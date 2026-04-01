use std::process::Command;
use std::sync::Arc;
use std::sync::Mutex;
use tauri::State;

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
pub fn add_ssh_connection(
    state: State<SshState>,
    host: String,
    port: u16,
    username: String,
    password: String,
) -> Result<String, String> {
    let id = format!("{}-{}", host, port);
    let connection = SshConnection {
        id: id.clone(),
        host,
        port,
        username,
        password,
        connected: false,
    };

    let mut connections = state.connections.lock().unwrap();
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
        // 这里应该使用 ssh2 库来实现 SSH 连接
        // 由于复杂，这里我们使用系统命令来模拟
        connection.connected = true;
        Ok(true)
    } else {
        Err("Connection not found".to_string())
    }
}

#[tauri::command]
pub fn disconnect_ssh(state: State<SshState>, id: String) -> Result<bool, String> {
    let mut connections = state.connections.lock().unwrap();
    if let Some(connection) = connections.iter_mut().find(|c| c.id == id) {
        connection.connected = false;
        Ok(true)
    } else {
        Err("Connection not found".to_string())
    }
}

#[tauri::command]
pub fn execute_ssh_command(
    state: State<SshState>,
    id: String,
    command: String,
) -> Result<String, String> {
    let connections = state.connections.lock().unwrap();
    if let Some(connection) = connections.iter().find(|c| c.id == id && c.connected) {
        // 使用系统命令来执行 SSH 命令
        let output = Command::new("ssh")
            .arg(format!(
                "{}@{}:{}",
                connection.username, connection.host, connection.port
            ))
            .arg(command)
            .output()
            .map_err(|e| e.to_string())?;

        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);

        if output.status.success() {
            Ok(stdout.to_string())
        } else {
            Err(stderr.to_string())
        }
    } else {
        Err("Connection not found or not connected".to_string())
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
    if let Some(connection) = connections.iter().find(|c| c.id == id && c.connected) {
        // 使用系统命令来执行 SCP 上传
        let output = Command::new("scp")
            .arg(local_path)
            .arg(format!(
                "{}@{}:{}",
                connection.username, connection.host, remote_path
            ))
            .output()
            .map_err(|e| e.to_string())?;

        let stderr = String::from_utf8_lossy(&output.stderr);

        if output.status.success() {
            Ok("Upload successful".to_string())
        } else {
            Err(stderr.to_string())
        }
    } else {
        Err("Connection not found or not connected".to_string())
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
    if let Some(connection) = connections.iter().find(|c| c.id == id && c.connected) {
        // 使用系统命令来执行 SCP 下载
        let output = Command::new("scp")
            .arg(format!(
                "{}@{}:{}",
                connection.username, connection.host, remote_path
            ))
            .arg(local_path)
            .output()
            .map_err(|e| e.to_string())?;

        let stderr = String::from_utf8_lossy(&output.stderr);

        if output.status.success() {
            Ok("Download successful".to_string())
        } else {
            Err(stderr.to_string())
        }
    } else {
        Err("Connection not found or not connected".to_string())
    }
}
