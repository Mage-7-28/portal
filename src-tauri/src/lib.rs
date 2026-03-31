// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
mod ssh;

use std::path::Path;
use tauri::Manager;

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
        .plugin(tauri_plugin_dialog::init())
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
        .setup(|app| {
            #[cfg(desktop)]
            {
                use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
                
                // 创建菜单项
                let about_item = MenuItem::with_id(app, "about", "关于", true, None::<&str>)?;
                let separator = PredefinedMenuItem::separator(app)?;
                let quit_item = MenuItem::with_id(app, "quit", "退出", true, Some("Cmd+Q"))?;
                
                let undo_item = MenuItem::with_id(app, "undo", "撤销", true, Some("Cmd+Z"))?;
                let redo_item = MenuItem::with_id(app, "redo", "重做", true, Some("Cmd+Shift+Z"))?;
                let copy_item = MenuItem::with_id(app, "copy", "复制", true, Some("Cmd+C"))?;
                let paste_item = MenuItem::with_id(app, "paste", "粘贴", true, Some("Cmd+V"))?;
                
                // 创建子菜单
                let file_submenu = Submenu::new(app, "文件", true)?;
                file_submenu.append(&about_item)?;
                file_submenu.append(&separator)?;
                file_submenu.append(&quit_item)?;
                
                let edit_submenu = Submenu::new(app, "编辑", true)?;
                edit_submenu.append(&undo_item)?;
                edit_submenu.append(&redo_item)?;
                edit_submenu.append(&separator)?;
                edit_submenu.append(&copy_item)?;
                edit_submenu.append(&paste_item)?;
                
                // 创建主菜单
                let menu = Menu::new(app)?;
                menu.append(&file_submenu)?;
                menu.append(&edit_submenu)?;
                
                // 设置应用菜单
                app.set_menu(menu)?;
                
                // 绑定菜单事件
                app.on_menu_event(|app, event| {
                    match event.id().as_ref() {
                        "about" => {
                            // 显示关于对话框
                            use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
                            app.dialog()
                                .message("        Portal 应用\n        版本: 0.1.0\n\n        一个现代化的跨平台桌面应用")
                                .title("关于 Portal")
                                .buttons(MessageDialogButtons::OkCustom("确定".to_string()))
                                .show(|_| {});
                        }
                        "quit" => {
                            // 显示退出确认对话框
                            use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
                            app.dialog()
                                .message("确定要退出应用吗？")
                                .title("退出确认")
                                .buttons(MessageDialogButtons::OkCancelCustom("确定".to_string(), "取消".to_string()))
                                .show(|confirmed| {
                                    if confirmed {
                                        std::process::exit(0);
                                    }
                                });
                        }
                        "undo" => {
                            // 撤销操作
                            println!("撤销操作");
                        }
                        "redo" => {
                            // 重做操作
                            println!("重做操作");
                        }
                        "copy" => {
                            // 复制操作
                            println!("复制操作");
                        }
                        "paste" => {
                            // 粘贴操作
                            println!("粘贴操作");
                        }
                        _ => {}
                    }
                });
                
                // 处理窗口关闭事件
                if let Some(window) = app.get_webview_window("Portal") {
                    let window_clone = window.clone();
                    window.on_window_event(move |event| match event {
                        tauri::WindowEvent::CloseRequested { api, .. } => {
                            // 阻止窗口关闭
                            api.prevent_close();
                            
                            // 显示退出确认对话框
                            use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
                            window_clone.dialog()
                                .message("确定要退出应用吗？")
                                .title("退出确认")
                                .buttons(MessageDialogButtons::OkCancelCustom("确定".to_string(), "取消".to_string()))
                                .show(|confirmed| {
                                    if confirmed {
                                        std::process::exit(0);
                                    }
                                });
                        }
                        _ => {}
                    });
                }
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| match event {
            tauri::RunEvent::ExitRequested { api, .. } => {
                // 阻止默认退出行为
                api.prevent_exit();
                
                // 显示退出确认对话框
                use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
                app.dialog()
                    .message("确定要退出应用吗？")
                    .title("退出确认")
                    .buttons(MessageDialogButtons::OkCancelCustom("确定".to_string(), "取消".to_string()))
                    .show(|confirmed| {
                        if confirmed {
                            // 强制退出应用
                            std::process::exit(0);
                        }
                        // 点击取消时，什么都不做，窗口保持打开状态
                    });
            }
            _ => {}
        });
}