import PubSub from 'pubsub-js'

export const GlobalFontFamily = '"Lora Variable", "Lora", "Source Serif Pro", "Source Serif 4", "Noto Serif SC", "Noto Serif TC", "Noto Serif JP", "Noto Serif KR", "Source Han Serif SC", "Source Han Serif TC", "Source Han Serif", "Songti SC", "STSong", "STSongti-SC-Regular", "PingFang SC", "SimSun", "NSimSun", "宋体", "FangSong", "仿宋", "KaiTi", "楷体", Georgia, "Times New Roman", Cambria, "Liberation Serif", ui-serif, serif'

export const StoreKeys = {
  DOWNLOAD_PATH: 'download_path',
  SSH_CONNECTIONS: 'ssh_connections',
  STORE_VERSION: 'store_version'
}

export const StoreVersion = 2

export const PubSubBusinessKeyEnum = {
  MASK: 'mask',
  SEND_MASK: (data) => PubSub.publish('mask', data)
}

export const FileSizeUnits = [ 'B', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB' ]

export const formatFileSize = (bytes, decimals = 2) => {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'

  const unitIndex = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), FileSizeUnits.length - 1)
  const value = bytes / Math.pow(1024, unitIndex)
  return `${ parseFloat(value.toFixed(Math.max(0, decimals))) } ${ FileSizeUnits[unitIndex] }`
}

export const SftpConnectionStatus = {
  DISCONNECTED: 'disconnected',
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  RECONNECTING: 'reconnecting',
  ERROR: 'error'
}

export const TransferStatus = {
  QUEUED: 'queued',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled'
}

export const CONNECTION_TIMEOUT_MS = 30_000
export const TRANSFER_BUFFER_SIZE = 64 * 1024
export const PROGRESS_UPDATE_INTERVAL_MS = 100
export const MAX_CONCURRENT_TRANSFERS = 4

// LAB 用于浏览器界面的强调色样式。Ant Design 的 FastColor 调色板生成器
// 目前只接受 RGB、HSL 和十六进制颜色，因此生成派生主题令牌时需要对应的 sRGB 降级色。
export const THEME_PRIMARY_COLOR = 'lab(68.9646% 33.16 32.3692)'
export const THEME_PRIMARY_COLOR_FALLBACK = '#eb9070'
export const THEME_BG_PRIMARY = '#1f1f1f'
export const THEME_BG_SECONDARY = '#252526'
export const THEME_BG_INPUT = '#2b2b2b'
export const THEME_BORDER_COLOR = '#3c3f41'
export const THEME_TEXT_PRIMARY = '#ebe8e1'
export const THEME_TEXT_SECONDARY = '#c0bcb4'
export const THEME_TEXT_LINK = '#d0b47d'
export const THEME_SUCCESS = '#7ea886'
export const THEME_WARNING = '#c5a467'
export const THEME_DANGER = '#d07878'

export const PROGRESS_GRADIENT = {
  '0%': THEME_PRIMARY_COLOR,
  '100%': '#c4aa78'
}

export const WINDOW_DEFAULT_WIDTH = 920
export const WINDOW_DEFAULT_HEIGHT = 620
export const WINDOW_MIN_WIDTH = 920
export const WINDOW_MIN_HEIGHT = 620

export const normalizeError = (error) => {
  if (!error) return '未知错误'

  if (typeof error === 'string') {
    try {
      const parsed = JSON.parse(error)
      if (parsed && typeof parsed === 'object') return normalizeError(parsed)
    } catch {
      return error
    }
  }

  if (typeof error.message === 'string' && error.message) return error.message
  if (typeof error.details === 'string' && error.details) return error.details
  if (typeof error.message === 'object' && error.message?.message) return error.message.message
  if (typeof error.code === 'string') {
    const detail = typeof error.message === 'string' ? error.message : ''
    return detail ? `${ error.code }: ${ detail }` : error.code
  }
  if (typeof error.toString === 'function') {
    const text = error.toString()
    if (text !== '[object Object]') return text
  }
  return '未知错误'
}

export const layoutStyle = {
  display: 'flex',
  flexDirection: 'column',
  minHeight: '100dvh',
  backgroundColor: THEME_BG_PRIMARY
}

export const msgBoxStyle = {
  background: THEME_BG_SECONDARY,
  color: THEME_TEXT_PRIMARY,
  border: `1px solid ${ THEME_BORDER_COLOR }`,
  fontSize: '14px'
}

export const headerStyle = {
  color: THEME_TEXT_PRIMARY,
  height: 50,
  lineHeight: '50px',
  backgroundColor: THEME_BG_SECONDARY,
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  width: '100%',
  padding: '0 16px'
}

export const contentStyle = {
  flex: 1,
  minHeight: 0,
  color: THEME_TEXT_PRIMARY,
  overflow: 'hidden',
  backgroundColor: THEME_BG_PRIMARY
}

export const footerStyle = {
  textAlign: 'center',
  color: THEME_TEXT_SECONDARY,
  height: 42,
  backgroundColor: THEME_BG_SECONDARY
}
