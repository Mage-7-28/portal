import React from 'react'
import ReactDOM from 'react-dom/client'
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

// 初始化 store 和通知
Promise.all([
  initStore(),
  initNotification()
]).finally(() => {
  // 无论初始化成功与否，都渲染应用
  ReactDOM.createRoot(document.getElementById('root')).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  )
})

// 应用加载完成后隐藏加载动画
window.addEventListener('load', () => {
  setTimeout(() => {
    // 保留首屏加载动画；页面模板被二次定制时缺少节点也不会影响应用初始化。
    const loadingElement = document.getElementById('loading')
    const rootElement = document.getElementById('root')
    if (loadingElement) loadingElement.style.display = 'none'
    if (rootElement) rootElement.style.display = 'block'
  }, 200) // 增加一个小延迟，确保加载动画有足够的时间显示
})
