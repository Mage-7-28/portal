import { WebviewWindow } from '@tauri-apps/api/webviewWindow'

export const TERMINAL_WINDOW_LABEL = 'PortalTerminal'

let openingWindowPromise = null

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

/** 打开或聚焦唯一的终端窗口，避免重复创建多个 PTY。 */
export const openTerminalWindow = async (connection) => {
  if (!connection?.id) throw new Error('当前连接不可用')
  if (openingWindowPromise) return openingWindowPromise

  openingWindowPromise = (async () => {
    const existing = await WebviewWindow.getByLabel(TERMINAL_WINDOW_LABEL)
    if (existing) {
      await existing.unminimize().catch(() => undefined)
      await existing.show()
      await existing.setFocus()
      return existing
    }

    const terminalWindow = new WebviewWindow(TERMINAL_WINDOW_LABEL, {
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
    return waitForWindowCreation(terminalWindow)
  })()

  try {
    return await openingWindowPromise
  } finally {
    openingWindowPromise = null
  }
}

/** 主窗口断开或退出时调用，确保子窗口和远程 PTY 一起释放。 */
export const closeTerminalWindow = async () => {
  if (openingWindowPromise) await openingWindowPromise.catch(() => undefined)
  const terminalWindow = await WebviewWindow.getByLabel(TERMINAL_WINDOW_LABEL)
  if (!terminalWindow) return false
  await terminalWindow.destroy()
  return true
}
