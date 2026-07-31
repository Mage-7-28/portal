use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{BufReader, BufWriter, Read, Write};
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::thread;
use std::time::Duration;

use serde::Serialize;
use serde_json::json;
use ssh2::{HashType, RenameFlags, Session, Sftp};
use tauri::{AppHandle, Emitter, State};
use thiserror::Error;

const DEFAULT_TIMEOUT_MS: u64 = 30_000;
const TRANSFER_BUFFER_SIZE: usize = 64 * 1024;
const KEEPALIVE_INTERVAL_SECS: u32 = 30;
const MAX_CONCURRENT_TRANSFERS: usize = 4;
const MAX_PREVIEW_BYTES: u64 = 5 * 1024 * 1024;

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
    session
        .sftp()
        .map_err(|error| SshError::SftpFailed(error.to_string()))
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
    let entries = sftp
        .readdir(Path::new(&remote_path))
        .map_err(|error| SshError::ReadDirFailed(error.to_string()))?;

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
    let mut file = sftp
        .open(Path::new(&remote_path))
        .map_err(|error| SshError::FileOperationFailed(error.to_string()))?;
    let size = file
        .stat()
        .map_err(|error| SshError::FileOperationFailed(error.to_string()))?
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
        let read = reader
            .read(&mut buffer)
            .map_err(|error| SshError::ReadFailed(error.to_string()))?;
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
        .map_err(|error| SshError::FileOperationFailed(error.to_string()))?;
    Ok(true)
}

#[tauri::command]
pub fn sftp_delete(
    state: State<SshState>,
    id: String,
    remote_path: String,
    is_directory: bool,
) -> Result<bool, SshError> {
    let sftp = sftp_for(&state, &id)?;
    if is_directory {
        sftp.rmdir(Path::new(&remote_path))
    } else {
        sftp.unlink(Path::new(&remote_path))
    }
    .map_err(|error| SshError::FileOperationFailed(error.to_string()))?;
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
    let flags = if overwrite.unwrap_or(false) {
        RenameFlags::ATOMIC | RenameFlags::OVERWRITE | RenameFlags::NATIVE
    } else {
        RenameFlags::ATOMIC | RenameFlags::NATIVE
    };
    sftp.rename(
        Path::new(&source_path),
        Path::new(&target_path),
        Some(flags),
    )
    .map_err(|error| SshError::FileOperationFailed(error.to_string()))?;
    Ok(true)
}

#[tauri::command]
pub fn get_sftp_user_home(state: State<SshState>, id: String) -> Result<String, SshError> {
    let sftp = sftp_for(&state, &id)?;
    Ok(sftp
        .realpath(Path::new("."))
        .map_err(|error| SshError::FileOperationFailed(error.to_string()))?
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

fn run_upload(
    state: &SshState,
    connection: &SshConnection,
    session: &Arc<Mutex<Session>>,
    transfer_id: &str,
    local_path: &str,
    remote_path: &str,
) -> Result<String, SshError> {
    let session = session
        .lock()
        .map_err(|_| SshError::SftpFailed("会话锁已损坏".to_string()))?;
    let sftp = session
        .sftp()
        .map_err(|error| SshError::SftpFailed(error.to_string()))?;
    drop(session);
    let local_file = File::open(local_path)
        .map_err(|error| SshError::FileOperationFailed(format!("无法打开本地文件: {error}")))?;
    let total = local_file
        .metadata()
        .map_err(|error| SshError::FileOperationFailed(error.to_string()))?
        .len();
    let temporary_path = format!("{remote_path}.portal-part-{transfer_id}");
    let mut remote_file = sftp
        .create(Path::new(&temporary_path))
        .map_err(|error| SshError::FileOperationFailed(error.to_string()))?;
    let mut reader = BufReader::new(local_file);
    let mut buffer = vec![0u8; TRANSFER_BUFFER_SIZE];
    let mut current = 0u64;

    let result = (|| -> Result<(), SshError> {
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
            remote_file
                .write_all(&buffer[..count])
                .map_err(|error| SshError::FileOperationFailed(error.to_string()))?;
            current += count as u64;
            transfer_progress(
                state,
                "upload-progress",
                transfer_id,
                &connection.id,
                current,
                total,
            );
        }
        remote_file
            .flush()
            .map_err(|error| SshError::FileOperationFailed(error.to_string()))?;
        drop(remote_file);
        sftp.rename(
            Path::new(&temporary_path),
            Path::new(remote_path),
            Some(RenameFlags::ATOMIC | RenameFlags::OVERWRITE | RenameFlags::NATIVE),
        )
        .map_err(|error| SshError::FileOperationFailed(error.to_string()))?;
        Ok(())
    })();

    if result.is_err() {
        let _ = sftp.unlink(Path::new(&temporary_path));
    }
    result.map(|_| "上传成功".to_string())
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
    let sftp = session
        .sftp()
        .map_err(|error| SshError::SftpFailed(error.to_string()))?;
    drop(session);
    let mut remote_file = sftp
        .open(Path::new(remote_path))
        .map_err(|error| SshError::FileOperationFailed(error.to_string()))?;
    let total = remote_file
        .stat()
        .map_err(|error| SshError::FileOperationFailed(error.to_string()))?
        .size
        .unwrap_or(0);
    let target = PathBuf::from(local_path);
    if target.exists() && !overwrite {
        return Err(SshError::FileOperationFailed(
            "本地目标文件已存在".to_string(),
        ));
    }
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| SshError::FileOperationFailed(error.to_string()))?;
    }
    let temporary_path = PathBuf::from(format!("{local_path}.portal-part-{transfer_id}"));
    let local_file = File::create(&temporary_path)
        .map_err(|error| SshError::FileOperationFailed(format!("无法创建本地临时文件: {error}")))?;
    let mut writer = BufWriter::new(local_file);
    let mut buffer = vec![0u8; TRANSFER_BUFFER_SIZE];
    let mut current = 0u64;

    let result = (|| -> Result<(), SshError> {
        loop {
            if is_cancelled(&state.cancelled_transfers, transfer_id) {
                return Err(SshError::TransferCancelled);
            }
            let count = remote_file
                .read(&mut buffer)
                .map_err(|error| SshError::FileOperationFailed(error.to_string()))?;
            if count == 0 {
                break;
            }
            writer
                .write_all(&buffer[..count])
                .map_err(|error| SshError::FileOperationFailed(error.to_string()))?;
            current += count as u64;
            transfer_progress(
                state,
                "download-progress",
                transfer_id,
                &connection.id,
                current,
                total,
            );
        }
        writer
            .flush()
            .map_err(|error| SshError::FileOperationFailed(error.to_string()))?;
        drop(writer);
        if overwrite && target.exists() {
            fs::remove_file(&target)
                .map_err(|error| SshError::FileOperationFailed(error.to_string()))?;
        }
        fs::rename(&temporary_path, &target)
            .map_err(|error| SshError::FileOperationFailed(error.to_string()))?;
        Ok(())
    })();

    if result.is_err() {
        let _ = fs::remove_file(&temporary_path);
    }
    result.map(|_| "下载成功".to_string())
}

#[tauri::command]
pub fn scp_upload(
    state: State<SshState>,
    id: String,
    local_path: String,
    remote_path: String,
    transfer_id: Option<String>,
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
}
