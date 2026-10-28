/**
 * Ant Design 主题配置。
 *
 * 开发运行时和构建脚本都从这里读取令牌，确保动态组件样式与静态提取结果一致。
 */
import { theme } from 'antd'
import { GlobalFontFamily, THEME_BG_INPUT, THEME_BG_PRIMARY, THEME_BG_SECONDARY, THEME_BORDER_COLOR, THEME_DANGER, THEME_PRIMARY_COLOR_FALLBACK, THEME_SUCCESS, THEME_TEXT_LINK, THEME_TEXT_PRIMARY, THEME_TEXT_SECONDARY, THEME_WARNING } from '../utils/constants.js'

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
    colorInfo: THEME_TEXT_LINK,
    colorSuccess: THEME_SUCCESS,
    colorWarning: THEME_WARNING,
    colorError: THEME_DANGER,
    borderRadius: 5,
    borderRadiusLG: 8,
    motionDurationFast: '0.15s',
    motionDurationMid: '0.18s',
    motionDurationSlow: '0.24s',
    controlOutline: 'rgba(103, 199, 209, 0.14)',
    controlOutlineWidth: 2,
    fontFamily: GlobalFontFamily,
    fontSize: 14,
    fontSizeSM: 13,
    lineHeight: 1.4,
    controlHeight: 32,
    controlHeightSM: 28,
    padding: 12,
    paddingSM: 8,
    margin: 14,
    marginSM: 8,
    wireframe: false
  },
  algorithm: [ theme.darkAlgorithm, theme.compactAlgorithm ],
  components: {
    Popover: {
      colorBgElevated: THEME_BG_INPUT
    },
    Card: {
      headerBg: THEME_BG_SECONDARY,
      actionsBg: THEME_BG_SECONDARY,
      paddingLG: 14,
      paddingSM: 10
    },
    Modal: {
      titleFontSize: 15,
      contentBg: THEME_BG_SECONDARY,
      headerBg: THEME_BG_SECONDARY
    },
    Button: {
      primaryShadow: '0 2px 10px rgba(235, 144, 112, 0.14)',
      defaultShadow: '0 1px 0 rgba(255, 255, 255, 0.025)',
      defaultHoverBorderColor: THEME_TEXT_LINK
    },
    Input: {
      activeBorderColor: THEME_TEXT_LINK,
      hoverBorderColor: THEME_TEXT_LINK,
      activeShadow: '0 0 0 2px rgba(103, 199, 209, 0.12)'
    },
    Table: {
      headerBg: THEME_BG_SECONDARY,
      rowHoverBg: 'rgba(255, 255, 255, 0.045)',
      cellPaddingBlockSM: 6,
      cellPaddingInlineSM: 8
    },
    Splitter: {
      splitBarSize: 3,
      splitBarDraggableSize: 12,
      splitTriggerSize: 12
    },
    Statistic: {
      titleFontSize: 12,
      contentFontSize: 21
    },
    Progress: {
      defaultColor: THEME_PRIMARY_COLOR_FALLBACK,
      remainingColor: 'rgba(255, 255, 255, 0.08)'
    }
  }
}
