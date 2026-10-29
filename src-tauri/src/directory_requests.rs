//! 目录请求的有界登记与取消状态，供调用方在实际工作前后配对使用。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

const MAX_REQUESTS: usize = 128;
const MAX_IDENTIFIER_BYTES: usize = 256;
const TOMBSTONE_TTL: Duration = Duration::from_secs(60);

struct Entry {
    owner: String,
    connection: String,
    request_id: String,
    status: EntryStatus,
}

enum EntryStatus {
    Active(Arc<AtomicBool>),
    Tombstone(Instant),
}

#[derive(Default)]
struct RequestState {
    entries: Vec<Entry>,
}

impl RequestState {
    fn remove_expired_tombstones(&mut self, now: Instant) {
        self.entries.retain(|entry| match &entry.status {
            EntryStatus::Active(_) => true,
            EntryStatus::Tombstone(cancelled_at) => {
                now.saturating_duration_since(*cancelled_at) < TOMBSTONE_TTL
            }
        });
    }

    // 保持插入顺序，以便时间戳相同时也能确定最早的墓碑。
    fn make_room(&mut self) -> bool {
        if self.entries.len() < MAX_REQUESTS {
            return true;
        }
        let oldest = self
            .entries
            .iter()
            .enumerate()
            .filter_map(|(index, entry)| match &entry.status {
                EntryStatus::Tombstone(cancelled_at) => Some((*cancelled_at, index)),
                EntryStatus::Active(_) => None,
            })
            .min()
            .map(|(_, index)| index);
        if let Some(index) = oldest {
            self.entries.remove(index);
            true
        } else {
            false
        }
    }
}

/// 按窗口和请求标识登记活动请求，或为提前到达的取消保留短期墓碑。
///
/// 活动请求与墓碑合计最多 128 条；满载时仅可回收墓碑。调用方负责
/// 在工作结束或不再启动工作时调用 [`Self::finish`]，包括已取消的请求。
#[derive(Default)]
pub(crate) struct DirectoryRequests {
    state: Mutex<RequestState>,
}

impl DirectoryRequests {
    fn lock(&self) -> MutexGuard<'_, RequestState> {
        // 即使持锁线程异常退出，仍允许其他线程取消和清理已登记请求。
        self.state.lock().unwrap_or_else(|error| error.into_inner())
    }

    fn valid_id(value: &str) -> bool {
        !value.is_empty() && value.len() <= MAX_IDENTIFIER_BYTES
    }

    /// 登记目录请求并返回取消标记；存在同连接墓碑时标记立即为 `true`。
    ///
    /// 返回的标记可使用 `Ordering::Acquire` 读取。登记不会取消其他请求；
    /// 活动请求必须一直保留到调用方完成清理。同窗口内重复使用活动请求
    /// 标识、跨连接使用已登记标识、标识不合法或容量被活动请求占满时
    /// 返回错误。
    pub(crate) fn begin(
        &self,
        owner: &str,
        connection: &str,
        request_id: &str,
    ) -> Result<Arc<AtomicBool>, String> {
        if !Self::valid_id(owner) || !Self::valid_id(connection) || !Self::valid_id(request_id) {
            return Err("目录请求的窗口、连接和请求标识必须为 1 至 256 字节".into());
        }

        let mut state = self.lock();
        state.remove_expired_tombstones(Instant::now());
        let index = state
            .entries
            .iter()
            .position(|entry| entry.owner == owner && entry.request_id == request_id);
        let already_cancelled = match index {
            Some(index) => {
                let entry = &state.entries[index];
                if entry.connection != connection {
                    return Err("目录请求标识已绑定其他连接".into());
                }
                match entry.status {
                    EntryStatus::Active(_) => return Err("目录请求标识正在使用".into()),
                    EntryStatus::Tombstone(_) => true,
                }
            }
            None => {
                if !state.make_room() {
                    return Err("目录请求登记数量已达上限".into());
                }
                false
            }
        };

        let cancellation = Arc::new(AtomicBool::new(already_cancelled));
        let entry = Entry {
            owner: owner.to_owned(),
            connection: connection.to_owned(),
            request_id: request_id.to_owned(),
            status: EntryStatus::Active(Arc::clone(&cancellation)),
        };
        if let Some(index) = index {
            state.entries[index] = entry;
        } else {
            state.entries.push(entry);
        }
        Ok(cancellation)
    }

    /// 取消活动请求，或为尚未登记的请求创建 60 秒墓碑。
    ///
    /// 已成功取消或保留墓碑时返回 `true`；标识不合法、连接不匹配或
    /// 容量全被活动请求占用而无法保留墓碑时返回 `false`。重复取消
    /// 会刷新同连接墓碑的有效期。
    pub(crate) fn cancel(&self, owner: &str, connection: &str, request_id: &str) -> bool {
        if !Self::valid_id(owner) || !Self::valid_id(connection) || !Self::valid_id(request_id) {
            return false;
        }

        let mut state = self.lock();
        let now = Instant::now();
        state.remove_expired_tombstones(now);
        if let Some(index) = state
            .entries
            .iter()
            .position(|entry| entry.owner == owner && entry.request_id == request_id)
        {
            let entry = &mut state.entries[index];
            if entry.connection != connection {
                return false;
            }
            match &mut entry.status {
                EntryStatus::Active(cancellation) => {
                    cancellation.store(true, Ordering::Release);
                    return true;
                }
                EntryStatus::Tombstone(cancelled_at) => *cancelled_at = now,
            }
            // 刷新墓碑的时间和顺序，避免同一时刻的重复取消被当成最旧记录。
            let entry = state.entries.remove(index);
            state.entries.push(entry);
            return true;
        }

        if !state.make_room() {
            return false;
        }
        state.entries.push(Entry {
            owner: owner.to_owned(),
            connection: connection.to_owned(),
            request_id: request_id.to_owned(),
            status: EntryStatus::Tombstone(now),
        });
        true
    }

    /// 仅当标记与登记时返回的是同一个 `Arc` 才释放活动请求。
    ///
    /// 调用方应在 `run_blocking` 完成后以及未启动工作等退出路径调用；
    /// 过期工作或错误窗口的完成通知不会删除新请求或未过期的取消墓碑。
    pub(crate) fn finish(&self, owner: &str, request_id: &str, cancellation: &Arc<AtomicBool>) {
        if !Self::valid_id(owner) || !Self::valid_id(request_id) {
            return;
        }

        let mut state = self.lock();
        state.remove_expired_tombstones(Instant::now());
        if let Some(index) = state.entries.iter().position(|entry| {
            entry.owner == owner
                && entry.request_id == request_id
                && matches!(&entry.status, EntryStatus::Active(current) if Arc::ptr_eq(current, cancellation))
        }) {
            state.entries.remove(index);
        }
    }

    /// 取消符合两个可选条件的活动请求；`None` 表示该条件不限制。
    ///
    /// 此方法不为未知请求创建墓碑，也不会删除尚未过期的现有墓碑。
    pub(crate) fn cancel_matching(&self, owner: Option<&str>, connection: Option<&str>) {
        let mut state = self.lock();
        state.remove_expired_tombstones(Instant::now());
        for entry in &state.entries {
            if owner.is_none_or(|value| value == entry.owner)
                && connection.is_none_or(|value| value == entry.connection)
            {
                if let EntryStatus::Active(cancellation) = &entry.status {
                    cancellation.store(true, Ordering::Release);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Barrier;
    use std::thread;

    fn is_cancelled(cancellation: &Arc<AtomicBool>) -> bool {
        cancellation.load(Ordering::Acquire)
    }

    fn age_tombstone(requests: &DirectoryRequests, owner: &str, request_id: &str, age: Duration) {
        let mut state = requests.state.lock().unwrap();
        let entry = state
            .entries
            .iter_mut()
            .find(|entry| entry.owner == owner && entry.request_id == request_id)
            .expect("墓碑必须存在");
        match &mut entry.status {
            EntryStatus::Tombstone(cancelled_at) => *cancelled_at = Instant::now() - age,
            EntryStatus::Active(_) => panic!("请求不应处于活动状态"),
        }
    }

    #[test]
    fn consumes_cancellation_that_arrives_before_registration() {
        let requests = DirectoryRequests::default();
        assert!(requests.cancel("window", "connection", "request"));
        assert!(requests.cancel("window", "connection", "request"));

        let first = requests.begin("window", "connection", "request").unwrap();
        assert!(is_cancelled(&first));
        assert!(requests.begin("window", "connection", "request").is_err());

        requests.finish("window", "request", &first);
        let next = requests.begin("window", "connection", "request").unwrap();
        assert!(!is_cancelled(&next));
    }

    #[test]
    fn isolates_identical_request_ids_between_windows() {
        let requests = DirectoryRequests::default();
        let first = requests.begin("first", "connection", "same").unwrap();
        let second = requests.begin("second", "connection", "same").unwrap();

        assert!(requests.cancel("first", "connection", "same"));
        assert!(is_cancelled(&first));
        assert!(!is_cancelled(&second));
        assert!(requests.cancel("third", "connection", "same"));
        let third = requests.begin("third", "connection", "same").unwrap();
        assert!(is_cancelled(&third));
        assert!(!is_cancelled(&second));
    }

    #[test]
    fn beginning_another_request_does_not_cancel_existing_requests() {
        let requests = DirectoryRequests::default();
        let older = requests.begin("window", "connection", "older").unwrap();
        let other_connection = requests.begin("window", "other", "other").unwrap();
        let other_window = requests.begin("other", "connection", "other").unwrap();
        let newer = requests.begin("window", "connection", "newer").unwrap();

        assert!(!is_cancelled(&older));
        assert!(!is_cancelled(&newer));
        assert!(!is_cancelled(&other_connection));
        assert!(!is_cancelled(&other_window));

        let newest = requests.begin("window", "connection", "newest").unwrap();
        assert!(!is_cancelled(&older));
        assert!(!is_cancelled(&newer));
        assert!(!is_cancelled(&newest));
    }

    #[test]
    fn pre_cancelled_registration_does_not_cancel_existing_active_work() {
        let requests = DirectoryRequests::default();
        let older = requests.begin("window", "connection", "older").unwrap();
        assert!(requests.cancel("window", "connection", "newer"));
        let newer = requests.begin("window", "connection", "newer").unwrap();
        assert!(!is_cancelled(&older));
        assert!(is_cancelled(&newer));
    }

    #[test]
    fn old_cancel_before_new_begin_cannot_cancel_new_when_old_begin_arrives_late() {
        let requests = DirectoryRequests::default();
        assert!(requests.cancel("window", "connection", "old"));
        let new = requests.begin("window", "connection", "new").unwrap();
        assert!(!is_cancelled(&new));

        let old = requests.begin("window", "connection", "old").unwrap();
        assert!(is_cancelled(&old));
        assert!(!is_cancelled(&new));
        assert!(requests.begin("window", "connection", "old").is_err());
        requests.finish("window", "old", &old);
        assert!(requests.begin("window", "connection", "new").is_err());
        assert!(!is_cancelled(&new));

        let newest = requests.begin("window", "connection", "newest").unwrap();
        assert!(!is_cancelled(&new));
        assert!(!is_cancelled(&newest));
    }

    #[test]
    fn old_cancel_after_new_begin_does_not_cancel_new_before_old_begin() {
        let requests = DirectoryRequests::default();
        let new = requests.begin("window", "connection", "new").unwrap();
        assert!(requests.cancel("window", "connection", "old"));
        assert!(!is_cancelled(&new));

        let old = requests.begin("window", "connection", "old").unwrap();
        assert!(is_cancelled(&old));
        assert!(!is_cancelled(&new));
    }

    #[test]
    fn active_old_cancel_before_new_begin_does_not_cancel_new() {
        let requests = DirectoryRequests::default();
        let old = requests.begin("window", "connection", "old").unwrap();
        assert!(requests.cancel("window", "connection", "old"));
        assert!(is_cancelled(&old));

        let new = requests.begin("window", "connection", "new").unwrap();
        assert!(!is_cancelled(&new));
    }

    #[test]
    fn late_old_begin_and_precise_active_cancel_do_not_cancel_new() {
        let requests = DirectoryRequests::default();
        let new = requests.begin("window", "connection", "new").unwrap();
        let old = requests.begin("window", "connection", "old").unwrap();
        assert!(!is_cancelled(&new));
        assert!(!is_cancelled(&old));

        assert!(requests.cancel("window", "connection", "old"));
        assert!(is_cancelled(&old));
        assert!(!is_cancelled(&new));
        requests.finish("window", "old", &old);
        assert!(requests.begin("window", "connection", "new").is_err());
        assert!(!is_cancelled(&new));
    }

    #[test]
    fn stale_or_foreign_finish_cannot_remove_a_new_request() {
        let requests = DirectoryRequests::default();
        let old = requests.begin("window", "connection", "same").unwrap();
        requests.finish("window", "same", &old);
        let new = requests.begin("window", "connection", "same").unwrap();

        requests.finish("window", "same", &old);
        requests.finish("other", "same", &new);
        assert!(requests.begin("window", "connection", "same").is_err());
        assert!(requests.cancel("window", "connection", "same"));
        assert!(is_cancelled(&new));

        requests.finish("window", "same", &new);
        assert!(requests.begin("window", "connection", "same").is_ok());
    }

    #[test]
    fn rejects_duplicate_active_ids_and_connection_mismatches() {
        let requests = DirectoryRequests::default();
        let active = requests.begin("window", "first", "same").unwrap();

        assert!(requests.begin("window", "first", "same").is_err());
        assert!(requests.begin("window", "second", "same").is_err());
        assert!(!requests.cancel("window", "second", "same"));
        assert!(!is_cancelled(&active));
        assert!(requests.cancel("window", "first", "same"));
        assert!(is_cancelled(&active));
        assert!(requests.begin("window", "second", "same").is_err());
    }

    #[test]
    fn tombstone_cannot_be_consumed_or_overwritten_by_another_connection() {
        let requests = DirectoryRequests::default();
        assert!(requests.cancel("window", "first", "same"));
        assert!(!requests.cancel("window", "second", "same"));
        assert!(requests.begin("window", "second", "same").is_err());
        let active = requests.begin("window", "first", "same").unwrap();
        assert!(is_cancelled(&active));
    }

    #[test]
    fn rejects_empty_or_oversized_identifiers_without_cancelling_live_work() {
        let requests = DirectoryRequests::default();
        let active = requests.begin("window", "connection", "active").unwrap();
        let oversized = "x".repeat(257);
        let oversized_utf8 = "é".repeat(129);
        let invalid = [
            ("", "connection", "id"),
            ("window", "", "id"),
            ("window", "connection", ""),
            (oversized.as_str(), "connection", "id"),
            ("window", oversized.as_str(), "id"),
            ("window", "connection", oversized.as_str()),
            ("window", "connection", oversized_utf8.as_str()),
        ];
        for (owner, connection, request_id) in invalid {
            assert!(requests.begin(owner, connection, request_id).is_err());
            assert!(!requests.cancel(owner, connection, request_id));
        }
        assert!(!is_cancelled(&active));

        let max = "x".repeat(256);
        assert!(requests.begin(&max, &max, &max).is_ok());
        let max_utf8 = "é".repeat(128);
        assert!(requests.begin("window", "other", &max_utf8).is_ok());
    }

    #[test]
    fn all_active_capacity_rejects_new_work_without_removing_or_cancelling_it() {
        let requests = DirectoryRequests::default();
        let mut active = Vec::new();
        for index in 0..128 {
            let connection = format!("connection-{index}");
            let request_id = format!("request-{index}");
            let cancellation = requests.begin("window", &connection, &request_id).unwrap();
            active.push((connection, request_id, cancellation));
        }

        assert!(requests
            .begin("window", "connection-0", "overflow")
            .is_err());
        assert!(!requests.cancel("window", "new-connection", "not-arrived"));
        assert_eq!(requests.state.lock().unwrap().entries.len(), 128);
        for (connection, request_id, cancellation) in &active {
            assert!(!is_cancelled(cancellation));
            assert!(requests.begin("window", connection, request_id).is_err());
        }
        assert!(requests.cancel("window", "connection-0", "request-0"));
        assert!(is_cancelled(&active[0].2));
        assert!(requests
            .begin("window", "connection-0", "request-0")
            .is_err());

        let (_, first_id, first) = &active[0];
        requests.finish("window", first_id, first);
        assert!(requests.begin("window", "new-connection", "new").is_ok());
    }

    #[test]
    fn evicts_oldest_tombstone_but_keeps_newer_tombstones_at_capacity() {
        let requests = DirectoryRequests::default();
        for index in 0..128 {
            assert!(requests.cancel("window", "connection", &format!("request-{index}")));
        }
        age_tombstone(&requests, "window", "request-0", Duration::from_secs(10));
        assert!(requests.cancel("window", "connection", "request-128"));
        assert_eq!(requests.state.lock().unwrap().entries.len(), 128);

        let retained = requests
            .begin("window", "connection", "request-128")
            .unwrap();
        assert!(is_cancelled(&retained));
        let evicted = requests.begin("window", "connection", "request-0").unwrap();
        assert!(!is_cancelled(&evicted));
        assert_eq!(requests.state.lock().unwrap().entries.len(), 128);
    }

    #[test]
    fn evicts_tombstones_before_active_requests_in_a_full_mixed_registry() {
        let requests = DirectoryRequests::default();
        let mut active = Vec::new();
        for index in 0..127 {
            let connection = format!("connection-{index}");
            let request_id = format!("request-{index}");
            let cancellation = requests.begin("window", &connection, &request_id).unwrap();
            active.push((connection, request_id, cancellation));
        }
        assert!(requests.cancel("window", "orphan-connection", "orphan"));
        let last = requests.begin("window", "new-connection", "new").unwrap();
        assert!(!is_cancelled(&last));
        assert!(!requests.cancel("window", "another-connection", "unknown"));
        for (connection, request_id, cancellation) in &active {
            assert!(!is_cancelled(cancellation));
            assert!(requests.begin("window", connection, request_id).is_err());
        }

        requests.finish("window", "new", &last);
        let evicted = requests
            .begin("window", "orphan-connection", "orphan")
            .unwrap();
        assert!(!is_cancelled(&evicted));
    }

    #[test]
    fn expires_tombstones_at_sixty_seconds_but_retains_recent_ones() {
        let requests = DirectoryRequests::default();
        assert!(requests.cancel("window", "connection", "expired"));
        assert!(requests.cancel("window", "connection", "recent"));
        age_tombstone(&requests, "window", "expired", Duration::from_secs(60));
        age_tombstone(&requests, "window", "recent", Duration::from_secs(59));

        let expired = requests.begin("window", "connection", "expired").unwrap();
        assert!(!is_cancelled(&expired));
        let recent = requests.begin("window", "connection", "recent").unwrap();
        assert!(is_cancelled(&recent));
    }

    #[test]
    fn repeated_cancel_refreshes_the_tombstone_lifetime() {
        let requests = DirectoryRequests::default();
        assert!(requests.cancel("window", "connection", "pending"));
        age_tombstone(&requests, "window", "pending", Duration::from_secs(59));
        assert!(requests.cancel("window", "connection", "pending"));
        {
            let mut state = requests.state.lock().unwrap();
            let entry = state
                .entries
                .iter_mut()
                .find(|entry| entry.request_id == "pending")
                .unwrap();
            match &mut entry.status {
                EntryStatus::Tombstone(cancelled_at) => *cancelled_at -= Duration::from_secs(2),
                EntryStatus::Active(_) => panic!("请求不应处于活动状态"),
            }
        }
        let pending = requests.begin("window", "connection", "pending").unwrap();
        assert!(is_cancelled(&pending));
    }

    #[test]
    fn evicts_the_first_tombstone_when_timestamps_are_equal() {
        let requests = DirectoryRequests::default();
        assert!(requests.cancel("window", "connection", "first"));
        assert!(requests.cancel("window", "connection", "second"));
        {
            let mut state = requests.state.lock().unwrap();
            let timestamp = Instant::now() - Duration::from_secs(1);
            for entry in &mut state.entries {
                if let EntryStatus::Tombstone(cancelled_at) = &mut entry.status {
                    *cancelled_at = timestamp;
                }
            }
        }
        for index in 0..126 {
            assert!(requests.cancel("window", "connection", &format!("other-{index}")));
        }
        assert!(requests.cancel("window", "connection", "extra"));
        let retained = requests.begin("window", "connection", "second").unwrap();
        assert!(is_cancelled(&retained));
        let evicted = requests.begin("window", "connection", "first").unwrap();
        assert!(!is_cancelled(&evicted));
    }

    #[test]
    fn cancel_matching_supports_both_filters_and_wildcards_without_erasing_tombstones() {
        let requests = DirectoryRequests::default();
        let first = requests.begin("first", "one", "a").unwrap();
        let second = requests.begin("first", "two", "b").unwrap();
        let third = requests.begin("second", "one", "c").unwrap();
        let fourth = requests.begin("second", "two", "d").unwrap();
        assert!(requests.cancel("first", "one", "pending"));

        requests.cancel_matching(Some("first"), Some("one"));
        assert!(is_cancelled(&first));
        assert!(!is_cancelled(&second));
        assert!(!is_cancelled(&third));
        assert!(!is_cancelled(&fourth));
        requests.cancel_matching(Some("first"), None);
        assert!(is_cancelled(&second));
        assert!(!is_cancelled(&third));
        requests.cancel_matching(None, Some("one"));
        assert!(is_cancelled(&third));
        assert!(!is_cancelled(&fourth));
        requests.cancel_matching(None, None);
        assert!(is_cancelled(&fourth));

        let pending = requests.begin("first", "one", "pending").unwrap();
        assert!(is_cancelled(&pending));
    }

    #[test]
    fn simultaneous_cancel_and_begin_always_leave_the_token_cancelled() {
        for _ in 0..32 {
            let requests = Arc::new(DirectoryRequests::default());
            let barrier = Arc::new(Barrier::new(3));
            let begin_requests = Arc::clone(&requests);
            let begin_barrier = Arc::clone(&barrier);
            let begin = thread::spawn(move || {
                begin_barrier.wait();
                begin_requests
                    .begin("window", "connection", "same")
                    .unwrap()
            });
            let cancel_requests = Arc::clone(&requests);
            let cancel_barrier = Arc::clone(&barrier);
            let cancel = thread::spawn(move || {
                cancel_barrier.wait();
                cancel_requests.cancel("window", "connection", "same")
            });
            barrier.wait();
            let cancellation = begin.join().unwrap();
            assert!(cancel.join().unwrap());
            assert!(is_cancelled(&cancellation));
        }
    }

    #[test]
    fn concurrent_new_requests_leave_all_tokens_uncancelled() {
        const WORKERS: usize = 16;
        let requests = Arc::new(DirectoryRequests::default());
        let barrier = Arc::new(Barrier::new(WORKERS));
        let workers: Vec<_> = (0..WORKERS)
            .map(|index| {
                let requests = Arc::clone(&requests);
                let barrier = Arc::clone(&barrier);
                thread::spawn(move || {
                    barrier.wait();
                    requests.begin("window", "connection", &format!("request-{index}"))
                })
            })
            .collect();
        let tokens: Vec<_> = workers
            .into_iter()
            .map(|worker| worker.join().unwrap().unwrap())
            .collect();
        assert!(tokens.iter().all(|token| !is_cancelled(token)));
        assert_eq!(requests.state.lock().unwrap().entries.len(), WORKERS);
    }

    #[test]
    fn concurrent_duplicate_registrations_allow_exactly_one_request() {
        const WORKERS: usize = 16;
        let requests = Arc::new(DirectoryRequests::default());
        let barrier = Arc::new(Barrier::new(WORKERS));
        let workers: Vec<_> = (0..WORKERS)
            .map(|_| {
                let requests = Arc::clone(&requests);
                let barrier = Arc::clone(&barrier);
                thread::spawn(move || {
                    barrier.wait();
                    requests.begin("window", "connection", "same")
                })
            })
            .collect();
        let results: Vec<_> = workers
            .into_iter()
            .map(|worker| worker.join().unwrap())
            .collect();
        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        assert_eq!(
            results.iter().filter(|result| result.is_err()).count(),
            WORKERS - 1
        );
    }
}
