/**
 * 在生产构建前静态提取 Ant Design 组件样式，保证首屏样式随主 CSS 加载。
 * 动态组件状态仍使用运行时样式；输出由构建覆盖，不应手动编辑。
 */
import fs from 'node:fs/promises'
import path from 'node:path'

// 采用生产模式提取组件样式，与正式构建的运行环境保持一致。
process.env.NODE_ENV = 'production'

const React = (await import('react')).default
const { ConfigProvider } = await import('antd')
const { extractStyle } = await import('@ant-design/static-style-extract')
const { AntdThemeConfig } = await import('../src/theme/antdTheme.js')

const outputPath = path.resolve('src/style/antd-theme.css')

// 提取阶段必须允许样式计算；应用运行时同时保留动态样式，以支持按需出现的组件状态。
const extractionTheme = { ...AntdThemeConfig }
const css = extractStyle({
  includes: [
    'Alert',
    'Button',
    'Dropdown',
    'Form',
    'Input',
    'List',
    'Menu',
    'Modal',
    'Popover',
    'Progress',
    'Radio',
    'Space',
    'Spin',
    'Tooltip',
    'Typography',
    'Upload'
  ],
  customTheme: node => React.createElement(ConfigProvider, { theme: extractionTheme }, node)
})

await fs.writeFile(outputPath, css + '\n', 'utf8')
console.log('已生成 Ant Design 静态主题样式：' + outputPath + '（' + css.length + ' 字符）')
