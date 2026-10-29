//! 单任务目录扫描的累计内存、工作量和时间预算。

use std::path::Path;
use std::time::{Duration, Instant};

const MAX_ENTRIES: usize = 100_000;
const MAX_PATH_BYTES: usize = 32 * 1024 * 1024;
const MAX_DEPTH: usize = 128;
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(120);

/// 枚举条目之前检查，多个目录/工作者必须共享同一实例。
pub(crate) struct ScanBudget {
    started: Instant,
    entries: usize,
    path_bytes: usize,
    max_entries: usize,
    max_path_bytes: usize,
    max_depth: usize,
    timeout: Option<Duration>,
}

impl Default for ScanBudget {
    fn default() -> Self {
        Self::with_limits(
            MAX_ENTRIES,
            MAX_PATH_BYTES,
            MAX_DEPTH,
            Some(DEFAULT_TIMEOUT),
        )
    }
}

impl ScanBudget {
    /// 文件传输仅限制扫描资源，不对持续有进展的任务施加累计时限。
    pub(crate) fn for_transfer() -> Self {
        Self::with_limits(MAX_ENTRIES, MAX_PATH_BYTES, MAX_DEPTH, None)
    }

    fn with_limits(
        max_entries: usize,
        max_path_bytes: usize,
        max_depth: usize,
        timeout: Option<Duration>,
    ) -> Self {
        Self {
            started: Instant::now(),
            entries: 0,
            path_bytes: 0,
            max_entries,
            max_path_bytes,
            max_depth,
            timeout,
        }
    }

    pub(crate) fn check(&self) -> Result<(), String> {
        if self
            .timeout
            .is_some_and(|timeout| self.started.elapsed() >= timeout)
        {
            return Err("目录扫描超过120秒总时限，请缩小操作范围".to_string());
        }
        Ok(())
    }

    pub(crate) fn record(&mut self, path: &Path) -> Result<(), String> {
        self.check()?;
        let bytes = path.as_os_str().as_encoded_bytes().len();
        if self.entries >= self.max_entries
            || bytes > self.max_path_bytes.saturating_sub(self.path_bytes)
            || path.components().count() > self.max_depth
        {
            return Err("目录扫描超过条目、路径内存或深度预算，请缩小操作范围".to_string());
        }
        self.entries += 1;
        self.path_bytes += bytes;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;
    use std::time::{Duration, Instant};

    #[test]
    fn stops_before_entry_and_path_storage_exceed_budget() {
        let mut budget = ScanBudget::with_limits(2, 8, 4, Some(Duration::from_secs(1)));
        budget.record(Path::new("abc")).unwrap();
        budget.record(Path::new("def")).unwrap();
        assert!(budget.record(Path::new("g")).is_err());
        let mut budget = ScanBudget::with_limits(10, 3, 4, Some(Duration::from_secs(1)));
        assert!(budget.record(Path::new("long")).is_err());
    }

    #[test]
    fn limits_depth_and_total_elapsed_time() {
        let mut budget = ScanBudget::with_limits(10, 100, 2, Some(Duration::from_secs(1)));
        assert!(budget.record(Path::new("a/b/c")).is_err());
        budget.started = Instant::now() - Duration::from_secs(2);
        assert!(budget.check().is_err());
    }

    #[test]
    fn transfer_budget_has_no_total_time_limit_but_keeps_resource_limits() {
        let mut budget = ScanBudget::for_transfer();
        budget.started = Instant::now() - Duration::from_secs(3600);
        assert!(budget.check().is_ok());
        budget.record(Path::new("file")).unwrap();
        assert_eq!(budget.max_entries, MAX_ENTRIES);
        assert_eq!(budget.max_path_bytes, MAX_PATH_BYTES);
        assert_eq!(budget.max_depth, MAX_DEPTH);

        budget.entries = MAX_ENTRIES;
        assert!(budget.record(Path::new("file")).is_err());
        budget.entries = 0;
        budget.path_bytes = MAX_PATH_BYTES;
        assert!(budget.record(Path::new("file")).is_err());
        budget.path_bytes = 0;
        let deep = std::iter::repeat_n("part", MAX_DEPTH + 1)
            .collect::<Vec<_>>()
            .join("/");
        assert!(budget.record(Path::new(&deep)).is_err());
    }

    #[test]
    fn default_budget_still_enforces_its_total_time_limit() {
        let mut budget = ScanBudget {
            started: Instant::now() - Duration::from_secs(121),
            ..Default::default()
        };
        assert!(budget.check().is_err());
        assert!(budget.record(Path::new("file")).is_err());
    }
}
