import React from 'react'
import ReactDOM from 'react-dom/client'
import { flushSync } from 'react-dom'
import App from './App.jsx'

// 引入样式文件
// Ant Design 和 react-hot-toast 的静态样式用于生产包，避免 CSP 阻止运行时注入导致组件退化为原生 HTML。
import './style/antd-theme.css'
import './style/react-hot-toast.css'
import './style/index.css'
import './style/geek-theme.css'
import './style/fonts.css'
// xterm 官方要求在应用入口加载基础 CSS，终端组件只负责创建实例和写入 PTY 数据。
import '@xterm/xterm/css/xterm.css'
import { GlobalFontFamily } from './utils/common.js'
import { initStore } from './utils/storeUtils.js'
import { initNotification } from './utils/notificationUtils.js'

// 设置CSS变量
document.documentElement.style.setProperty('--global-font-family', GlobalFontFamily)

const LOADING_EXIT_DURATION_MS = 180

const revealApplication = () => {
  const loadingElement = document.getElementById('loading')
  const rootElement = document.getElementById('root')
  if (rootElement) rootElement.style.display = 'block'
  if (!loadingElement) return

  // 首次 React 渲染完成后再淡出，避免初始化较慢时露出空白根节点。
  loadingElement.setAttribute('aria-hidden', 'true')
  loadingElement.classList.add('is-leaving')
  window.setTimeout(() => loadingElement.remove(), LOADING_EXIT_DURATION_MS)
}

// 初始化 store 和通知
Promise.all([
  initStore(),
  initNotification()
]).finally(() => {
  // 无论初始化成功与否，都渲染应用
  flushSync(() => {
    ReactDOM.createRoot(document.getElementById('root')).render(
      <React.StrictMode>
        <App />
      </React.StrictMode>
    )
  })

  // 留出一帧让已挂载的界面参与绘制，再平滑移除首屏加载层。
  if (typeof window.requestAnimationFrame === 'function') {
    window.requestAnimationFrame(revealApplication)
  } else {
    window.setTimeout(revealApplication, 0)
  }
})
