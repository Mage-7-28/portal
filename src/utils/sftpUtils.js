import { invoke } from '@tauri-apps/api/core'
import { SftpConnectionStatus } from './common'
import { notification } from './notificationUtils'

/**
 * SFTP连接配置接口
 * @typedef {Object} SftpConfig
 * @property {string} host - 主机地址
 * @property {number} port - 端口号
 * @property {string} username - 用户名
 * @property {string} password - 密码
 */

/**
 * 远程文件信息
 * @typedef {Object} RemoteFileInfo
 * @property {string} name - 文件名
 * @property {boolean} isDirectory - 是否为目录
 * @property {number} size - 文件大小（字节）
 */

/**
 * SFTP工具类
 * 提供统一的SFTP连接管理、文件上传下载功能
 */
class SftpManager {
  constructor() {
    this.connections = new Map()
    this.defaultTimeout = 30000
    this.retryAttempts = 3
    this.retryDelay = 1000
  }

  /**
   * 测试SFTP连接
   * @param {SftpConfig} config - SFTP连接配置
   * @param {number} timeout - 连接超时时间（毫秒）
   * @returns {Promise<{success: boolean, message: string, error?: string, connectionId?: string}>}
   */
  async testConnection(config, timeout = this.defaultTimeout) {
    try {
      const connectionId = this.generateConnectionId(config)

      const result = await invoke('test_sftp_connection', {
        host: config.host,
        port: config.port,
        username: config.username,
        password: config.password,
        timeout: timeout
      })

      return {
        success: true,
        message: '连接测试成功',
        connectionId: connectionId
      }
    } catch (error) {
      const errorMessage = this.parseError(error)
      return {
        success: false,
        message: '连接测试失败',
        error: errorMessage
      }
    }
  }

  /**
   * 创建SFTP连接
   * @param {SftpConfig} config - SFTP连接配置
   * @returns {Promise<string>} 连接ID
   */
  async createConnection(config) {
    try {
      const connectionId = this.generateConnectionId(config)

      await invoke('add_ssh_connection', {
        host: config.host,
        port: config.port,
        username: config.username,
        password: config.password
      })

      this.connections.set(connectionId, {
        config,
        status: SftpConnectionStatus.DISCONNECTED,
        lastError: null,
        lastActivity: Date.now()
      })

      return connectionId
    } catch (error) {
      const errorMessage = this.parseError(error)
      notification.error('创建连接失败', errorMessage)
      return null
    }
  }

  /**
   * 连接到SFTP服务器
   * @param {string} connectionId - 连接ID
   * @returns {Promise<boolean>}
   */
  async connect(connectionId) {
    try {
      const connectionInfo = this.connections.get(connectionId)
      if (!connectionInfo) {
        notification.error('连接错误', '连接不存在')
        return false
      }

      connectionInfo.status = SftpConnectionStatus.CONNECTING
      connectionInfo.lastError = null

      const result = await invoke('connect_ssh', { id: connectionId })

      if (result) {
        connectionInfo.status = SftpConnectionStatus.CONNECTED
        connectionInfo.lastActivity = Date.now()
      }

      return result
    } catch (error) {
      const errorMessage = this.parseError(error)
      const connectionInfo = this.connections.get(connectionId)
      if (connectionInfo) {
        connectionInfo.status = SftpConnectionStatus.ERROR
        connectionInfo.lastError = errorMessage
      }
      notification.error('连接失败', errorMessage)
      return false
    }
  }

  /**
   * 断开SFTP连接
   * @param {string} connectionId - 连接ID
   * @returns {Promise<boolean>}
   */
  async disconnect(connectionId) {
    try {
      const result = await invoke('disconnect_ssh', { id: connectionId })

      const connectionInfo = this.connections.get(connectionId)
      if (connectionInfo) {
        connectionInfo.status = SftpConnectionStatus.DISCONNECTED
      }

      return result
    } catch (error) {
      const errorMessage = this.parseError(error)
      notification.error('断开连接失败', errorMessage)
      return false
    }
  }

  /**
   * 上传文件
   * @param {string} connectionId - 连接ID
   * @param {string} localPath - 本地文件路径
   * @param {string} remotePath - 远程文件路径
   * @param {Function} onProgress - 进度回调函数
   * @returns {Promise<string>}
   */
  async uploadFile(connectionId, localPath, remotePath, onProgress) {
    return new Promise(async (resolve, reject) => {
      try {
        const connectionInfo = this.connections.get(connectionId)
        if (!connectionInfo) {
          notification.error('连接错误', '连接不存在')
          reject(new Error('连接不存在'))
          return
        }

        if (connectionInfo.status !== SftpConnectionStatus.CONNECTED) {
          notification.error('连接错误', '连接未建立')
          reject(new Error('连接未建立'))
          return
        }

        const { listen } = await import('@tauri-apps/api/event')
        let unlistenProgress = null
        let unlistenComplete = null

        if (onProgress) {
          const handleProgress = (event) => {
            if (event.payload.id === connectionId) {
              onProgress(event.payload.progress)
            }
          }
          unlistenProgress = await listen('upload-progress', handleProgress)
        }

        const handleComplete = (event) => {
          if (event.payload.id === connectionId) {
            if (unlistenProgress) unlistenProgress()
            if (unlistenComplete) unlistenComplete()

            connectionInfo.lastActivity = Date.now()

            if (event.payload.success) {
              resolve(event.payload.message)
            } else {
              reject(new Error(event.payload.message))
            }
          }
        }
        unlistenComplete = await listen('upload-complete', handleComplete)

        invoke('scp_upload', {
          id: connectionId,
          localPath: localPath,
          remotePath: remotePath
        }).catch((error) => {
          const errorMessage = this.parseError(error)
          if (unlistenProgress) unlistenProgress()
          if (unlistenComplete) unlistenComplete()
          reject(new Error(errorMessage))
        })
      } catch (error) {
        const errorMessage = this.parseError(error)
        notification.error('上传文件失败', errorMessage)
        reject(new Error(errorMessage))
      }
    })
  }

  /**
   * 下载文件
   * @param {string} connectionId - 连接ID
   * @param {string} remotePath - 远程文件路径
   * @param {string} localPath - 本地文件路径
   * @param {Function} onProgress - 进度回调函数
   * @returns {Promise<string>}
   */
  async downloadFile(connectionId, remotePath, localPath, onProgress) {
    return new Promise(async (resolve, reject) => {
      try {
        const connectionInfo = this.connections.get(connectionId)
        if (!connectionInfo) {
          notification.error('连接错误', '连接不存在')
          reject(new Error('连接不存在'))
          return
        }

        if (connectionInfo.status !== SftpConnectionStatus.CONNECTED) {
          notification.error('连接错误', '连接未建立')
          reject(new Error('连接未建立'))
          return
        }

        const { listen } = await import('@tauri-apps/api/event')
        let unlistenProgress = null
        let unlistenComplete = null

        if (onProgress) {
          const handleProgress = (event) => {
            if (event.payload.id === connectionId) {
              onProgress(event.payload.progress)
            }
          }
          unlistenProgress = await listen('download-progress', handleProgress)
        }

        const handleComplete = (event) => {
          if (event.payload.id === connectionId) {
            if (unlistenProgress) unlistenProgress()
            if (unlistenComplete) unlistenComplete()

            connectionInfo.lastActivity = Date.now()

            if (event.payload.success) {
              resolve(event.payload.message)
            } else {
              reject(new Error(event.payload.message))
            }
          }
        }
        unlistenComplete = await listen('download-complete', handleComplete)

        invoke('scp_download', {
          id: connectionId,
          remotePath: remotePath,
          localPath: localPath
        }).catch((error) => {
          const errorMessage = this.parseError(error)
          if (unlistenProgress) unlistenProgress()
          if (unlistenComplete) unlistenComplete()
          reject(new Error(errorMessage))
        })
      } catch (error) {
        const errorMessage = this.parseError(error)
        notification.error('下载文件失败', errorMessage)
        reject(new Error(errorMessage))
      }
    })
  }

  /**
   * 获取远程文件内容
   * @param {string} connectionId - 连接ID
   * @param {string} remotePath - 远程文件路径
   * @returns {Promise<ArrayBuffer>}
   */
  async getRemoteFileContent(connectionId, remotePath) {
    try {
      const connectionInfo = this.connections.get(connectionId)
      if (!connectionInfo) {
        notification.error('连接错误', '连接不存在')
        return null
      }

      if (connectionInfo.status !== SftpConnectionStatus.CONNECTED) {
        notification.error('连接错误', '连接未建立')
        return null
      }

      const result = await invoke('get_sftp_file_content', {
        id: connectionId,
        remotePath: remotePath
      })

      connectionInfo.lastActivity = Date.now()
      return result
    } catch (error) {
      const errorMessage = this.parseError(error)
      notification.error('获取文件内容失败', errorMessage)
      return null
    }
  }

  /**
   * 列出远程目录内容
   * @param {string} connectionId - 连接ID
   * @param {string} remotePath - 远程目录路径
   * @returns {Promise<RemoteFileInfo[]>}
   */
  async listRemoteDirectory(connectionId, remotePath) {
    try {
      const connectionInfo = this.connections.get(connectionId)
      if (!connectionInfo) {
        notification.error('连接错误', '连接不存在')
        return []
      }

      if (connectionInfo.status !== SftpConnectionStatus.CONNECTED) {
        notification.error('连接错误', '连接未建立')
        return []
      }

      const result = await invoke('list_sftp_directory', {
        id: connectionId,
        remotePath: remotePath
      })

      const parsedResult = JSON.parse(result)
      const files = parsedResult.files

      files.sort((a, b) => {
        if (a.isDirectory && !b.isDirectory) return -1
        if (!a.isDirectory && b.isDirectory) return 1
        return a.name.localeCompare(b.name)
      })

      connectionInfo.lastActivity = Date.now()
      return files
    } catch (error) {
      const errorMessage = this.parseError(error)
      notification.error('列出目录失败', errorMessage)
      return []
    }
  }

  /**
   * 创建远程目录
   * @param {string} connectionId - 连接ID
   * @param {string} remotePath - 远程目录路径
   * @returns {Promise<boolean>}
   */
  async createRemoteDirectory(connectionId, remotePath) {
    try {
      const connectionInfo = this.connections.get(connectionId)
      if (!connectionInfo) {
        notification.error('连接错误', '连接不存在')
        return false
      }

      if (connectionInfo.status !== SftpConnectionStatus.CONNECTED) {
        notification.error('连接错误', '连接未建立')
        return false
      }

      await invoke('execute_ssh_command', {
        id: connectionId,
        command: `mkdir -p "${ remotePath }"`
      })

      connectionInfo.lastActivity = Date.now()
      return true
    } catch (error) {
      const errorMessage = this.parseError(error)
      notification.error('创建目录失败', errorMessage)
      return false
    }
  }

  /**
   * 删除远程文件或目录
   * @param {string} connectionId - 连接ID
   * @param {string} remotePath - 远程路径
   * @param {boolean} recursive - 是否递归删除目录
   * @returns {Promise<boolean>}
   */
  async deleteRemoteItem(connectionId, remotePath, recursive = false) {
    try {
      const connectionInfo = this.connections.get(connectionId)
      if (!connectionInfo) {
        notification.error('连接错误', '连接不存在')
        return false
      }

      if (connectionInfo.status !== SftpConnectionStatus.CONNECTED) {
        notification.error('连接错误', '连接未建立')
        return false
      }

      const command = recursive
        ? `rm -rf "${ remotePath }"`
        : `rm "${ remotePath }"`

      await invoke('execute_ssh_command', {
        id: connectionId,
        command: command
      })

      connectionInfo.lastActivity = Date.now()
      return true
    } catch (error) {
      const errorMessage = this.parseError(error)
      notification.error('删除失败', errorMessage)
      return false
    }
  }

  /**
   * 获取远程用户主目录
   * @param {string} connectionId - 连接ID
   * @returns {Promise<string>}
   */
  async getRemoteUserHome(connectionId) {
    try {
      const connectionInfo = this.connections.get(connectionId)
      if (!connectionInfo) {
        notification.error('连接错误', '连接不存在')
        return ''
      }

      if (connectionInfo.status !== SftpConnectionStatus.CONNECTED) {
        notification.error('连接错误', '连接未建立')
        return ''
      }

      const result = await invoke('execute_ssh_command', {
        id: connectionId,
        command: 'echo $HOME'
      })

      connectionInfo.lastActivity = Date.now()
      return result.trim()
    } catch (error) {
      const errorMessage = this.parseError(error)
      notification.error('获取用户主目录失败', errorMessage)
      return ''
    }
  }

  /**
   * 获取远程服务器系统信息
   * @param {string} connectionId - 连接ID
   * @returns {Promise<{os: string, version: string}>}
   */
  async getRemoteSystemInfo(connectionId) {
    try {
      const connectionInfo = this.connections.get(connectionId)
      if (!connectionInfo) {
        notification.error('连接错误', '连接不存在')
        return { os: 'unknown', version: '' }
      }

      if (connectionInfo.status !== SftpConnectionStatus.CONNECTED) {
        notification.error('连接错误', '连接未建立')
        return { os: 'unknown', version: '' }
      }

      let os = 'unknown'
      let version = ''

      try {
        const windowsResult = await invoke('execute_ssh_command', {
          id: connectionId,
          command: 'ver'
        })

        if (windowsResult) {
          os = 'windows'
          version = windowsResult.trim()
        } else {
          const unixResult = await invoke('execute_ssh_command', {
            id: connectionId,
            command: 'uname -a'
          })

          if (unixResult) {
            os = 'unix'
            version = unixResult.trim()
          }
        }
      } catch (error) {
        // 获取系统信息失败，使用默认值
      }

      connectionInfo.lastActivity = Date.now()
      return { os, version }
    } catch (error) {
      const errorMessage = this.parseError(error)
      notification.error('获取系统信息失败', errorMessage)
      return { os: 'unknown', version: '' }
    }
  }

  /**
   * 获取远程服务器驱动器
   * @param {string} connectionId - 连接ID
   * @returns {Promise<string[]>}
   */
  async getRemoteDrives(connectionId) {
    try {
      const connectionInfo = this.connections.get(connectionId)
      if (!connectionInfo) {
        notification.error('连接错误', '连接不存在')
        return []
      }

      if (connectionInfo.status !== SftpConnectionStatus.CONNECTED) {
        notification.error('连接错误', '连接未建立')
        return []
      }

      let drives = []

      const systemInfo = await this.getRemoteSystemInfo(connectionId)

      try {
        if (systemInfo.os === 'windows') {
          const windowsResult = await invoke('execute_ssh_command', {
            id: connectionId,
            command: 'wmic logicaldisk get caption'
          })

          if (windowsResult) {
            const lines = windowsResult.split('\n')
            for (const line of lines) {
              const drive = line.trim()
              if (drive && drive.match(/^[A-Z]:$/)) {
                drives.push(drive)
              }
            }
          }
        } else if (systemInfo.os === 'unix') {
          const unixResult = await invoke('execute_ssh_command', {
            id: connectionId,
            command: 'findmnt -n -o TARGET | grep -E "^/" | head -20'
          })

          if (unixResult) {
            const lines = unixResult.split('\n')
            for (const line of lines) {
              const drive = line.trim()
              if (drive && drive.startsWith('/')) {
                drives.push(drive)
              }
            }
          }
        }
      } catch (error) {
        // 获取驱动器失败，使用空列表
      }

      connectionInfo.lastActivity = Date.now()
      return drives
    } catch (error) {
      const errorMessage = this.parseError(error)
      notification.error('获取驱动器失败', errorMessage)
      return []
    }
  }

  /**
   * 获取连接状态
   * @param {string} connectionId - 连接ID
   * @returns {SftpConnectionStatus}
   */
  getConnectionStatus(connectionId) {
    const connectionInfo = this.connections.get(connectionId)
    return connectionInfo ? connectionInfo.status : SftpConnectionStatus.DISCONNECTED
  }

  /**
   * 获取连接信息
   * @param {string} connectionId - 连接ID
   * @returns {Object|null}
   */
  getConnectionInfo(connectionId) {
    return this.connections.get(connectionId) || null
  }

  /**
   * 关闭所有连接
   * @returns {Promise<void>}
   */
  async closeAllConnections() {
    const connectionIds = Array.from(this.connections.keys())
    for (const connectionId of connectionIds) {
      try {
        await this.disconnect(connectionId)
      } catch (error) {
        // 忽略关闭连接时的错误
      }
    }
    this.connections.clear()
  }

  /**
   * 获取所有连接
   * @returns {Object}
   */
  getConnections() {
    return Object.fromEntries(this.connections)
  }

  /**
   * 生成连接ID
   * @param {SftpConfig} config - SFTP连接配置
   * @returns {string}
   */
  generateConnectionId(config) {
    return `${ config.host }-${ config.port }-${ config.username }`
  }

  /**
   * 解析错误信息
   * @param {Error|string} error - 错误对象或错误信息
   * @returns {string}
   */
  parseError(error) {
    if (typeof error === 'string') {
      return error
    }

    if (error.message) {
      return error.message
    }

    if (error.toString) {
      return error.toString()
    }

    return '未知错误'
  }

  /**
   * 带重试机制的连接
   * @param {string} connectionId - 连接ID
   * @param {number} attempts - 重试次数
   * @returns {Promise<boolean>}
   */
  async connectWithRetry(connectionId, attempts = this.retryAttempts) {
    for (let i = 0; i < attempts; i++) {
      try {
        const result = await this.connect(connectionId)
        return result
      } catch (error) {
        if (i === attempts - 1) {
          throw error
        }
        await new Promise(resolve => setTimeout(resolve, this.retryDelay))
      }
    }
    return false
  }
}

export const sftpManager = new SftpManager()
export default sftpManager