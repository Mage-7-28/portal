import fs from 'node:fs/promises'
import path from 'node:path'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { extractCss } from 'goober'
import { Toaster, ToastBar, toast } from 'react-hot-toast'

const outputPath = path.resolve('src/style/react-hot-toast.css')
const toastTypes = [ 'blank', 'success', 'error', 'loading' ]
const positions = [ 'top-center', 'bottom-center' ]

const createToast = (type, visible, position, icon) => ({
  id: 'static-style-' + type + '-' + visible + '-' + position,
  type,
  message: '静态样式预热',
  icon,
  duration: 4_000,
  pauseDuration: 0,
  position,
  ariaProps: {
    role: 'status',
    'aria-live': 'polite'
  },
  createdAt: 0,
  visible,
  dismissed: !visible,
  height: 40
})

// 预热 Toaster、内置图标和上下两组动画，生产环境直接使用生成的 CSS。
toast.success('静态样式预热', { id: 'static-toast-container', duration: Infinity })
renderToStaticMarkup(React.createElement(Toaster))
toast.remove('static-toast-container')

for (const type of toastTypes) {
  for (const position of positions) {
    for (const visible of [ true, false ]) {
      renderToStaticMarkup(
        React.createElement(ToastBar, {
          toast: createToast(type, visible, position),
          position
        })
      )
    }
  }
}

renderToStaticMarkup(
  React.createElement(ToastBar, {
    toast: createToast('blank', true, 'top-center', 'i'),
    position: 'top-center'
  })
)

const css = extractCss()
if (!css) throw new Error('未能提取 react-hot-toast 样式')

await fs.writeFile(
  outputPath,
  '/* 此文件由 generate-react-hot-toast-style.mjs 自动生成，请勿手动修改。 */\n' + css + '\n',
  'utf8'
)
console.log('已生成 react-hot-toast 静态样式：' + outputPath + '（' + css.length + ' 字符）')
