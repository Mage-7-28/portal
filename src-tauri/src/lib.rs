//! Portal Tauri 应用入口和本地文件系统命令。
//!
//! 本模块组装插件、原生菜单和 SSH 状态，并提供跨平台的本地目录读取、
//! 路径检查、平台识别及菜单状态同步能力。远程操作由 [`ssh`] 模块负责。

mod ssh;

use std::path::Path;
use tauri::{Emitter, Manager};

/// 返回用于验证 IPC 链路的问候语。
///
/// # Arguments
///
/// * `name` - 要插入问候语的调用方名称。
///
/// # Returns
///
/// 返回包含调用方名称的问候字符串。
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

/// 请求 Tauri 退出当前应用。
///
/// # Arguments
///
/// * `app` - 当前 Tauri 应用句柄。
///
/// # Returns
///
/// 此命令不返回结果；退出请求会交给 Tauri 事件循环处理。
#[tauri::command]
fn exit_application(app: tauri::AppHandle) {
    app.exit(0);
}

/// 同步原生菜单中“显示隐藏文件”的勾选状态。
///
/// # Arguments
///
/// * `app` - 当前 Tauri 应用句柄。
/// * `show_hidden_files` - 是否勾选“显示隐藏文件”菜单项。
///
/// # Returns
///
/// 菜单项更新成功时返回 `Ok(())`。
///
/// # Errors
///
/// 当应用菜单、显示子菜单或目标菜单项不存在，或菜单状态更新失败时返回错误。
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

/// 本地目录列表返回给前端的条目。
#[derive(serde::Serialize)]
struct FileEntry {
    /// 文件或目录名称。
    name: String,
    /// 是否为目录；目录大小由前端按需递归统计。
    #[serde(rename = "isDirectory")]
    is_directory: bool,
    /// 普通文件的字节数，目录固定返回 0。
    size: u64,
}

/// 拖放路径检查后返回给前端的本地条目。
#[derive(serde::Serialize)]
struct LocalPathEntry {
    /// 规范化前由调用方提供的本地路径。
    path: String,
    /// 是否为目录。
    #[serde(rename = "isDirectory")]
    is_directory: bool,
}

/// 获取当前用户主目录，兼容 Windows、macOS 和 Linux。
///
/// # Returns
///
/// 返回当前用户主目录的跨平台绝对路径。
///
/// # Errors
///
/// 当操作系统无法解析当前用户主目录时返回错误。
#[tauri::command]
fn get_home_dir() -> Result<String, String> {
    dirs::home_dir()
        .map(|path| path.to_string_lossy().to_string())
        .ok_or_else(|| "Failed to get home directory".to_string())
}

/// 读取本地目录的直接子项，不递归计算目录大小。
///
/// # Arguments
///
/// * `path` - 要读取的本地目录路径。
///
/// # Returns
///
/// 返回直接子项数组；普通文件包含字节数，目录的大小固定为 `0`。
///
/// # Errors
///
/// 当路径不存在、不是目录或目录读取失败时返回错误。
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

/// 校验拖放到窗口的本地路径，拒绝符号链接和特殊文件。
///
/// # Arguments
///
/// * `paths` - 拖放事件提供的本地文件或目录路径数组。
///
/// # Returns
///
/// 返回通过校验的路径条目数组，并标注每个条目是否为目录。
///
/// # Errors
///
/// 当路径无法读取、是符号链接或属于不支持的特殊文件类型时返回错误。
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

/// 返回当前运行环境的操作系统标识。
///
/// # Returns
///
/// 返回 Rust 编译目标对应的操作系统名称，例如 `windows`、`macos` 或 `linux`。
#[tauri::command]
fn get_platform() -> String {
    std::env::consts::OS.to_string()
}

/// 列出本地可浏览根路径；Windows 返回逻辑盘符，其余平台返回根目录。
///
/// # Returns
///
/// 返回可供文件浏览器切换的根路径数组。
///
/// # Errors
///
/// 当前实现仅在 Windows 原生盘符查询失败且无法构造回退结果时可能返回错误；
/// 非 Windows 平台始终返回根目录。
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

/// 创建并运行 Tauri 应用，注册插件、菜单和全部 IPC 命令。
///
/// # Returns
///
/// 此函数持续运行 Tauri 事件循环，不返回应用运行结果。
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
                    // CmdOrCtrl 在 macOS 对应 Command，在 Windows 和 Linux 对应 Ctrl。
                    Some("CmdOrCtrl+Shift+."),
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
