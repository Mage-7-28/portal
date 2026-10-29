/**
 * SFTP/SSH 前端适配层。
 *
 * 统一封装 Tauri IPC 调用、连接状态、文件传输事件以及远程目录大小统计任务。
 */
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { CONNECTION_TIMEOUT_MS, SftpConnectionStatus, getErrorCode, getErrorDetails, normalizeError } from './constants.js'

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
 * @property {number} [generation] - 已认证会话的原生代次。
 */

/**
 * @typedef {Object} ConnectionInfo
 * @property {SshConnectionConfig} config - 已规范化的连接配置。
 * @property {string} status - 当前连接状态。
 * @property {string|null} lastError - 最近一次失败的标准化错误信息。
 * @property {number} lastActivity - 最近一次成功远程操作的 Unix 时间戳（毫秒）。
 * @property {number|null} generation - 已认证会话的原生代次。
 */

/**
 * @typedef {Object} ConnectionSnapshot
 * @property {ConnectionInfo} record - 捕获的连接记录。
 * @property {number} generation - 捕获时的原生会话代次。
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
// 多个后台任务共享一次状态查询；原生层负责启动和停滞超时。
const TRANSFER_STATUS_POLL_INTERVAL_MS = 2000
// 限制单次状态 IPC 的等待，不取消或限制原生文件任务本身。
const TRANSFER_STATUS_QUERY_TIMEOUT_MS = 10000
// 仅限制未确认登记的启动请求，不限制已经登记的文件任务运行时间。
const TRANSFER_START_TIMEOUT_MS = 30000
const TRANSFER_STATUSES = new Set([ 'queued', 'starting', 'planning', 'running', 'committing', 'succeeded', 'partial', 'failed', 'cancelled' ])
// 原生契约保证这些启动拒绝均发生在任务登记之前。
const TRANSFER_START_REJECTION_CODES = new Set([
  'ConnectionGenerationChanged', 'TransferStartExpired', 'TransferCancelled', 'TransferRejected', 'ConnectionNotFound'
])
const REMOTE_NAME_COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

/**
 * 将任务快照或事件中的结构化错误转换为可供现有调用方使用的 Error。
 *
 * @param {Object} payload - 任务快照或完成事件。
 * @param {string} fallback - 没有错误消息时使用的默认提示。
 * @returns {Error} 保留错误码和作用域的异常。
 */
const createTaskError = (payload, fallback) => {
  const details = payload.error && typeof payload.error === 'object' ? payload.error : {}
  // 旧调用方仍用这条提示识别取消；原生端的单位错误码未必带有 message。
  const message = payload.status === 'cancelled' ? '传输已取消' : details.message || payload.message || fallback
  const error = new Error(message)
  error.code = details.code || payload.code || (payload.status === 'cancelled' ? 'TransferCancelled' : '')
  if (payload.result) error.result = payload.result
  if (details.scope || payload.scope) error.scope = details.scope || payload.scope
  return error
}

/**
 * 为调用方取消的目录请求创建可识别的标准中止异常。
 *
 * @returns {Error} 名称为 AbortError 的异常。
 */
const createDirectoryAbortError = () => {
  const error = new Error('目录读取已取消')
  error.name = 'AbortError'
  return error
}

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
    // connectionId -> Promise，合并标签卸载与快速重连期间的重复断开命令。
    this.pendingDisconnects = new Map()
    // UI 层断线订阅者集合；每个订阅者由 subscribeConnectionLost 返回的函数移除。
    this.connectionLostListeners = new Set()
    // 连接测试的 TCP 与 SSH 握手默认超时。
    this.defaultTimeout = CONNECTION_TIMEOUT_MS
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
    // transferId -> 当前窗口内已启动的传输或递归删除任务。
    this.activeTransfers = new Map()
    this.transferStatusTimer = null
    this.pollingTransferStatuses = false
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
   * @param {{id?: string, reason?: string, generation?: number}} [payload={}] - 被断开会话的代次和原因。
   * @returns {void}
   */
  handleConnectionLoss(payload = {}) {
    const connectionId = payload.id
    if (!connectionId || !Number.isSafeInteger(payload.generation) || payload.generation < 0) return
    const info = this.connections.get(connectionId)
    if (!info) return
    if (info.status === SftpConnectionStatus.CONNECTING && info.pendingDisconnectedGenerations) {
      // 新会话可能在 connect 回执之前断开；暂存代次，待回执核对，不能把旧事件当作新会话断线。
      info.pendingDisconnectedGenerations.add(payload.generation)
      return
    }
    this.markConnectionLost(connectionId, payload.reason || 'SSH 连接已断开', {
      record: info,
      generation: payload.generation
    })
  }

  /**
   * 标记连接失效，同时取消目录统计任务、清理缓存并通知订阅者。
   *
   * @param {string} connectionId - 需要标记为断开的连接 ID。
   * @param {unknown} reason - 原始错误或用户可读断线原因。
   * @param {{record: ConnectionInfo, generation: number}} [expected] - 仅允许标记捕获的会话。
   * @returns {boolean} 连接此前处于活动状态时返回 true，否则返回 false。
   */
  markConnectionLost(connectionId, reason, expected) {
    const info = this.connections.get(connectionId)
    if (!info) return false
    if (expected && (info !== expected.record || info.generation !== expected.generation)) return false
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
   * @returns {boolean} 结构化错误或固定旧消息明确表示主连接失效时返回 true。
   */
  isConnectionLossError(error) {
    let details = error
    if (typeof details === 'string') {
      try {
        details = JSON.parse(details)
      } catch {
        // 无结构的旧错误只匹配完整的固定消息，不能把路径中的词当作断线。
      }
    }
    if (details?.scope && details.scope !== 'main') return false
    const code = getErrorCode(details)
    if (code) {
      return /^(ConnectionNotFound|ConnectionFailed|ConnectionLost|ConnectionClosed|Disconnected)$/i.test(code)
    }
    return /^(?:连接不存在(?:或未连接)?|连接未建立|连接已断开|连接已关闭|SSH 连接已断开|broken pipe|connection (?:lost|reset|aborted|closed|not connected))$/i.test(getErrorDetails(details))
  }

  /**
   * 调用远程 Tauri 命令，并在必要时执行连接健康检查。
   *
   * Rust 端返回带有结构化错误码时，断线状态已经由原生层分类并通过事件同步；
   * 只有兼容旧协议或无法解析错误码的异常才需要额外执行保活探测。
   *
   * @param {string} connectionId - 命令关联的连接 ID。
   * @param {string} command - 要调用的 Tauri 命令名称。
   * @param {Record<string, unknown>} args - 传递给 Tauri 命令的参数。
   * @param {{suppressHealthCheck?: () => boolean, suppressConnectionLoss?: boolean|(() => boolean)}} [options={}] - 远程任务错误的连接状态处理策略。
   * @returns {Promise<unknown>} Rust 命令返回的原始结果。
   * @throws {unknown} 当远程命令失败时原样抛出；连接异常会先同步本地状态。
   */
  async invokeRemote(connectionId, command, args, options = {}) {
    const record = this.connections.get(connectionId)
    const generation = record?.generation
    const expected = { record, generation }
    const guardsGeneration = command === 'sftp_mkdir' || command === 'sftp_rename'
    if (guardsGeneration && !this.isCurrentConnection(connectionId, expected)) {
      const error = new Error('连接已更改，未发送远程操作')
      error.code = 'ConnectionGenerationChanged'
      throw error
    }
    try {
      const result = await invoke(command, guardsGeneration ? { ...args, expectedGeneration: generation } : args)
      if (guardsGeneration && !this.isCurrentConnection(connectionId, expected)) {
        // 操作可能已在旧会话完成，不能把迟到的成功回执当作新会话的操作结果。
        const error = new Error('连接已更改，远程操作可能已完成，请核对结果')
        error.code = 'ConnectionResultStale'
        throw error
      }
      return result
    } catch (error) {
      if (!this.isCurrentConnection(connectionId, expected)) throw error
      const suppressConnectionLoss = typeof options.suppressConnectionLoss === 'function'
        ? options.suppressConnectionLoss()
        : options.suppressConnectionLoss
      if (this.isConnectionLossError(error) && !suppressConnectionLoss) {
        this.markConnectionLost(connectionId, error, expected)
      } else if (!getErrorCode(error) && !options.suppressHealthCheck?.()) {
        // 旧版或非结构化错误无法由原生层分类时，再用保活探测区分断线和业务错误。
        try {
          const alive = await this.checkConnection(connectionId)
          if (!alive) this.markConnectionLost(connectionId, '服务器无响应或网络已断开', expected)
        } catch {
          this.markConnectionLost(connectionId, '服务器无响应或网络已断开', expected)
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
        errorDetails: getErrorDetails(error),
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

    // 关闭文件标签后立即重开时，必须等待旧会话的卸载清理完成，
    // 否则迟到的 disconnect_ssh 可能关闭刚建立的新会话。
    const pendingDisconnect = this.pendingDisconnects.get(id)
    if (pendingDisconnect) await pendingDisconnect.catch(() => undefined)

    const previous = this.connections.get(id)
    if (previous?.status === SftpConnectionStatus.CONNECTED) {
      const previousConfig = previous.config
      const sameConfiguration = previousConfig.host === normalized.host
        && previousConfig.port === normalized.port
        && previousConfig.username === normalized.username
        && previousConfig.authMethod === normalized.authMethod
        && previousConfig.hostKeyFingerprint === normalized.hostKeyFingerprint
        && previousConfig.password === normalized.password
      if (sameConfiguration) return id
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
      generation: null,
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
    info.generation = null
    const disconnectedGenerations = new Set()
    info.pendingDisconnectedGenerations = disconnectedGenerations
    info.lastError = null

    try {
      const result = await invoke('connect_ssh', { id: connectionId })
      if (this.connections.get(connectionId) !== info || info.pendingDisconnectedGenerations !== disconnectedGenerations
        || info.status !== SftpConnectionStatus.CONNECTING) {
        const error = new Error('连接已更改，请重新连接')
        error.code = 'ConnectionGenerationChanged'
        throw error
      }
      if (result.requiresHostKeyConfirmation) {
        info.status = SftpConnectionStatus.DISCONNECTED
        return result
      }
      if (!result.connected) {
        throw new Error('服务器拒绝连接')
      }
      if (!Number.isSafeInteger(result.generation) || result.generation < 0) {
        throw new Error('服务器连接代次无效，请重新连接')
      }
      if (disconnectedGenerations.has(result.generation)) {
        throw new Error('SSH 连接已断开，请重新连接')
      }
      info.generation = result.generation
      info.status = SftpConnectionStatus.CONNECTED
      info.lastActivity = Date.now()
      this.invalidateDirectorySizeCache(connectionId)
      return result
    } catch (error) {
      if (this.connections.get(connectionId) === info && info.pendingDisconnectedGenerations === disconnectedGenerations
        && info.status === SftpConnectionStatus.CONNECTING) {
        info.status = SftpConnectionStatus.ERROR
        info.lastError = normalizeError(error)
      }
      throw error
    } finally {
      if (info.pendingDisconnectedGenerations === disconnectedGenerations) delete info.pendingDisconnectedGenerations
    }
  }

  /**
   * 获取一次经 Rust 后端采集的 CPU、内存与进程快照。
   *
   * @param {string} connectionId - 已连接的配置 ID。
   * @returns {Promise<Object>} 统一结构的服务器资源快照。
   */
  async getServerMonitorSnapshot(connectionId) {
    const info = this.requireConnected(connectionId)
    const snapshot = await this.invokeRemote(
      connectionId,
      'get_server_monitor_snapshot',
      { id: connectionId },
      { suppressConnectionLoss: true, suppressHealthCheck: () => true }
    )
    info.lastActivity = Date.now()
    return snapshot
  }

  /**
   * 断开连接并清理相关终端、目录统计缓存和排队任务。
   *
   * @param {string} connectionId - 要断开的连接 ID。
   * @returns {Promise<boolean>} 无论连接是否存在，清理完成后均返回 true。
   * @throws {Error} 当 Rust 端主动断开会话失败时抛出；本地清理仍会执行。
   */
  async disconnect(connectionId) {
    const pendingDisconnect = this.pendingDisconnects.get(connectionId)
    if (pendingDisconnect) return pendingDisconnect

    const info = this.connections.get(connectionId)

    const operation = (async () => {
      try {
        await invoke('disconnect_ssh', { id: connectionId })
      } finally {
        if (info) {
          info.status = SftpConnectionStatus.DISCONNECTED
          info.lastError = null
        }
        this.cancelDirectorySizeRequests(connectionId, '连接已断开')
        this.invalidateDirectorySizeCache(connectionId)
        this.pumpDirectorySizeQueue()
      }
      return true
    })()
    this.pendingDisconnects.set(connectionId, operation)
    try {
      return await operation
    } finally {
      if (this.pendingDisconnects.get(connectionId) === operation) {
        this.pendingDisconnects.delete(connectionId)
      }
    }
  }

  /**
   * 从活动任务表移除已完成的任务，并在空闲时停止共享轮询。
   *
   * @param {Object} task - 当前窗口持有的后台任务。
   * @returns {void}
   */
  removeActiveTransfer(task) {
    if (this.activeTransfers.get(task.transferId) === task) this.activeTransfers.delete(task.transferId)
    if (task.startTimer != null) {
      window.clearTimeout(task.startTimer)
      task.startTimer = null
    }
    if (this.activeTransfers.size === 0 && this.transferStatusTimer !== null) {
      window.clearInterval(this.transferStatusTimer)
      this.transferStatusTimer = null
    }
  }

  /**
   * 对照启动代次应用原生任务快照；终态只处理一次。
   *
   * @param {Object} task - 本窗口的后台任务。
   * @param {Object} snapshot - 原生状态快照或转换后的完成事件。
   * @param {boolean} [reportProgress=true] - 是否将非终态进度转发给调用方。
   * @param {boolean} [fromEvent=false] - 是否为包含文件级详情的进度事件。
   * @returns {void}
   */
  applyTransferSnapshot(task, snapshot, reportProgress = true, fromEvent = false) {
    if (Number.isSafeInteger(snapshot.revision)) {
      if (snapshot.revision < (task.revision || 0)) return
      task.revision = snapshot.revision
    }
    if (task.settled || snapshot?.id !== task.connectionId || snapshot?.transferId !== task.transferId) return
    if (snapshot.generation !== task.generation || !TRANSFER_STATUSES.has(snapshot.status)) return
    const registered = !task.ready
    task.ready = true
    if (task.startTimer != null) {
      window.clearTimeout(task.startTimer)
      task.startTimer = null
    }
    task.missingStatusCount = 0

    if ([ 'succeeded', 'partial', 'failed', 'cancelled' ].includes(snapshot.status)) {
      task.settled = true
      this.removeActiveTransfer(task)
      if (snapshot.status === 'succeeded' || (task.batch && snapshot.result)) {
        task.resolve({ message: snapshot.message, result: snapshot.result && { ...snapshot.result, status: snapshot.status }})
      } else {
        const error = createTaskError(snapshot, snapshot.status === 'cancelled' ? '传输已取消' : task.failureMessage)
        // 独立传输会话出错不能使仍正常工作的主连接断开。
        if (error.scope === 'main' && this.isConnectionLossError(error)) {
          this.markConnectionLost(task.connectionId, error, task.connection)
        }
        task.resolve({ error })
      }
      return
    }

    // 事件或查询也能确认登记，不能只等待可能丢失的启动回执再补发取消。
    if (registered && task.cancelRequested) void this.cancelTransfer(task.transferId).catch(() => undefined)

    // 排队和启动快照的 null 总量不表示正在传输未知大小的文件。
    if (!fromEvent && (snapshot.status === 'queued' || snapshot.status === 'starting')) return

    if (reportProgress && task.onProgress && Number.isFinite(Number(snapshot.progress))) {
      const progressDetails = { ...task.lastProgress, ...snapshot }
      let progress = Number(snapshot.progress)
      if (!fromEvent && task.directoryTransfer) {
        // 目录快照的字节数是整体进度，不能覆盖上一个事件中的单文件进度。
        if (task.lastProgress) {
          const fileProgress = Number(task.lastProgress.progress)
          if (Number.isFinite(fileProgress)) progress = fileProgress
          progressDetails.progress = progress
          progressDetails.current = task.lastProgress.current
          progressDetails.total = task.lastProgress.total
        }
        // 空文件夹的整体百分比依靠事件中的文件计数，快照无法重新计算。
        progressDetails.overallProgress = snapshot.total === 0 && task.lastProgress?.overallProgress != null
          ? task.lastProgress.overallProgress
          : Number(snapshot.progress)
        progressDetails.completedBytes = snapshot.current
        progressDetails.totalBytes = snapshot.total
      }
      try {
        task.onProgress(progress, progressDetails)
      } catch (error) {
        console.error('处理任务进度失败:', error)
      }
    }
  }

  /**
   * 合并查询本窗口的活动任务，补偿丢失的进度或完成事件。
   *
   * @returns {Promise<void>} 本轮查询和快照处理结束后的 Promise。
   */
  async pollTransferStatuses() {
    if (this.pollingTransferStatuses || this.activeTransfers.size === 0) return
    const tasks = Array.from(this.activeTransfers.values()).filter(task => task.dispatched)
    if (tasks.length === 0) return
    this.pollingTransferStatuses = true
    const eventVersions = new Map(tasks.map(task => [ task, task.eventVersion ]))
    let queryTimeout
    try {
      const request = invoke('get_transfer_statuses', { transferIds: tasks.map(task => task.transferId) })
      const timeout = new Promise((resolve, reject) => {
        queryTimeout = window.setTimeout(() => reject(new Error('查询任务状态超时')), TRANSFER_STATUS_QUERY_TIMEOUT_MS)
      })
      const snapshots = await Promise.race([ request, timeout ])
      if (!Array.isArray(snapshots)) return
      const found = new Set()
      for (const snapshot of snapshots) {
        const task = this.activeTransfers.get(snapshot.transferId)
        if (!task || !eventVersions.has(task)) continue
        if (snapshot.id !== task.connectionId || snapshot.generation !== task.generation || !TRANSFER_STATUSES.has(snapshot.status)) continue
        found.add(task)
        // 查询期间收到的新事件比非终态查询结果更新，避免进度倒退。
        this.applyTransferSnapshot(task, snapshot, eventVersions.get(task) === task.eventVersion)
      }
      for (const task of tasks) {
        if (found.has(task) || task.settled || !task.ready || task.eventVersion !== eventVersions.get(task)) continue
        task.missingStatusCount += 1
        if (task.missingStatusCount < 3) continue
        // 已确认登记的任务可能在窗口休眠期间被有界终态缓存淘汰，不能永远空转。
        this.applyTransferSnapshot(task, {
          id: task.connectionId,
          transferId: task.transferId,
          generation: task.generation,
          status: 'failed',
          error: {
            code: 'TransferStateUnavailable',
            scope: 'transfer',
            message: '传输结果无法确认，请核对目标文件后再操作；不会自动重试'
          }
        })
      }
    } catch {
      // IPC 暂时失败时保留任务和事件监听，下次继续查询。
    } finally {
      window.clearTimeout(queryTimeout)
      this.pollingTransferStatuses = false
    }
  }

  /**
   * 注册当前窗口事件、启动原生任务，并以快照和共享轮询协调其终态。
   *
   * @param {Object} options - 命令、关联 ID、事件名称和进度回调。
   * @returns {Promise<string>} 成功完成时的原生消息。
   * @throws {Error} 当启动失败或原生任务进入失败、取消终态时抛出。
   */
  async runTransferTask(options) {
    const { connectionId, connection, transferId, command, args, progressEvent, completeEvent, onProgress, onTransferId } = options
    let resolveCompletion
    // 完成信号始终 resolve，避免任务在启动 IPC 返回前失败时产生未处理 rejection。
    const completion = new Promise(resolve => { resolveCompletion = resolve })
    const task = {
      connectionId,
      connection,
      transferId,
      onProgress,
      failureMessage: options.failureMessage,
      directoryTransfer: command === 'start_transfer',
      batch: options.batch === true,
      shouldStart: options.shouldStart,
      resolve: resolveCompletion,
      generation: connection.generation,
      dispatched: false,
      ready: false,
      settled: false,
      eventVersion: 0,
      lastProgress: null,
      missingStatusCount: 0,
      cancelRequested: false,
      startTimer: null
    }
    let unlistenProgress
    let unlistenComplete
    const acceptEvent = (payload, complete) => {
      const eventTransferId = payload.transferId || payload.operationId
      if (payload.id !== connectionId || eventTransferId !== transferId || task.settled) return
      if (payload.generation !== task.generation) return
      task.eventVersion += 1
      if (complete) {
        this.applyTransferSnapshot(task, {
          ...payload,
          transferId,
          status: TRANSFER_STATUSES.has(payload.status) ? payload.status : payload.cancelled ? 'cancelled' : payload.success ? 'succeeded' : 'failed'
        })
      } else {
        task.lastProgress = payload
        this.applyTransferSnapshot(task, { ...payload, transferId, status: 'running' }, true, true)
      }
    }

    this.activeTransfers.set(transferId, task)
    try {
      try {
        onTransferId?.(transferId)
      } catch (error) {
        console.error('处理任务标识失败:', error)
      }
      const currentWindow = getCurrentWebviewWindow()
      if (onProgress) {
        unlistenProgress = await currentWindow.listen(progressEvent, event => acceptEvent(event.payload || {}, false))
        if (task.settled) {
          const result = await completion
          if (result.error) throw result.error
          return task.batch ? result.result : result.message
        }
        if (task.cancelRequested) throw createTaskError({ status: 'cancelled' }, '传输已取消')
      }
      unlistenComplete = await currentWindow.listen(completeEvent, event => acceptEvent(event.payload || {}, true))
      if (task.settled) {
        const result = await completion
        if (result.error) throw result.error
        return task.batch ? result.result : result.message
      }
      if (task.cancelRequested && !task.dispatched) {
        throw createTaskError({ status: 'cancelled' }, '传输已取消')
      }
      if (!this.isCurrentConnection(connectionId, connection)) {
        const error = new Error('连接已更改，未启动文件任务')
        error.code = 'ConnectionGenerationChanged'
        throw error
      }
      if (task.shouldStart && !task.shouldStart()) throw createTaskError({ status: 'cancelled' }, '传输已取消')
      if (!this.isCurrentConnection(connectionId, connection)) {
        throw createTaskError({ code: 'ConnectionGenerationChanged', message: '连接已更改，未启动文件任务' }, '连接已更改')
      }
      const expiresAt = Date.now() + TRANSFER_START_TIMEOUT_MS
      task.startTimer = window.setTimeout(() => {
        if (task.settled || task.ready) return
        task.settled = true
        const error = new Error('传输结果无法确认，请核对目标文件后再操作；不会自动重试')
        error.code = 'TransferStateUnavailable'
        error.scope = 'transfer'
        task.resolve({ error })
        this.removeActiveTransfer(task)
        // 请求建立启动前取消墓碑；结果未知不能被迟到的取消回执改写。
        void invoke('cancel_transfer', { transferId }).catch(() => undefined)
      }, TRANSFER_START_TIMEOUT_MS)
      task.dispatched = true
      if (this.transferStatusTimer === null) {
        this.transferStatusTimer = window.setInterval(() => void this.pollTransferStatuses(), TRANSFER_STATUS_POLL_INTERVAL_MS)
      }
      // 启动回执、定向事件与状态查询互为补偿；启动 IPC 挂起不能阻止已确认终态结算。
      void invoke(command, { ...args, expectedGeneration: connection.generation, expiresAt }).then(snapshot => {
        if (task.settled) return
        if (!snapshot || snapshot.id !== connectionId || snapshot.transferId !== transferId) {
          throw new Error('原生任务返回了无效的启动状态')
        }
        this.applyTransferSnapshot(task, snapshot, task.eventVersion === 0)
      }).catch(error => {
        // 已有事件或查询证实原生登记时，以真实任务状态为准，不把迟到的回执错误当终态。
        if (task.settled || task.ready) return
        const code = getErrorCode(error)
        // 只有明确的登记前拒绝能立即结算；其他 IPC 错误不能证明未启动。
        if (!TRANSFER_START_REJECTION_CODES.has(code)) return
        task.settled = true
        task.resolve({ error: code === 'TransferCancelled' ? createTaskError({ status: 'cancelled' }, '传输已取消') : error })
        this.removeActiveTransfer(task)
      })

      const result = await completion
      if (result.error) throw result.error
      return task.batch || options.returnResult ? result.result : result.message
    } finally {
      this.removeActiveTransfer(task)
      // 解绑失败或 IPC 挂起不能吞掉已确认的传输结果，所有清理 Promise 都显式接住异常。
      for (const unlisten of [ unlistenProgress, unlistenComplete ]) {
        if (unlisten) void Promise.resolve().then(unlisten).catch(() => undefined)
      }
    }
  }

  /** 一次登记整个批次，由原生有界工作池调度，避免前端逐文件 IPC 串行等待。 */
  async transferBatch(connectionId, entries, options = {}) {
    const connection = options.connection || this.captureConnection(connectionId)
    if (!this.isCurrentConnection(connectionId, connection)) {
      const error = new Error('连接已更改，未启动文件任务')
      error.code = 'ConnectionGenerationChanged'
      throw error
    }
    const info = connection.record
    if (options.shouldStart && !options.shouldStart()) throw createTaskError({ status: 'cancelled' }, '传输已取消')
    if (!this.isCurrentConnection(connectionId, connection)) {
      throw createTaskError({ code: 'ConnectionGenerationChanged', message: '连接已更改，未启动文件任务' }, '连接已更改')
    }
    const direction = options.direction === 'upload' ? 'upload' : 'download'
    const transferId = randomId(direction)
    const isUpload = direction === 'upload'
    const result = await this.runTransferTask({
      connectionId,
      connection,
      transferId,
      command: 'start_transfer',
      batch: true,
      shouldStart: options.shouldStart,
      args: { id: connectionId, transferId, request: {
        version: 2,
        direction,
        entries,
        overwrite: options.overwrite === true,
        mode: 'auto',
        compression: 'auto'
      }},
      progressEvent: isUpload ? 'upload-progress' : 'download-progress',
      completeEvent: isUpload ? 'upload-complete' : 'download-complete',
      onProgress: options.onProgress,
      onTransferId: options.onTransferId,
      failureMessage: '传输失败'
    })
    info.lastActivity = Date.now()
    if (isUpload && this.isCurrentConnection(connectionId, connection)) this.invalidateDirectorySizeCache(connectionId)
    const items = []
    // 原生快照只携带汇总，按页读取结果明细，避免大目录事件复制百兆清单。
    while (items.length < (result?.itemCount || 0)) {
      const page = await invoke('get_transfer_results', { transferId, offset: items.length, limit: 256 })
      if (!page || !page.items.length) {
        const error = new Error('传输明细已过期，请核对目标文件；不会自动重传')
        error.code = 'TransferStateUnavailable'
        throw error
      }
      items.push(...page.items)
      if (!page.hasMore) break
    }
    return { ...result, items, transferId }
  }

  /**
   * 请求 Rust 端取消指定传输任务。
   *
   * @param {string} transferId - 创建传输任务时生成的唯一标识。
   * @returns {Promise<Object|null>} 原生任务的最新状态；任务不存在或不属于当前窗口时返回 null。
   * @throws {Error} 当 IPC 调用失败时抛出。
   */
  async cancelTransfer(transferId) {
    const pendingTask = this.activeTransfers.get(transferId)
    if (pendingTask) pendingTask.cancelRequested = true
    const snapshot = await invoke('cancel_transfer', { transferId })
    const task = this.activeTransfers.get(transferId)
    if (task && snapshot) {
      this.applyTransferSnapshot(task, snapshot)
    }
    return snapshot
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
  async getRemoteFileContent(connectionId, remotePath, previewId, onProgress, signal) {
    const connection = this.captureConnection(connectionId)
    previewId ||= randomId('preview')
    if (signal?.aborted) throw createDirectoryAbortError()
    let unlistenProgress
    let onAbort
    const aborted = signal && new Promise((resolve, reject) => {
      onAbort = () => {
        void invoke('cancel_sftp_preview', { previewId }).catch(() => undefined)
        reject(createDirectoryAbortError())
      }
      signal.addEventListener('abort', onAbort, { once: true })
    })
    // 事件监听注册也需要 await；在这个窗口内取消不能产生未处理的 rejection。
    aborted?.catch(() => undefined)
    try {
      if (onProgress && previewId) {
        unlistenProgress = await listen('preview-progress', event => {
          const payload = event.payload || {}
          if (payload.id !== connectionId || payload.previewId !== previewId || !this.isCurrentConnection(connectionId, connection)) return
          onProgress(payload.progress, payload)
        })
      }
      if (signal?.aborted) throw createDirectoryAbortError()
      const request = invoke('get_sftp_file_content', {
        id: connectionId,
        remotePath,
        previewId,
        expectedGeneration: connection.generation
      })
      const result = await (aborted ? Promise.race([ request, aborted ]) : request)
      if (!this.isCurrentConnection(connectionId, connection)) throw createDirectoryAbortError()
      return new Uint8Array(result)
    } finally {
      if (onAbort) signal.removeEventListener('abort', onAbort)
      unlistenProgress?.()
    }
  }

  /**
   * 列出远程目录，并按目录优先、名称自然排序。
   *
   * @param {string} connectionId - 已建立的 SSH 连接 ID。
   * @param {string} remotePath - 要读取的远程目录路径。
   * @param {{showHiddenFiles?: boolean, signal?: AbortSignal, requestId?: string}} [options={}] - 隐藏文件设置及可取消请求的标识。
   * @returns {Promise<RemoteEntry[]>} 已排序的远程目录条目。
   * @throws {Error} 当连接无效、目录不存在或无权限读取时抛出。
   */
  async listRemoteDirectory(connectionId, remotePath, options = {}) {
    const info = this.requireConnected(connectionId)
    const showHiddenFiles = options.showHiddenFiles === true
    const { signal } = options
    if (signal?.aborted) throw createDirectoryAbortError()
    const requestId = typeof options.requestId === 'string' && options.requestId
      ? options.requestId
      : signal ? randomId('directory') : undefined
    let onAbort
    const abortPromise = signal && new Promise((resolve, reject) => {
      onAbort = () => {
        void invoke('cancel_sftp_directory_request', { id: connectionId, requestId }).catch(() => undefined)
        reject(createDirectoryAbortError())
      }
      signal.addEventListener('abort', onAbort, { once: true })
    })
    try {
      const request = this.invokeRemote(connectionId, 'list_sftp_directory', {
        id: connectionId,
        remotePath,
        showHiddenFiles,
        ...(requestId ? { requestId } : {})
      }, {
        suppressConnectionLoss: () => signal?.aborted,
        suppressHealthCheck: () => signal?.aborted
      })
      const files = await (abortPromise ? Promise.race([ request, abortPromise ]) : request)
      info.lastActivity = Date.now()
      return files.sort((a, b) => {
        if (a.isDirectory && !b.isDirectory) return -1
        if (!a.isDirectory && b.isDirectory) return 1
        return REMOTE_NAME_COLLATOR.compare(a.name, b.name)
      })
    } finally {
      if (onAbort) signal.removeEventListener('abort', onAbort)
    }
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
   * @param {ConnectionSnapshot} [connection] - 删除操作发起时捕获的会话。
   * @returns {Promise<{operation: 'delete', outcome: 'deleted'|'alreadyAbsent', removedEntries: number, verifiedAbsent: true}>} 经原生端验证的删除结果。
   * @throws {Error} 当连接无效、删除失败或后端完成事件报告失败时抛出。
   */
  async deleteRemoteItem(connectionId, remotePath, isDirectory = false, onProgress, connection = this.captureConnection(connectionId)) {
    if (!this.isCurrentConnection(connectionId, connection)) {
      const error = new Error('连接已更改，未启动文件任务')
      error.code = 'ConnectionGenerationChanged'
      throw error
    }
    const info = connection.record
    const operationId = randomId('delete')
    const result = await this.runTransferTask({
      connectionId,
      connection,
      transferId: operationId,
      command: 'sftp_delete',
      args: { id: connectionId, remotePath, isDirectory, operationId },
      progressEvent: 'delete-progress',
      completeEvent: 'delete-complete',
      returnResult: true,
      onProgress,
      failureMessage: '删除失败'
    })
    if (result?.operation !== 'delete' || result.verifiedAbsent !== true
      || ![ 'deleted', 'alreadyAbsent' ].includes(result.outcome)) {
      const error = new Error('原生端未确认目标已不存在，请刷新核对删除结果')
      error.code = 'TransferOutcomeUnknown'
      error.result = result
      throw error
    }
    info.lastActivity = Date.now()
    if (this.isCurrentConnection(connectionId, connection)) this.invalidateDirectorySizeCache(connectionId)
    return result
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
    const connection = this.captureConnection(connectionId)
    try {
      const result = await invoke('check_ssh_connection', { id: connectionId })
      if (!this.isCurrentConnection(connectionId, connection)) return false
      connection.record.lastActivity = Date.now()
      const healthy = Boolean(result)
      if (!healthy) this.markConnectionLost(connectionId, '服务器无响应或网络已断开', connection)
      return healthy
    } catch (error) {
      this.markConnectionLost(
        connectionId,
        this.isConnectionLossError(error) ? error : '服务器无响应或网络已断开',
        connection
      )
      throw error
    }
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

  /** 捕获当前连接记录及原生代次，供跨 await 的操作保持同一会话。 */
  captureConnection(connectionId) {
    const record = this.requireConnected(connectionId)
    if (!Number.isSafeInteger(record.generation) || record.generation < 0) {
      throw new Error('服务器连接代次无效，请重新连接')
    }
    return { record, generation: record.generation }
  }

  /** 同一 ID 重连后，旧操作不得使用新记录或新代次。 */
  isCurrentConnection(connectionId, connection) {
    return Boolean(connection?.record)
      && Number.isSafeInteger(connection.generation)
      && connection.generation >= 0
      && this.connections.get(connectionId) === connection.record
      && connection.record.generation === connection.generation
      && connection.record.status === SftpConnectionStatus.CONNECTED
  }
}

export const sftpManager = new SftpManager()
export default sftpManager
