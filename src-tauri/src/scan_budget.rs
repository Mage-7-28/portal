//! 单任务目录扫描的累计内存、工作量和时间预算。

use std::path::Path;
use std::time::{Duration, Instant};

/// 枚举条目之前检查，多个目录/工作者必须共享同一实例。
pub(crate) struct ScanBudget {
    started: Instant,
    entries: usize,
    path_bytes: usize,
    max_entries: usize,
    max_path_bytes: usize,
    max_depth: usize,
    timeout: Duration,
}

impl Default for ScanBudget {
    fn default() -> Self {
        Self::with_limits(100_000, 32 * 1024 * 1024, 128, Duration::from_secs(120))
    }
}

impl ScanBudget {
    fn with_limits(
        max_entries: usize,
        max_path_bytes: usize,
        max_depth: usize,
        timeout: Duration,
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
        if self.started.elapsed() >= self.timeout {
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
        let mut budget = ScanBudget::with_limits(2, 8, 4, Duration::from_secs(1));
        budget.record(Path::new("abc")).unwrap();
        budget.record(Path::new("def")).unwrap();
        assert!(budget.record(Path::new("g")).is_err());
        let mut budget = ScanBudget::with_limits(10, 3, 4, Duration::from_secs(1));
        assert!(budget.record(Path::new("long")).is_err());
    }

    #[test]
    fn limits_depth_and_total_elapsed_time() {
        let mut budget = ScanBudget::with_limits(10, 100, 2, Duration::from_secs(1));
        assert!(budget.record(Path::new("a/b/c")).is_err());
        budget.started = Instant::now() - Duration::from_secs(2);
        assert!(budget.check().is_err());
    }
}
