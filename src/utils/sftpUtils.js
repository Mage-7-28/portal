import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { CONNECTION_TIMEOUT_MS, SftpConnectionStatus, normalizeError } from './constants.js'

const randomId = (prefix) => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${ prefix }-${ crypto.randomUUID() }`
  }
  return `${ prefix }-${ Date.now() }-${ Math.random().toString(16).slice(2) }`
}

class SftpManager {
  constructor() {
    this.connections = new Map()
    this.connectionLostListeners = new Set()
    this.defaultTimeout = CONNECTION_TIMEOUT_MS
    this.retryAttempts = 3
    this.retryDelay = 1000
    this.connectionEventUnlisten = null
    void this.listenForConnectionLoss()
  }

  async listenForConnectionLoss() {
    try {
      this.connectionEventUnlisten = await listen('ssh-disconnected', event => {
        this.handleConnectionLoss(event.payload || {})
      })
    } catch {
      // The manager is also used by browser-side tooling where Tauri events
      // are unavailable. Remote command errors still use the local fallback.
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
    if (!wasActive) return false
    const event = { id: connectionId, reason: connectionMessage }
    this.connectionLostListeners.forEach(listener => listener(event))
    return true
  }

  isConnectionLossError(error) {
    const message = normalizeError(error).toLowerCase()
    return /(socket|broken pipe|connection (?:lost|reset|aborted|closed|not connected)|network|timed out|timeout|连接(?:不存在|未建立|已断开|已关闭|丢失|超时)|套接字|网络)/i.test(message)
  }

  async invokeRemote(connectionId, command, args) {
    try {
      return await invoke(command, args)
    } catch (error) {
      if (this.isConnectionLossError(error)) this.markConnectionLost(connectionId, error)
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
        authMethod: config.authMethod || 'password',
        privateKeyPath: config.privateKeyPath || null,
        passphrase: config.passphrase || null,
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
      authMethod: config.authMethod || 'password',
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
      authMethod: normalized.authMethod,
      privateKeyPath: normalized.privateKeyPath || null,
      passphrase: normalized.passphrase || null,
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
    }
    return true
  }

  async uploadFile(connectionId, localPath, remotePath, onProgress, onTransferId) {
    return this.transfer('upload', connectionId, {
      localPath,
      remotePath,
      onProgress,
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

  async transfer(direction, connectionId, options) {
    const info = this.requireConnected(connectionId)
    const transferId = randomId(direction)
    const progressEvent = `${ direction }-progress`
    const completeEvent = `${ direction }-complete`
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
      // Register listeners before invoking the worker to avoid losing a fast completion event.
      if (options.onProgress) unlistenProgress = await listen(progressEvent, progressHandler)
      unlistenComplete = await listen(completeEvent, completeHandler)
      const command = direction === 'upload' ? 'scp_upload' : 'scp_download'
      await this.invokeRemote(connectionId, command, direction === 'upload'
        ? {
          id: connectionId,
          localPath: options.localPath,
          remotePath: options.remotePath,
          transferId
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

  async createRemoteDirectory(connectionId, remotePath) {
    this.requireConnected(connectionId)
    await this.invokeRemote(connectionId, 'sftp_mkdir', { id: connectionId, remotePath })
    return true
  }

  async deleteRemoteItem(connectionId, remotePath, isDirectory = false) {
    this.requireConnected(connectionId)
    await this.invokeRemote(connectionId, 'sftp_delete', { id: connectionId, remotePath, isDirectory })
    return true
  }

  async renameRemoteItem(connectionId, sourcePath, targetPath, overwrite = false) {
    this.requireConnected(connectionId)
    await this.invokeRemote(connectionId, 'sftp_rename', { id: connectionId, sourcePath, targetPath, overwrite })
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
      return Boolean(result)
    } catch (error) {
      if (this.isConnectionLossError(error)) this.markConnectionLost(connectionId, error)
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
