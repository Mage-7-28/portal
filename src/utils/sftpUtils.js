/**
 * SFTP/SSH 前端适配层。
 *
 * 统一封装 Tauri IPC 调用、连接状态、终端会话、文件传输事件以及远程目录
 * 大小统计任务，供文件浏览器和终端组件共享同一套连接生命周期。
 */
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { CONNECTION_TIMEOUT_MS, SftpConnectionStatus, normalizeError } from './constants.js'

/**
 * @typedef {Object} SshConnectionConfig
 * @property {string} [id] - 前端保存连接时使用的稳定标识。
 * @property {string} host - SSH 服务器主机名或 IP 地址。
 * @property {string|number} port - SSH 服务端口。
 * @property {string} username - 用于认证的账户名。
 * @property {string} [password] - 仅在当前进程内使用的账户密码。
 * @property {string|null} [hostKeyFingerprint] - 用户确认过的服务器主机指纹。
 */

/**
 * @typedef {Object} HostKeyInfo
 * @property {string} fingerprint - 服务器主机密钥的 SHA-256 指纹。
 * @property {string} algorithm - 服务器主机密钥算法。
 */

/**
 * @typedef {Object} ConnectionTestResult
 * @property {boolean} success - 连接、指纹和认证是否验证成功。
 * @property {boolean} requiresHostKeyConfirmation - 是否需要用户确认首次见到的指纹。
 * @property {HostKeyInfo} [hostKey] - 服务端返回的主机密钥信息。
 * @property {string} message - 适合直接展示给用户的结果说明。
 * @property {string} [error] - 测试失败时的标准化错误信息。
 */

/**
 * @typedef {Object} ConnectResult
 * @property {boolean} connected - 是否已建立可用的 SSH 会话。
 * @property {boolean} requiresHostKeyConfirmation - 是否需要先确认服务器指纹。
 * @property {HostKeyInfo} hostKey - 本次握手读取到的主机密钥信息。
 */

/**
 * @typedef {Object} ConnectionInfo
 * @property {SshConnectionConfig} config - 已规范化的连接配置。
 * @property {string} status - 当前连接状态。
 * @property {string|null} lastError - 最近一次失败的标准化错误信息。
 * @property {number} lastActivity - 最近一次成功远程操作的 Unix 时间戳（毫秒）。
 */

/**
 * @typedef {Object} RemoteEntry
 * @property {string} name - 当前目录中展示的项目名称。
 * @property {string} path - 远程项目完整路径。
 * @property {boolean} isDirectory - 项目是否为目录。
 * @property {string} kind - 远程条目类型，如 file、directory 或 symlink。
 * @property {number} size - 文件或链接自身的字节数。
 * @property {number|null} [modifiedAt] - 服务器返回的修改时间。
 * @property {number|null} [permissions] - 服务器返回的权限位。
 */

/**
 * @typedef {Object} DirectorySizeResult
 * @property {number} size - 已扫描文件的总字节数。
 * @property {boolean} complete - 是否完整扫描；权限不足等可恢复错误会使其为 false。
 * @property {number} inaccessibleCount - 未能访问的子目录数量。
 * @property {number} scannedEntries - 已纳入统计的目录条目数量。
 */

/**
 * @typedef {Object} DirectorySizeOptions
 * @property {AbortSignal} [signal] - 仅取消当前调用方订阅的取消信号。
 * @property {string|number} [cacheVersion] - 用于识别目录内容变化的外部缓存版本。
 * @property {boolean} [showHiddenFiles=false] - 是否把以点开头的远程项目纳入统计。
 */

/**
 * @typedef {Object} DirectorySizeTask
 * @property {string} cacheKey - 用于合并相同扫描请求的缓存键。
 * @property {string} connectionId - 任务所属连接 ID。
 * @property {string} remotePath - 待递归扫描的远程目录路径。
 * @property {boolean} showHiddenFiles - 是否将隐藏项目纳入扫描。
 * @property {number} cacheEpoch - 创建任务时的连接缓存代次。
 * @property {string} operationId - 用于请求 Rust 端取消任务的操作 ID。
 * @property {Set<Object>} subscribers - 等待本任务结果的前端调用方集合。
 * @property {boolean} started - 是否已提交给 Rust 端执行。
 * @property {boolean} cancelled - 是否已请求取消。
 * @property {boolean} settled - 是否已向全部订阅者返回结果。
 */

/**
 * @callback TransferProgressCallback
 * @param {number} progress - 当前文件的完成百分比，范围为 0 至 100。
 * @param {Object} payload - Rust 端发出的完整进度事件负载。
 * @returns {void}
 */

/**
 * @callback ConnectionLostListener
 * @param {{id: string, reason: string}} event - 已断开连接的标识和用户可读原因。
 * @returns {void}
 */

/**
 * 生成关联 IPC 事件与前端回调的临时操作 ID。
 *
 * @param {string} prefix - 操作类别前缀，用于区分连接、传输和目录统计任务。
 * @returns {string} 全局唯一的临时操作标识。
 */
const randomId = (prefix) => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${ prefix }-${ crypto.randomUUID() }`
  }
  return `${ prefix }-${ Date.now() }-${ Math.random().toString(16).slice(2) }`
}

// 目录大小结果短期缓存，减少列表滚动和重复渲染触发的重复递归扫描。
const DIRECTORY_SIZE_CACHE_TTL_MS = 45 * 1000
// 限制缓存条目数，防止长期浏览大量路径导致前端内存无界增长。
const MAX_DIRECTORY_SIZE_CACHE_ENTRIES = 500
// 调用方取消或连接清理时使用的统一错误文案。
const DIRECTORY_SIZE_CANCELLED_MESSAGE = '目录大小统计已取消'

/**
 * 兼容旧调用方式：可直接传入 AbortSignal 或完整选项对象。
 *
 * @param {AbortSignal|DirectorySizeOptions|undefined|null} options - 调用方提供的统计选项。
 * @returns {DirectorySizeOptions} 已规范化的目录统计选项对象。
 */
const normalizeDirectorySizeOptions = (options) => {
  if (options && typeof options.addEventListener === 'function' && 'aborted' in options) {
    return { signal: options }
  }
  return options || {}
}

/**
 * 管理远程 SSH/SFTP 连接及其关联的异步任务。
 *
 * 一个实例对应一个前端进程；连接配置和状态保存在内存中，实际 SSH 会话
 * 由 Rust 端维护。目录大小统计单独使用有界队列，避免多个目录同时扫描时
 * 挤占交互请求和远端 SSH 会话资源。
 *
 * @class
 */
class SftpManager {
  /**
   * 创建连接状态表、目录统计队列和 Rust 端断线监听器。
   *
   * @returns {void}
   */
  constructor() {
    // connectionId -> ConnectionInfo，保存连接配置、状态、错误和最近活动时间。
    this.connections = new Map()
    // UI 层断线订阅者集合；每个订阅者由 subscribeConnectionLost 返回的函数移除。
    this.connectionLostListeners = new Set()
    // 远程命令默认超时和历史重试参数，供连接流程兼容旧调用方。
    this.defaultTimeout = CONNECTION_TIMEOUT_MS
    this.retryAttempts = 3
    this.retryDelay = 1000
    // Rust `ssh-disconnected` 事件的唯一取消监听函数。
    this.connectionEventUnlisten = null
    // 目录统计使用独立 SSH 会话；限制并发数，兼顾扫描速度和远端会话压力。
    this.directorySizeQueue = []
    // cacheKey -> DirectorySizeTask，用于合并同一目录的并发请求。
    this.directorySizeRequests = new Map()
    // cacheKey -> 带过期时间的 DirectorySizeResult，按插入顺序淘汰最旧条目。
    this.directorySizeCache = new Map()
    // 远端写入后推进代次，已启动的旧扫描结果不能回写到新视图的缓存。
    this.directorySizeCacheEpochs = new Map()
    this.activeDirectorySizeRequests = 0
    this.maxDirectorySizeRequests = 4
    void this.listenForConnectionLoss()
  }

  /**
   * 注册全局 SSH 断线事件监听器。
   *
   * 浏览器预览环境没有 Tauri 事件总线时会静默跳过，远程命令异常仍由
   * {@link SftpManager#invokeRemote} 的降级逻辑处理。
   *
   * @returns {Promise<void>} 监听器注册完成后的 Promise。
   */
  async listenForConnectionLoss() {
    try {
      this.connectionEventUnlisten = await listen('ssh-disconnected', event => {
        this.handleConnectionLoss(event.payload || {})
      })
    } catch {
      // 连接管理器也会被浏览器端工具使用，此时无法监听 Tauri 事件；
      // 远程命令错误仍然通过本地降级逻辑处理。
    }
  }

  /**
   * 订阅连接丢失通知。
   *
   * @param {ConnectionLostListener} listener - 接收断线连接标识和原因的回调。
   * @returns {() => boolean} 取消订阅函数；返回值表示监听器是否仍在集合中。
   */
  subscribeConnectionLost(listener) {
    this.connectionLostListeners.add(listener)
    return () => this.connectionLostListeners.delete(listener)
  }

  /**
   * 将 Rust 端的断线事件转换为本地连接状态变化。
   *
   * @param {{id?: string, reason?: string}} [payload={}] - Rust 端 `ssh-disconnected` 事件负载。
   * @returns {void}
   */
  handleConnectionLoss(payload = {}) {
    const connectionId = payload.id
    if (!connectionId) return
    this.markConnectionLost(connectionId, payload.reason || 'SSH 连接已断开')
  }

  /**
   * 标记连接失效，同时取消目录统计任务、清理缓存并通知订阅者。
   *
   * @param {string} connectionId - 需要标记为断开的连接 ID。
   * @param {unknown} reason - 原始错误或用户可读断线原因。
   * @returns {boolean} 连接此前处于活动状态时返回 true，否则返回 false。
   */
  markConnectionLost(connectionId, reason) {
    const info = this.connections.get(connectionId)
    if (!info) return false
    const wasActive = info.status === SftpConnectionStatus.CONNECTED
      || info.status === SftpConnectionStatus.CONNECTING
      || info.status === SftpConnectionStatus.RECONNECTING
    const message = normalizeError(reason)
    const connectionMessage = this.isConnectionLossError(reason)
      ? '服务器无响应或网络已断开，请重新连接'
      : message
    info.status = SftpConnectionStatus.DISCONNECTED
    info.lastError = message
    this.cancelDirectorySizeRequests(connectionId, message)
    this.invalidateDirectorySizeCache(connectionId)
    this.pumpDirectorySizeQueue()
    if (!wasActive) return false
    const event = { id: connectionId, reason: connectionMessage }
    this.connectionLostListeners.forEach(listener => listener(event))
    return true
  }

  /**
   * 判断错误是否代表传输层断线，而不是路径或权限等可恢复错误。
   *
   * @param {unknown} error - IPC、网络或普通 JavaScript 错误。
   * @returns {boolean} 错误属于 socket、连接关闭、网络或超时场景时返回 true。
   */
  isConnectionLossError(error) {
    const message = normalizeError(error).toLowerCase()
    return /(socket|broken pipe|connection (?:lost|reset|aborted|closed|not connected)|network|timed out|timeout|连接(?:不存在|未建立|已断开|已关闭|丢失|超时)|套接字|网络)/i.test(message)
  }

  /**
   * 调用远程 Tauri 命令，并在必要时执行连接健康检查。
   *
   * @param {string} connectionId - 命令关联的连接 ID。
   * @param {string} command - 要调用的 Tauri 命令名称。
   * @param {Record<string, unknown>} args - 传递给 Tauri 命令的参数。
   * @param {{suppressHealthCheck?: () => boolean}} [options={}] - 取消任务等场景使用的保活检查抑制策略。
   * @returns {Promise<unknown>} Rust 命令返回的原始结果。
   * @throws {unknown} 当远程命令失败时原样抛出；连接异常会先同步本地状态。
   */
  async invokeRemote(connectionId, command, args, options = {}) {
    try {
      return await invoke(command, args)
    } catch (error) {
      if (this.isConnectionLossError(error)) {
        this.markConnectionLost(connectionId, error)
      } else if (!options.suppressHealthCheck?.()) {
        // 某些 SFTP 失效只返回通用 failure，先用保活探测区分断线和权限/路径错误。
        try {
          const alive = await this.checkConnection(connectionId)
          if (!alive) this.markConnectionLost(connectionId, '服务器无响应或网络已断开')
        } catch {
          this.markConnectionLost(connectionId, '服务器无响应或网络已断开')
        }
      }
      throw error
    }
  }

  /**
   * 测试连接、主机指纹和账户密码，不改变已保存的连接状态。
   *
   * 连接失败会转换为结果对象，便于表单直接展示失败原因，而不是抛出异常。
   *
   * @param {SshConnectionConfig} config - 待测试的连接配置。
   * @param {number} [timeout=this.defaultTimeout] - TCP 与 SSH 握手超时时间（毫秒）。
   * @returns {Promise<ConnectionTestResult>} 测试结果或待确认的服务器主机指纹。
   */
  async testConnection(config, timeout = this.defaultTimeout) {
    try {
      const result = await invoke('test_sftp_connection', {
        host: config.host,
        port: Number(config.port),
        username: config.username,
        password: config.password || '',
        authMethod: 'password',
        timeout,
        hostKeyFingerprint: config.hostKeyFingerprint || null
      })
      return {
        success: Boolean(result.success),
        requiresHostKeyConfirmation: Boolean(result.requiresHostKeyConfirmation),
        hostKey: result.hostKey,
        message: result.success ? '连接测试成功' : '需要确认服务器指纹'
      }
    } catch (error) {
      return {
        success: false,
        requiresHostKeyConfirmation: false,
        error: normalizeError(error),
        message: '连接测试失败'
      }
    }
  }

  /**
   * 创建或覆盖本地连接记录，并把规范化配置同步到 Rust 端。
   *
   * @param {SshConnectionConfig} config - 用户输入或持久化恢复的连接配置。
   * @returns {Promise<string>} 可用于后续连接和远程操作的连接 ID。
   * @throws {Error} 当 Rust 端拒绝或无法保存连接配置时抛出。
   */
  async createConnection(config) {
    const id = config.id || randomId('connection')
    const normalized = {
      ...config,
      id,
      port: Number(config.port),
      authMethod: 'password',
      hostKeyFingerprint: config.hostKeyFingerprint || null
    }

    const previous = this.connections.get(id)
    if (previous?.status === SftpConnectionStatus.CONNECTED) {
      await this.disconnect(id).catch(() => undefined)
    }

    await invoke('add_ssh_connection', {
      id,
      host: normalized.host,
      port: normalized.port,
      username: normalized.username,
      password: normalized.password || '',
      authMethod: 'password',
      hostKeyFingerprint: normalized.hostKeyFingerprint
    })

    this.connections.set(id, {
      config: normalized,
      status: SftpConnectionStatus.DISCONNECTED,
      lastError: null,
      lastActivity: Date.now()
    })
    return id
  }

  /**
   * 保存用户确认后的 SSH 主机指纹。
   *
   * @param {string} connectionId - 目标连接 ID。
   * @param {string} fingerprint - 要信任的 SHA-256 主机指纹。
   * @returns {Promise<void>} 指纹同步到 Rust 端后的 Promise。
   * @throws {Error} 当连接不存在或 Rust 端拒绝指纹时抛出。
   */
  async updateHostKey(connectionId, fingerprint) {
    const info = this.requireConnection(connectionId)
    info.config.hostKeyFingerprint = fingerprint
    await invoke('set_ssh_host_key', {
      id: connectionId,
      fingerprint
    })
  }

  /**
   * 建立指定 SSH 连接。
   *
   * 首次遇到未知主机指纹时不认证账户，而是返回待确认的指纹信息。
   *
   * @param {string} connectionId - 要建立连接的配置 ID。
   * @returns {Promise<ConnectResult>} 已连接结果或待确认主机指纹结果。
   * @throws {Error} 当连接配置无效、网络不可达或认证失败时抛出。
   */
  async connect(connectionId) {
    const info = this.requireConnection(connectionId)
    info.status = SftpConnectionStatus.CONNECTING
    info.lastError = null

    try {
      const result = await invoke('connect_ssh', { id: connectionId })
      if (result.requiresHostKeyConfirmation) {
        info.status = SftpConnectionStatus.DISCONNECTED
        return result
      }
      if (!result.connected) {
        throw new Error('服务器拒绝连接')
      }
      info.status = SftpConnectionStatus.CONNECTED
      info.lastActivity = Date.now()
      this.invalidateDirectorySizeCache(connectionId)
      return result
    } catch (error) {
      info.status = SftpConnectionStatus.ERROR
      info.lastError = normalizeError(error)
      throw error
    }
  }

  /**
   * 断开连接并清理相关终端、目录统计缓存和排队任务。
   *
   * @param {string} connectionId - 要断开的连接 ID。
   * @returns {Promise<boolean>} 无论连接是否存在，清理完成后均返回 true。
   * @throws {Error} 当 Rust 端主动断开会话失败时抛出；本地清理仍会执行。
   */
  async disconnect(connectionId) {
    const info = this.connections.get(connectionId)
    if (!info) return true
    try {
      await invoke('disconnect_ssh', { id: connectionId })
    } finally {
      info.status = SftpConnectionStatus.DISCONNECTED
      info.lastError = null
      this.cancelDirectorySizeRequests(connectionId, '连接已断开')
      this.invalidateDirectorySizeCache(connectionId)
      this.pumpDirectorySizeQueue()
    }
    return true
  }

  /**
   * 为已连接的远程服务器创建一个 PTY 终端会话。
   *
   * @param {string} connectionId - 已建立的 SSH 连接 ID。
   * @param {string} terminalId - 前端为该终端生成的唯一会话 ID。
   * @param {number} columns - 终端初始列数。
   * @param {number} rows - 终端初始行数。
   * @returns {Promise<boolean>} Rust 端成功创建远程 PTY 时返回 true。
   * @throws {Error} 当连接不存在、未建立或远程 PTY 无法创建时抛出。
   */
  async openTerminal(connectionId, terminalId, columns, rows) {
    this.requireConnected(connectionId)
    return invoke('open_ssh_terminal', {
      id: connectionId,
      terminalId,
      columns,
      rows
    })
  }

  /**
   * 向已打开的远程终端写入键盘输入。
   *
   * @param {string} terminalId - 目标 PTY 会话 ID。
   * @param {string} data - 待发送的原始键盘输入。
   * @returns {Promise<boolean>} Rust 端接收输入后返回 true。
   * @throws {Error} 当终端会话不存在或写入失败时抛出。
   */
  async writeTerminal(terminalId, data) {
    return invoke('write_ssh_terminal', {
      terminalId,
      data
    })
  }

  /**
   * 更新远程 PTY 的行列尺寸。
   *
   * @param {string} terminalId - 目标 PTY 会话 ID。
   * @param {number} columns - 新的终端列数。
   * @param {number} rows - 新的终端行数。
   * @returns {Promise<boolean>} Rust 端应用新尺寸后返回 true。
   * @throws {Error} 当终端会话不存在或尺寸更新失败时抛出。
   */
  async resizeTerminal(terminalId, columns, rows) {
    return invoke('resize_ssh_terminal', {
      terminalId,
      columns,
      rows
    })
  }

  /**
   * 关闭远程终端；连接已断开时允许 Rust 端会话已经不存在。
   *
   * @param {string} terminalId - 要关闭的 PTY 会话 ID。
   * @returns {Promise<boolean>} 成功关闭时返回 true；会话已被后端清理时返回 false。
   */
  async closeTerminal(terminalId) {
    try {
      return await invoke('close_ssh_terminal', { terminalId })
    } catch {
      // 连接断开后 Rust 端可能已经清理会话，关闭操作可以安全忽略。
      return false
    }
  }

  /**
   * 上传单个本地文件，并通过回调报告传输进度。
   *
   * @param {string} connectionId - 已建立的 SSH 连接 ID。
   * @param {string} localPath - 本机源文件绝对路径。
   * @param {string} remotePath - 远程目标文件路径。
   * @param {TransferProgressCallback} [onProgress] - 接收传输进度事件的回调。
   * @param {boolean} [overwrite=false] - 目标存在时是否允许覆盖。
   * @param {(transferId: string) => void} [onTransferId] - 任务创建后接收可取消传输 ID 的回调。
   * @returns {Promise<string>} Rust 端发出的成功完成消息。
   * @throws {Error} 当连接无效、传输失败或被取消时抛出。
   */
  async uploadFile(connectionId, localPath, remotePath, onProgress, overwrite = false, onTransferId) {
    return this.transfer('upload', connectionId, {
      localPath,
      remotePath,
      onProgress,
      overwrite,
      onTransferId
    })
  }

  /**
   * 递归上传本地目录。
   *
   * @param {string} connectionId - 已建立的 SSH 连接 ID。
   * @param {string} localPath - 本机源目录绝对路径。
   * @param {string} remotePath - 远程目标目录路径。
   * @param {TransferProgressCallback} [onProgress] - 接收单文件和整体进度事件的回调。
   * @param {boolean} [overwrite=false] - 目标目录或文件存在时是否允许覆盖。
   * @param {(transferId: string) => void} [onTransferId] - 任务创建后接收可取消传输 ID 的回调。
   * @returns {Promise<string>} Rust 端发出的成功完成消息。
   * @throws {Error} 当连接无效、目录扫描失败、传输失败或被取消时抛出。
   */
  async uploadDirectory(connectionId, localPath, remotePath, onProgress, overwrite = false, onTransferId) {
    return this.transfer('upload-directory', connectionId, {
      localPath,
      remotePath,
      onProgress,
      overwrite,
      onTransferId
    })
  }

  /**
   * 下载单个远程文件到本地路径。
   *
   * @param {string} connectionId - 已建立的 SSH 连接 ID。
   * @param {string} remotePath - 远程源文件路径。
   * @param {string} localPath - 本机目标文件绝对路径。
   * @param {TransferProgressCallback} [onProgress] - 接收传输进度事件的回调。
   * @param {boolean} [overwrite=false] - 本机目标已存在时是否允许覆盖。
   * @param {(transferId: string) => void} [onTransferId] - 任务创建后接收可取消传输 ID 的回调。
   * @returns {Promise<string>} Rust 端发出的成功完成消息。
   * @throws {Error} 当连接无效、传输失败或被取消时抛出。
   */
  async downloadFile(connectionId, remotePath, localPath, onProgress, overwrite = false, onTransferId) {
    return this.transfer('download', connectionId, {
      remotePath,
      localPath,
      onProgress,
      overwrite,
      onTransferId
    })
  }

  /**
   * 递归下载远程目录。
   *
   * @param {string} connectionId - 已建立的 SSH 连接 ID。
   * @param {string} remotePath - 远程源目录路径。
   * @param {string} localPath - 本机目标目录绝对路径。
   * @param {TransferProgressCallback} [onProgress] - 接收单文件和整体进度事件的回调。
   * @param {boolean} [overwrite=false] - 本机目录或文件存在时是否允许覆盖。
   * @param {(transferId: string) => void} [onTransferId] - 任务创建后接收可取消传输 ID 的回调。
   * @returns {Promise<string>} Rust 端发出的成功完成消息。
   * @throws {Error} 当连接无效、目录扫描失败、传输失败或被取消时抛出。
   */
  async downloadDirectory(connectionId, remotePath, localPath, onProgress, overwrite = false, onTransferId) {
    return this.transfer('download-directory', connectionId, {
      remotePath,
      localPath,
      onProgress,
      overwrite,
      onTransferId
    })
  }

  /**
   * 监听传输事件并等待对应的上传或下载任务完成。
   *
   * @param {'upload'|'upload-directory'|'download'|'download-directory'} direction - 传输方向和项目类型。
   * @param {string} connectionId - 已建立的 SSH 连接 ID。
   * @param {{localPath: string, remotePath: string, onProgress?: TransferProgressCallback, overwrite?: boolean, onTransferId?: (transferId: string) => void}} options - 传输路径、覆盖策略和回调。
   * @returns {Promise<string>} 对应完成事件中的成功消息。
   * @throws {Error} 当连接不存在、远程命令失败、超时取消或完成事件报告失败时抛出。
   */
  async transfer(direction, connectionId, options) {
    const info = this.requireConnected(connectionId)
    const transferId = randomId(direction)
    const isUpload = direction === 'upload' || direction === 'upload-directory'
    const progressEvent = isUpload ? 'upload-progress' : 'download-progress'
    const completeEvent = isUpload ? 'upload-complete' : 'download-complete'
    options.onTransferId?.(transferId)
    let unlistenProgress
    let unlistenComplete
    let timeoutHandle

    try {
      let resolveCompletion
      let rejectCompletion
      const completion = new Promise((resolve, reject) => {
        resolveCompletion = resolve
        rejectCompletion = reject
      })
      /**
       * 处理当前传输的完成事件，并把失败原因转换为 Promise 结果。
       *
       * @param {{payload?: Object}} event - Rust 端传来的完成事件。
       * @returns {void}
       */
      const completeHandler = (event) => {
        const payload = event.payload || {}
        if (payload.id !== connectionId || payload.transferId !== transferId) return
        if (payload.cancelled) {
          rejectCompletion(new Error('传输已取消'))
        } else if (payload.success) {
          resolveCompletion(payload.message)
        } else {
          const transferError = new Error(payload.message || '传输失败')
          if (this.isConnectionLossError(transferError)) {
            this.markConnectionLost(connectionId, transferError)
          }
          rejectCompletion(transferError)
        }
      }
      /**
       * 过滤连接和传输 ID 后转发进度，避免串线到其他并发任务。
       *
       * @param {{payload?: Object}} event - Rust 端传来的进度事件。
       * @returns {void}
       */
      const progressHandler = (event) => {
        const payload = event.payload || {}
        if (payload.id === connectionId && payload.transferId === transferId) {
          options.onProgress?.(payload.progress, payload)
        }
      }
      // 先注册监听器再调用工作线程，避免错过快速完成事件。
      if (options.onProgress) unlistenProgress = await listen(progressEvent, progressHandler)
      unlistenComplete = await listen(completeEvent, completeHandler)
      const command = direction === 'upload'
        ? 'scp_upload'
        : direction === 'upload-directory'
          ? 'sftp_upload_directory'
          : direction === 'download-directory'
            ? 'sftp_download_directory'
            : 'scp_download'
      await this.invokeRemote(connectionId, command, isUpload
        ? {
          id: connectionId,
          localPath: options.localPath,
          remotePath: options.remotePath,
          transferId,
          overwrite: options.overwrite
        }
        : {
          id: connectionId,
          remotePath: options.remotePath,
          localPath: options.localPath,
          transferId,
          overwrite: options.overwrite
        })

      timeoutHandle = setTimeout(() => {
        void this.cancelTransfer(transferId)
      }, 30 * 60 * 1000)
      const result = await completion
      info.lastActivity = Date.now()
      if (isUpload) this.invalidateDirectorySizeCache(connectionId)
      return result
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle)
      unlistenProgress?.()
      unlistenComplete?.()
    }
  }

  /**
   * 请求 Rust 端取消指定传输任务。
   *
   * @param {string} transferId - 创建传输任务时生成的唯一标识。
   * @returns {Promise<boolean>} Rust 端接受取消请求时返回 true。
   * @throws {Error} 当 IPC 调用失败时抛出。
   */
  async cancelTransfer(transferId) {
    return invoke('cancel_transfer', { transferId })
  }

  /**
   * 删除连接配置，并先释放其已建立的远程会话。
   *
   * @param {string} connectionId - 要删除的连接 ID。
   * @returns {Promise<boolean>} 本地记录删除完成后返回 true。
   * @throws {Error} 当 Rust 端无法删除连接配置时抛出。
   */
  async removeConnection(connectionId) {
    await this.disconnect(connectionId).catch(() => undefined)
    await invoke('remove_ssh_connection', { id: connectionId })
    this.connections.delete(connectionId)
    return true
  }

  /**
   * 读取远程文件内容，供预览功能使用。
   *
   * @param {string} connectionId - 已建立的 SSH 连接 ID。
   * @param {string} remotePath - 要预览的远程文件路径。
   * @param {string} [previewId] - 用于筛选预览进度事件的请求 ID。
   * @param {TransferProgressCallback} [onProgress] - 接收预览读取进度的回调。
   * @returns {Promise<Uint8Array>} 文件原始字节；文本解码由预览层负责。
   * @throws {Error} 当连接无效、文件过大或远程读取失败时抛出。
   */
  async getRemoteFileContent(connectionId, remotePath, previewId, onProgress) {
    this.requireConnected(connectionId)
    let unlistenProgress
    try {
      if (onProgress && previewId) {
        unlistenProgress = await listen('preview-progress', event => {
          const payload = event.payload || {}
          if (payload.id !== connectionId || payload.previewId !== previewId) return
          onProgress(payload.progress, payload)
        })
      }
      const result = await this.invokeRemote(connectionId, 'get_sftp_file_content', {
        id: connectionId,
        remotePath,
        previewId: previewId || null
      })
      return new Uint8Array(result)
    } finally {
      unlistenProgress?.()
    }
  }

  /**
   * 列出远程目录，并按目录优先、名称自然排序。
   *
   * @param {string} connectionId - 已建立的 SSH 连接 ID。
   * @param {string} remotePath - 要读取的远程目录路径。
   * @param {{showHiddenFiles?: boolean}} [options={}] - 控制是否返回以点开头的项目。
   * @returns {Promise<RemoteEntry[]>} 已排序的远程目录条目。
   * @throws {Error} 当连接无效、目录不存在或无权限读取时抛出。
   */
  async listRemoteDirectory(connectionId, remotePath, options = {}) {
    const info = this.requireConnected(connectionId)
    const showHiddenFiles = options.showHiddenFiles === true
    const files = await this.invokeRemote(connectionId, 'list_sftp_directory', {
      id: connectionId,
      remotePath,
      showHiddenFiles
    })
    info.lastActivity = Date.now()
    return files.sort((a, b) => {
      if (a.isDirectory && !b.isDirectory) return -1
      if (!a.isDirectory && b.isDirectory) return 1
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
    })
  }

  /**
   * 返回连接当前的目录统计缓存代次，用于丢弃旧扫描结果。
   *
   * @param {string} connectionId - 目标连接 ID。
   * @returns {number} 当前缓存代次；此前未写入时返回 0。
   */
  getDirectorySizeCacheEpoch(connectionId) {
    return this.directorySizeCacheEpochs.get(connectionId) || 0
  }

  /**
   * 生成同时区分路径、显示隐藏文件设置和连接代次的缓存键。
   *
   * @param {string} connectionId - 目标连接 ID。
   * @param {string} remotePath - 待统计的远程目录路径。
   * @param {string|number|undefined} cacheVersion - 调用方提供的目录内容版本。
   * @param {boolean} showHiddenFiles - 是否统计隐藏项目。
   * @param {number} cacheEpoch - 当前连接缓存代次。
   * @returns {string} 用 NUL 分隔的稳定缓存键。
   */
  getDirectorySizeCacheKey(connectionId, remotePath, cacheVersion, showHiddenFiles, cacheEpoch) {
    const normalizedPath = String(remotePath || '/').replaceAll('\\', '/').replace(/\/+$/, '') || '/'
    return `${ connectionId }\u0000${ normalizedPath }\u0000${ cacheVersion == null ? '' : String(cacheVersion) }\u0000${ showHiddenFiles ? 'with-hidden' : 'without-hidden' }\u0000${ cacheEpoch }`
  }

  /**
   * 将 Rust 返回的目录大小结果转换为稳定的前端数据结构。
   *
   * @param {number|Partial<DirectorySizeResult>} result - Rust 返回的旧版数字结果或完整统计对象。
   * @returns {DirectorySizeResult} 可安全用于界面展示和缓存的统计结果。
   * @throws {Error} 当结果不是非负有限数字时抛出。
   */
  normalizeDirectorySizeResult(result) {
    const size = Number(typeof result === 'object' ? result?.size : result)
    if (!Number.isFinite(size) || size < 0) throw new Error('目录大小无效')
    return {
      size,
      complete: result?.complete !== false,
      inaccessibleCount: Math.max(0, Math.trunc(Number(result?.inaccessibleCount) || 0)),
      scannedEntries: Math.max(0, Math.trunc(Number(result?.scannedEntries) || 0))
    }
  }

  /**
   * 获取未过期的目录统计缓存；过期条目会在读取时删除。
   *
   * @param {string} cacheKey - 目录统计缓存键。
   * @returns {DirectorySizeResult|null} 命中且未过期的结果；否则返回 null。
   */
  getCachedDirectorySize(cacheKey) {
    const cached = this.directorySizeCache.get(cacheKey)
    if (!cached) return null
    if (cached.expiresAt <= Date.now()) {
      this.directorySizeCache.delete(cacheKey)
      return null
    }
    return cached.result
  }

  /**
   * 写入带 TTL 和数量上限的目录统计缓存。
   *
   * 若连接代次已变化，说明扫描期间发生远程写入，本次结果会被安全丢弃。
   *
   * @param {string} cacheKey - 目录统计缓存键。
   * @param {string} connectionId - 结果所属连接 ID。
   * @param {number} cacheEpoch - 发起扫描时的连接缓存代次。
   * @param {DirectorySizeResult} result - 已规范化的目录统计结果。
   * @returns {void}
   */
  cacheDirectorySize(cacheKey, connectionId, cacheEpoch, result) {
    if (this.getDirectorySizeCacheEpoch(connectionId) !== cacheEpoch) return
    this.directorySizeCache.delete(cacheKey)
    while (this.directorySizeCache.size >= MAX_DIRECTORY_SIZE_CACHE_ENTRIES) {
      const oldestKey = this.directorySizeCache.keys().next().value
      if (!oldestKey) break
      this.directorySizeCache.delete(oldestKey)
    }
    this.directorySizeCache.set(cacheKey, {
      connectionId,
      expiresAt: Date.now() + DIRECTORY_SIZE_CACHE_TTL_MS,
      result
    })
  }

  /**
   * 使连接已有目录统计缓存失效，并提升其代次。
   *
   * @param {string} connectionId - 发生远程写入、重连或断线的连接 ID。
   * @returns {void}
   */
  invalidateDirectorySizeCache(connectionId) {
    if (!connectionId) return
    this.directorySizeCacheEpochs.set(
      connectionId,
      this.getDirectorySizeCacheEpoch(connectionId) + 1
    )
    this.directorySizeCache.forEach((cached, cacheKey) => {
      if (cached.connectionId === connectionId) this.directorySizeCache.delete(cacheKey)
    })
  }

  /**
   * 创建可被多个调用方共享的目录统计任务对象。
   *
   * @param {string} connectionId - 任务所属连接 ID。
   * @param {string} remotePath - 待扫描的远程目录路径。
   * @param {boolean} showHiddenFiles - 是否统计隐藏项目。
   * @param {string} cacheKey - 用于去重和缓存结果的键。
   * @param {number} cacheEpoch - 创建任务时的缓存代次。
   * @returns {DirectorySizeTask} 尚未开始执行的共享任务。
   */
  createDirectorySizeTask(connectionId, remotePath, showHiddenFiles, cacheKey, cacheEpoch) {
    return {
      cacheKey,
      connectionId,
      remotePath,
      showHiddenFiles,
      cacheEpoch,
      operationId: randomId('directory-size'),
      subscribers: new Set(),
      started: false,
      cancelled: false,
      settled: false
    }
  }

  /**
   * 以成功或失败结果结束任务，并通知全部订阅者。
   *
   * @param {DirectorySizeTask} task - 要结束的共享扫描任务。
   * @param {unknown|null} error - 扫描失败原因；成功时传入 null。
   * @param {DirectorySizeResult} [result] - 扫描成功时返回的目录统计结果。
   * @returns {void}
   */
  settleDirectorySizeTask(task, error, result) {
    if (task.settled) return
    task.settled = true
    if (this.directorySizeRequests.get(task.cacheKey) === task) {
      this.directorySizeRequests.delete(task.cacheKey)
    }
    task.subscribers.forEach(subscriber => {
      subscriber.signal?.removeEventListener('abort', subscriber.onAbort)
      if (error) subscriber.reject(error)
      else subscriber.resolve(result)
    })
    task.subscribers.clear()
  }

  /**
   * 标记目录统计任务取消；已启动任务会同步通知 Rust 端。
   *
   * @param {DirectorySizeTask} task - 要取消的共享扫描任务。
   * @returns {void}
   */
  cancelDirectorySizeTask(task) {
    if (task.cancelled || task.settled) return
    task.cancelled = true
    if (this.directorySizeRequests.get(task.cacheKey) === task) {
      this.directorySizeRequests.delete(task.cacheKey)
    }
    if (task.started) {
      void invoke('cancel_sftp_directory_size', { operationId: task.operationId }).catch(() => undefined)
      return
    }
    this.directorySizeQueue = this.directorySizeQueue.filter(queuedTask => queuedTask !== task)
  }

  /**
   * 为目录统计任务增加一个可独立取消的调用方订阅。
   *
   * 只有最后一个订阅者取消时，才会停止后端实际扫描任务。
   *
   * @param {DirectorySizeTask} task - 要订阅的共享扫描任务。
   * @param {AbortSignal} [signal] - 仅取消当前调用方等待结果的信号。
   * @returns {Promise<DirectorySizeResult>} 任务成功时解析目录统计结果的 Promise。
   * @throws {Error} 当调用方在订阅前或等待期间取消时拒绝。
   */
  subscribeDirectorySizeTask(task, signal) {
    // 相同目录共享一次后端扫描；只有最后一个订阅者取消时才终止实际任务。
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error(DIRECTORY_SIZE_CANCELLED_MESSAGE))
        return
      }
      const subscriber = {
        signal,
        resolve,
        reject,
        onAbort: null
      }
      subscriber.onAbort = () => {
        if (!task.subscribers.delete(subscriber)) return
        signal?.removeEventListener('abort', subscriber.onAbort)
        reject(new Error(DIRECTORY_SIZE_CANCELLED_MESSAGE))
        if (task.subscribers.size === 0) {
          this.cancelDirectorySizeTask(task)
          this.pumpDirectorySizeQueue()
        }
      }
      task.subscribers.add(subscriber)
      signal?.addEventListener('abort', subscriber.onAbort, { once: true })
    })
  }

  /**
   * 取消连接关联的所有目录统计请求，并向订阅者返回统一原因。
   *
   * @param {string} connectionId - 要清理任务的连接 ID。
   * @param {string} [reason='连接已断开'] - 用于拒绝订阅者 Promise 的错误描述。
   * @returns {void}
   */
  cancelDirectorySizeRequests(connectionId, reason = '连接已断开') {
    const error = new Error(reason)
    Array.from(this.directorySizeRequests.values()).forEach(task => {
      if (task.connectionId !== connectionId) return
      this.cancelDirectorySizeTask(task)
      this.settleDirectorySizeTask(task, error)
    })
  }

  /**
   * 按并发上限推进目录统计队列，启动和回收后端扫描任务。
   *
   * @returns {void}
   */
  pumpDirectorySizeQueue() {
    while (
      this.activeDirectorySizeRequests < this.maxDirectorySizeRequests
      && this.directorySizeQueue.length > 0
    ) {
      const task = this.directorySizeQueue.shift()
      if (task.cancelled || task.settled || task.subscribers.size === 0) {
        continue
      }
      if (this.getConnectionStatus(task.connectionId) !== SftpConnectionStatus.CONNECTED) {
        this.settleDirectorySizeTask(task, new Error('连接已断开'))
        continue
      }

      this.activeDirectorySizeRequests += 1
      task.started = true
      void (async () => {
        try {
          const result = await this.invokeRemote(
            task.connectionId,
            'get_sftp_directory_size',
            {
              id: task.connectionId,
              remotePath: task.remotePath,
              showHiddenFiles: task.showHiddenFiles,
              operationId: task.operationId
            },
            // 已取消的统计无需再发起一次保活探测，避免它排在用户的目录切换请求之前。
            { suppressHealthCheck: () => task.cancelled || task.settled }
          )
          const info = this.connections.get(task.connectionId)
          if (info) info.lastActivity = Date.now()
          if (task.cancelled || task.settled) return
          const normalizedResult = this.normalizeDirectorySizeResult(result)
          this.cacheDirectorySize(task.cacheKey, task.connectionId, task.cacheEpoch, normalizedResult)
          this.settleDirectorySizeTask(task, null, normalizedResult)
        } catch (error) {
          if (!task.cancelled && !task.settled) this.settleDirectorySizeTask(task, error)
        } finally {
          this.activeDirectorySizeRequests -= 1
          this.pumpDirectorySizeQueue()
        }
      })()
    }
  }

  /**
   * 获取远程目录递归大小，优先复用缓存和相同路径的进行中任务。
   *
   * @param {string} connectionId - 已建立的 SSH 连接 ID。
   * @param {string} remotePath - 待统计的远程目录路径。
   * @param {AbortSignal|DirectorySizeOptions} [options] - 缓存、隐藏文件和取消选项。
   * @returns {Promise<DirectorySizeResult>} 已缓存或新扫描得到的目录统计结果。
   * @throws {Error} 当连接无效、调用方取消或 Rust 端扫描失败时抛出。
   */
  async getRemoteDirectorySize(connectionId, remotePath, options) {
    this.requireConnected(connectionId)
    const { signal, cacheVersion, showHiddenFiles: requestedShowHiddenFiles } = normalizeDirectorySizeOptions(options)
    const showHiddenFiles = requestedShowHiddenFiles === true
    if (signal?.aborted) throw new Error(DIRECTORY_SIZE_CANCELLED_MESSAGE)
    const cacheEpoch = this.getDirectorySizeCacheEpoch(connectionId)
    const cacheKey = this.getDirectorySizeCacheKey(
      connectionId,
      remotePath,
      cacheVersion,
      showHiddenFiles,
      cacheEpoch
    )
    const cached = this.getCachedDirectorySize(cacheKey)
    if (cached) return cached

    let task = this.directorySizeRequests.get(cacheKey)
    if (!task) {
      task = this.createDirectorySizeTask(
        connectionId,
        remotePath,
        showHiddenFiles,
        cacheKey,
        cacheEpoch
      )
      this.directorySizeRequests.set(cacheKey, task)
      this.directorySizeQueue.push(task)
    }
    const result = this.subscribeDirectorySizeTask(task, signal)
    this.pumpDirectorySizeQueue()
    return result
  }

  /**
   * 在远程创建目录，并使相关目录大小缓存失效。
   *
   * @param {string} connectionId - 已建立的 SSH 连接 ID。
   * @param {string} remotePath - 要创建的远程目录路径。
   * @returns {Promise<boolean>} 目录创建成功后返回 true。
   * @throws {Error} 当连接无效、目录已存在或服务器拒绝创建时抛出。
   */
  async createRemoteDirectory(connectionId, remotePath) {
    this.requireConnected(connectionId)
    await this.invokeRemote(connectionId, 'sftp_mkdir', { id: connectionId, remotePath })
    this.invalidateDirectorySizeCache(connectionId)
    return true
  }

  /**
   * 删除远程文件或目录，并监听递归删除进度。
   *
   * @param {string} connectionId - 已建立的 SSH 连接 ID。
   * @param {string} remotePath - 要删除的远程项目路径。
   * @param {boolean} [isDirectory=false] - 调用方已知项目为目录时传入 true。
   * @param {TransferProgressCallback} [onProgress] - 接收递归删除进度事件的回调。
   * @returns {Promise<boolean>} 删除完成后返回 true。
   * @throws {Error} 当连接无效、删除失败或后端完成事件报告失败时抛出。
   */
  async deleteRemoteItem(connectionId, remotePath, isDirectory = false, onProgress) {
    const info = this.requireConnected(connectionId)
    const operationId = randomId('delete')
    let unlistenProgress
    let unlistenComplete
    try {
      let resolveCompletion
      let rejectCompletion
      const completion = new Promise((resolve, reject) => {
        resolveCompletion = resolve
        rejectCompletion = reject
      })
      const completeHandler = event => {
        const payload = event.payload || {}
        if (payload.id !== connectionId || payload.operationId !== operationId) return
        if (payload.success) {
          resolveCompletion(payload.message)
        } else {
          const deleteError = new Error(payload.message || '删除失败')
          if (this.isConnectionLossError(deleteError)) {
            this.markConnectionLost(connectionId, deleteError)
          }
          rejectCompletion(deleteError)
        }
      }
      if (onProgress) {
        unlistenProgress = await listen('delete-progress', event => {
          const payload = event.payload || {}
          if (payload.id === connectionId && payload.operationId === operationId) {
            onProgress(payload.progress, payload)
          }
        })
      }
      unlistenComplete = await listen('delete-complete', completeHandler)
      await this.invokeRemote(connectionId, 'sftp_delete', {
        id: connectionId,
        remotePath,
        isDirectory,
        operationId
      })
      await completion
      info.lastActivity = Date.now()
      this.invalidateDirectorySizeCache(connectionId)
      return true
    } finally {
      unlistenProgress?.()
      unlistenComplete?.()
    }
  }

  /**
   * 重命名远程文件或目录，可按调用方要求覆盖目标。
   *
   * @param {string} connectionId - 已建立的 SSH 连接 ID。
   * @param {string} sourcePath - 原始远程路径。
   * @param {string} targetPath - 新的远程路径。
   * @param {boolean} [overwrite=false] - 目标已存在时是否允许覆盖。
   * @returns {Promise<boolean>} 重命名成功后返回 true。
   * @throws {Error} 当连接无效、源路径不存在或服务器拒绝重命名时抛出。
   */
  async renameRemoteItem(connectionId, sourcePath, targetPath, overwrite = false) {
    this.requireConnected(connectionId)
    await this.invokeRemote(connectionId, 'sftp_rename', { id: connectionId, sourcePath, targetPath, overwrite })
    this.invalidateDirectorySizeCache(connectionId)
    return true
  }

  /**
   * 查询远程账户的主目录。
   *
   * @param {string} connectionId - 已建立的 SSH 连接 ID。
   * @returns {Promise<string>} 服务器规范化后的远程主目录路径。
   * @throws {Error} 当连接无效或服务器无法解析当前目录时抛出。
   */
  async getRemoteUserHome(connectionId) {
    const info = this.requireConnected(connectionId)
    const home = await this.invokeRemote(connectionId, 'get_sftp_user_home', { id: connectionId })
    info.lastActivity = Date.now()
    return home
  }

  /**
   * 返回远程系统信息；当前协议层仅提供占位结果。
   *
   * @param {string} connectionId - 要校验的已连接 SSH 连接 ID。
   * @returns {Promise<{os: string, version: string}>} 当前固定返回未知系统信息的 Promise。
   * @throws {Error} 当连接未建立时抛出。
   */
  async getRemoteSystemInfo(connectionId) {
    this.requireConnected(connectionId)
    return { os: 'unknown', version: '' }
  }

  /**
   * 将 Windows 远程主目录转换为可浏览的盘符列表。
   *
   * @param {string} connectionId - 已建立的 SSH 连接 ID。
   * @returns {Promise<string[]>} Windows 主目录返回对应盘符根路径，其他系统返回空数组。
   * @throws {Error} 当连接无效或主目录查询失败时抛出。
   */
  async getRemoteDrives(connectionId) {
    const info = this.requireConnected(connectionId)
    const home = await this.invokeRemote(connectionId, 'get_sftp_user_home', { id: connectionId })
    info.lastActivity = Date.now()
    const match = /^([A-Za-z]):(?:[/\\]|$)/.exec(home || '')
    return match ? [`${ match[1] }:/`] : []
  }

  /**
   * 查询连接当前状态。
   *
   * @param {string} connectionId - 要查询的连接 ID。
   * @returns {string} 已记录的连接状态；未找到时返回 `DISCONNECTED`。
   */
  getConnectionStatus(connectionId) {
    return this.connections.get(connectionId)?.status || SftpConnectionStatus.DISCONNECTED
  }

  /**
   * 获取连接的完整内存记录，未找到时返回 null。
   *
   * @param {string} connectionId - 要查询的连接 ID。
   * @returns {ConnectionInfo|null} 当前内存记录或 null。
   */
  getConnectionInfo(connectionId) {
    return this.connections.get(connectionId) || null
  }

  /**
   * 通过 Rust 端保活检查连接是否仍可用。
   *
   * @param {string} connectionId - 已建立的 SSH 连接 ID。
   * @returns {Promise<boolean>} 服务器确认连接可用时返回 true。
   * @throws {Error} 当保活失败时抛出，并在本地标记连接已断开。
   */
  async checkConnection(connectionId) {
    this.requireConnected(connectionId)
    try {
      const result = await invoke('check_ssh_connection', { id: connectionId })
      const info = this.connections.get(connectionId)
      if (info) info.lastActivity = Date.now()
      const healthy = Boolean(result)
      if (!healthy) this.markConnectionLost(connectionId, '服务器无响应或网络已断开')
      return healthy
    } catch (error) {
      this.markConnectionLost(
        connectionId,
        this.isConnectionLossError(error) ? error : '服务器无响应或网络已断开'
      )
      throw error
    }
  }

  /**
   * 在应用退出或页面重置时关闭所有连接。
   *
   * 单条连接关闭失败不会阻断其余连接的清理。
   *
   * @returns {Promise<void>} 全部本地连接状态清理完成后的 Promise。
   */
  async closeAllConnections() {
    await Promise.all(Array.from(this.connections.keys()).map(connectionId => this.disconnect(connectionId).catch(() => undefined)))
    this.connections.clear()
  }

  /**
   * 将连接状态表转换为普通对象，便于调试或兼容旧调用方。
   *
   * @returns {Record<string, ConnectionInfo>} 以连接 ID 为键的当前内存状态快照。
   */
  getConnections() {
    return Object.fromEntries(this.connections)
  }

  /**
   * 根据配置复用已有 ID，否则生成新的连接 ID。
   *
   * @param {SshConnectionConfig} config - 待保存或新建的连接配置。
   * @returns {string} 配置已有 ID 或新生成的连接 ID。
   */
  generateConnectionId(config) {
    return config.id || randomId('connection')
  }

  /**
   * 使用统一错误格式化函数转换 IPC 或网络错误。
   *
   * @param {unknown} error - 待展示的原始错误值。
   * @returns {string} 用户可读的错误文本。
   */
  parseError(error) {
    return normalizeError(error)
  }

  /**
   * 按有限次数重试建立连接，最后一次错误会原样抛出。
   *
   * @param {string} connectionId - 要重试的连接 ID。
   * @param {number} [attempts=this.retryAttempts] - 总尝试次数，至少会执行一次。
   * @returns {Promise<ConnectResult>} 连接成功或待确认主机指纹时的结果。
   * @throws {Error} 当全部尝试失败或连接配置不存在时抛出最后一个错误。
   */
  async connectWithRetry(connectionId, attempts = this.retryAttempts) {
    let lastError
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        return await this.connect(connectionId)
      } catch (error) {
        lastError = error
        if (attempt < attempts - 1) await new Promise(resolve => setTimeout(resolve, this.retryDelay))
      }
    }
    throw lastError || new Error('连接失败')
  }

  /**
   * 读取连接记录，不存在时抛出统一错误。
   *
   * @param {string} connectionId - 要读取的连接 ID。
   * @returns {ConnectionInfo} 对应连接的内存状态记录。
   * @throws {Error} 当连接 ID 未注册时抛出。
   */
  requireConnection(connectionId) {
    const info = this.connections.get(connectionId)
    if (!info) throw new Error('连接不存在')
    return info
  }

  /**
   * 读取并校验连接已建立，供所有远程操作复用。
   *
   * @param {string} connectionId - 要校验的连接 ID。
   * @returns {ConnectionInfo} 已建立连接的内存状态记录。
   * @throws {Error} 当连接不存在或尚未建立时抛出。
   */
  requireConnected(connectionId) {
    const info = this.requireConnection(connectionId)
    if (info.status !== SftpConnectionStatus.CONNECTED) throw new Error('连接未建立')
    return info
  }
}

export const sftpManager = new SftpManager()
export default sftpManager
