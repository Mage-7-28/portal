//! 原生批量传输编排：有界工作池、目标预占、结构化结果和独占工作会话。
use super::{
    collect_folder_download_plan_with_progress, collect_folder_upload_plan_with_progress,
    connection_generation, download_file_to_local, emit_task_event, ensure_remote_directory,
    is_cancelled, remote_mutation_policy, upload_file_to_sftp, FileTransferContext, SshConnection,
    SshError, SshState, TransferSessionLease,
};
use crate::local_transfer::{LocalReservationKey, LocalTransferRoot};
use crate::scan_budget::ScanBudget;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

#[path = "transfer_archive.rs"]
mod transfer_archive;

type Job = Box<dyn FnOnce() + Send + 'static>;

/// 排队只保存闭包，协调器和 IO 工作者使用独立队列，避免嵌套等待耗尽线程。
struct WorkQueue {
    sender: mpsc::SyncSender<Job>,
}
impl WorkQueue {
    fn new(count: usize, capacity: usize, name: &str) -> Self {
        let (sender, receiver) = mpsc::sync_channel::<Job>(capacity);
        let receiver = Arc::new(Mutex::new(receiver));
        for index in 0..count {
            let receiver = receiver.clone();
            thread::Builder::new()
                .name(format!("{name}-{index}"))
                .spawn(move || loop {
                    let job = receiver.lock().unwrap_or_else(|e| e.into_inner()).recv();
                    match job {
                        Ok(job) => {
                            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(job));
                        }
                        Err(_) => break,
                    }
                })
                .expect("无法创建文件工作池");
        }
        Self { sender }
    }
}
static COORDINATORS: OnceLock<WorkQueue> = OnceLock::new();
static WORKERS: OnceLock<WorkQueue> = OnceLock::new();

pub(super) fn submit_coordinator(job: Job) -> Result<(), SshError> {
    COORDINATORS
        .get_or_init(|| WorkQueue::new(4, 64, "transfer-plan"))
        .sender
        .try_send(job)
        .map_err(|_| SshError::TransferRejected("任务队列已满".into()))
}
pub(super) fn submit_worker(job: Job) -> Result<(), SshError> {
    WORKERS
        .get_or_init(|| WorkQueue::new(8, 256, "transfer-io"))
        .sender
        .send(job)
        .map_err(|_| SshError::TransferRejected("传输工作池已关闭".into()))
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TransferEntry {
    pub local_path: String,
    pub remote_path: String,
    pub is_directory: bool,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TransferRequest {
    pub version: u8,
    pub direction: String,
    pub entries: Vec<TransferEntry>,
    #[serde(default)]
    pub overwrite: bool,
    #[serde(default = "automatic")]
    pub mode: String,
    #[serde(default = "automatic")]
    pub compression: String,
}
fn clone_error(error: &SshError) -> SshError {
    error.clone()
}

fn error_value(error: &SshError) -> Value {
    let mut value = serde_json::to_value(error).unwrap();
    if let Some(message) = value
        .get("message")
        .and_then(Value::as_str)
        .map(str::to_owned)
    {
        if message.len() > 1024 {
            let mut end = 1024 - '…'.len_utf8();
            while !message.is_char_boundary(end) {
                end -= 1;
            }
            value["message"] = Value::String(format!("{}…", &message[..end]));
        }
    }
    value
}

fn automatic() -> String {
    "auto".into()
}
impl TransferRequest {
    pub(super) fn validate(&self) -> Result<(), SshError> {
        if self.version != 2
            || !matches!(self.direction.as_str(), "upload" | "download")
            || !matches!(self.mode.as_str(), "auto" | "sftp" | "archive")
            || !matches!(self.compression.as_str(), "auto" | "none" | "gzip")
            || self.entries.is_empty()
            || self.entries.len() > 100_000
        {
            return Err(SshError::TransferRejected("传输请求格式或数量无效".into()));
        }
        let mut budget = ScanBudget::for_transfer();
        for entry in &self.entries {
            if entry.local_path.is_empty()
                || entry.remote_path.is_empty()
                || entry.local_path.contains('\0')
                || entry.remote_path.contains('\0')
                || Path::new(&entry.local_path)
                    .components()
                    .any(|part| matches!(part, std::path::Component::ParentDir))
                || entry
                    .remote_path
                    .split('/')
                    .any(|part| matches!(part, ".." | "."))
            {
                return Err(SshError::InvalidTargetPath(
                    "传输路径不能为空或包含 NUL".into(),
                ));
            }
            budget
                .record(Path::new(&entry.local_path))
                .map_err(SshError::TransferRejected)?;
            budget
                .record(Path::new(&entry.remote_path))
                .map_err(SshError::TransferRejected)?;
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemResult {
    pub entry_index: usize,
    pub item_id: String,
    pub local_path: String,
    pub remote_path: String,
    pub status: String,
    pub bytes: u64,
    pub is_directory: bool,
    pub error: Option<Value>,
}
#[derive(Clone, Default, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferResult {
    pub message: String,
    pub succeeded: usize,
    pub failed: usize,
    pub skipped: usize,
    pub not_started: usize,
    pub unknown: usize,
    pub items: Vec<ItemResult>,
    pub engine: String,
    pub elapsed_ms: u128,
    pub directory_count: usize,
}

const RESULT_TTL: Duration = Duration::from_secs(600);
const RESULT_CACHE_BYTES: usize = 128 * 1024 * 1024;
const RESULT_CACHE_BATCHES: usize = 8;

struct CachedResult {
    created: Instant,
    owner: String,
    request: TransferRequest,
    result: TransferResult,
    estimated_bytes: usize,
}

#[derive(Default)]
pub(super) struct Registry {
    targets: Mutex<HashMap<String, Vec<ReservedTarget>>>,
    results: Mutex<HashMap<String, CachedResult>>,
}

enum ReservedTarget {
    Local(LocalReservationKey),
    Remote { host: String, path: PathBuf },
}
impl ReservedTarget {
    fn conflicts(&self, other: &Self) -> bool {
        match (self, other) {
            (Self::Local(a), Self::Local(b)) => a.conflicts(b),
            (Self::Remote { host: a, path: x }, Self::Remote { host: b, path: y }) => {
                a == b && (x.starts_with(y) || y.starts_with(x))
            }
            _ => false,
        }
    }
}

/// 一次校验所有顶层目标，才能发现分别选择 A/a 文件或目录时的文件系统别名。
fn validate_local_targets(request: &TransferRequest) -> Result<(), SshError> {
    let mut groups = HashMap::<PathBuf, (Vec<PathBuf>, Vec<PathBuf>)>::new();
    for entry in &request.entries {
        let target = Path::new(&entry.local_path);
        let mut anchor = target
            .parent()
            .filter(|path| !path.as_os_str().is_empty())
            .unwrap_or(Path::new("."));
        while !anchor.exists() {
            anchor = anchor
                .parent()
                .ok_or_else(|| SshError::InvalidTargetPath("无法解析本地目标的父目录".into()))?;
        }
        let relative = target
            .strip_prefix(anchor)
            .map_err(|_| SshError::InvalidTargetPath("本地目标必须在选择的父目录内".into()))?
            .to_path_buf();
        let anchor = std::fs::canonicalize(anchor)?;
        let group = groups.entry(anchor).or_default();
        if entry.is_directory {
            group.0.push(relative);
        } else {
            group.1.push(relative);
        }
    }
    for (anchor, (directories, files)) in groups {
        LocalTransferRoot::open(&anchor)?.validate_manifest(&directories, &files)?;
    }
    Ok(())
}

struct Reservation {
    registry: Arc<Registry>,
    id: String,
}
impl Drop for Reservation {
    fn drop(&mut self) {
        self.registry.targets.lock().unwrap().remove(&self.id);
    }
}
impl Registry {
    pub(super) fn prune(&self) {
        self.results
            .lock()
            .unwrap()
            .retain(|_, row| row.created.elapsed() < RESULT_TTL);
    }

    pub(super) fn clear_owner(&self, owner: &str) {
        self.results
            .lock()
            .unwrap()
            .retain(|_, row| row.owner != owner);
    }

    fn store(&self, id: &str, owner: String, request: TransferRequest, result: TransferResult) {
        let estimated_bytes = result
            .items
            .iter()
            .fold(0usize, |bytes, item| {
                bytes
                    .saturating_add(std::mem::size_of::<ItemResult>())
                    .saturating_add(
                        item.item_id.len()
                            + item.local_path.len()
                            + item.remote_path.len()
                            + item.status.len(),
                    )
                    .saturating_add(
                        item.error
                            .as_ref()
                            .map(|error| error.to_string().len())
                            .unwrap_or(0),
                    )
            })
            .saturating_add(
                request
                    .entries
                    .iter()
                    .map(|entry| {
                        entry.local_path.len()
                            + entry.remote_path.len()
                            + std::mem::size_of::<TransferEntry>()
                    })
                    .sum::<usize>(),
            );
        let mut rows = self.results.lock().unwrap();
        rows.retain(|_, row| row.created.elapsed() < RESULT_TTL);
        // 单批无法缓存时不得顺便淘汰其它窗口仍在读取的完整结果。
        if estimated_bytes > RESULT_CACHE_BYTES {
            return;
        }
        while !rows.is_empty()
            && (rows.len() >= RESULT_CACHE_BATCHES
                || rows
                    .values()
                    .map(|row| row.estimated_bytes)
                    .sum::<usize>()
                    .saturating_add(estimated_bytes)
                    > RESULT_CACHE_BYTES)
        {
            let oldest = rows
                .iter()
                .min_by_key(|(_, row)| row.created)
                .map(|(id, _)| id.clone())
                .unwrap();
            rows.remove(&oldest);
        }
        // 超出明细预算时不截断成看似完整的列表；分页接口明确返回不可用，前端禁止盲目重试。
        if estimated_bytes <= RESULT_CACHE_BYTES {
            rows.insert(
                id.into(),
                CachedResult {
                    created: Instant::now(),
                    owner,
                    request,
                    result,
                    estimated_bytes,
                },
            );
        }
    }

    fn reserve(
        self: &Arc<Self>,
        id: &str,
        host: &str,
        request: &TransferRequest,
    ) -> Result<Reservation, SshError> {
        let mut targets = self.targets.lock().unwrap();
        if request.direction == "download" {
            validate_local_targets(request)?;
        }
        let requested: Vec<_> = request
            .entries
            .iter()
            .map(|entry| -> Result<ReservedTarget, SshError> {
                if request.direction == "upload" {
                    let path = PathBuf::from(
                        entry
                            .remote_path
                            .split('/')
                            .filter(|part| !part.is_empty())
                            .collect::<Vec<_>>()
                            .join("/"),
                    );
                    Ok(ReservedTarget::Remote {
                        host: host.into(),
                        path,
                    })
                } else {
                    Ok(ReservedTarget::Local(LocalTransferRoot::reservation_key(
                        Path::new(&entry.local_path),
                    )?))
                }
            })
            .collect::<Result<_, _>>()?;
        for (index, path) in requested.iter().enumerate() {
            let overlaps_batch = requested[..index].iter().any(|other| match (path, other) {
                (ReservedTarget::Local(a), ReservedTarget::Local(b)) => a.same_resolved_target(b),
                _ => path.conflicts(other),
            });
            let overlaps_local_path = request.direction == "download"
                && request.entries[..index].iter().any(|other| {
                    let path = Path::new(&request.entries[index].local_path);
                    let other = Path::new(&other.local_path);
                    path.starts_with(other) || other.starts_with(path)
                });
            if overlaps_batch
                || overlaps_local_path
                || targets
                    .values()
                    .flatten()
                    .any(|other| path.conflicts(other))
            {
                return Err(SshError::TargetNameCollision(
                    "目标路径与本批次或正在执行的任务重叠".into(),
                ));
            }
        }
        targets.insert(id.into(), requested);
        Ok(Reservation {
            registry: self.clone(),
            id: id.into(),
        })
    }
    pub(super) fn result_page(
        &self,
        id: &str,
        owner: &str,
        offset: usize,
        limit: usize,
    ) -> Option<Value> {
        let mut rows = self.results.lock().unwrap();
        rows.retain(|_, row| row.created.elapsed() < RESULT_TTL);
        let row = rows.get(id).filter(|row| row.owner == owner)?;
        let end = offset.saturating_add(limit).min(row.result.items.len());
        let items = row.result.items.get(offset..end).unwrap_or_default();
        Some(
            json!({"items":items,"offset":offset,"total":row.result.items.len(),"hasMore":end<row.result.items.len()}),
        )
    }
    pub(super) fn retry(&self, id: &str, owner: &str) -> Option<TransferRequest> {
        let mut rows = self.results.lock().unwrap();
        rows.retain(|_, row| row.created.elapsed() < RESULT_TTL);
        let row = rows.get(id)?;
        let (actual_owner, request, result) = (&row.owner, &row.request, &row.result);
        if actual_owner != owner {
            return None;
        }
        let mut retry = request.clone();
        let indices: std::collections::HashSet<_> = result
            .items
            .iter()
            .filter(|item| matches!(item.status.as_str(), "failed" | "notStarted"))
            .map(|item| item.entry_index)
            .collect();
        // 逐文件结果转成新条目，不能按根重传已经成功的文件。
        retry.entries = result
            .items
            .iter()
            .filter(|item| {
                indices.contains(&item.entry_index)
                    && matches!(item.status.as_str(), "failed" | "notStarted")
            })
            .map(|item| TransferEntry {
                local_path: item.local_path.clone(),
                remote_path: item.remote_path.clone(),
                is_directory: item.is_directory,
            })
            .collect();
        (!retry.entries.is_empty()).then_some(retry)
    }
}

#[derive(Clone)]
struct PlannedFile {
    entry_index: usize,
    item_id: String,
    local_path: String,
    remote_path: String,
    root: Arc<LocalTransferRoot>,
    relative: PathBuf,
    size: Option<u64>,
    stamp: crate::transfer_validation::SourceStamp,
    remote_root: String,
    source_relative: String,
}

#[derive(Clone)]
enum FileJob {
    Sftp(PlannedFile),
    Archive(
        Vec<PlannedFile>,
        crate::archive_transfer::ManifestBlock,
        bool,
    ),
}

fn make_jobs(
    files: Vec<PlannedFile>,
    request: &TransferRequest,
    capability: Option<crate::archive_transfer::TarCapability>,
    result: &mut TransferResult,
) -> Result<VecDeque<FileJob>, SshError> {
    if cfg!(not(unix)) && request.mode == "archive" {
        return Err(SshError::ArchiveUnsupported(
            "当前平台无法建立经过验证的私有归档暂存区，请使用并行 SFTP".into(),
        ));
    }
    let capability = if cfg!(unix) { capability } else { None };
    let mut groups = std::collections::BTreeMap::<usize, Vec<PlannedFile>>::new();
    for file in files {
        groups.entry(file.entry_index).or_default().push(file);
    }
    let mut jobs = VecDeque::new();
    let mut used_archive = false;
    let mut used_sftp = result.items.iter().any(|item| !item.is_directory);
    for rows in groups.into_values() {
        // 超大文件或元数据不足的文件单独走 SFTP，不能让同目录的小文件失去归档机会。
        let (rows, large): (Vec<_>, Vec<_>) = rows.into_iter().partition(|file| {
            file.size
                .is_some_and(|size| size <= crate::archive_transfer::MAX_BLOCK_BYTES)
                && file.stamp.size == file.size
                && file
                    .stamp
                    .modified
                    .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                    .is_some()
        });
        if !large.is_empty() {
            used_sftp = true;
            jobs.extend(large.into_iter().map(FileJob::Sftp));
        }
        if rows.is_empty() {
            continue;
        }
        let prefetched = result
            .items
            .iter()
            .filter(|item| !item.is_directory && item.entry_index == rows[0].entry_index)
            .count();
        let candidate = capability
            .as_ref()
            .and_then(|_| transfer_archive::manifest(&rows).ok());
        let selected = candidate.filter(|manifest| {
            request.mode == "archive"
                || crate::archive_transfer::should_use_archive(manifest)
                || (rows.len() + prefetched >= 256
                    && rows
                        .iter()
                        .map(|file| file.size.unwrap_or(0) as u128)
                        .sum::<u128>()
                        <= rows.len() as u128 * 256 * 1024)
        });
        if let (Some(manifest), Some(capability)) = (selected, capability.as_ref()) {
            let gzip = transfer_archive::gzip_for(&rows, &request.compression, capability.gzip)?;
            let mut by_id: HashMap<_, _> = rows
                .into_iter()
                .map(|file| (file.item_id.clone(), file))
                .collect();
            // 块大小上限不等于并行粒度；让中等规模目录也能使用四个独占工作会话。
            let chunk_size = by_id.len().div_ceil(4).clamp(64, 512);
            for block in manifest.blocks() {
                for entries in block.entries.chunks(chunk_size) {
                    let rows: Vec<_> = entries
                        .iter()
                        .map(|entry| by_id.remove(&entry.internal_id).unwrap())
                        .collect();
                    for block in transfer_archive::manifest(&rows)?.blocks() {
                        jobs.push_back(FileJob::Archive(rows.clone(), block, gzip));
                    }
                }
            }
            used_archive = true;
        } else {
            jobs.extend(rows.into_iter().map(FileJob::Sftp));
            used_sftp = true;
        }
    }
    result.engine = match (used_archive, used_sftp) {
        (true, true) => "mixed",
        (true, false) => "archive",
        _ => "sftp",
    }
    .into();
    Ok(jobs)
}

fn item_result(file: PlannedFile, work: Result<u64, SshError>) -> ItemResult {
    let (status, bytes, error) = match work {
        Ok(bytes) => ("succeeded", bytes, None),
        Err(error) => {
            let status = if matches!(error, SshError::CommitOutcomeUnknown(_)) {
                "unknown"
            } else if matches!(
                error,
                SshError::TransferCancelled | SshError::ConnectionGenerationChanged
            ) {
                "notStarted"
            } else {
                "failed"
            };
            (status, 0, Some(error_value(&error)))
        }
    };
    ItemResult {
        entry_index: file.entry_index,
        item_id: file.item_id,
        local_path: file.local_path,
        remote_path: file.remote_path,
        status: status.into(),
        bytes,
        is_directory: false,
        error,
    }
}

/// 每个工作者仅使用自己的会话和 SFTP 句柄；所有结果都经父任务汇总。
pub(super) fn run_batch(
    state: &SshState,
    connection: &SshConnection,
    task_id: &str,
    request: TransferRequest,
) -> Result<String, SshError> {
    request.validate()?;
    let started = Instant::now();
    let owner = state
        .tasks
        .owner(task_id)
        .ok_or(SshError::TransferCancelled)?;
    let endpoint = state
        .connection_endpoints
        .lock()
        .unwrap()
        .get(&connection.id)
        .copied()
        .ok_or(SshError::ConnectionNotFound)?;
    let _reservation = state
        .transfer_registry
        .reserve(task_id, &endpoint.to_string(), &request)?;
    let mut result = TransferResult {
        engine: "sftp".into(),
        ..Default::default()
    };
    let mut files = Vec::new();
    let mut budget = ScanBudget::for_transfer();
    let mut archive_capability = None;
    let mut planning_error = None;
    {
        let _slot = state
            .tasks
            .acquire_worker(task_id, "worker-0")
            .map_err(|_| SshError::TransferCancelled)?;
        let mut lease =
            TransferSessionLease::checkout_worker(state, connection, task_id, "worker-0")?;
        let session = lease.session();
        let sftp = lease.sftp()?;
        let policy = if request.direction == "upload" {
            Some(remote_mutation_policy(state, &connection.id, &session)?)
        } else {
            None
        };
        for (entry_index, entry) in request.entries.iter().enumerate() {
            if is_cancelled(state, task_id) {
                planning_error = Some(SshError::TransferCancelled);
                for (index, pending) in request.entries.iter().enumerate().skip(entry_index) {
                    result.not_started += 1;
                    result.items.push(ItemResult {
                        entry_index: index,
                        item_id: format!("root-{index}"),
                        local_path: pending.local_path.clone(),
                        remote_path: pending.remote_path.clone(),
                        status: "notStarted".into(),
                        bytes: 0,
                        is_directory: pending.is_directory,
                        error: Some(serde_json::to_value(SshError::TransferCancelled).unwrap()),
                    });
                }
                break;
            }
            let checkpoint = files.len();
            let mut prefetch = None;
            let prepare = (|| -> Result<(), SshError> {
                if request.direction == "upload" {
                    let local = Path::new(&entry.local_path);
                    let root = Arc::new(LocalTransferRoot::open(if entry.is_directory {
                        local
                    } else {
                        local.parent().unwrap_or(Path::new("."))
                    })?);
                    let (directories, members, skipped) = if entry.is_directory {
                        if cfg!(unix) {
                            let remote_parent = Path::new(&entry.remote_path)
                                .parent()
                                .unwrap_or(Path::new("."))
                                .to_string_lossy()
                                .into_owned();
                            prefetch = super::transfer_prefetch::Prefetcher::start(
                                state,
                                connection,
                                task_id,
                                root.clone(),
                                true,
                                remote_parent,
                            )
                            .ok();
                        }
                        let plan = collect_folder_upload_plan_with_progress(
                            &root,
                            || is_cancelled(state, task_id),
                            || state.tasks.heartbeat(task_id),
                            |relative, stamp| {
                                if let (Some(prefetch), Ok(remote)) = (
                                    prefetch.as_mut(),
                                    super::join_remote_path(&entry.remote_path, relative),
                                ) {
                                    prefetch.offer(relative, &remote, stamp);
                                }
                            },
                        )?;
                        (
                            plan.directories,
                            plan.files
                                .into_iter()
                                .map(|file| (file.relative_path, file.stamp))
                                .collect::<Vec<_>>(),
                            plan.skipped_entries,
                        )
                    } else {
                        (
                            Vec::new(),
                            vec![(
                                PathBuf::from(local.file_name().ok_or_else(|| {
                                    SshError::InvalidTargetPath("源文件名称无效".into())
                                })?),
                                crate::transfer_validation::SourceStamp::from_local_metadata(
                                    &root
                                        .open_source(Path::new(local.file_name().unwrap()))?
                                        .metadata()?,
                                )?,
                            )],
                            0,
                        )
                    };
                    result.skipped += skipped;
                    if entry.is_directory {
                        ensure_remote_directory(
                            state,
                            &connection.id,
                            &sftp,
                            policy.as_ref().unwrap(),
                            &entry.remote_path,
                            request.overwrite,
                        )?;
                        for directory in &directories {
                            ensure_remote_directory(
                                state,
                                &connection.id,
                                &sftp,
                                policy.as_ref().unwrap(),
                                &format!(
                                    "{}/{}",
                                    entry.remote_path.trim_end_matches('/'),
                                    directory.to_string_lossy()
                                ),
                                true,
                            )?;
                        }
                    }
                    for (relative, stamp) in members {
                        budget
                            .record(&relative)
                            .map_err(SshError::TransferRejected)?;
                        let remote_path = if entry.is_directory {
                            format!(
                                "{}/{}",
                                entry.remote_path.trim_end_matches('/'),
                                relative.to_string_lossy()
                            )
                        } else {
                            entry.remote_path.clone()
                        };
                        files.push(PlannedFile {
                            entry_index,
                            item_id: format!("f{entry_index:08x}-{:08x}", files.len()),
                            local_path: if entry.is_directory {
                                local.join(&relative).to_string_lossy().into_owned()
                            } else {
                                entry.local_path.clone()
                            },
                            remote_path,
                            root: root.clone(),
                            relative: relative.clone(),
                            size: stamp.size,
                            stamp,
                            remote_root: if entry.is_directory {
                                entry.remote_path.clone()
                            } else {
                                Path::new(&entry.remote_path)
                                    .parent()
                                    .unwrap_or(Path::new("."))
                                    .to_string_lossy()
                                    .into_owned()
                            },
                            source_relative: relative.to_string_lossy().into_owned(),
                        });
                    }
                } else if entry.is_directory {
                    let root = Arc::new(LocalTransferRoot::download_root(
                        Path::new(&entry.local_path),
                        request.overwrite,
                    )?);
                    if cfg!(unix) {
                        prefetch = super::transfer_prefetch::Prefetcher::start(
                            state,
                            connection,
                            task_id,
                            root.clone(),
                            false,
                            String::new(),
                        )
                        .ok();
                    }
                    let plan = collect_folder_download_plan_with_progress(
                        state,
                        &connection.id,
                        &sftp,
                        &entry.remote_path,
                        task_id,
                        |relative, remote, stamp| {
                            if let Some(prefetch) = prefetch.as_mut() {
                                prefetch.offer(relative, remote, stamp);
                            }
                        },
                    )?;
                    let members: Vec<_> = plan
                        .files
                        .iter()
                        .map(|file| file.relative_path.clone())
                        .collect();
                    root.validate_manifest(&plan.directories, &members)?;
                    for directory in &plan.directories {
                        root.create_dir_all(directory)?;
                    }
                    result.skipped += plan.skipped_entries;
                    for file in plan.files {
                        budget
                            .record(&file.relative_path)
                            .map_err(SshError::TransferRejected)?;
                        files.push(PlannedFile {
                            entry_index,
                            item_id: format!("f{entry_index:08x}-{:08x}", files.len()),
                            local_path: Path::new(&entry.local_path)
                                .join(&file.relative_path)
                                .to_string_lossy()
                                .into_owned(),
                            remote_path: file.remote_path,
                            root: root.clone(),
                            relative: file.relative_path.clone(),
                            size: file.stamp.size,
                            stamp: file.stamp,
                            remote_root: entry.remote_path.clone(),
                            source_relative: file.relative_path.to_string_lossy().into_owned(),
                        });
                    }
                } else {
                    let local = Path::new(&entry.local_path);
                    let root = Arc::new(LocalTransferRoot::open(
                        local.parent().unwrap_or(Path::new(".")),
                    )?);
                    let relative =
                        PathBuf::from(local.file_name().ok_or_else(|| {
                            SshError::InvalidTargetPath("目标文件名称无效".into())
                        })?);
                    root.validate_manifest(&[], std::slice::from_ref(&relative))?;
                    let stat = sftp
                        .lstat(Path::new(&entry.remote_path))
                        .map_err(|e| SshError::FileOperationFailed(e.to_string()))?;
                    if !stat.is_file() {
                        return Err(SshError::InvalidTargetPath(
                            "远端下载源必须是普通文件".into(),
                        ));
                    }
                    let stamp = super::remote_source_stamp(&stat)?;
                    let remote = Path::new(&entry.remote_path);
                    files.push(PlannedFile {
                        entry_index,
                        item_id: format!("f{entry_index:08x}-{:08x}", files.len()),
                        local_path: entry.local_path.clone(),
                        remote_path: entry.remote_path.clone(),
                        root,
                        relative,
                        size: stamp.size,
                        stamp,
                        remote_root: remote
                            .parent()
                            .unwrap_or(Path::new("."))
                            .to_string_lossy()
                            .into_owned(),
                        source_relative: remote.file_name().unwrap().to_string_lossy().into_owned(),
                    });
                }
                Ok(())
            })();
            if let Err(error) = prepare {
                files.truncate(checkpoint);
                let cancelled = matches!(
                    error,
                    SshError::TransferCancelled | SshError::ConnectionGenerationChanged
                );
                if cancelled {
                    result.not_started += 1;
                } else {
                    result.failed += 1;
                }
                result.items.push(ItemResult {
                    entry_index,
                    item_id: format!("root-{entry_index}"),
                    local_path: entry.local_path.clone(),
                    remote_path: entry.remote_path.clone(),
                    status: if cancelled { "notStarted" } else { "failed" }.into(),
                    bytes: 0,
                    is_directory: entry.is_directory,
                    error: Some(error_value(&error)),
                });
            } else {
                result.directory_count += usize::from(entry.is_directory);
                if let Some(prepared) = prefetch.take().and_then(|prefetch| prefetch.finish()) {
                    let outcomes: HashMap<_, _> =
                        prepared.publish(request.overwrite).into_iter().collect();
                    let mut pending = Vec::new();
                    for file in files.drain(checkpoint..) {
                        pending.push(file);
                    }
                    let mut outcomes = outcomes;
                    for file in pending {
                        if let Some(work) = outcomes.remove(&file.relative) {
                            let item = item_result(file, work);
                            match item.status.as_str() {
                                "succeeded" => result.succeeded += 1,
                                "unknown" => result.unknown += 1,
                                "notStarted" => result.not_started += 1,
                                _ => result.failed += 1,
                            }
                            result.items.push(item);
                        } else {
                            files.push(file);
                        }
                    }
                }
            }
        }
        if planning_error.is_none()
            && cfg!(unix)
            && request.mode != "sftp"
            && (request.mode == "archive"
                || files.len()
                    + result
                        .items
                        .iter()
                        .filter(|item| !item.is_directory)
                        .count()
                    >= 256)
        {
            let transport = session.lock().unwrap().clone();
            let probe = crate::archive_transfer::probe_remote_tar(
                &transport,
                &|| {
                    state.tasks.heartbeat(task_id);
                    is_cancelled(state, task_id)
                },
                Duration::from_secs(5),
            );
            match probe {
                Ok(capability) => archive_capability = Some(capability),
                Err(crate::archive_transfer::ArchiveTransferError::Unsupported(_))
                    if request.mode == "auto" => {}
                Err(error) => planning_error = Some(transfer_archive::archive_error(error)),
            }
        }
        drop(sftp);
        drop(session);
        if planning_error.is_none() {
            lease.reuse_on_success();
        }
    }
    if let Some(error) = planning_error {
        // 首块已经发布的成功项必须保留；规划中止只撤销尚未执行的项。
        for file in files.drain(..) {
            let mut item = item_result(file, Err(error.clone()));
            item.status = "notStarted".into();
            result.not_started += 1;
            result.items.push(item);
        }
    }
    let file_total = files.len()
        + result
            .items
            .iter()
            .filter(|item| !item.is_directory)
            .count();
    let prefetched_bytes: u64 = result.items.iter().map(|item| item.bytes).sum();
    let total_bytes = files
        .iter()
        .try_fold(0u64, |total, file| {
            file.size.and_then(|size| total.checked_add(size))
        })
        .and_then(|total| total.checked_add(prefetched_bytes));
    let completed = Arc::new(AtomicU64::new(prefetched_bytes));
    let done = Arc::new(AtomicU64::new(
        result
            .items
            .iter()
            .filter(|item| !item.is_directory)
            .count() as u64,
    ));
    let active_bytes = Arc::new(Mutex::new(HashMap::<String, u64>::new()));
    let jobs = make_jobs(files, &request, archive_capability, &mut result)?;
    let worker_count = jobs.len().min(4);
    let files = Arc::new(Mutex::new(jobs));
    let (sender, receiver) = mpsc::channel();
    for worker_index in 0..worker_count {
        let state = state.clone();
        let connection = connection.clone();
        let task_id = task_id.to_owned();
        let direction = request.direction.clone();
        let overwrite = request.overwrite;
        let automatic = request.mode == "auto";
        let completed = completed.clone();
        let done = done.clone();
        let active_bytes = active_bytes.clone();
        let sender = sender.clone();
        let files = files.clone();
        submit_worker(Box::new(move || {
            let worker_id = format!("worker-{worker_index}");
            let buffer = Mutex::new(vec![0u8; super::TRANSFER_BUFFER_SIZE]);
            let mut resources = None;
            let slot = state.tasks.acquire_worker(&task_id, &worker_id);
            loop {
                let Some(job) = files.lock().unwrap().pop_front() else {
                    break;
                };
                let (file, archive_job) = match job {
                    FileJob::Sftp(file) => (file, None),
                    FileJob::Archive(rows, block, gzip) => {
                        (rows[0].clone(), Some((rows, block, gzip)))
                    }
                };
                let mut archive_outcomes = None;
                let mut archive_pending = archive_job.as_ref().map(|(rows, _, _)| rows.clone());
                let work = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| -> Result<u64, SshError> {
                    if slot.is_err() || state.tasks.cancelled_worker(&task_id, &worker_id) { return Err(SshError::TransferCancelled); }
                    if Some(connection_generation(&state, &connection.id)) != state.tasks.generation(&task_id) { return Err(SshError::ConnectionGenerationChanged); }
                    if resources.is_none() {
                        let mut lease = TransferSessionLease::checkout_worker(&state, &connection, &task_id, &worker_id)?;
                        let sftp = lease.sftp()?;
                        let session = lease.session();
                        let policy = if direction == "upload" { Some(remote_mutation_policy(&state, &connection.id, &session)?) } else { None };
                        resources = Some((lease, session, sftp, policy));
                    }
                    let (lease, session, sftp, policy) = resources.as_mut().unwrap();
                    let rename_client = lease.rename_client();
                    let context = FileTransferContext { state: &state, connection: &connection, sftp, session, transfer_id: &task_id, overwrite, worker_id: Some(&worker_id), buffer: Some(&buffer), rename_client: Some(&rename_client), expected_source: Some(&file.stamp), local_cancellation: None };
                    let mut progress = |current, _| {
                        let mut bytes = active_bytes.lock().unwrap();
                        bytes.insert(worker_id.clone(), current);
                        let current = completed.load(Ordering::Relaxed).saturating_add(bytes.values().copied().sum::<u64>());
                        drop(bytes);
                        if state.tasks.progress(&task_id, current, total_bytes, &file.remote_path) {
                            let overall = total_bytes.filter(|n|*n>0).map(|n|(current as f64 / n as f64*100.0).min(99.0));
                            emit_task_event(&state, &task_id, &format!("{direction}-progress"), json!({"id":connection.id,"transferId":task_id,"current":current,"total":total_bytes,"completedBytes":current,"totalBytes":total_bytes,"fileTotal":file_total,"fileIndex":done.load(Ordering::Relaxed),"fileName":file.relative.to_string_lossy(),"overallProgress":overall,"progress":overall.unwrap_or(0.0),"engine":"sftp"}));
                        }
                    };
                    if let Some((rows, _block, gzip)) = archive_job.clone() {
                        let mut ready = Vec::with_capacity(rows.len());
                        // 普通文件级权限/源变化在发送数据前隔离，不能拖垮整块的其他文件。
                        for row in rows {
                            match transfer_archive::preflight(&context,&row,direction == "upload") {
                                Ok(()) => ready.push(row),
                                Err(error) => {
                                    done.fetch_add(1,Ordering::Relaxed);
                                    let _ = sender.send(item_result(row,Err(error)));
                                }
                            }
                        }
                        archive_pending = Some(ready.clone());
                        if ready.is_empty() { archive_outcomes = Some(Ok(Vec::new())); return Ok(0); }
                        let block = transfer_archive::manifest(&ready)?.blocks().into_iter().next().unwrap();
                        let rows = ready;
                        let outcome = if direction == "upload" {
                            transfer_archive::upload(&context, policy.as_ref().unwrap(), rows, &block, gzip)
                        } else {
                            transfer_archive::download(&context, rows, &block, gzip)
                        };
                        archive_outcomes = Some(outcome);
                        return Ok(0);
                    }
                    if direction == "upload" {
                        upload_file_to_sftp(&context, policy.as_ref().unwrap(), file.root.open_source(&file.relative)?, &file.remote_path, &mut progress)
                    } else {
                        download_file_to_local(&context, &file.remote_path, file.root.prepare_download(&file.relative, overwrite)?, &mut progress)
                    }
                })).unwrap_or_else(|_| Err(SshError::FileOperationFailed("文件工作者异常退出".into())));
                state.tasks.end_commit(&task_id, &worker_id);
                active_bytes.lock().unwrap().remove(&worker_id);
                let outcomes = match archive_outcomes {
                    Some(Ok(outcomes)) => outcomes,
                    Some(Err((rows, error)))
                        if automatic && matches!(error, SshError::ArchiveUnsupported(_)) =>
                    {
                        // 尚未提交任何目标：丢弃失败暂存与通道，降级只对本块文件执行一次 SFTP。
                        resources = None;
                        files
                            .lock()
                            .unwrap()
                            .extend(rows.into_iter().map(FileJob::Sftp));
                        continue;
                    }
                    Some(Err((rows, error))) => {
                        resources = None;
                        rows.into_iter()
                            .map(|row| (row, Err(clone_error(&error))))
                            .collect()
                    }
                    None => match archive_pending {
                        Some(rows) => rows
                            .into_iter()
                            .map(|row| {
                                (
                                    row,
                                    Err(work
                                        .as_ref()
                                        .err()
                                        .map(clone_error)
                                        .unwrap_or(SshError::TransferCancelled)),
                                )
                            })
                            .collect(),
                        None => vec![(file, work)],
                    },
                };
                for (file, work) in outcomes {
                    let mut item = ItemResult {
                        entry_index: file.entry_index,
                        item_id: file.item_id.clone(),
                        local_path: file.local_path,
                        remote_path: file.remote_path,
                        status: "succeeded".into(),
                        bytes: 0,
                        is_directory: false,
                        error: None,
                    };
                    match work {
                        Ok(bytes) => {
                            item.bytes = bytes;
                            completed.fetch_add(bytes, Ordering::Relaxed);
                        }
                        Err(error) => {
                            if !matches!(
                                error,
                                SshError::TargetExists(_)
                                    | SshError::PermissionDenied(_)
                                    | SshError::InvalidTargetPath(_)
                                    | SshError::SourceChanged(_)
                            ) {
                                resources = None;
                            }
                            item.status = if matches!(error, SshError::CommitOutcomeUnknown(_)) {
                                "unknown"
                            } else if matches!(
                                error,
                                SshError::TransferCancelled | SshError::ConnectionGenerationChanged
                            ) {
                                "notStarted"
                            } else {
                                "failed"
                            }
                            .into();
                            item.error = Some(error_value(&error));
                        }
                    }
                    done.fetch_add(1, Ordering::Relaxed);
                    let current = completed.load(Ordering::Relaxed);
                    if state
                        .tasks
                        .progress(&task_id, current, total_bytes, &item.remote_path)
                    {
                        let overall = total_bytes
                            .filter(|n| *n > 0)
                            .map(|n| (current as f64 / n as f64 * 100.0).min(99.0));
                        emit_task_event(
                            &state,
                            &task_id,
                            &format!("{direction}-progress"),
                            json!({"id":connection.id,"transferId":task_id,"current":current,"total":total_bytes,"completedBytes":current,"totalBytes":total_bytes,"fileTotal":file_total,"fileIndex":done.load(Ordering::Relaxed),"fileName":item.remote_path,"overallProgress":overall,"progress":overall.unwrap_or(0.0)}),
                        );
                    }
                    let _ = sender.send(item);
                }
            }
            if let Some((mut lease, session, sftp, _policy)) = resources {
                drop(sftp);
                drop(session);
                if !state.tasks.cancelled(&task_id) {
                    lease.reuse_on_success();
                }
            }
        }))?;
    }
    drop(sender);
    for item in receiver {
        match item.status.as_str() {
            "succeeded" => result.succeeded += 1,
            "unknown" => result.unknown += 1,
            "notStarted" => result.not_started += 1,
            _ => result.failed += 1,
        }
        result.items.push(item);
    }
    result.elapsed_ms = started.elapsed().as_millis();
    result.message = format!(
        "已完成 {}，失败 {}，跳过 {}，未执行 {}，结果未知 {}",
        result.succeeded, result.failed, result.skipped, result.not_started, result.unknown
    );
    let summary = json!({"message": result.message, "succeeded":result.succeeded, "failed":result.failed, "skipped":result.skipped, "notStarted":result.not_started, "unknown":result.unknown, "engine":result.engine, "elapsedMs":result.elapsed_ms, "directoryCount":result.directory_count, "itemCount":result.items.len()});
    state.tasks.set_result(task_id, summary);
    let message = result.message.clone();
    state
        .transfer_registry
        .store(task_id, owner, request, result);
    if is_cancelled(state, task_id) {
        return Err(SshError::TransferCancelled);
    }
    Ok(message)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn request() -> TransferRequest {
        TransferRequest {
            version: 2,
            direction: "upload".into(),
            entries: vec![TransferEntry {
                local_path: "/source/a".into(),
                remote_path: "/target/a".into(),
                is_directory: false,
            }],
            overwrite: false,
            mode: "auto".into(),
            compression: "auto".into(),
        }
    }
    #[test]
    fn rejects_unknown_protocol_and_injected_paths() {
        let mut row = request();
        assert!(row.validate().is_ok());
        row.version = 1;
        assert!(row.validate().is_err());
        row.version = 2;
        row.entries[0].remote_path.push('\0');
        assert!(row.validate().is_err());
    }
    #[test]
    fn target_ancestor_reservation_is_exclusive_and_released() {
        let registry = Arc::new(Registry::default());
        let first = registry.reserve("a", "host", &request()).unwrap();
        assert!(registry.reserve("b", "host", &request()).is_err());
        drop(first);
        assert!(registry.reserve("b", "host", &request()).is_ok());
    }
    fn planned_files(count: usize) -> Vec<PlannedFile> {
        let root = Arc::new(LocalTransferRoot::open(Path::new(".")).unwrap());
        (0..count)
            .map(|index| PlannedFile {
                entry_index: 0,
                item_id: format!("f{index:08x}"),
                local_path: format!("/local/{index}.txt"),
                remote_path: format!("/remote/{index}.txt"),
                root: root.clone(),
                relative: PathBuf::from(format!("{index}.txt")),
                size: Some(1024),
                stamp: crate::transfer_validation::SourceStamp::new(
                    Some(1024),
                    Some(std::time::UNIX_EPOCH + Duration::from_secs(1_700_000_000)),
                ),
                remote_root: "/remote".into(),
                source_relative: format!("{index}.txt"),
            })
            .collect()
    }

    #[test]
    #[cfg(unix)]
    fn a_large_file_does_not_disable_archive_for_small_siblings() {
        let mut files = planned_files(257);
        files[0].size = Some(crate::archive_transfer::MAX_BLOCK_BYTES + 1);
        files[0].stamp.size = files[0].size;
        let mut result = TransferResult::default();
        let jobs = make_jobs(
            files,
            &request(),
            Some(crate::archive_transfer::TarCapability { gzip: true }),
            &mut result,
        )
        .unwrap();
        assert!(jobs.iter().any(|job| matches!(job, FileJob::Archive(..))));
        assert!(jobs.iter().any(|job| matches!(job, FileJob::Sftp(..))));
        assert_eq!(result.engine, "mixed");
    }

    #[test]
    #[cfg(unix)]
    fn prefetched_files_still_count_toward_the_archive_threshold() {
        let mut files = planned_files(256);
        let mut result = TransferResult::default();
        for file in files.drain(..32) {
            result.items.push(item_result(file, Ok(1024)));
        }
        let jobs = make_jobs(
            files,
            &request(),
            Some(crate::archive_transfer::TarCapability { gzip: false }),
            &mut result,
        )
        .unwrap();
        assert!(jobs.iter().any(|job| matches!(job, FileJob::Archive(..))));
        assert_eq!(result.engine, "mixed");
    }

    #[test]
    #[cfg(unix)]
    fn incomplete_metadata_does_not_disable_archive_for_other_files() {
        let mut files = planned_files(257);
        files[0].stamp.modified = None;
        let mut result = TransferResult::default();
        let jobs = make_jobs(
            files,
            &request(),
            Some(crate::archive_transfer::TarCapability { gzip: true }),
            &mut result,
        )
        .unwrap();
        assert!(jobs.iter().any(|job| matches!(job, FileJob::Archive(..))));
        assert!(jobs
            .iter()
            .any(|job| matches!(job, FileJob::Sftp(file) if file.stamp.modified.is_none())));
        assert_eq!(result.engine, "mixed");
    }

    #[test]
    fn retry_never_repeats_succeeded_or_unknown_files() {
        let registry = Registry::default();
        let mut files = planned_files(4).into_iter();
        let result = TransferResult {
            items: vec![
                item_result(files.next().unwrap(), Ok(1024)),
                item_result(
                    files.next().unwrap(),
                    Err(SshError::CommitOutcomeUnknown("核对目标".into())),
                ),
                item_result(
                    files.next().unwrap(),
                    Err(SshError::PermissionDenied("拒绝".into())),
                ),
                item_result(files.next().unwrap(), Err(SshError::TransferCancelled)),
            ],
            ..Default::default()
        };
        registry.store("batch", "owner".into(), request(), result);
        assert!(registry.retry("batch", "other-window").is_none());
        let retry = registry.retry("batch", "owner").unwrap();
        assert_eq!(retry.entries.len(), 2);
        assert!(retry.entries.iter().all(
            |entry| entry.local_path.ends_with("2.txt") || entry.local_path.ends_with("3.txt")
        ));
    }

    #[test]
    fn cached_results_expire_and_are_isolated_by_window() {
        let registry = Registry::default();
        registry.store(
            "expired",
            "owner".into(),
            request(),
            TransferResult::default(),
        );
        registry.store("live", "other".into(), request(), TransferResult::default());
        assert!(registry.result_page("expired", "other", 0, 256).is_none());
        registry
            .results
            .lock()
            .unwrap()
            .get_mut("expired")
            .unwrap()
            .created = Instant::now() - RESULT_TTL;
        registry.prune();
        assert!(registry.result_page("expired", "owner", 0, 256).is_none());
        assert!(registry.retry("expired", "owner").is_none());
        registry.clear_owner("owner");
        assert!(registry.result_page("live", "other", 0, 256).is_some());
        registry.clear_owner("other");
        assert!(registry.results.lock().unwrap().is_empty());
    }

    #[test]
    fn cached_results_evict_oldest_batches_and_preserve_page_boundaries() {
        let registry = Registry::default();
        for index in 0..=RESULT_CACHE_BATCHES {
            let files = planned_files(3);
            let result = TransferResult {
                items: files
                    .into_iter()
                    .map(|file| item_result(file, Ok(1024)))
                    .collect(),
                ..Default::default()
            };
            registry.store(&index.to_string(), "owner".into(), request(), result);
            registry
                .results
                .lock()
                .unwrap()
                .get_mut(&index.to_string())
                .unwrap()
                .created =
                Instant::now() - Duration::from_secs((RESULT_CACHE_BATCHES - index) as u64);
        }
        assert_eq!(registry.results.lock().unwrap().len(), RESULT_CACHE_BATCHES);
        assert!(registry.result_page("0", "owner", 0, 256).is_none());
        let first = registry.result_page("1", "owner", 0, 2).unwrap();
        assert_eq!(first["total"], 3);
        assert_eq!(first["items"].as_array().unwrap().len(), 2);
        assert_eq!(first["hasMore"], true);
        let last = registry.result_page("1", "owner", 2, 2).unwrap();
        assert_eq!(last["items"].as_array().unwrap().len(), 1);
        assert_eq!(last["hasMore"], false);
        assert_eq!(
            registry.result_page("1", "owner", usize::MAX, 256).unwrap()["items"],
            json!([])
        );
    }

    #[test]
    fn oversized_result_does_not_evict_unrelated_batches() {
        let registry = Registry::default();
        registry.store("kept", "owner".into(), request(), TransferResult::default());
        let mut row = request();
        row.entries[0].local_path = "a".repeat(RESULT_CACHE_BYTES + 1);
        registry.store("oversized", "owner".into(), row, TransferResult::default());
        assert!(registry.result_page("kept", "owner", 0, 256).is_some());
        assert!(registry.result_page("oversized", "owner", 0, 256).is_none());
    }

    #[test]
    fn structured_error_truncation_preserves_unicode_and_error_code() {
        let value = error_value(&SshError::PermissionDenied("权限".repeat(1024)));
        assert_eq!(value["code"], "PermissionDenied");
        let message = value["message"].as_str().unwrap();
        assert!(message.len() <= 1024);
        assert!(message.ends_with('…'));
    }
}
