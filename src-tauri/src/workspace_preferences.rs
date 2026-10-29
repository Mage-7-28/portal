//! 工作区布局偏好的跨窗口原子更新，与连接配置共享同一把进程内存储锁。

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::sync::Mutex;
use tauri_plugin_store::StoreExt;

static WORKSPACE_LAYOUT_LOCK: Mutex<()> = Mutex::new(());
const WORKSPACE_LAYOUTS_KEY: &str = "workspace_layouts";

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceLayout {
    file_ratio: f64,
    right_terminal_ratio: f64,
}

fn normalize_ratio(value: f64, fallback: f64, min: f64, max: f64) -> f64 {
    if value.is_finite() {
        value.clamp(min, max)
    } else {
        fallback
    }
}

pub(crate) fn update_layout_entry(
    current: Option<Value>,
    id: &str,
    layout: Option<WorkspaceLayout>,
) -> Value {
    let mut layouts = match current {
        Some(Value::Object(layouts)) => layouts,
        _ => Map::new(),
    };
    if let Some(layout) = layout {
        layouts.insert(
            id.to_string(),
            serde_json::json!({
                "fileRatio": normalize_ratio(layout.file_ratio, 0.38, 0.30, 0.62),
                "rightTerminalRatio": normalize_ratio(layout.right_terminal_ratio, 0.62, 0.32, 0.70)
            }),
        );
    } else {
        layouts.remove(id);
    }
    Value::Object(layouts)
}

fn connection_profile_exists(connections: Option<Value>, id: &str) -> bool {
    match connections {
        Some(Value::Array(profiles)) => profiles
            .iter()
            .any(|profile| profile.get("id").and_then(Value::as_str) == Some(id)),
        _ => false,
    }
}

pub(crate) fn with_workspace_layout_lock<T>(
    operation: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    let _guard = WORKSPACE_LAYOUT_LOCK
        .lock()
        .map_err(|_| "连接配置与工作区布局存储锁不可用".to_string())?;
    operation()
}

/// 在原生进程内串行合并或删除单个连接布局，避免不同 WebView 读改写丢失。
///
/// # Arguments
///
/// * `app` - 当前应用句柄，仅访问固定的本地偏好 Store。
/// * `connection_id` - 已保存连接的配置标识，不作为文件路径使用。
/// * `layout` - 新的面板比例；`None` 仅删除该连接的布局。
///
/// # Returns
///
/// 返回更新后的完整布局映射；Store 变更事件会同步通知其他窗口。
///
/// # Errors
///
/// 连接标识为空、待保存配置已被删除、存储锁不可用或本地 Store 打开、保存失败时返回错误。
#[tauri::command]
pub async fn update_workspace_layout(
    app: tauri::AppHandle,
    connection_id: String,
    layout: Option<WorkspaceLayout>,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if connection_id.trim().is_empty() {
            return Err("连接标识不能为空".to_string());
        }
        with_workspace_layout_lock(|| {
            let store = app.store("store.json").map_err(|error| error.to_string())?;
            if layout.is_some()
                && !connection_profile_exists(store.get("ssh_connections"), &connection_id)
            {
                return Err("连接配置已删除，未保存工作区布局".to_string());
            }
            let previous = store.get(WORKSPACE_LAYOUTS_KEY);
            let next = update_layout_entry(previous.clone(), &connection_id, layout);
            store.set(WORKSPACE_LAYOUTS_KEY, next.clone());
            if let Err(error) = store.save() {
                restore_value(&store, WORKSPACE_LAYOUTS_KEY, previous);
                return Err(error.to_string());
            }
            Ok(next)
        })
    })
    .await
    .map_err(|error| format!("工作区布局保存失败：{error}"))?
}

fn restore_value(store: &tauri_plugin_store::Store<tauri::Wry>, key: &str, value: Option<Value>) {
    if let Some(value) = value {
        store.set(key, value);
    } else {
        store.delete(key);
    }
}

fn is_plain_preference(key: &str) -> bool {
    matches!(
        key,
        "download_path"
            | "store_version"
            | "update_skipped_version"
            | "show_hidden_files"
            | "terminal_font_size"
    )
}

/// 普通偏好与连接/布局使用同一把原生保存锁，禁止前端直接写入受保护的配置键。
#[tauri::command]
pub async fn write_store_preference(
    app: tauri::AppHandle,
    key: String,
    value: Value,
    remove: Option<bool>,
) -> Result<(), String> {
    if !is_plain_preference(&key) {
        return Err("该设置必须通过专用的原生命令保存".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        with_workspace_layout_lock(|| {
            let store = app.store("store.json").map_err(|error| error.to_string())?;
            let previous = store.get(&key);
            if remove.unwrap_or(false) {
                store.delete(&key);
            } else {
                store.set(&key, value);
            }
            if let Err(error) = store.save() {
                restore_value(&store, &key, previous);
                return Err(error.to_string());
            }
            Ok(())
        })
    })
    .await
    .map_err(|error| format!("偏好设置保存失败：{error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::{Arc, Mutex};

    #[test]
    fn plain_preferences_cannot_overwrite_connection_or_layout_transactions() {
        for key in [
            "ssh_connections",
            "ssh_connections_revision",
            "workspace_layouts",
            "credential_key",
            "",
            "../store.json",
        ] {
            assert!(!is_plain_preference(key));
        }
        for key in [
            "download_path",
            "store_version",
            "update_skipped_version",
            "show_hidden_files",
            "terminal_font_size",
        ] {
            assert!(is_plain_preference(key));
        }
    }

    #[test]
    fn preserves_other_connections_and_clamps_saved_ratios() {
        let updated = update_layout_entry(
            Some(json!({"other": {"fileRatio": 0.5, "rightTerminalRatio": 0.6}})),
            "current",
            Some(WorkspaceLayout {
                file_ratio: 0.9,
                right_terminal_ratio: 0.1,
            }),
        );
        assert_eq!(updated["other"]["fileRatio"], 0.5);
        assert_eq!(
            updated["current"],
            json!({"fileRatio": 0.62, "rightTerminalRatio": 0.32})
        );
    }

    #[test]
    fn removes_only_the_deleted_connections_layout() {
        let updated =
            update_layout_entry(Some(json!({"deleted": {}, "other": {}})), "deleted", None);
        assert!(updated.get("deleted").is_none());
        assert!(updated.get("other").is_some());
    }

    #[test]
    fn rejects_late_layout_writes_for_deleted_or_invalid_profiles() {
        let profiles = Some(json!([{ "id": "existing" }]));
        assert!(connection_profile_exists(profiles.clone(), "existing"));
        assert!(!connection_profile_exists(profiles, "deleted"));
        assert!(!connection_profile_exists(None, "existing"));
        assert!(!connection_profile_exists(Some(json!({})), "existing"));
    }

    #[test]
    fn replaces_invalid_mapping_and_nonfinite_ratios_with_defaults() {
        let updated = update_layout_entry(
            Some(json!([])),
            "current",
            Some(WorkspaceLayout {
                file_ratio: f64::NAN,
                right_terminal_ratio: f64::INFINITY,
            }),
        );
        assert_eq!(
            updated["current"],
            json!({"fileRatio": 0.38, "rightTerminalRatio": 0.62})
        );
    }

    #[test]
    fn serializes_concurrent_connection_updates_before_reading() {
        let current = Arc::new(Mutex::new(None));
        let workers: Vec<_> = (0..12)
            .map(|index| {
                let current = current.clone();
                std::thread::spawn(move || {
                    with_workspace_layout_lock(|| {
                        let previous = current.lock().unwrap().clone();
                        std::thread::sleep(std::time::Duration::from_millis(1));
                        let next = update_layout_entry(
                            previous,
                            &index.to_string(),
                            Some(WorkspaceLayout {
                                file_ratio: 0.4,
                                right_terminal_ratio: 0.6,
                            }),
                        );
                        *current.lock().unwrap() = Some(next);
                        Ok(())
                    })
                    .unwrap();
                })
            })
            .collect();
        for worker in workers {
            worker.join().unwrap();
        }
        assert_eq!(
            current
                .lock()
                .unwrap()
                .as_ref()
                .unwrap()
                .as_object()
                .unwrap()
                .len(),
            12
        );
    }
}
