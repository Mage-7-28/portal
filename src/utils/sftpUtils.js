import { invoke } from '@tauri-apps/api/core'
import { SftpConnectionStatus } from './common'

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
      console.error('SFTP连接测试失败:', errorMessage)
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

      // 无论连接是否已存在，都重新创建连接
      // 这样可以确保使用最新的密码信息
      await invoke('add_ssh_connection', {
        host: config.host,
        port: config.port,
        username: config.username,
        password: config.password
      })

      // 存储连接信息
      this.connections.set(connectionId, {
        config,
        status: SftpConnectionStatus.DISCONNECTED,
        lastError: null,
        lastActivity: Date.now()
      })

      return connectionId
    } catch (error) {
      const errorMessage = this.parseError(error)
      console.error('创建SFTP连接失败:', errorMessage)
      throw new Error(`创建连接失败: ${ errorMessage }`)
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
        throw new Error('连接不存在')
      }

      console.log('连接信息:', connectionInfo)
      connectionInfo.status = SftpConnectionStatus.CONNECTING
      connectionInfo.lastError = null

      console.log('尝试连接到服务器，连接ID:', connectionId)
      const result = await invoke('connect_ssh', { id: connectionId })
      console.log('连接结果:', result)

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
      console.error('SFTP连接失败:', errorMessage)
      throw new Error(`连接失败: ${ errorMessage }`)
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
      console.error('断开SFTP连接失败:', errorMessage)
      throw new Error(`断开连接失败: ${ errorMessage }`)
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
    try {
      const connectionInfo = this.connections.get(connectionId)
      if (!connectionInfo) {
        throw new Error('连接不存在')
      }

      if (connectionInfo.status !== SftpConnectionStatus.CONNECTED) {
        throw new Error('连接未建立')
      }

      // 模拟进度更新
      if (onProgress) {
        let progress = 0
        const interval = setInterval(() => {
          progress += Math.random() * 10
          if (progress >= 90) {
            clearInterval(interval)
          }
          onProgress(progress)
        }, 200)

        try {
          const result = await invoke('scp_upload', {
            id: connectionId,
            localPath: localPath,
            remotePath: remotePath
          })

          clearInterval(interval)
          onProgress(100)

          connectionInfo.lastActivity = Date.now()
          return result
        } catch (error) {
          clearInterval(interval)
          throw error
        }
      } else {
        const result = await invoke('scp_upload', {
          id: connectionId,
          localPath: localPath,
          remotePath: remotePath
        })

        connectionInfo.lastActivity = Date.now()
        return result
      }
    } catch (error) {
      const errorMessage = this.parseError(error)
      console.error('上传文件失败:', errorMessage)
      throw new Error(`上传文件失败: ${ errorMessage }`)
    }
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
    try {
      const connectionInfo = this.connections.get(connectionId)
      if (!connectionInfo) {
        throw new Error('连接不存在')
      }

      if (connectionInfo.status !== SftpConnectionStatus.CONNECTED) {
        throw new Error('连接未建立')
      }

      // 模拟进度更新
      if (onProgress) {
        let progress = 0
        const interval = setInterval(() => {
          progress += Math.random() * 10
          if (progress >= 90) {
            clearInterval(interval)
          }
          onProgress(progress)
        }, 200)

        try {
          const result = await invoke('scp_download', {
            id: connectionId,
            remotePath: remotePath,
            localPath: localPath
          })

          clearInterval(interval)
          onProgress(100)

          connectionInfo.lastActivity = Date.now()
          return result
        } catch (error) {
          clearInterval(interval)
          throw error
        }
      } else {
        const result = await invoke('scp_download', {
          id: connectionId,
          remotePath: remotePath,
          localPath: localPath
        })

        connectionInfo.lastActivity = Date.now()
        return result
      }
    } catch (error) {
      const errorMessage = this.parseError(error)
      console.error('下载文件失败:', errorMessage)
      throw new Error(`下载文件失败: ${ errorMessage }`)
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
        throw new Error('连接不存在')
      }

      if (connectionInfo.status !== SftpConnectionStatus.CONNECTED) {
        throw new Error('连接未建立')
      }

      // 使用SFTP命令获取目录内容
      const result = await invoke('list_sftp_directory', {
        id: connectionId,
        remotePath: remotePath
      })

      const parsedResult = JSON.parse(result)
      const files = parsedResult.files

      // 排序：目录在前，文件在后
      files.sort((a, b) => {
        if (a.isDirectory && !b.isDirectory) return -1
        if (!a.isDirectory && b.isDirectory) return 1
        return a.name.localeCompare(b.name)
      })

      connectionInfo.lastActivity = Date.now()
      return files
    } catch (error) {
      const errorMessage = this.parseError(error)
      console.error('列出远程目录失败:', errorMessage)
      throw new Error(`列出目录失败: ${ errorMessage }`)
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
        throw new Error('连接不存在')
      }

      if (connectionInfo.status !== SftpConnectionStatus.CONNECTED) {
        throw new Error('连接未建立')
      }

      await invoke('execute_ssh_command', {
        id: connectionId,
        command: `mkdir -p "${ remotePath }"`
      })

      connectionInfo.lastActivity = Date.now()
      return true
    } catch (error) {
      const errorMessage = this.parseError(error)
      console.error('创建远程目录失败:', errorMessage)
      throw new Error(`创建目录失败: ${ errorMessage }`)
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
        throw new Error('连接不存在')
      }

      if (connectionInfo.status !== SftpConnectionStatus.CONNECTED) {
        throw new Error('连接未建立')
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
      console.error('删除远程项目失败:', errorMessage)
      throw new Error(`删除失败: ${ errorMessage }`)
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
        throw new Error('连接不存在')
      }

      if (connectionInfo.status !== SftpConnectionStatus.CONNECTED) {
        throw new Error('连接未建立')
      }

      // 执行命令获取用户主目录
      const result = await invoke('execute_ssh_command', {
        id: connectionId,
        command: 'echo $HOME'
      })

      connectionInfo.lastActivity = Date.now()
      return result.trim()
    } catch (error) {
      const errorMessage = this.parseError(error)
      console.error('获取远程用户主目录失败:', errorMessage)
      throw new Error(`获取用户主目录失败: ${ errorMessage }`)
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
        throw new Error('连接不存在')
      }

      if (connectionInfo.status !== SftpConnectionStatus.CONNECTED) {
        throw new Error('连接未建立')
      }

      let drives = []
      
      // 根据不同的操作系统获取驱动器
      try {
        // 尝试获取Windows驱动器
        const windowsResult = await invoke('execute_ssh_command', {
          id: connectionId,
          command: 'wmic logicaldisk get caption'
        })
        
        // 解析Windows驱动器
        if (windowsResult) {
          const lines = windowsResult.split('\n')
          for (const line of lines) {
            const drive = line.trim()
            if (drive && drive.match(/^[A-Z]:$/)) {
              drives.push(drive)
            }
          }
        }
      } catch (error) {
        // Windows命令失败，尝试获取Linux/macOS挂载点
        try {
          const unixResult = await invoke('execute_ssh_command', {
            id: connectionId,
            command: 'df -h | grep -E "^/dev/" | awk "{print \$6}"'
          })
          
          // 解析Linux/macOS挂载点
          if (unixResult) {
            const lines = unixResult.split('\n')
            for (const line of lines) {
              const drive = line.trim()
              if (drive) {
                drives.push(drive)
              }
            }
          }
        } catch (error) {
          console.warn('获取远程驱动器失败:', error)
        }
      }

      connectionInfo.lastActivity = Date.now()
      return drives
    } catch (error) {
      const errorMessage = this.parseError(error)
      console.error('获取远程驱动器失败:', errorMessage)
      throw new Error(`获取驱动器失败: ${ errorMessage }`)
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
        console.error(`关闭连接 ${ connectionId } 失败:`, error)
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
        console.warn(`连接失败，${ this.retryDelay }ms后重试 (${ i + 1 }/${ attempts })`)
        await new Promise(resolve => setTimeout(resolve, this.retryDelay))
      }
    }
    return false
  }
}

export const sftpManager = new SftpManager()
export default sftpManager
