import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import { createSvgIconsPlugin } from 'vite-plugin-svg-icons'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    plugins: [
      react(),
      createSvgIconsPlugin({
        iconDirs: [path.resolve(process.cwd(), 'src/renderer/src/assets/icons')],
        symbolId: 'icon-[dir]-[name]'
        /*svgoOptions: {
          // 删除一些填充的属性
          plugins: [
            {
              name: "removeAttrs",
              params: { attrs: ["class", "data-name", "fill", "stroke"] },
            },
            // 删除样式标签
            "removeStyleElement",
          ],
        },*/
      })
    ]
  }
})
