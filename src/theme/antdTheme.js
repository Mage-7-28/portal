/**
 * Ant Design 主题配置。
 *
 * 开发运行时和构建脚本都从这里读取令牌，确保动态组件样式与静态提取结果一致。
 */
import { theme } from 'antd'
import { GlobalFontFamily, THEME_BG_INPUT, THEME_BG_PRIMARY, THEME_BG_SECONDARY, THEME_BORDER_COLOR, THEME_PRIMARY_COLOR_FALLBACK, THEME_TEXT_LINK, THEME_TEXT_PRIMARY, THEME_TEXT_SECONDARY } from '../utils/constants.js'

// AntD 主题配置集中维护，开发服务器和 Tauri 安装包共用同一套运行时样式。
export const AntdThemeConfig = {
  // 项目只使用一个 antd 版本，关闭哈希类名便于自定义 CSS 稳定覆盖组件样式。
  hashed: false,
  // 固定 CSS 变量作用域，保证静态提取的样式与客户端运行时的类名一致。
  cssVar: { key: 'portal' },
  token: {
    colorPrimary: THEME_PRIMARY_COLOR_FALLBACK,
    colorBgBase: THEME_BG_PRIMARY,
    colorBgContainer: THEME_BG_SECONDARY,
    colorBgElevated: THEME_BG_INPUT,
    colorBorder: THEME_BORDER_COLOR,
    colorText: THEME_TEXT_PRIMARY,
    colorTextSecondary: THEME_TEXT_SECONDARY,
    colorLink: THEME_TEXT_LINK,
    borderRadius: 5,
    fontFamily: GlobalFontFamily,
    fontSize: 14,
    fontSizeSM: 13,
    controlHeight: 32,
    controlHeightSM: 28,
    lineHeight: 1.4
  },
  algorithm: [ theme.darkAlgorithm, theme.compactAlgorithm ],
  components: {
    Popover: {
      colorBgElevated: THEME_BG_INPUT
    },
    Card: {
      headerBg: THEME_BG_SECONDARY,
      actionsBg: THEME_BG_SECONDARY
    },
    Modal: {
      titleFontSize: 15
    }
  }
}
