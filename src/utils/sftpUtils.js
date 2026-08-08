import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { CONNECTION_TIMEOUT_MS, SftpConnectionStatus, normalizeError } from './constants.js'

const randomId = (prefix) => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${ prefix }-${ crypto.randomUUID() }`
  }
  return `${ prefix }-${ Date.now() }-${ Math.random().toString(16).slice(2) }`
}

const DIRECTORY_SIZE_CACHE_TTL_MS = 45 * 1000
const MAX_DIRECTORY_SIZE_CACHE_ENTRIES = 500
const DIRECTORY_SIZE_CANCELLED_MESSAGE = '目录大小统计已取消'

const normalizeDirectorySizeOptions = (options) => {
  if (options && typeof options.addEventListener === 'function' && 'aborted' in options) {
    return { signal: options }
  }
  return options || {}
}

class SftpManager {
  constructor() {
    this.connections = new Map()
    this.connectionLostListeners = new Set()
    this.defaultTimeout = CONNECTION_TIMEOUT_MS
    this.retryAttempts = 3
    this.retryDelay = 1000
    this.connectionEventUnlisten = null
    // 目录统计使用独立 SSH 会话；限制为四个工作者，兼顾扫描速度和远端会话压力。
    this.directorySizeQueue = []
    this.directorySizeRequests = new Map()
    this.directorySizeCache = new Map()
    // 远端写入后推进代次，已启动的旧扫描结果不能回写到新视图的缓存。
    this.directorySizeCacheEpochs = new Map()
    this.activeDirectorySizeRequests = 0
    this.maxDirectorySizeRequests = 4
    void this.listenForConnectionLoss()
  }

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

  subscribeConnectionLost(listener) {
    this.connectionLostListeners.add(listener)
    return () => this.connectionLostListeners.delete(listener)
  }

  handleConnectionLoss(payload = {}) {
    const connectionId = payload.id
    if (!connectionId) return
    this.markConnectionLost(connectionId, payload.reason || 'SSH 连接已断开')
  }

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

  isConnectionLossError(error) {
    const message = normalizeError(error).toLowerCase()
    return /(socket|broken pipe|connection (?:lost|reset|aborted|closed|not connected)|network|timed out|timeout|连接(?:不存在|未建立|已断开|已关闭|丢失|超时)|套接字|网络)/i.test(message)
  }

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

  async updateHostKey(connectionId, fingerprint) {
    const info = this.requireConnection(connectionId)
    info.config.hostKeyFingerprint = fingerprint
    await invoke('set_ssh_host_key', {
      id: connectionId,
      fingerprint
    })
  }

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

  async openTerminal(connectionId, terminalId, columns, rows) {
    this.requireConnected(connectionId)
    return invoke('open_ssh_terminal', {
      id: connectionId,
      terminalId,
      columns,
      rows
    })
  }

  async writeTerminal(terminalId, data) {
    return invoke('write_ssh_terminal', {
      terminalId,
      data
    })
  }

  async resizeTerminal(terminalId, columns, rows) {
    return invoke('resize_ssh_terminal', {
      terminalId,
      columns,
      rows
    })
  }

  async closeTerminal(terminalId) {
    try {
      return await invoke('close_ssh_terminal', { terminalId })
    } catch {
      // 连接断开后 Rust 端可能已经清理会话，关闭操作可以安全忽略。
      return false
    }
  }

  async uploadFile(connectionId, localPath, remotePath, onProgress, overwrite = false, onTransferId) {
    return this.transfer('upload', connectionId, {
      localPath,
      remotePath,
      onProgress,
      overwrite,
      onTransferId
    })
  }

  async uploadDirectory(connectionId, localPath, remotePath, onProgress, overwrite = false, onTransferId) {
    return this.transfer('upload-directory', connectionId, {
      localPath,
      remotePath,
      onProgress,
      overwrite,
      onTransferId
    })
  }

  async downloadFile(connectionId, remotePath, localPath, onProgress, overwrite = false, onTransferId) {
    return this.transfer('download', connectionId, {
      remotePath,
      localPath,
      onProgress,
      overwrite,
      onTransferId
    })
  }

  async downloadDirectory(connectionId, remotePath, localPath, onProgress, overwrite = false, onTransferId) {
    return this.transfer('download-directory', connectionId, {
      remotePath,
      localPath,
      onProgress,
      overwrite,
      onTransferId
    })
  }

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

  async cancelTransfer(transferId) {
    return invoke('cancel_transfer', { transferId })
  }

  async removeConnection(connectionId) {
    await this.disconnect(connectionId).catch(() => undefined)
    await invoke('remove_ssh_connection', { id: connectionId })
    this.connections.delete(connectionId)
    return true
  }

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

  async listRemoteDirectory(connectionId, remotePath) {
    const info = this.requireConnected(connectionId)
    const files = await this.invokeRemote(connectionId, 'list_sftp_directory', { id: connectionId, remotePath })
    info.lastActivity = Date.now()
    return files.sort((a, b) => {
      if (a.isDirectory && !b.isDirectory) return -1
      if (!a.isDirectory && b.isDirectory) return 1
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
    })
  }

  getDirectorySizeCacheEpoch(connectionId) {
    return this.directorySizeCacheEpochs.get(connectionId) || 0
  }

  getDirectorySizeCacheKey(connectionId, remotePath, cacheVersion, cacheEpoch) {
    const normalizedPath = String(remotePath || '/').replaceAll('\\', '/').replace(/\/+$/, '') || '/'
    return `${ connectionId }\u0000${ normalizedPath }\u0000${ cacheVersion == null ? '' : String(cacheVersion) }\u0000${ cacheEpoch }`
  }

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

  getCachedDirectorySize(cacheKey) {
    const cached = this.directorySizeCache.get(cacheKey)
    if (!cached) return null
    if (cached.expiresAt <= Date.now()) {
      this.directorySizeCache.delete(cacheKey)
      return null
    }
    return cached.result
  }

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

  createDirectorySizeTask(connectionId, remotePath, cacheKey, cacheEpoch) {
    return {
      cacheKey,
      connectionId,
      remotePath,
      cacheEpoch,
      operationId: randomId('directory-size'),
      subscribers: new Set(),
      started: false,
      cancelled: false,
      settled: false
    }
  }

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

  cancelDirectorySizeRequests(connectionId, reason = '连接已断开') {
    const error = new Error(reason)
    Array.from(this.directorySizeRequests.values()).forEach(task => {
      if (task.connectionId !== connectionId) return
      this.cancelDirectorySizeTask(task)
      this.settleDirectorySizeTask(task, error)
    })
  }

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

  async getRemoteDirectorySize(connectionId, remotePath, options) {
    this.requireConnected(connectionId)
    const { signal, cacheVersion } = normalizeDirectorySizeOptions(options)
    if (signal?.aborted) throw new Error(DIRECTORY_SIZE_CANCELLED_MESSAGE)
    const cacheEpoch = this.getDirectorySizeCacheEpoch(connectionId)
    const cacheKey = this.getDirectorySizeCacheKey(connectionId, remotePath, cacheVersion, cacheEpoch)
    const cached = this.getCachedDirectorySize(cacheKey)
    if (cached) return cached

    let task = this.directorySizeRequests.get(cacheKey)
    if (!task) {
      task = this.createDirectorySizeTask(connectionId, remotePath, cacheKey, cacheEpoch)
      this.directorySizeRequests.set(cacheKey, task)
      this.directorySizeQueue.push(task)
    }
    const result = this.subscribeDirectorySizeTask(task, signal)
    this.pumpDirectorySizeQueue()
    return result
  }

  async createRemoteDirectory(connectionId, remotePath) {
    this.requireConnected(connectionId)
    await this.invokeRemote(connectionId, 'sftp_mkdir', { id: connectionId, remotePath })
    this.invalidateDirectorySizeCache(connectionId)
    return true
  }

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

  async renameRemoteItem(connectionId, sourcePath, targetPath, overwrite = false) {
    this.requireConnected(connectionId)
    await this.invokeRemote(connectionId, 'sftp_rename', { id: connectionId, sourcePath, targetPath, overwrite })
    this.invalidateDirectorySizeCache(connectionId)
    return true
  }

  async getRemoteUserHome(connectionId) {
    const info = this.requireConnected(connectionId)
    const home = await this.invokeRemote(connectionId, 'get_sftp_user_home', { id: connectionId })
    info.lastActivity = Date.now()
    return home
  }

  async getRemoteSystemInfo(connectionId) {
    this.requireConnected(connectionId)
    return { os: 'unknown', version: '' }
  }

  async getRemoteDrives(connectionId) {
    const info = this.requireConnected(connectionId)
    const home = await this.invokeRemote(connectionId, 'get_sftp_user_home', { id: connectionId })
    info.lastActivity = Date.now()
    const match = /^([A-Za-z]):(?:[/\\]|$)/.exec(home || '')
    return match ? [`${ match[1] }:/`] : []
  }

  getConnectionStatus(connectionId) {
    return this.connections.get(connectionId)?.status || SftpConnectionStatus.DISCONNECTED
  }

  getConnectionInfo(connectionId) {
    return this.connections.get(connectionId) || null
  }

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

  async closeAllConnections() {
    await Promise.all(Array.from(this.connections.keys()).map(connectionId => this.disconnect(connectionId).catch(() => undefined)))
    this.connections.clear()
  }

  getConnections() {
    return Object.fromEntries(this.connections)
  }

  generateConnectionId(config) {
    return config.id || randomId('connection')
  }

  parseError(error) {
    return normalizeError(error)
  }

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

  requireConnection(connectionId) {
    const info = this.connections.get(connectionId)
    if (!info) throw new Error('连接不存在')
    return info
  }

  requireConnected(connectionId) {
    const info = this.requireConnection(connectionId)
    if (info.status !== SftpConnectionStatus.CONNECTED) throw new Error('连接未建立')
    return info
  }
}

export const sftpManager = new SftpManager()
export default sftpManager
