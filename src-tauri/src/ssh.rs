use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;
use std::time::Instant;
use std::io::{Read, Write};
use tauri::{State, AppHandle, Emitter};
use ssh2::Session;
use std::net::TcpStream;
use std::thread;
use std::collections::HashMap;

#[derive(Default)]
pub struct SshState {
    pub connections: Arc<Mutex<Vec<SshConnection>>>,
    pub connection_pool: Arc<Mutex<Option<SshConnectionPool>>>,
    pub app_handle: Arc<Mutex<Option<AppHandle>>>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SshConnection {
    pub id: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: String,
    pub connected: bool,
}

// 连接池中的活跃会话
struct ActiveSession {
    session: Arc<Mutex<Session>>,
    last_used: Instant,
}

// SSH连接池
pub struct SshConnectionPool {
    sessions: Arc<Mutex<HashMap<String, ActiveSession>>>,
}

impl SshConnectionPool {
    pub fn new() -> Self {
        let pool = Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
        };

        // 启动连接保活任务
        pool.start_keepalive();
        pool
    }
    
    // 获取或创建SSH会话
    pub fn get_session(&self, id: &str, host: &str, port: u16, username: &str, password: &str) -> Result<Arc<Mutex<Session>>, String> {
        let mut sessions = self.sessions.lock().unwrap();
        
        // 尝试从缓存获取
        if let Some(active) = sessions.get_mut(id) {
            // 检查连接是否仍然有效
            if self.is_session_alive(&active.session) {
                active.last_used = Instant::now();
                return Ok(active.session.clone());
            } else {
                // 连接已失效，移除并重新创建
                sessions.remove(id);
            }
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
    
    // 创建SSH连接
    fn create_ssh_connection(&self, host: &str, port: u16, username: &str, password: &str) -> Result<Session, String> {
        let timeout_duration = Duration::from_millis(30000);

        let tcp = TcpStream::connect(format!("{}:{}", host, port))
            .map_err(|e| format!("无法连接到服务器: {}", e))?;

        tcp.set_read_timeout(Some(timeout_duration))
            .map_err(|e| format!("设置读取超时失败: {}", e))?;
        tcp.set_write_timeout(Some(timeout_duration))
            .map_err(|e| format!("设置写入超时失败: {}", e))?;

        let mut sess = Session::new()
            .map_err(|e| format!("创建SSH会话失败: {}", e))?;

        sess.set_tcp_stream(tcp);
        sess.handshake()
            .map_err(|e| format!("SSH握手失败: {}", e))?;

        sess.userauth_password(username, password)
            .map_err(|e| format!("认证失败: {}", e))?;

        if !sess.authenticated() {
            return Err("认证失败".to_string());
        }

        Ok(sess)
    }
    
    // 检查会话是否存活
    fn is_session_alive(&self, session: &Arc<Mutex<Session>>) -> bool {
        // 通过执行简单命令检测连接状态
        let session = session.lock().unwrap();
        match session.channel_session() {
            Ok(mut channel) => {
                match channel.exec("echo alive") {
                    Ok(_) => {
                        let mut output = String::new();
                        channel.read_to_string(&mut output).is_ok()
                    }
                    Err(_) => false
                }
            }
            Err(_) => false
        }
    }
    
    // 启动连接保活任务
    fn start_keepalive(&self) {
        let sessions = self.sessions.clone();
        std::thread::spawn(move || {
            loop {
                std::thread::sleep(Duration::from_secs(60)); // 每分钟检查一次
                
                let mut sessions = sessions.lock().unwrap();
                let mut dead_sessions = Vec::new();
                
                for (id, active) in sessions.iter_mut() {
                    // 检查连接是否超时（超过5分钟未使用）
                    if active.last_used.elapsed() > Duration::from_secs(300) {
                        dead_sessions.push(id.clone());
                    }
                }
                
                // 移除失效连接
                for id in dead_sessions {
                    sessions.remove(&id);
                }
            }
        });
    }
    
    // 从连接池移除会话
    pub fn remove_session(&self, id: &str) {
        let mut sessions = self.sessions.lock().unwrap();
        if let Some(active) = sessions.remove(id) {
            // 优雅地关闭SSH会话
            let session = active.session.lock().unwrap();
            let _ = session.disconnect(None, "用户主动断开连接", None);
        }
    }
}

#[tauri::command]
pub fn test_sftp_connection(
    host: String,
    port: u16,
    username: String,
    password: String,
    timeout: Option<u64>,
) -> Result<String, String> {
    let timeout_duration = Duration::from_millis(timeout.unwrap_or(30000));

    let tcp = TcpStream::connect(format!("{}:{}", host, port))
        .map_err(|e| format!("无法连接到服务器 {}: {}", host, e))?;

    tcp.set_read_timeout(Some(timeout_duration))
        .map_err(|e| format!("设置读取超时失败: {}", e))?;
    tcp.set_write_timeout(Some(timeout_duration))
        .map_err(|e| format!("设置写入超时失败: {}", e))?;

    let mut sess = Session::new()
        .map_err(|e| format!("创建SSH会话失败: {}", e))?;

    sess.set_tcp_stream(tcp);
    sess.handshake()
        .map_err(|e| format!("SSH握手失败: {}", e))?;

    sess.userauth_password(&username, &password)
        .map_err(|e| format!("认证失败: {}", e))?;

    if sess.authenticated() {
        sess.disconnect(None, "测试连接成功", None)
            .unwrap_or_else(|e| eprintln!("断开连接时出错: {}", e));
        Ok("连接测试成功".to_string())
    } else {
        Err("认证失败，请检查用户名和密码".to_string())
    }
}

#[tauri::command]
pub fn add_ssh_connection(
    state: State<SshState>,
    host: String,
    port: u16,
    username: String,
    password: String,
) -> Result<String, String> {
    let id = format!("{}-{}-{}", host, port, username);
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
pub fn list_ssh_connections(state: State<SshState>) -> Result<Vec<SshConnection>, String> {
    let connections = state.connections.lock().unwrap();
    Ok(connections.clone())
}

#[tauri::command]
pub fn connect_ssh(state: State<SshState>, id: String) -> Result<bool, String> {
    // 获取连接信息
    let (host, port, username, password) = {
        let connections = state.connections.lock().unwrap();
        if let Some(connection) = connections.iter().find(|c| c.id == id) {
            (connection.host.clone(), connection.port, 
             connection.username.clone(), connection.password.clone())
        } else {
            return Err("连接不存在".to_string());
        }
    };
    
    // 初始化连接池（如果尚未初始化）
    {
        let mut pool_guard = state.connection_pool.lock().unwrap();
        if pool_guard.is_none() {
            *pool_guard = Some(SshConnectionPool::new());
        }
    }
    
    // 通过连接池创建并缓存会话
    let pool_guard = state.connection_pool.lock().unwrap();
    let pool = pool_guard.as_ref().ok_or("连接池初始化失败")?;
    
    match pool.get_session(&id, &host, port, &username, &password) {
        Ok(_) => {
            // 更新连接状态
            let mut connections = state.connections.lock().unwrap();
            if let Some(connection) = connections.iter_mut().find(|c| c.id == id) {
                connection.connected = true;
            }
            Ok(true)
        }
        Err(e) => {
            // 连接失败，确保状态正确
            let mut connections = state.connections.lock().unwrap();
            if let Some(connection) = connections.iter_mut().find(|c| c.id == id) {
                connection.connected = false;
            }
            Err(e)
        }
    }
}

#[tauri::command]
pub fn disconnect_ssh(state: State<SshState>, id: String) -> Result<bool, String> {
    // 从连接池移除会话
    let pool_guard = state.connection_pool.lock().unwrap();
    if let Some(pool) = pool_guard.as_ref() {
        pool.remove_session(&id);
    }
    
    // 更新连接状态
    let mut connections = state.connections.lock().unwrap();
    if let Some(connection) = connections.iter_mut().find(|c| c.id == id) {
        connection.connected = false;
        Ok(true)
    } else {
        Err("连接不存在".to_string())
    }
}

#[tauri::command]
pub fn execute_ssh_command(
    state: State<SshState>,
    id: String,
    command: String,
) -> Result<String, String> {
    // 获取连接信息
    let (host, port, username, password) = {
        let connections = state.connections.lock().unwrap();
        if let Some(connection) = connections.iter().find(|c| c.id == id && c.connected) {
            (connection.host.clone(), connection.port, 
             connection.username.clone(), connection.password.clone())
        } else {
            return Err("连接不存在或未连接".to_string());
        }
    };
    
    // 从连接池获取会话
    let pool_guard = state.connection_pool.lock().unwrap();
    let pool = pool_guard.as_ref().ok_or("连接池未初始化")?;
    
    let sess = pool.get_session(&id, &host, port, &username, &password)?;

    // 执行命令
    let sess = sess.lock().unwrap();
    let mut channel = sess.channel_session()
        .map_err(|e| format!("创建通道失败: {}", e))?;

    channel.exec(&command)
        .map_err(|e| format!("执行命令失败: {}", e))?;

    let mut output = String::new();
    channel.read_to_string(&mut output)
        .map_err(|e| format!("读取输出失败: {}", e))?;

    channel.wait_close()
        .map_err(|e| format!("关闭通道失败: {}", e))?;

    Ok(output)
}

#[tauri::command]
pub fn scp_upload(
    state: State<SshState>,
    id: String,
    local_path: String,
    remote_path: String,
) -> Result<String, String> {
    // 获取连接信息
    let (host, port, username, password) = {
        let connections = state.connections.lock().unwrap();
        if let Some(connection) = connections.iter().find(|c| c.id == id && c.connected) {
            (connection.host.clone(), connection.port, connection.username.clone(), connection.password.clone())
        } else {
            return Err("连接不存在或未连接".to_string());
        }
    };

    let app_handle = state.app_handle.clone();
    let pool = state.connection_pool.clone();
    let id_clone = id.clone();
    let local_path_clone = local_path.clone();
    let remote_path_clone = remote_path.clone();

    // 在后台线程中执行上传，避免阻塞主线程
    thread::spawn(move || {
        let result = (|| -> Result<String, String> {
            // 从连接池获取会话
            let pool_guard = pool.lock().unwrap();
            let pool = pool_guard.as_ref().ok_or("连接池未初始化")?;
            
            let sess = pool.get_session(&id_clone, &host, port, &username, &password)?;

            let sess = sess.lock().unwrap();
            let sftp = sess.sftp()
                .map_err(|e| format!("创建SFTP会话失败: {}", e))?;

            let local_file = std::fs::File::open(&local_path_clone)
                .map_err(|e| format!("无法打开本地文件: {}", e))?;

            let file_size = local_file.metadata()
                .map_err(|e| format!("获取文件大小失败: {}", e))?
                .len();

            let mut remote_file = sftp.create(std::path::Path::new(&remote_path_clone))
                .map_err(|e| format!("无法创建远程文件: {}", e))?;

            // 优化缓冲区大小，使用更大的缓冲区提升传输效率
            let mut buffer = vec![0; 65536]; // 64KB缓冲区
            let mut total_read = 0u64;
            let mut last_progress = 0u64;
            let mut last_update_time = Instant::now();
            let mut reader = std::io::BufReader::new(local_file);

            while let Ok(n) = reader.read(&mut buffer) {
                if n == 0 { break; }
                remote_file.write_all(&buffer[0..n])
                    .map_err(|e| format!("文件写入失败: {}", e))?;
                total_read += n as u64;

                if file_size > 0 {
                    let progress = (total_read * 100) / file_size;
                    // 优化进度更新：只在进度变化超过1%且距离上次更新超过100ms时才发送事件
                    let now = Instant::now();
                    if progress > last_progress && now.duration_since(last_update_time) > Duration::from_millis(100) {
                        last_progress = progress;
                        last_update_time = now;
                        // 发送进度事件
                        {
                            let app_handle = app_handle.lock().unwrap();
                            if let Some(app_handle) = &*app_handle {
                                let _ = app_handle.emit("upload-progress", serde_json::json!({
                                    "id": id_clone.clone(),
                                    "progress": progress,
                                    "total": file_size,
                                    "current": total_read
                                }));
                            }
                        }
                    }
                }
            }

            // 确保所有数据都已写入
            remote_file.flush()
                .map_err(|e| format!("刷新文件缓冲区失败: {}", e))?;

            // 显式关闭远程文件
            drop(remote_file);
            // 显式关闭SFTP会话
            drop(sftp);

            Ok("上传成功".to_string())
        })();

        // 发送完成事件
        {
            let app_handle = app_handle.lock().unwrap();
            if let Some(app_handle) = &*app_handle {
                match result {
                    Ok(msg) => {
                        let _ = app_handle.emit("upload-complete", serde_json::json!({
                            "id": id_clone,
                            "success": true,
                            "message": msg
                        }));
                    },
                    Err(err) => {
                        let _ = app_handle.emit("upload-complete", serde_json::json!({
                            "id": id_clone,
                            "success": false,
                            "message": err
                        }));
                    }
                }
            }
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
) -> Result<String, String> {
    println!("scp_download 被调用: id={}, remote={}, local={}", id, remote_path, local_path);
    
    // 获取连接信息
    let (host, port, username, password) = {
        let connections = state.connections.lock().unwrap();
        if let Some(connection) = connections.iter().find(|c| c.id == id && c.connected) {
            (connection.host.clone(), connection.port, connection.username.clone(), connection.password.clone())
        } else {
            return Err("连接不存在或未连接".to_string());
        }
    };

    let app_handle = state.app_handle.clone();
    let pool = state.connection_pool.clone();
    let id_clone = id.clone();
    let remote_path_clone = remote_path.clone();
    let local_path_clone = local_path.clone();

    // 在后台线程中执行下载，避免阻塞主线程
    thread::spawn(move || {
        println!("开始后台下载线程");
        let result = (|| -> Result<String, String> {
            println!("从连接池获取会话");
            // 从连接池获取会话
            let pool_guard = pool.lock().unwrap();
            let pool = pool_guard.as_ref().ok_or("连接池未初始化")?;
            
            let sess = pool.get_session(&id_clone, &host, port, &username, &password)?;

            let sess = sess.lock().unwrap();
            let sftp = sess.sftp()
                .map_err(|e| format!("创建SFTP会话失败: {}", e))?;

            println!("打开远程文件: {}", remote_path_clone);
            let mut remote_file = sftp.open(std::path::Path::new(&remote_path_clone))
                .map_err(|e| format!("无法打开远程文件: {}", e))?;

            let file_size = remote_file.stat()
                .map_err(|e| format!("获取文件大小失败: {}", e))?
                .size
                .unwrap_or(0);
            
            println!("文件大小: {} 字节", file_size);

            println!("创建本地文件: {}", local_path_clone);
            let local_file = std::fs::File::create(&local_path_clone)
                .map_err(|e| format!("无法创建本地文件: {}", e))?;

            // 优化缓冲区大小，使用更大的缓冲区提升传输效率
            let mut buffer = vec![0; 65536]; // 64KB缓冲区
            let mut total_read = 0u64;
            let mut last_progress = 0u64;
            let mut last_update_time = Instant::now();
            let mut writer = std::io::BufWriter::new(local_file);

            println!("开始读取文件数据");
            while let Ok(n) = remote_file.read(&mut buffer) {
                if n == 0 { break; }
                writer.write_all(&buffer[0..n])
                    .map_err(|e| format!("文件写入失败: {}", e))?;
                total_read += n as u64;

                if file_size > 0 {
                    let progress = (total_read * 100) / file_size;
                    // 优化进度更新：只在进度变化超过1%且距离上次更新超过100ms时才发送事件
                    let now = Instant::now();
                    if progress > last_progress && now.duration_since(last_update_time) > Duration::from_millis(100) {
                        last_progress = progress;
                        last_update_time = now;
                        println!("下载进度: {}%", progress);
                        // 发送进度事件
                        {
                            let app_handle = app_handle.lock().unwrap();
                            if let Some(app_handle) = &*app_handle {
                                let _ = app_handle.emit("download-progress", serde_json::json!({
                                    "id": id_clone.clone(),
                                    "progress": progress,
                                    "total": file_size,
                                    "current": total_read
                                }));
                            }
                        }
                    }
                }
            }

            // 确保所有数据都已写入
            writer.flush()
                .map_err(|e| format!("刷新文件缓冲区失败: {}", e))?;

            // 显式关闭远程文件
            drop(remote_file);
            // 显式关闭SFTP会话
            drop(sftp);

            println!("文件下载完成，共读取 {} 字节", total_read);
            Ok("下载成功".to_string())
        })();

        // 发送完成事件
        println!("发送完成事件，结果: {:?}", result);
        {
            let app_handle = app_handle.lock().unwrap();
            if let Some(app_handle) = &*app_handle {
                match result {
                    Ok(msg) => {
                        let _ = app_handle.emit("download-complete", serde_json::json!({
                            "id": id_clone,
                            "success": true,
                            "message": msg
                        }));
                    },
                    Err(err) => {
                        let _ = app_handle.emit("download-complete", serde_json::json!({
                            "id": id_clone,
                            "success": false,
                            "message": err
                        }));
                    }
                }
            } else {
                println!("警告: app_handle 为空，无法发送完成事件");
            }
        }
    });

    println!("scp_download 命令返回: 下载开始");
    Ok("下载开始".to_string())
}

#[tauri::command]
pub fn list_sftp_directory(
    state: State<SshState>,
    id: String,
    remote_path: String,
) -> Result<String, String> {
    use serde_json::json;

    // 获取连接信息
    let (host, port, username, password) = {
        let connections = state.connections.lock().unwrap();
        if let Some(connection) = connections.iter().find(|c| c.id == id && c.connected) {
            (connection.host.clone(), connection.port, 
             connection.username.clone(), connection.password.clone())
        } else {
            return Err("连接不存在或未连接".to_string());
        }
    };
    
    // 从连接池获取会话
    let pool_guard = state.connection_pool.lock().unwrap();
    let pool = pool_guard.as_ref().ok_or("连接池未初始化")?;
    
    let sess = pool.get_session(&id, &host, port, &username, &password)?;

    let sess = sess.lock().unwrap();
    let sftp = sess.sftp()
        .map_err(|e| format!("创建SFTP会话失败: {}", e))?;

    let entries = sftp.readdir(std::path::Path::new(&remote_path))
        .map_err(|e| format!("读取目录失败: {}", e))?;

    let mut files = Vec::new();
    for (path, stat) in entries {
        if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
            if name == "." || name == ".." {
                continue;
            }

            let is_directory = stat.is_dir();
            let size = if is_directory { 0 } else { stat.size.unwrap_or(0) };

            files.push(json!({"name": name, "isDirectory": is_directory, "size": size}));
        }
    }

    let result = json!({"files": files});
    Ok(result.to_string())
}

#[tauri::command]
pub fn remove_ssh_connection(
    state: State<SshState>,
    id: String,
) -> Result<bool, String> {
    let mut connections = state.connections.lock().unwrap();
    let initial_len = connections.len();
    connections.retain(|c| c.id != id);
    let new_len = connections.len();
    Ok(initial_len > new_len)
}
