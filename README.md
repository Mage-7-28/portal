# 传送门 (Portal)

一个简洁易用的跨平台文件传输工具，专为MacOS用户打造。

## 📖 项目背景

作为一名刚毕业的Java开发人员，我在使用MacOS时发现，之前在Windows系统中习惯使用的scp文件传输工具在MacOS上使用体验有所不同。为了解决这个问题，同时也是为了锻炼自己的全栈开发能力，我利用空闲时间开发了这个文件传输工具——「传送门」。

## ✨ 核心功能

### 已完成功能

- [x] **文件拖拽上传下载**：支持通过拖拽文件实现本地与服务器之间的快速传输
- [x] **目录浏览**：直观的文件目录浏览界面，支持本地和服务器文件系统的导航
- [x] **现代化界面**：采用深色主题设计，符合现代开发工具的视觉风格
- [x] **服务器连接存储**：支持保存多个服务器连接配置，方便快速切换
- [ ] **跨平台支持**：目前仅支持MacOS，后续将考虑Windows平台
- [ ] **文件上传下载进度**：文件传输过程中显示详细的进度条，实时了解传输状态
- [ ] **文件夹的拖拽上传下载**：支持整个文件夹的批量传输
- [ ] **文件预览，编辑**：支持常见文件格式的预览和简单编辑
- [ ] **创建或删除文件/文件夹**：支持在本地和服务器上创建或删除文件和文件夹
- [ ] **文件复制，移动**：支持文件的复制和移动操作
- [ ] **文件列表刷新，手动修改文件路径**：支持手动刷新文件列表和修改文件路径

## 🛠️ 技术栈

- **前端框架**：React + TypeScript + Ant Design
- **运行环境**：Node.js + Electron
- **文件传输**：ssh2-sftp-client
- **状态管理**：Valtio
- **事件通信**：PubSub.js
- **构建工具**：Vite

## 📦 安装和使用

### 前置要求

- Node.js 16.x 或更高版本
- npm 7.x 或更高版本

### 安装步骤

1. 克隆项目代码

```bash
git clone https://github.com/Mage-7-28/portal.git
cd portal
```

2. 安装依赖

```bash
npm install
```

3. 启动开发服务器

```bash
npm run dev
```

### 首次使用

1. 启动应用后，点击左侧的「服务器」按钮
2. 点击「新建服务器链接」按钮，填写服务器连接信息（主机、用户名、密码、端口）
3. 选择创建的服务器连接，点击「连接服务器」按钮
4. 连接成功后，右侧面板会显示服务器上的文件目录
5. 现在你可以通过拖拽文件在本地和服务器之间传输文件了

## 📁 项目结构

```
portal/
├── src/
│   ├── main/           # Electron 主进程代码
│   │   └── index.ts    # 主进程入口，处理文件传输和IPC通信
│   ├── preload/        # 预加载脚本
│   │   ├── index.ts    # 预加载脚本，暴露API给渲染进程
│   │   └── index.d.ts  # TypeScript类型定义
│   └── renderer/       # 渲染进程代码（React应用）
│       ├── components/ # React组件
│       │   ├── PortalLocal.tsx  # 本地文件浏览器
│       │   └── PortalServer.tsx # 服务器文件浏览器
│       ├── store/      # 状态管理
│       ├── util/       # 工具函数
│       ├── style/      # 样式文件
│       ├── interface/  # TypeScript接口定义
│       ├── App.tsx     # 应用主组件
│       └── main.tsx    # 渲染进程入口
├── public/             # 静态资源
├── resources/          # 应用图标等资源
├── package.json        # 项目配置和依赖
├── tsconfig.json       # TypeScript配置
├── vite.config.ts      # Vite配置
└── README.md           # 项目说明文档
```

## 🏗️ 开发和构建

### 开发

```bash
npm run dev
```

### 构建

```bash
# 构建Windows版本
npm run build:win

# 构建MacOS版本
npm run build:mac

# 构建Linux版本
npm run build:linux
```

### 代码风格

项目使用ESLint和Prettier保持代码风格的一致性，建议在开发时使用VSCode并安装相关插件。

## 🤝 贡献指南

欢迎对项目提出改进建议或提交代码！如果你有任何问题或建议，都可以通过Issue或Pull Request的方式与我交流。

## 📄 许可证

本项目采用MIT许可证，详见[LICENSE](LICENSE)文件。

**传送门** - 连接本地与服务器的桥梁，让文件传输变得简单高效！
