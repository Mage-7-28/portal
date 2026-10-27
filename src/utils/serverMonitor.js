import { normalizeError } from './common.js'
import sftpManager from './sftpUtils.js'

/**
 * 以连接配置 ID 为键管理当前 WebView 内的监控轮询，避免同一工作区重复采集。
 */
class ServerMonitorManager {
  constructor() {
    this.entries = new Map()
  }

  /**
   * 订阅指定服务器的周期监控快照。
   *
   * @param {string} connectionId - 已连接的配置 ID。
   * @param {(state: Object) => void} listener - 接收监控状态的回调。
   * @param {number} [intervalMs=5000] - 期望刷新间隔，后端全局最短间隔为 3 秒。
   * @returns {() => void} 取消本次订阅的函数。
   */
  subscribe(connectionId, listener, intervalMs = 5000) {
    if (!connectionId || typeof listener !== 'function') return () => undefined

    let entry = this.entries.get(connectionId)
    if (!entry) {
      entry = {
        listeners: new Set(),
        snapshot: null,
        error: '',
        loading: true,
        timer: null,
        request: null,
        intervalMs: Math.max(intervalMs, 3000)
      }
      this.entries.set(connectionId, entry)
      this.refresh(connectionId, entry)
    } else {
      entry.intervalMs = Math.min(entry.intervalMs, Math.max(intervalMs, 3000))
    }

    entry.listeners.add(listener)
    listener(this.getState(entry))
    this.ensureTimer(connectionId, entry)

    return () => {
      entry.listeners.delete(listener)
      if (entry.listeners.size > 0) return
      if (entry.timer) window.clearTimeout(entry.timer)
      this.entries.delete(connectionId)
    }
  }

  getState(entry) {
    return {
      snapshot: entry.snapshot,
      error: entry.error,
      loading: entry.loading,
      refreshing: Boolean(entry.request)
    }
  }

  publish(entry) {
    const state = this.getState(entry)
    entry.listeners.forEach(listener => listener(state))
  }

  ensureTimer(connectionId, entry) {
    if (entry.timer || entry.listeners.size === 0) return
    entry.timer = window.setTimeout(() => {
      entry.timer = null
      this.refresh(connectionId, entry)
    }, entry.intervalMs)
  }

  refresh(connectionId, entry) {
    if (entry.request) return entry.request
    entry.loading = !entry.snapshot
    entry.error = ''
    // requireConnected 可能在连接刚断开时同步抛错，先转入 Promise 链统一处理。
    const request = Promise.resolve()
      .then(() => sftpManager.getServerMonitorSnapshot(connectionId))
      .then(snapshot => {
        entry.snapshot = snapshot
        entry.error = ''
      })
      .catch(error => {
        entry.error = normalizeError(error)
      })
      .finally(() => {
        entry.loading = false
        entry.request = null
        this.publish(entry)
        this.ensureTimer(connectionId, entry)
      })
    entry.request = request
    this.publish(entry)
    return request
  }
}

export const serverMonitorManager = new ServerMonitorManager()
