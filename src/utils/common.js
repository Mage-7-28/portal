import PubSub from 'pubsub-js'
import CryptoJS from 'crypto-js'

export const GlobalFontFamily = 'AlimamaDongFangDaKai, sans-serif'

/**
 * 文件大小单位枚举
 */
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

  // 确保索引不超出单位数组范围
  const unitIndex = Math.min(i, FileSizeUnits.length - 1)

  return parseFloat((bytes / Math.pow(k, unitIndex)).toFixed(dm)) + ' ' + FileSizeUnits[unitIndex]
}

/**
 * SFTP连接状态枚举
 */
export const SftpConnectionStatus = {
  DISCONNECTED: 'disconnected',
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  ERROR: 'error'
}

export const PubSubBusinessKeyEnum = {
  /* 全局遮罩 */
  MASK: 'mask',
  /* 发布全局遮罩事件 */
  SEND_MASK: (data) => PubSub.publish(PubSubBusinessKeyEnum.MASK, data)
}

/**
 * Store键名枚举
 */
export const StoreKeys = {
  /* 本地下载路径 */
  DOWNLOAD_PATH: 'download_path',
  /* SSH连接列表 */
  SSH_CONNECTIONS: 'ssh_connections'
}

/**
 * 加密密钥 (可以从环境变量或其他安全方式获取)
 * 注意：在生产环境中，应该使用更安全的方式管理密钥
 */
export const ENCRYPTION_KEY = 'portal-secure-key-2024'

/**
 * 加密数据
 * @param {any} data - 要加密的数据
 * @param {string} key - 加密密钥
 * @returns {string} 加密后的数据
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
 * @returns {any} 解密后的数据
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
