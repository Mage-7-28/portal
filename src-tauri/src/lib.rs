// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
mod ssh;

use std::path::Path;

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[derive(serde::Serialize)]
struct FileEntry {
    name: String,
    #[serde(rename = "isDirectory")]
    is_directory: bool,
    size: u64,
}

#[tauri::command]
fn get_home_dir() -> Result<String, String> {
    dirs::home_dir()
        .map(|path| path.to_string_lossy().to_string())
        .ok_or_else(|| "Failed to get home directory".to_string())
}

#[tauri::command]
fn read_directory(path: &str) -> Result<Vec<FileEntry>, String> {
    let path = Path::new(path);
    
    if !path.exists() {
        return Err("Path does not exist".to_string());
    }
    
    if !path.is_dir() {
        return Err("Path is not a directory".to_string());
    }
    
    let mut entries = Vec::new();
    
    match std::fs::read_dir(path) {
        Ok(dir_entries) => {
            for entry in dir_entries {
                if let Ok(entry) = entry {
                    let name = entry.file_name().to_string_lossy().to_string();
                    let is_directory = entry.file_type().map(|ft| ft.is_dir()).unwrap_or(false);
                    let size = if is_directory {
                        0
                    } else {
                        entry.metadata().map(|m| m.len()).unwrap_or(0)
                    };
                    
                    entries.push(FileEntry {
                        name,
                        is_directory,
                        size,
                    });
                }
            }
            Ok(entries)
        }
        Err(e) => Err(format!("Failed to read directory: {}", e)),
    }
}

#[tauri::command]
fn get_platform() -> String {
    std::env::consts::OS.to_string()
}

#[tauri::command]
fn list_drives() -> Result<Vec<String>, String> {
    #[cfg(target_os = "windows")]
    {
        use std::ffi::OsString;
        use std::os::windows::ffi::OsStringExt;
        
        unsafe {
            let mut drives = Vec::new();
            let buffer_size = 256;
            let mut buffer: Vec<u16> = vec![0; buffer_size];
            
            let len = windows_sys::Win32::Storage::FileSystem::GetLogicalDriveStringsW(
                buffer_size as u32,
                buffer.as_mut_ptr(),
            );
            
            if len > 0 {
                let mut i = 0;
                while i < len as usize {
                    if buffer[i] == 0 {
                        if i > 0 {
                            let drive = OsString::from_wide(&buffer[..i]);
                            drives.push(drive.to_string_lossy().to_string());
                        }
                        break;
                    }
                    i += 1;
                }
            }
            
            if drives.is_empty() {
                drives.push("C:".to_string());
            }
            
            Ok(drives)
        }
    }
    
    #[cfg(not(target_os = "windows"))]
    {
        Ok(vec!["/".to_string()])
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(ssh::SshState::default())
        .invoke_handler(tauri::generate_handler![
            greet,
            get_home_dir,
            read_directory,
            get_platform,
            list_drives,
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