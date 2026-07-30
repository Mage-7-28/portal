import PubSub from 'pubsub-js'

export const GlobalFontFamily = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif'

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

export const THEME_PRIMARY_COLOR = '#4f8cff'
export const THEME_BG_PRIMARY = '#111318'
export const THEME_BG_SECONDARY = '#1b1e24'
export const THEME_BG_INPUT = '#242832'
export const THEME_BORDER_COLOR = '#343a46'
export const THEME_TEXT_PRIMARY = '#f5f7fa'
export const THEME_TEXT_SECONDARY = '#a4adbd'
export const THEME_TEXT_LINK = '#8ab4ff'
export const THEME_SUCCESS = '#47c68a'
export const THEME_WARNING = '#e5ac4f'
export const THEME_DANGER = '#ef6b73'

export const PROGRESS_GRADIENT = {
  '0%': THEME_PRIMARY_COLOR,
  '100%': '#68c4ff'
}

export const WINDOW_DEFAULT_WIDTH = 1100
export const WINDOW_DEFAULT_HEIGHT = 700
export const WINDOW_MIN_WIDTH = 820
export const WINDOW_MIN_HEIGHT = 520

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
  fontSize: '13px'
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
