//! 扫描期间的有限首块预取：只写随机私有暂存区，完整清单校验后才发布。
use super::*;
use crate::local_transfer::LocalStaging;
use crate::transfer_tasks::TaskLease;
use std::sync::mpsc::{self, Receiver, SyncSender};

const PREFETCH_FILES: usize = 32;
const PREFETCH_BYTES: u64 = 32 * 1024 * 1024;
const PREFETCH_FILE_BYTES: u64 = 1024 * 1024;

struct Spec {
    relative: PathBuf,
    remote: String,
    stamp: SourceStamp,
    id: String,
}
struct Ready {
    spec: Spec,
    result: Result<u64, SshError>,
}
type Resources = (
    TransferSessionLease,
    Arc<Mutex<Session>>,
    Arc<Sftp>,
    Option<RemoteMutationPolicy>,
);

pub(super) struct Prefetcher {
    sender: Option<SyncSender<Spec>>,
    result: Option<Receiver<Option<PreparedBatch>>>,
    cancel: Arc<AtomicBool>,
    count: usize,
    bytes: u64,
}

impl Prefetcher {
    /// 队列繁忙或工作名额不足时放弃预取，不能占着扫描名额等待另一个名额。
    pub(super) fn start(
        state: &SshState,
        connection: &SshConnection,
        task: &str,
        root: Arc<LocalTransferRoot>,
        upload: bool,
        remote_parent: String,
    ) -> Result<Self, SshError> {
        let (sender, receiver) = mpsc::sync_channel::<Spec>(PREFETCH_FILES);
        let (result_sender, result) = mpsc::sync_channel(1);
        let cancel = Arc::new(AtomicBool::new(false));
        let worker_cancel = cancel.clone();
        let state = state.clone();
        let connection = connection.clone();
        let task = task.to_owned();
        super::transfer_service::submit_worker(Box::new(move || {
            let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                let first = receiver.recv_timeout(Duration::from_millis(100)).ok()?;
                let slot = state.tasks.try_acquire_worker(&task, "prefetch").ok()?;
                let mut lease =
                    TransferSessionLease::checkout_worker(&state, &connection, &task, "prefetch")
                        .ok()?;
                let session = lease.session();
                let sftp = lease.sftp().ok()?;
                let policy = if upload {
                    Some(remote_mutation_policy(&state, &connection.id, &session).ok()?)
                } else {
                    None
                };
                let mut batch = PreparedBatch {
                    state: state.clone(),
                    task: task.clone(),
                    root,
                    upload,
                    cancel: worker_cancel.clone(),
                    resources: Some((lease, session, sftp, policy)),
                    slot: Some(slot),
                    local: None,
                    remote: None,
                    rows: Vec::new(),
                    healthy: true,
                };
                if batch.prepare(&remote_parent).is_err() {
                    batch.healthy = false;
                    return None;
                }
                let buffer = Mutex::new(vec![0u8; TRANSFER_BUFFER_SIZE]);
                let mut pending = Some(first);
                while !worker_cancel.load(Ordering::Acquire) {
                    let spec = match pending
                        .take()
                        .or_else(|| receiver.recv_timeout(Duration::from_millis(100)).ok())
                    {
                        Some(spec) => spec,
                        None => break,
                    };
                    let (_, session, sftp, policy) = batch.resources.as_ref().unwrap();
                    let context = FileTransferContext {
                        state: &state,
                        connection: &connection,
                        sftp,
                        session,
                        transfer_id: &task,
                        overwrite: false,
                        worker_id: Some("prefetch"),
                        buffer: Some(&buffer),
                        rename_client: None,
                        expected_source: Some(&spec.stamp),
                        local_cancellation: Some(&worker_cancel),
                    };
                    let result = if upload {
                        let temporary = format!("{}/{}", batch.remote.as_ref().unwrap(), spec.id);
                        batch
                            .root
                            .open_source(&spec.relative)
                            .map_err(SshError::from)
                            .and_then(|file| {
                                upload_file_to_sftp(
                                    &context,
                                    policy.as_ref().unwrap(),
                                    file,
                                    &temporary,
                                    |_, _| state.tasks.heartbeat(&task),
                                )
                            })
                    } else {
                        batch
                            .local
                            .as_ref()
                            .unwrap()
                            .root()
                            .prepare_download(Path::new(&spec.id), false)
                            .map_err(SshError::from)
                            .and_then(|file| {
                                download_file_to_local(&context, &spec.remote, file, |_, _| {
                                    state.tasks.heartbeat(&task)
                                })
                            })
                    };
                    state.tasks.end_commit(&task, "prefetch");
                    let failed = result.is_err();
                    batch.rows.push(Ready { spec, result });
                    if failed {
                        batch.healthy = false;
                        break;
                    }
                }
                Some(batch)
            }))
            .unwrap_or(None);
            let _ = result_sender.send(outcome);
        }))?;
        Ok(Self {
            sender: Some(sender),
            result: Some(result),
            cancel,
            count: 0,
            bytes: 0,
        })
    }

    pub(super) fn offer(&mut self, relative: &Path, remote: &str, stamp: SourceStamp) -> bool {
        let Some(size) = stamp.size else {
            return false;
        };
        if self.count >= PREFETCH_FILES
            || size > PREFETCH_FILE_BYTES
            || size > PREFETCH_BYTES.saturating_sub(self.bytes)
            || self.cancel.load(Ordering::Acquire)
        {
            return false;
        }
        let spec = Spec {
            relative: relative.to_owned(),
            remote: remote.to_owned(),
            stamp,
            id: format!("p{:08x}", self.count),
        };
        if self
            .sender
            .as_ref()
            .is_some_and(|sender| sender.try_send(spec).is_ok())
        {
            self.count += 1;
            self.bytes += size;
            true
        } else {
            false
        }
    }

    pub(super) fn finish(mut self) -> Option<PreparedBatch> {
        self.sender.take();
        self.result.take()?.recv().ok().flatten()
    }
}
impl Drop for Prefetcher {
    fn drop(&mut self) {
        let Some(receiver) = self.result.take() else {
            return;
        };
        self.cancel.store(true, Ordering::Release);
        self.sender.take();
        // 只回收本任务的有限预取作业；不留下后台工作者继续读取已失效的源。
        if let Ok(batch) = receiver.recv() {
            drop(batch);
        }
    }
}

pub(super) struct PreparedBatch {
    state: SshState,
    task: String,
    root: Arc<LocalTransferRoot>,
    upload: bool,
    cancel: Arc<AtomicBool>,
    resources: Option<Resources>,
    slot: Option<TaskLease>,
    local: Option<LocalStaging>,
    remote: Option<String>,
    rows: Vec<Ready>,
    healthy: bool,
}
impl PreparedBatch {
    fn prepare(&mut self, parent: &str) -> Result<(), SshError> {
        if self.upload {
            let (_, _, sftp, policy) = self.resources.as_ref().unwrap();
            let path = format!(
                "{}/.portal-stage-{:032x}",
                parent.trim_end_matches('/'),
                rand::random::<u128>()
            );
            let policy = policy.as_ref().unwrap();
            policy
                .validate_parent(sftp, Path::new(&path))
                .map_err(SshError::FileOperationFailed)?;
            sftp.mkdir(Path::new(&path), 0o700)
                .map_err(|error| SshError::FileOperationFailed(error.to_string()))?;
            self.remote = Some(path);
            policy
                .validate_directory(sftp, Path::new(self.remote.as_ref().unwrap()))
                .map_err(SshError::FileOperationFailed)
        } else {
            self.local = Some(self.root.private_staging()?);
            Ok(())
        }
    }

    /// 调用者只能在整个清单与目标名称验证通过后调用；任何预取错误仍返回原始错误码。
    pub(super) fn publish(mut self, overwrite: bool) -> Vec<(PathBuf, Result<u64, SshError>)> {
        let rows = std::mem::take(&mut self.rows);
        let mut outcomes = Vec::with_capacity(rows.len());
        for Ready { spec, result } in rows {
            let result = result.and_then(|bytes| {
                let (lease, session, sftp, policy) = self.resources.as_ref().unwrap();
                if self.state.tasks.cancelled_worker(&self.task, "prefetch") {
                    return Err(SshError::TransferCancelled);
                }
                if self.upload {
                    let policy = policy.as_ref().unwrap();
                    let now = SourceStamp::from_local_metadata(
                        &self.root.open_source(&spec.relative)?.metadata()?,
                    )?;
                    validate_transfer(&spec.stamp, &now, bytes)
                        .map_err(|error| SshError::SourceChanged(error.to_string()))?;
                    policy
                        .validate_parent(sftp, Path::new(&spec.remote))
                        .map_err(SshError::FileOperationFailed)?;
                    let before = upload_target_stamp(sftp, Path::new(&spec.remote))?;
                    if before.is_some() && !overwrite {
                        return Err(SshError::TargetExists(spec.remote.clone()));
                    }
                    let mode = validate_upload_target(before, before)
                        .map_err(|error| SshError::SourceChanged(error.into()))?;
                    let stage = format!("{}/{}", self.remote.as_ref().unwrap(), spec.id);
                    sftp.setstat(
                        Path::new(&stage),
                        ssh2::FileStat {
                            size: None,
                            uid: None,
                            gid: None,
                            perm: Some(mode),
                            atime: None,
                            mtime: None,
                        },
                    )
                    .map_err(|error| SshError::FileOperationFailed(error.to_string()))?;
                    let client = lease.rename_client();
                    let session = session.lock().unwrap().clone();
                    rename_remote_file_cached(
                        sftp,
                        &session,
                        Path::new(&stage),
                        Path::new(&spec.remote),
                        overwrite,
                        Some(&client),
                        || self.state.tasks.cancelled_worker(&self.task, "prefetch"),
                        || {
                            let current = upload_target_stamp(sftp, Path::new(&spec.remote))
                                .map_err(|error| {
                                    crate::sftp_commit::CommitError::Protocol(error.to_string())
                                })?;
                            validate_upload_target(before, current).map_err(|error| {
                                crate::sftp_commit::CommitError::Protocol(error.into())
                            })?;
                            self.state
                                .tasks
                                .begin_commit(&self.task, "prefetch")
                                .map_err(|_| crate::sftp_commit::CommitError::Cancelled)
                        },
                    )?;
                } else {
                    let stat = sftp
                        .lstat(Path::new(&spec.remote))
                        .map_err(|error| SshError::FileOperationFailed(error.to_string()))?;
                    if !stat.is_file() {
                        return Err(SshError::SourceChanged("预取源不再是普通文件".into()));
                    }
                    validate_transfer(&spec.stamp, &remote_source_stamp(&stat)?, bytes)
                        .map_err(|error| SshError::SourceChanged(error.to_string()))?;
                    self.state
                        .tasks
                        .begin_commit(&self.task, "prefetch")
                        .map_err(|_| SshError::TransferCancelled)?;
                    self.root.publish_from(
                        self.local.as_ref().unwrap().root(),
                        Path::new(&spec.id),
                        &spec.relative,
                        overwrite,
                    )?;
                }
                Ok(bytes)
            });
            self.state.tasks.end_commit(&self.task, "prefetch");
            if result.is_err() {
                self.healthy = false;
            }
            outcomes.push((spec.relative, result));
        }
        outcomes
    }
}
impl Drop for PreparedBatch {
    fn drop(&mut self) {
        self.cancel.store(true, Ordering::Release);
        if let (Some(remote), Some((_, _, sftp, _))) = (self.remote.take(), self.resources.as_ref())
        {
            // 上传的名字固定且最多 32 个；失败后停止，不能在已断开的连接上重复等待。
            for index in 0..PREFETCH_FILES {
                if let Err(error) = sftp.unlink(Path::new(&format!("{remote}/p{index:08x}"))) {
                    if !is_sftp_missing_path(&error) {
                        break;
                    }
                }
            }
            let _ = sftp.rmdir(Path::new(&remote));
        }
        self.local.take();
        if let Some((mut lease, session, sftp, _)) = self.resources.take() {
            drop(sftp);
            drop(session);
            if self.healthy && !self.state.tasks.cancelled(&self.task) {
                lease.reuse_on_success();
            }
            drop(lease);
        }
        self.slot.take();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefetch_offers_are_bounded_and_skip_large_or_unknown_sources() {
        let (sender, receiver) = mpsc::sync_channel(PREFETCH_FILES);
        let mut prefetch = Prefetcher {
            sender: Some(sender),
            result: None,
            cancel: Arc::new(AtomicBool::new(false)),
            count: 0,
            bytes: 0,
        };
        let unknown = SourceStamp::new(None, None);
        let large = SourceStamp::new(Some(PREFETCH_FILE_BYTES + 1), None);
        assert!(!prefetch.offer(Path::new("unknown"), "/unknown", unknown));
        assert!(!prefetch.offer(Path::new("large"), "/large", large));
        for index in 0..PREFETCH_FILES {
            assert!(prefetch.offer(
                Path::new(&format!("file-{index}")),
                "/file",
                SourceStamp::new(Some(PREFETCH_FILE_BYTES), None)
            ));
        }
        assert_eq!(prefetch.bytes, PREFETCH_BYTES);
        assert!(!prefetch.offer(
            Path::new("extra"),
            "/extra",
            SourceStamp::new(Some(1), None)
        ));
        assert_eq!(receiver.try_iter().count(), PREFETCH_FILES);
    }

    #[test]
    fn finishing_does_not_cancel_the_prepared_batch_or_wait_twice() {
        let (sender, _receiver) = mpsc::sync_channel(PREFETCH_FILES);
        let (ready, receiver) = mpsc::sync_channel(1);
        ready.send(None).unwrap();
        let cancellation = Arc::new(AtomicBool::new(false));
        let prefetch = Prefetcher {
            sender: Some(sender),
            result: Some(receiver),
            cancel: cancellation.clone(),
            count: 0,
            bytes: 0,
        };
        assert!(prefetch.finish().is_none());
        assert!(!cancellation.load(Ordering::Acquire));
    }
}
