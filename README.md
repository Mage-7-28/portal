# Portal

Portal 是一个跨平台的 SSH / SFTP 桌面客户端，用于在本地和远程服务器之间浏览、管理和传输文件。应用使用 Tauri 2 提供原生桌面能力，React 构建界面，Rust `ssh2` 负责 SSH、SFTP 和远程 PTY 会话。

- 项目主页：<https://gitee.com/Mage-7-28/portal>
- 当前版本：`2.0.0`
- Tauri：2（CLI `2.10.1`，Rust crate `2.10.3`）
- 协议：SSH / SFTP
- 许可证：MIT

Portal 打包后是独立桌面程序，不需要单独部署 Web 服务或后端服务。开发模式下的 `pnpm run tauri:dev` 会启动 Vite 开发服务器，这是本地开发工具链的一部分。

## 功能

### 连接与安全

- 支持自定义 SSH 主机、端口、用户名和密码。
- 连接配置持久化保存；密码只在当前应用进程内存中保留，不写入连接配置、窗口 URL 或日志。
- 首次连接显示服务器的 SHA-256 主机指纹，用户确认后才建立连接。
- 后续连接会校验已保存的指纹；指纹发生变化时拒绝连接，避免无提示地信任新的服务器身份。
- SSH 保活、连接状态探测和连接丢失后的页面清理，避免文件操作继续使用失效会话。

### 远程文件管理

- 浏览远程用户主目录，使用路径栏跳转、返回上级和刷新目录。
- 兼容 POSIX 路径和 Windows 盘符样式路径，具体可访问范围取决于服务器的 SFTP 权限。
- 创建目录、重命名、删除文件和递归删除目录。
- 通过原生文件选择器或拖拽上传文件、文件夹；支持批量选择。
- 下载文件和文件夹，支持批量下载、覆盖确认、进度显示和取消。
- 传输过程中先写入临时文件，完成后再替换目标，减少中断传输留下半成品的风险。
- 本地符号链接和特殊文件不会被文件夹传输跟随或复制；远程目录大小统计也不会跟随符号链接。

### 预览与终端

- 预览常见图片、纯文本、JSON 和代码文件。
- 使用 PrismJS 按需加载语法高亮；较大的 JSON 会放到 Worker 中格式化，避免阻塞界面。
- 单个远程文件预览上限为 5 MiB；不支持的二进制、办公文档和压缩包请先下载到本地打开。
- 打开独立的 SSH PTY 终端窗口，支持 ANSI/VT 控制序列、终端尺寸调整和交互式程序。
- 终端会话与文件传输使用独立 SSH 会话，关闭窗口、断开连接或退出应用时会释放远程 PTY。

## 目录大小统计

目录大小统计是按需执行的递归统计，不会把远程文件内容下载到客户端。为了减少大目录的等待时间，当前实现分为两条路径：

1. 对绝对 POSIX 路径，优先在远端 SSH 会话中执行经过安全转义的 `LC_ALL=C du -s -b -l -P -- <path>`。服务器本机完成遍历，只返回汇总值，适用于常见带 GNU `du` 的 Linux 环境。
2. 如果远端没有兼容的 `du`、命令执行失败、路径是 Windows 盘符样式、路径是相对路径，或服务器的 `du` 参数不兼容，则回退到 SFTP 递归扫描。回退路径最多使用 4 个独立工作会话，并在同一会话中批量处理少量子目录，降低 SFTP 往返和重复建会话的开销。

前端只在目录行进入可视区域附近时发起统计请求，并提供以下保护：

- 相同连接、路径和目录版本共享一次正在进行的请求。
- 最多同时调度 4 个目录统计任务，避免大量目录同时占满 SSH 会话。
- 成功结果缓存 45 秒，最多保留 500 项；上传、删除、重命名、新建目录和断开连接时会使相关缓存失效。
- 切换目录、滚动离开或主动取消时可以中止扫描。
- 子目录权限不足或在扫描期间被删除时，返回已访问部分并标记为不完整，界面显示 `≥`，提示实际大小可能更大。

因此，常见 Linux 服务器通常走远端 `du` 快速路径；Windows Server、远端 macOS/BSD、BusyBox 或没有兼容 `du` 的系统仍可通过 SFTP 回退路径工作，但速度和统计完整性会受到 SFTP 权限、网络延迟及目录规模影响。

## 跨平台兼容性

### 客户端

Portal 的客户端代码包含 macOS、Windows 和 Linux 的窗口、路径、文件对话框及驱动器处理逻辑。发布包需要在目标平台的原生工具链上分别构建和验证：

| 客户端系统 | 当前构建入口 | 产物 |
| --- | --- | --- |
| macOS | `pnpm run tauri:dmg` | DMG |
| Windows x64 | `pnpm run tauri:windows` | Windows 安装包 |
| Linux | `pnpm run tauri:linux` | Debian 包和 AppImage |

Windows 构建脚本使用 `x86_64-pc-windows-msvc` 目标；macOS 和 Linux 的架构由实际构建机及 Rust target 决定。跨架构或交叉编译需要自行准备对应的 Tauri、Rust 和原生依赖，发布时建议在目标系统上构建。

### 远端服务器

远端服务器只要提供可用的 SSH 服务、SFTP 子系统，并允许当前账户访问目标目录，即可使用文件浏览和传输功能。常见 Linux、Windows Server、macOS 和 BSD 服务器均可使用 SFTP 路径；远端 Shell 只用于目录大小统计的可选快速路径，不是文件管理功能的必要条件。

| 远端环境 | 目录大小策略 |
| --- | --- |
| Linux + 兼容 GNU `du` | 优先使用远端 `du` 汇总 |
| Windows Server 或 Windows 风格路径 | 使用 SFTP 递归回退 |
| macOS、BSD、BusyBox 或 `du` 参数不兼容 | 自动回退到 SFTP 递归 |

## 安装与开发

### 环境要求

- Node.js 22 或更高版本。
- pnpm 10 或更高版本。
- Rust stable、Cargo，以及 Tauri 2 对应的桌面系统依赖。
- macOS 需要 Xcode Command Line Tools；Windows 需要 WebView2 和 MSVC/Visual Studio Build Tools；Linux 需要 GTK、WebKitGTK、OpenSSL 等 Tauri 构建依赖。

各平台的原生依赖请以 [Tauri 2 prerequisites](https://v2.tauri.app/start/prerequisites/) 为准。

### 获取代码并安装依赖

```bash
git clone https://gitee.com/Mage-7-28/portal.git
cd portal
pnpm install --frozen-lockfile
```

### 开发运行

```bash
pnpm run tauri:dev
```

只调试 React 前端时可以运行：

```bash
pnpm run dev
```

默认开发地址为 `http://localhost:1420`。生产构建不依赖这个地址，也不需要单独启动服务。

### 构建打包

```bash
pnpm run tauri:dmg       # macOS DMG
pnpm run tauri:windows   # Windows x64 安装包
pnpm run tauri:linux     # Linux deb + AppImage
pnpm run tauri:build     # 当前平台的默认产物
```

常见产物位于 `src-tauri/target/**/release/bundle/` 下。打包前会自动执行 `pnpm build`，并将 `LICENSE`、`THIRD-PARTY-NOTICES.md` 和 `license-report.csv` 放入生产包的 `licenses/` 资源目录。

### 质量检查

```bash
pnpm lint
pnpm build
cargo check --manifest-path src-tauri/Cargo.toml --locked
```

需要运行 Rust 单元测试时：

```bash
cargo test --manifest-path src-tauri/Cargo.toml --locked
```

## 使用流程

1. 在“SSH 连接”页面新建连接，填写名称、主机、端口、用户名和密码。可以先点击“测试连接”。
2. 首次连接时核对服务器显示的 SHA-256 指纹，确认确实属于目标服务器后选择信任。
3. 双击连接配置进入远程用户主目录。双击文件夹进入目录，按 Enter 或在路径栏输入路径也可以跳转。
4. 单击选择项目，使用 Ctrl（Windows/Linux）或 Cmd（macOS）进行多选，使用 Shift 选择连续范围；随后执行批量下载或批量删除。
5. 使用“上传”选择文件或文件夹，也可以把本地文件拖到上传区域或远程文件列表。首次下载时选择本地下载目录，之后可从菜单“下载路径”修改。
6. 双击支持的文件类型可预览；目录行进入可视区域后会自动显示目录大小。显示 `不可用` 或 `≥` 时，请检查权限并按提示理解统计结果。
7. 点击“打开终端”使用独立 SSH PTY。断开连接或退出应用前，Portal 会尝试关闭所有终端窗口和远程会话。

## 当前限制

- 当前版本只支持 SSH 账户密码认证，不支持私钥、SSH Agent、键盘交互认证或跳板机配置。
- 文件预览上限为 5 MiB，未覆盖所有图片格式和文档格式；不支持预览的文件仍可正常传输。
- 目录大小统计的完整性取决于远端账户权限；无权读取的子目录会返回部分结果，而不是伪造完整大小。
- 目录大小快速路径依赖远端 Shell 和兼容 GNU `du`；SFTP 回退适用于更多系统，但大目录可能需要更长时间。
- 自动更新功能尚未接入。当前 Gitee 发行版用于人工下载，不需要上传 updater 的 `latest.json`、签名元数据或更新密钥文件。

## 在 Gitee 发布

创建 Gitee Release 时，建议只上传目标平台的安装包，不要把整个 `target` 目录打包上传：

| 平台 | 建议上传的文件 |
| --- | --- |
| macOS | `*.dmg` |
| Windows | `*.msi` 和/或 NSIS `*.exe` |
| Linux | `*.deb`、`*.AppImage` |

发布前请确认 `package.json` 中的版本号、安装包文件名和 Gitee Release 标签一致。`LICENSE`、`THIRD-PARTY-NOTICES.md` 和 `license-report.csv` 已经随源码维护，生产包也会包含它们；发布二进制时请保留适用的第三方许可证和 NOTICE 文件。

当前项目没有配置 Tauri Updater。macOS 公证、Windows Authenticode 代码签名和 Linux 发行渠道签名属于平台分发信任机制，与项目的 MIT 许可证及未来可能采用的自动更新签名是不同问题，应按发布渠道单独配置。

## 安全说明

- SSH 密码通过加密的 SSH 会话发送，应用不会把密码放进终端窗口 URL、连接配置或日志。
- 首次连接必须确认主机指纹；看到指纹变化时不要直接接受，先核实服务器是否确实更换了主机密钥。
- 目录大小快速路径只对远端路径做安全 Shell 转义，并且失败时会回退到 SFTP；不要在服务器上为 Portal 账户授予不必要的权限。
- 不要把真实密码、主机密钥、服务器地址或传输日志提交到仓库、Issue、截图或公开讨论中。

## 许可证与第三方依赖

Portal 自身使用 [MIT License](./LICENSE)。第三方依赖仍受各自原始许可证约束，完整说明见：

- [THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md)：运行时依赖、原生桥接库和特殊许可证说明。
- [license-report.csv](./license-report.csv)：当前锁文件对应的机器可读许可证清单。

更新依赖或锁文件后，请同步检查第三方许可证和 NOTICE，并在发布包中保留适用文本。
