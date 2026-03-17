import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'

// 引入样式文件
import './style/index.css'
import './style/fonts.css'
import { GlobalFontFamily } from './utils/GlobalEnum.js'

// 设置CSS变量
document.documentElement.style.setProperty('--global-font-family', GlobalFontFamily)

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
