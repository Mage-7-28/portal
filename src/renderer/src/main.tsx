import './style/index.css'
import './style/fonts.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'

import 'virtual:svg-icons-register'
import { GlobalFontFamily } from '@renderer/util/GlobalEnum'
import { HashRouter } from 'react-router-dom'
import { HappyProvider } from '@ant-design/happy-work-theme'

// 设置CSS变量
document.documentElement.style.setProperty('--global-font-family', GlobalFontFamily)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <HashRouter>
      <HappyProvider>
        <App />
      </HappyProvider>
    </HashRouter>
  </StrictMode>
)
