// Tauri 命令说明：https://tauri.app/develop/calling-rust/
mod ssh;

use std::path::Path;
use tauri::{Emitter, Manager};

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[tauri::command]
fn exit_application(app: tauri::AppHandle) {
    app.exit(0);
}

#[tauri::command]
fn set_show_hidden_files_menu_checked(
    app: tauri::AppHandle,
    show_hidden_files: bool,
) -> Result<(), String> {
    #[cfg(desktop)]
    {
        let menu = app.menu().ok_or_else(|| "应用菜单尚未初始化".to_string())?;
        let view_menu = menu
            .get("view")
            .and_then(|item| item.as_submenu().cloned())
            .ok_or_else(|| "未找到显示菜单".to_string())?;
        let hidden_files_item = view_menu
            .get("show-hidden-files")
            .and_then(|item| item.as_check_menuitem().cloned())
            .ok_or_else(|| "未找到显示隐藏文件菜单项".to_string())?;
        hidden_files_item
            .set_checked(show_hidden_files)
            .map_err(|error| error.to_string())?;
    }

    #[cfg(not(desktop))]
    {
        let _ = (app, show_hidden_files);
    }

    Ok(())
}

#[derive(serde::Serialize)]
struct FileEntry {
    name: String,
    #[serde(rename = "isDirectory")]
    is_directory: bool,
    size: u64,
}

#[derive(serde::Serialize)]
struct LocalPathEntry {
    path: String,
    #[serde(rename = "isDirectory")]
    is_directory: bool,
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
            for entry in dir_entries.flatten() {
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
            Ok(entries)
        }
        Err(e) => Err(format!("Failed to read directory: {}", e)),
    }
}

#[tauri::command]
fn inspect_local_paths(paths: Vec<String>) -> Result<Vec<LocalPathEntry>, String> {
    paths
        .into_iter()
        .map(|path| {
            let metadata = std::fs::symlink_metadata(&path)
                .map_err(|error| format!("无法读取本地路径“{path}”: {error}"))?;
            let file_type = metadata.file_type();
            if file_type.is_symlink() {
                return Err(format!("不支持拖拽符号链接: {path}"));
            }
            if !metadata.is_file() && !metadata.is_dir() {
                return Err(format!("不支持的本地项目类型: {path}"));
            }
            Ok(LocalPathEntry {
                path,
                is_directory: metadata.is_dir(),
            })
        })
        .collect()
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
                let mut start = 0;
                for i in 0..len as usize {
                    if buffer[i] == 0 {
                        if i > start {
                            let drive = OsString::from_wide(&buffer[start..i]);
                            drives.push(drive.to_string_lossy().to_string());
                        }
                        start = i + 1;
                    }
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
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(ssh::SshState::default())
        .invoke_handler(tauri::generate_handler![
            greet,
            exit_application,
            set_show_hidden_files_menu_checked,
            get_home_dir,
            read_directory,
            inspect_local_paths,
            get_platform,
            list_drives,
            ssh::test_sftp_connection,
            ssh::add_ssh_connection,
            ssh::set_ssh_host_key,
            ssh::list_ssh_connections,
            ssh::connect_ssh,
            ssh::disconnect_ssh,
            ssh::check_ssh_connection,
            ssh::scp_upload,
            ssh::sftp_upload_directory,
            ssh::scp_download,
            ssh::sftp_download_directory,
            ssh::list_sftp_directory,
            ssh::get_sftp_directory_size,
            ssh::cancel_sftp_directory_size,
            ssh::remove_ssh_connection,
            ssh::get_sftp_file_content,
            ssh::sftp_mkdir,
            ssh::sftp_delete,
            ssh::sftp_rename,
            ssh::get_sftp_user_home,
            ssh::open_ssh_terminal,
            ssh::write_ssh_terminal,
            ssh::resize_ssh_terminal,
            ssh::close_ssh_terminal,
            ssh::cancel_transfer
        ])
        .setup(|app| {
            // 设置AppHandle到SshState中
            let app_handle = app.app_handle();
            let state = app.state::<ssh::SshState>();
            *state.app_handle.lock().unwrap() = Some(app_handle.clone());

            #[cfg(desktop)]
            {
                use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};

                // 创建菜单项
                let update_item = MenuItem::with_id(app, "update", "更新", true, None::<&str>)?;
                let about_item = MenuItem::with_id(app, "about", "关于", true, None::<&str>)?;
                let separator = PredefinedMenuItem::separator(app)?;
                let quit_shortcut = if cfg!(target_os = "macos") {
                    "Cmd+Q"
                } else {
                    "Ctrl+Q"
                };
                let quit_item = MenuItem::with_id(app, "quit", "退出", true, Some(quit_shortcut))?;
                let download_path_item =
                    MenuItem::with_id(app, "download-path", "选择下载路径", true, None::<&str>)?;
                let show_hidden_files_item = CheckMenuItem::with_id(
                    app,
                    "show-hidden-files",
                    "显示隐藏文件",
                    true,
                    false,
                    None::<&str>,
                )?;

                // 创建子菜单
                let file_submenu = Submenu::new(app, "文件", true)?;
                file_submenu.append(&update_item)?;
                file_submenu.append(&about_item)?;
                file_submenu.append(&separator)?;
                file_submenu.append(&quit_item)?;

                // 创建编辑子菜单，使用原生菜单项
                let edit_submenu = Submenu::new(app, "编辑", true)?;
                edit_submenu.append(&PredefinedMenuItem::undo(app, None)?)?;
                edit_submenu.append(&PredefinedMenuItem::redo(app, None)?)?;
                edit_submenu.append(&separator)?;
                edit_submenu.append(&PredefinedMenuItem::copy(app, None)?)?;
                edit_submenu.append(&PredefinedMenuItem::paste(app, None)?)?;

                let view_submenu = Submenu::with_id(app, "view", "显示", true)?;
                view_submenu.append(&show_hidden_files_item)?;

                // macOS 菜单栏的顶层项目使用 Submenu，确保下载路径入口可见。
                let download_path_submenu = Submenu::new(app, "下载路径", true)?;
                download_path_submenu.append(&download_path_item)?;

                // 创建主菜单
                let menu = Menu::new(app)?;
                menu.append(&file_submenu)?;
                menu.append(&edit_submenu)?;
                menu.append(&view_submenu)?;
                menu.append(&download_path_submenu)?;

                // 设置应用菜单
                app.set_menu(menu)?;

                // 绑定菜单事件
                app.on_menu_event(move |app, event| match event.id().as_ref() {
                    "update" => {
                        let _ = app.emit("menu-update", ());
                    }
                    "about" => {
                        let _ = app.emit("menu-about", ());
                    }
                    "quit" => {
                        let _ = app.emit("menu-request-exit", ());
                    }
                    "download-path" => {
                        let _ = app.emit("menu-download-path", ());
                    }
                    "show-hidden-files" => {
                        if let Ok(show_hidden_files) = show_hidden_files_item.is_checked() {
                            let _ = app.emit("menu-show-hidden-files", show_hidden_files);
                        }
                    }

                    _ => {}
                });
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_, _| {});
}
