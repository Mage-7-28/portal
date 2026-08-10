import { useCallback, useEffect, useRef } from 'react'
import { ConfigProvider } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { AntdThemeConfig } from '../theme/antdTheme.js'
import { TerminalView } from './TerminalModal.jsx'

// 远端关闭命令异常阻塞时，窗口最多等待此时长后强制销毁 WebView。
const TERMINAL_CLOSE_TIMEOUT_MS = 1200

/**
 * 独立终端窗口的宿主。关闭窗口前先释放远程 PTY，避免 SSH 会话残留。
 *
 * @param {Object} props - 独立终端窗口属性。
 * @param {string|null} props.connectionId - 当前 SSH 连接 ID。
 * @param {{username?: string, host?: string, port?: number}|null} props.connection - 用于展示终端标题的连接信息。
 * @returns {JSX.Element} 包含独立终端视图和窗口级资源清理逻辑的页面。
 */
const TerminalWindow = ({ connectionId, connection }) => {
  // 当前 WebView 窗口实例；通过 ref 保证事件回调中读取同一窗口对象。
  const windowRef = useRef(null)
  // TerminalView 注册的后端 PTY 清理函数。
  const terminalCloseRef = useRef(() => Promise.resolve())
  // 防止关闭事件和连接断开事件同时触发两次销毁流程。
  const closingRef = useRef(false)

  if (!windowRef.current) {
    windowRef.current = getCurrentWebviewWindow()
  }

  /**
   * 注册由 TerminalView 创建的后端 PTY 清理函数。
   *
   * @param {(() => Promise<unknown>)|undefined} closeTerminal - 可幂等关闭后端终端会话的函数。
   * @returns {void}
   */
  const registerTerminalClose = useCallback(closeTerminal => {
    terminalCloseRef.current = typeof closeTerminal === 'function'
      ? closeTerminal
      : () => Promise.resolve()
  }, [])

  /**
   * 释放远程 PTY 并销毁当前独立窗口；远端异常时使用超时兜底。
   *
   * @returns {Promise<void>} PTY 清理和窗口销毁完成后的 Promise。
   */
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

  // 监听窗口关闭和 SSH 断线事件；卸载时撤销所有异步监听器。
  useEffect(() => {
    let disposed = false
    let unlistenCloseRequested
    let unlistenConnectionLost

    /**
     * 注册窗口关闭与连接断开监听，并在异步注册竞态中及时清理。
     *
     * @returns {Promise<void>} 窗口事件监听注册完成后的 Promise。
     */
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
