use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{BufReader, BufWriter, Read, Write};
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::thread;
use std::time::Duration;

use serde::Serialize;
use serde_json::json;
use ssh2::{ErrorCode, HashType, RenameFlags, Session, Sftp};
use tauri::{AppHandle, Emitter, State};
use thiserror::Error;

const DEFAULT_TIMEOUT_MS: u64 = 30_000;
const TRANSFER_BUFFER_SIZE: usize = 64 * 1024;
const KEEPALIVE_INTERVAL_SECS: u32 = 30;
const MAX_CONCURRENT_TRANSFERS: usize = 4;
const MAX_PREVIEW_BYTES: u64 = 5 * 1024 * 1024;

// Transport/SFTP codes from libssh2-sys. They are kept local to avoid adding
// a second direct dependency when ssh2 already supplies the raw values.
const LIBSSH2_ERROR_SOCKET_SEND: i32 = -7;
const LIBSSH2_ERROR_TIMEOUT: i32 = -9;
const LIBSSH2_ERROR_SOCKET_DISCONNECT: i32 = -13;
const LIBSSH2_ERROR_SOCKET_TIMEOUT: i32 = -30;
const LIBSSH2_ERROR_SOCKET_RECV: i32 = -43;
const LIBSSH2_ERROR_BAD_SOCKET: i32 = -45;
const LIBSSH2_ERROR_EAGAIN: i32 = -37;
const LIBSSH2_FX_NO_SUCH_FILE: i32 = 2;
const LIBSSH2_FX_NO_CONNECTION: i32 = 6;
const LIBSSH2_FX_CONNECTION_LOST: i32 = 7;
const LIBSSH2_FX_FAILURE: i32 = 4;
const LIBSSH2_FX_OP_UNSUPPORTED: i32 = 8;

#[derive(Error, Debug, Serialize)]
#[serde(tag = "code", content = "message")]
pub enum SshError {
    #[error("连接不存在或未连接")]
    ConnectionNotFound,
    #[error("无法连接到服务器: {0}")]
    ConnectionFailed(String),
    #[error("SSH 握手失败: {0}")]
    HandshakeFailed(String),
    #[error("认证失败: {0}")]
    AuthFailed(String),
    #[error("认证方式不支持: {0}")]
    UnsupportedAuth(String),
    #[error("认证失败")]
    AuthFailedUnknown,
    #[error("主机密钥需要确认: {0}")]
    HostKeyVerificationRequired(String),
    #[error("主机密钥不匹配，期望 {expected}，实际 {actual}")]
    HostKeyMismatch { expected: String, actual: String },
    #[error("读取输出失败: {0}")]
    ReadFailed(String),
    #[error("创建 SFTP 会话失败: {0}")]
    SftpFailed(String),
    #[error("文件操作失败: {0}")]
    FileOperationFailed(String),
    #[error("读取目录失败: {0}")]
    ReadDirFailed(String),
    #[error("传输任务数量已达到上限")]
    TransferLimitReached,
    #[error("传输已取消")]
    TransferCancelled,
    #[error("预览文件超过大小限制")]
    PreviewTooLarge,
}

impl From<std::io::Error> for SshError {
    fn from(error: std::io::Error) -> Self {
        SshError::FileOperationFailed(error.to_string())
    }
}

impl From<ssh2::Error> for SshError {
    fn from(error: ssh2::Error) -> Self {
        SshError::ConnectionFailed(error.to_string())
    }
}

#[derive(Clone, Default)]
pub struct SshState {
    pub connections: Arc<RwLock<HashMap<String, SshConnection>>>,
    pub connection_pool: Arc<RwLock<HashMap<String, Arc<Mutex<Session>>>>>,
    pub app_handle: Arc<Mutex<Option<AppHandle>>>,
    pub cancelled_transfers: Arc<Mutex<HashSet<String>>>,
    pub active_transfers: Arc<AtomicUsize>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshConnection {
    pub id: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_method: String,
    pub private_key_path: Option<String>,
    pub host_key_fingerprint: Option<String>,
    #[serde(skip_serializing)]
    pub password: String,
    #[serde(skip_serializing)]
    pub passphrase: Option<String>,
    pub connected: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostKeyInfo {
    pub fingerprint: String,
    pub algorithm: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectResult {
    pub connected: bool,
    pub requires_host_key_confirmation: bool,
    pub host_key: HostKeyInfo,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionTestResult {
    pub success: bool,
    pub requires_host_key_confirmation: bool,
    pub host_key: HostKeyInfo,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteEntry {
    pub name: String,
    pub path: String,
    #[serde(rename = "isDirectory")]
    pub is_directory: bool,
    pub kind: String,
    pub size: u64,
    pub modified_at: Option<u64>,
    pub permissions: Option<u32>,
}

struct FolderUploadFile {
    local_path: PathBuf,
    relative_path: PathBuf,
}

struct FolderUploadPlan {
    directories: Vec<PathBuf>,
    files: Vec<FolderUploadFile>,
    total_bytes: u64,
    skipped_entries: usize,
}

struct FolderDownloadFile {
    remote_path: String,
    relative_path: PathBuf,
}

struct FolderDownloadPlan {
    directories: Vec<PathBuf>,
    files: Vec<FolderDownloadFile>,
    total_bytes: u64,
    skipped_entries: usize,
}

struct RemoteDeleteTarget {
    path: PathBuf,
    display_path: String,
    is_directory: bool,
}

struct OpenSession {
    session: Session,
    host_key: HostKeyInfo,
}

fn connection_info(
    state: &SshState,
    id: &str,
    require_connected: bool,
) -> Result<SshConnection, SshError> {
    let connections = state.connections.read().unwrap();
    connections
        .get(id)
        .filter(|connection| !require_connected || connection.connected)
        .cloned()
        .ok_or(SshError::ConnectionNotFound)
}

fn base64_encode(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut output = String::with_capacity((bytes.len() + 2) / 3 * 4);
    let mut index = 0;
    while index < bytes.len() {
        let first = bytes[index] as u32;
        let second = bytes.get(index + 1).copied().unwrap_or(0) as u32;
        let third = bytes.get(index + 2).copied().unwrap_or(0) as u32;
        let chunk = (first << 16) | (second << 8) | third;
        output.push(TABLE[((chunk >> 18) & 0x3f) as usize] as char);
        output.push(TABLE[((chunk >> 12) & 0x3f) as usize] as char);
        output.push(if index + 1 < bytes.len() {
            TABLE[((chunk >> 6) & 0x3f) as usize] as char
        } else {
            '='
        });
        output.push(if index + 2 < bytes.len() {
            TABLE[(chunk & 0x3f) as usize] as char
        } else {
            '='
        });
        index += 3;
    }
    output.trim_end_matches('=').to_string()
}

fn host_key_info(session: &Session) -> Result<HostKeyInfo, SshError> {
    let fingerprint = session
        .host_key_hash(HashType::Sha256)
        .ok_or_else(|| SshError::HandshakeFailed("服务器未提供主机密钥".to_string()))?
        .to_vec();
    let algorithm = session
        .host_key()
        .map(|(_, key_type)| format!("{key_type:?}"))
        .unwrap_or_else(|| "unknown".to_string());

    Ok(HostKeyInfo {
        fingerprint: format!("SHA256:{}", base64_encode(&fingerprint)),
        algorithm,
    })
}

fn connect_tcp(host: &str, port: u16, timeout: Duration) -> Result<TcpStream, SshError> {
    let target = if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    };
    let addresses: Vec<SocketAddr> = target
        .to_socket_addrs()
        .map_err(|error| SshError::ConnectionFailed(format!("解析服务器地址失败: {error}")))?
        .collect();
    if addresses.is_empty() {
        return Err(SshError::ConnectionFailed(
            "服务器地址无可用解析结果".to_string(),
        ));
    }

    let mut last_error = None;
    for address in addresses {
        match TcpStream::connect_timeout(&address, timeout) {
            Ok(stream) => {
                stream
                    .set_read_timeout(Some(timeout))
                    .map_err(|error| SshError::ConnectionFailed(error.to_string()))?;
                stream
                    .set_write_timeout(Some(timeout))
                    .map_err(|error| SshError::ConnectionFailed(error.to_string()))?;
                return Ok(stream);
            }
            Err(error) => last_error = Some(error),
        }
    }
    Err(SshError::ConnectionFailed(
        last_error
            .map(|error| error.to_string())
            .unwrap_or_else(|| "连接服务器失败".to_string()),
    ))
}

fn open_session_with_timeout(
    connection: &SshConnection,
    timeout: Duration,
) -> Result<OpenSession, SshError> {
    let tcp = connect_tcp(&connection.host, connection.port, timeout)?;
    let mut session =
        Session::new().map_err(|error| SshError::ConnectionFailed(error.to_string()))?;
    session.set_tcp_stream(tcp);
    session
        .handshake()
        .map_err(|error| SshError::HandshakeFailed(error.to_string()))?;
    session.set_keepalive(true, KEEPALIVE_INTERVAL_SECS);
    let host_key = host_key_info(&session)?;
    Ok(OpenSession { session, host_key })
}

fn open_session(connection: &SshConnection) -> Result<OpenSession, SshError> {
    open_session_with_timeout(connection, Duration::from_millis(DEFAULT_TIMEOUT_MS))
}

fn validate_connection(connection: &SshConnection) -> Result<(), SshError> {
    if connection.host.trim().is_empty() {
        return Err(SshError::ConnectionFailed("主机地址不能为空".to_string()));
    }
    if connection.username.trim().is_empty() {
        return Err(SshError::AuthFailed("用户名不能为空".to_string()));
    }
    if connection.port == 0 {
        return Err(SshError::ConnectionFailed(
            "端口必须在 1-65535 范围内".to_string(),
        ));
    }
    match connection.auth_method.as_str() {
        "password" | "agent" => Ok(()),
        "key"
            if connection
                .private_key_path
                .as_deref()
                .is_some_and(|path| !path.trim().is_empty()) =>
        {
            Ok(())
        }
        "key" => Err(SshError::UnsupportedAuth("未提供私钥路径".to_string())),
        method => Err(SshError::UnsupportedAuth(method.to_string())),
    }
}

fn verify_host_key(connection: &SshConnection, host_key: &HostKeyInfo) -> Result<(), SshError> {
    match connection.host_key_fingerprint.as_deref() {
        None | Some("") => Err(SshError::HostKeyVerificationRequired(
            host_key.fingerprint.clone(),
        )),
        Some(expected) if expected.eq_ignore_ascii_case(&host_key.fingerprint) => Ok(()),
        Some(expected) => Err(SshError::HostKeyMismatch {
            expected: expected.to_string(),
            actual: host_key.fingerprint.clone(),
        }),
    }
}

fn authenticate(session: &Session, connection: &SshConnection) -> Result<(), SshError> {
    let result = match connection.auth_method.as_str() {
        "agent" => session.userauth_agent(&connection.username),
        "key" => {
            let path = connection
                .private_key_path
                .as_deref()
                .ok_or_else(|| SshError::UnsupportedAuth("未提供私钥路径".to_string()))?;
            session.userauth_pubkey_file(
                &connection.username,
                None,
                Path::new(path),
                connection.passphrase.as_deref(),
            )
        }
        "password" | "" => session.userauth_password(&connection.username, &connection.password),
        method => return Err(SshError::UnsupportedAuth(method.to_string())),
    };

    result.map_err(|error| SshError::AuthFailed(error.to_string()))?;
    if session.authenticated() {
        Ok(())
    } else {
        Err(SshError::AuthFailedUnknown)
    }
}

fn emit_event(
    state_handle: &Arc<Mutex<Option<AppHandle>>>,
    event: &str,
    payload: serde_json::Value,
) {
    let app_handle = state_handle.lock().unwrap();
    if let Some(handle) = app_handle.as_ref() {
        let _ = handle.emit(event, payload);
    }
}

// libssh2 exposes transport failures through numeric error codes. Keep the
// list deliberately narrow so file/path/permission errors remain recoverable
// without throwing the user back to the connection list.
fn is_connection_loss(error: &ssh2::Error) -> bool {
    match error.code() {
        ErrorCode::Session(code) => matches!(
            code,
            LIBSSH2_ERROR_SOCKET_SEND
                | LIBSSH2_ERROR_TIMEOUT
                | LIBSSH2_ERROR_SOCKET_DISCONNECT
                | LIBSSH2_ERROR_SOCKET_TIMEOUT
                | LIBSSH2_ERROR_SOCKET_RECV
                | LIBSSH2_ERROR_BAD_SOCKET
        ),
        ErrorCode::SFTP(code) => {
            matches!(code, LIBSSH2_FX_NO_CONNECTION | LIBSSH2_FX_CONNECTION_LOST)
        }
    }
}

fn is_io_connection_loss(error: &std::io::Error) -> bool {
    let transport_kind = matches!(
        error.kind(),
        std::io::ErrorKind::BrokenPipe
            | std::io::ErrorKind::ConnectionAborted
            | std::io::ErrorKind::ConnectionReset
            | std::io::ErrorKind::NotConnected
            | std::io::ErrorKind::TimedOut
            | std::io::ErrorKind::UnexpectedEof
    );
    let message = error.to_string().to_ascii_lowercase();
    transport_kind
        || message.contains("socket")
        || message.contains("connection lost")
        || message.contains("connection disconnected")
        || message.contains("sftp(6)")
        || message.contains("sftp(7)")
}

fn mark_connection_disconnected(state: &SshState, id: &str, reason: String) {
    let was_connected = state
        .connections
        .write()
        .unwrap()
        .get_mut(id)
        .map(|connection| {
            let was_connected = connection.connected;
            connection.connected = false;
            was_connected
        })
        .unwrap_or(false);

    // Dropping the cached session closes the broken transport. Active
    // transfer tasks may still hold their own Arc until they finish.
    state.connection_pool.write().unwrap().remove(id);
    if was_connected {
        emit_event(
            &state.app_handle,
            "ssh-disconnected",
            json!({ "id": id, "reason": reason }),
        );
    }
}

fn mark_ssh_error_if_connection_lost(state: &SshState, id: &str, error: &ssh2::Error) {
    if is_connection_loss(error) {
        mark_connection_disconnected(state, id, error.to_string());
    }
}

fn mark_io_error_if_connection_lost(state: &SshState, id: &str, error: &std::io::Error) {
    if is_io_connection_loss(error) {
        mark_connection_disconnected(state, id, error.to_string());
    }
}

fn is_rename_compatibility_error(error: &ssh2::Error) -> bool {
    matches!(
        error.code(),
        ErrorCode::SFTP(LIBSSH2_FX_FAILURE | LIBSSH2_FX_OP_UNSUPPORTED)
    )
}

fn is_sftp_missing_path(error: &ssh2::Error) -> bool {
    matches!(error.code(), ErrorCode::SFTP(LIBSSH2_FX_NO_SUCH_FILE))
}

fn join_remote_path(base_path: &str, relative_path: &Path) -> Result<String, SshError> {
    let mut remote_path = base_path.trim_end_matches('/').to_string();
    if remote_path.is_empty() {
        remote_path.push('/');
    }

    for component in relative_path.components() {
        let Component::Normal(segment) = component else {
            if matches!(component, Component::CurDir) {
                continue;
            }
            return Err(SshError::FileOperationFailed(
                "本地目录包含不安全的相对路径".to_string(),
            ));
        };
        let segment = segment.to_str().ok_or_else(|| {
            SshError::FileOperationFailed("本地文件名不是有效的 UTF-8 文本".to_string())
        })?;

        if remote_path != "/" {
            remote_path.push('/');
        }
        remote_path.push_str(segment);
    }
    Ok(remote_path)
}

fn display_relative_path(relative_path: &Path) -> String {
    relative_path
        .components()
        .filter_map(|component| match component {
            Component::Normal(segment) => Some(segment.to_string_lossy().to_string()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/")
}

fn collect_folder_upload_plan(local_root: &Path) -> Result<FolderUploadPlan, SshError> {
    let root_metadata = fs::symlink_metadata(local_root)
        .map_err(|error| SshError::FileOperationFailed(format!("无法读取本地文件夹: {error}")))?;
    if root_metadata.file_type().is_symlink() || !root_metadata.is_dir() {
        return Err(SshError::FileOperationFailed(
            "请选择一个普通本地文件夹，符号链接不支持直接上传".to_string(),
        ));
    }

    let mut plan = FolderUploadPlan {
        directories: Vec::new(),
        files: Vec::new(),
        total_bytes: 0,
        skipped_entries: 0,
    };
    let mut pending_directories = vec![local_root.to_path_buf()];

    while let Some(directory) = pending_directories.pop() {
        let mut entries = fs::read_dir(&directory)
            .map_err(|error| {
                SshError::FileOperationFailed(format!(
                    "无法读取本地文件夹“{}”: {error}",
                    directory.display()
                ))
            })?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| {
                SshError::FileOperationFailed(format!(
                    "无法读取本地文件夹“{}”: {error}",
                    directory.display()
                ))
            })?;
        entries.sort_by_key(|entry| entry.file_name());

        for entry in entries {
            let local_path = entry.path();
            let relative_path = local_path
                .strip_prefix(local_root)
                .map_err(|error| {
                    SshError::FileOperationFailed(format!("无法计算本地相对路径: {error}"))
                })?
                .to_path_buf();
            let metadata = fs::symlink_metadata(&local_path).map_err(|error| {
                SshError::FileOperationFailed(format!(
                    "无法读取本地文件“{}”: {error}",
                    local_path.display()
                ))
            })?;

            if metadata.file_type().is_symlink() {
                plan.skipped_entries += 1;
            } else if metadata.is_dir() {
                plan.directories.push(relative_path);
                pending_directories.push(local_path);
            } else if metadata.is_file() {
                let size = metadata.len();
                plan.total_bytes = plan.total_bytes.saturating_add(size);
                plan.files.push(FolderUploadFile {
                    local_path,
                    relative_path,
                });
            } else {
                plan.skipped_entries += 1;
            }
        }
    }

    plan.directories.sort_by(|left, right| {
        left.components()
            .count()
            .cmp(&right.components().count())
            .then_with(|| left.cmp(right))
    });
    plan.files
        .sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
    Ok(plan)
}

fn join_remote_child_path(base_path: &str, name: &str) -> Result<String, SshError> {
    if name.is_empty() || name == "." || name == ".." || name.contains('/') || name.contains('\\') {
        return Err(SshError::FileOperationFailed(
            "远程目录包含不安全的项目名称".to_string(),
        ));
    }
    let mut components = Path::new(name).components();
    if !matches!(components.next(), Some(Component::Normal(_))) || components.next().is_some() {
        return Err(SshError::FileOperationFailed(
            "远程目录包含不安全的项目名称".to_string(),
        ));
    }

    // SFTP paths always use slash separators, even when the local desktop is
    // running on Windows. Normalizing here keeps recursive downloads
    // independent from the host platform's Path separator.
    let mut remote_path = base_path.replace('\\', "/");
    while remote_path.len() > 1 && remote_path.ends_with('/') {
        remote_path.pop();
    }
    if remote_path.is_empty() {
        remote_path.push('/');
    }
    if remote_path != "/" {
        remote_path.push('/');
    }
    remote_path.push_str(name);
    Ok(remote_path)
}

fn collect_folder_download_plan(
    state: &SshState,
    connection_id: &str,
    sftp: &Sftp,
    remote_path: &str,
    transfer_id: &str,
) -> Result<FolderDownloadPlan, SshError> {
    let normalized_root = remote_path.replace('\\', "/");
    let root_stat = sftp.lstat(Path::new(&normalized_root)).map_err(|error| {
        mark_ssh_error_if_connection_lost(state, connection_id, &error);
        SshError::FileOperationFailed(format!("无法读取远程文件夹“{remote_path}”: {error}"))
    })?;
    if root_stat.file_type() == ssh2::FileType::Symlink || !root_stat.is_dir() {
        return Err(SshError::FileOperationFailed(
            "远程路径不是可下载的文件夹".to_string(),
        ));
    }

    let mut plan = FolderDownloadPlan {
        directories: Vec::new(),
        files: Vec::new(),
        total_bytes: 0,
        skipped_entries: 0,
    };
    let mut pending = vec![(normalized_root, PathBuf::new())];

    while let Some((directory, relative_directory)) = pending.pop() {
        if is_cancelled(&state.cancelled_transfers, transfer_id) {
            return Err(SshError::TransferCancelled);
        }
        let entries = sftp.readdir(Path::new(&directory)).map_err(|error| {
            mark_ssh_error_if_connection_lost(state, connection_id, &error);
            SshError::FileOperationFailed(format!("读取远程文件夹“{directory}”失败: {error}"))
        })?;

        for (listed_path, _) in entries {
            if is_cancelled(&state.cancelled_transfers, transfer_id) {
                return Err(SshError::TransferCancelled);
            }
            let Some(name) = listed_path.file_name().and_then(|value| value.to_str()) else {
                plan.skipped_entries = plan.skipped_entries.saturating_add(1);
                continue;
            };
            if name == "." || name == ".." {
                continue;
            }
            let child_remote_path = match join_remote_child_path(&directory, name) {
                Ok(path) => path,
                Err(_) => {
                    plan.skipped_entries = plan.skipped_entries.saturating_add(1);
                    continue;
                }
            };
            let child_stat = match sftp.lstat(Path::new(&child_remote_path)) {
                Ok(stat) => stat,
                Err(error) if is_sftp_missing_path(&error) => {
                    plan.skipped_entries = plan.skipped_entries.saturating_add(1);
                    continue;
                }
                Err(error) => {
                    mark_ssh_error_if_connection_lost(state, connection_id, &error);
                    return Err(SshError::FileOperationFailed(format!(
                        "无法读取远程项目“{child_remote_path}”: {error}"
                    )));
                }
            };
            if child_stat.file_type() == ssh2::FileType::Symlink {
                // Never follow a remote link while creating local paths. This
                // also keeps the plan safe if a link points outside the tree.
                plan.skipped_entries = plan.skipped_entries.saturating_add(1);
                continue;
            }

            let relative_path = relative_directory.join(name);
            if child_stat.is_dir() {
                plan.directories.push(relative_path.clone());
                pending.push((child_remote_path, relative_path));
            } else if child_stat.is_file() {
                let size = child_stat.size.unwrap_or(0);
                plan.total_bytes = plan.total_bytes.saturating_add(size);
                plan.files.push(FolderDownloadFile {
                    remote_path: child_remote_path,
                    relative_path,
                });
            } else {
                plan.skipped_entries = plan.skipped_entries.saturating_add(1);
            }
        }
    }

    plan.directories.sort_by(|left, right| {
        left.components()
            .count()
            .cmp(&right.components().count())
            .then_with(|| left.cmp(right))
    });
    plan.files
        .sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
    Ok(plan)
}

fn rename_remote_file(
    sftp: &Sftp,
    source_path: &Path,
    target_path: &Path,
    overwrite: bool,
) -> Result<(), ssh2::Error> {
    let preferred_flags = if overwrite {
        RenameFlags::ATOMIC | RenameFlags::OVERWRITE | RenameFlags::NATIVE
    } else {
        RenameFlags::ATOMIC | RenameFlags::NATIVE
    };

    match sftp.rename(source_path, target_path, Some(preferred_flags)) {
        Ok(()) => Ok(()),
        Err(error) if !is_rename_compatibility_error(&error) => Err(error),
        // Some SFTP servers reject ATOMIC/NATIVE even though they support a
        // regular overwrite rename. Retry with only the required flag first.
        Err(error) if !overwrite => sftp
            .rename(source_path, target_path, Some(RenameFlags::empty()))
            .map_err(|fallback_error| {
                if is_rename_compatibility_error(&fallback_error) {
                    error
                } else {
                    fallback_error
                }
            }),
        Err(error) => match sftp.rename(source_path, target_path, Some(RenameFlags::OVERWRITE)) {
            Ok(()) => Ok(()),
            Err(fallback_error) if !is_rename_compatibility_error(&fallback_error) => {
                Err(fallback_error)
            }
            Err(fallback_error) => {
                if sftp
                    .stat(target_path)
                    .map(|stat| stat.is_dir())
                    .unwrap_or(true)
                {
                    return Err(fallback_error);
                }
                // Older servers sometimes cannot overwrite through rename at
                // all. This final fallback is only used after explicit
                // overwrite semantics were requested for a non-directory.
                sftp.unlink(target_path)
                    .and_then(|_| sftp.rename(source_path, target_path, Some(RenameFlags::empty())))
                    .map_err(|fallback_error| {
                        if is_rename_compatibility_error(&fallback_error) {
                            error
                        } else {
                            fallback_error
                        }
                    })
            }
        },
    }
}

fn session_for(state: &SshState, id: &str) -> Result<Arc<Mutex<Session>>, SshError> {
    let _ = connection_info(state, id, true)?;
    state
        .connection_pool
        .read()
        .unwrap()
        .get(id)
        .cloned()
        .ok_or(SshError::ConnectionNotFound)
}

fn sftp_for(state: &SshState, id: &str) -> Result<Sftp, SshError> {
    let session = session_for(state, id)?;
    let session = session
        .lock()
        .map_err(|_| SshError::SftpFailed("会话锁已损坏".to_string()))?;
    session.sftp().map_err(|error| {
        mark_ssh_error_if_connection_lost(state, id, &error);
        SshError::SftpFailed(error.to_string())
    })
}

fn remote_delete_display_path(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().to_string())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| path.to_string_lossy().to_string())
}

fn collect_remote_delete_plan(
    state: &SshState,
    connection_id: &str,
    sftp: &Sftp,
    remote_path: &Path,
) -> Result<Vec<RemoteDeleteTarget>, SshError> {
    // Build the plan with lstat so a symbolic link to a directory is deleted
    // as a link and never followed outside the user-selected tree.
    let mut pending = vec![(
        remote_path.to_path_buf(),
        remote_delete_display_path(remote_path),
    )];
    let mut files = Vec::new();
    let mut directories = Vec::new();

    while let Some((path, display_path)) = pending.pop() {
        let stat = match sftp.lstat(&path) {
            Ok(stat) => stat,
            // A concurrent client may have already removed an entry. It does
            // not need to be part of the plan because the desired end state
            // has already been reached.
            Err(error) if is_sftp_missing_path(&error) => continue,
            Err(error) => {
                mark_ssh_error_if_connection_lost(state, connection_id, &error);
                return Err(SshError::FileOperationFailed(format!(
                    "无法读取远程项目“{}”: {error}",
                    path.display()
                )));
            }
        };

        if !stat.is_dir() {
            files.push(RemoteDeleteTarget {
                path,
                display_path,
                is_directory: false,
            });
            continue;
        }

        directories.push(RemoteDeleteTarget {
            path: path.clone(),
            display_path: display_path.clone(),
            is_directory: true,
        });
        let entries = sftp.readdir(&path).map_err(|error| {
            mark_ssh_error_if_connection_lost(state, connection_id, &error);
            SshError::FileOperationFailed(format!(
                "读取远程文件夹“{}”失败: {error}",
                path.display()
            ))
        })?;

        for (listed_path, _) in entries {
            let name = listed_path.file_name().ok_or_else(|| {
                SshError::FileOperationFailed(format!(
                    "无法识别远程文件夹“{}”中的项目名称",
                    path.display()
                ))
            })?;
            if name == "." || name == ".." {
                continue;
            }
            let child_name = name.to_string_lossy();
            pending.push((path.join(name), format!("{display_path}/{child_name}")));
        }
    }

    // Parents are visited before descendants. Reverse the directory portion
    // so every directory is removed only after its contents are gone.
    directories.reverse();
    files.extend(directories);
    Ok(files)
}

fn delete_progress(
    state: &SshState,
    connection_id: &str,
    operation_id: Option<&str>,
    file_name: &str,
    item_index: usize,
    item_total: usize,
    phase: &str,
) {
    let Some(operation_id) = operation_id else {
        return;
    };
    let progress = if phase == "cleaning" {
        100
    } else if item_total == 0 {
        0
    } else {
        (((item_index.saturating_add(1)).saturating_mul(100)) / item_total).min(100)
    };
    emit_event(
        &state.app_handle,
        "delete-progress",
        json!({
            "id": connection_id,
            "operationId": operation_id,
            "progress": progress,
            "fileName": file_name,
            "itemIndex": item_index,
            "itemTotal": item_total,
            "phase": phase
        }),
    );
}

fn delete_remote_path(
    state: &SshState,
    connection_id: &str,
    sftp: &Sftp,
    remote_path: &Path,
    operation_id: Option<&str>,
) -> Result<(), SshError> {
    let root_name = remote_delete_display_path(remote_path);
    delete_progress(
        state,
        connection_id,
        operation_id,
        &root_name,
        0,
        0,
        "scanning",
    );
    let plan = collect_remote_delete_plan(state, connection_id, sftp, remote_path)?;
    let file_total = plan.iter().filter(|target| !target.is_directory).count();
    let mut file_index = 0usize;
    let mut cleaning_started = false;

    for target in plan.iter() {
        if target.is_directory && !cleaning_started {
            delete_progress(
                state,
                connection_id,
                operation_id,
                &target.display_path,
                file_index,
                file_total,
                "cleaning",
            );
            cleaning_started = true;
        }
        let result = if target.is_directory {
            sftp.rmdir(&target.path)
        } else {
            sftp.unlink(&target.path)
        };
        if let Err(error) = result {
            if is_sftp_missing_path(&error) {
                if !target.is_directory {
                    delete_progress(
                        state,
                        connection_id,
                        operation_id,
                        &target.display_path,
                        file_index,
                        file_total,
                        "deleting",
                    );
                    file_index = file_index.saturating_add(1);
                }
                continue;
            }
            mark_ssh_error_if_connection_lost(state, connection_id, &error);
            let action = if target.is_directory {
                "删除远程文件夹"
            } else {
                "删除远程项目"
            };
            return Err(SshError::FileOperationFailed(format!(
                "{action}“{}”失败: {error}",
                target.path.display()
            )));
        }
        if !target.is_directory {
            delete_progress(
                state,
                connection_id,
                operation_id,
                &target.display_path,
                file_index,
                file_total,
                "deleting",
            );
            file_index = file_index.saturating_add(1);
        }
    }
    Ok(())
}

fn run_delete(
    state: &SshState,
    session: &Arc<Mutex<Session>>,
    connection_id: &str,
    remote_path: &str,
    operation_id: &str,
) -> Result<(), SshError> {
    let session = session
        .lock()
        .map_err(|_| SshError::SftpFailed("会话锁已损坏".to_string()))?;
    let sftp = session.sftp().map_err(|error| {
        mark_ssh_error_if_connection_lost(state, connection_id, &error);
        SshError::SftpFailed(error.to_string())
    })?;
    drop(session);

    delete_remote_path(
        state,
        connection_id,
        &sftp,
        Path::new(remote_path),
        Some(operation_id),
    )
}

fn ensure_remote_directory(
    state: &SshState,
    connection_id: &str,
    sftp: &Sftp,
    remote_path: &str,
    allow_existing: bool,
) -> Result<(), SshError> {
    match sftp.stat(Path::new(remote_path)) {
        Ok(stat) if stat.is_dir() && allow_existing => Ok(()),
        Ok(stat) if stat.is_dir() => Err(SshError::FileOperationFailed(format!(
            "远程文件夹已存在: {remote_path}"
        ))),
        Ok(_) => Err(SshError::FileOperationFailed(format!(
            "远程路径存在同名文件: {remote_path}"
        ))),
        Err(error) if is_sftp_missing_path(&error) => {
            match sftp.mkdir(Path::new(remote_path), 0o755) {
                Ok(()) => Ok(()),
                Err(mkdir_error) => match sftp.stat(Path::new(remote_path)) {
                    // Another client may have created the directory between stat
                    // and mkdir. A confirmed merge can safely continue.
                    Ok(stat) if stat.is_dir() && allow_existing => Ok(()),
                    Ok(stat) if stat.is_dir() => Err(SshError::FileOperationFailed(format!(
                        "远程文件夹已存在: {remote_path}"
                    ))),
                    Ok(_) => Err(SshError::FileOperationFailed(format!(
                        "远程路径存在同名文件: {remote_path}"
                    ))),
                    Err(stat_error) => {
                        mark_ssh_error_if_connection_lost(state, connection_id, &mkdir_error);
                        mark_ssh_error_if_connection_lost(state, connection_id, &stat_error);
                        Err(SshError::FileOperationFailed(mkdir_error.to_string()))
                    }
                },
            }
        }
        Err(error) => {
            mark_ssh_error_if_connection_lost(state, connection_id, &error);
            Err(SshError::FileOperationFailed(error.to_string()))
        }
    }
}

fn transfer_slot(state: &SshState) -> Result<(), SshError> {
    loop {
        let current = state.active_transfers.load(Ordering::Acquire);
        if current >= MAX_CONCURRENT_TRANSFERS {
            return Err(SshError::TransferLimitReached);
        }
        if state
            .active_transfers
            .compare_exchange(current, current + 1, Ordering::AcqRel, Ordering::Relaxed)
            .is_ok()
        {
            return Ok(());
        }
    }
}

fn is_cancelled(cancelled: &Arc<Mutex<HashSet<String>>>, transfer_id: &str) -> bool {
    cancelled.lock().unwrap().contains(transfer_id)
}

fn finish_transfer(state: &SshState, transfer_id: &str) {
    state
        .cancelled_transfers
        .lock()
        .unwrap()
        .remove(transfer_id);
    state.active_transfers.fetch_sub(1, Ordering::AcqRel);
}

#[tauri::command]
pub fn test_sftp_connection(
    host: String,
    port: u16,
    username: String,
    password: String,
    auth_method: Option<String>,
    private_key_path: Option<String>,
    passphrase: Option<String>,
    timeout: Option<u64>,
    host_key_fingerprint: Option<String>,
) -> Result<ConnectionTestResult, SshError> {
    let connection = SshConnection {
        id: "test".to_string(),
        host,
        port,
        username,
        auth_method: auth_method.unwrap_or_else(|| "password".to_string()),
        private_key_path,
        host_key_fingerprint,
        password,
        passphrase,
        connected: false,
    };

    validate_connection(&connection)?;
    let opened = open_session_with_timeout(
        &connection,
        Duration::from_millis(timeout.unwrap_or(DEFAULT_TIMEOUT_MS).clamp(1_000, 120_000)),
    )?;
    if connection.host_key_fingerprint.is_none() {
        return Ok(ConnectionTestResult {
            success: false,
            requires_host_key_confirmation: true,
            host_key: opened.host_key,
        });
    }
    verify_host_key(&connection, &opened.host_key)?;
    authenticate(&opened.session, &connection)?;
    opened
        .session
        .sftp()
        .map_err(|error| SshError::SftpFailed(error.to_string()))?;
    Ok(ConnectionTestResult {
        success: true,
        requires_host_key_confirmation: false,
        host_key: opened.host_key,
    })
}

#[tauri::command]
pub fn add_ssh_connection(
    state: State<SshState>,
    id: String,
    host: String,
    port: u16,
    username: String,
    password: String,
    auth_method: Option<String>,
    private_key_path: Option<String>,
    passphrase: Option<String>,
    host_key_fingerprint: Option<String>,
) -> Result<String, SshError> {
    let connection = SshConnection {
        id: id.clone(),
        host,
        port,
        username,
        auth_method: auth_method.unwrap_or_else(|| "password".to_string()),
        private_key_path,
        host_key_fingerprint,
        password,
        passphrase,
        connected: false,
    };

    validate_connection(&connection)?;
    remove_cached_session(&state, &id);
    state
        .connections
        .write()
        .unwrap()
        .insert(id.clone(), connection);
    Ok(id)
}

#[tauri::command]
pub fn set_ssh_host_key(
    state: State<SshState>,
    id: String,
    fingerprint: String,
) -> Result<bool, SshError> {
    if fingerprint.trim().is_empty() {
        return Err(SshError::HandshakeFailed("主机指纹不能为空".to_string()));
    }
    let mut connections = state.connections.write().unwrap();
    let connection = connections
        .get_mut(&id)
        .ok_or(SshError::ConnectionNotFound)?;
    connection.host_key_fingerprint = Some(fingerprint);
    Ok(true)
}

#[tauri::command]
pub fn list_ssh_connections(state: State<SshState>) -> Result<Vec<SshConnection>, SshError> {
    Ok(state
        .connections
        .read()
        .unwrap()
        .values()
        .cloned()
        .collect())
}

#[tauri::command]
pub fn connect_ssh(state: State<SshState>, id: String) -> Result<ConnectResult, SshError> {
    let connection = connection_info(&state, &id, false)?;
    validate_connection(&connection)?;
    remove_cached_session(&state, &id);
    if let Some(item) = state.connections.write().unwrap().get_mut(&id) {
        item.connected = false;
    }
    let opened = open_session(&connection)?;
    if connection.host_key_fingerprint.is_none() {
        return Ok(ConnectResult {
            connected: false,
            requires_host_key_confirmation: true,
            host_key: opened.host_key,
        });
    }
    verify_host_key(&connection, &opened.host_key)?;
    authenticate(&opened.session, &connection)?;

    state
        .connection_pool
        .write()
        .unwrap()
        .insert(id.clone(), Arc::new(Mutex::new(opened.session)));
    if let Some(item) = state.connections.write().unwrap().get_mut(&id) {
        item.connected = true;
    }

    Ok(ConnectResult {
        connected: true,
        requires_host_key_confirmation: false,
        host_key: opened.host_key,
    })
}

fn remove_cached_session(state: &SshState, id: &str) {
    if let Some(session) = state.connection_pool.write().unwrap().remove(id) {
        if let Ok(session) = session.lock() {
            let _ = session.disconnect(None, "客户端关闭连接", None);
        }
    }
}

#[tauri::command]
pub fn disconnect_ssh(state: State<SshState>, id: String) -> Result<bool, SshError> {
    let _ = connection_info(&state, &id, false)?;
    remove_cached_session(&state, &id);
    if let Some(connection) = state.connections.write().unwrap().get_mut(&id) {
        connection.connected = false;
    }
    Ok(true)
}

#[tauri::command]
pub fn check_ssh_connection(state: State<SshState>, id: String) -> Result<bool, SshError> {
    let session = session_for(&state, &id)?;
    let result = session
        .lock()
        .map_err(|_| SshError::ConnectionFailed("会话锁已损坏".to_string()))?
        .keepalive_send();

    match result {
        Ok(_) => Ok(true),
        // A non-blocking keepalive can temporarily report EAGAIN. The next
        // probe will retry; it is not evidence that the SSH connection died.
        Err(error) if matches!(error.code(), ErrorCode::Session(LIBSSH2_ERROR_EAGAIN)) => Ok(true),
        Err(error) => {
            let message = error.to_string();
            if is_connection_loss(&error) {
                mark_connection_disconnected(&state, &id, message.clone());
            }
            Err(SshError::ConnectionFailed(message))
        }
    }
}

#[tauri::command]
pub fn remove_ssh_connection(state: State<SshState>, id: String) -> Result<bool, SshError> {
    remove_cached_session(&state, &id);
    Ok(state.connections.write().unwrap().remove(&id).is_some())
}

#[tauri::command]
pub fn list_sftp_directory(
    state: State<SshState>,
    id: String,
    remote_path: String,
) -> Result<Vec<RemoteEntry>, SshError> {
    let sftp = sftp_for(&state, &id)?;
    let entries = sftp.readdir(Path::new(&remote_path)).map_err(|error| {
        mark_ssh_error_if_connection_lost(&state, &id, &error);
        SshError::ReadDirFailed(error.to_string())
    })?;

    let mut files = Vec::with_capacity(entries.len());
    for (path, stat) in entries {
        let name = path
            .file_name()
            .map(|value| value.to_string_lossy().to_string())
            .unwrap_or_default();
        if name == "." || name == ".." {
            continue;
        }
        let kind = if stat.is_dir() {
            "directory"
        } else if stat.file_type() == ssh2::FileType::Symlink {
            "symlink"
        } else if stat.is_file() {
            "file"
        } else {
            "other"
        };
        files.push(RemoteEntry {
            name,
            path: path.to_string_lossy().to_string(),
            is_directory: stat.is_dir(),
            kind: kind.to_string(),
            size: stat.size.unwrap_or(0),
            modified_at: stat.mtime,
            permissions: stat.perm,
        });
    }
    Ok(files)
}

fn preview_progress(
    state: &SshState,
    connection_id: &str,
    preview_id: Option<&str>,
    current: u64,
    total: u64,
) {
    let Some(preview_id) = preview_id else {
        return;
    };
    let progress = if total == 0 {
        100
    } else {
        ((current.saturating_mul(100)) / total).min(100)
    };
    emit_event(
        &state.app_handle,
        "preview-progress",
        json!({
            "id": connection_id,
            "previewId": preview_id,
            "progress": progress,
            "current": current,
            "total": total
        }),
    );
}

fn read_sftp_file_content(
    state: &SshState,
    id: String,
    remote_path: String,
    preview_id: Option<String>,
) -> Result<Vec<u8>, SshError> {
    let sftp = sftp_for(state, &id)?;
    let mut file = sftp.open(Path::new(&remote_path)).map_err(|error| {
        mark_ssh_error_if_connection_lost(state, &id, &error);
        SshError::FileOperationFailed(error.to_string())
    })?;
    let size = file
        .stat()
        .map_err(|error| {
            mark_ssh_error_if_connection_lost(state, &id, &error);
            SshError::FileOperationFailed(error.to_string())
        })?
        .size
        .unwrap_or(0);
    if size > MAX_PREVIEW_BYTES {
        return Err(SshError::PreviewTooLarge);
    }
    let mut content = Vec::with_capacity(size.min(MAX_PREVIEW_BYTES) as usize);
    let mut reader = file.take(MAX_PREVIEW_BYTES.saturating_add(1));
    let mut buffer = vec![0_u8; TRANSFER_BUFFER_SIZE];
    let mut current = 0_u64;
    preview_progress(state, &id, preview_id.as_deref(), current, size);
    // Read in chunks so the UI can receive progress events during slow SFTP reads.
    loop {
        let read = reader.read(&mut buffer).map_err(|error| {
            mark_io_error_if_connection_lost(state, &id, &error);
            SshError::ReadFailed(error.to_string())
        })?;
        if read == 0 {
            break;
        }
        content.extend_from_slice(&buffer[..read]);
        current = current.saturating_add(read as u64);
        if current > MAX_PREVIEW_BYTES {
            return Err(SshError::PreviewTooLarge);
        }
        preview_progress(state, &id, preview_id.as_deref(), current, size);
    }
    preview_progress(state, &id, preview_id.as_deref(), current, size);
    Ok(content)
}

#[tauri::command]
pub async fn get_sftp_file_content(
    state: State<'_, SshState>,
    id: String,
    remote_path: String,
    preview_id: Option<String>,
) -> Result<Vec<u8>, SshError> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        read_sftp_file_content(&state, id, remote_path, preview_id)
    })
    .await
    .map_err(|error| SshError::ReadFailed(format!("预览任务失败: {error}")))?
}

#[tauri::command]
pub fn sftp_mkdir(
    state: State<SshState>,
    id: String,
    remote_path: String,
) -> Result<bool, SshError> {
    let sftp = sftp_for(&state, &id)?;
    sftp.mkdir(Path::new(&remote_path), 0o755)
        .map_err(|error| {
            mark_ssh_error_if_connection_lost(&state, &id, &error);
            SshError::FileOperationFailed(error.to_string())
        })?;
    Ok(true)
}

#[tauri::command]
pub fn sftp_delete(
    state: State<SshState>,
    id: String,
    remote_path: String,
    is_directory: bool,
    operation_id: Option<String>,
) -> Result<bool, SshError> {
    let _ = is_directory;
    let session = session_for(&state, &id)?;
    let operation_id = operation_id.unwrap_or_else(|| format!("delete-{}", uuid_fallback()));
    let state_handle = state.inner().clone();
    let connection_id = id.clone();
    let operation_id_for_thread = operation_id.clone();
    thread::spawn(move || {
        let result = run_delete(
            &state_handle,
            &session,
            &connection_id,
            &remote_path,
            &operation_id_for_thread,
        );
        let (success, message) = match result {
            Ok(()) => (true, "删除成功".to_string()),
            Err(error) => (false, error.to_string()),
        };
        emit_event(
            &state_handle.app_handle,
            "delete-complete",
            json!({
                "id": connection_id,
                "operationId": operation_id_for_thread,
                "success": success,
                "message": message
            }),
        );
    });
    Ok(true)
}

#[tauri::command]
pub fn sftp_rename(
    state: State<SshState>,
    id: String,
    source_path: String,
    target_path: String,
    overwrite: Option<bool>,
) -> Result<bool, SshError> {
    let sftp = sftp_for(&state, &id)?;
    rename_remote_file(
        &sftp,
        Path::new(&source_path),
        Path::new(&target_path),
        overwrite.unwrap_or(false),
    )
    .map_err(|error| {
        mark_ssh_error_if_connection_lost(&state, &id, &error);
        SshError::FileOperationFailed(error.to_string())
    })?;
    Ok(true)
}

#[tauri::command]
pub fn get_sftp_user_home(state: State<SshState>, id: String) -> Result<String, SshError> {
    let sftp = sftp_for(&state, &id)?;
    Ok(sftp
        .realpath(Path::new("."))
        .map_err(|error| {
            mark_ssh_error_if_connection_lost(&state, &id, &error);
            SshError::FileOperationFailed(error.to_string())
        })?
        .to_string_lossy()
        .to_string())
}

fn transfer_progress(
    state: &SshState,
    event: &str,
    transfer_id: &str,
    connection_id: &str,
    current: u64,
    total: u64,
) {
    let progress = if total == 0 {
        100
    } else {
        ((current.saturating_mul(100)) / total).min(100)
    };
    emit_event(
        &state.app_handle,
        event,
        json!({
            "id": connection_id,
            "transferId": transfer_id,
            "progress": progress,
            "current": current,
            "total": total
        }),
    );
}

fn folder_transfer_progress(
    state: &SshState,
    event: &str,
    transfer_id: &str,
    connection_id: &str,
    file_name: &str,
    file_index: usize,
    file_total: usize,
    current: u64,
    total: u64,
    completed_bytes: u64,
    total_bytes: u64,
) {
    let progress = if total == 0 {
        100
    } else {
        ((current.saturating_mul(100)) / total).min(100)
    };
    let overall_progress = if total_bytes == 0 {
        if file_total == 0 {
            100
        } else {
            ((file_index.saturating_add(1).saturating_mul(100)) / file_total).min(100) as u64
        }
    } else {
        (((completed_bytes.saturating_add(current)).saturating_mul(100)) / total_bytes).min(100)
    };
    emit_event(
        &state.app_handle,
        event,
        json!({
            "id": connection_id,
            "transferId": transfer_id,
            "progress": progress,
            "current": current,
            "total": total,
            "fileName": file_name,
            "fileIndex": file_index,
            "fileTotal": file_total,
            "overallProgress": overall_progress,
            "completedBytes": completed_bytes.saturating_add(current),
            "totalBytes": total_bytes
        }),
    );
}

fn upload_file_to_sftp<F>(
    state: &SshState,
    connection: &SshConnection,
    sftp: &Sftp,
    transfer_id: &str,
    local_path: &Path,
    remote_path: &str,
    overwrite: bool,
    mut report_progress: F,
) -> Result<u64, SshError>
where
    F: FnMut(u64, u64),
{
    let local_file = File::open(local_path)
        .map_err(|error| SshError::FileOperationFailed(format!("无法打开本地文件: {error}")))?;
    let total = local_file
        .metadata()
        .map_err(|error| SshError::FileOperationFailed(error.to_string()))?
        .len();
    let temporary_path = format!("{remote_path}.portal-part-{transfer_id}");
    let mut remote_file = sftp.create(Path::new(&temporary_path)).map_err(|error| {
        mark_ssh_error_if_connection_lost(state, &connection.id, &error);
        SshError::FileOperationFailed(error.to_string())
    })?;
    let mut reader = BufReader::new(local_file);
    let mut buffer = vec![0u8; TRANSFER_BUFFER_SIZE];
    let mut current = 0u64;
    report_progress(current, total);

    let write_result = (|| -> Result<(), SshError> {
        loop {
            if is_cancelled(&state.cancelled_transfers, transfer_id) {
                return Err(SshError::TransferCancelled);
            }
            let count = reader
                .read(&mut buffer)
                .map_err(|error| SshError::FileOperationFailed(error.to_string()))?;
            if count == 0 {
                break;
            }
            remote_file.write_all(&buffer[..count]).map_err(|error| {
                mark_io_error_if_connection_lost(state, &connection.id, &error);
                SshError::FileOperationFailed(error.to_string())
            })?;
            current += count as u64;
            report_progress(current, total);
        }
        remote_file.flush().map_err(|error| {
            mark_io_error_if_connection_lost(state, &connection.id, &error);
            SshError::FileOperationFailed(error.to_string())
        })?;
        Ok(())
    })();
    drop(remote_file);

    let result = write_result.and_then(|_| {
        rename_remote_file(
            sftp,
            Path::new(&temporary_path),
            Path::new(remote_path),
            overwrite,
        )
        .map_err(|error| {
            mark_ssh_error_if_connection_lost(state, &connection.id, &error);
            SshError::FileOperationFailed(error.to_string())
        })
    });

    if result.is_err() {
        let _ = sftp.unlink(Path::new(&temporary_path));
    }
    result.map(|_| total)
}

fn run_upload(
    state: &SshState,
    connection: &SshConnection,
    session: &Arc<Mutex<Session>>,
    transfer_id: &str,
    local_path: &str,
    remote_path: &str,
    overwrite: bool,
) -> Result<String, SshError> {
    let session = session
        .lock()
        .map_err(|_| SshError::SftpFailed("会话锁已损坏".to_string()))?;
    let sftp = session.sftp().map_err(|error| {
        mark_ssh_error_if_connection_lost(state, &connection.id, &error);
        SshError::SftpFailed(error.to_string())
    })?;
    drop(session);

    upload_file_to_sftp(
        state,
        connection,
        &sftp,
        transfer_id,
        Path::new(local_path),
        remote_path,
        overwrite,
        |current, total| {
            transfer_progress(
                state,
                "upload-progress",
                transfer_id,
                &connection.id,
                current,
                total,
            );
        },
    )
    .map(|_| "上传成功".to_string())
}

fn run_upload_directory(
    state: &SshState,
    connection: &SshConnection,
    session: &Arc<Mutex<Session>>,
    transfer_id: &str,
    local_path: &str,
    remote_path: &str,
    overwrite: bool,
) -> Result<String, SshError> {
    let plan = collect_folder_upload_plan(Path::new(local_path))?;
    if is_cancelled(&state.cancelled_transfers, transfer_id) {
        return Err(SshError::TransferCancelled);
    }

    let session = session
        .lock()
        .map_err(|_| SshError::SftpFailed("会话锁已损坏".to_string()))?;
    let sftp = session.sftp().map_err(|error| {
        mark_ssh_error_if_connection_lost(state, &connection.id, &error);
        SshError::SftpFailed(error.to_string())
    })?;
    drop(session);

    ensure_remote_directory(state, &connection.id, &sftp, remote_path, overwrite)?;
    for relative_path in &plan.directories {
        if is_cancelled(&state.cancelled_transfers, transfer_id) {
            return Err(SshError::TransferCancelled);
        }
        let remote_directory = join_remote_path(remote_path, relative_path)?;
        ensure_remote_directory(state, &connection.id, &sftp, &remote_directory, true).map_err(
            |error| {
                SshError::FileOperationFailed(format!(
                    "创建远程文件夹“{}”失败: {error}",
                    display_relative_path(relative_path)
                ))
            },
        )?;
    }

    let file_total = plan.files.len();
    let mut completed_bytes = 0u64;
    for (file_index, file) in plan.files.iter().enumerate() {
        if is_cancelled(&state.cancelled_transfers, transfer_id) {
            return Err(SshError::TransferCancelled);
        }
        let remote_file_path = join_remote_path(remote_path, &file.relative_path)?;
        let display_path = display_relative_path(&file.relative_path);
        let uploaded_size = upload_file_to_sftp(
            state,
            connection,
            &sftp,
            transfer_id,
            &file.local_path,
            &remote_file_path,
            overwrite,
            |current, total| {
                folder_transfer_progress(
                    state,
                    "upload-progress",
                    transfer_id,
                    &connection.id,
                    &display_path,
                    file_index,
                    file_total,
                    current,
                    total,
                    completed_bytes,
                    plan.total_bytes,
                );
            },
        )
        .map_err(|error| {
            if matches!(&error, SshError::TransferCancelled) {
                error
            } else {
                SshError::FileOperationFailed(format!("上传“{display_path}”失败: {error}"))
            }
        })?;
        completed_bytes = completed_bytes.saturating_add(uploaded_size);
    }

    let skipped_note = if plan.skipped_entries == 0 {
        String::new()
    } else {
        format!("，已跳过 {} 个符号链接或特殊文件", plan.skipped_entries)
    };
    if file_total == 0 {
        Ok(format!(
            "文件夹上传成功：已创建 {} 个文件夹{}",
            plan.directories.len().saturating_add(1),
            skipped_note
        ))
    } else {
        Ok(format!(
            "文件夹上传成功：{} 个文件{}",
            file_total, skipped_note
        ))
    }
}

fn download_file_to_local<F>(
    state: &SshState,
    connection: &SshConnection,
    sftp: &Sftp,
    transfer_id: &str,
    remote_path: &str,
    target: &Path,
    overwrite: bool,
    mut report_progress: F,
) -> Result<u64, SshError>
where
    F: FnMut(u64, u64),
{
    if let Ok(metadata) = fs::symlink_metadata(target) {
        if metadata.file_type().is_symlink() {
            return Err(SshError::FileOperationFailed(
                "本地目标路径是符号链接，不支持直接覆盖".to_string(),
            ));
        }
        if metadata.is_dir() {
            return Err(SshError::FileOperationFailed(
                "本地目标路径是文件夹，无法保存文件".to_string(),
            ));
        }
        if !overwrite {
            return Err(SshError::FileOperationFailed(
                "本地目标文件已存在".to_string(),
            ));
        }
    }

    let mut remote_file = sftp.open(Path::new(remote_path)).map_err(|error| {
        mark_ssh_error_if_connection_lost(state, &connection.id, &error);
        SshError::FileOperationFailed(error.to_string())
    })?;
    let total = remote_file
        .stat()
        .map_err(|error| {
            mark_ssh_error_if_connection_lost(state, &connection.id, &error);
            SshError::FileOperationFailed(error.to_string())
        })?
        .size
        .unwrap_or(0);
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| SshError::FileOperationFailed(error.to_string()))?;
    }
    let target_name = target
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| "download".to_string());
    let temporary_path = target.with_file_name(format!("{target_name}.portal-part-{transfer_id}"));
    let local_file = File::create(&temporary_path)
        .map_err(|error| SshError::FileOperationFailed(format!("无法创建本地临时文件: {error}")))?;
    let mut writer = BufWriter::new(local_file);
    let mut buffer = vec![0u8; TRANSFER_BUFFER_SIZE];
    let mut current = 0u64;
    report_progress(current, total);

    let result = (|| -> Result<(), SshError> {
        loop {
            if is_cancelled(&state.cancelled_transfers, transfer_id) {
                return Err(SshError::TransferCancelled);
            }
            let count = remote_file.read(&mut buffer).map_err(|error| {
                mark_io_error_if_connection_lost(state, &connection.id, &error);
                SshError::FileOperationFailed(error.to_string())
            })?;
            if count == 0 {
                break;
            }
            writer
                .write_all(&buffer[..count])
                .map_err(|error| SshError::FileOperationFailed(error.to_string()))?;
            current = current.saturating_add(count as u64);
            report_progress(current, total);
        }
        writer
            .flush()
            .map_err(|error| SshError::FileOperationFailed(error.to_string()))?;
        drop(writer);
        if overwrite && target.exists() {
            fs::remove_file(target)
                .map_err(|error| SshError::FileOperationFailed(error.to_string()))?;
        }
        fs::rename(&temporary_path, target)
            .map_err(|error| SshError::FileOperationFailed(error.to_string()))?;
        Ok(())
    })();

    if result.is_err() {
        let _ = fs::remove_file(&temporary_path);
    }
    result.map(|_| total)
}

fn run_download(
    state: &SshState,
    connection: &SshConnection,
    session: &Arc<Mutex<Session>>,
    transfer_id: &str,
    remote_path: &str,
    local_path: &str,
    overwrite: bool,
) -> Result<String, SshError> {
    let session = session
        .lock()
        .map_err(|_| SshError::SftpFailed("会话锁已损坏".to_string()))?;
    let sftp = session.sftp().map_err(|error| {
        mark_ssh_error_if_connection_lost(state, &connection.id, &error);
        SshError::SftpFailed(error.to_string())
    })?;
    drop(session);
    download_file_to_local(
        state,
        connection,
        &sftp,
        transfer_id,
        remote_path,
        Path::new(local_path),
        overwrite,
        |current, total| {
            transfer_progress(
                state,
                "download-progress",
                transfer_id,
                &connection.id,
                current,
                total,
            );
        },
    )
    .map(|_| "下载成功".to_string())
}

fn run_download_directory(
    state: &SshState,
    connection: &SshConnection,
    session: &Arc<Mutex<Session>>,
    transfer_id: &str,
    remote_path: &str,
    local_path: &str,
    overwrite: bool,
) -> Result<String, SshError> {
    let target_root = PathBuf::from(local_path);
    if let Ok(metadata) = fs::symlink_metadata(&target_root) {
        if metadata.file_type().is_symlink() {
            return Err(SshError::FileOperationFailed(
                "本地目标文件夹是符号链接，不支持直接覆盖".to_string(),
            ));
        }
        if !metadata.is_dir() {
            return Err(SshError::FileOperationFailed(
                "本地目标路径已存在且不是文件夹".to_string(),
            ));
        }
        if !overwrite {
            return Err(SshError::FileOperationFailed(
                "本地目标文件夹已存在".to_string(),
            ));
        }
    }

    let session = session
        .lock()
        .map_err(|_| SshError::SftpFailed("会话锁已损坏".to_string()))?;
    let sftp = session.sftp().map_err(|error| {
        mark_ssh_error_if_connection_lost(state, &connection.id, &error);
        SshError::SftpFailed(error.to_string())
    })?;
    drop(session);

    let plan =
        collect_folder_download_plan(state, &connection.id, &sftp, remote_path, transfer_id)?;
    if is_cancelled(&state.cancelled_transfers, transfer_id) {
        return Err(SshError::TransferCancelled);
    }
    fs::create_dir_all(&target_root)
        .map_err(|error| SshError::FileOperationFailed(format!("无法创建本地文件夹: {error}")))?;
    for relative_path in &plan.directories {
        if is_cancelled(&state.cancelled_transfers, transfer_id) {
            return Err(SshError::TransferCancelled);
        }
        fs::create_dir_all(target_root.join(relative_path)).map_err(|error| {
            SshError::FileOperationFailed(format!(
                "无法创建本地文件夹“{}”: {error}",
                display_relative_path(relative_path)
            ))
        })?;
    }

    let file_total = plan.files.len();
    let mut completed_bytes = 0u64;
    for (file_index, file) in plan.files.iter().enumerate() {
        if is_cancelled(&state.cancelled_transfers, transfer_id) {
            return Err(SshError::TransferCancelled);
        }
        let display_path = display_relative_path(&file.relative_path);
        let target = target_root.join(&file.relative_path);
        let downloaded_size = download_file_to_local(
            state,
            connection,
            &sftp,
            transfer_id,
            &file.remote_path,
            &target,
            overwrite,
            |current, total| {
                folder_transfer_progress(
                    state,
                    "download-progress",
                    transfer_id,
                    &connection.id,
                    &display_path,
                    file_index,
                    file_total,
                    current,
                    total,
                    completed_bytes,
                    plan.total_bytes,
                );
            },
        )
        .map_err(|error| {
            if matches!(&error, SshError::TransferCancelled) {
                error
            } else {
                SshError::FileOperationFailed(format!("下载“{display_path}”失败: {error}"))
            }
        })?;
        completed_bytes = completed_bytes.saturating_add(downloaded_size);
    }

    let skipped_note = if plan.skipped_entries == 0 {
        String::new()
    } else {
        format!("，已跳过 {} 个符号链接或特殊文件", plan.skipped_entries)
    };
    if file_total == 0 {
        Ok(format!(
            "文件夹下载成功：已创建 {} 个文件夹{}",
            plan.directories.len().saturating_add(1),
            skipped_note
        ))
    } else {
        Ok(format!(
            "文件夹下载成功：{} 个文件{}",
            file_total, skipped_note
        ))
    }
}

#[tauri::command]
pub fn scp_upload(
    state: State<SshState>,
    id: String,
    local_path: String,
    remote_path: String,
    transfer_id: Option<String>,
    overwrite: Option<bool>,
) -> Result<String, SshError> {
    let transfer_id = transfer_id.unwrap_or_else(|| format!("upload-{}", uuid_fallback()));
    let connection = connection_info(&state, &id, true)?;
    let session = session_for(&state, &id)?;
    transfer_slot(&state)?;
    let state_handle = state.inner().clone();
    let transfer_id_for_thread = transfer_id.clone();
    thread::spawn(move || {
        let result = run_upload(
            &state_handle,
            &connection,
            &session,
            &transfer_id_for_thread,
            &local_path,
            &remote_path,
            overwrite.unwrap_or(false),
        );
        let cancelled = matches!(result, Err(SshError::TransferCancelled));
        emit_event(
            &state_handle.app_handle,
            "upload-complete",
            json!({
                "id": connection.id,
                "transferId": transfer_id_for_thread,
                "success": result.is_ok(),
                "cancelled": cancelled,
                "message": result.map(|message| message).unwrap_or_else(|error| error.to_string())
            }),
        );
        finish_transfer(&state_handle, &transfer_id_for_thread);
    });
    Ok("上传已开始".to_string())
}

#[tauri::command]
pub fn sftp_upload_directory(
    state: State<SshState>,
    id: String,
    local_path: String,
    remote_path: String,
    transfer_id: Option<String>,
    overwrite: Option<bool>,
) -> Result<String, SshError> {
    let transfer_id = transfer_id.unwrap_or_else(|| format!("folder-upload-{}", uuid_fallback()));
    let connection = connection_info(&state, &id, true)?;
    let session = session_for(&state, &id)?;
    transfer_slot(&state)?;
    let state_handle = state.inner().clone();
    let transfer_id_for_thread = transfer_id.clone();
    let overwrite = overwrite.unwrap_or(false);
    thread::spawn(move || {
        let result = run_upload_directory(
            &state_handle,
            &connection,
            &session,
            &transfer_id_for_thread,
            &local_path,
            &remote_path,
            overwrite,
        );
        let cancelled = matches!(result, Err(SshError::TransferCancelled));
        emit_event(
            &state_handle.app_handle,
            "upload-complete",
            json!({
                "id": connection.id,
                "transferId": transfer_id_for_thread,
                "success": result.is_ok(),
                "cancelled": cancelled,
                "message": result.map(|message| message).unwrap_or_else(|error| error.to_string())
            }),
        );
        finish_transfer(&state_handle, &transfer_id_for_thread);
    });
    Ok("文件夹上传已开始".to_string())
}

#[tauri::command]
pub fn scp_download(
    state: State<SshState>,
    id: String,
    remote_path: String,
    local_path: String,
    transfer_id: Option<String>,
    overwrite: Option<bool>,
) -> Result<String, SshError> {
    let transfer_id = transfer_id.unwrap_or_else(|| format!("download-{}", uuid_fallback()));
    let connection = connection_info(&state, &id, true)?;
    let session = session_for(&state, &id)?;
    transfer_slot(&state)?;
    let state_handle = state.inner().clone();
    let transfer_id_for_thread = transfer_id.clone();
    let overwrite = overwrite.unwrap_or(false);
    thread::spawn(move || {
        let result = run_download(
            &state_handle,
            &connection,
            &session,
            &transfer_id_for_thread,
            &remote_path,
            &local_path,
            overwrite,
        );
        let cancelled = matches!(result, Err(SshError::TransferCancelled));
        emit_event(
            &state_handle.app_handle,
            "download-complete",
            json!({
                "id": connection.id,
                "transferId": transfer_id_for_thread,
                "success": result.is_ok(),
                "cancelled": cancelled,
                "message": result.map(|message| message).unwrap_or_else(|error| error.to_string())
            }),
        );
        finish_transfer(&state_handle, &transfer_id_for_thread);
    });
    Ok("下载已开始".to_string())
}

#[tauri::command]
pub fn sftp_download_directory(
    state: State<SshState>,
    id: String,
    remote_path: String,
    local_path: String,
    transfer_id: Option<String>,
    overwrite: Option<bool>,
) -> Result<String, SshError> {
    let transfer_id = transfer_id.unwrap_or_else(|| format!("folder-download-{}", uuid_fallback()));
    let connection = connection_info(&state, &id, true)?;
    let session = session_for(&state, &id)?;
    transfer_slot(&state)?;
    let state_handle = state.inner().clone();
    let transfer_id_for_thread = transfer_id.clone();
    let overwrite = overwrite.unwrap_or(false);
    thread::spawn(move || {
        let result = run_download_directory(
            &state_handle,
            &connection,
            &session,
            &transfer_id_for_thread,
            &remote_path,
            &local_path,
            overwrite,
        );
        let cancelled = matches!(result, Err(SshError::TransferCancelled));
        emit_event(
            &state_handle.app_handle,
            "download-complete",
            json!({
                "id": connection.id,
                "transferId": transfer_id_for_thread,
                "success": result.is_ok(),
                "cancelled": cancelled,
                "message": result.map(|message| message).unwrap_or_else(|error| error.to_string())
            }),
        );
        finish_transfer(&state_handle, &transfer_id_for_thread);
    });
    Ok("文件夹下载已开始".to_string())
}

#[tauri::command]
pub fn cancel_transfer(state: State<SshState>, transfer_id: String) -> Result<bool, SshError> {
    state
        .cancelled_transfers
        .lock()
        .unwrap()
        .insert(transfer_id);
    Ok(true)
}

fn uuid_fallback() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos().to_string())
        .unwrap_or_else(|_| "0".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_sha256_fingerprint_bytes_as_base64() {
        assert_eq!(base64_encode(b"hello"), "aGVsbG8");
        assert_eq!(base64_encode(&[]), "");
    }

    #[test]
    fn rejects_invalid_connection_configuration() {
        let connection = SshConnection {
            id: "test".to_string(),
            host: "".to_string(),
            port: 22,
            username: "user".to_string(),
            auth_method: "password".to_string(),
            private_key_path: None,
            host_key_fingerprint: None,
            password: "secret".to_string(),
            passphrase: None,
            connected: false,
        };
        assert!(validate_connection(&connection).is_err());
    }

    #[test]
    fn distinguishes_transport_loss_from_sftp_path_errors() {
        assert!(is_connection_loss(&ssh2::Error::new(
            ErrorCode::Session(-13),
            "socket disconnected"
        )));
        assert!(is_connection_loss(&ssh2::Error::new(
            ErrorCode::SFTP(7),
            "connection lost"
        )));
        assert!(!is_connection_loss(&ssh2::Error::new(
            ErrorCode::SFTP(2),
            "no such file"
        )));
    }

    #[test]
    fn identifies_sftp_rename_capability_failures() {
        assert!(is_rename_compatibility_error(&ssh2::Error::new(
            ErrorCode::SFTP(LIBSSH2_FX_FAILURE),
            "failure"
        )));
        assert!(is_rename_compatibility_error(&ssh2::Error::new(
            ErrorCode::SFTP(LIBSSH2_FX_OP_UNSUPPORTED),
            "operation unsupported"
        )));
        assert!(!is_rename_compatibility_error(&ssh2::Error::new(
            ErrorCode::SFTP(3),
            "permission denied"
        )));
    }

    #[test]
    fn joins_folder_upload_paths_without_parent_components() {
        assert_eq!(
            join_remote_path("/", Path::new("nested/file.txt")).unwrap(),
            "/nested/file.txt"
        );
        assert_eq!(
            join_remote_path("C:/upload/", Path::new("nested/file.txt")).unwrap(),
            "C:/upload/nested/file.txt"
        );
        assert!(join_remote_path("/upload", Path::new("../escape")).is_err());
    }

    #[test]
    fn joins_remote_download_children_with_portable_separators() {
        assert_eq!(
            join_remote_child_path("/remote/", "nested").unwrap(),
            "/remote/nested"
        );
        assert_eq!(
            join_remote_child_path("C:\\remote\\", "nested").unwrap(),
            "C:/remote/nested"
        );
        assert!(join_remote_child_path("/remote", "../escape").is_err());
        assert!(join_remote_child_path("/remote", "nested/file.txt").is_err());
    }

    #[test]
    fn collects_nested_files_and_empty_directories_for_folder_upload() {
        let root = std::env::temp_dir().join(format!(
            "portal-folder-upload-plan-{}-{}",
            std::process::id(),
            uuid_fallback()
        ));
        fs::create_dir_all(root.join("nested")).unwrap();
        fs::create_dir_all(root.join("empty")).unwrap();
        fs::write(root.join("root.txt"), b"abc").unwrap();
        fs::write(root.join("nested").join("child.txt"), b"hello").unwrap();

        let plan = collect_folder_upload_plan(&root).unwrap();
        let directories = plan
            .directories
            .iter()
            .map(|path| display_relative_path(path))
            .collect::<Vec<_>>();
        let files = plan
            .files
            .iter()
            .map(|file| display_relative_path(&file.relative_path))
            .collect::<Vec<_>>();

        let _ = fs::remove_dir_all(&root);

        assert_eq!(directories, vec!["empty", "nested"]);
        assert_eq!(files, vec!["nested/child.txt", "root.txt"]);
        assert_eq!(plan.total_bytes, 8);
        assert_eq!(plan.skipped_entries, 0);
    }
}
