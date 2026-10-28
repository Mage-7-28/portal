/**
 * 前端启动入口。
 * 先初始化持久化设置和通知能力，再挂载 React，避免首屏读取状态时出现闪烁。
 */
import React from 'react'
import ReactDOM from 'react-dom/client'
import { flushSync } from 'react-dom'
import App from './App.jsx'

// 引入样式文件
// 静态样式随首屏一起加载；Ant Design 仍保留运行时样式以覆盖动态组件状态。
import './style/antd-theme.css'
import './style/react-hot-toast.css'
import './style/index.css'
import './style/geek-theme.css'
import './style/connection-boot.css'
import './style/launcher.css'
// xterm 官方要求在应用入口加载基础 CSS，终端组件只负责创建实例和写入 PTY 数据。
import '@xterm/xterm/css/xterm.css'
import { GlobalFontFamily } from './utils/common.js'
import { initStore } from './utils/storeUtils.js'
import { initNotification } from './utils/notificationUtils.js'

// 在 React 挂载前设置全局字体令牌，确保首屏 loading 和正式页面使用同一字体链。
document.documentElement.style.setProperty('--global-font-family', GlobalFontFamily)

// 后台窗口停止纯装饰动画；连接、传输和监控采集不受影响。
const syncAnimationVisibility = () => {
  document.documentElement.classList.toggle('portal-window-hidden', document.hidden)
}
document.addEventListener('visibilitychange', syncAnimationVisibility)
syncAnimationVisibility()

// loading 层的离场时长必须与 index.html 中的 CSS transition 保持一致。
const LOADING_EXIT_DURATION_MS = 180

/**
 * 在首帧完成后淡出静态 loading 层，避免初始化较慢时出现长时间白屏。
 *
 * @returns {void}
 */
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

// 并行初始化本地 Store 与通知能力；两者都完成或失败后再挂载主应用。
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
