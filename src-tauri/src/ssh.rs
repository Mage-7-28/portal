use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::sync::Arc;
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::json;
use ssh2::Session;
use tauri::{AppHandle, Emitter, State};
use thiserror::Error;

// ============================================================================
// 常量定义
// ============================================================================

const DEFAULT_TIMEOUT_MS: u64 = 30_000;
const UPLOAD_BUFFER_SIZE: usize = 64 * 1024; // 64KB
const PROGRESS_UPDATE_INTERVAL_MS: u64 = 100;
const KEEPALIVE_CHECK_INTERVAL_SECS: u64 = 60;
const SESSION_MAX_IDLE_SECS: u64 = 300;

// ============================================================================
// 错误类型定义
// ============================================================================

#[derive(Error, Debug, Serialize)]
pub enum SshError {
    #[error("连接不存在或未连接")]
    ConnectionNotFound,

    #[error("连接池未初始化")]
    PoolNotInitialized,

    #[error("无法连接到服务器: {0}")]
    ConnectionFailed(String),

    #[error("SSH握手失败: {0}")]
    HandshakeFailed(String),

    #[error("认证失败: {0}")]
    AuthFailed(String),

    #[error("认证失败")]
    AuthFailedUnknown,

    #[error("创建通道失败: {0}")]
    ChannelFailed(String),

    #[error("执行命令失败: {0}")]
    CommandFailed(String),

    #[error("读取输出失败: {0}")]
    ReadFailed(String),

    #[error("关闭通道失败: {0}")]
    ChannelCloseFailed(String),

    #[error("创建SFTP会话失败: {0}")]
    SftpFailed(String),

    #[error("文件操作失败: {0}")]
    FileOperationFailed(String),

    #[error("读取目录失败: {0}")]
    ReadDirFailed(String),
}

impl From<std::io::Error> for SshError {
    fn from(e: std::io::Error) -> Self {
        SshError::FileOperationFailed(e.to_string())
    }
}

// 方便从 ssh2::Error 转换
impl From<ssh2::Error> for SshError {
    fn from(e: ssh2::Error) -> Self {
        SshError::ConnectionFailed(e.to_string())
    }
}

// ============================================================================
// 数据结构
// ============================================================================

#[derive(Default)]
pub struct SshState {
    pub connections: Arc<Mutex<Vec<SshConnection>>>,
    pub connection_pool: Arc<Mutex<Option<SshConnectionPool>>>,
    pub app_handle: Arc<Mutex<Option<AppHandle>>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SshConnection {
    pub id: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    #[serde(skip_serializing)]
    pub password: String,
    pub connected: bool,
}

impl SshConnection {
    /// 生成连接 ID（不含密码，用于标识连接身份）
    fn generate_id(host: &str, port: u16, username: &str) -> String {
        format!("{}-{}-{}", host, port, username)
    }
}

// 连接池中的活跃会话
struct ActiveSession {
    session: Arc<Mutex<Session>>,
    last_used: Instant,
}

// SSH 连接池
pub struct SshConnectionPool {
    sessions: Arc<Mutex<HashMap<String, ActiveSession>>>,
}

// ============================================================================
// SshState 辅助方法
// ============================================================================

impl SshState {
    /// 从连接列表中获取连接信息
    fn get_connection_info(
        connections: &[SshConnection],
        id: &str,
        require_connected: bool,
    ) -> Result<SshConnection, SshError> {
        connections
            .iter()
            .find(|c| {
                c.id == id && (!require_connected || c.connected)
            })
            .cloned()
            .ok_or(SshError::ConnectionNotFound)
    }
}

// ============================================================================
// SshConnectionPool 实现
// ============================================================================

impl SshConnectionPool {
    pub fn new() -> Self {
        let pool = Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
        };
        pool.start_keepalive();
        pool
    }

    pub fn get_session(
        &self,
        id: &str,
        host: &str,
        port: u16,
        username: &str,
        password: &str,
    ) -> Result<Arc<Mutex<Session>>, SshError> {
        let mut sessions = self.sessions.lock().unwrap();

        // 尝试从缓存获取
        if let Some(active) = sessions.get_mut(id) {
            if self.is_session_alive(&active.session) {
                active.last_used = Instant::now();
                return Ok(active.session.clone());
            }
            // 连接已失效，移除并重新创建
            sessions.remove(id);
        }

        // 创建新连接
        let session = self.create_ssh_connection(host, port, username, password)?;
        let session = Arc::new(Mutex::new(session));

        let active = ActiveSession {
            session: session.clone(),
            last_used: Instant::now(),
        };

        sessions.insert(id.to_string(), active);
        Ok(session)
    }

    fn create_ssh_connection(
        &self,
        host: &str,
        port: u16,
        username: &str,
        password: &str,
    ) -> Result<Session, SshError> {
        let timeout = Duration::from_millis(DEFAULT_TIMEOUT_MS);

        let tcp = TcpStream::connect(format!("{}:{}", host, port))
            .map_err(|e| SshError::ConnectionFailed(e.to_string()))?;

        tcp.set_read_timeout(Some(timeout))
            .map_err(|e| SshError::ConnectionFailed(e.to_string()))?;
        tcp.set_write_timeout(Some(timeout))
            .map_err(|e| SshError::ConnectionFailed(e.to_string()))?;

        let mut sess = Session::new()
            .map_err(|e| SshError::ConnectionFailed(e.to_string()))?;

        sess.set_tcp_stream(tcp);
        sess.handshake()
            .map_err(|e| SshError::HandshakeFailed(e.to_string()))?;

        sess.userauth_password(username, password)
            .map_err(|e| SshError::AuthFailed(e.to_string()))?;

        if !sess.authenticated() {
            return Err(SshError::AuthFailedUnknown);
        }

        Ok(sess)
    }

    fn is_session_alive(&self, session: &Arc<Mutex<Session>>) -> bool {
        let session = session.lock().unwrap();
        match session.channel_session() {
            Ok(mut channel) => {
                match channel.exec("echo alive") {
                    Ok(_) => {
                        let mut output = String::new();
                        channel.read_to_string(&mut output).is_ok()
                    }
                    Err(_) => false,
                }
            }
            Err(_) => false,
        }
    }

    fn start_keepalive(&self) {
        let sessions = self.sessions.clone();
        thread::spawn(move || {
            loop {
                thread::sleep(Duration::from_secs(KEEPALIVE_CHECK_INTERVAL_SECS));
                let mut sessions = sessions.lock().unwrap();
                let mut dead = Vec::new();

                for (id, active) in sessions.iter_mut() {
                    if active.last_used.elapsed() > Duration::from_secs(SESSION_MAX_IDLE_SECS) {
                        dead.push(id.clone());
                    }
                }

                for id in dead {
                    sessions.remove(&id);
                }
            }
        });
    }

    pub fn remove_session(&self, id: &str) {
        let mut sessions = self.sessions.lock().unwrap();
        if let Some(active) = sessions.remove(id) {
            let session = active.session.lock().unwrap();
            let _ = session.disconnect(None, "用户主动断开连接", None);
        }
    }
}

// ============================================================================
// Tauri 命令
// ============================================================================

#[tauri::command]
pub fn test_sftp_connection(
    host: String,
    port: u16,
    username: String,
    password: String,
    timeout: Option<u64>,
) -> Result<String, SshError> {
    let timeout_duration = Duration::from_millis(timeout.unwrap_or(DEFAULT_TIMEOUT_MS));

    let tcp = TcpStream::connect(format!("{}:{}", host, port))
        .map_err(|e| SshError::ConnectionFailed(format!("{}: {}", host, e)))?;

    tcp.set_read_timeout(Some(timeout_duration))
        .map_err(|e| SshError::ConnectionFailed(e.to_string()))?;
    tcp.set_write_timeout(Some(timeout_duration))
        .map_err(|e| SshError::ConnectionFailed(e.to_string()))?;

    let mut sess = Session::new()
        .map_err(|e| SshError::ConnectionFailed(e.to_string()))?;

    sess.set_tcp_stream(tcp);
    sess.handshake()
        .map_err(|e| SshError::HandshakeFailed(e.to_string()))?;

    sess.userauth_password(&username, &password)
        .map_err(|e| SshError::AuthFailed(e.to_string()))?;

    if sess.authenticated() {
        sess.disconnect(None, "测试连接成功", None)
            .unwrap_or_else(|e| eprintln!("断开连接时出错: {}", e));
        Ok("连接测试成功".to_string())
    } else {
        Err(SshError::AuthFailedUnknown)
    }
}

#[tauri::command]
pub fn add_ssh_connection(
    state: State<SshState>,
    host: String,
    port: u16,
    username: String,
    password: String,
) -> Result<String, SshError> {
    let id = SshConnection::generate_id(&host, port, &username);
    let mut connections = state.connections.lock().unwrap();

    if let Some(existing) = connections.iter_mut().find(|c| c.id == id) {
        existing.password = password;
        existing.connected = false;
        return Ok(existing.id.clone());
    }

    let connection = SshConnection {
        id: id.clone(),
        host,
        port,
        username,
        password,
        connected: false,
    };

    connections.push(connection);
    Ok(id)
}

#[tauri::command]
pub fn list_ssh_connections(state: State<SshState>) -> Result<Vec<SshConnection>, SshError> {
    let connections = state.connections.lock().unwrap();
    // 返回连接列表，密码字段已被 #[serde(skip_serializing)] 跳过
    Ok(connections.clone())
}

#[tauri::command]
pub fn connect_ssh(state: State<SshState>, id: String) -> Result<bool, SshError> {
    // 获取连接信息
    let (host, port, username, password) = {
        let connections = state.connections.lock().unwrap();
        let conn = SshState::get_connection_info(&connections, &id, false)?;
        (conn.host, conn.port, conn.username, conn.password)
    };

    // 初始化连接池
    {
        let mut pool_guard = state.connection_pool.lock().unwrap();
        if pool_guard.is_none() {
            *pool_guard = Some(SshConnectionPool::new());
        }
    }

    // 通过连接池创建并缓存会话
    let pool_guard = state.connection_pool.lock().unwrap();
    let pool = pool_guard.as_ref().ok_or(SshError::PoolNotInitialized)?;

    match pool.get_session(&id, &host, port, &username, &password) {
        Ok(_) => {
            let mut connections = state.connections.lock().unwrap();
            if let Some(conn) = connections.iter_mut().find(|c| c.id == id) {
                conn.connected = true;
            }
            Ok(true)
        }
        Err(e) => {
            let mut connections = state.connections.lock().unwrap();
            if let Some(conn) = connections.iter_mut().find(|c| c.id == id) {
                conn.connected = false;
            }
            Err(e)
        }
    }
}

#[tauri::command]
pub fn disconnect_ssh(state: State<SshState>, id: String) -> Result<bool, SshError> {
    let pool_guard = state.connection_pool.lock().unwrap();
    if let Some(pool) = pool_guard.as_ref() {
        pool.remove_session(&id);
    }

    let mut connections = state.connections.lock().unwrap();
    if let Some(conn) = connections.iter_mut().find(|c| c.id == id) {
        conn.connected = false;
        Ok(true)
    } else {
        Err(SshError::ConnectionNotFound)
    }
}

#[tauri::command]
pub fn execute_ssh_command(
    state: State<SshState>,
    id: String,
    command: String,
) -> Result<String, SshError> {
    let (host, port, username, password) = {
        let connections = state.connections.lock().unwrap();
        let conn = SshState::get_connection_info(&connections, &id, true)?;
        (conn.host, conn.port, conn.username, conn.password)
    };

    let pool_guard = state.connection_pool.lock().unwrap();
    let pool = pool_guard.as_ref().ok_or(SshError::PoolNotInitialized)?;

    let sess = pool.get_session(&id, &host, port, &username, &password)?;

    let sess = sess.lock().unwrap();
    let mut channel = sess
        .channel_session()
        .map_err(|e| SshError::ChannelFailed(e.to_string()))?;

    channel
        .exec(&command)
        .map_err(|e| SshError::CommandFailed(e.to_string()))?;

    let mut output = String::new();
    channel
        .read_to_string(&mut output)
        .map_err(|e| SshError::ReadFailed(e.to_string()))?;

    channel
        .wait_close()
        .map_err(|e| SshError::ChannelCloseFailed(e.to_string()))?;

    Ok(output)
}

#[tauri::command]
pub fn scp_upload(
    state: State<SshState>,
    id: String,
    local_path: String,
    remote_path: String,
) -> Result<String, SshError> {
    let (host, port, username, password) = {
        let connections = state.connections.lock().unwrap();
        let conn = SshState::get_connection_info(&connections, &id, true)?;
        (conn.host, conn.port, conn.username, conn.password)
    };

    let app_handle = state.app_handle.clone();
    let pool = state.connection_pool.clone();
    let id_clone = id.clone();
    let local_path_clone = local_path.clone();
    let remote_path_clone = remote_path.clone();

    thread::spawn(move || {
        let result = (|| -> Result<String, SshError> {
            let pool_guard = pool.lock().unwrap();
            let pool = pool_guard.as_ref().ok_or(SshError::PoolNotInitialized)?;

            let sess = pool.get_session(&id_clone, &host, port, &username, &password)?;

            let sess = sess.lock().unwrap();
            let sftp = sess
                .sftp()
                .map_err(|e| SshError::SftpFailed(e.to_string()))?;

            let local_file = std::fs::File::open(&local_path_clone)
                .map_err(|e| SshError::FileOperationFailed(format!("无法打开本地文件: {}", e)))?;

            let file_size = local_file
                .metadata()
                .map_err(|e| SshError::FileOperationFailed(format!("获取文件大小失败: {}", e)))?
                .len();

            let mut remote_file = sftp
                .create(std::path::Path::new(&remote_path_clone))
                .map_err(|e| SshError::FileOperationFailed(format!("无法创建远程文件: {}", e)))?;

            let mut buffer = vec![0; UPLOAD_BUFFER_SIZE];
            let mut total_read = 0u64;
            let mut last_progress = 0u64;
            let mut last_update_time = Instant::now();
            let mut reader = std::io::BufReader::new(local_file);

            while let Ok(n) = reader.read(&mut buffer) {
                if n == 0 {
                    break;
                }
                remote_file
                    .write_all(&buffer[0..n])
                    .map_err(|e| SshError::FileOperationFailed(format!("文件写入失败: {}", e)))?;
                total_read += n as u64;

                if file_size > 0 {
                    let progress = (total_read * 100) / file_size;
                    let now = Instant::now();
                    if progress > last_progress
                        && now.duration_since(last_update_time)
                            > Duration::from_millis(PROGRESS_UPDATE_INTERVAL_MS as u64)
                    {
                        last_progress = progress;
                        last_update_time = now;
                        let app_handle = app_handle.lock().unwrap();
                        if let Some(handle) = &*app_handle {
                            let _ = handle.emit(
                                "upload-progress",
                                json!({
                                    "id": id_clone.clone(),
                                    "progress": progress,
                                    "total": file_size,
                                    "current": total_read
                                }),
                            );
                        }
                    }
                }
            }

            remote_file.flush()?;
            drop(remote_file);
            drop(sftp);

            Ok("上传成功".to_string())
        })();

        let app_handle = app_handle.lock().unwrap();
        if let Some(handle) = &*app_handle {
            let (success, message) = match &result {
                Ok(msg) => (true, msg.clone()),
                Err(e) => (false, e.to_string()),
            };
            let _ = handle.emit(
                "upload-complete",
                json!({
                    "id": id_clone,
                    "success": success,
                    "message": message
                }),
            );
        }
    });

    Ok("上传开始".to_string())
}

#[tauri::command]
pub fn scp_download(
    state: State<SshState>,
    id: String,
    remote_path: String,
    local_path: String,
) -> Result<String, SshError> {
    let (host, port, username, password) = {
        let connections = state.connections.lock().unwrap();
        let conn = SshState::get_connection_info(&connections, &id, true)?;
        (conn.host, conn.port, conn.username, conn.password)
    };

    let app_handle = state.app_handle.clone();
    let pool = state.connection_pool.clone();
    let id_clone = id.clone();
    let remote_path_clone = remote_path.clone();
    let local_path_clone = local_path.clone();

    thread::spawn(move || {
        let result = (|| -> Result<String, SshError> {
            let pool_guard = pool.lock().unwrap();
            let pool = pool_guard.as_ref().ok_or(SshError::PoolNotInitialized)?;

            let sess = pool.get_session(&id_clone, &host, port, &username, &password)?;

            let sess = sess.lock().unwrap();
            let sftp = sess
                .sftp()
                .map_err(|e| SshError::SftpFailed(e.to_string()))?;

            let mut remote_file = sftp
                .open(std::path::Path::new(&remote_path_clone))
                .map_err(|e| SshError::FileOperationFailed(format!("无法打开远程文件: {}", e)))?;

            let file_size = remote_file
                .stat()
                .map_err(|e| SshError::FileOperationFailed(format!("获取文件大小失败: {}", e)))?
                .size
                .unwrap_or(0);

            let local_file = std::fs::File::create(&local_path_clone)
                .map_err(|e| SshError::FileOperationFailed(format!("无法创建本地文件: {}", e)))?;

            let mut buffer = vec![0; UPLOAD_BUFFER_SIZE];
            let mut total_read = 0u64;
            let mut last_progress = 0u64;
            let mut last_update_time = Instant::now();
            let mut writer = std::io::BufWriter::new(local_file);

            while let Ok(n) = remote_file.read(&mut buffer) {
                if n == 0 {
                    break;
                }
                writer
                    .write_all(&buffer[0..n])
                    .map_err(|e| SshError::FileOperationFailed(format!("文件写入失败: {}", e)))?;
                total_read += n as u64;

                if file_size > 0 {
                    let progress = (total_read * 100) / file_size;
                    let now = Instant::now();
                    if progress > last_progress
                        && now.duration_since(last_update_time)
                            > Duration::from_millis(PROGRESS_UPDATE_INTERVAL_MS as u64)
                    {
                        last_progress = progress;
                        last_update_time = now;
                        let app_handle = app_handle.lock().unwrap();
                        if let Some(handle) = &*app_handle {
                            let _ = handle.emit(
                                "download-progress",
                                json!({
                                    "id": id_clone.clone(),
                                    "progress": progress,
                                    "total": file_size,
                                    "current": total_read
                                }),
                            );
                        }
                    }
                }
            }

            writer.flush()?;
            drop(remote_file);
            drop(sftp);

            Ok("下载成功".to_string())
        })();

        let app_handle = app_handle.lock().unwrap();
        if let Some(handle) = &*app_handle {
            let (success, message) = match &result {
                Ok(msg) => (true, msg.clone()),
                Err(e) => (false, e.to_string()),
            };
            let _ = handle.emit(
                "download-complete",
                json!({
                    "id": id_clone,
                    "success": success,
                    "message": message
                }),
            );
        }
    });

    Ok("下载开始".to_string())
}

#[tauri::command]
pub fn list_sftp_directory(
    state: State<SshState>,
    id: String,
    remote_path: String,
) -> Result<String, SshError> {
    let (host, port, username, password) = {
        let connections = state.connections.lock().unwrap();
        let conn = SshState::get_connection_info(&connections, &id, true)?;
        (conn.host, conn.port, conn.username, conn.password)
    };

    let pool_guard = state.connection_pool.lock().unwrap();
    let pool = pool_guard.as_ref().ok_or(SshError::PoolNotInitialized)?;

    let sess = pool.get_session(&id, &host, port, &username, &password)?;

    let sess = sess.lock().unwrap();
    let sftp = sess
        .sftp()
        .map_err(|e| SshError::SftpFailed(e.to_string()))?;

    let entries = sftp
        .readdir(std::path::Path::new(&remote_path))
        .map_err(|e| SshError::ReadDirFailed(e.to_string()))?;

    let mut files = Vec::new();
    for (path, stat) in entries {
        if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
            if name == "." || name == ".." {
                continue;
            }
            let is_directory = stat.is_dir();
            let size = if is_directory {
                0
            } else {
                stat.size.unwrap_or(0)
            };
            files.push(json!({
                "name": name,
                "isDirectory": is_directory,
                "size": size
            }));
        }
    }

    let result = json!({ "files": files });
    Ok(result.to_string())
}

#[tauri::command]
pub fn remove_ssh_connection(state: State<SshState>, id: String) -> Result<bool, SshError> {
    let mut connections = state.connections.lock().unwrap();
    let initial_len = connections.len();
    connections.retain(|c| c.id != id);
    let new_len = connections.len();
    Ok(initial_len > new_len)
}