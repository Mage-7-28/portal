//! 将应用菜单操作交给当前活动 WebView，避免跨窗口广播触发重复弹窗。

use std::sync::Mutex;
use tauri::{AppHandle, Emitter, EventTarget, Manager, Runtime};

/// 原生菜单可能短暂夺走窗口焦点，因此保留仍存活窗口的最近聚焦顺序。
#[derive(Default)]
pub(crate) struct MenuWindowState {
    focus_order: Mutex<Vec<String>>,
}

struct WindowSnapshot {
    label: String,
    focused: bool,
    visible: bool,
    minimized: bool,
}

impl MenuWindowState {
    /// 记录真实聚焦事件；重复聚焦只调整顺序，不积累重复记录。
    pub(crate) fn focused(&self, label: &str) {
        let mut order = self
            .focus_order
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        order.retain(|existing| existing != label);
        order.push(label.into());
    }

    /// 窗口销毁时移除记录，防止旧菜单操作指向已经关闭的 WebView。
    pub(crate) fn destroyed(&self, label: &str) {
        self.focus_order
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .retain(|existing| existing != label);
    }

    fn target(&self, windows: &[WindowSnapshot]) -> Option<String> {
        let visible: Vec<_> = windows
            .iter()
            .filter(|window| window.visible && !window.minimized)
            .collect();
        if let Some(window) = visible.iter().find(|window| window.focused) {
            return Some(window.label.clone());
        }

        let order = self
            .focus_order
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let recent = order.iter().rev().find_map(|label| {
            visible
                .iter()
                .find(|window| &window.label == label)
                .map(|window| window.label.clone())
        });
        // 首个聚焦事件可能晚于菜单初始化；只在目标唯一时使用无歧义的降级。
        recent.or_else(|| (visible.len() == 1).then(|| visible[0].label.clone()))
    }

    /// 将菜单事件定向发送给活动窗口，不打开隐藏窗口，也不强制切回主窗口。
    ///
    /// # Errors
    ///
    /// 当目标 WebView 的事件发送失败时返回 Tauri 错误；没有可用窗口时不发送。
    pub(crate) fn dispatch<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        event: &str,
    ) -> tauri::Result<()> {
        let windows = app
            .webview_windows()
            .values()
            .map(|window| WindowSnapshot {
                label: window.label().into(),
                focused: window.is_focused().unwrap_or(false),
                visible: window.is_visible().unwrap_or(false),
                minimized: window.is_minimized().unwrap_or(true),
            })
            .collect::<Vec<_>>();
        if let Some(label) = self.target(&windows) {
            app.emit_to(EventTarget::WebviewWindow { label }, event, ())?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::{MenuWindowState, WindowSnapshot};

    fn window(label: &str, focused: bool) -> WindowSnapshot {
        WindowSnapshot {
            label: label.into(),
            focused,
            visible: true,
            minimized: false,
        }
    }

    #[test]
    fn current_focus_overrides_stale_focus_history() {
        let state = MenuWindowState::default();
        state.focused("Portal");
        assert_eq!(
            state.target(&[window("Portal", false), window("PortalWorkspace-a", true)]),
            Some("PortalWorkspace-a".into())
        );
    }

    #[test]
    fn menu_temporary_blur_keeps_the_last_active_window() {
        let state = MenuWindowState::default();
        state.focused("Portal");
        state.focused("PortalTerminal-a");
        assert_eq!(
            state.target(&[window("Portal", false), window("PortalTerminal-a", false)]),
            Some("PortalTerminal-a".into())
        );
    }

    #[test]
    fn hidden_and_minimized_windows_cannot_receive_menu_dialogs() {
        let state = MenuWindowState::default();
        state.focused("Portal");
        state.focused("PortalWorkspace-a");
        state.focused("PortalTerminal-a");
        let mut workspace = window("PortalWorkspace-a", false);
        workspace.minimized = true;
        let mut terminal = window("PortalTerminal-a", true);
        terminal.visible = false;
        assert_eq!(
            state.target(&[window("Portal", false), workspace, terminal]),
            Some("Portal".into())
        );
    }

    #[test]
    fn destroying_a_window_removes_all_of_its_focus_history() {
        let state = MenuWindowState::default();
        state.focused("Portal");
        state.focused("PortalWorkspace-a");
        state.focused("Portal");
        state.focused("PortalWorkspace-a");
        state.destroyed("PortalWorkspace-a");
        assert_eq!(
            state.target(&[window("Portal", false), window("PortalWorkspace-a", false)]),
            Some("Portal".into())
        );
    }

    #[test]
    fn missing_windows_are_not_resurrected_by_old_menu_targets() {
        let state = MenuWindowState::default();
        state.focused("PortalWorkspace-a");
        assert_eq!(state.target(&[]), None);
    }

    #[test]
    fn ambiguous_windows_without_focus_history_are_not_selected_arbitrarily() {
        let state = MenuWindowState::default();
        assert_eq!(
            state.target(&[window("Portal", false), window("PortalWorkspace-a", false)]),
            None
        );
    }

    #[test]
    fn a_single_visible_window_works_before_the_first_focus_event() {
        let state = MenuWindowState::default();
        assert_eq!(
            state.target(&[window("Portal", false)]),
            Some("Portal".into())
        );
    }
}
