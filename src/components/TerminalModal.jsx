import React, { useEffect, useRef, useState } from 'react'
import { Button, Modal, Spin } from 'antd'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import AppIcon from './AppIcon'
import { normalizeError } from '../utils/constants.js'

const createTerminalId = () => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `terminal-${ crypto.randomUUID() }`
  }
  return `terminal-${ Date.now() }-${ Math.random().toString(16).slice(2) }`
}

const TERMINAL_THEME = {
  background: '#1e1f22',
  foreground: '#e6e8eb',
  cursor: '#eb9070',
  cursorAccent: '#1e1f22',
  selectionBackground: 'rgba(235, 144, 112, 0.28)',
  black: '#1e1f22',
  red: '#d86f6f',
  green: '#8fb996',
  yellow: '#d0a965',
  blue: '#7f9fb0',
  magenta: '#a894b5',
  cyan: '#7fa6a4',
  white: '#d8dbe0',
  brightBlack: '#858991',
  brightRed: '#ed9088',
  brightGreen: '#a8caa9',
  brightYellow: '#e4c17a',
  brightBlue: '#a2bfce',
  brightMagenta: '#c0aacd',
  brightCyan: '#a2c2bd',
  brightWhite: '#f1f3f5'
}

// 终端优先使用等宽字体，按 macOS、Windows、Linux 的常见字体顺序回退。
const TERMINAL_FONT_FAMILY = '"SF Mono", "SFMono-Regular", Menlo, Monaco, Consolas, "Liberation Mono", "DejaVu Sans Mono", monospace'

const LOG_HIGHLIGHT_COLORS = {
  FATAL: '38;2;225;132;125',
  ERROR: '38;2;225;132;125',
  EXCEPTION: '38;2;225;132;125',
  TRACEBACK: '38;2;225;132;125',
  WARN: '38;2;220;177;105',
  WARNING: '38;2;220;177;105',
  INFO: '38;2;145;181;151',
  NOTICE: '38;2;145;181;151',
  SUCCESS: '38;2;145;181;151',
  DEBUG: '38;2;158;162;173',
  TRACE: '38;2;158;162;173'
}

const LOG_HIGHLIGHT_PATTERN = /\b(FATAL|ERROR|EXCEPTION|TRACEBACK|WARN(?:ING)?|INFO|NOTICE|SUCCESS|DEBUG|TRACE)\b/gi
const UNSUPPORTED_CONTROL_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001a\u001c-\u001f]/

const highlightPlainText = text => text.replace(
  LOG_HIGHLIGHT_PATTERN,
  value => `\x1b[${ LOG_HIGHLIGHT_COLORS[value.toUpperCase()] }m${ value }\x1b[0m`
)

const decorateTerminalOutput = data => {
  // 含有 ESC 或其他控制字符的数据可能属于 ANSI、光标控制或全屏程序，必须原样交给 xterm。
  if (!data || data.includes('\x1b') || UNSUPPORTED_CONTROL_PATTERN.test(data)) return data
  return highlightPlainText(data)
}

/**
 * 终端视图只负责 xterm 与后端 PTY 的生命周期，外层可以是模态框或独立窗口。
 * 通过直接调用 Tauri 命令，独立 WebView 不需要复制主窗口的连接缓存。
 */
export const TerminalView = ({ connectionId, connection, onRequestClose, onCloseReady }) => {
  const containerRef = useRef(null)
  const terminalRef = useRef(null)
  const backendReadyRef = useRef(false)
  const closingRef = useRef(false)
  const writeErrorShownRef = useRef(false)
  const closeTerminalRef = useRef(() => Promise.resolve())
  const [ status, setStatus ] = useState('closed')
  const [ statusMessage, setStatusMessage ] = useState('')

  useEffect(() => {
    if (!connectionId || !containerRef.current) {
      setStatus('closed')
      setStatusMessage('')
      onCloseReady?.(() => Promise.resolve())
      return undefined
    }

    let disposed = false
    let listenerCleanups = []
    const terminalId = createTerminalId()
    backendReadyRef.current = false
    closingRef.current = false
    writeErrorShownRef.current = false
    setStatus('connecting')
    setStatusMessage('正在建立终端连接...')

    const terminal = new Terminal({
      allowProposedApi: false,
      convertEol: false,
      cursorBlink: true,
      cursorStyle: 'bar',
      disableStdin: true,
      fontFamily: TERMINAL_FONT_FAMILY,
      fontSize: 12,
      lineHeight: 1.18,
      scrollback: 5000,
      theme: TERMINAL_THEME
    })
    const fitAddon = new FitAddon()
    terminal.loadAddon(fitAddon)
    terminal.open(containerRef.current)
    terminalRef.current = terminal

    const closeBackend = () => {
      closingRef.current = true
      backendReadyRef.current = false
      // 关闭命令幂等，重复调用可以覆盖“窗口关闭早于 PTY 创建完成”的竞态。
      return invoke('close_ssh_terminal', { terminalId }).catch(() => false)
    }
    closeTerminalRef.current = closeBackend
    onCloseReady?.(closeBackend)

    const fitTerminal = () => {
      if (disposed) return
      const container = containerRef.current
      // 窗口初始布局完成前容器可能为 0 尺寸，此时跳过测量，交给 ResizeObserver 重试。
      if (!container || container.clientWidth <= 0 || container.clientHeight <= 0) return
      try {
        fitAddon.fit()
      } catch {
        return
      }
    }
    let fitFrame = 0
    const scheduleFit = () => {
      if (disposed || fitFrame) return
      fitFrame = window.requestAnimationFrame(() => {
        fitFrame = 0
        fitTerminal()
      })
    }
    const ResizeObserverConstructor = typeof window !== 'undefined' ? window.ResizeObserver : undefined
    const resizeObserver = typeof ResizeObserverConstructor === 'function'
      ? new ResizeObserverConstructor(scheduleFit)
      : null
    resizeObserver?.observe(containerRef.current)

    const dataDisposable = terminal.onData(data => {
      if (disposed || !backendReadyRef.current) return
      void invoke('write_ssh_terminal', { terminalId, data }).catch(error => {
        if (disposed || writeErrorShownRef.current) return
        writeErrorShownRef.current = true
        backendReadyRef.current = false
        terminal.options.disableStdin = true
        terminal.writeln(`\r\n\x1b[31m[终端输入失败] ${ normalizeError(error) }\x1b[0m`)
        setStatus('error')
        setStatusMessage('终端输入失败')
      })
    })
    const resizeDisposable = terminal.onResize(({ cols, rows }) => {
      if (disposed || !backendReadyRef.current) return
      void invoke('resize_ssh_terminal', {
        terminalId,
        columns: cols,
        rows
      }).catch(() => undefined)
    })

    const setupTerminal = async () => {
      try {
        const [ dataUnlisten, errorUnlisten, closedUnlisten ] = await Promise.all([
          listen('ssh-terminal-data', event => {
            const payload = event.payload || {}
            if (disposed || payload.terminalId !== terminalId || typeof payload.data !== 'string') return
            // xterm 自带 VT/ANSI 解析器；普通日志只增强关键词颜色，交互式控制序列原样传递。
            // 这样不会按 IPC 数据块破坏 vim、top 等程序的转义序列。
            terminal.write(decorateTerminalOutput(payload.data))
          }),
          listen('ssh-terminal-error', event => {
            const payload = event.payload || {}
            if (disposed || payload.terminalId !== terminalId) return
            const message = String(payload.message || '终端连接发生错误')
            terminal.writeln(`\r\n\x1b[31m[终端错误] ${ message }\x1b[0m`)
            setStatus('error')
            setStatusMessage('终端连接发生错误')
          }),
          listen('ssh-terminal-closed', event => {
            const payload = event.payload || {}
            if (disposed || payload.terminalId !== terminalId || payload.expected) return
            backendReadyRef.current = false
            terminal.options.disableStdin = true
            terminal.writeln(`\r\n\x1b[90m[${ payload.reason || '远程终端已关闭' }]\x1b[0m`)
            setStatus('closed')
            setStatusMessage(payload.reason || '远程终端已关闭')
          })
        ])
        if (disposed) {
          dataUnlisten()
          errorUnlisten()
          closedUnlisten()
          return
        }
        listenerCleanups = [ dataUnlisten, errorUnlisten, closedUnlisten ]
        fitTerminal()
        await invoke('open_ssh_terminal', {
          id: connectionId,
          terminalId,
          columns: terminal.cols,
          rows: terminal.rows
        })
        if (disposed || closingRef.current) {
          closeBackend()
          return
        }
        backendReadyRef.current = true
        terminal.options.disableStdin = false
        setStatus('connected')
        setStatusMessage('已连接')
        fitTerminal()
        terminal.focus()
      } catch (error) {
        if (disposed) return
        terminal.options.disableStdin = true
        terminal.writeln(`\r\n\x1b[31m[终端启动失败] ${ normalizeError(error) }\x1b[0m`)
        setStatus('error')
        setStatusMessage('终端启动失败')
        closeBackend()
      }
    }

    void setupTerminal()
    window.addEventListener('resize', fitTerminal)
    const firstFrame = window.requestAnimationFrame(fitTerminal)
    const secondFrame = window.requestAnimationFrame(() => window.requestAnimationFrame(fitTerminal))

    return () => {
      disposed = true
      if (fitFrame) window.cancelAnimationFrame(fitFrame)
      window.cancelAnimationFrame(firstFrame)
      window.cancelAnimationFrame(secondFrame)
      window.removeEventListener('resize', fitTerminal)
      resizeObserver?.disconnect()
      backendReadyRef.current = false
      dataDisposable.dispose()
      resizeDisposable.dispose()
      listenerCleanups.forEach(cleanup => cleanup())
      closeBackend()
      onCloseReady?.(() => Promise.resolve())
      fitAddon.dispose()
      terminal.dispose()
      terminalRef.current = null
      closeTerminalRef.current = () => Promise.resolve()
    }
  }, [ connectionId, onCloseReady ])

  const handleClose = () => {
    // 由外层宿主统一负责“清理 PTY + 关闭容器”，避免等待远端异常通道导致按钮无响应。
    if (onRequestClose) {
      void onRequestClose()
      return
    }
    void closeTerminalRef.current()
  }

  const statusLabel = status === 'connecting'
    ? <><Spin size="small" /> {statusMessage || '连接中...'}</>
    : statusMessage || (status === 'connected' ? '已连接' : '未连接')

  return (
    <div className="terminal-view">
      <div className="terminal-connection-meta">
        <AppIcon name="terminal" />
        <span>{connection?.username || '用户'}@{connection?.host || '服务器'}:{connection?.port || 22}</span>
        <span className={`terminal-status is-${ status }`}>
          {statusLabel}
        </span>
      </div>
      <div
        ref={containerRef}
        className="terminal-emulator"
        role="application"
        aria-label="远程终端"
        onClick={() => terminalRef.current?.focus()}
      />
      <div className="terminal-hint">
        <span>远程 Shell 会话</span>
        <Button
          type="text"
          size="small"
          className="terminal-close-button"
          icon={<AppIcon name="disconnect" />}
          onClick={handleClose}
        >
          关闭终端
        </Button>
      </div>
    </div>
  )
}

const TerminalModal = ({ open, onClose, connectionId, connection }) => {
  if (!open) return null
  return (
    <Modal
      rootClassName="compact-modal terminal-modal"
      title="远程终端"
      open
      centered
      footer={null}
      width="min(1120px, calc(100vw - 32px))"
      onCancel={onClose}
      maskClosable
      keyboard
      destroyOnHidden
    >
      <TerminalView
        connectionId={connectionId}
        connection={connection}
        onRequestClose={onClose}
      />
    </Modal>
  )
}

export default TerminalModal
