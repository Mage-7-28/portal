//! 有界文件任务状态机。结果保存在原生端，事件仅作为实时通知。
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::net::{Shutdown, TcpStream};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

const TERMINAL_TTL: Duration = Duration::from_secs(600);
const START_TIMEOUT: Duration = Duration::from_secs(60);
const STALL_TIMEOUT: Duration = Duration::from_secs(120);
const CANCEL_TOMBSTONE_TTL: Duration = Duration::from_secs(120);
const MAX_CANCEL_TOMBSTONES: usize = 1024;
const MAX_IDENTIFIER_BYTES: usize = 256;
const MAX_ACTIVE_WORKERS: usize = 8;
const INITIAL_HOST_WORKERS: usize = 2;
const MAX_HOST_WORKERS: usize = 4;
const PROGRESS_INTERVAL: Duration = Duration::from_millis(100);

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TaskSnapshot {
    pub transfer_id: String,
    pub id: String,
    pub generation: u64,
    pub revision: u64,
    pub status: String,
    pub current: u64,
    pub total: Option<u64>,
    pub progress: f64,
    pub message: String,
    pub error: Option<Value>,
    pub result: Option<Value>,
}
impl TaskSnapshot {
    pub fn terminal(&self) -> bool {
        matches!(
            self.status.as_str(),
            "succeeded" | "partial" | "failed" | "cancelled"
        )
    }

    /// 调用方先按窗口读取快照；重试还须绑定已结束任务的原连接及其代次。
    pub fn allows_retry_for(&self, connection_id: &str, generation: u64) -> bool {
        self.terminal() && self.id == connection_id && self.generation == generation
    }
}

struct WorkerRecord {
    socket: Option<TcpStream>,
    committing: bool,
}
struct Record {
    snapshot: TaskSnapshot,
    owner: String,
    host: String,
    cancel: bool,
    updated: Instant,
    emitted: Option<Instant>,
    file: String,
    workers: HashMap<String, WorkerRecord>,
    legacy_commit_shield: bool,
}
#[derive(Default)]
struct Inner {
    records: HashMap<String, Record>,
    cancel_tombstones: HashMap<(String, String), Instant>,
    cancel_overflowed_at: Option<Instant>,
    next_worker_order: u64,
    active: usize,
    hosts: HashMap<String, usize>,
    host_limits: HashMap<String, usize>,
    waiting_workers: HashMap<(String, String), (String, u64)>,
}
#[derive(Default)]
pub(crate) struct TransferTasks {
    inner: Mutex<Inner>,
    wake: Condvar,
}
impl TransferTasks {
    fn valid_identifier(value: &str) -> bool {
        !value.is_empty() && value.len() <= MAX_IDENTIFIER_BYTES
    }

    pub fn register(
        &self,
        owner: &str,
        id: &str,
        connection: &str,
        generation: u64,
        host: &str,
    ) -> Result<TaskSnapshot, String> {
        if !Self::valid_identifier(owner) || !Self::valid_identifier(id) {
            return Err("任务标识无效".into());
        }
        let mut inner = self.inner.lock().map_err(|_| "任务状态锁已损坏")?;
        Self::prune(&mut inner);
        if inner
            .cancel_tombstones
            .contains_key(&(owner.to_owned(), id.to_owned()))
        {
            return Err("传输已取消".into());
        }
        if inner.records.contains_key(id) {
            return Err("任务标识已经使用，不能重复执行".into());
        }
        if inner.cancel_overflowed_at.is_some() {
            return Err("文件任务取消记录已满，请稍后重试".into());
        }
        if inner
            .records
            .values()
            .filter(|r| r.snapshot.status == "queued")
            .count()
            >= 64
        {
            return Err("文件任务等待队列已满".into());
        }
        let snapshot = TaskSnapshot {
            transfer_id: id.into(),
            id: connection.into(),
            generation,
            revision: 1,
            status: "queued".into(),
            current: 0,
            total: None,
            progress: 0.0,
            message: "等待执行".into(),
            error: None,
            result: None,
        };
        inner.records.insert(
            id.into(),
            Record {
                snapshot: snapshot.clone(),
                owner: owner.into(),
                host: host.into(),
                cancel: false,
                updated: Instant::now(),
                emitted: None,
                file: String::new(),
                workers: HashMap::new(),
                legacy_commit_shield: false,
            },
        );
        Ok(snapshot)
    }
    fn bump_revision(row: &mut Record) {
        row.snapshot.revision = row.snapshot.revision.saturating_add(1);
    }
    fn prune(inner: &mut Inner) {
        inner
            .cancel_tombstones
            .retain(|_, cancelled_at| cancelled_at.elapsed() < CANCEL_TOMBSTONE_TTL);
        if inner
            .cancel_overflowed_at
            .is_some_and(|at| at.elapsed() >= CANCEL_TOMBSTONE_TTL)
        {
            inner.cancel_overflowed_at = None;
        }
        inner
            .records
            .retain(|_, r| !r.snapshot.terminal() || r.updated.elapsed() < TERMINAL_TTL);
        while inner
            .records
            .values()
            .filter(|r| r.snapshot.terminal())
            .count()
            > 512
        {
            let oldest = inner
                .records
                .iter()
                .filter(|(_, r)| r.snapshot.terminal())
                .min_by_key(|(_, r)| r.updated)
                .map(|(id, _)| id.clone());
            if let Some(id) = oldest {
                inner.records.remove(&id);
            }
        }
    }
    /// 为旧的单文件/删除执行者申请唯一名额。
    pub fn acquire(self: &Arc<Self>, id: &str) -> Result<TaskLease, String> {
        self.acquire_inner(id, "", true)
    }

    /// 为父任务的一个独立 worker 申请数据名额；父协调者自身无需持有名额。
    ///
    /// `worker_id` 在同一父任务内必须唯一；等待主机容量时不占用全局容量。
    pub fn acquire_worker(
        self: &Arc<Self>,
        id: &str,
        worker_id: &str,
    ) -> Result<TaskLease, String> {
        if !Self::valid_identifier(worker_id) {
            return Err("工作线程标识无效".into());
        }
        self.acquire_inner(id, worker_id, false)
    }

    /// 预取是可选工作；名额繁忙时立即返回，避免扫描者持有名额形成循环等待。
    pub fn try_acquire_worker(
        self: &Arc<Self>,
        id: &str,
        worker_id: &str,
    ) -> Result<TaskLease, String> {
        if !Self::valid_identifier(worker_id) {
            return Err("工作线程标识无效".into());
        }
        let mut inner = self.inner.lock().map_err(|_| "任务状态锁已损坏")?;
        let row = inner.records.get(id).ok_or("任务不存在")?;
        if row.cancel || row.snapshot.terminal() || row.workers.contains_key(worker_id) {
            return Err("预取任务已取消或重复".into());
        }
        let host = row.host.clone();
        let limit = inner
            .host_limits
            .get(&host)
            .copied()
            .unwrap_or(INITIAL_HOST_WORKERS);
        if inner.active >= MAX_ACTIVE_WORKERS
            || inner.hosts.get(&host).copied().unwrap_or(0) >= limit
            || inner
                .waiting_workers
                .values()
                .any(|(waiting, _)| waiting == &host)
        {
            return Err("预取名额繁忙".into());
        }
        inner.active += 1;
        *inner.hosts.entry(host.clone()).or_default() += 1;
        inner.records.get_mut(id).unwrap().workers.insert(
            worker_id.into(),
            WorkerRecord {
                socket: None,
                committing: false,
            },
        );
        Ok(TaskLease {
            tasks: self.clone(),
            host,
            task_id: id.into(),
            worker_id: worker_id.into(),
        })
    }

    fn acquire_inner(
        self: &Arc<Self>,
        id: &str,
        worker_id: &str,
        legacy: bool,
    ) -> Result<TaskLease, String> {
        let mut inner = self.inner.lock().map_err(|_| "任务状态锁已损坏")?;
        let key = (id.to_owned(), worker_id.to_owned());
        let row = inner.records.get(id).ok_or("任务不存在")?;
        if row.cancel || row.snapshot.terminal() {
            return Err("传输已取消".into());
        }
        if (legacy && row.snapshot.status != "queued")
            || row.workers.contains_key(worker_id)
            || inner.waiting_workers.contains_key(&key)
        {
            return Err("任务已开始或结束，不能重复执行".into());
        }
        let host = row.host.clone();
        inner.next_worker_order = inner.next_worker_order.saturating_add(1);
        let order = inner.next_worker_order;
        inner
            .waiting_workers
            .insert(key.clone(), (host.clone(), order));

        loop {
            let valid = inner.records.get(id).is_some_and(|row| {
                !row.cancel
                    && !row.snapshot.terminal()
                    && (!legacy || row.snapshot.status == "queued")
            });
            if !valid {
                inner.waiting_workers.remove(&key);
                self.wake.notify_all();
                return Err("传输已取消".into());
            }
            let earlier = inner
                .waiting_workers
                .values()
                .any(|(other_host, other_order)| other_host == &host && *other_order < order);
            let host_active = inner.hosts.get(&host).copied().unwrap_or(0);
            // 初始两条并发完成会话握手后可逐步扩展至四条；报告连接成功前不扩大。
            let host_limit = inner
                .host_limits
                .get(&host)
                .copied()
                .unwrap_or(INITIAL_HOST_WORKERS);
            if !earlier && inner.active < MAX_ACTIVE_WORKERS && host_active < host_limit {
                inner.waiting_workers.remove(&key);
                inner.active += 1;
                *inner.hosts.entry(host.clone()).or_default() += 1;
                let row = inner.records.get_mut(id).unwrap();
                row.workers.insert(
                    worker_id.to_owned(),
                    WorkerRecord {
                        socket: None,
                        committing: false,
                    },
                );
                if legacy {
                    row.snapshot.status = "starting".into();
                    Self::bump_revision(row);
                }
                row.updated = Instant::now();
                self.wake.notify_all();
                return Ok(TaskLease {
                    tasks: self.clone(),
                    host,
                    task_id: id.to_owned(),
                    worker_id: worker_id.to_owned(),
                });
            }
            inner = self.wake.wait(inner).map_err(|_| "任务状态锁已损坏")?;
        }
    }

    /// 成功建立独立会话后，逐步提高该物理对端的并发上限。
    pub fn worker_connected(&self, id: &str) {
        let mut inner = self.inner.lock().unwrap();
        if let Some(host) = inner.records.get(id).map(|row| row.host.clone()) {
            let limit = inner
                .host_limits
                .entry(host)
                .or_insert(INITIAL_HOST_WORKERS);
            *limit = (*limit + 1).min(MAX_HOST_WORKERS);
            self.wake.notify_all();
        }
    }
    pub fn snapshots(&self, owner: &str, ids: &[String]) -> Vec<TaskSnapshot> {
        let mut inner = self.inner.lock().unwrap();
        Self::prune(&mut inner);
        ids.iter()
            .take(68)
            .filter_map(|id| {
                inner
                    .records
                    .get(id)
                    .filter(|r| r.owner == owner)
                    .map(|r| r.snapshot.clone())
            })
            .collect()
    }
    pub fn owner(&self, id: &str) -> Option<String> {
        self.inner
            .lock()
            .unwrap()
            .records
            .get(id)
            .map(|r| r.owner.clone())
    }
    pub fn generation(&self, id: &str) -> Option<u64> {
        self.inner
            .lock()
            .unwrap()
            .records
            .get(id)
            .map(|r| r.snapshot.generation)
    }
    /// 为当前 worker 绑定 socket；取消或标识冲突时拒绝并中断新 socket。
    pub fn attach_worker_socket(&self, id: &str, worker_id: &str, socket: TcpStream) -> bool {
        let mut inner = self.inner.lock().unwrap();
        let Some(row) = inner.records.get_mut(id) else {
            let _ = socket.shutdown(Shutdown::Both);
            return false;
        };
        if row.cancel || row.snapshot.terminal() {
            let _ = socket.shutdown(Shutdown::Both);
            return false;
        }
        let Some(worker) = row.workers.get_mut(worker_id) else {
            let _ = socket.shutdown(Shutdown::Both);
            return false;
        };
        if worker.socket.is_some() {
            let _ = socket.shutdown(Shutdown::Both);
            return false;
        }
        worker.socket = Some(socket);
        true
    }

    /// 归还会话前先移除对应取消句柄，避免迟到取消关闭其他任务复用的 socket。
    pub fn detach_worker_socket(&self, id: &str, worker_id: &str) -> bool {
        let mut inner = self.inner.lock().unwrap();
        if let Some(row) = inner.records.get_mut(id) {
            if let Some(worker) = row.workers.get_mut(worker_id) {
                worker.socket = None;
            }
            row.cancel || row.snapshot.terminal()
        } else {
            true
        }
    }
    pub fn running(&self, id: &str) {
        if let Some(row) = self.inner.lock().unwrap().records.get_mut(id) {
            if !row.snapshot.terminal() {
                if row.legacy_commit_shield {
                    row.legacy_commit_shield = false;
                    if let Some(worker) = row.workers.get_mut("") {
                        worker.committing = false;
                        if row.cancel {
                            if let Some(socket) = &worker.socket {
                                let _ = socket.shutdown(Shutdown::Both);
                            }
                        }
                    }
                }
                if row.snapshot.status != "running" {
                    Self::bump_revision(row);
                }
                row.snapshot.status = "running".into();
                row.updated = Instant::now();
            }
        }
    }
    /// 实际完成目录操作时刷新停滞时间；不会改变已取消或终态任务。
    pub fn heartbeat(&self, id: &str) {
        if let Some(row) = self.inner.lock().unwrap().records.get_mut(id) {
            if !row.cancel && !row.snapshot.terminal() {
                row.updated = Instant::now();
            }
        }
    }
    pub fn committing(&self, id: &str) -> Result<(), String> {
        let mut inner = self.inner.lock().unwrap();
        let row = inner.records.get_mut(id).ok_or("任务不存在")?;
        if row.cancel || row.snapshot.terminal() {
            return Err("传输已取消".into());
        }
        row.legacy_commit_shield = true;
        row.workers
            .entry("".into())
            .or_insert(WorkerRecord {
                socket: None,
                committing: false,
            })
            .committing = true;
        row.snapshot.status = "committing".into();
        row.updated = Instant::now();
        Self::bump_revision(row);
        Ok(())
    }

    /// 原子地检查父任务取消状态并保护此 worker 的提交，不影响其他 worker。
    pub fn begin_commit(&self, id: &str, worker_id: &str) -> Result<(), String> {
        let mut inner = self.inner.lock().unwrap();
        let row = inner.records.get_mut(id).ok_or("任务不存在")?;
        if row.cancel || row.snapshot.terminal() {
            return Err("传输已取消".into());
        }
        let worker = row.workers.get_mut(worker_id).ok_or("工作线程不存在")?;
        if worker.committing {
            return Err("工作线程正在提交".into());
        }
        worker.committing = true;
        row.updated = Instant::now();
        Self::bump_revision(row);
        Ok(())
    }

    /// 离开提交保护；若期间已取消，立即中断此 worker 的独占连接。
    pub fn end_commit(&self, id: &str, worker_id: &str) {
        let mut inner = self.inner.lock().unwrap();
        if let Some(row) = inner.records.get_mut(id) {
            if let Some(worker) = row.workers.get_mut(worker_id) {
                if worker.committing {
                    worker.committing = false;
                    if row.cancel {
                        if let Some(socket) = &worker.socket {
                            let _ = socket.shutdown(Shutdown::Both);
                        }
                    }
                    Self::bump_revision(row);
                }
            }
        }
    }

    /// 字节增长重置停滞计时；整个父任务的进度事件最多 10Hz。
    pub fn progress(&self, id: &str, current: u64, total: Option<u64>, file: &str) -> bool {
        let mut inner = self.inner.lock().unwrap();
        let Some(row) = inner.records.get_mut(id) else {
            return false;
        };
        if row.snapshot.terminal() {
            return false;
        }
        let changed_file = row.file != file;
        if changed_file || current != row.snapshot.current {
            row.updated = Instant::now();
        }
        row.file = file.into();
        row.snapshot.current = current;
        row.snapshot.total = total;
        row.snapshot.progress = total
            .filter(|v| *v > 0)
            .map(|v| (current as f64 / v as f64 * 100.0).min(99.9))
            .unwrap_or(0.0);
        if row.snapshot.status != "committing" {
            row.snapshot.status = "running".into();
        }
        Self::bump_revision(row);
        let send = row
            .emitted
            .is_none_or(|last| last.elapsed() >= PROGRESS_INTERVAL);
        if send {
            row.emitted = Some(Instant::now());
        }
        send
    }
    pub fn cancelled(&self, id: &str) -> bool {
        self.inner
            .lock()
            .unwrap()
            .records
            .get(id)
            .is_none_or(|r| r.cancel && !r.legacy_commit_shield)
    }

    /// 只有正在提交的 worker 可暂时忽略父任务取消；其他 worker 仍立即停止。
    pub fn cancelled_worker(&self, id: &str, worker_id: &str) -> bool {
        self.inner.lock().unwrap().records.get(id).is_none_or(|r| {
            r.cancel
                && !r
                    .workers
                    .get(worker_id)
                    .is_some_and(|worker| worker.committing)
        })
    }
    fn cancel_row(row: &mut Record) {
        if row.snapshot.terminal() {
            return;
        }
        if !row.cancel {
            row.cancel = true;
            Self::bump_revision(row);
        }
        // 只保护已进入原子提交的独占连接，不保护其他并行 worker。
        for worker in row.workers.values() {
            if !worker.committing {
                if let Some(socket) = &worker.socket {
                    let _ = socket.shutdown(Shutdown::Both);
                }
            }
        }
    }
    pub fn cancel(&self, owner: &str, id: &str) -> Option<TaskSnapshot> {
        if !Self::valid_identifier(owner) || !Self::valid_identifier(id) {
            return None;
        }
        let mut inner = self.inner.lock().unwrap();
        if let Some(row) = inner.records.get_mut(id).filter(|r| r.owner == owner) {
            Self::cancel_row(row);
            self.wake.notify_all();
            return Some(row.snapshot.clone());
        }
        Self::prune(&mut inner);
        let now = Instant::now();
        let key = (owner.to_owned(), id.to_owned());
        if let Some(cancelled_at) = inner.cancel_tombstones.get_mut(&key) {
            *cancelled_at = now;
        } else if inner.cancel_tombstones.len() < MAX_CANCEL_TOMBSTONES {
            inner.cancel_tombstones.insert(key, now);
        } else {
            // 未能记录的取消也必须被保护；拒绝所有新登记直到其有效期结束。
            inner.cancel_overflowed_at = Some(now);
        }
        None
    }
    pub fn cancel_matching(&self, owner: Option<&str>, connection: Option<&str>) {
        for row in self.inner.lock().unwrap().records.values_mut() {
            if owner.is_none_or(|v| v == row.owner)
                && connection.is_none_or(|v| v == row.snapshot.id)
            {
                Self::cancel_row(row);
            }
        }
        self.wake.notify_all();
    }
    /// 看门狗只中断独占文件任务的 socket，不中断浏览和终端连接。
    pub fn expire_stalled(&self) {
        let mut inner = self.inner.lock().unwrap();
        for row in inner.records.values_mut() {
            let limit = match row.snapshot.status.as_str() {
                "starting" => START_TIMEOUT,
                "running" => STALL_TIMEOUT,
                _ => continue,
            };
            if !row.cancel && row.updated.elapsed() >= limit {
                row.snapshot.error = Some(
                    serde_json::json!({"code":"TaskStalled","message":"文件任务长时间没有进展","scope":"transfer"}),
                );
                Self::cancel_row(row);
            }
        }
        Self::prune(&mut inner);
        self.wake.notify_all();
    }

    /// 保存可恢复的聚合结果；终态一经发布不再改变。
    pub fn set_result(&self, id: &str, result: Value) -> bool {
        let mut inner = self.inner.lock().unwrap();
        let Some(row) = inner.records.get_mut(id) else {
            return false;
        };
        if row.snapshot.terminal() {
            return false;
        }
        row.snapshot.result = Some(result);
        Self::bump_revision(row);
        true
    }

    pub fn finish(&self, id: &str, result: Result<String, Value>) -> Option<TaskSnapshot> {
        let mut inner = self.inner.lock().unwrap();
        let row = inner.records.get_mut(id)?;
        if row.snapshot.terminal() {
            return Some(row.snapshot.clone());
        }
        match result {
            Ok(message) => {
                let partial = row.snapshot.result.as_ref().is_some_and(|result| {
                    ["failed", "unknown", "notStarted"]
                        .iter()
                        .any(|field| result.get(*field).and_then(Value::as_u64).unwrap_or(0) > 0)
                });
                row.snapshot.status = if partial { "partial" } else { "succeeded" }.into();
                row.snapshot.message = message;
                if !partial {
                    row.snapshot.progress = 100.0;
                }
                row.snapshot.error = None;
            }
            Err(error) => {
                let error = row.snapshot.error.take().unwrap_or(error);
                let cancelled =
                    error.get("code").and_then(Value::as_str) == Some("TransferCancelled");
                row.snapshot.status = if cancelled { "cancelled" } else { "failed" }.into();
                row.snapshot.message = error
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or(if cancelled {
                        "传输已取消"
                    } else {
                        "文件任务失败"
                    })
                    .into();
                row.snapshot.error = Some(error);
            }
        }
        row.updated = Instant::now();
        Self::bump_revision(row);
        self.wake.notify_all();
        Some(row.snapshot.clone())
    }
}
pub(crate) struct TaskLease {
    tasks: Arc<TransferTasks>,
    host: String,
    task_id: String,
    worker_id: String,
}
impl Drop for TaskLease {
    fn drop(&mut self) {
        let mut inner = self.tasks.inner.lock().unwrap();
        if let Some(row) = inner.records.get_mut(&self.task_id) {
            if let Some(worker) = row.workers.remove(&self.worker_id) {
                if let Some(socket) = worker.socket {
                    let _ = socket.shutdown(Shutdown::Both);
                }
            }
        }
        inner.active = inner.active.saturating_sub(1);
        if let Some(count) = inner.hosts.get_mut(&self.host) {
            *count = count.saturating_sub(1);
            if *count == 0 {
                inner.hosts.remove(&self.host);
                inner.host_limits.remove(&self.host);
            }
        }
        self.tasks.wake.notify_all();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;
    fn register(tasks: &TransferTasks, id: &str) {
        tasks
            .register("window", id, "connection", 1, "host:22")
            .unwrap();
    }
    #[test]
    fn cancellation_before_registration_rejects_every_late_start() {
        let tasks = TransferTasks::default();
        assert!(tasks.cancel("window", "late").is_none());
        for _ in 0..2 {
            assert_eq!(
                tasks
                    .register("window", "late", "connection", 1, "host:22")
                    .unwrap_err(),
                "传输已取消"
            );
        }
        assert!(tasks.snapshots("window", &["late".into()]).is_empty());
    }
    #[test]
    fn concurrent_cancellation_and_registration_cannot_lose_cancellation() {
        for _ in 0..100 {
            let tasks = Arc::new(TransferTasks::default());
            let start = Arc::new(std::sync::Barrier::new(3));
            let registering = tasks.clone();
            let register_start = start.clone();
            let register_thread = std::thread::spawn(move || {
                register_start.wait();
                registering.register("window", "racing", "connection", 1, "host:22")
            });
            let cancelling = tasks.clone();
            let cancel_start = start.clone();
            let cancel_thread = std::thread::spawn(move || {
                cancel_start.wait();
                cancelling.cancel("window", "racing")
            });
            start.wait();
            let registered = register_thread.join().unwrap();
            let cancelled = cancel_thread.join().unwrap();
            match registered {
                Ok(_) => {
                    assert!(cancelled.is_some());
                    assert!(tasks.cancelled("racing"));
                }
                Err(error) => {
                    assert!(cancelled.is_none());
                    assert_eq!(error, "传输已取消");
                }
            }
        }
    }
    #[test]
    fn another_owner_cannot_consume_or_override_a_pre_cancellation() {
        let tasks = TransferTasks::default();
        tasks.cancel("alice", "shared");
        tasks
            .register("bob", "shared", "connection", 1, "host:22")
            .unwrap();
        assert!(tasks.cancel("charlie", "shared").is_none());
        assert!(!tasks.cancelled("shared"));
        assert_eq!(
            tasks
                .register("alice", "shared", "connection", 1, "host:22")
                .unwrap_err(),
            "传输已取消"
        );
        assert_eq!(
            tasks
                .register("charlie", "shared", "connection", 1, "host:22")
                .unwrap_err(),
            "传输已取消"
        );
    }
    #[test]
    fn pre_cancellations_for_the_same_id_are_isolated_by_owner() {
        let tasks = TransferTasks::default();
        tasks.cancel("alice", "shared");
        tasks.cancel("bob", "shared");
        for owner in ["alice", "bob"] {
            assert_eq!(
                tasks
                    .register(owner, "shared", "connection", 1, "host:22")
                    .unwrap_err(),
                "传输已取消"
            );
        }
        tasks
            .register("charlie", "shared", "connection", 1, "host:22")
            .unwrap();
    }
    #[test]
    fn saturation_never_evicts_a_live_cancellation_or_starts_an_overflow() {
        let tasks = TransferTasks::default();
        for index in 0..=MAX_CANCEL_TOMBSTONES {
            tasks.cancel("window", &format!("task-{index}"));
        }
        assert_eq!(
            tasks.inner.lock().unwrap().cancel_tombstones.len(),
            MAX_CANCEL_TOMBSTONES
        );
        assert_eq!(
            tasks
                .register("window", "task-0", "connection", 1, "host:22")
                .unwrap_err(),
            "传输已取消"
        );
        assert!(tasks
            .register(
                "window",
                &format!("task-{MAX_CANCEL_TOMBSTONES}"),
                "connection",
                1,
                "host:22",
            )
            .is_err());
        assert!(tasks
            .register("window", "unrelated", "connection", 1, "host:22")
            .is_err());
    }
    #[test]
    fn pre_cancellation_expires_after_120_seconds_and_can_be_registered() {
        let tasks = TransferTasks::default();
        let key = ("window".to_owned(), "late".to_owned());
        assert_eq!(CANCEL_TOMBSTONE_TTL, Duration::from_secs(120));
        tasks.cancel("window", "late");
        *tasks
            .inner
            .lock()
            .unwrap()
            .cancel_tombstones
            .get_mut(&key)
            .unwrap() = Instant::now() - Duration::from_secs(119);
        assert_eq!(
            tasks
                .register("window", "late", "connection", 1, "host:22")
                .unwrap_err(),
            "传输已取消"
        );
        *tasks
            .inner
            .lock()
            .unwrap()
            .cancel_tombstones
            .get_mut(&key)
            .unwrap() = Instant::now() - CANCEL_TOMBSTONE_TTL;
        tasks
            .register("window", "late", "connection", 1, "host:22")
            .unwrap();
        assert!(!tasks
            .inner
            .lock()
            .unwrap()
            .cancel_tombstones
            .contains_key(&key));
    }
    #[test]
    fn repeated_pre_cancellation_refreshes_its_expiration() {
        let tasks = TransferTasks::default();
        let key = ("window".to_owned(), "late".to_owned());
        tasks.cancel("window", "late");
        let old = Instant::now() - Duration::from_secs(119);
        *tasks
            .inner
            .lock()
            .unwrap()
            .cancel_tombstones
            .get_mut(&key)
            .unwrap() = old;
        tasks.cancel("window", "late");
        assert!(tasks.inner.lock().unwrap().cancel_tombstones[&key] > old);
    }
    #[test]
    fn overflow_guard_tracks_the_latest_unrecorded_cancel_and_expires() {
        let tasks = TransferTasks::default();
        for index in 0..=MAX_CANCEL_TOMBSTONES {
            tasks.cancel("window", &format!("task-{index}"));
        }
        let old = Instant::now() - Duration::from_secs(119);
        tasks.inner.lock().unwrap().cancel_overflowed_at = Some(old);
        tasks.cancel("window", "overflow-again");
        {
            let mut inner = tasks.inner.lock().unwrap();
            assert!(inner.cancel_overflowed_at.unwrap() > old);
            for cancelled_at in inner.cancel_tombstones.values_mut() {
                *cancelled_at = Instant::now() - CANCEL_TOMBSTONE_TTL;
            }
        }
        // 已存储的墓碑先过期时，仍须保护未能存储的取消请求。
        assert!(tasks
            .register("window", "overflow-again", "connection", 1, "host:22")
            .is_err());
        assert!(tasks.inner.lock().unwrap().cancel_tombstones.is_empty());
        tasks.inner.lock().unwrap().cancel_overflowed_at =
            Some(Instant::now() - CANCEL_TOMBSTONE_TTL);
        tasks
            .register("window", "overflow-again", "connection", 1, "host:22")
            .unwrap();
    }
    #[test]
    fn overflow_guard_does_not_block_cancellation_of_a_registered_task() {
        let tasks = TransferTasks::default();
        register(&tasks, "running");
        tasks.running("running");
        for index in 0..=MAX_CANCEL_TOMBSTONES {
            tasks.cancel("window", &format!("task-{index}"));
        }
        assert!(tasks.cancel("window", "running").is_some());
        assert!(tasks.cancelled("running"));
    }
    #[test]
    fn invalid_cancellation_ids_do_not_exhaust_cancellation_capacity() {
        let tasks = TransferTasks::default();
        tasks.cancel("window", "");
        for index in 0..=MAX_CANCEL_TOMBSTONES {
            tasks.cancel("window", &format!("{}{index}", "x".repeat(257)));
            tasks.cancel(&format!("{}{index}", "x".repeat(257)), "valid");
        }
        tasks.cancel("", "valid");
        tasks
            .register("window", "valid", "connection", 1, "host:22")
            .unwrap();
        assert!(tasks
            .register("", "invalid-owner", "connection", 1, "host:22")
            .is_err());
    }
    #[test]
    fn cancellation_identifiers_are_limited_by_utf8_byte_length() {
        let tasks = TransferTasks::default();
        let longest = "界".repeat(85) + "a";
        let too_long = "界".repeat(86);
        assert_eq!(longest.len(), 256);
        assert!(too_long.len() > 256);
        tasks.cancel("window", &longest);
        assert_eq!(
            tasks
                .register("window", &longest, "connection", 1, "host:22")
                .unwrap_err(),
            "传输已取消"
        );
        assert!(tasks
            .register("window", &too_long, "connection", 1, "host:22")
            .is_err());
        assert!(tasks
            .register(&too_long, "valid-id", "connection", 1, "host:22")
            .is_err());
    }
    #[test]
    fn cancellation_during_commit_becomes_visible_when_running_resumes() {
        let tasks = TransferTasks::default();
        register(&tasks, "directory");
        tasks.running("directory");
        tasks.committing("directory").unwrap();
        tasks.cancel("window", "directory");
        assert!(!tasks.cancelled("directory"));
        tasks.running("directory");
        assert!(tasks.cancelled("directory"));
        assert_eq!(tasks.committing("directory").unwrap_err(), "传输已取消");
        assert_eq!(
            tasks
                .finish(
                    "directory",
                    Err(serde_json::json!({"code":"TransferCancelled"})),
                )
                .unwrap()
                .status,
            "cancelled"
        );
    }
    #[test]
    fn owns_results_and_rejects_duplicate_execution() {
        let tasks = TransferTasks::default();
        register(&tasks, "a");
        assert!(tasks
            .register("window", "a", "connection", 1, "host:22")
            .is_err());
        assert!(tasks.cancel("other", "a").is_none());
        assert!(tasks.snapshots("other", &["a".into()]).is_empty());
    }
    #[test]
    fn retry_requires_the_original_completed_connection_generation() {
        let tasks = TransferTasks::default();
        tasks
            .register("window", "batch", "connection-a", 7, "host:22")
            .unwrap();
        let snapshot = tasks.snapshots("window", &["batch".into()]).pop().unwrap();
        assert!(!snapshot.allows_retry_for("connection-a", 7));
        tasks.finish("batch", Err(serde_json::json!({"code":"PermissionDenied"})));
        let snapshot = tasks.snapshots("window", &["batch".into()]).pop().unwrap();
        assert!(snapshot.allows_retry_for("connection-a", 7));
        assert!(!snapshot.allows_retry_for("connection-b", 7));
        assert!(!snapshot.allows_retry_for("connection-a", 8));
        assert!(tasks
            .snapshots("other-window", &["batch".into()])
            .is_empty());
    }
    #[test]
    fn acquiring_the_same_task_twice_does_not_duplicate_execution_slots() {
        let tasks = Arc::new(TransferTasks::default());
        register(&tasks, "duplicate");
        let lease = tasks.acquire("duplicate").unwrap();
        assert!(tasks.acquire("duplicate").is_err());
        assert_eq!(tasks.inner.lock().unwrap().active, 1);
        tasks.running("duplicate");
        assert!(tasks.acquire("duplicate").is_err());
        tasks.finish("duplicate", Ok("done".into()));
        assert!(tasks.acquire("duplicate").is_err());
        drop(lease);
        let inner = tasks.inner.lock().unwrap();
        assert_eq!(inner.active, 0);
        assert!(inner.hosts.is_empty());
    }
    #[test]
    fn optional_prefetch_respects_limits_and_releases_its_slot() {
        let tasks = Arc::new(TransferTasks::default());
        register(&tasks, "prefetch");
        let first = tasks.try_acquire_worker("prefetch", "first").unwrap();
        let second = tasks.try_acquire_worker("prefetch", "second").unwrap();
        assert!(tasks.try_acquire_worker("prefetch", "first").is_err());
        assert!(tasks.try_acquire_worker("prefetch", "overflow").is_err());
        assert_eq!(tasks.inner.lock().unwrap().active, INITIAL_HOST_WORKERS);
        drop(first);
        let replacement = tasks.try_acquire_worker("prefetch", "replacement").unwrap();
        drop(second);
        drop(replacement);
        assert_eq!(tasks.inner.lock().unwrap().active, 0);
        tasks.cancel("window", "prefetch");
        assert!(tasks.try_acquire_worker("prefetch", "cancelled").is_err());
    }

    #[test]
    fn optional_prefetch_never_jumps_a_host_waiter() {
        let tasks = Arc::new(TransferTasks::default());
        register(&tasks, "prefetch");
        tasks
            .inner
            .lock()
            .unwrap()
            .waiting_workers
            .insert(("waiting".into(), "worker".into()), ("host:22".into(), 1));
        assert!(tasks.try_acquire_worker("prefetch", "optional").is_err());
        assert_eq!(tasks.inner.lock().unwrap().active, 0);
    }
    #[test]
    fn cancel_during_commit_does_not_override_actual_success() {
        let tasks = TransferTasks::default();
        register(&tasks, "a");
        tasks.running("a");
        tasks.committing("a").unwrap();
        tasks.cancel("window", "a");
        assert!(!tasks.cancelled("a"));
        let result = tasks.finish("a", Ok("完成".into())).unwrap();
        assert_eq!(result.status, "succeeded");
        assert_eq!(
            tasks
                .finish("a", Err(serde_json::json!({"code":"TransferCancelled"})))
                .unwrap()
                .status,
            "succeeded"
        );
    }
    #[test]
    fn cancel_during_commit_does_not_override_actual_failure() {
        let tasks = TransferTasks::default();
        register(&tasks, "a");
        tasks.running("a");
        tasks.committing("a").unwrap();
        tasks.cancel("window", "a");
        let result = tasks
            .finish("a", Err(serde_json::json!({"code":"CommitFailed"})))
            .unwrap();
        assert_eq!(result.status, "failed");
        assert_eq!(result.error.unwrap()["code"], "CommitFailed");
    }
    #[test]
    fn releases_execution_slot_and_does_not_timeout_healthy_long_tasks() {
        let tasks = Arc::new(TransferTasks::default());
        register(&tasks, "a");
        let lease = tasks.acquire("a").unwrap();
        tasks.running("a");
        tasks
            .inner
            .lock()
            .unwrap()
            .records
            .get_mut("a")
            .unwrap()
            .updated = Instant::now() - Duration::from_secs(3600);
        tasks.progress("a", 1, Some(10), "f");
        tasks.expire_stalled();
        assert!(!tasks.cancelled("a"));
        drop(lease);
        assert_eq!(tasks.inner.lock().unwrap().active, 0);
    }
    #[test]
    fn directory_heartbeat_refreshes_stall_time_without_changing_progress() {
        let tasks = Arc::new(TransferTasks::default());
        register(&tasks, "directory");
        let _lease = tasks.acquire("directory").unwrap();
        tasks.running("directory");
        let before = tasks.snapshots("window", &["directory".into()]).remove(0);
        tasks
            .inner
            .lock()
            .unwrap()
            .records
            .get_mut("directory")
            .unwrap()
            .updated = Instant::now() - Duration::from_secs(3600);
        tasks.heartbeat("directory");
        tasks.expire_stalled();
        let after = tasks.snapshots("window", &["directory".into()]).remove(0);
        assert!(!tasks.cancelled("directory"));
        assert_eq!(after.status, before.status);
        assert_eq!(after.current, before.current);
        assert_eq!(after.total, before.total);
        assert_eq!(after.progress, before.progress);
        assert_eq!(after.message, before.message);
        assert_eq!(after.error, before.error);
    }
    #[test]
    fn heartbeat_never_revives_cancelled_or_terminal_tasks() {
        let tasks = TransferTasks::default();
        register(&tasks, "cancelled");
        tasks.running("cancelled");
        tasks.cancel("window", "cancelled");
        let old = Instant::now() - Duration::from_secs(601);
        tasks
            .inner
            .lock()
            .unwrap()
            .records
            .get_mut("cancelled")
            .unwrap()
            .updated = old;
        tasks.heartbeat("cancelled");
        assert!(tasks.cancelled("cancelled"));
        assert_eq!(
            tasks.inner.lock().unwrap().records["cancelled"].updated,
            old
        );
        let cancelled = tasks
            .finish(
                "cancelled",
                Err(serde_json::json!({"code":"TransferCancelled"})),
            )
            .unwrap();
        assert_eq!(cancelled.status, "cancelled");
        tasks
            .inner
            .lock()
            .unwrap()
            .records
            .get_mut("cancelled")
            .unwrap()
            .updated = old;
        tasks.heartbeat("cancelled");
        assert!(tasks.snapshots("window", &["cancelled".into()]).is_empty());

        register(&tasks, "succeeded");
        tasks.finish("succeeded", Ok("done".into()));
        tasks
            .inner
            .lock()
            .unwrap()
            .records
            .get_mut("succeeded")
            .unwrap()
            .updated = old;
        tasks.heartbeat("succeeded");
        tasks.heartbeat("missing");
        assert!(tasks.snapshots("window", &["succeeded".into()]).is_empty());
    }
    #[test]
    fn stalls_are_cancelled_and_terminal_error_is_retained() {
        let tasks = TransferTasks::default();
        register(&tasks, "a");
        tasks.running("a");
        tasks
            .inner
            .lock()
            .unwrap()
            .records
            .get_mut("a")
            .unwrap()
            .updated = Instant::now() - Duration::from_secs(121);
        tasks.expire_stalled();
        assert!(tasks.cancelled("a"));
        assert_eq!(
            tasks
                .finish("a", Err(serde_json::json!({"code":"TransferCancelled"})))
                .unwrap()
                .error
                .unwrap()["code"],
            "TaskStalled"
        );
    }
    #[test]
    fn throttles_progress_even_when_files_change() {
        let tasks = TransferTasks::default();
        register(&tasks, "a");
        assert!(tasks.progress("a", 0, Some(10), "a"));
        assert!(!tasks.progress("a", 1, Some(10), "a"));
        assert!(!tasks.progress("a", 0, None, "b"));
        assert!(tasks.snapshots("window", &["a".into()])[0].total.is_none());
    }

    #[test]
    fn result_and_revision_are_retained_for_partial_tasks() {
        let tasks = TransferTasks::default();
        let initial = tasks
            .register("window", "a", "connection", 1, "host:22")
            .unwrap();
        assert!(tasks.progress("a", 4, Some(10), "first"));
        let progress = tasks.snapshots("window", &["a".into()]).remove(0);
        assert!(progress.revision > initial.revision);
        assert!(tasks.set_result(
            "a",
            serde_json::json!({"failed": 1, "unknown": 0, "notStarted": 0})
        ));
        let result = tasks.snapshots("window", &["a".into()]).remove(0);
        assert!(result.revision > progress.revision);
        assert_eq!(result.result.unwrap()["failed"], 1);
        let finished = tasks.finish("a", Ok("done".into())).unwrap();
        assert_eq!(finished.status, "partial");
        assert!(finished.terminal());
        assert!(finished.revision > result.revision);
        assert!(!tasks.set_result("a", serde_json::json!({})));
    }

    #[test]
    fn cancellation_shields_only_committing_worker_and_closes_others() {
        let tasks = Arc::new(TransferTasks::default());
        register(&tasks, "folder");
        let first = tasks.acquire_worker("folder", "w0").unwrap();
        let second = tasks.acquire_worker("folder", "w1").unwrap();
        let (socket0, mut peer0) = tcp_pair();
        let (socket1, mut peer1) = tcp_pair();
        assert!(tasks.attach_worker_socket("folder", "w0", socket0));
        assert!(tasks.attach_worker_socket("folder", "w1", socket1));
        tasks.begin_commit("folder", "w0").unwrap();
        tasks.cancel("window", "folder");
        assert!(tasks.cancelled("folder"));
        assert!(!tasks.cancelled_worker("folder", "w0"));
        assert!(tasks.cancelled_worker("folder", "w1"));
        peer1
            .set_read_timeout(Some(Duration::from_secs(1)))
            .unwrap();
        let mut byte = [0];
        assert_eq!(peer1.read(&mut byte).unwrap(), 0);
        peer0
            .set_read_timeout(Some(Duration::from_millis(50)))
            .unwrap();
        assert!(peer0.read(&mut byte).is_err());
        tasks.end_commit("folder", "w0");
        assert!(tasks.cancelled_worker("folder", "w0"));
        peer0
            .set_read_timeout(Some(Duration::from_secs(1)))
            .unwrap();
        assert_eq!(peer0.read(&mut byte).unwrap(), 0);
        drop((first, second));
    }

    fn tcp_pair() -> (TcpStream, TcpStream) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let peer = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let (socket, _) = listener.accept().unwrap();
        (socket, peer)
    }

    #[test]
    fn worker_socket_requires_an_active_worker_lease() {
        let tasks = Arc::new(TransferTasks::default());
        register(&tasks, "folder");
        let (socket, mut peer) = tcp_pair();
        assert!(!tasks.attach_worker_socket("folder", "unleased", socket));
        peer.set_read_timeout(Some(Duration::from_secs(1))).unwrap();
        assert_eq!(peer.read(&mut [0]).unwrap(), 0);
        let lease = tasks.acquire_worker("folder", "w0").unwrap();
        let (socket, _peer) = tcp_pair();
        assert!(tasks.attach_worker_socket("folder", "w0", socket));
        drop(lease);
    }

    #[test]
    fn host_limit_starts_at_two_then_grows_to_four_without_overbooking() {
        let tasks = Arc::new(TransferTasks::default());
        register(&tasks, "folder");
        let first = tasks.acquire_worker("folder", "w0").unwrap();
        let second = tasks.acquire_worker("folder", "w1").unwrap();
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let (lease_tx, lease_rx) = std::sync::mpsc::channel();
        let waiting_tasks = tasks.clone();
        let waiting = std::thread::spawn(move || {
            started_tx.send(()).unwrap();
            lease_tx
                .send(waiting_tasks.acquire_worker("folder", "w2"))
                .unwrap();
        });
        started_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        assert!(lease_rx.recv_timeout(Duration::from_millis(50)).is_err());
        tasks.worker_connected("folder");
        let third = lease_rx
            .recv_timeout(Duration::from_secs(2))
            .unwrap()
            .unwrap();
        waiting.join().unwrap();
        tasks.worker_connected("folder");
        let fourth = tasks.acquire_worker("folder", "w3").unwrap();
        assert_eq!(tasks.inner.lock().unwrap().active, 4);

        let (lease_tx, lease_rx) = std::sync::mpsc::channel();
        let waiting_tasks = tasks.clone();
        let waiting = std::thread::spawn(move || {
            lease_tx
                .send(waiting_tasks.acquire_worker("folder", "w4"))
                .unwrap();
        });
        assert!(lease_rx.recv_timeout(Duration::from_millis(50)).is_err());
        drop(first);
        let fifth = lease_rx
            .recv_timeout(Duration::from_secs(2))
            .unwrap()
            .unwrap();
        waiting.join().unwrap();
        assert_eq!(tasks.inner.lock().unwrap().active, 4);
        drop((second, third, fourth, fifth));
        let inner = tasks.inner.lock().unwrap();
        assert_eq!(inner.active, 0);
        assert!(inner.host_limits.is_empty());
    }

    #[test]
    fn one_parent_cannot_acquire_a_duplicate_worker_id() {
        let tasks = Arc::new(TransferTasks::default());
        register(&tasks, "folder");
        let worker = tasks.acquire_worker("folder", "w0").unwrap();
        assert!(tasks.acquire_worker("folder", "w0").is_err());
        assert_eq!(tasks.inner.lock().unwrap().active, 1);
        drop(worker);
    }

    #[test]
    fn worker_leases_across_parents_share_the_global_eight_budget() {
        let tasks = Arc::new(TransferTasks::default());
        for (id, host) in [("a", "host-a"), ("b", "host-b"), ("c", "host-c")] {
            tasks.register("window", id, "connection", 1, host).unwrap();
        }
        let mut leases = Vec::new();
        for parent in ["a", "b"] {
            leases.push(tasks.acquire_worker(parent, "w0").unwrap());
            leases.push(tasks.acquire_worker(parent, "w1").unwrap());
            tasks.worker_connected(parent);
            tasks.worker_connected(parent);
            leases.push(tasks.acquire_worker(parent, "w2").unwrap());
            leases.push(tasks.acquire_worker(parent, "w3").unwrap());
        }
        assert_eq!(tasks.inner.lock().unwrap().active, 8);
        let (sender, receiver) = std::sync::mpsc::channel();
        let waiting_tasks = tasks.clone();
        let waiting = std::thread::spawn(move || {
            sender
                .send(waiting_tasks.acquire_worker("c", "w0"))
                .unwrap();
        });
        assert!(receiver.recv_timeout(Duration::from_millis(50)).is_err());
        drop(leases.pop());
        let ninth = receiver
            .recv_timeout(Duration::from_secs(2))
            .unwrap()
            .unwrap();
        waiting.join().unwrap();
        assert_eq!(tasks.inner.lock().unwrap().active, 8);
        drop((leases, ninth));
        assert_eq!(tasks.inner.lock().unwrap().active, 0);
    }

    #[test]
    fn cancelled_finish_keeps_the_published_batch_result() {
        let tasks = TransferTasks::default();
        register(&tasks, "folder");
        let summary = serde_json::json!({"succeeded": 2, "notStarted": 1, "itemCount": 3});
        assert!(tasks.set_result("folder", summary.clone()));
        tasks.cancel("window", "folder");
        let snapshot = tasks
            .finish(
                "folder",
                Err(serde_json::json!({"code":"TransferCancelled"})),
            )
            .unwrap();
        assert_eq!(snapshot.status, "cancelled");
        assert_eq!(snapshot.result, Some(summary));
    }
    #[test]
    fn queue_is_bounded_and_retains_only_bounded_terminal_results() {
        let tasks = TransferTasks::default();
        for index in 0..64 {
            register(&tasks, &index.to_string());
        }
        assert!(tasks
            .register("window", "overflow", "connection", 1, "host:22")
            .is_err());
        for index in 0..64 {
            tasks.finish(&index.to_string(), Ok("done".into()));
        }
        for index in 64..600 {
            register(&tasks, &index.to_string());
            tasks.finish(&index.to_string(), Ok("done".into()));
        }
        tasks.expire_stalled();
        assert!(tasks.inner.lock().unwrap().records.len() <= 512);
        for row in tasks.inner.lock().unwrap().records.values_mut() {
            row.updated = Instant::now() - Duration::from_secs(601);
        }
        tasks.expire_stalled();
        assert!(tasks.inner.lock().unwrap().records.is_empty());
    }
    #[test]
    fn waiting_for_one_host_does_not_reserve_global_capacity() {
        let tasks = Arc::new(TransferTasks::default());
        register(&tasks, "a");
        register(&tasks, "b");
        register(&tasks, "c");
        tasks
            .register("window", "other", "other", 1, "another-host:22")
            .unwrap();
        let a = tasks.acquire("a").unwrap();
        let b = tasks.acquire("b").unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        let waiting = tasks.clone();
        let worker = std::thread::spawn(move || {
            let c = waiting.acquire("c").unwrap();
            tx.send(()).unwrap();
            drop(c);
        });
        let other = tasks.acquire("other").unwrap();
        assert_eq!(tasks.inner.lock().unwrap().active, 3);
        assert!(rx.try_recv().is_err());
        drop(a);
        rx.recv_timeout(Duration::from_secs(2)).unwrap();
        worker.join().unwrap();
        drop(b);
        drop(other);
        assert_eq!(tasks.inner.lock().unwrap().active, 0);
    }
    #[test]
    fn global_execution_capacity_is_eight() {
        let tasks = Arc::new(TransferTasks::default());
        for index in 0..9 {
            tasks
                .register(
                    "window",
                    &format!("task-{index}"),
                    "connection",
                    1,
                    &format!("host-{index}:22"),
                )
                .unwrap();
        }
        let leases: Vec<_> = (0..8)
            .map(|index| tasks.acquire(&format!("task-{index}")).unwrap())
            .collect();
        let (ready_tx, ready_rx) = std::sync::mpsc::channel();
        let (acquired_tx, acquired_rx) = std::sync::mpsc::channel();
        let waiting = tasks.clone();
        let worker = std::thread::spawn(move || {
            ready_tx.send(()).unwrap();
            let lease = waiting.acquire("task-8").unwrap();
            acquired_tx.send(()).unwrap();
            drop(lease);
        });
        ready_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        assert!(acquired_rx.recv_timeout(Duration::from_millis(50)).is_err());
        assert_eq!(tasks.inner.lock().unwrap().active, 8);
        drop(leases);
        acquired_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        worker.join().unwrap();
        assert_eq!(tasks.inner.lock().unwrap().active, 0);
    }
    #[test]
    fn window_and_connection_cancellation_are_isolated() {
        let tasks = TransferTasks::default();
        register(&tasks, "a");
        tasks
            .register("other", "b", "other-connection", 1, "host:22")
            .unwrap();
        tasks.cancel_matching(Some("window"), None);
        assert!(tasks.cancelled("a"));
        assert!(!tasks.cancelled("b"));
        tasks.cancel_matching(None, Some("other-connection"));
        assert!(tasks.cancelled("b"));
    }
}
