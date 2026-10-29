//! 通过独立的 SFTP 通道执行有明确结果的 OpenSSH 原子重命名。

use std::fmt;
use std::io::{self, Read, Write};
use std::path::Path;

const MAX_PACKET_SIZE: usize = 64 * 1024;
const MAX_PAYLOAD_SIZE: usize = MAX_PACKET_SIZE - 4;
const POSIX_RENAME: &[u8] = b"posix-rename@openssh.com";
const REQUEST_ID: u32 = 1;
const INIT: [u8; 9] = [0, 0, 0, 5, 1, 0, 0, 0, 3];

/// 提交失败的类别；结果未知时不得自动重试或删除目标。
#[derive(Debug)]
pub(crate) enum CommitError {
    Unsupported,
    Protocol(String),
    Io(String),
    Cancelled,
    OutcomeUnknown(String),
    Rejected { code: u32, message: String },
}

impl fmt::Display for CommitError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Unsupported => write!(formatter, "服务器不支持所需的原子重命名扩展"),
            Self::Protocol(message) => write!(formatter, "SFTP 协议错误：{message}"),
            Self::Io(message) => write!(formatter, "SFTP 通信失败：{message}"),
            Self::Cancelled => write!(formatter, "操作已取消或超时"),
            Self::OutcomeUnknown(message) => write!(formatter, "提交结果未知：{message}"),
            Self::Rejected { code, message } => {
                write!(formatter, "服务器拒绝提交（状态 {code}）：{message}")
            }
        }
    }
}

impl std::error::Error for CommitError {}

/// 在独立 SFTP 通道上调用 `posix-rename@openssh.com`，不通过 shell 或 unlink。
///
/// 调用方必须在请求前自行验证两个绝对 POSIX 路径及其父目录的授权、类型和
/// 符号链接边界；这里的词法检查不能消除远端并发替换目录的风险。内容传输
/// 应继续使用独立的 `ssh2::Sftp` 通道。
///
/// `cancelled` 应同时检查取消和调用方的截止时间。检查发生在每次阻塞操作
/// 之前，但阻塞操作本身仍由现有 SSH 会话超时限制，不能中途被该闭包打断。
/// VERSION 扩展确认后先做最后的提交前取消检查，再调用一次 `begin_commit`。
/// 该闭包应原子地确认未取消并进入提交状态；返回错误时不发送 EXTENDED。
/// 一旦开始发送提交请求，通信、取消或协议错误均返回 `OutcomeUnknown`；
/// 调用方不得据此自动重试或移除目标。临时文件只可在可信父目录和所有权
/// 策略允许的前提下清理。
pub(crate) fn posix_rename(
    session: &ssh2::Session,
    source: &Path,
    target: &Path,
    cancelled: impl Fn() -> bool,
    begin_commit: impl Fn() -> Result<(), CommitError>,
) -> Result<(), CommitError> {
    let request = prepare_commit(source, target)?;
    check_cancelled(&cancelled)?;
    let mut channel = session.channel_session().map_err(|error| {
        if cancelled() {
            CommitError::Cancelled
        } else {
            CommitError::Io(error.to_string())
        }
    })?;
    check_cancelled(&cancelled)?;
    channel.subsystem("sftp").map_err(|error| {
        if cancelled() {
            CommitError::Cancelled
        } else {
            CommitError::Io(error.to_string())
        }
    })?;
    perform_commit(&mut channel, &request, &cancelled, begin_commit)
}

fn prepare_commit(source: &Path, target: &Path) -> Result<Vec<u8>, CommitError> {
    let source = posix_path_bytes(source)?;
    let target = posix_path_bytes(target)?;
    // 类型、请求 ID、扩展名及两个路径各自的长度字段均计入 payload。
    let payload_len = 1_usize
        .checked_add(4)
        .and_then(|n| n.checked_add(4 + POSIX_RENAME.len()))
        .and_then(|n| n.checked_add(4))
        .and_then(|n| n.checked_add(source.len()))
        .and_then(|n| n.checked_add(4))
        .and_then(|n| n.checked_add(target.len()))
        .ok_or_else(|| protocol("重命名请求长度溢出"))?;
    if payload_len > MAX_PAYLOAD_SIZE {
        return Err(protocol("重命名请求超过 64 KiB"));
    }
    let mut request = Vec::with_capacity(payload_len + 4);
    request.extend_from_slice(&(payload_len as u32).to_be_bytes());
    request.push(200); // SSH_FXP_EXTENDED
    request.extend_from_slice(&REQUEST_ID.to_be_bytes());
    append_string(&mut request, POSIX_RENAME);
    append_string(&mut request, source);
    append_string(&mut request, target);
    Ok(request)
}

fn append_string(packet: &mut Vec<u8>, value: &[u8]) {
    packet.extend_from_slice(&(value.len() as u32).to_be_bytes());
    packet.extend_from_slice(value);
}

fn posix_path_bytes(path: &Path) -> Result<&[u8], CommitError> {
    #[cfg(unix)]
    let bytes = {
        use std::os::unix::ffi::OsStrExt;
        path.as_os_str().as_bytes()
    };
    #[cfg(not(unix))]
    let bytes = path
        .to_str()
        .ok_or_else(|| protocol("远端路径无法表示为 UTF-8"))?
        .as_bytes();

    if !bytes.starts_with(b"/")
        || bytes.contains(&0)
        || bytes[1..]
            .split(|byte| *byte == b'/')
            .any(|part| part.is_empty() || part == b"." || part == b"..")
    {
        return Err(protocol("远端路径必须是规范的绝对 POSIX 文件路径"));
    }
    Ok(bytes)
}

fn perform_commit<T: Read + Write>(
    transport: &mut T,
    request: &[u8],
    cancelled: &impl Fn() -> bool,
    begin_commit: impl Fn() -> Result<(), CommitError>,
) -> Result<(), CommitError> {
    let mut init_attempted = false;
    write_all_checked(transport, &INIT, cancelled, &mut init_attempted)?;
    let version = read_packet(transport, cancelled)?;
    parse_version(&version)?;
    check_cancelled(cancelled)?;
    begin_commit()?;

    let mut commit_attempted = false;
    let result = (|| {
        write_all_checked(transport, request, cancelled, &mut commit_attempted)?;
        let response = read_packet(transport, cancelled)?;
        parse_status(&response)
    })();
    match result {
        Err(error)
            if commit_attempted
                && !matches!(
                    error,
                    CommitError::Unsupported | CommitError::Rejected { .. }
                ) =>
        {
            Err(CommitError::OutcomeUnknown(error.to_string()))
        }
        other => other,
    }
}

fn check_cancelled(cancelled: &impl Fn() -> bool) -> Result<(), CommitError> {
    if cancelled() {
        Err(CommitError::Cancelled)
    } else {
        Ok(())
    }
}

fn write_all_checked<T: Write>(
    transport: &mut T,
    mut bytes: &[u8],
    cancelled: &impl Fn() -> bool,
    attempted: &mut bool,
) -> Result<(), CommitError> {
    while !bytes.is_empty() {
        check_cancelled(cancelled)?;
        // 调用 write 后即使返回错误，也不能证明 libssh2 未发送请求字节。
        *attempted = true;
        match transport.write(bytes) {
            Ok(0) => {
                check_cancelled(cancelled)?;
                return Err(CommitError::Io("写入 SFTP 通道时连接关闭".to_string()));
            }
            Ok(written) => bytes = &bytes[written..],
            Err(error) => {
                check_cancelled(cancelled)?;
                return Err(CommitError::Io(error.to_string()));
            }
        }
    }
    Ok(())
}

fn read_exact_checked<T: Read>(
    transport: &mut T,
    mut bytes: &mut [u8],
    cancelled: &impl Fn() -> bool,
) -> Result<(), CommitError> {
    while !bytes.is_empty() {
        check_cancelled(cancelled)?;
        match transport.read(bytes) {
            Ok(0) => {
                check_cancelled(cancelled)?;
                return Err(CommitError::Io(
                    io::Error::from(io::ErrorKind::UnexpectedEof).to_string(),
                ));
            }
            Ok(read) => bytes = &mut bytes[read..],
            Err(error) => {
                check_cancelled(cancelled)?;
                return Err(CommitError::Io(error.to_string()));
            }
        }
    }
    Ok(())
}

fn read_packet<T: Read>(
    transport: &mut T,
    cancelled: &impl Fn() -> bool,
) -> Result<Vec<u8>, CommitError> {
    let mut length = [0_u8; 4];
    read_exact_checked(transport, &mut length, cancelled)?;
    let length = u32::from_be_bytes(length) as usize;
    if length == 0 || length > MAX_PAYLOAD_SIZE {
        return Err(protocol("SFTP 包长度无效或超过 64 KiB"));
    }
    let mut payload = vec![0; length];
    read_exact_checked(transport, &mut payload, cancelled)?;
    Ok(payload)
}

fn parse_version(payload: &[u8]) -> Result<(), CommitError> {
    let mut parser = Parser::new(payload);
    if parser.byte()? != 2 || parser.u32()? != 3 {
        return Err(protocol("服务器未返回 SFTP v3 VERSION"));
    }
    let mut found = None;
    while !parser.finished() {
        let name = parser.string()?;
        let value = parser.string()?;
        if name == POSIX_RENAME {
            if found.replace(value).is_some() {
                return Err(protocol("服务器重复声明原子重命名扩展"));
            }
        }
    }
    match found {
        Some(b"1") => Ok(()),
        _ => Err(CommitError::Unsupported),
    }
}

fn parse_status(payload: &[u8]) -> Result<(), CommitError> {
    let mut parser = Parser::new(payload);
    if parser.byte()? != 101 || parser.u32()? != REQUEST_ID {
        return Err(protocol("SFTP 提交响应类型或请求 ID 不匹配"));
    }
    let code = parser.u32()?;
    let message = parser.string()?;
    let _language = parser.string()?;
    if !parser.finished() {
        return Err(protocol("SFTP 状态响应包含额外数据"));
    }
    match code {
        0 => Ok(()),
        8 => Err(CommitError::Unsupported),
        code @ 1..=5 => Err(CommitError::Rejected {
            code,
            message: String::from_utf8_lossy(message).into_owned(),
        }),
        // v3 的 6、7 是仅供客户端使用的连接错误，未知状态也不能证明提交失败。
        _ => Err(protocol("服务器返回无效的 SFTP v3 状态码")),
    }
}

fn protocol(message: &str) -> CommitError {
    CommitError::Protocol(message.to_string())
}

struct Parser<'a> {
    bytes: &'a [u8],
    offset: usize,
}

impl<'a> Parser<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, offset: 0 }
    }

    fn take(&mut self, length: usize) -> Result<&'a [u8], CommitError> {
        let end = self
            .offset
            .checked_add(length)
            .ok_or_else(|| protocol("SFTP 字段长度溢出"))?;
        let value = self
            .bytes
            .get(self.offset..end)
            .ok_or_else(|| protocol("SFTP 包字段不完整"))?;
        self.offset = end;
        Ok(value)
    }

    fn byte(&mut self) -> Result<u8, CommitError> {
        Ok(self.take(1)?[0])
    }

    fn u32(&mut self) -> Result<u32, CommitError> {
        let bytes = self.take(4)?;
        Ok(u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
    }

    fn string(&mut self) -> Result<&'a [u8], CommitError> {
        let length = self.u32()? as usize;
        self.take(length)
    }

    fn finished(&self) -> bool {
        self.offset == self.bytes.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    use std::io::{self, Cursor, Read, Write};
    use std::path::Path;
    use std::rc::Rc;

    #[derive(Default)]
    struct ScriptedTransport {
        replies: Cursor<Vec<u8>>,
        written: Vec<u8>,
        progress: Rc<Cell<usize>>,
        read_progress: Rc<Cell<usize>>,
        read_limit: usize,
        write_limit: usize,
        fail_write_after: Option<usize>,
    }

    impl ScriptedTransport {
        fn new(replies: Vec<u8>) -> Self {
            Self {
                replies: Cursor::new(replies),
                read_limit: usize::MAX,
                write_limit: usize::MAX,
                ..Self::default()
            }
        }
    }

    impl Read for ScriptedTransport {
        fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
            let len = buffer.len().min(self.read_limit);
            let read = self.replies.read(&mut buffer[..len])?;
            self.read_progress.set(self.replies.position() as usize);
            Ok(read)
        }
    }

    impl Write for ScriptedTransport {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            if self
                .fail_write_after
                .is_some_and(|limit| self.written.len() >= limit)
            {
                return Err(io::Error::new(
                    io::ErrorKind::BrokenPipe,
                    "scripted failure",
                ));
            }
            let remaining = self
                .fail_write_after
                .map_or(usize::MAX, |limit| limit - self.written.len());
            let len = bytes.len().min(self.write_limit).min(remaining);
            self.written.extend_from_slice(&bytes[..len]);
            self.progress.set(self.written.len());
            Ok(len)
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    fn packet(payload: &[u8]) -> Vec<u8> {
        let mut packet = (payload.len() as u32).to_be_bytes().to_vec();
        packet.extend_from_slice(payload);
        packet
    }

    fn string(payload: &mut Vec<u8>, value: &[u8]) {
        payload.extend_from_slice(&(value.len() as u32).to_be_bytes());
        payload.extend_from_slice(value);
    }

    fn version(version: u32, extensions: &[(&[u8], &[u8])]) -> Vec<u8> {
        let mut payload = vec![2];
        payload.extend_from_slice(&version.to_be_bytes());
        for (name, data) in extensions {
            string(&mut payload, name);
            string(&mut payload, data);
        }
        packet(&payload)
    }

    fn supported_version() -> Vec<u8> {
        version(3, &[(b"posix-rename@openssh.com", b"1")])
    }

    fn status(id: u32, code: u32, message: &[u8]) -> Vec<u8> {
        let mut payload = vec![101];
        payload.extend_from_slice(&id.to_be_bytes());
        payload.extend_from_slice(&code.to_be_bytes());
        string(&mut payload, message);
        string(&mut payload, b"");
        packet(&payload)
    }

    fn scripted_rename(
        transport: &mut ScriptedTransport,
        source: &Path,
        target: &Path,
        cancelled: impl Fn() -> bool,
    ) -> Result<(), CommitError> {
        let request = prepare_commit(source, target)?;
        perform_commit(transport, &request, &cancelled, || Ok(()))
    }

    fn exchange(replies: Vec<u8>) -> Result<(), CommitError> {
        scripted_rename(
            &mut ScriptedTransport::new(replies),
            Path::new("/safe/.temporary"),
            Path::new("/safe/file"),
            || false,
        )
    }

    #[test]
    fn negotiates_v3_then_sends_posix_rename_with_request_id_one() {
        let mut replies = supported_version();
        replies.extend_from_slice(&status(1, 0, b""));
        let mut transport = ScriptedTransport::new(replies);
        transport.read_limit = 1;
        transport.write_limit = 1;
        scripted_rename(
            &mut transport,
            Path::new("/safe/.temporary"),
            Path::new("/safe/file"),
            || false,
        )
        .unwrap();

        let mut expected = packet(&[1, 0, 0, 0, 3]);
        let mut request = vec![200, 0, 0, 0, 1];
        string(&mut request, b"posix-rename@openssh.com");
        string(&mut request, b"/safe/.temporary");
        string(&mut request, b"/safe/file");
        expected.extend_from_slice(&packet(&request));
        assert_eq!(transport.written, expected);
    }

    #[test]
    fn refuses_missing_or_incompatible_extension_without_sending_commit() {
        for reply in [
            version(3, &[]),
            version(3, &[(b"posix-rename@openssh.com", b"2")]),
        ] {
            let mut transport = ScriptedTransport::new(reply);
            assert!(matches!(
                scripted_rename(&mut transport, Path::new("/a"), Path::new("/b"), || false),
                Err(CommitError::Unsupported)
            ));
            assert_eq!(transport.written, packet(&[1, 0, 0, 0, 3]));
        }
    }

    #[test]
    fn rejects_wrong_version_duplicate_extensions_and_malformed_negotiation() {
        let duplicate = version(
            3,
            &[
                (b"posix-rename@openssh.com", b"1"),
                (b"posix-rename@openssh.com", b"1"),
            ],
        );
        let malformed = packet(&[2, 0, 0, 0, 3, 0, 0, 0, 10, b'x']);
        for reply in [
            version(4, &[]),
            duplicate,
            malformed,
            packet(&[1, 0, 0, 0, 3]),
        ] {
            assert!(matches!(exchange(reply), Err(CommitError::Protocol(_))));
        }
    }

    #[test]
    fn rejects_oversized_or_empty_incoming_packets_before_allocating_payload() {
        for length in [0_u32, 65_533, u32::MAX] {
            assert!(matches!(
                exchange(length.to_be_bytes().to_vec()),
                Err(CommitError::Protocol(_))
            ));
        }
    }

    #[test]
    fn rejects_invalid_paths_and_oversized_request_before_any_writes() {
        let oversized = format!("/{}", "x".repeat(65_536));
        for source in [
            "relative",
            "/",
            "//file",
            "/a//file",
            "/a/./file",
            "/a/../file",
            "/a/file/",
            "/a/\0bad",
            oversized.as_str(),
        ] {
            let mut transport = ScriptedTransport::new(Vec::new());
            assert!(
                matches!(
                    scripted_rename(
                        &mut transport,
                        Path::new(source),
                        Path::new("/safe/file"),
                        || false
                    ),
                    Err(CommitError::Protocol(_))
                ),
                "{source:?}"
            );
            assert!(transport.written.is_empty());
        }

        let mut transport = ScriptedTransport::new(Vec::new());
        assert!(matches!(
            scripted_rename(
                &mut transport,
                Path::new("/safe/file"),
                Path::new("/unsafe/../target"),
                || false
            ),
            Err(CommitError::Protocol(_))
        ));
        assert!(transport.written.is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn sends_non_utf8_posix_path_bytes_without_loss() {
        use std::ffi::OsStr;
        use std::os::unix::ffi::OsStrExt;
        let mut replies = supported_version();
        replies.extend_from_slice(&status(1, 0, b""));
        let mut transport = ScriptedTransport::new(replies);
        let source = Path::new(OsStr::from_bytes(b"/safe/\xff"));
        scripted_rename(&mut transport, source, Path::new("/safe/file"), || false).unwrap();
        assert!(transport
            .written
            .windows(7)
            .any(|bytes| bytes == b"/safe/\xff"));
    }

    #[test]
    fn valid_server_rejection_and_unsupported_status_are_definitive() {
        let mut rejected = supported_version();
        rejected.extend_from_slice(&status(1, 3, b"denied"));
        assert!(
            matches!(exchange(rejected), Err(CommitError::Rejected { code: 3, message }) if message == "denied")
        );
        let mut unsupported = supported_version();
        unsupported.extend_from_slice(&status(1, 8, b"unsupported"));
        assert!(matches!(
            exchange(unsupported),
            Err(CommitError::Unsupported)
        ));
    }

    #[test]
    fn invalid_status_or_request_id_after_commit_has_unknown_outcome() {
        let mut truncated_status = status(1, 0, b"");
        truncated_status.pop();
        for response in [
            status(2, 0, b""),
            packet(&[201, 0, 0, 0, 1]),
            truncated_status,
            packet(&[101, 0, 0, 0, 1, 0, 0, 0, 0]),
        ] {
            let mut replies = supported_version();
            replies.extend_from_slice(&response);
            assert!(matches!(
                exchange(replies),
                Err(CommitError::OutcomeUnknown(_))
            ));
        }
    }

    #[test]
    fn invalid_or_client_only_status_codes_have_unknown_outcome() {
        for code in [6, 7, 9, u32::MAX] {
            let mut replies = supported_version();
            replies.extend_from_slice(&status(1, code, b""));
            assert!(
                matches!(exchange(replies), Err(CommitError::OutcomeUnknown(_))),
                "{code}"
            );
        }
    }

    #[test]
    fn accepts_maximum_sized_packets_but_not_one_byte_more() {
        let baseline = prepare_commit(Path::new("/s"), Path::new("/t"))
            .unwrap()
            .len();
        let source = format!("/{}", "x".repeat(1 + 65_536 - baseline));
        let request = prepare_commit(Path::new(&source), Path::new("/t")).unwrap();
        assert_eq!(request.len(), 65_536);
        assert!(matches!(
            prepare_commit(Path::new(&(source + "x")), Path::new("/t")),
            Err(CommitError::Protocol(_))
        ));

        let extensions: &[(&[u8], &[u8])] =
            &[(b"posix-rename@openssh.com", b"1"), (b"padding", b"")];
        let padding = vec![b'x'; 65_536 - version(3, extensions).len()];
        let mut replies = version(
            3,
            &[(b"posix-rename@openssh.com", b"1"), (b"padding", &padding)],
        );
        assert_eq!(replies.len(), 65_536);
        replies.extend_from_slice(&status(1, 0, b""));
        assert!(exchange(replies).is_ok());
    }

    #[test]
    fn a_received_success_status_wins_over_a_later_cancellation() {
        let mut replies = supported_version();
        replies.extend_from_slice(&status(1, 0, b""));
        let reply_len = replies.len();
        let mut transport = ScriptedTransport::new(replies);
        transport.read_limit = 1;
        let progress = transport.read_progress.clone();
        assert!(scripted_rename(
            &mut transport,
            Path::new("/a"),
            Path::new("/b"),
            || progress.get() >= reply_len
        )
        .is_ok());
    }

    #[test]
    fn interruption_before_commit_is_cancelled_or_io_not_unknown() {
        let mut immediately_cancelled = ScriptedTransport::new(Vec::new());
        assert!(matches!(
            scripted_rename(
                &mut immediately_cancelled,
                Path::new("/a"),
                Path::new("/b"),
                || true
            ),
            Err(CommitError::Cancelled)
        ));
        assert!(immediately_cancelled.written.is_empty());
        assert!(matches!(exchange(Vec::new()), Err(CommitError::Io(_))));
    }

    #[test]
    fn cancellation_during_a_failed_precommit_read_is_not_misreported_as_io() {
        struct CancelOnRead(Rc<Cell<bool>>);
        impl Read for CancelOnRead {
            fn read(&mut self, _buffer: &mut [u8]) -> io::Result<usize> {
                self.0.set(true);
                Err(io::Error::from(io::ErrorKind::TimedOut))
            }
        }
        impl Write for CancelOnRead {
            fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
                Ok(bytes.len())
            }
            fn flush(&mut self) -> io::Result<()> {
                Ok(())
            }
        }

        let flag = Rc::new(Cell::new(false));
        let request = prepare_commit(Path::new("/a"), Path::new("/b")).unwrap();
        assert!(matches!(
            perform_commit(
                &mut CancelOnRead(flag.clone()),
                &request,
                &|| flag.get(),
                || Ok(())
            ),
            Err(CommitError::Cancelled)
        ));
    }

    #[test]
    fn public_entry_point_checks_cancellation_before_opening_a_channel() {
        let session = ssh2::Session::new().unwrap();
        assert!(matches!(
            posix_rename(
                &session,
                Path::new("/a"),
                Path::new("/b"),
                || true,
                || Ok(())
            ),
            Err(CommitError::Cancelled)
        ));
    }

    #[test]
    fn cancelled_after_init_but_before_commit_is_safe_to_report_cancelled() {
        let reply = supported_version();
        let reply_len = reply.len();
        let mut transport = ScriptedTransport::new(reply);
        let progress = transport.read_progress.clone();
        assert!(matches!(
            scripted_rename(
                &mut transport,
                Path::new("/a"),
                Path::new("/b"),
                || progress.get() >= reply_len
            ),
            Err(CommitError::Cancelled)
        ));
        assert_eq!(transport.written.len(), 9);
    }

    #[test]
    fn cancellation_received_during_version_prevents_begin_and_extended_request() {
        let reply = supported_version();
        let reply_len = reply.len();
        let mut transport = ScriptedTransport::new(reply);
        transport.read_limit = 1;
        let progress = transport.read_progress.clone();
        let begin_calls = Cell::new(0);
        let request = prepare_commit(Path::new("/a"), Path::new("/b")).unwrap();

        assert!(matches!(
            perform_commit(
                &mut transport,
                &request,
                &|| progress.get() >= reply_len,
                || {
                    begin_calls.set(begin_calls.get() + 1);
                    Ok(())
                }
            ),
            Err(CommitError::Cancelled)
        ));
        assert_eq!(begin_calls.get(), 0);
        assert_eq!(transport.written, INIT);
    }

    #[test]
    fn begin_commit_can_cancel_without_sending_extended_request() {
        let mut transport = ScriptedTransport::new(supported_version());
        let begin_calls = Cell::new(0);
        let written = transport.progress.clone();
        let request = prepare_commit(Path::new("/a"), Path::new("/b")).unwrap();

        assert!(matches!(
            perform_commit(&mut transport, &request, &|| false, || {
                begin_calls.set(begin_calls.get() + 1);
                assert_eq!(written.get(), INIT.len());
                Err(CommitError::Cancelled)
            }),
            Err(CommitError::Cancelled)
        ));
        assert_eq!(begin_calls.get(), 1);
        assert_eq!(transport.written, INIT);
    }

    #[test]
    fn begin_commit_runs_once_after_negotiation_before_first_extended_write() {
        let version = supported_version();
        let version_len = version.len();
        let mut replies = version;
        replies.extend_from_slice(&status(1, 0, b""));
        let reply_len = replies.len();
        let mut transport = ScriptedTransport::new(replies);
        transport.read_limit = 1;
        transport.write_limit = 1;
        let read = transport.read_progress.clone();
        let written = transport.progress.clone();
        let begin_calls = Cell::new(0);
        let request = prepare_commit(Path::new("/a"), Path::new("/b")).unwrap();

        perform_commit(
            &mut transport,
            &request,
            &|| read.get() >= reply_len,
            || {
                assert_eq!(read.get(), version_len);
                assert_eq!(written.get(), INIT.len());
                begin_calls.set(begin_calls.get() + 1);
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(begin_calls.get(), 1);
        let mut expected = INIT.to_vec();
        expected.extend_from_slice(&request);
        assert_eq!(transport.written, expected);
    }

    #[test]
    fn cancellation_or_write_failure_after_commit_attempt_has_unknown_outcome() {
        let mut cancelled = ScriptedTransport::new(supported_version());
        cancelled.write_limit = 1;
        let progress = cancelled.progress.clone();
        assert!(matches!(
            scripted_rename(
                &mut cancelled,
                Path::new("/a"),
                Path::new("/b"),
                || progress.get() >= 10
            ),
            Err(CommitError::OutcomeUnknown(_))
        ));
        let mut broken = ScriptedTransport::new(supported_version());
        broken.fail_write_after = Some(9);
        assert!(matches!(
            scripted_rename(&mut broken, Path::new("/a"), Path::new("/b"), || false),
            Err(CommitError::OutcomeUnknown(_))
        ));
    }

    #[test]
    fn missing_response_after_commit_has_unknown_outcome() {
        assert!(matches!(
            exchange(supported_version()),
            Err(CommitError::OutcomeUnknown(_))
        ));
    }
}
