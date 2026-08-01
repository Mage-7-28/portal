// 发布版 Windows 应用不显示额外控制台窗口，请勿删除！
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    portal_lib::run()
}
