/**
 * 独立终端 WebView 的创建、追踪和批量关闭工具。
 *
 * 窗口标签、连接展示信息和关闭清理逻辑由本模块统一维护。
 */
import { WebviewWindow } from '@tauri-apps/api/webviewWindow'

export const TERMINAL_WINDOW_PREFIX = 'PortalTerminal-'
const LEGACY_TERMINAL_WINDOW_LABEL = 'PortalTerminal'
const pendingWindowPromises = new Set()

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
 * 判断窗口标签是否属于当前或兼容旧版本的终端窗口。
 *
 * @param {string} label - Tauri WebView 窗口标签。
 * @returns {boolean} 标签可由终端窗口清理流程管理时返回 true。
 */
const isTerminalWindowLabel = label => label === LEGACY_TERMINAL_WINDOW_LABEL
  || label.startsWith(TERMINAL_WINDOW_PREFIX)

/**
 * 获取当前应用中的全部独立终端窗口。
 *
 * @returns {Promise<Object[]>} 终端 WebviewWindow 实例数组。
 * @throws {Error} 当 Tauri 窗口列表查询失败时抛出。
 */
const getTerminalWindows = async () => {
  const windows = await WebviewWindow.getAll()
  return windows.filter(window => isTerminalWindowLabel(window.label))
}

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
 * 主窗口断开或退出时调用，确保所有终端窗口和远程 PTY 一起释放。
 *
 * @returns {Promise<boolean>} 至少销毁一个终端窗口时返回 true。
 */
export const closeTerminalWindows = async () => {
  // 等待正在创建的窗口登记完成，避免断开连接时漏掉刚发起的窗口。
  await Promise.allSettled([...pendingWindowPromises])
  const terminalWindows = await getTerminalWindows()
  await Promise.allSettled(terminalWindows.map(window => window.destroy()))
  return terminalWindows.length > 0
}
