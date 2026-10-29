//! 有界归档传输和远端归档内容验证。
//!
//! 调用方必须提供独占 SSH 会话、可信源文件句柄和私有暂存区；本模块不提交目标。

use crate::transfer_validation::{validate_transfer, SourceStamp};
use flate2::{read::MultiGzDecoder, write::GzEncoder, Compression};
use ssh2::{Channel, ErrorCode, Session};
use std::collections::{HashMap, HashSet, VecDeque};
use std::fs::File;
use std::io::{self, Read, Write};
use std::path::{Component, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, SyncSender, TryRecvError, TrySendError};
use std::thread;
use std::time::{Duration, Instant, UNIX_EPOCH};
use thiserror::Error;

pub(crate) const MAX_BLOCK_FILES: usize = 512;
pub(crate) const MAX_BLOCK_BYTES: u64 = 64 * 1024 * 1024;
const MAX_EXTENSION_BYTES: usize = 64 * 1024;
const MAX_PATH_BYTES: usize = 4096;
const STDERR_TAIL_BYTES: usize = 64 * 1024;
const CHUNK_BYTES: usize = 32 * 1024;
const PUMP_PAUSE: Duration = Duration::from_millis(5);
const PROBE_LIMIT: Duration = Duration::from_secs(5);
const EAGAIN: i32 = -37;

/// 不支持只用于尚未发送传输数据的能力探测，后续错误绝不映射成不支持。
#[derive(Debug, Error)]
pub(crate) enum ArchiveTransferError {
    #[error("远端不支持归档传输: {0}")]
    Unsupported(String),
    #[error("归档内容无效: {0}")]
    InvalidArchive(String),
    #[error("源文件在传输期间发生变化: {0}")]
    SourceChanged(String),
    #[error("传输已取消")]
    Cancelled,
    #[error("远端归档命令失败（退出码 {status}）: {stderr}")]
    CommandFailed { status: i32, stderr: String },
    #[error("归档传输 I/O 失败: {0}")]
    Io(#[from] io::Error),
}

/// 路径和身份分离：远端源路径只用于 NUL 清单，内部 ID 只用于上传私有暂存。
#[derive(Debug, Clone)]
pub(crate) struct ManifestEntry {
    pub(crate) source_path: String,
    pub(crate) relative_path: PathBuf,
    pub(crate) internal_id: String,
    pub(crate) size: u64,
    pub(crate) stamp: SourceStamp,
}

#[derive(Debug, Clone)]
pub(crate) struct ArchiveManifest {
    entries: Vec<ManifestEntry>,
    total_bytes: u64,
}

#[derive(Debug, Clone)]
pub(crate) struct ManifestBlock {
    pub(crate) entries: Vec<ManifestEntry>,
    total_bytes: u64,
}

impl ArchiveManifest {
    pub(crate) fn new(entries: Vec<ManifestEntry>) -> Result<Self, ArchiveTransferError> {
        let mut ids = HashSet::new();
        let mut total_bytes = 0_u64;
        for entry in &entries {
            if !valid_remote_relative(&entry.source_path)
                || entry.relative_path.as_os_str().is_empty()
                || entry
                    .relative_path
                    .components()
                    .any(|part| !matches!(part, Component::Normal(_)))
                || !valid_internal_id(&entry.internal_id)
                || !ids.insert(entry.internal_id.clone())
            {
                return Err(ArchiveTransferError::InvalidArchive(
                    "清单路径或内部 ID 无效或重复".into(),
                ));
            }
            if entry.size > MAX_BLOCK_BYTES
                || entry.stamp.size != Some(entry.size)
                || entry
                    .stamp
                    .modified
                    .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                    .is_none()
            {
                return Err(ArchiveTransferError::Unsupported(
                    "源大小或时间未知，或单个文件超过归档块上限".into(),
                ));
            }
            total_bytes = total_bytes
                .checked_add(entry.size)
                .ok_or_else(|| ArchiveTransferError::Unsupported("清单大小溢出".into()))?;
        }
        Ok(Self {
            entries,
            total_bytes,
        })
    }

    /// 每块最多 512 个文件或 64 MiB，适合交由主控有界调度。
    pub(crate) fn blocks(&self) -> Vec<ManifestBlock> {
        let mut result = Vec::new();
        let mut block = ManifestBlock {
            entries: Vec::new(),
            total_bytes: 0,
        };
        for entry in &self.entries {
            if !block.entries.is_empty()
                && (block.entries.len() == MAX_BLOCK_FILES
                    || block.total_bytes + entry.size > MAX_BLOCK_BYTES)
            {
                result.push(block);
                block = ManifestBlock {
                    entries: Vec::new(),
                    total_bytes: 0,
                };
            }
            block.total_bytes += entry.size;
            block.entries.push(entry.clone());
        }
        if !block.entries.is_empty() {
            result.push(block);
        }
        result
    }
}

/// 自动模式仅对至少 256 个、平均不超过 256 KiB 的文件选择归档。
pub(crate) fn should_use_archive(manifest: &ArchiveManifest) -> bool {
    manifest.entries.len() >= 256
        && (manifest.total_bytes as u128) <= (manifest.entries.len() as u128) * 256 * 1024
}

fn valid_remote_relative(path: &str) -> bool {
    !path.is_empty()
        && path.len() <= MAX_PATH_BYTES
        && !path.contains('\0')
        && path
            .split('/')
            .all(|part| !part.is_empty() && part != "." && part != "..")
}

fn valid_internal_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 100
        && id.as_bytes()[0].is_ascii_alphanumeric()
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

pub(crate) struct StagedFile<W> {
    pub(crate) entry: ManifestEntry,
    pub(crate) writer: W,
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct TarCapability {
    pub(crate) gzip: bool,
}

fn invalid(message: impl Into<String>) -> ArchiveTransferError {
    ArchiveTransferError::InvalidArchive(message.into())
}

fn cancelled(cancel: &(dyn Fn() -> bool + Sync)) -> Result<(), ArchiveTransferError> {
    if cancel() {
        Err(ArchiveTransferError::Cancelled)
    } else {
        Ok(())
    }
}

/// 对解压后的字节总数设限，避免 gzip 或扩展头制造无限展开。
struct LimitedReader<R> {
    inner: R,
    remaining: u64,
}
impl<R: Read> Read for LimitedReader<R> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        if buffer.is_empty() {
            return Ok(0);
        }
        if self.remaining == 0 {
            let mut extra = [0_u8; 1];
            return match self.inner.read(&mut extra)? {
                0 => Ok(0),
                _ => Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "归档解压大小超限",
                )),
            };
        }
        let count = buffer.len().min(self.remaining as usize);
        let read = self.inner.read(&mut buffer[..count])?;
        self.remaining -= read as u64;
        Ok(read)
    }
}

fn read_archive_exact(
    reader: &mut impl Read,
    bytes: &mut [u8],
    cancel: &(dyn Fn() -> bool + Sync),
) -> Result<(), ArchiveTransferError> {
    let mut position = 0;
    while position < bytes.len() {
        cancelled(cancel)?;
        match reader.read(&mut bytes[position..]) {
            Ok(0) => return Err(invalid("归档意外截断")),
            Ok(count) => position += count,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {
                cancelled(cancel)?;
                return Err(error.into());
            }
            Err(error) => return Err(invalid(format!("读取归档失败: {error}"))),
        }
    }
    Ok(())
}

#[derive(Default)]
struct Extension {
    path: Option<Vec<u8>>,
    mtime: Option<u64>,
    seen: bool,
}

fn parse_pax(data: &[u8], extension: &mut Extension) -> Result<(), ArchiveTransferError> {
    let mut offset = 0;
    let mut keys = HashSet::new();
    while offset < data.len() {
        let space = data[offset..]
            .iter()
            .position(|b| *b == b' ')
            .ok_or_else(|| invalid("PAX 长度格式错误"))?
            + offset;
        let digits = &data[offset..space];
        if digits.is_empty() || digits.len() > 8 || !digits.iter().all(u8::is_ascii_digit) {
            return Err(invalid("PAX 长度无效"));
        }
        let length: usize = std::str::from_utf8(digits)
            .ok()
            .and_then(|v| v.parse().ok())
            .ok_or_else(|| invalid("PAX 长度无效"))?;
        let end = offset
            .checked_add(length)
            .filter(|end| *end <= data.len() && *end > space + 1)
            .ok_or_else(|| invalid("PAX 记录越界"))?;
        if data[end - 1] != b'\n' {
            return Err(invalid("PAX 记录未结束"));
        }
        let body = &data[space + 1..end - 1];
        let equal = body
            .iter()
            .position(|b| *b == b'=')
            .ok_or_else(|| invalid("PAX 字段无效"))?;
        let key = &body[..equal];
        let value = &body[equal + 1..];
        if !keys.insert(key.to_vec()) || value.contains(&0) {
            return Err(invalid("PAX 字段重复或含 NUL"));
        }
        match key {
            b"path" if extension.path.is_none() && value.len() <= MAX_PATH_BYTES + 2 => {
                extension.path = Some(value.to_vec())
            }
            b"mtime" if extension.mtime.is_none() => {
                let integer = value.split(|b| *b == b'.').next().unwrap_or_default();
                if integer.is_empty() || !integer.iter().all(u8::is_ascii_digit) {
                    return Err(invalid("PAX 时间无效"));
                }
                if let Some(dot) = value.iter().position(|b| *b == b'.') {
                    let fraction = &value[dot + 1..];
                    if fraction.is_empty() || !fraction.iter().all(u8::is_ascii_digit) {
                        return Err(invalid("PAX 时间无效"));
                    }
                }
                extension.mtime = Some(
                    std::str::from_utf8(integer)
                        .ok()
                        .and_then(|v| v.parse().ok())
                        .ok_or_else(|| invalid("PAX 时间溢出"))?,
                );
            }
            // 这些字段不参与本地创建；其余字段（包括所有 sparse、size、linkpath）拒绝。
            b"atime" | b"ctime" | b"uid" | b"gid" | b"uname" | b"gname" => {}
            _ => return Err(invalid("不允许的 PAX 字段")),
        }
        offset = end;
    }
    Ok(())
}

/// 逐项解码且绝不使用 `Archive::unpack`；任何错误都会丢弃全部尚未提交的写入器。
fn decode_archive<R: Read, W: Write>(
    reader: R,
    block: &ManifestBlock,
    prepare: &mut dyn FnMut(&ManifestEntry) -> io::Result<W>,
    cancel: &(dyn Fn() -> bool + Sync),
) -> Result<Vec<StagedFile<W>>, ArchiveTransferError> {
    let maximum = block.total_bytes.saturating_add(4 * 1024 * 1024);
    let mut reader = LimitedReader {
        inner: reader,
        remaining: maximum,
    };
    let mut expected = HashMap::new();
    for entry in &block.entries {
        let key = format!("./{}", entry.source_path).into_bytes();
        if expected.insert(key, entry).is_some() {
            return Err(invalid("远端源路径重复"));
        }
    }
    let mut seen = HashSet::new();
    let mut staged = Vec::with_capacity(block.entries.len());
    let mut extension = Extension::default();
    let mut extension_bytes = 0_usize;
    let mut zero_blocks = 0;
    loop {
        let mut bytes = [0_u8; 512];
        read_archive_exact(&mut reader, &mut bytes, cancel)?;
        if bytes.iter().all(|b| *b == 0) {
            zero_blocks += 1;
            if zero_blocks == 2 {
                break;
            }
            continue;
        }
        if zero_blocks != 0 {
            return Err(invalid("归档结束标记不完整"));
        }
        let header = tar::Header::from_byte_slice(&bytes);
        let checksum = bytes
            .iter()
            .enumerate()
            .map(|(index, byte)| {
                if (148..156).contains(&index) {
                    32
                } else {
                    u32::from(*byte)
                }
            })
            .sum::<u32>();
        if header.cksum().ok() != Some(checksum) {
            return Err(invalid("归档头校验和错误"));
        }
        let size = header
            .entry_size()
            .map_err(|_| invalid("归档大小字段错误"))?;
        let kind = bytes[156];
        if kind == b'x' || kind == b'L' {
            if extension.seen {
                return Err(invalid("重复归档扩展头"));
            }
            extension.seen = true;
            let len = usize::try_from(size).map_err(|_| invalid("扩展头过大"))?;
            extension_bytes = extension_bytes
                .checked_add(len)
                .ok_or_else(|| invalid("扩展头过大"))?;
            if len > MAX_EXTENSION_BYTES || extension_bytes > MAX_EXTENSION_BYTES {
                return Err(invalid("归档扩展头总量超限"));
            }
            let mut data = vec![0; len];
            read_archive_exact(&mut reader, &mut data, cancel)?;
            let padding = (512 - len % 512) % 512;
            let mut pad = [0_u8; 512];
            read_archive_exact(&mut reader, &mut pad[..padding], cancel)?;
            if kind == b'x' {
                parse_pax(&data, &mut extension)?;
            } else {
                if data.last() == Some(&0) {
                    data.pop();
                }
                if data.len() > MAX_PATH_BYTES + 2 || data.contains(&0) {
                    return Err(invalid("GNU 长路径无效"));
                }
                extension.path = Some(data);
            }
            continue;
        }
        if kind != 0 && kind != b'0' {
            return Err(invalid("归档包含链接、目录、特殊文件或稀疏文件"));
        }
        if bytes[157..257].iter().any(|byte| *byte != 0) {
            return Err(invalid("普通文件包含链接目标"));
        }
        let name = extension
            .path
            .take()
            .unwrap_or_else(|| header.path_bytes().into_owned());
        let entry = expected
            .get(&name)
            .copied()
            .ok_or_else(|| invalid("归档出现非清单路径"))?;
        if !seen.insert(name) {
            return Err(invalid("归档包含重复文件"));
        }
        let modified = extension
            .mtime
            .take()
            .or_else(|| header.mtime().ok())
            .ok_or_else(|| invalid("归档时间字段无效"))?;
        extension = Extension::default();
        let expected_mtime = entry
            .stamp
            .modified
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|t| t.as_secs())
            .ok_or_else(|| invalid("清单缺少源时间"))?;
        if size != entry.size || modified != expected_mtime {
            return Err(ArchiveTransferError::SourceChanged(
                entry.source_path.clone(),
            ));
        }
        let mut writer = prepare(entry)?;
        let mut left = size;
        let mut buffer = [0_u8; CHUNK_BYTES];
        while left != 0 {
            let count = (left as usize).min(buffer.len());
            read_archive_exact(&mut reader, &mut buffer[..count], cancel)?;
            cancelled(cancel)?;
            writer.write_all(&buffer[..count])?;
            left -= count as u64;
        }
        let padding = ((512 - size % 512) % 512) as usize;
        read_archive_exact(&mut reader, &mut buffer[..padding], cancel)?;
        staged.push(StagedFile {
            entry: entry.clone(),
            writer,
        });
    }
    if extension.seen || seen.len() != expected.len() {
        return Err(invalid("归档缺少清单项目或包含悬空扩展头"));
    }
    // GNU tar 可以在两个结束块之后补零到记录边界；不得有额外成员或非零尾部。
    let mut buffer = [0_u8; CHUNK_BYTES];
    loop {
        cancelled(cancel)?;
        let count = reader
            .read(&mut buffer)
            .map_err(|error| invalid(format!("归档尾部无效: {error}")))?;
        if count == 0 {
            break;
        }
        if buffer[..count].iter().any(|byte| *byte != 0) {
            return Err(invalid("归档结束标记后含非零数据"));
        }
    }
    Ok(staged)
}

/// 进入独占会话的非阻塞模式，并恢复调用前状态。
struct SessionMode<'a> {
    session: &'a Session,
    blocking: bool,
}
impl<'a> SessionMode<'a> {
    fn new(session: &'a Session) -> Self {
        let blocking = session.is_blocking();
        session.set_blocking(false);
        Self { session, blocking }
    }
}
impl Drop for SessionMode<'_> {
    fn drop(&mut self) {
        self.session.set_blocking(self.blocking);
    }
}

fn check_wait(
    cancel: &(dyn Fn() -> bool + Sync),
    deadline: Option<Instant>,
) -> Result<(), ArchiveTransferError> {
    cancelled(cancel)?;
    if deadline.is_some_and(|limit| Instant::now() >= limit) {
        return Err(io::Error::new(io::ErrorKind::TimedOut, "远端归档命令超时").into());
    }
    Ok(())
}

fn ssh_would_block(error: &ssh2::Error) -> bool {
    error.code() == ErrorCode::Session(EAGAIN)
}

fn open_command(
    session: &Session,
    command: &str,
    cancel: &(dyn Fn() -> bool + Sync),
    deadline: Option<Instant>,
) -> Result<Channel, ArchiveTransferError> {
    let mut channel = loop {
        check_wait(cancel, deadline)?;
        match session.channel_session() {
            Ok(channel) => break channel,
            Err(error) if ssh_would_block(&error) => thread::sleep(PUMP_PAUSE),
            Err(error) => return Err(io::Error::other(error.to_string()).into()),
        }
    };
    loop {
        check_wait(cancel, deadline)?;
        match channel.exec(command) {
            Ok(()) => return Ok(channel),
            Err(error) if ssh_would_block(&error) => thread::sleep(PUMP_PAUSE),
            Err(error) => return Err(io::Error::other(error.to_string()).into()),
        }
    }
}

enum PumpInput {
    Bytes { data: Vec<u8>, position: usize },
    Chunks(Receiver<Vec<u8>>),
}
enum PumpOutput {
    Discard,
    Capture { data: Vec<u8>, maximum: usize },
    Chunks(SyncSender<Vec<u8>>),
}

/// SSH stdin、stdout 和 stderr 在同一个非阻塞循环内交替推进。
/// 上下游最多两个分块加一个待发送分块，stderr 只保留最近 64 KiB。
fn pump(
    session: &Session,
    command: &str,
    mut input: PumpInput,
    mut output: PumpOutput,
    cancel: &(dyn Fn() -> bool + Sync),
    deadline: Option<Instant>,
) -> Result<Vec<u8>, ArchiveTransferError> {
    let _mode = SessionMode::new(session);
    let mut channel = open_command(session, command, cancel, deadline)?;
    let mut stderr = channel.stderr();
    let mut tail = VecDeque::with_capacity(STDERR_TAIL_BYTES);
    let mut pending_input: Option<(Vec<u8>, usize)> = None;
    let mut pending_output: Option<Vec<u8>> = None;
    let mut input_done = false;
    let mut eof_sent = false;
    let mut read_buffer = [0_u8; CHUNK_BYTES];
    loop {
        check_wait(cancel, deadline)?;
        let mut progress = false;
        if let Some(data) = pending_output.take() {
            match &mut output {
                PumpOutput::Chunks(sender) => match sender.try_send(data) {
                    Ok(()) => progress = true,
                    Err(TrySendError::Full(data)) => pending_output = Some(data),
                    Err(TrySendError::Disconnected(_)) => {
                        return Err(
                            io::Error::new(io::ErrorKind::BrokenPipe, "归档解析器已退出").into(),
                        )
                    }
                },
                _ => unreachable!(),
            }
        }
        if pending_input.is_none() && !input_done {
            match &mut input {
                PumpInput::Bytes { data, position } => {
                    if *position == data.len() {
                        input_done = true;
                    } else {
                        let end = (*position + CHUNK_BYTES).min(data.len());
                        pending_input = Some((data[*position..end].to_vec(), 0));
                        *position = end;
                    }
                }
                PumpInput::Chunks(receiver) => match receiver.try_recv() {
                    Ok(data) => {
                        pending_input = Some((data, 0));
                        progress = true;
                    }
                    Err(TryRecvError::Empty) => {}
                    Err(TryRecvError::Disconnected) => input_done = true,
                },
            }
        }
        if let Some((data, position)) = &mut pending_input {
            match channel.write(&data[*position..]) {
                Ok(0) => {}
                Ok(count) => {
                    *position += count;
                    progress = true;
                    if *position == data.len() {
                        pending_input = None;
                    }
                }
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {}
                Err(error) => return Err(error.into()),
            }
        }
        if input_done && pending_input.is_none() && !eof_sent {
            match channel.send_eof() {
                Ok(()) => {
                    eof_sent = true;
                    progress = true;
                }
                Err(error) if ssh_would_block(&error) => {}
                Err(error) => return Err(io::Error::other(error.to_string()).into()),
            }
        }
        match stderr.read(&mut read_buffer) {
            Ok(0) => {}
            Ok(count) => {
                progress = true;
                for byte in &read_buffer[..count] {
                    if tail.len() == STDERR_TAIL_BYTES {
                        tail.pop_front();
                    }
                    tail.push_back(*byte);
                }
            }
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {}
            Err(error) => return Err(error.into()),
        }
        if pending_output.is_none() {
            match channel.read(&mut read_buffer) {
                Ok(0) => {}
                Ok(count) => {
                    progress = true;
                    match &mut output {
                        PumpOutput::Discard => {}
                        PumpOutput::Capture { data, maximum } => {
                            if data.len().saturating_add(count) > *maximum {
                                return Err(io::Error::new(
                                    io::ErrorKind::InvalidData,
                                    "远端输出超限",
                                )
                                .into());
                            }
                            data.extend_from_slice(&read_buffer[..count]);
                        }
                        PumpOutput::Chunks(sender) => {
                            match sender.try_send(read_buffer[..count].to_vec()) {
                                Ok(()) => {}
                                Err(TrySendError::Full(data)) => pending_output = Some(data),
                                Err(TrySendError::Disconnected(_)) => {
                                    return Err(io::Error::new(
                                        io::ErrorKind::BrokenPipe,
                                        "归档解析器已退出",
                                    )
                                    .into())
                                }
                            }
                        }
                    }
                }
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {}
                Err(error) => return Err(error.into()),
            }
        }
        if channel.eof() && pending_output.is_none() {
            break;
        }
        if !progress {
            thread::sleep(PUMP_PAUSE);
        }
    }
    loop {
        check_wait(cancel, deadline)?;
        match channel.wait_close() {
            Ok(()) => break,
            Err(error) if ssh_would_block(&error) => thread::sleep(PUMP_PAUSE),
            Err(error) => return Err(io::Error::other(error.to_string()).into()),
        }
    }
    let status = channel
        .exit_status()
        .map_err(|e| io::Error::other(e.to_string()))?;
    let signal = channel
        .exit_signal()
        .map_err(|e| io::Error::other(e.to_string()))?;
    if status != 0 || signal.exit_signal.is_some() {
        let mut message =
            String::from_utf8_lossy(&tail.into_iter().collect::<Vec<_>>()).into_owned();
        if let Some(signal) = signal.exit_signal {
            message.push_str(&format!(" (signal: {signal})"));
        }
        return Err(ArchiveTransferError::CommandFailed {
            status,
            stderr: message,
        });
    }
    if !eof_sent {
        return Err(io::Error::new(io::ErrorKind::BrokenPipe, "远端在输入完成前退出").into());
    }
    Ok(match output {
        PumpOutput::Capture { data, .. } => data,
        _ => Vec::new(),
    })
}

/// 探测 GNU tar 和 gzip；总时间（包括打开通道）不超过 5 秒。
pub(crate) fn probe_remote_tar(
    session: &Session,
    cancel: &(dyn Fn() -> bool + Sync),
    timeout: Duration,
) -> Result<TarCapability, ArchiveTransferError> {
    let deadline = Instant::now().checked_add(timeout.min(PROBE_LIMIT));
    let command = |command| {
        pump(
            session,
            command,
            PumpInput::Bytes {
                data: Vec::new(),
                position: 0,
            },
            PumpOutput::Capture {
                data: Vec::new(),
                maximum: STDERR_TAIL_BYTES,
            },
            cancel,
            deadline,
        )
    };
    let tar = match command("tar --version") {
        Ok(output) => output,
        Err(error @ ArchiveTransferError::CommandFailed { .. }) => {
            return Err(ArchiveTransferError::Unsupported(error.to_string()))
        }
        Err(error) => return Err(error),
    };
    if !tar.starts_with(b"tar (GNU tar)") {
        return Err(ArchiveTransferError::Unsupported("需要 GNU tar".into()));
    }
    let gzip = match command("gzip --version") {
        Ok(_) => true,
        Err(ArchiveTransferError::CommandFailed { .. }) => false,
        Err(error) => return Err(error),
    };
    Ok(TarCapability { gzip })
}

fn shell_quote(path: &str) -> Result<String, ArchiveTransferError> {
    if path.is_empty() || path.contains('\0') {
        return Err(invalid("远端根路径为空或含 NUL"));
    }
    Ok(format!("'{}'", path.replace('\'', "'\\''")))
}

struct ChunkWriter<'a> {
    sender: SyncSender<Vec<u8>>,
    stopped: &'a AtomicBool,
    cancel: &'a (dyn Fn() -> bool + Sync),
}
impl Write for ChunkWriter<'_> {
    fn write(&mut self, data: &[u8]) -> io::Result<usize> {
        if data.is_empty() {
            return Ok(0);
        }
        let count = data.len().min(CHUNK_BYTES);
        let mut chunk = data[..count].to_vec();
        loop {
            if self.stopped.load(Ordering::Acquire) || (self.cancel)() {
                return Err(io::Error::new(io::ErrorKind::Interrupted, "归档写入已取消"));
            }
            match self.sender.try_send(chunk) {
                Ok(()) => return Ok(count),
                Err(TrySendError::Full(pending)) => {
                    chunk = pending;
                    thread::sleep(PUMP_PAUSE);
                }
                Err(TrySendError::Disconnected(_)) => {
                    return Err(io::Error::new(
                        io::ErrorKind::BrokenPipe,
                        "SSH 归档通道已关闭",
                    ))
                }
            }
        }
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

struct ChunkReader<'a> {
    receiver: Receiver<Vec<u8>>,
    current: Vec<u8>,
    position: usize,
    stopped: &'a AtomicBool,
    cancel: &'a (dyn Fn() -> bool + Sync),
}
impl Read for ChunkReader<'_> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        if buffer.is_empty() {
            return Ok(0);
        }
        loop {
            if self.stopped.load(Ordering::Acquire) || (self.cancel)() {
                return Err(io::Error::new(io::ErrorKind::Interrupted, "归档读取已取消"));
            }
            if self.position < self.current.len() {
                let count = buffer.len().min(self.current.len() - self.position);
                buffer[..count]
                    .copy_from_slice(&self.current[self.position..self.position + count]);
                self.position += count;
                return Ok(count);
            }
            match self.receiver.recv_timeout(PUMP_PAUSE) {
                Ok(chunk) => {
                    self.current = chunk;
                    self.position = 0;
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => return Ok(0),
            }
        }
    }
}

struct CancelReader<'a, R> {
    inner: R,
    cancel: &'a (dyn Fn() -> bool + Sync),
}
impl<R: Read> Read for CancelReader<'_, R> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        if (self.cancel)() {
            return Err(io::Error::new(io::ErrorKind::Interrupted, "归档读取已取消"));
        }
        self.inner.read(buffer)
    }
}

fn produce_tar<W: Write>(
    mut builder: tar::Builder<W>,
    block: &ManifestBlock,
    cancel: &(dyn Fn() -> bool + Sync),
    open: &(dyn Fn(&ManifestEntry) -> io::Result<File> + Sync),
) -> Result<W, ArchiveTransferError> {
    for entry in &block.entries {
        cancelled(cancel)?;
        let mut file = open(entry)?;
        let metadata = file.metadata()?;
        if !metadata.is_file() {
            return Err(ArchiveTransferError::SourceChanged(
                entry.source_path.clone(),
            ));
        }
        let before = SourceStamp::from_local_metadata(&metadata)?;
        validate_transfer(&entry.stamp, &before, entry.size).map_err(|e| {
            ArchiveTransferError::SourceChanged(format!("{}: {e}", entry.source_path))
        })?;
        let mut header = tar::Header::new_gnu();
        header.set_size(entry.size);
        header.set_mode(0o600);
        header.set_mtime(
            before
                .modified
                .and_then(|m| m.duration_since(UNIX_EPOCH).ok())
                .map(|v| v.as_secs())
                .unwrap_or(0),
        );
        header.set_entry_type(tar::EntryType::Regular);
        let mut limited = (&mut file).take(entry.size);
        let source = CancelReader {
            inner: &mut limited,
            cancel,
        };
        if let Err(error) = builder.append_data(&mut header, &entry.internal_id, source) {
            cancelled(cancel)?;
            return Err(error.into());
        }
        let actual = entry.size - limited.limit();
        let after = SourceStamp::from_local_metadata(&file.metadata()?)?;
        validate_transfer(&before, &after, actual).map_err(|e| {
            ArchiveTransferError::SourceChanged(format!("{}: {e}", entry.source_path))
        })?;
    }
    builder.into_inner().map_err(|error| {
        if cancel() {
            ArchiveTransferError::Cancelled
        } else {
            error.into()
        }
    })
}

/// 将可信普通文件句柄组成归档，远端仅解到调用方预先创建的私有平铺暂存目录。
/// 若失败，调用方必须删除整个暂存区；不能提交任何已有暂存文件。
pub(crate) fn upload_block(
    session: &Session,
    block: &ManifestBlock,
    stage_dir: &str,
    gzip: bool,
    cancel: &(dyn Fn() -> bool + Sync),
    open: &(dyn Fn(&ManifestEntry) -> io::Result<File> + Sync),
) -> Result<(), ArchiveTransferError> {
    cancelled(cancel)?;
    let stage = shell_quote(stage_dir)?;
    let compression = if gzip { " --gzip" } else { "" };
    let command = format!("cd -- {stage} && umask 077 && exec tar --extract --file=- --no-same-owner --no-same-permissions --keep-old-files{compression}");
    let stopped = AtomicBool::new(false);
    let (sender, receiver) = mpsc::sync_channel(2);
    thread::scope(|scope| {
        let producer = scope.spawn(|| -> Result<(), ArchiveTransferError> {
            let output = ChunkWriter {
                sender,
                stopped: &stopped,
                cancel,
            };
            if gzip {
                let encoder = GzEncoder::new(output, Compression::default());
                let encoder = produce_tar(tar::Builder::new(encoder), block, cancel, open)?;
                encoder.finish().map_err(|error| {
                    if cancel() {
                        ArchiveTransferError::Cancelled
                    } else {
                        error.into()
                    }
                })?;
            } else {
                produce_tar(tar::Builder::new(output), block, cancel, open)?;
            }
            Ok(())
        });
        let result = pump(
            session,
            &command,
            PumpInput::Chunks(receiver),
            PumpOutput::Discard,
            cancel,
            None,
        );
        if result.is_err() {
            stopped.store(true, Ordering::Release);
        }
        let produced = producer
            .join()
            .unwrap_or_else(|_| Err(io::Error::other("归档生产线程异常退出").into()));
        if cancel() {
            return Err(ArchiveTransferError::Cancelled);
        }
        match (result, produced) {
            (_, Err(error @ ArchiveTransferError::SourceChanged(_))) => Err(error),
            (Err(error), _) => Err(error),
            (Ok(_), Err(error)) => Err(error),
            (Ok(_), Ok(())) => Ok(()),
        }
    })
}

/// 用固定 GNU tar 参数和 NUL 清单读取远端普通文件；返回值全部仍未提交。
/// 调用方须在运行前后通过 SFTP 校验每个源的类型、大小、修改时间。
pub(crate) fn download_block<W: Write + Send>(
    session: &Session,
    block: &ManifestBlock,
    remote_root: &str,
    gzip: bool,
    cancel: &(dyn Fn() -> bool + Sync),
    prepare: &mut (dyn FnMut(&ManifestEntry) -> io::Result<W> + Send),
) -> Result<Vec<StagedFile<W>>, ArchiveTransferError> {
    cancelled(cancel)?;
    let root = shell_quote(remote_root)?;
    let mut names = HashSet::new();
    let mut list = Vec::new();
    for entry in &block.entries {
        if !names.insert(&entry.source_path) {
            return Err(invalid("远端源路径重复"));
        }
        list.extend_from_slice(b"./");
        list.extend_from_slice(entry.source_path.as_bytes());
        list.push(0);
    }
    let compression = if gzip { " --gzip" } else { "" };
    let command = format!("cd -- {root} && exec tar --create --file=- --format=gnu --null --no-recursion --verbatim-files-from --hard-dereference{compression} --files-from=-");
    let stopped = AtomicBool::new(false);
    let (sender, receiver) = mpsc::sync_channel(2);
    thread::scope(|scope| {
        let consumer = scope.spawn(|| {
            let input = ChunkReader {
                receiver,
                current: Vec::new(),
                position: 0,
                stopped: &stopped,
                cancel,
            };
            if gzip {
                decode_archive(MultiGzDecoder::new(input), block, prepare, cancel)
            } else {
                decode_archive(input, block, prepare, cancel)
            }
        });
        let result = pump(
            session,
            &command,
            PumpInput::Bytes {
                data: list,
                position: 0,
            },
            PumpOutput::Chunks(sender),
            cancel,
            None,
        );
        if result.is_err() {
            stopped.store(true, Ordering::Release);
        }
        let decoded = consumer
            .join()
            .unwrap_or_else(|_| Err(io::Error::other("归档解析线程异常退出").into()));
        if cancel() {
            return Err(ArchiveTransferError::Cancelled);
        }
        match (result, decoded) {
            (Err(error @ ArchiveTransferError::CommandFailed { .. }), _) => Err(error),
            (Err(ArchiveTransferError::Io(error)), Err(parsed))
                if error.kind() == io::ErrorKind::BrokenPipe =>
            {
                Err(parsed)
            }
            (Err(error), _) => Err(error),
            (Ok(_), Err(error)) => Err(error),
            (Ok(_), Ok(staged)) => Ok(staged),
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Cursor, Write};
    use std::time::{Duration, UNIX_EPOCH};

    fn item(source: &str, id: &str, size: u64) -> ManifestEntry {
        ManifestEntry {
            source_path: source.into(),
            relative_path: source.into(),
            internal_id: id.into(),
            size,
            stamp: SourceStamp::new(Some(size), Some(UNIX_EPOCH + Duration::from_secs(42))),
        }
    }

    fn block(items: Vec<ManifestEntry>) -> ManifestBlock {
        ArchiveManifest::new(items).unwrap().blocks().remove(0)
    }

    fn archive(rows: &[(&str, u8, &[u8], u64)]) -> Vec<u8> {
        let mut result = Vec::new();
        for (name, kind, data, mtime) in rows {
            let mut header = tar::Header::new_gnu();
            header.set_size(data.len() as u64);
            header.set_mode(0o600);
            header.set_mtime(*mtime);
            header.set_entry_type(tar::EntryType::new(*kind));
            let raw = header.as_mut_bytes();
            assert!(name.len() <= 100);
            raw[..100].fill(0);
            raw[..name.len()].copy_from_slice(name.as_bytes());
            header.set_cksum();
            result.extend_from_slice(header.as_bytes());
            result.extend_from_slice(data);
            result.resize((result.len() + 511) & !511, 0);
        }
        result.resize(result.len() + 1024, 0);
        result
    }

    fn parse(
        bytes: &[u8],
        block: &ManifestBlock,
    ) -> Result<Vec<StagedFile<Cursor<Vec<u8>>>>, ArchiveTransferError> {
        decode_archive(
            Cursor::new(bytes),
            block,
            &mut |_| Ok(Cursor::new(Vec::new())),
            &|| false,
        )
    }

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            use std::sync::atomic::{AtomicU64, Ordering};
            static NEXT: AtomicU64 = AtomicU64::new(0);
            let path = std::env::temp_dir().join(format!(
                "portal-archive-test-{}-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn upload_uses_flattened_ids_and_rechecks_open_handle_stamp() {
        let fixture = Fixture::new();
        let source = fixture.0.join("real name");
        std::fs::write(&source, b"abc").unwrap();
        let stamp = SourceStamp::from_local_metadata(&std::fs::metadata(&source).unwrap()).unwrap();
        let mut entry = item("real name", "f00", 3);
        entry.stamp = stamp;
        let block = block(vec![entry.clone()]);
        let output = produce_tar(tar::Builder::new(Vec::new()), &block, &|| false, &|_| {
            File::open(&source)
        })
        .unwrap();
        let mut archive = tar::Archive::new(Cursor::new(output));
        let mut files = archive.entries().unwrap();
        let mut file = files.next().unwrap().unwrap();
        assert_eq!(file.path().unwrap().as_ref(), std::path::Path::new("f00"));
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes).unwrap();
        assert_eq!(bytes, b"abc");
        assert!(files.next().is_none());
        std::fs::write(&source, b"changed-size").unwrap();
        assert!(matches!(
            produce_tar(tar::Builder::new(Vec::new()), &block, &|| false, &|_| {
                File::open(&source)
            }),
            Err(ArchiveTransferError::SourceChanged(_))
        ));
    }

    #[test]
    fn upload_detects_mutation_after_source_handle_opened() {
        struct ChangeOnHeader {
            path: PathBuf,
            changed: bool,
        }
        impl Write for ChangeOnHeader {
            fn write(&mut self, data: &[u8]) -> io::Result<usize> {
                if !self.changed {
                    self.changed = true;
                    std::fs::write(&self.path, b"changed-size")?;
                }
                Ok(data.len())
            }
            fn flush(&mut self) -> io::Result<()> {
                Ok(())
            }
        }
        let fixture = Fixture::new();
        let source = fixture.0.join("source");
        std::fs::write(&source, b"abc").unwrap();
        let mut entry = item("source", "f00", 3);
        entry.stamp =
            SourceStamp::from_local_metadata(&std::fs::metadata(&source).unwrap()).unwrap();
        let result = produce_tar(
            tar::Builder::new(ChangeOnHeader {
                path: source.clone(),
                changed: false,
            }),
            &block(vec![entry]),
            &|| false,
            &|_| File::open(&source),
        );
        assert!(matches!(
            result,
            Err(ArchiveTransferError::SourceChanged(_))
        ));
    }

    #[test]
    fn any_invalid_later_header_drops_previous_staged_writers() {
        use std::sync::{
            atomic::{AtomicUsize, Ordering},
            Arc,
        };
        struct Tracked(Arc<AtomicUsize>);
        impl Write for Tracked {
            fn write(&mut self, data: &[u8]) -> io::Result<usize> {
                Ok(data.len())
            }
            fn flush(&mut self) -> io::Result<()> {
                Ok(())
            }
        }
        impl Drop for Tracked {
            fn drop(&mut self) {
                self.0.fetch_add(1, Ordering::SeqCst);
            }
        }
        let drops = Arc::new(AtomicUsize::new(0));
        let expected = block(vec![item("a", "f0", 3), item("b", "f1", 3)]);
        let bytes = archive(&[("./a", b'0', b"abc", 42), ("./other", b'0', b"xyz", 42)]);
        let result = decode_archive(
            Cursor::new(bytes),
            &expected,
            &mut |_| Ok(Tracked(drops.clone())),
            &|| false,
        );
        assert!(matches!(
            result,
            Err(ArchiveTransferError::InvalidArchive(_))
        ));
        assert_eq!(drops.load(Ordering::SeqCst), 1);
    }

    fn pax_record(key: &str, value: &str) -> Vec<u8> {
        let body = format!("{key}={value}\n");
        let mut length = body.len() + 2;
        loop {
            let actual = length.to_string().len() + 1 + body.len();
            if actual == length {
                return format!("{length} {body}").into_bytes();
            }
            length = actual;
        }
    }

    #[test]
    fn accepts_bounded_pax_path_and_matching_mtime_but_rejects_size_override() {
        let expected = block(vec![item("nested/a", "f0", 3)]);
        let mut pax = pax_record("path", "./nested/a");
        pax.extend(pax_record("mtime", "42.123456"));
        let bytes = archive(&[
            ("PaxHeaders/a", b'x', &pax, 42),
            ("./placeholder", b'0', b"abc", 1),
        ]);
        assert!(parse(&bytes, &expected).is_ok());
        let sparse = pax_record("GNU.sparse.map", "0,3");
        let bytes = archive(&[
            ("PaxHeaders/a", b'x', &sparse, 42),
            ("./nested/a", b'0', b"abc", 42),
        ]);
        assert!(matches!(
            parse(&bytes, &expected),
            Err(ArchiveTransferError::InvalidArchive(_))
        ));
        let size = pax_record("size", "3");
        let bytes = archive(&[
            ("PaxHeaders/a", b'x', &size, 42),
            ("./nested/a", b'0', b"abc", 42),
        ]);
        assert!(matches!(
            parse(&bytes, &expected),
            Err(ArchiveTransferError::InvalidArchive(_))
        ));
    }

    #[test]
    fn decompression_limit_rejects_large_zero_tail_and_cancel_unblocks_channel() {
        let expected = block(vec![item("a", "f0", 3)]);
        let mut bytes = archive(&[("./a", b'0', b"abc", 42)]);
        bytes.resize(4 * 1024 * 1024 + 2048, 0);
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(&bytes).unwrap();
        let decoded = MultiGzDecoder::new(Cursor::new(encoder.finish().unwrap()));
        assert!(matches!(
            decode_archive(
                decoded,
                &expected,
                &mut |_| Ok(Cursor::new(Vec::new())),
                &|| false
            ),
            Err(ArchiveTransferError::InvalidArchive(_))
        ));
        let stopped = AtomicBool::new(true);
        let (sender, receiver) = mpsc::sync_channel(1);
        let mut writer = ChunkWriter {
            sender,
            stopped: &stopped,
            cancel: &|| false,
        };
        assert_eq!(
            writer.write(b"x").unwrap_err().kind(),
            io::ErrorKind::Interrupted
        );
        let mut reader = ChunkReader {
            receiver,
            current: Vec::new(),
            position: 0,
            stopped: &stopped,
            cancel: &|| false,
        };
        assert_eq!(
            reader.read(&mut [0]).unwrap_err().kind(),
            io::ErrorKind::Interrupted
        );
    }

    #[test]
    fn shell_paths_are_quoted_as_single_arguments() {
        assert_eq!(shell_quote("a'b;$(x)\n").unwrap(), "'a'\\''b;$(x)\n'");
        assert!(shell_quote("bad\0path").is_err());
    }

    #[test]
    fn policy_uses_file_count_average_and_strict_block_bounds() {
        let entries = (0..1025)
            .map(|n| item(&format!("file-{n}"), &format!("f{n}"), 1))
            .collect();
        let manifest = ArchiveManifest::new(entries).unwrap();
        assert!(should_use_archive(&manifest));
        assert_eq!(
            manifest
                .blocks()
                .iter()
                .map(|b| b.entries.len())
                .collect::<Vec<_>>(),
            vec![512, 512, 1]
        );
        let too_few = ArchiveManifest::new(
            (0..255)
                .map(|n| item(&format!("f{n}"), &format!("f{n}"), 0))
                .collect(),
        )
        .unwrap();
        assert!(!should_use_archive(&too_few));
        let large = ArchiveManifest::new(
            (0..256)
                .map(|n| item(&format!("f{n}"), &format!("f{n}"), 256 * 1024 + 1))
                .collect(),
        )
        .unwrap();
        assert!(!should_use_archive(&large));
        assert!(large
            .blocks()
            .iter()
            .all(|b| b.entries.iter().map(|e| e.size).sum::<u64>() <= MAX_BLOCK_BYTES));
    }

    #[test]
    fn manifest_rejects_unsafe_names_duplicates_and_unknown_stamps() {
        for bad in ["../outside", "/absolute", "a//b", "a/../b", "./a", "a\0b"] {
            assert!(
                ArchiveManifest::new(vec![item(bad, "f0", 0)]).is_err(),
                "{bad:?}"
            );
        }
        for bad in ["../f0", "a/b", "-f", "", "é"] {
            assert!(
                ArchiveManifest::new(vec![item("a", bad, 0)]).is_err(),
                "{bad:?}"
            );
        }
        assert!(ArchiveManifest::new(vec![item("a", "f0", 0), item("b", "f0", 0)]).is_err());
        assert!(ArchiveManifest::new(vec![item("a", "f0", MAX_BLOCK_BYTES + 1)]).is_err());
        let mut unknown = item("a", "f0", 1);
        unknown.stamp = SourceStamp::new(None, None);
        assert!(ArchiveManifest::new(vec![unknown]).is_err());
    }

    #[test]
    fn validates_normal_headers_and_stages_only_expected_contents() {
        let manifest = block(vec![item("a", "f0", 3), item("nested/b", "f1", 2)]);
        let data = archive(&[("./nested/b", b'0', b"xy", 42), ("./a", b'0', b"abc", 42)]);
        let staged = parse(&data, &manifest).unwrap();
        assert_eq!(staged.len(), 2);
        assert_eq!(staged[0].entry.internal_id, "f1");
        assert_eq!(staged[0].writer.get_ref(), b"xy");
        assert_eq!(staged[1].writer.get_ref(), b"abc");
    }

    #[test]
    fn rejects_unexpected_duplicate_missing_traversal_links_sparse_and_mismatch() {
        let manifest = block(vec![item("a", "f0", 3)]);
        let cases = [
            archive(&[("./other", b'0', b"abc", 42)]),
            archive(&[("./a", b'0', b"abc", 42), ("./a", b'0', b"abc", 42)]),
            archive(&[]),
            archive(&[("../a", b'0', b"abc", 42)]),
            archive(&[("./a", b'2', b"abc", 42)]),
            archive(&[("./a", b'1', b"abc", 42)]),
            archive(&[("./a", b'3', b"abc", 42)]),
            archive(&[("./a", b'S', b"abc", 42)]),
            archive(&[("./a", b'0', b"ab", 42)]),
            archive(&[("./a", b'0', b"abc", 43)]),
        ];
        for bytes in &cases {
            assert!(parse(bytes, &manifest).is_err());
        }
    }

    #[test]
    fn rejects_bad_checksum_truncation_and_nonzero_trailing_data() {
        let manifest = block(vec![item("a", "f0", 3)]);
        let mut bytes = archive(&[("./a", b'0', b"abc", 42)]);
        bytes[0] ^= 1;
        assert!(parse(&bytes, &manifest).is_err());
        let bytes = archive(&[("./a", b'0', b"abc", 42)]);
        assert!(parse(&bytes[..600], &manifest).is_err());
        let mut bytes = bytes;
        bytes.push(1);
        assert!(parse(&bytes, &manifest).is_err());
    }

    #[test]
    fn detects_pax_sparse_and_oversized_extensions() {
        let manifest = block(vec![item("a", "f0", 3)]);
        let pax = b"24 GNU.sparse.map=0,3\n";
        assert!(parse(
            &archive(&[("PaxHeaders/a", b'x', pax, 42), ("./a", b'0', b"abc", 42)]),
            &manifest
        )
        .is_err());
        let oversized = vec![b'x'; MAX_EXTENSION_BYTES + 1];
        assert!(parse(
            &archive(&[
                ("PaxHeaders/a", b'x', &oversized, 42),
                ("./a", b'0', b"abc", 42)
            ]),
            &manifest
        )
        .is_err());
    }

    #[test]
    fn handles_gnu_long_names_and_gzip_without_unpack() {
        let source = "n".repeat(120);
        let manifest = block(vec![item(&source, "f0", 3)]);
        let mut long_name = format!("./{source}").into_bytes();
        long_name.push(0);
        let bytes = archive(&[
            ("././@LongLink", b'L', &long_name, 42),
            ("./placeholder", b'0', b"abc", 42),
        ]);
        let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        gz.write_all(&bytes).unwrap();
        let compressed = gz.finish().unwrap();
        let decoder = flate2::read::MultiGzDecoder::new(Cursor::new(compressed));
        let staged = decode_archive(
            decoder,
            &manifest,
            &mut |_| Ok(Cursor::new(Vec::new())),
            &|| false,
        )
        .unwrap();
        assert_eq!(staged[0].writer.get_ref(), b"abc");
    }
}
