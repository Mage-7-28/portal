import PubSub from 'pubsub-js'

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

/**
 * 消息类型枚举
 */
export const MessageType = {
  SUCCESS: 'success',
  ERROR: 'error',
  WARNING: 'warning',
  INFO: 'info'
}

/**
 * 操作类型枚举
 */
export const OperationType = {
  UPLOAD: 'upload',
  DOWNLOAD: 'download',
  DELETE: 'delete',
  CREATE: 'create'
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
