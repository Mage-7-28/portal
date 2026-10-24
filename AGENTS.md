# Repository Guidelines

## 协作与操作边界

- 仅在用户明确要求时才可修改 `AGENTS.md`；不得因代码变更、规范维护或自动化流程建议而主动修改本文件。
- 仅在用户明确要求提交时才可执行 `git commit`；不得自行创建、追加或修改 Git 提交。完成修改、通过检查或工作流建议均不构成提交授权。

## 项目结构与模块划分

Portal 是基于 React 19、Tauri 2 和 Rust 的 SSH/SFTP 桌面客户端。

- `src/components/`：React 界面组件；`src/App.jsx` 负责主窗口编排。
- `src/utils/`、`src/workers/`、`src/theme/`：集成工具、文件预览处理与主题配置。
- `src/style/`、`src/assets/`、`public/`：样式、字体和图片资源。
- `src-tauri/src/lib.rs`：原生命令注册；`ssh.rs`：SSH/SFTP 实现及内嵌单元测试。
- `src-tauri/` 还包含权限声明、图标及开发与生产配置；`scripts/` 生成第三方 CSS；`dist/` 存放构建产物。

## 构建、测试与开发命令

准备 Node.js LTS、pnpm、Rust 稳定版及目标平台所需的 Tauri 原生依赖；macOS 还需安装 Xcode Command Line Tools。

- `pnpm install`：安装前端依赖。
- `pnpm tauri:dev`：启动桌面开发环境，同时运行 Vite 与 Rust 后端。
- `pnpm dev`：启动前端开发服务，端口为 1420。
- `pnpm generate:styles`：重新生成 Ant Design 与提示消息组件的 CSS。
- `pnpm build`：构建前端，输出至 `dist/`。
- `pnpm lint` / `pnpm lint:fix`：检查或自动修复前端 ESLint 问题。
- `cargo test --manifest-path src-tauri/Cargo.toml`：运行 Rust 测试。
- `pnpm tauri:dmg`：打包 macOS；Windows、Linux 分别使用 `pnpm tauri:windows`、`pnpm tauri:linux`。当前主要验证平台为 macOS。

## 代码与注释规范

遵守 JavaScript、React 和 Rust 的主流编码规范；具体格式以仓库 ESLint 配置和 Rust 官方格式化工具为准，并保持相邻代码风格一致。

- JavaScript/React：遵循 `eslint.config.js`，使用两个空格缩进、单引号，不写语句末尾分号或尾随逗号；组件文件使用 PascalCase，工具函数使用 camelCase，并遵守 React Hooks 规则。
- Rust：函数和模块使用 snake_case，类型使用 PascalCase，常量使用 SCREAMING_SNAKE_CASE；通过 `cargo fmt --manifest-path src-tauri/Cargo.toml` 格式化。
- 注释：JavaScript 使用规范的 JSDoc，Rust 文档注释使用 Rustdoc。公共接口和复杂逻辑应按需说明用途、参数、返回值、错误条件及安全约束；行内注释解释原因，避免复述代码。修改行为时同步更新注释，删除过期或误导性说明。
- 生成文件：修改主题源文件或生成脚本，不直接编辑生成的 `antd-theme.css`、`react-hot-toast.css`。

## 测试规范

Rust 单元测试位于 `ssh.rs` 的 `#[cfg(test)]` 模块，使用 `#[test]`，名称应描述可观察行为。路径解析、命令参数转义及连接校验的修改应补充回归用例。当前未配置前端测试框架或覆盖率门槛。提交前运行 ESLint、前端构建和 Rust 测试；使用临时 SSH 测试服务器验证受影响的桌面流程，包括文件传输、取消操作与终端资源清理。

## 提交与合并请求规范

仅在获得用户明确提交指令后创建提交。提交信息遵循 Conventional Commits（约定式提交）规范：

- 格式为 `<type>(<scope>): <简洁描述>`，其中 `(<scope>)` 可省略；例如 `fix(ssh): 修复连接断开后的会话清理`。
- 根据改动选择 `feat`、`fix`、`docs`、`style`、`refactor`、`perf`、`test`、`build`、`ci` 或 `chore`；描述优先使用简洁中文，准确说明改动，避免“更新代码”等模糊内容。
- 每次提交聚焦一项改动；破坏性变更在类型或作用域后添加 `!`，或在提交信息末尾使用 `BREAKING CHANGE:` 说明影响。

合并请求应说明行为变化、关联相关问题，并列出验证命令、结果及测试平台；界面改动需附截图。

## 安全与配置注意事项

保留主机指纹校验、凭据加密与 Tauri 权限边界。不得在代码、日志、截图或问题反馈中包含真实密码、凭据密钥或私有服务器信息。
