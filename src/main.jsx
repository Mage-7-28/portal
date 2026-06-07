import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'

// 引入样式文件
import './style/index.css'
import './style/fonts.css'
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
    document.getElementById('loading').style.display = 'none'
    document.getElementById('root').style.display = 'block'
  }, 200) // 增加一个小延迟，确保加载动画有足够的时间显示
})
