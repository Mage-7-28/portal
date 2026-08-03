import { WebviewWindow } from '@tauri-apps/api/webviewWindow'

export const TERMINAL_WINDOW_PREFIX = 'PortalTerminal-'
const LEGACY_TERMINAL_WINDOW_LABEL = 'PortalTerminal'
const pendingWindowPromises = new Set()

const createWindowLabel = () => {
  const suffix = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${ Date.now() }-${ Math.random().toString(16).slice(2) }`
  return `${ TERMINAL_WINDOW_PREFIX }${ suffix }`
}

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

const buildTerminalUrl = (connection) => {
  const params = new window.URLSearchParams({
    window: 'terminal',
    connectionId: String(connection?.id || '')
  })
  // 只传递显示所需的非敏感连接信息，密码和私钥口令永远不进入 URL。
  if (connection?.host) params.set('host', String(connection.host))
  if (connection?.username) params.set('username', String(connection.username))
  if (connection?.port) params.set('port', String(connection.port))
  return `index.html?${ params.toString() }`
}

const isTerminalWindowLabel = label => label === LEGACY_TERMINAL_WINDOW_LABEL
  || label.startsWith(TERMINAL_WINDOW_PREFIX)

const getTerminalWindows = async () => {
  const windows = await WebviewWindow.getAll()
  return windows.filter(window => isTerminalWindowLabel(window.label))
}

/** 打开一个新的终端窗口，每个窗口拥有独立的 WebView 和 SSH PTY。 */
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

/** 主窗口断开或退出时调用，确保所有终端窗口和远程 PTY 一起释放。 */
export const closeTerminalWindows = async () => {
  // 等待正在创建的窗口登记完成，避免断开连接时漏掉刚发起的窗口。
  await Promise.allSettled([...pendingWindowPromises])
  const terminalWindows = await getTerminalWindows()
  await Promise.allSettled(terminalWindows.map(window => window.destroy()))
  return terminalWindows.length > 0
}
