import PubSub from 'pubsub-js'

export const GlobalFontFamily = '"Lora Variable", "Lora", "Source Serif Pro", "Source Serif 4", "Noto Serif SC", "Noto Serif TC", "Noto Serif JP", "Noto Serif KR", "Source Han Serif SC", "Source Han Serif TC", "Source Han Serif", "Songti SC", "STSong", "STSongti-SC-Regular", "PingFang SC", "SimSun", "NSimSun", "宋体", "FangSong", "仿宋", "KaiTi", "楷体", Georgia, "Times New Roman", Cambria, "Liberation Serif", ui-serif, serif'

export const StoreKeys = {
  DOWNLOAD_PATH: 'download_path',
  SSH_CONNECTIONS: 'ssh_connections',
  STORE_VERSION: 'store_version',
  UPDATE_SKIPPED_VERSION: 'update_skipped_version'
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
// 基于 IDEA 深色新界面的炭灰分层：画布、岛屿面板和浮层保持明确层级。
export const THEME_BG_PRIMARY = '#1e1f22'
export const THEME_BG_SECONDARY = '#2b2d30'
export const THEME_BG_INPUT = '#313438'
export const THEME_BORDER_COLOR = '#45474d'
export const THEME_TEXT_PRIMARY = '#e6e8eb'
export const THEME_TEXT_SECONDARY = '#a9adb6'
export const THEME_TEXT_LINK = '#7fa6a4'
export const THEME_SUCCESS = '#8fb996'
export const THEME_WARNING = '#d0a965'
export const THEME_DANGER = '#d86f6f'

export const PROGRESS_GRADIENT = {
  '0%': THEME_PRIMARY_COLOR,
  '100%': '#f0aa90'
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

const getErrorCode = (error) => {
  if (!error) return ''
  if (typeof error === 'string') {
    try {
      return getErrorCode(JSON.parse(error))
    } catch {
      return ''
    }
  }
  return typeof error.code === 'string' ? error.code : ''
}

export const isCredentialError = (error) => {
  const message = normalizeError(error)
  const normalized = `${ getErrorCode(error) } ${ message }`.toLowerCase()
  if (normalized.includes('用户名不能为空')) return false
  return normalized.includes('authfailed')
    || normalized.includes('authentication failed')
    || normalized.includes('auth failed')
    || normalized.includes('认证失败')
    || normalized.includes('password')
    || normalized.includes('permission denied')
}

// 将底层 SSH 错误转换成用户可以直接处理的提示，避免把 libssh2 的内部信息暴露给用户。
export const getReadableConnectionError = (error) => {
  const message = normalizeError(error)
  const normalized = `${ getErrorCode(error) } ${ message }`.toLowerCase()

  if (normalized.includes('用户名不能为空')) {
    return '用户名不能为空，请检查连接配置'
  }
  if (normalized.includes('hostkeymismatch') || normalized.includes('主机密钥不匹配')) {
    return '服务器指纹发生变化，请确认服务器身份后重试'
  }
  if (normalized.includes('hostkeyverificationrequired') || normalized.includes('主机密钥需要确认')) {
    return '服务器需要确认主机指纹，请重新连接并确认服务器身份'
  }
  if (isCredentialError(error)) {
    return '账户密码错误，请检查后重试'
  }
  if (normalized.includes('unsupportedauth') || normalized.includes('认证方式不支持')) {
    return '当前认证方式不可用，请检查认证配置'
  }
  if (
    normalized.includes('timeout')
    || normalized.includes('timed out')
    || normalized.includes('超时')
  ) {
    return '连接超时，请检查服务器地址、端口和网络'
  }
  if (
    normalized.includes('connectionfailed')
    || normalized.includes('connection refused')
    || normalized.includes('拒绝连接')
    || normalized.includes('无法连接到服务器')
  ) {
    return '无法连接服务器，请检查地址、端口和 SSH 服务'
  }
  if (
    normalized.includes('handshakefailed')
    || normalized.includes('握手失败')
  ) {
    return 'SSH 握手失败，请检查服务器地址、端口和协议配置'
  }
  if (normalized.includes('connectionnotfound') || normalized.includes('连接不存在')) {
    return '连接已失效，请重新连接服务器'
  }
  return '连接失败，请检查服务器地址、端口和认证信息'
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
