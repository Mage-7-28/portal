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

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TaskSnapshot {
    pub transfer_id: String,
    pub id: String,
    pub generation: u64,
    pub status: String,
    pub current: u64,
    pub total: Option<u64>,
    pub progress: f64,
    pub message: String,
    pub error: Option<Value>,
}
impl TaskSnapshot {
    pub fn terminal(&self) -> bool {
        matches!(self.status.as_str(), "succeeded" | "failed" | "cancelled")
    }
}
struct Record {
    snapshot: TaskSnapshot,
    owner: String,
    host: String,
    order: u64,
    cancel: bool,
    updated: Instant,
    emitted: Option<Instant>,
    file: String,
    socket: Option<TcpStream>,
}
#[derive(Default)]
struct Inner {
    records: HashMap<String, Record>,
    cancel_tombstones: HashMap<(String, String), Instant>,
    cancel_overflowed_at: Option<Instant>,
    next_order: u64,
    active: usize,
    hosts: HashMap<String, usize>,
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
        inner.next_order += 1;
        let order = inner.next_order;
        let snapshot = TaskSnapshot {
            transfer_id: id.into(),
            id: connection.into(),
            generation,
            status: "queued".into(),
            current: 0,
            total: None,
            progress: 0.0,
            message: "等待执行".into(),
            error: None,
        };
        inner.records.insert(
            id.into(),
            Record {
                snapshot: snapshot.clone(),
                owner: owner.into(),
                host: host.into(),
                order,
                cancel: false,
                updated: Instant::now(),
                emitted: None,
                file: String::new(),
                socket: None,
            },
        );
        Ok(snapshot)
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
    /// 同一主机最多两个执行者；等待主机名额时不持有全局执行名额。
    pub fn acquire(self: &Arc<Self>, id: &str) -> Result<TaskLease, String> {
        let mut inner = self.inner.lock().map_err(|_| "任务状态锁已损坏")?;
        loop {
            let row = inner.records.get(id).ok_or("任务不存在")?;
            if row.cancel {
                return Err("传输已取消".into());
            }
            if row.snapshot.status != "queued" {
                return Err("任务已开始或结束，不能重复执行".into());
            }
            let host = row.host.clone();
            let order = row.order;
            let earlier = inner.records.values().any(|r| {
                r.host == host && r.order < order && r.snapshot.status == "queued" && !r.cancel
            });
            if !earlier && inner.active < 4 && inner.hosts.get(&host).copied().unwrap_or(0) < 2 {
                inner.active += 1;
                *inner.hosts.entry(host.clone()).or_default() += 1;
                let row = inner.records.get_mut(id).unwrap();
                row.snapshot.status = "starting".into();
                row.updated = Instant::now();
                self.wake.notify_all();
                return Ok(TaskLease {
                    tasks: self.clone(),
                    host,
                });
            }
            inner = self.wake.wait(inner).map_err(|_| "任务状态锁已损坏")?;
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
    pub fn attach_socket(&self, id: &str, socket: TcpStream) {
        if let Some(row) = self.inner.lock().unwrap().records.get_mut(id) {
            if row.cancel {
                let _ = socket.shutdown(Shutdown::Both);
            }
            row.socket = Some(socket);
        }
    }
    /// 归还会话前先移除取消句柄，避免迟到取消关闭已被其他任务租用的 socket。
    pub fn detach_socket(&self, id: &str) -> bool {
        let mut inner = self.inner.lock().unwrap();
        if let Some(row) = inner.records.get_mut(id) {
            row.socket = None;
            row.cancel
        } else {
            true
        }
    }
    pub fn running(&self, id: &str) {
        if let Some(row) = self.inner.lock().unwrap().records.get_mut(id) {
            if !row.snapshot.terminal() {
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
        if row.cancel {
            return Err("传输已取消".into());
        }
        row.snapshot.status = "committing".into();
        row.updated = Instant::now();
        Ok(())
    }
    /// 字节增长重置停滞计时，普通进度最多 10Hz，切换文件时立即发送。
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
        let send = changed_file
            || row
                .emitted
                .is_none_or(|last| last.elapsed() >= Duration::from_millis(100));
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
            .is_none_or(|r| r.cancel && r.snapshot.status != "committing")
    }
    fn cancel_row(row: &mut Record) {
        if row.snapshot.terminal() {
            return;
        }
        row.cancel = true;
        // 安全替换已发出时不能以取消来断言结果，交给提交返回值判定。
        if row.snapshot.status != "committing" {
            if let Some(socket) = &row.socket {
                let _ = socket.shutdown(Shutdown::Both);
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
    pub fn finish(&self, id: &str, result: Result<String, Value>) -> Option<TaskSnapshot> {
        let mut inner = self.inner.lock().unwrap();
        let row = inner.records.get_mut(id)?;
        if row.snapshot.terminal() {
            return Some(row.snapshot.clone());
        }
        row.socket = None;
        match result {
            Ok(message) => {
                row.snapshot.status = "succeeded".into();
                row.snapshot.message = message;
                row.snapshot.progress = 100.0;
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
        self.wake.notify_all();
        Some(row.snapshot.clone())
    }
}
pub(crate) struct TaskLease {
    tasks: Arc<TransferTasks>,
    host: String,
}
impl Drop for TaskLease {
    fn drop(&mut self) {
        let mut inner = self.tasks.inner.lock().unwrap();
        inner.active = inner.active.saturating_sub(1);
        if let Some(count) = inner.hosts.get_mut(&self.host) {
            *count = count.saturating_sub(1);
            if *count == 0 {
                inner.hosts.remove(&self.host);
            }
        }
        self.tasks.wake.notify_all();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
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
    fn throttles_progress_but_flushes_file_boundaries() {
        let tasks = TransferTasks::default();
        register(&tasks, "a");
        assert!(tasks.progress("a", 0, Some(10), "a"));
        assert!(!tasks.progress("a", 1, Some(10), "a"));
        assert!(tasks.progress("a", 0, None, "b"));
        assert!(tasks.snapshots("window", &["a".into()])[0].total.is_none());
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
    fn global_execution_capacity_remains_four() {
        let tasks = Arc::new(TransferTasks::default());
        for index in 0..5 {
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
        let leases: Vec<_> = (0..4)
            .map(|index| tasks.acquire(&format!("task-{index}")).unwrap())
            .collect();
        let (ready_tx, ready_rx) = std::sync::mpsc::channel();
        let (acquired_tx, acquired_rx) = std::sync::mpsc::channel();
        let waiting = tasks.clone();
        let worker = std::thread::spawn(move || {
            ready_tx.send(()).unwrap();
            let lease = waiting.acquire("task-4").unwrap();
            acquired_tx.send(()).unwrap();
            drop(lease);
        });
        ready_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        assert!(acquired_rx.recv_timeout(Duration::from_millis(50)).is_err());
        assert_eq!(tasks.inner.lock().unwrap().active, 4);
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
