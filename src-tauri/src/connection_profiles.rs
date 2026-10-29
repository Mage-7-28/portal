//! 连接配置的原生事务、旧格式迁移和跨窗口乐观并发控制。

use crate::workspace_preferences::{update_layout_entry, with_workspace_layout_lock};
use serde_json::{json, Number, Value};
use std::collections::HashSet;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri_plugin_store::{Store, StoreExt};

const CONNECTIONS_KEY: &str = "ssh_connections";
const REVISION_KEY: &str = "ssh_connections_revision";
const WORKSPACE_LAYOUTS_KEY: &str = "workspace_layouts";
// JavaScript Number 能无损表示的最大整数，避免跨 IPC 丢失并发版本。
const MAX_REVISION: u64 = 9_007_199_254_740_991;
const LEGACY_TIMESTAMP: &str = "1970-01-01T00:00:00.000Z";
const CONFLICT: &str = "连接配置已更改或删除，请重新打开后重试";

/// 将 UTC Unix 时间转换为前端现有的 ISO 8601 毫秒格式，无需增加日期依赖。
fn timestamp_now() -> String {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let seconds = duration.as_secs();
    let days = (seconds / 86_400) as i64;
    // 公历日期转换基于 400 年循环；时间戳使用 UTC，因此不依赖本地时区。
    let shifted = days + 719_468;
    let era = shifted / 146_097;
    let day_of_era = shifted - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let mut year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_prime + 2) / 5 + 1;
    let month = month_prime + if month_prime < 10 { 3 } else { -9 };
    year += i64::from(month <= 2);
    let within_day = seconds % 86_400;
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        within_day / 3_600,
        within_day % 3_600 / 60,
        within_day % 60,
        duration.subsec_millis()
    )
}

fn nonempty_string<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
}

fn normalized_port(profile: &Value) -> Value {
    let port = profile
        .get("port")
        .and_then(|value| match value {
            Value::Number(number) => number.as_f64(),
            Value::String(text) => text.trim().parse::<f64>().ok(),
            _ => None,
        })
        .filter(|number| number.is_finite() && *number != 0.0)
        .unwrap_or(22.0);
    if port.fract() == 0.0 && port >= i64::MIN as f64 && port <= i64::MAX as f64 {
        json!(port as i64)
    } else {
        Number::from_f64(port)
            .map(Value::Number)
            .unwrap_or(json!(22))
    }
}

/// 沿用原有 profile 字段，丢弃旧明文密码等不属于持久化结构的字段。
fn normalize_profile(profile: &Value, index: usize) -> Option<Value> {
    let host = nonempty_string(profile, "host")?;
    let username = nonempty_string(profile, "username")?;
    let port = normalized_port(profile);
    let id = nonempty_string(profile, "id")
        .map(str::to_owned)
        .unwrap_or_else(|| format!("legacy-{host}-{port}-{username}-{index}"));
    let name = nonempty_string(profile, "name")
        .map(str::to_owned)
        .unwrap_or_else(|| format!("{username}@{host}"));
    let created_at = nonempty_string(profile, "createdAt").unwrap_or(LEGACY_TIMESTAMP);
    let updated_at = nonempty_string(profile, "updatedAt").unwrap_or(created_at);
    let fingerprint = nonempty_string(profile, "hostKeyFingerprint")
        .map(Value::from)
        .unwrap_or(Value::Null);
    let encrypted = profile
        .get("encryptedPassword")
        .and_then(Value::as_str)
        .map(Value::from)
        .unwrap_or(Value::Null);
    let revision = profile
        .get("revision")
        .and_then(Value::as_u64)
        .filter(|value| *value <= MAX_REVISION)
        .unwrap_or(0);
    Some(json!({
        "id": id, "name": name, "host": host, "port": port, "username": username,
        "authMethod": "password", "hostKeyFingerprint": fingerprint,
        "encryptedPassword": encrypted, "createdAt": created_at, "updatedAt": updated_at,
        "revision": revision
    }))
}

struct ProfileState {
    profiles: Vec<Value>,
    revision: u64,
}

impl ProfileState {
    fn from_store(saved: Option<Value>, counter: Option<Value>) -> Self {
        let mut ids = HashSet::new();
        let profiles = saved
            .and_then(|value| value.as_array().cloned())
            .unwrap_or_default()
            .iter()
            .enumerate()
            .filter_map(|(index, profile)| {
                let mut normalized = normalize_profile(profile, index)?;
                let id = normalized["id"].as_str()?.to_owned();
                if !ids.insert(id.clone()) {
                    let mut suffix = index;
                    loop {
                        let candidate = format!("{id}-duplicate-{suffix}");
                        if ids.insert(candidate.clone()) {
                            normalized["id"] = Value::String(candidate);
                            break;
                        }
                        suffix += 1;
                    }
                }
                Some(normalized)
            })
            .collect::<Vec<_>>();
        let maximum = profiles
            .iter()
            .filter_map(|profile| profile["revision"].as_u64())
            .max()
            .unwrap_or(0);
        let revision = counter
            .and_then(|value| value.as_u64())
            .filter(|value| *value <= MAX_REVISION)
            .unwrap_or(0)
            .max(maximum);
        Self { profiles, revision }
    }

    fn next_revision(&self) -> Result<u64, String> {
        self.revision
            .checked_add(1)
            .filter(|revision| *revision <= MAX_REVISION)
            .ok_or_else(|| "连接配置版本已耗尽，无法保存".to_string())
    }

    fn index_for_revision(&self, id: &str, revision: u64) -> Result<usize, String> {
        self.profiles
            .iter()
            .position(|profile| {
                profile["id"].as_str() == Some(id) && profile["revision"].as_u64() == Some(revision)
            })
            .ok_or_else(|| CONFLICT.to_string())
    }

    fn save(&mut self, profile: Value, expected_revision: Option<u64>) -> Result<(), String> {
        let id = nonempty_string(&profile, "id")
            .ok_or_else(|| "连接标识不能为空".to_string())?
            .to_owned();
        if id.trim().is_empty() {
            return Err("连接标识不能为空".to_string());
        }
        let existing = self
            .profiles
            .iter()
            .position(|item| item["id"].as_str() == Some(&id));
        let index = match expected_revision {
            None if existing.is_some() => {
                return Err("连接配置已存在，请重新打开后重试".to_string())
            }
            None => None,
            Some(revision) => Some(self.index_for_revision(&id, revision)?),
        };
        let mut merged = index
            .map(|index| {
                self.profiles[index]
                    .as_object()
                    .cloned()
                    .unwrap_or_default()
            })
            .unwrap_or_default();
        let input = profile
            .as_object()
            .ok_or_else(|| "连接配置格式无效".to_string())?;
        merged.extend(
            input
                .iter()
                .map(|(key, value)| (key.clone(), value.clone())),
        );
        let mut next =
            normalize_profile(&Value::Object(merged), index.unwrap_or(self.profiles.len()))
                .ok_or_else(|| "连接地址和用户名不能为空".to_string())?;
        let now = timestamp_now();
        if index.is_none() && nonempty_string(&profile, "createdAt").is_none() {
            next["createdAt"] = json!(now);
        }
        next["updatedAt"] = json!(now);
        let revision = self.next_revision()?;
        next["revision"] = json!(revision);
        if let Some(index) = index {
            self.profiles[index] = next;
        } else {
            self.profiles.push(next);
        }
        self.revision = revision;
        Ok(())
    }

    fn patch(&mut self, id: &str, changes: Value, expected_revision: u64) -> Result<(), String> {
        let index = self.index_for_revision(id, expected_revision)?;
        let changes = changes
            .as_object()
            .ok_or_else(|| "连接配置变更格式无效".to_string())?;
        const ALLOWED: &[&str] = &[
            "name",
            "host",
            "port",
            "username",
            "hostKeyFingerprint",
            "encryptedPassword",
        ];
        if changes.keys().any(|key| !ALLOWED.contains(&key.as_str())) {
            return Err("连接配置包含不允许修改的字段".to_string());
        }
        let mut merged = self.profiles[index]
            .as_object()
            .cloned()
            .unwrap_or_default();
        merged.extend(
            changes
                .iter()
                .map(|(key, value)| (key.clone(), value.clone())),
        );
        let mut next = normalize_profile(&Value::Object(merged), index)
            .ok_or_else(|| "连接地址和用户名不能为空".to_string())?;
        let revision = self.next_revision()?;
        next["revision"] = json!(revision);
        next["updatedAt"] = json!(timestamp_now());
        self.profiles[index] = next;
        self.revision = revision;
        Ok(())
    }

    fn delete(&mut self, id: &str, expected_revision: u64) -> Result<(), String> {
        let index = self.index_for_revision(id, expected_revision)?;
        let revision = self.next_revision()?;
        self.profiles.remove(index);
        self.revision = revision;
        Ok(())
    }
}

fn read_state(store: &Store<tauri::Wry>) -> ProfileState {
    ProfileState::from_store(store.get(CONNECTIONS_KEY), store.get(REVISION_KEY))
}

/// 单次 Store 保存包含配置、全局版本和可选的布局删除；失败时恢复内存快照。
fn write_state(
    store: &Store<tauri::Wry>,
    state: &ProfileState,
    deleted_id: Option<&str>,
) -> Result<(), String> {
    let previous_connections = store.get(CONNECTIONS_KEY);
    let previous_revision = store.get(REVISION_KEY);
    let previous_layouts = deleted_id.map(|_| store.get(WORKSPACE_LAYOUTS_KEY));
    store.set(REVISION_KEY, json!(state.revision));
    if let Some(id) = deleted_id {
        store.set(
            WORKSPACE_LAYOUTS_KEY,
            update_layout_entry(previous_layouts.clone().flatten(), id, None),
        );
    }
    // 最后发布配置删除事件，确保观察到删除的窗口不会再看到该配置的旧布局。
    store.set(CONNECTIONS_KEY, json!(state.profiles));
    if let Err(error) = store.save() {
        for (key, value) in [
            (CONNECTIONS_KEY, previous_connections),
            (REVISION_KEY, previous_revision),
        ] {
            if let Some(value) = value {
                store.set(key, value);
            } else {
                store.delete(key);
            }
        }
        if let Some(layouts) = previous_layouts {
            if let Some(layouts) = layouts {
                store.set(WORKSPACE_LAYOUTS_KEY, layouts);
            } else {
                store.delete(WORKSPACE_LAYOUTS_KEY);
            }
        }
        return Err(format!("保存连接配置失败：{error}"));
    }
    Ok(())
}

/// 服务器身份字段变化时撤销旧运行态；首次指纹确认已同步到运行态时不重复撤销。
fn reconcile_runtime(
    state: &crate::ssh::SshState,
    previous: Option<&Value>,
    next: Option<&Value>,
    id: &str,
) {
    let fields = [
        "host",
        "port",
        "username",
        "authMethod",
        "hostKeyFingerprint",
    ];
    let changed = match (previous, next) {
        (Some(previous), Some(next)) => fields
            .iter()
            .any(|key| previous.get(*key) != next.get(*key)),
        _ => true,
    };
    if !changed {
        return;
    }
    let matches_runtime = next.is_some_and(|profile| {
        state
            .connections
            .read()
            .unwrap()
            .get(id)
            .is_some_and(|runtime| {
                profile["host"].as_str() == Some(runtime.host.as_str())
                    && profile["port"].as_u64() == Some(u64::from(runtime.port))
                    && profile["username"].as_str() == Some(runtime.username.as_str())
                    && profile["authMethod"].as_str() == Some(runtime.auth_method.as_str())
                    && profile["hostKeyFingerprint"].as_str()
                        == runtime.host_key_fingerprint.as_deref()
            })
    });
    if previous.is_none() || !matches_runtime {
        crate::ssh::invalidate_profile_runtime(state, id);
        if next.is_none() {
            state.connections.write().unwrap().remove(id);
        }
    }
}

fn snapshot(state: ProfileState) -> Value {
    json!({"profiles": state.profiles, "revision": state.revision})
}

/// 磁盘保存和连接生命周期锁都在 blocking runtime 中执行，不阻塞窗口事件循环。
async fn storage_operation<T: Send + 'static>(
    operation: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(operation)
        .await
        .map_err(|error| format!("本地配置操作失败：{error}"))?
}

/// 读取并确定性迁移连接配置，返回带全局版本的完整快照。
#[tauri::command]
pub async fn list_connection_profiles(app: tauri::AppHandle) -> Result<Value, String> {
    storage_operation(move || {
        with_workspace_layout_lock(|| {
            let store = app.store("store.json").map_err(|error| error.to_string())?;
            let state = read_state(&store);
            if store.get(CONNECTIONS_KEY) != Some(json!(state.profiles))
                || store.get(REVISION_KEY) != Some(json!(state.revision))
            {
                write_state(&store, &state, None)?;
            }
            Ok(snapshot(state))
        })
    })
    .await
}

/// 创建或修改指定版本的配置；过期版本不会覆盖更新或恢复已删除的配置。
#[tauri::command]
pub async fn save_connection_profile(
    app: tauri::AppHandle,
    runtime: tauri::State<'_, crate::ssh::SshState>,
    profile: Value,
    expected_revision: Option<u64>,
) -> Result<Value, String> {
    let runtime = runtime.inner().clone();
    storage_operation(move || {
        with_workspace_layout_lock(|| {
            let store = app.store("store.json").map_err(|error| error.to_string())?;
            let mut state = read_state(&store);
            let id = profile["id"]
                .as_str()
                .ok_or("连接标识不能为空")?
                .to_string();
            let previous = state
                .profiles
                .iter()
                .find(|item| item["id"].as_str() == Some(&id))
                .cloned();
            state.save(profile, expected_revision)?;
            write_state(&store, &state, None)?;
            let next = state
                .profiles
                .iter()
                .find(|item| item["id"].as_str() == Some(&id));
            reconcile_runtime(&runtime, previous.as_ref(), next, &id);
            Ok(snapshot(state))
        })
    })
    .await
}

/// 指纹和密码异步回写必须携带捕获的版本，只提交仍然存在的同一配置。
#[tauri::command]
pub async fn patch_connection_profile(
    app: tauri::AppHandle,
    runtime: tauri::State<'_, crate::ssh::SshState>,
    id: String,
    changes: Value,
    expected_revision: u64,
) -> Result<Value, String> {
    let runtime = runtime.inner().clone();
    storage_operation(move || {
        with_workspace_layout_lock(|| {
            let store = app.store("store.json").map_err(|error| error.to_string())?;
            let mut state = read_state(&store);
            let previous = state
                .profiles
                .iter()
                .find(|item| item["id"].as_str() == Some(&id))
                .cloned();
            state.patch(&id, changes, expected_revision)?;
            write_state(&store, &state, None)?;
            let next = state
                .profiles
                .iter()
                .find(|item| item["id"].as_str() == Some(&id));
            reconcile_runtime(&runtime, previous.as_ref(), next, &id);
            Ok(snapshot(state))
        })
    })
    .await
}

/// 在同一持久化操作中删除指定版本的配置和布局，成功后撤销运行态。
#[tauri::command]
pub async fn delete_connection_profile(
    app: tauri::AppHandle,
    runtime: tauri::State<'_, crate::ssh::SshState>,
    id: String,
    expected_revision: u64,
) -> Result<Value, String> {
    let runtime = runtime.inner().clone();
    storage_operation(move || {
        with_workspace_layout_lock(|| {
            let store = app.store("store.json").map_err(|error| error.to_string())?;
            let mut state = read_state(&store);
            state.delete(&id, expected_revision)?;
            write_state(&store, &state, Some(&id))?;
            reconcile_runtime(&runtime, None, None, &id);
            Ok(snapshot(state))
        })
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn sample(id: &str) -> Value {
        json!({
            "id": id,
            "name": "示例",
            "host": "example.invalid",
            "port": 22,
            "username": "user",
            "authMethod": "password",
            "hostKeyFingerprint": null,
            "encryptedPassword": "encrypted",
            "createdAt": "2024-01-01T00:00:00.000Z",
            "updatedAt": "2024-01-01T00:00:00.000Z"
        })
    }

    fn runtime_for(profile: &Value) -> crate::ssh::SshState {
        let state = crate::ssh::SshState::default();
        state.connections.write().unwrap().insert(
            "one".into(),
            crate::ssh::SshConnection {
                id: "one".into(),
                host: profile["host"].as_str().unwrap().into(),
                port: profile["port"].as_u64().unwrap() as u16,
                username: profile["username"].as_str().unwrap().into(),
                auth_method: "password".into(),
                host_key_fingerprint: profile["hostKeyFingerprint"].as_str().map(str::to_string),
                password: String::new(),
                connected: true,
            },
        );
        state
    }

    #[test]
    fn persisted_identity_changes_and_deletion_revoke_old_runtime() {
        let previous = sample("one");
        let state = runtime_for(&previous);
        let mut next = previous.clone();
        next["host"] = json!("other.invalid");
        reconcile_runtime(&state, Some(&previous), Some(&next), "one");
        assert!(!state.connections.read().unwrap()["one"].connected);
        reconcile_runtime(&state, None, None, "one");
        assert!(!state.connections.read().unwrap().contains_key("one"));
    }

    #[test]
    fn name_and_ciphertext_updates_do_not_revoke_authenticated_runtime() {
        let previous = sample("one");
        let state = runtime_for(&previous);
        let mut next = previous.clone();
        next["name"] = json!("新名称");
        next["encryptedPassword"] = json!("new ciphertext");
        reconcile_runtime(&state, Some(&previous), Some(&next), "one");
        assert!(state.connections.read().unwrap()["one"].connected);
    }

    #[test]
    fn first_host_key_confirmation_keeps_the_already_updated_runtime() {
        let previous = sample("one");
        let mut next = previous.clone();
        next["hostKeyFingerprint"] = json!("confirmed fingerprint");
        let state = runtime_for(&next);
        reconcile_runtime(&state, Some(&previous), Some(&next), "one");
        assert!(state.connections.read().unwrap()["one"].connected);
    }

    #[test]
    fn normalizes_legacy_profiles_deterministically_and_preserves_ciphertext() {
        let legacy = json!([{ "host": "host", "username": "user", "encryptedPassword": "cipher" }]);
        let first = ProfileState::from_store(Some(legacy.clone()), None);
        let second = ProfileState::from_store(Some(legacy), None);
        assert_eq!(first.profiles, second.profiles);
        assert_eq!(first.profiles[0]["id"], "legacy-host-22-user-0");
        assert_eq!(first.profiles[0]["encryptedPassword"], "cipher");
        assert_eq!(first.profiles[0]["revision"], 0);
    }

    #[test]
    fn rejects_stale_updates_and_does_not_resurrect_deleted_profile() {
        let mut state = ProfileState::from_store(None, None);
        state.save(sample("one"), None).unwrap();
        let original = state.profiles[0]["revision"].as_u64().unwrap();
        state
            .patch("one", json!({"name": "changed"}), original)
            .unwrap();
        assert!(state
            .patch("one", json!({"hostKeyFingerprint": "stale"}), original)
            .is_err());
        let current = state.profiles[0]["revision"].as_u64().unwrap();
        state.delete("one", current).unwrap();
        assert!(state.save(sample("one"), Some(current)).is_err());
        assert!(state
            .patch("one", json!({"encryptedPassword": "stale"}), current)
            .is_err());
        state.save(sample("one"), None).unwrap();
        assert_ne!(state.profiles[0]["revision"], current);
        assert!(state.delete("one", current).is_err());
    }

    #[test]
    fn create_is_not_upsert_and_update_keeps_unspecified_encrypted_password() {
        let mut state = ProfileState::from_store(None, None);
        state.save(sample("one"), None).unwrap();
        assert!(state.save(sample("one"), None).is_err());
        let revision = state.profiles[0]["revision"].as_u64().unwrap();
        let mut edited = sample("one");
        edited.as_object_mut().unwrap().remove("encryptedPassword");
        edited["name"] = json!("edited");
        state.save(edited, Some(revision)).unwrap();
        assert_eq!(state.profiles[0]["encryptedPassword"], "encrypted");
        assert_eq!(state.profiles[0]["name"], "edited");
    }

    #[test]
    fn patch_rejects_identity_and_revision_fields_and_does_not_store_plaintext() {
        let mut state = ProfileState::from_store(None, None);
        let mut profile = sample("one");
        profile["password"] = json!("secret");
        state.save(profile, None).unwrap();
        let revision = state.profiles[0]["revision"].as_u64().unwrap();
        assert!(state.profiles[0].get("password").is_none());
        assert!(state
            .patch("one", json!({"id": "other"}), revision)
            .is_err());
        assert!(state
            .patch("one", json!({"revision": 1}), revision)
            .is_err());
        assert!(state
            .patch("one", json!({"password": "secret"}), revision)
            .is_err());
    }

    #[test]
    fn revision_survives_an_empty_store_and_prevents_recreated_identity_aba() {
        let mut state = ProfileState::from_store(None, None);
        state.save(sample("one"), None).unwrap();
        let old_revision = state.profiles[0]["revision"].as_u64().unwrap();
        state.delete("one", old_revision).unwrap();
        let mut restarted =
            ProfileState::from_store(Some(json!(state.profiles)), Some(json!(state.revision)));
        restarted.save(sample("one"), None).unwrap();
        assert!(restarted.profiles[0]["revision"].as_u64().unwrap() > old_revision);
        assert!(restarted
            .patch("one", json!({"encryptedPassword": "stale"}), old_revision)
            .is_err());
    }

    #[test]
    fn normalizes_duplicate_identifiers_stably_without_dropping_profiles() {
        let input = json!([sample("same"), sample("same"), sample("same-duplicate-1")]);
        let first = ProfileState::from_store(Some(input.clone()), None);
        let second = ProfileState::from_store(Some(input), None);
        assert_eq!(first.profiles, second.profiles);
        let ids: HashSet<_> = first
            .profiles
            .iter()
            .map(|profile| profile["id"].as_str().unwrap())
            .collect();
        assert_eq!(ids.len(), 3);
        let again = ProfileState::from_store(Some(json!(first.profiles)), None);
        assert_eq!(again.profiles.len(), 3);
    }

    #[test]
    fn concurrent_updates_to_different_profiles_are_serialized_with_layout_lock() {
        use std::sync::{Arc, Mutex};
        let shared = Arc::new(Mutex::new(ProfileState::from_store(None, None)));
        let workers: Vec<_> = (0..12)
            .map(|index| {
                let shared = Arc::clone(&shared);
                std::thread::spawn(move || {
                    with_workspace_layout_lock(|| {
                        let mut state = shared.lock().unwrap();
                        state.save(sample(&index.to_string()), None)
                    })
                    .unwrap();
                })
            })
            .collect();
        for worker in workers {
            worker.join().unwrap();
        }
        let state = shared.lock().unwrap();
        assert_eq!(state.profiles.len(), 12);
        assert_eq!(state.revision, 12);
        assert_eq!(
            state
                .profiles
                .iter()
                .map(|profile| profile["revision"].as_u64().unwrap())
                .collect::<HashSet<_>>()
                .len(),
            12
        );
    }

    #[test]
    fn refuses_revision_overflow_without_mutating_profile() {
        let mut state =
            ProfileState::from_store(Some(json!([sample("one")])), Some(json!(MAX_REVISION)));
        let before = state.profiles.clone();
        assert!(state.patch("one", json!({"name": "changed"}), 0).is_err());
        assert_eq!(state.profiles, before);
    }

    #[test]
    fn concurrent_changes_using_one_revision_have_exactly_one_winner() {
        use std::sync::{Arc, Mutex};
        let mut state = ProfileState::from_store(None, None);
        state.save(sample("one"), None).unwrap();
        let revision = state.profiles[0]["revision"].as_u64().unwrap();
        let shared = Arc::new(Mutex::new(state));
        let workers: Vec<_> = ["first", "second"]
            .into_iter()
            .map(|name| {
                let shared = Arc::clone(&shared);
                std::thread::spawn(move || {
                    with_workspace_layout_lock(|| {
                        shared
                            .lock()
                            .unwrap()
                            .patch("one", json!({"name": name}), revision)
                    })
                    .is_ok()
                })
            })
            .collect();
        let successes = workers
            .into_iter()
            .map(|worker| worker.join().unwrap())
            .filter(|success| *success)
            .count();
        assert_eq!(successes, 1);
        assert_eq!(shared.lock().unwrap().profiles[0]["revision"], revision + 1);
    }
}
