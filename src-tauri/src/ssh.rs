use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;
use std::io::Read;
use tauri::State;
use ssh2::Session;
use std::net::TcpStream;

#[derive(Default)]
pub struct SshState {
    pub connections: Arc<Mutex<Vec<SshConnection>>>,
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
    let connection = SshConnection {
        id: id.clone(),
        host,
        port,
        username,
        password,
        connected: false,
    };

    let mut connections = state.connections.lock().unwrap();
    
    // 检查连接是否已存在
    if let Some(existing) = connections.iter().find(|c| c.id == id) {
        return Ok(existing.id.clone());
    }
    
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
    let mut connections = state.connections.lock().unwrap();
    if let Some(connection) = connections.iter_mut().find(|c| c.id == id) {
        let tcp = TcpStream::connect(format!("{}:{}", connection.host, connection.port))
            .map_err(|e| format!("无法连接到服务器: {}", e))?;
        
        let mut sess = Session::new()
            .map_err(|e| format!("创建SSH会话失败: {}", e))?;
        
        sess.set_tcp_stream(tcp);
        sess.handshake()
            .map_err(|e| format!("SSH握手失败: {}", e))?;
        
        sess.userauth_password(&connection.username, &connection.password)
            .map_err(|e| format!("认证失败: {}", e))?;
        
        if sess.authenticated() {
            connection.connected = true;
            Ok(true)
        } else {
            Err("认证失败".to_string())
        }
    } else {
        Err("连接不存在".to_string())
    }
}

#[tauri::command]
pub fn disconnect_ssh(state: State<SshState>, id: String) -> Result<bool, String> {
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
    let connections = state.connections.lock().unwrap();
    if let Some(_connection) = connections.iter().find(|c| c.id == id && c.connected) {
        let tcp = TcpStream::connect(format!("{}:{}", _connection.host, _connection.port))
            .map_err(|e| format!("无法连接到服务器: {}", e))?;
        
        let mut sess = Session::new()
            .map_err(|e| format!("创建SSH会话失败: {}", e))?;
        
        sess.set_tcp_stream(tcp);
        sess.handshake()
            .map_err(|e| format!("SSH握手失败: {}", e))?;
        
        sess.userauth_password(&_connection.username, &_connection.password)
            .map_err(|e| format!("认证失败: {}", e))?;
        
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
    } else {
        Err("连接不存在或未连接".to_string())
    }
}

#[tauri::command]
pub fn scp_upload(
    state: State<SshState>,
    id: String,
    local_path: String,
    remote_path: String,
) -> Result<String, String> {
    let connections = state.connections.lock().unwrap();
    if let Some(_connection) = connections.iter().find(|c| c.id == id && c.connected) {
        let tcp = TcpStream::connect(format!("{}:{}", _connection.host, _connection.port))
            .map_err(|e| format!("无法连接到服务器: {}", e))?;
        
        let mut sess = Session::new()
            .map_err(|e| format!("创建SSH会话失败: {}", e))?;
        
        sess.set_tcp_stream(tcp);
        sess.handshake()
            .map_err(|e| format!("SSH握手失败: {}", e))?;
        
        sess.userauth_password(&_connection.username, &_connection.password)
            .map_err(|e| format!("认证失败: {}", e))?;
        
        let sftp = sess.sftp()
            .map_err(|e| format!("创建SFTP会话失败: {}", e))?;
        
        let local_file = std::fs::File::open(&local_path)
            .map_err(|e| format!("无法打开本地文件: {}", e))?;
        
        let mut remote_file = sftp.create(std::path::Path::new(&remote_path))
            .map_err(|e| format!("无法创建远程文件: {}", e))?;
        
        let mut reader = std::io::BufReader::new(local_file);
        std::io::copy(&mut reader, &mut remote_file)
            .map_err(|e| format!("文件传输失败: {}", e))?;
        
        Ok("上传成功".to_string())
    } else {
        Err("连接不存在或未连接".to_string())
    }
}

#[tauri::command]
pub fn scp_download(
    state: State<SshState>,
    id: String,
    remote_path: String,
    local_path: String,
) -> Result<String, String> {
    let connections = state.connections.lock().unwrap();
    if let Some(_connection) = connections.iter().find(|c| c.id == id && c.connected) {
        let tcp = TcpStream::connect(format!("{}:{}", _connection.host, _connection.port))
            .map_err(|e| format!("无法连接到服务器: {}", e))?;
        
        let mut sess = Session::new()
            .map_err(|e| format!("创建SSH会话失败: {}", e))?;
        
        sess.set_tcp_stream(tcp);
        sess.handshake()
            .map_err(|e| format!("SSH握手失败: {}", e))?;
        
        sess.userauth_password(&_connection.username, &_connection.password)
            .map_err(|e| format!("认证失败: {}", e))?;
        
        let sftp = sess.sftp()
            .map_err(|e| format!("创建SFTP会话失败: {}", e))?;
        
        let mut remote_file = sftp.open(std::path::Path::new(&remote_path))
            .map_err(|e| format!("无法打开远程文件: {}", e))?;
        
        let local_file = std::fs::File::create(&local_path)
            .map_err(|e| format!("无法创建本地文件: {}", e))?;
        
        let mut writer = std::io::BufWriter::new(local_file);
        std::io::copy(&mut remote_file, &mut writer)
            .map_err(|e| format!("文件传输失败: {}", e))?;
        
        Ok("下载成功".to_string())
    } else {
        Err("连接不存在或未连接".to_string())
    }
}

#[tauri::command]
pub fn list_sftp_directory(
    state: State<SshState>,
    id: String,
    remote_path: String,
) -> Result<String, String> {
    use serde_json::json;
    
    let connections = state.connections.lock().unwrap();
    if let Some(_connection) = connections.iter().find(|c| c.id == id && c.connected) {
        let tcp = TcpStream::connect(format!("{}:{}", _connection.host, _connection.port))
            .map_err(|e| format!("无法连接到服务器: {}", e))?;
        
        let mut sess = Session::new()
            .map_err(|e| format!("创建SSH会话失败: {}", e))?;
        
        sess.set_tcp_stream(tcp);
        sess.handshake()
            .map_err(|e| format!("SSH握手失败: {}", e))?;
        
        sess.userauth_password(&_connection.username, &_connection.password)
            .map_err(|e| format!("认证失败: {}", e))?;
        
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
    } else {
        Err("连接不存在或未连接".to_string())
    }
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
