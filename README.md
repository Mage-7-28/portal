# 传送门（Portal）

Portal 是一个基于 Tauri 2、React 和 Rust `ssh2` 的跨平台 SFTP 桌面工具，面向需要在本地与远程服务器之间浏览和传输文件的开发者。

项目主页：<https://gitee.com/Mage-7-28/portal>

## 功能

- SSH 密码、私钥和 SSH Agent 认证
- 首次连接显示并校验服务器 SHA-256 主机指纹（TOFU）
- 远程目录浏览、路径跳转、返回上级和刷新
- 文件预览、新建目录、重命名、删除
- 多文件上传、下载、实时进度和取消
- 临时文件 + 原子替换，避免中断传输留下半成品
- macOS、Windows、Linux 原生窗口和路径处理
- 连接配置可持久化，密码和私钥口令仅保存在当前运行内存中

## 开发环境

- Node.js 22 或更高版本
- pnpm 10 或更高版本
- Rust stable、Cargo 和 Tauri 2 系统依赖

```bash
git clone https://gitee.com/Mage-7-28/portal.git
cd portal
pnpm install
pnpm run tauri:dev
```

只调试前端时可以运行 `pnpm run dev`，默认地址为 `http://localhost:1420`。

## 构建

请在目标平台的原生工具链上构建，以获得正确的系统依赖、签名和安装包格式：

```bash
pnpm run tauri:dmg       # macOS
pnpm run tauri:windows   # Windows x64
pnpm run tauri:linux     # Linux deb + AppImage
pnpm run tauri:build     # 当前平台默认目标
```

Windows 交叉编译需要安装 `x86_64-pc-windows-msvc` target 和 Visual Studio Build Tools；Linux 构建需要 Tauri 文档列出的 WebKitGTK、GTK 和 AppImage 依赖。发布前应在三种系统分别验证文件对话框、键盘快捷键、路径分隔符、通知权限和 SSH Agent。

## 质量检查

```bash
pnpm lint
pnpm build
cargo check --manifest-path src-tauri/Cargo.toml
```

## 安全说明

Portal 不接受任意远程 shell 命令，文件操作全部通过 SFTP 专用接口完成。首次连接必须确认主机指纹；指纹变化会阻止连接。请勿把密码、私钥或私钥口令写入连接配置、日志、截图或 Gitee Issue。

## 许可证

本项目采用 MIT License，见 [`LICENSE`](./LICENSE)。第三方依赖及其许可证见 [`DEPENDENCIES.md`](./DEPENDENCIES.md) 和 [`license-report.csv`](./license-report.csv)。
