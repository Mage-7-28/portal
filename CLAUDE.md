# CLAUDE.md

本文件为 Claude Code (claude.ai/code) 在本仓库中工作时提供指导。

## 项目概述

**Portal（传送门）** — 一款基于 Tauri 2 + React 19 构建的 macOS 桌面 SFTP 文件传输工具。通过 SSH/SFTP 连接远程服务器，支持浏览、上传、下载文件，深色主题 UI。

## 命令

```bash
pnpm install       # 安装依赖
pnpm run dev       # 启动 Vite 开发服务器（端口 1420）
pnpm run build     # 仅构建前端

# Tauri 命令（dev 使用 tauri.dev.conf.json，build 使用 tauri.prod.conf.json）
pnpm run tauri:dev   # Tauri 开发模式
pnpm run tauri:dmg   # 构建 macOS .dmg
pnpm run tauri:win32 # 构建 Windows .exe
pnpm run tauri:build # 使用默认打包器构建

pnpm run lint       # ESLint 检查
pnpm run lint:fix  # ESLint 自动修复
```

## 架构

### 前端（React 19 + Vite）

- **状态管理**：基于 Valtio 的 `ReactiveStore`，通过 `@tauri-apps/plugin-store` 实现 AES 加密持久化存储。连接信息和下载路径以加密形式保存。
- **SFTP 管理器**：`src/utils/sftpUtils.js` — 单例 `SftpManager` 封装所有 Tauri invoke 调用。文件传输通过 Tauri 事件系统（`listen`/`emit`）实现实时进度监听，后端线程完成后 resolve Promise。
- **组件结构**：`Remote.jsx` 是根控制器 — 管理连接状态和文件浏览状态，向下传递处理函数给 `RemoteFileBrowser` 和 `RemoteConnectionList`。`AddConnectionModal` 处理 SSH 凭证输入，支持实时连接测试。
- **进度遮罩**：基于 PubSub 的全局遮罩层（`ProgressMask.jsx`），上传/下载时显示。前端通过 `PubSubBusinessKeyEnum.SEND_MASK` 发布状态，遮罩组件订阅并渲染。
- **样式**：Ant Design 组件，使用 dark algorithm + compact algorithm + 自定义 token 覆盖。混合使用行内样式和 CSS 文件（`src/style/`）。无 CSS 框架。
- **字体**：自定义 `AlimamaDongFangDaKai` 字体，通过 `fonts.css` 加载。

### 后端（Rust + Tauri 2）

- **SSH/SFTP**：使用 `ssh2` crate。`SshState` 保存连接列表和 `SshConnectionPool`（线程安全的 session HashMap，含保活机制）。文件传输命令启动后台线程以避免阻塞 Tauri 主线程。
- **事件**：传输进度和完成通过 `app_handle.emit()` 发送到前端 `listen()` 监听器。事件名：`upload-progress`、`upload-complete`、`download-progress`、`download-complete`。
- **插件**：使用 Tauri 插件：dialog、clipboard、notification、store、opener、global-shortcut。
- **平台差异**：Windows 使用 `windows-sys` 枚举驱动器；macOS/Linux 使用根目录 `/`。
- **应用生命周期**：关闭请求时弹出确认对话框（使用 `tauri-plugin-dialog`），而非直接退出。

### Tauri Capabilities

`src-tauri/capabilities/` 下有两个 capability 文件：
- `default.json` — `main` 和 `Portal` 窗口的 dialog、store、notification、opener 权限。
- `desktop.json` — 桌面平台的 global-shortcut 权限。

## 关键模式

### Tauri Command → Event → Frontend Promise

上传/下载（`scp_upload`、`scp_download`）工作流程：
1. 前端调用 invoke，立即返回（`"上传开始"`/`"下载开始"`）。
2. 后端启动线程；进度变化时通过 `app_handle.emit("upload-progress", ...)` 发送事件。
3. 前端 `listen('upload-progress')` 监听并更新进度状态。
4. 完成后后端发送 `upload-complete`；前端 resolve/reject Promise。
5. 前端必须在完成后 `unlisten()` 两个监听器以避免内存泄漏。

### 加密存储

通过 `ReactiveStore` 存储的所有值均使用 `CryptoJS.AES` 加密，密钥硬编码在 `src/utils/common.js` 中。加密后的 JSON 字符串通过 `@tauri-apps/plugin-store` 保存。

### 连接 ID

连接 ID 生成规则为 `{host}-{port}-{username}` — 由配置派生出的确定性值。此 ID 必须与前端 `sftpManager.connections` 和 Rust `SshState.connections` 中的一致。

### Rust State 访问模式

Tauri 命令接收 `State<SshState>`，并将 `Arc<Mutex<...>>` 引用克隆到启动的后台线程中。`app_handle` 也被克隆到线程中，以便后台工作线程能发送事件。

### 人工延迟的 UI 更新

多个前端操作使用 `setTimeout(..., 100)` 包装异步调用，确保状态传播后再触发下一次渲染（如 `setCurrentPath` 后调用 `loadRemoteDirectory`）。
