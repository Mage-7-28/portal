/**
 * 服务器工作窗口的创建、复用和关闭工具。
 *
 * 窗口标签、连接展示信息和关闭清理逻辑由本模块统一维护。
 */
import { WebviewWindow } from '@tauri-apps/api/webviewWindow'
import { getServerWorkspaceWindowLabel, SERVER_WORKSPACE_WINDOW_PREFIX } from './serverWorkspace.js'

export const TERMINAL_WINDOW_PREFIX = 'PortalTerminal-'
const LEGACY_TERMINAL_WINDOW_LABEL = 'PortalTerminal'
const pendingWindowPromises = new Set()
const pendingWorkspaceWindows = new Map()

/**
 * 将已有工作窗口恢复显示并聚焦。
 *
 * @param {Object} targetWindow - 已创建的 Tauri WebView 窗口。
 * @param {Object} connection - 最新连接展示配置。
 * @returns {Promise<Object>} 已聚焦的工作窗口。
 */
const focusServerWorkspaceWindow = async (targetWindow, connection) => {
  const title = `${ connection?.name || connection?.host || '服务器' } · Portal`
  await Promise.allSettled([
    targetWindow.setTitle(title),
    targetWindow.unminimize(),
    targetWindow.show()
  ])
  await targetWindow.setFocus().catch(() => undefined)
  return targetWindow
}

/**
 * 请求子窗口执行自己的连接清理，并等待原生窗口销毁事件。
 *
 * @param {Object} targetWindow - 要关闭的服务器或终端窗口。
 * @returns {Promise<void>} 窗口完成关闭后的 Promise。
 */
const closeOwnedWindowGracefully = async (targetWindow) => {
  let resolveDestroyed
  let unlistenDestroyed
  let timeoutId
  let destroyed

  try {
    destroyed = new Promise(resolve => {
      resolveDestroyed = resolve
    })
    unlistenDestroyed = await targetWindow.once('tauri://destroyed', () => resolveDestroyed(true))
  } catch {
    destroyed = undefined
  }

  try {
    const timeout = new Promise(resolve => {
      timeoutId = window.setTimeout(() => resolve(false), 12_000)
    })
    await targetWindow.close().catch(() => undefined)
    if (destroyed) await Promise.race([ destroyed, timeout ])
  } finally {
    if (timeoutId !== undefined) window.clearTimeout(timeoutId)
    unlistenDestroyed?.()
  }
}

/**
 * 生成独立终端 WebView 的唯一标签。
 *
 * @returns {string} 以 `PortalTerminal-` 为前缀的窗口标签。
 */
const createWindowLabel = () => {
  const suffix = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${ Date.now() }-${ Math.random().toString(16).slice(2) }`
  return `${ TERMINAL_WINDOW_PREFIX }${ suffix }`
}

/**
 * 等待 Tauri WebView 创建成功或失败事件。
 *
 * @param {Object} webviewWindow - 刚创建、尚未就绪的 Tauri WebviewWindow。
 * @returns {Promise<Object>} 创建成功时解析为同一个 WebviewWindow 实例的 Promise。
 * @throws {Error} 当 Tauri 发出窗口创建错误事件时拒绝。
 */
const waitForWindowCreation = (webviewWindow) => new Promise((resolve, reject) => {
  let settled = false
  const finish = (callback, value) => {
    if (settled) return
    settled = true
    callback(value)
  }

  void webviewWindow.once('tauri://created', () => finish(resolve, webviewWindow))
  void webviewWindow.once('tauri://error', event => {
    const message = event?.payload?.message || event?.payload || '终端窗口创建失败'
    finish(reject, new Error(String(message)))
  })
})

/**
 * 构造独立终端页面 URL，只携带显示和连接定位需要的非敏感信息。
 *
 * @param {{id?: string, host?: string, username?: string, port?: string|number}} connection - 当前连接的非敏感配置。
 * @returns {string} 包含终端窗口查询参数的本地页面 URL。
 */
const buildTerminalUrl = (connection) => {
  const params = new window.URLSearchParams({
    window: 'terminal',
    connectionId: String(connection?.id || '')
  })
  // 只传递显示所需的非敏感连接信息，密码永远不进入 URL。
  if (connection?.host) params.set('host', String(connection.host))
  if (connection?.username) params.set('username', String(connection.username))
  if (connection?.port) params.set('port', String(connection.port))
  return `index.html?${ params.toString() }`
}

/**
 * 构造服务器工作窗口 URL，仅携带连接标识和非敏感展示信息。
 *
 * @param {Object} connection - 连接配置展示字段。
 * @returns {string} 工作窗口页面 URL。
 */
const buildServerWorkspaceUrl = connection => {
  const params = new window.URLSearchParams({
    window: 'workspace',
    connectionId: String(connection.id)
  })
  for (const key of [ 'name', 'host', 'username', 'port' ]) {
    if (connection[key] !== undefined && connection[key] !== null) {
      params.set(key, String(connection[key]))
    }
  }
  return `index.html?${ params.toString() }`
}

/**
 * 判断窗口标签是否属于当前或兼容旧版本的终端窗口。
 *
 * @param {string} label - Tauri WebView 窗口标签。
 * @returns {boolean} 标签可由终端窗口清理流程管理时返回 true。
 */
const isTerminalWindowLabel = label => label === LEGACY_TERMINAL_WINDOW_LABEL
  || label.startsWith(TERMINAL_WINDOW_PREFIX)

/**
 * 打开一个新的终端窗口，每个窗口拥有独立的 WebView 和 SSH PTY。
 *
 * @param {{id: string, host?: string, username?: string, port?: string|number}} connection - 用于定位远程会话的连接信息。
 * @returns {Promise<Object>} 创建成功后的 Tauri WebviewWindow 实例。
 * @throws {Error} 当连接无效或窗口创建失败时抛出。
 */
export const openTerminalWindow = async (connection) => {
  if (!connection?.id) throw new Error('当前连接不可用')
  const label = createWindowLabel()
  const terminalWindow = new WebviewWindow(label, {
    url: buildTerminalUrl(connection),
    title: 'Portal 远程终端',
    width: 1024,
    height: 680,
    minWidth: 680,
    minHeight: 420,
    resizable: true,
    center: true,
    focus: true,
    visible: true,
    decorations: true
  })
  const creationPromise = waitForWindowCreation(terminalWindow)
  pendingWindowPromises.add(creationPromise)
  try {
    return await creationPromise
  } finally {
    pendingWindowPromises.delete(creationPromise)
  }
}

/**
 * 打开或聚焦连接配置对应的唯一服务器工作窗口。
 *
 * @param {Object} connection - 要在独立窗口中打开的连接配置。
 * @returns {Promise<Object>} 已创建并聚焦的 Tauri 工作窗口。
 * @throws {Error} 当连接无效或窗口创建失败时抛出。
 */
export const openServerWorkspaceWindow = async (connection) => {
  if (!connection?.id) throw new Error('当前连接不可用')
  const label = getServerWorkspaceWindowLabel(connection.id)
  const pending = pendingWorkspaceWindows.get(connection.id)
  if (pending) return focusServerWorkspaceWindow(await pending, connection)

  const creationPromise = (async () => {
    const existingWindow = await WebviewWindow.getByLabel(label)
    if (existingWindow) return existingWindow
    const workspaceWindow = new WebviewWindow(label, {
      url: buildServerWorkspaceUrl(connection),
      title: `${ connection.name || connection.host || '服务器' } · Portal`,
      width: 1440,
      height: 900,
      minWidth: 1100,
      minHeight: 720,
      resizable: true,
      center: true,
      focus: true,
      visible: true,
      decorations: true
    })
    return waitForWindowCreation(workspaceWindow)
  })()
  pendingWorkspaceWindows.set(connection.id, creationPromise)
  try {
    return focusServerWorkspaceWindow(await creationPromise, connection)
  } finally {
    if (pendingWorkspaceWindows.get(connection.id) === creationPromise) {
      pendingWorkspaceWindows.delete(connection.id)
    }
  }
}

/**
 * 更新已打开工作窗口的标题，不改变其焦点和连接状态。
 *
 * @param {Object} connection - 最新连接配置。
 * @returns {Promise<boolean>} 找到并更新窗口时返回 true。
 */
export const updateServerWorkspaceWindow = async connection => {
  if (!connection?.id) return false
  const label = getServerWorkspaceWindowLabel(connection.id)
  const workspaceWindow = await WebviewWindow.getByLabel(label)
  if (!workspaceWindow) return false
  await workspaceWindow.setTitle(`${ connection.name || connection.host || '服务器' } · Portal`)
  return true
}

/**
 * 按连接配置 ID 关闭对应服务器工作窗口。
 *
 * @param {string} connectionId - 已删除配置的稳定 ID。
 * @returns {Promise<boolean>} 找到并销毁窗口时返回 true。
 */
export const closeServerWorkspaceWindow = async (connectionId) => {
  if (!connectionId) return false
  const pending = pendingWorkspaceWindows.get(connectionId)
  if (pending) await Promise.allSettled([pending])
  const label = getServerWorkspaceWindowLabel(connectionId)
  const workspaceWindow = await WebviewWindow.getByLabel(label)
  if (!workspaceWindow) return false
  await closeOwnedWindowGracefully(workspaceWindow)
  return true
}

/**
 * 关闭全部服务器工作窗口和兼容旧版本的独立终端窗口。
 *
 * @returns {Promise<boolean>} 至少销毁一个子窗口时返回 true。
 */
export const closeServerWorkspaceWindows = async () => {
  await Promise.allSettled([
    ...pendingWindowPromises,
    ...pendingWorkspaceWindows.values()
  ])
  const windows = await WebviewWindow.getAll()
  const ownedWindows = windows.filter(window => isTerminalWindowLabel(window.label)
    || window.label.startsWith(SERVER_WORKSPACE_WINDOW_PREFIX))
  await Promise.allSettled(ownedWindows.map(closeOwnedWindowGracefully))
  return ownedWindows.length > 0
}
