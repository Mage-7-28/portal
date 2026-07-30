# Portal 开发说明

Portal 是 Tauri 2 + React 19 + Rust 的跨平台 SFTP 桌面应用。前端负责交互和状态，Rust 负责 TCP/SSH/SFTP、传输线程和本地文件系统边界。

## 常用命令

```bash
pnpm install
pnpm run dev
pnpm run tauri:dev
pnpm lint
pnpm build
cargo check --manifest-path src-tauri/Cargo.toml
```

## 目录职责

- `src/components/FileBrowserPanel.jsx`：连接、目录、预览和远程文件操作的页面状态控制器。
- `src/components/ConnectionList.jsx`、`AddConnectionModal.jsx`：连接配置和认证方式输入；下载路径由原生菜单触发维护，窗口底部持续显示当前路径。
- `src/components/FileBrowser.jsx`、`FileItem.jsx`：目录工具栏、上传、预览入口和项目操作。
- `src/utils/sftpUtils.js`：Tauri invoke/event 的单例封装，严格区分 disconnected/connecting/connected/error 状态。
- `src/utils/storeUtils.js`：串行写入 Tauri Store。只保存非敏感连接配置和下载目录，凭据不落盘。
- `src-tauri/src/ssh.rs`：SSH 会话、主机指纹、SFTP 操作和后台传输任务。
- `src-tauri/src/lib.rs`：Tauri 插件、命令注册和跨平台本地系统命令。

## SSH/SFTP 约定

- 连接 ID 由前端生成并在 Rust 状态中复用；不要使用密码参与 ID。
- 首次握手返回 SHA-256 主机指纹，前端明确确认后再保存；已保存指纹不匹配时必须拒绝连接。
- 已认证的 `ssh2::Session` 存在 `connection_pool` 中，目录操作和传输复用该会话，避免每个文件重新握手。
- 上传先写远程临时文件再原子重命名；下载先写本地临时文件再替换目标文件。
- 传输在后台线程执行，事件名为 `upload-progress`/`upload-complete` 和 `download-progress`/`download-complete`，每个事件都包含 `id` 和 `transferId`。
- 通用远程 shell 命令接口已移除，新增能力应优先使用参数化 SFTP 命令，避免命令注入。

## 跨平台要求

远程 SFTP 路径使用 `/`；本地路径必须接受 `/` 和 `\\`，不能通过字符串字面量假设 macOS。窗口默认和最小尺寸均为 920x620。Windows 驱动器枚举在 Rust 的 `cfg(target_os = "windows")` 中实现；macOS/Linux 使用 POSIX 根目录。

## 依赖与许可证

只引入 MIT、MIT OR Apache-2.0、Apache-2.0 或 BSD-3-Clause 等宽松许可证依赖，保留其版权和 NOTICE 要求。每次增删依赖后重新生成 `license-report.csv` 并更新 `DEPENDENCIES.md`。
