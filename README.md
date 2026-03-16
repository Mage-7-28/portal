# 传送门 (Portal)
一个简洁易用的跨平台文件传输工具，专为MacOS用户打造。

📖 项目背景
作为一名刚毕业的Java开发人员，我在使用MacOS时发现，之前在Windows系统中习惯使用的scp文件传输工具在MacOS上使用体验有所不同。为了解决这个问题，同时也是为了锻炼自己的全栈开发能力，我利用空闲时间开发了这个文件传输工具——「传送门」。

✨ 核心功能
- 文件拖拽上传下载：支持通过拖拽文件实现本地与服务器之间的快速传输
- 目录浏览：直观的文件目录浏览界面，支持本地和服务器文件系统的导航
- 现代化界面：采用深色主题设计，符合现代开发工具的视觉风格
- 服务器连接存储：支持保存多个服务器连接配置，方便快速切换
- 文件上传下载进度：文件传输过程中显示详细的进度条，实时了解传输状态
- 创建或删除文件/文件夹：支持在本地和服务器上创建或删除文件和文件夹
- 文件复制，移动：支持文件的复制和移动操作
- 文件列表刷新，手动修改文件路径：支持手动刷新文件列表和修改文件路径
- 文件夹的拖拽上传下载：支持整个文件夹的批量传输
- 文件预览，编辑：支持常见文件格式的预览和简单编辑
- 跨平台支持：目前仅支持MacOS，后续将考虑Windows平台

📦 安装和使用
前置要求
- Node.js 22.x 或更高版本
- pnpm 10.x 或更高版本

安装步骤
1. 克隆项目代码
   ```bash
   git clone https://github.com/Mage-7-28/portal.git
   cd portal
   ```

2. 安装依赖
   ```bash
   pnpm install
   ```

3. 启动开发服务器
   ```bash
   pnpm run dev
   ```

📁 项目结构
```
portal/
├── src/                # React应用代码
│   ├── assets/         # 静态资源
│   ├── App.jsx         # 应用主组件
│   ├── main.jsx        # 渲染进程入口
│   └── App.css         # 样式文件
├── src-tauri/          # Tauri相关代码
│   ├── capabilities/   # 能力配置
│   ├── icons/          # 应用图标
│   ├── src/            # Rust代码
│   │   ├── lib.rs      # 库文件
│   │   └── main.rs     # 主进程
│   ├── Cargo.toml      # Rust依赖配置
│   └── tauri.conf.json # Tauri配置
├── public/             # 静态资源
├── package.json        # 项目配置和依赖
├── vite.config.js      # Vite配置
└── README.md           # 项目说明文档
```

🏗️ 开发和构建
开发
```bash
pnpm run dev
```

构建
```bash
# 构建MacOS版本
pnpm run tauri:dmg

# 构建Windows版本
pnpm run tauri:win32
```

🤝 贡献指南
欢迎对项目提出改进建议或提交代码！如果你有任何问题或建议，都可以通过Issue或Pull Request的方式与我交流。

📄 许可证
本项目采用MIT许可证，详见LICENSE文件。

传送门 - 连接本地与服务器的桥梁，让文件传输变得简单高效！