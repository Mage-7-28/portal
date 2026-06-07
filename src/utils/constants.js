/**
 * 全局常量定义
 * 统一管理项目中的魔法数字、配置值和业务常量
 * 所有其他模块的常量应优先从本文件导入
 */

import CryptoJS from 'crypto-js'

// ============================================================================
// 全局字体
// ============================================================================

export const GlobalFontFamily = 'AlimamaDongFangDaKai, sans-serif'

// ============================================================================
// 存储键名
// ============================================================================

export const StoreKeys = {
  DOWNLOAD_PATH: 'download_path',
  SSH_CONNECTIONS: 'ssh_connections'
}

// ============================================================================
// PubSub 事件键名（使用动态导入避免循环依赖）
// ============================================================================

export const PubSubBusinessKeyEnum = {
  MASK: 'mask',
  SEND_MASK: (data) => {
    import('pubsub-js').then(({ default: PubSub }) => {
      PubSub.publish(PubSubBusinessKeyEnum.MASK, data)
    })
  }
}

// ============================================================================
// 文件大小
// ============================================================================

export const FileSizeUnits = [
  'B',
  'KB',
  'MB',
  'GB',
  'TB',
  'PB',
  'EB',
  'ZB',
  'YB'
]

/**
 * 格式化文件大小
 * @param {number} bytes - 文件大小（字节）
 * @param {number} decimals - 小数位数
 * @returns {string} 格式化后的文件大小
 */
export const formatFileSize = (bytes, decimals = 2) => {
  if (bytes === 0) return '0 B'

  const k = 1024
  const dm = decimals < 0 ? 0 : decimals
  const i = Math.floor(Math.log(bytes) / Math.log(k))

  const unitIndex = Math.min(i, FileSizeUnits.length - 1)

  return parseFloat((bytes / Math.pow(k, unitIndex)).toFixed(dm)) + ' ' + FileSizeUnits[unitIndex]
}

// ============================================================================
// SFTP 连接状态
// ============================================================================

export const SftpConnectionStatus = {
  DISCONNECTED: 'disconnected',
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  ERROR: 'error'
}

// ============================================================================
// 布局样式
// ============================================================================

export const layoutStyle = {
  display: 'flex',
  flexDirection: 'column',
  minHeight: '100vh',
  backgroundSize: 'cover'
}

export const msgBoxStyle = {
  background: 'rgb(30, 31, 34)',
  color: 'rgba(255, 255, 255, 0.85)',
  border: '1px solid #36383a',
  fontSize: '12px'
}

export const headerStyle = {
  textAlign: 'center',
  color: '#fff',
  height: 50,
  paddingInline: 50,
  lineHeight: '50px',
  backgroundColor: 'rgba(0, 0, 0, 0.3)',
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  width: '100%',
  paddingLeft: '10px'
}

export const contentStyle = {
  flex: 1,
  color: '#fff',
  overflow: 'auto',
  height: 'calc(100vh - 50px)',
  backgroundColor: 'transparent'
}

export const footerStyle = {
  textAlign: 'center',
  color: '#fff',
  height: 55,
  backgroundColor: '#212121'
}

// ============================================================================
// 传输配置（魔法数字集中管理）
// ============================================================================

/** SSH 连接超时（毫秒） */
export const CONNECTION_TIMEOUT_MS = 30_000

/** 上传/下载缓冲区大小（字节）64KB */
export const TRANSFER_BUFFER_SIZE = 64 * 1024

/** 进度更新间隔（毫秒） */
export const PROGRESS_UPDATE_INTERVAL_MS = 100

/** UI 操作延迟（毫秒） */
export const UI_DELAY_MS = 100

// ============================================================================
// 主题颜色
// ============================================================================

/** 主色调 */
export const THEME_PRIMARY_COLOR = 'rgb(224, 82, 156)'

/** 背景色 - 主色 */
export const THEME_BG_PRIMARY = '#101113'

/** 背景色 - 次级 */
export const THEME_BG_SECONDARY = '#1E1E1E'

/** 背景色 - 输入框 */
export const THEME_BG_INPUT = '#2B2D30'

/** 边框色 */
export const THEME_BORDER_COLOR = '#3E4148'

/** 文字色 - 主色 */
export const THEME_TEXT_PRIMARY = '#ffffff'

/** 文字色 - 次级 */
export const THEME_TEXT_SECONDARY = '#888888'

/** 文字色 - 链接/目录 */
export const THEME_TEXT_LINK = '#4EC9B0'

/** 成功色 */
export const THEME_SUCCESS = '#4caf50'

/** 危险色 */
export const THEME_DANGER = '#f44336'

/** 下载进度渐变色 */
export const PROGRESS_GRADIENT = {
  '0%': '#8B5CF6',
  '100%': '#EC4899'
}

// ============================================================================
// 窗口尺寸
// ============================================================================

/** 窗口默认宽度（px） */
export const WINDOW_DEFAULT_WIDTH = 500

/** 窗口默认高度（px） */
export const WINDOW_DEFAULT_HEIGHT = 600

/** 窗口最小宽度（px） */
export const WINDOW_MIN_WIDTH = 500

/** 窗口最小高度（px） */
export const WINDOW_MIN_HEIGHT = 600

// ============================================================================
// 加密密钥（⚠️ 安全注意）
// ============================================================================

/**
 * 加密密钥
 * @deprecated 生产环境应从环境变量或系统密钥链获取
 * 当前硬编码仅用于本地开发，生产部署务必替换为安全方案
 */
export const ENCRYPTION_KEY = 'portal-secure-key-2024'

/**
 * 加密数据
 * @param {any} data - 要加密的数据
 * @param {string} key - 加密密钥
 * @returns {string|null} 加密后的数据
 */
export const encryptData = (data, key = ENCRYPTION_KEY) => {
  try {
    const jsonString = JSON.stringify(data)
    return CryptoJS.AES.encrypt(jsonString, key).toString()
  } catch (error) {
    console.error('加密数据失败:', error)
    return null
  }
}

/**
 * 解密数据
 * @param {string} encryptedData - 加密的数据
 * @param {string} key - 加密密钥
 * @returns {any|null} 解密后的数据
 */
export const decryptData = (encryptedData, key = ENCRYPTION_KEY) => {
  try {
    const bytes = CryptoJS.AES.decrypt(encryptedData, key)
    const jsonString = bytes.toString(CryptoJS.enc.Utf8)
    return JSON.parse(jsonString)
  } catch (error) {
    console.error('解密数据失败:', error)
    return null
  }
}