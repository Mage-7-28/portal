import { useCallback, useEffect, useRef } from 'react'
import { ConfigProvider } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { AntdThemeConfig } from '../theme/antdTheme.js'
import { TerminalView } from './TerminalModal.jsx'

const TERMINAL_CLOSE_TIMEOUT_MS = 1200

/**
 * 独立终端窗口的宿主。关闭窗口前先释放远程 PTY，避免 SSH 会话残留。
 */
const TerminalWindow = ({ connectionId, connection }) => {
  const windowRef = useRef(null)
  const terminalCloseRef = useRef(() => Promise.resolve())
  const closingRef = useRef(false)

  if (!windowRef.current) {
    windowRef.current = getCurrentWebviewWindow()
  }

  const registerTerminalClose = useCallback(closeTerminal => {
    terminalCloseRef.current = typeof closeTerminal === 'function'
      ? closeTerminal
      : () => Promise.resolve()
  }, [])

  const closeWindow = useCallback(async () => {
    if (closingRef.current) return
    closingRef.current = true
    let timeoutId
    try {
      // 远端 socket 异常时关闭命令可能等待锁；窗口不能因此一直卡住。
      await Promise.race([
        Promise.resolve()
          .then(() => terminalCloseRef.current())
          .catch(() => undefined),
        new Promise(resolve => {
          timeoutId = window.setTimeout(resolve, TERMINAL_CLOSE_TIMEOUT_MS)
        })
      ])
    } finally {
      if (timeoutId) window.clearTimeout(timeoutId)
      // destroy 不会再次触发 onCloseRequested，避免 close -> close 的事件递归。
      await windowRef.current?.destroy().catch(() => undefined)
    }
  }, [])

  useEffect(() => {
    let disposed = false
    let unlistenCloseRequested
    let unlistenConnectionLost

    const registerWindowEvents = async () => {
      const currentWindow = windowRef.current
      if (!currentWindow) return
      try {
        const closeListener = await currentWindow.onCloseRequested(async event => {
          if (closingRef.current) return
          event.preventDefault()
          await closeWindow()
        })
        if (disposed) {
          closeListener()
        } else {
          unlistenCloseRequested = closeListener
        }

        const disconnectListener = await listen('ssh-disconnected', event => {
          const payload = event.payload || {}
          if (payload.id !== connectionId || disposed) return
          // 主窗口或后端发现连接失效时，子窗口没有可用的终端会话，直接关闭并释放资源。
          void closeWindow()
        })
        if (disposed) {
          disconnectListener()
        } else {
          unlistenConnectionLost = disconnectListener
        }
      } catch {
        // 窗口正在退出时事件注册可能失败，不影响 PTY 的组件清理流程。
      }
    }

    void registerWindowEvents()
    return () => {
      disposed = true
      unlistenCloseRequested?.()
      unlistenConnectionLost?.()
    }
  }, [ closeWindow, connectionId ])

  return (
    <ConfigProvider theme={ AntdThemeConfig } locale={ zhCN } componentSize="small">
      <main className="terminal-window-shell">
        <header className="terminal-window-header">
          <span className="terminal-window-title">远程终端</span>
          <span className="terminal-window-subtitle">独立 SSH 会话</span>
        </header>
        <TerminalView
          connectionId={connectionId}
          connection={connection}
          onRequestClose={closeWindow}
          onCloseReady={registerTerminalClose}
        />
      </main>
    </ConfigProvider>
  )
}

export default TerminalWindow
