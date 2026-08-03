import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const host = process.env.TAURI_DEV_HOST

// Vite 配置文档：https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [ react() ],

  // Tauri 生产包通过内置资源协议加载文件，使用相对路径可兼容开发服务器和安装包。
  base: './',

  // 以下配置专门适配 Tauri 开发与构建命令。
  //
  // 1. 避免 Vite 清屏导致 Rust 错误信息被隐藏。
  clearScreen: false,
  // 2. Tauri 需要固定端口，端口被占用时直接报错。
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
        protocol: 'ws',
        host,
        port: 1421
      }
      : undefined,
    watch: {
      // 3. 忽略 src-tauri 目录的文件监听。
      ignored: ['**/src-tauri/**']
    }
  },
  // 4. 构建配置：移除 console 日志
  build: {
    // 禁止 CSS 分片，所有第三方样式随主 CSS 一起加载，适配 Tauri 内置资源协议。
    cssCodeSplit: false,
    minify: 'esbuild',
    esbuild: {
      drop: [ 'console', 'debugger' ]
    }
  }
}))
