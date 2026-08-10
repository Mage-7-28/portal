/**
 * 远程终端 UI。
 * xterm 只处理显示和输入，PTY 生命周期由 Tauri 命令与事件完成闭环。
 */
import React, { useEffect, useRef, useState } from 'react'
import { Button, Modal, Spin } from 'antd'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import AppIcon from './AppIcon'
import { normalizeError } from '../utils/constants.js'

/**
 * 为每个终端 WebView 生成独立的后端会话标识。
 *
 * @returns {string} 可用于 Tauri PTY 命令和事件关联的终端 ID。
 */
const createTerminalId = () => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `terminal-${ crypto.randomUUID() }`
  }
  return `terminal-${ Date.now() }-${ Math.random().toString(16).slice(2) }`
}

// xterm 的基础主题令牌，与 CSS ANSI 颜色兜底保持一致。
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

// 普通日志关键词的 ANSI 前景色；已经携带控制序列的终端输出不会使用它。
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

// 仅匹配完整关键词，避免给普通单词的一部分添加颜色控制码。
const LOG_HIGHLIGHT_PATTERN = /\b(FATAL|ERROR|EXCEPTION|TRACEBACK|WARN(?:ING)?|INFO|NOTICE|SUCCESS|DEBUG|TRACE)\b/gi
// xterm 无法安全处理的控制字符模式；命中后将原样交给终端解析器。
const UNSUPPORTED_CONTROL_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001a\u001c-\u001f]/

/**
 * 只为普通日志关键词增加颜色，保留已有 ANSI 控制序列不变。
 *
 * @param {string} text - 不包含 ANSI 控制序列的终端文本。
 * @returns {string} 插入关键词颜色控制序列后的文本。
 */
const highlightPlainText = text => text.replace(
  LOG_HIGHLIGHT_PATTERN,
  value => `\x1b[${ LOG_HIGHLIGHT_COLORS[value.toUpperCase()] }m${ value }\x1b[0m`
)

/**
 * 判断输出是否可安全增强；交互式程序输出必须原样交给 xterm。
 *
 * @param {string} data - 后端 PTY 返回的文本数据。
 * @returns {string} 可安全增强时返回带关键词颜色的文本，否则返回原始数据。
 */
const decorateTerminalOutput = data => {
  // 含有 ESC 或其他控制字符的数据可能属于 ANSI、光标控制或全屏程序，必须原样交给 xterm。
  if (!data || data.includes('\x1b') || UNSUPPORTED_CONTROL_PATTERN.test(data)) return data
  return highlightPlainText(data)
}

/**
 * 终端视图只负责 xterm 与后端 PTY 的生命周期，外层可以是模态框或独立窗口。
 * 通过直接调用 Tauri 命令，独立 WebView 不需要复制主窗口的连接缓存。
 *
 * @param {Object} props - 终端视图属性。
 * @param {string|null} props.connectionId - 当前 SSH 连接 ID。
 * @param {{username?: string, host?: string, port?: number}|null} props.connection - 用于展示终端标题的连接信息。
 * @param {() => void|Promise<void>} [props.onRequestClose] - 请求外层宿主关闭终端的回调。
 * @param {(closeHandler: () => Promise<unknown>) => void} [props.onCloseReady] - 接收可幂等释放后端 PTY 的回调。
 * @returns {JSX.Element} 包含连接状态、xterm 容器和关闭按钮的终端视图。
 */
export const TerminalView = ({ connectionId, connection, onRequestClose, onCloseReady }) => {
  // xterm 容器和实例引用；实例存于 ref 以便按钮和清理回调读取最新对象。
  const containerRef = useRef(null)
  const terminalRef = useRef(null)
  // 后端 PTY 生命周期标志，避免在尚未建立或已经关闭后继续发送数据。
  const backendReadyRef = useRef(false)
  const closingRef = useRef(false)
  const writeErrorShownRef = useRef(false)
  // 对外暴露的幂等关闭函数，独立窗口宿主和组件卸载都会调用它。
  const closeTerminalRef = useRef(() => Promise.resolve())
  // 终端连接阶段和用户可读的状态文本。
  const [ status, setStatus ] = useState('closed')
  const [ statusMessage, setStatusMessage ] = useState('')

  // connectionId 变化时重建 xterm、IPC 监听和 PTY；清理必须先关后端再销毁视图。
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

    /**
     * 关闭当前终端的后端 PTY；命令设计为可重复调用以覆盖关闭竞态。
     *
     * @returns {Promise<boolean>} 后端关闭命令返回的结果；调用失败时返回 false。
     */
    const closeBackend = () => {
      closingRef.current = true
      backendReadyRef.current = false
      // 关闭命令幂等，重复调用可以覆盖“窗口关闭早于 PTY 创建完成”的竞态。
      return invoke('close_ssh_terminal', { terminalId }).catch(() => false)
    }
    closeTerminalRef.current = closeBackend
    onCloseReady?.(closeBackend)

    /**
     * 根据容器尺寸调整 xterm 行列数，容器尚未布局完成时跳过本次测量。
     *
     * @returns {void}
     */
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
    /**
     * 将多次尺寸变化合并到下一帧，避免 ResizeObserver 高频触发 fit。
     *
     * @returns {void}
     */
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

    /**
     * 注册终端 IPC 事件并创建后端 PTY，成功后开启 xterm 输入。
     *
     * @returns {Promise<void>} 终端初始化完成或失败清理完成后的 Promise。
     */
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

  /**
   * 请求宿主关闭终端；没有宿主回调时直接释放当前 PTY。
   *
   * @returns {void}
   */
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
        <span className="terminal-session-label">远程 Shell · 独立 SSH 会话</span>
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

/**
 * 模态框宿主，复用 TerminalView 以保持主窗口与独立窗口行为一致。
 *
 * @param {Object} props - 模态框属性。
 * @param {boolean} props.open - 是否显示终端模态框。
 * @param {() => void} props.onClose - 请求关闭模态框的回调。
 * @param {string|null} props.connectionId - 当前 SSH 连接 ID。
 * @param {{username?: string, host?: string, port?: number}|null} props.connection - 用于展示终端标题的连接信息。
 * @returns {JSX.Element|null} 打开时返回终端模态框，否则返回 null。
 */
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
