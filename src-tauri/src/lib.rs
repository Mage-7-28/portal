// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
mod ssh;

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(ssh::SshState::default())
        .invoke_handler(tauri::generate_handler![
            greet,
            ssh::add_ssh_connection,
            ssh::list_ssh_connections,
            ssh::connect_ssh,
            ssh::disconnect_ssh,
            ssh::execute_ssh_command,
            ssh::scp_upload,
            ssh::scp_download
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
