// 发布版 Windows 应用不显示额外控制台窗口，请勿删除！
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

/// 桌面端入口；移动端入口由 Tauri 的 `mobile_entry_point` 属性生成。
fn main() {
    portal_lib::run()
}
