//! 远程终端的尺寸、输入顺序和输出背压状态；不负责线程同步或 IPC。

use std::collections::VecDeque;

/// 未确认输出达到此字节数时暂停读取。
pub const OUTPUT_HIGH_WATERMARK: usize = 256 * 1024;
/// 暂停后，未确认输出降至此字节数或以下时恢复读取。
pub const OUTPUT_LOW_WATERMARK: usize = 64 * 1024;

/// 将终端尺寸限制到 PTY 支持的范围；零值使用默认尺寸。
pub fn normalize_dimensions(columns: u32, rows: u32) -> (u32, u32) {
    let columns = if columns == 0 { 100 } else { columns.min(4096) };
    let rows = if rows == 0 { 30 } else { rows.min(2048) };
    (columns, rows)
}

/// 解码一次输出，替换确定无效的字节，最多保留三个尚不完整的 UTF-8 尾字节。
///
/// ANSI 字节保持原序；流结束时由调用方将残留尾字节按有损 UTF-8 输出。
pub fn decode_output(pending: &mut Vec<u8>, bytes: &[u8]) -> String {
    pending.extend_from_slice(bytes);
    let mut text = String::with_capacity(pending.len());
    let mut consumed = 0;
    while consumed < pending.len() {
        match std::str::from_utf8(&pending[consumed..]) {
            Ok(valid) => {
                text.push_str(valid);
                consumed = pending.len();
            }
            Err(error) => {
                let end = consumed + error.valid_up_to();
                text.push_str(&String::from_utf8_lossy(&pending[consumed..end]));
                consumed = end;
                if let Some(invalid_length) = error.error_len() {
                    text.push('\u{fffd}');
                    consumed += invalid_length;
                } else {
                    break;
                }
            }
        }
    }
    pending.drain(..consumed);
    text
}

/// libssh2 的尺寸控制请求在 EAGAIN 后必须使用原参数继续完成。
#[derive(Default)]
pub struct PendingResize {
    pending: Option<(u32, u32)>,
}

impl PendingResize {
    pub fn next(&mut self, requested: (u32, u32)) -> (u32, u32) {
        *self.pending.get_or_insert(requested)
    }

    pub fn complete(&mut self) {
        self.pending = None;
    }
}

/// 单个终端的累计输出确认状态。
///
/// 调用方需使用同一把锁保护本状态及条件变量；ACK 和取消后通知等待的读取线程。
#[derive(Default)]
pub struct OutputFlow {
    pending: VecDeque<(u64, usize)>,
    outstanding_bytes: usize,
    last_sent: u64,
    paused: bool,
    cancelled: bool,
}

impl OutputFlow {
    /// 为一次发送分配从 1 开始的序号并记录未确认的 UTF-8 字节数。
    ///
    /// 取消或计数溢出时返回 `None`，且不修改状态。退出和错误包可使用零字节。
    pub fn record_sent(&mut self, bytes: usize) -> Option<u64> {
        if self.cancelled {
            return None;
        }
        let sequence = self.last_sent.checked_add(1)?;
        let outstanding = self.outstanding_bytes.checked_add(bytes)?;
        self.last_sent = sequence;
        self.outstanding_bytes = outstanding;
        self.pending.push_back((sequence, bytes));
        if outstanding >= OUTPUT_HIGH_WATERMARK {
            self.paused = true;
        }
        Some(sequence)
    }

    /// 确认不大于最后发送序号的所有输出；旧 ACK 与重复 ACK 保持幂等。
    ///
    /// 返回 `false` 表示 ACK 超过已发送范围，状态不会发生变化。
    pub fn acknowledge(&mut self, sequence: u64) -> bool {
        if sequence > self.last_sent {
            return false;
        }
        while self
            .pending
            .front()
            .is_some_and(|(sent, _)| *sent <= sequence)
        {
            if let Some((_, bytes)) = self.pending.pop_front() {
                self.outstanding_bytes -= bytes;
            }
        }
        if self.outstanding_bytes <= OUTPUT_LOW_WATERMARK {
            self.paused = false;
        }
        true
    }

    /// 是否应在下一次读取前等待；取消后返回 `false` 以允许线程退出。
    pub fn should_wait(&self) -> bool {
        self.paused && !self.cancelled
    }

    /// 尚未被累计确认的输出字节数。
    #[cfg(test)]
    pub fn outstanding_bytes(&self) -> usize {
        self.outstanding_bytes
    }

    /// 最后一次分配的输出序号；尚未发送时为零。
    #[cfg(test)]
    pub fn last_sent(&self) -> u64 {
        self.last_sent
    }

    /// 取消读取；调用方还需通知条件变量，唤醒已等待的线程。
    pub fn cancel(&mut self) {
        self.cancelled = true;
        self.paused = false;
    }

    /// 当前终端读取是否已取消。
    pub fn is_cancelled(&self) -> bool {
        self.cancelled
    }
}

/// 验证单个终端输入命令的连续序号；调用方需在写入过程使用同一把锁。
#[derive(Default)]
pub struct InputSequence {
    last_accepted: u64,
}

impl InputSequence {
    /// 仅接受从 1 开始严格连续的序号，错误序号不会改变当前状态。
    pub fn accept(&mut self, sequence: u64) -> bool {
        if self.last_accepted.checked_add(1) != Some(sequence) {
            return false;
        }
        self.last_accepted = sequence;
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn invalid_bytes_do_not_consume_a_later_split_utf8_character() {
        let mut pending = Vec::new();
        assert_eq!(decode_output(&mut pending, &[0xff, 0xe7, 0x95]), "�");
        assert_eq!(pending, [0xe7, 0x95]);
        assert_eq!(decode_output(&mut pending, &[0x8c]), "界");
        assert!(pending.is_empty());
    }

    #[test]
    fn unfinished_resize_is_drained_before_a_new_size_is_sent() {
        let mut pending = PendingResize::default();
        assert_eq!(pending.next((80, 24)), (80, 24));
        assert_eq!(pending.next((120, 40)), (80, 24));
        pending.complete();
        assert_eq!(pending.next((120, 40)), (120, 40));
        pending.complete();
        assert_eq!(pending.next((90, 20)), (90, 20));
    }

    #[test]
    fn output_decoding_preserves_ansi_and_all_code_point_boundaries() {
        let bytes = "\u{1b}[32m中文🙂\u{1b}[0m".as_bytes();
        for split in 0..=bytes.len() {
            let mut pending = Vec::new();
            let mut decoded = decode_output(&mut pending, &bytes[..split]);
            decoded.push_str(&decode_output(&mut pending, &bytes[split..]));
            assert!(pending.is_empty());
            assert_eq!(decoded.as_bytes(), bytes);
        }
        let mut pending = Vec::new();
        let mut decoded = String::new();
        for byte in bytes {
            decoded.push_str(&decode_output(&mut pending, &[*byte]));
        }
        assert_eq!(decoded.as_bytes(), bytes);
    }

    #[test]
    fn dimensions_use_defaults_only_for_zero_and_clamp_upper_bounds() {
        assert_eq!(normalize_dimensions(0, 0), (100, 30));
        assert_eq!(normalize_dimensions(1, 1), (1, 1));
        assert_eq!(normalize_dimensions(4096, 2048), (4096, 2048));
        assert_eq!(normalize_dimensions(u32::MAX, u32::MAX), (4096, 2048));
        assert_eq!(normalize_dimensions(0, 50), (100, 50));
    }

    #[test]
    fn cumulative_acknowledgements_release_only_sent_packets() {
        let mut flow = OutputFlow::default();
        assert_eq!(flow.record_sent(12), Some(1));
        assert_eq!(flow.record_sent(24), Some(2));
        assert_eq!(flow.record_sent(0), Some(3));
        assert_eq!(flow.last_sent(), 3);
        assert!(!flow.acknowledge(4));
        assert_eq!(flow.outstanding_bytes(), 36);
        assert!(flow.acknowledge(1));
        assert_eq!(flow.outstanding_bytes(), 24);
        assert!(flow.acknowledge(1));
        assert!(flow.acknowledge(0));
        assert_eq!(flow.outstanding_bytes(), 24);
        assert!(flow.acknowledge(3));
        assert_eq!(flow.outstanding_bytes(), 0);
    }

    #[test]
    fn pauses_at_high_watermark_and_resumes_only_at_low_watermark() {
        let mut flow = OutputFlow::default();
        assert_eq!(flow.record_sent(OUTPUT_LOW_WATERMARK), Some(1));
        assert_eq!(flow.record_sent(1), Some(2));
        assert_eq!(
            flow.record_sent(OUTPUT_HIGH_WATERMARK - OUTPUT_LOW_WATERMARK - 1),
            Some(3)
        );
        assert!(flow.should_wait());
        assert!(flow.acknowledge(1));
        assert!(flow.should_wait());
        assert!(flow.acknowledge(2));
        assert!(flow.should_wait());
        assert_eq!(flow.record_sent(OUTPUT_LOW_WATERMARK), Some(4));
        assert!(flow.acknowledge(3));
        assert_eq!(flow.outstanding_bytes(), OUTPUT_LOW_WATERMARK);
        assert!(!flow.should_wait());
    }

    #[test]
    fn cancellation_wakes_wait_policy_and_rejects_new_packets() {
        let mut flow = OutputFlow::default();
        assert_eq!(flow.record_sent(OUTPUT_HIGH_WATERMARK), Some(1));
        assert!(flow.should_wait());
        flow.cancel();
        assert!(flow.is_cancelled());
        assert!(!flow.should_wait());
        assert_eq!(flow.record_sent(1), None);
    }

    #[test]
    fn input_sequences_must_be_contiguous_and_start_at_one() {
        let mut input = InputSequence::default();
        assert!(!input.accept(0));
        assert!(!input.accept(2));
        assert!(input.accept(1));
        assert!(!input.accept(1));
        assert!(!input.accept(3));
        assert!(input.accept(2));
    }

    #[test]
    fn byte_counter_overflow_does_not_issue_a_sequence() {
        let mut flow = OutputFlow::default();
        assert_eq!(flow.record_sent(usize::MAX), Some(1));
        assert_eq!(flow.record_sent(1), None);
        assert_eq!(flow.last_sent(), 1);
        assert_eq!(flow.outstanding_bytes(), usize::MAX);
    }

    #[test]
    fn exhausted_sequence_numbers_do_not_wrap_or_modify_counters() {
        let mut flow = OutputFlow {
            last_sent: u64::MAX,
            ..OutputFlow::default()
        };
        assert_eq!(flow.record_sent(1), None);
        assert_eq!(flow.outstanding_bytes(), 0);
        assert_eq!(flow.last_sent(), u64::MAX);

        let mut input = InputSequence {
            last_accepted: u64::MAX,
        };
        assert!(!input.accept(0));
        assert!(!input.accept(u64::MAX));
    }
}
