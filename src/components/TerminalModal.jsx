/**
 * 远程终端 UI。
 * xterm 只处理显示和输入，PTY 生命周期由 Tauri 命令与事件完成闭环。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button, Input, Modal, Spin } from 'antd'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { Terminal } from '@xterm/xterm'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import AppIcon from './AppIcon'
import { normalizeError, StoreKeys } from '../utils/constants.js'
import { store, useStoreValue } from '../utils/storeUtils.js'
import { normalizeTerminalFontSize } from '../utils/workspacePreferences.js'

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

const DEFAULT_TERMINAL_FONT_SIZE = 13
const MIN_TERMINAL_FONT_SIZE = 10
const MAX_TERMINAL_FONT_SIZE = 22
const SEARCH_HIGHLIGHT_LIMIT = 1000

const SEARCH_OPTIONS = {
  regex: false,
  caseSensitive: false,
  decorations: {
    matchBackground: '#4a4540',
    activeMatchBackground: '#805c4e',
    matchOverviewRuler: '#67c7d1',
    activeMatchColorOverviewRuler: '#eb9070'
  }
}

/** 搜索刷新由宿主统一调度，禁止插件的延迟刷新改写用户的复制选区。 */
class ControlledSearchAddon extends SearchAddon {
  activate(terminal) {
    super.activate(new Proxy(terminal, {
      get(target, key) {
        if (key === 'onWriteParsed' || key === 'onResize') return () => ({ dispose: () => undefined })
        const value = Reflect.get(target, key, target)
        return typeof value === 'function' ? value.bind(target) : value
      }
    }))
  }
}

/**
 * 仅拦截平台约定的终端搜索快捷键，保留 Shell 的 Ctrl+F。
 *
 * @param {KeyboardEvent} event - 当前键盘事件。
 * @returns {boolean} 是否为当前平台的搜索快捷键。
 */
const isTerminalSearchShortcut = event => {
  if (event.key.toLowerCase() !== 'f' || event.altKey) return false
  const platform = window.navigator.userAgentData?.platform || window.navigator.platform || window.navigator.userAgent
  const isMac = /Mac|iPhone|iPad|iPod/i.test(platform)
  return isMac
    ? event.metaKey && !event.ctrlKey && !event.shiftKey
    : event.ctrlKey && event.shiftKey && !event.metaKey
}

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
 * @param {boolean} [props.active=true] - 当前终端标签是否可见；重新显示时会校正尺寸并聚焦。
 * @param {boolean} [props.showFooter=true] - 是否显示独立终端宿主使用的底部关闭区域。
 * @param {boolean} [props.showConnectionMeta=true] - 是否显示连接地址和终端状态栏。
 * @param {(state: {status: string, message: string}) => void} [props.onStatusChange] - 将终端状态同步给外层面板。
 * @param {() => void|Promise<void>} [props.onRequestClose] - 请求外层宿主关闭终端的回调。
 * @param {(closeHandler: () => Promise<unknown>) => void} [props.onCloseReady] - 接收可幂等释放后端 PTY 的回调。
 * @param {(controls: {openSearch: () => void, adjustFontSize: (delta: number) => void, resetFontSize: () => void}|null) => void} [props.onControlsReady] - 注册不暴露终端实例的工具操作。
 * @param {number} [props.focusRequest=0] - 变化时将键盘焦点交给已运行终端。
 * @returns {JSX.Element} 包含连接状态和 xterm 容器，并可按宿主配置显示底部关闭区域的终端视图。
 */
export const TerminalView = ({
  connectionId,
  connection,
  active = true,
  showFooter = true,
  showConnectionMeta = true,
  onStatusChange,
  onRequestClose,
  onCloseReady,
  onControlsReady,
  focusRequest = 0
}) => {
  // xterm 容器和实例引用；实例存于 ref 以便按钮和清理回调读取最新对象。
  const containerRef = useRef(null)
  const terminalRef = useRef(null)
  const fitTerminalRef = useRef(() => undefined)
  const searchAddonRef = useRef(null)
  const runSearchRef = useRef(() => undefined)
  const searchInputRef = useRef(null)
  const activeRef = useRef(active)
  const searchOpenRef = useRef(false)
  const searchTermRef = useRef('')
  const searchConnectionRef = useRef(connectionId)
  const searchRefreshTimerRef = useRef(null)
  const previousFocusRequestRef = useRef(focusRequest)
  // 后端 PTY 生命周期标志，避免在尚未建立或已经关闭后继续发送数据。
  const backendReadyRef = useRef(false)
  const closingRef = useRef(false)
  const writeErrorShownRef = useRef(false)
  // 对外暴露的幂等关闭函数，独立窗口宿主和组件卸载都会调用它。
  const closeTerminalRef = useRef(() => Promise.resolve())
  // 终端连接阶段和用户可读的状态文本。
  const [ status, setStatus ] = useState(connectionId ? 'connecting' : 'closed')
  const [ statusMessage, setStatusMessage ] = useState('')
  const [ searchOpen, setSearchOpen ] = useState(false)
  const [ searchTerm, setSearchTerm ] = useState('')
  const [ searchResults, setSearchResults ] = useState({ resultIndex: -1, resultCount: 0 })
  const storedFontSize = useStoreValue(StoreKeys.TERMINAL_FONT_SIZE)
  const [ fontSize, setFontSize ] = useState(() => normalizeTerminalFontSize(storedFontSize))
  const fontSizeRef = useRef(fontSize)
  const fontWriteRevisionRef = useRef(0)
  const pendingFontWriteRef = useRef(false)
  activeRef.current = active
  searchOpenRef.current = searchOpen
  searchTermRef.current = searchTerm

  // 其他窗口修改全局偏好时同步当前实例，不重建终端或 PTY。
  useEffect(() => {
    if (pendingFontWriteRef.current) return
    const nextSize = normalizeTerminalFontSize(storedFontSize)
    fontSizeRef.current = nextSize
    setFontSize(nextSize)
  }, [storedFontSize])

  const updateFontSize = useCallback(nextSize => {
    const normalized = normalizeTerminalFontSize(nextSize)
    const revision = ++fontWriteRevisionRef.current
    pendingFontWriteRef.current = true
    fontSizeRef.current = normalized
    setFontSize(normalized)
    void store.set(StoreKeys.TERMINAL_FONT_SIZE, normalized)
      .catch(error => console.warn('保存终端字号失败：', error))
      .finally(() => {
        if (revision !== fontWriteRevisionRef.current) return
        pendingFontWriteRef.current = false
        // 在途写入期间可能跳过了其他窗口的更新，结束后必须与最新 Store 快照协调。
        const latestSize = normalizeTerminalFontSize(store.state[StoreKeys.TERMINAL_FONT_SIZE])
        fontSizeRef.current = latestSize
        setFontSize(latestSize)
      })
  }, [])

  const adjustFontSize = useCallback(delta => {
    if (!Number.isFinite(delta) || delta === 0) return
    const nextSize = Math.max(MIN_TERMINAL_FONT_SIZE, Math.min(MAX_TERMINAL_FONT_SIZE, fontSizeRef.current + Math.sign(delta)))
    if (nextSize !== fontSizeRef.current) updateFontSize(nextSize)
  }, [updateFontSize])

  const resetFontSize = useCallback(() => {
    updateFontSize(DEFAULT_TERMINAL_FONT_SIZE)
  }, [updateFontSize])

  const openSearch = useCallback(() => {
    if (!activeRef.current) return
    setSearchOpen(true)
    searchInputRef.current?.focus()
  }, [])

  const controls = useMemo(() => ({ openSearch, adjustFontSize, resetFontSize }), [ openSearch, adjustFontSize, resetFontSize ])

  // 自动聚焦只在窗口和终端都可交互、且用户没有聚焦其他控件时发生。
  const focusTerminalIfAvailable = useCallback(() => {
    if (!activeRef.current || searchOpenRef.current || (document.hasFocus && !document.hasFocus())) return
    const focusedElement = document.activeElement
    if (focusedElement && focusedElement !== document.body && !containerRef.current?.contains(focusedElement)) return
    terminalRef.current?.focus()
  }, [])

  // connectionId 变化时重建 xterm、IPC 监听和 PTY；清理必须先关后端再销毁视图。
  useEffect(() => {
    if (searchConnectionRef.current !== connectionId) {
      // 搜索内容只属于原会话，不能带入新连接。
      searchConnectionRef.current = connectionId
      searchOpenRef.current = false
      searchTermRef.current = ''
      setSearchOpen(false)
      setSearchTerm('')
      setSearchResults({ resultIndex: -1, resultCount: 0 })
    }
    if (!connectionId || !containerRef.current) {
      setStatus('closed')
      setStatusMessage('')
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

    const motionPreference = window.matchMedia?.('(prefers-reduced-motion: reduce)')
    const terminal = new Terminal({
      // SearchAddon 的结果计数与高亮依赖 xterm 的实验性 decoration API。
      allowProposedApi: true,
      convertEol: false,
      cursorBlink: !motionPreference?.matches,
      cursorStyle: 'bar',
      disableStdin: true,
      fontFamily: TERMINAL_FONT_FAMILY,
      fontSize: fontSizeRef.current,
      lineHeight: 1.25,
      scrollback: 5000,
      theme: TERMINAL_THEME
    })
    const fitAddon = new FitAddon()
    terminal.loadAddon(fitAddon)
    terminal.open(containerRef.current)
    terminalRef.current = terminal
    let searchResultsDisposable
    const releaseSearch = () => {
      searchResultsDisposable?.dispose()
      searchResultsDisposable = null
      searchAddonRef.current?.dispose()
      searchAddonRef.current = null
    }
    const restoreSelection = selection => {
      if (selection) {
        const length = (selection.end.y - selection.start.y) * terminal.cols + selection.end.x - selection.start.x
        terminal.select(selection.start.x, selection.start.y, length)
      } else {
        terminal.clearSelection()
      }
    }
    runSearchRef.current = (direction = 'next', incremental = true, preserveSelection = false) => {
      const term = searchTermRef.current
      const selection = terminal.getSelectionPosition()
      const viewportY = terminal.buffer.active.viewportY
      releaseSearch()
      if (!term || disposed) {
        if (!disposed) setSearchResults({ resultIndex: -1, resultCount: 0 })
        return
      }
      // 每次搜索建立新缓存，确保回车或光标控制造成的原位覆盖也能立即反映。
      const searchAddon = new ControlledSearchAddon({ highlightLimit: SEARCH_HIGHLIGHT_LIMIT })
      terminal.loadAddon(searchAddon)
      searchAddonRef.current = searchAddon
      searchResultsDisposable = searchAddon.onDidChangeResults(result => {
        if (!disposed) setSearchResults(result)
      })
      searchAddon.findNext(term, { ...SEARCH_OPTIONS, incremental: true })
      if (!incremental) {
        // 缓存初始化不能移动显式导航的起点；下一次查找从用户原选区继续。
        restoreSelection(selection)
        terminal.scrollToLine(viewportY)
        if (direction === 'previous') searchAddon.findPrevious(term, SEARCH_OPTIONS)
        else searchAddon.findNext(term, SEARCH_OPTIONS)
      } else if (preserveSelection) {
        const selectedMatch = terminal.getSelectionPosition()
        if (!selection || !selectedMatch
          || selection.start.x !== selectedMatch.start.x || selection.start.y !== selectedMatch.start.y
          || selection.end.x !== selectedMatch.end.x || selection.end.y !== selectedMatch.end.y) {
          searchAddon.clearActiveDecoration()
          setSearchResults(current => ({ ...current, resultIndex: -1 }))
        }
        restoreSelection(selection)
        terminal.scrollToLine(viewportY)
      }
    }
    let selectionDragActive = false
    // 输出与缩放共用有界节流；拖选期间不调用搜索，避免插件清除 xterm 的拖动监听。
    const scheduleSearchRefresh = () => {
      if (disposed || selectionDragActive || !searchOpenRef.current || !searchTermRef.current || searchRefreshTimerRef.current !== null) return
      searchRefreshTimerRef.current = window.setTimeout(() => {
        searchRefreshTimerRef.current = null
        if (disposed || selectionDragActive || !searchOpenRef.current || !searchTermRef.current) return
        runSearchRef.current('next', true, true)
      }, 400)
    }
    const pauseSearchWhileSelecting = event => {
      if (event.button === 0) selectionDragActive = true
    }
    const resumeSearchAfterSelecting = () => {
      if (!selectionDragActive) return
      selectionDragActive = false
      scheduleSearchRefresh()
    }
    const terminalContainer = containerRef.current
    terminalContainer.addEventListener('pointerdown', pauseSearchWhileSelecting, true)
    document.addEventListener('pointerup', resumeSearchAfterSelecting, true)
    document.addEventListener('pointercancel', resumeSearchAfterSelecting, true)
    window.addEventListener('blur', resumeSearchAfterSelecting)
    const searchOutputDisposable = terminal.onWriteParsed(scheduleSearchRefresh)
    const searchResizeDisposable = terminal.onResize(scheduleSearchRefresh)
    const handleMotionChange = event => {
      terminal.options.cursorBlink = !event.matches
    }
    if (motionPreference?.addEventListener) motionPreference.addEventListener('change', handleMotionChange)
    else motionPreference?.addListener?.(handleMotionChange)

    /**
     * 关闭当前终端的后端 PTY；命令设计为可重复调用以覆盖关闭竞态。
     *
     * @returns {Promise<boolean>} 后端关闭命令返回的结果；调用失败时返回 false。
     */
    const closeBackend = () => {
      // 旧连接的异步清理不能更改新实例的 PTY 状态。
      if (terminalRef.current === terminal) {
        closingRef.current = true
        backendReadyRef.current = false
      }
      // 关闭命令幂等，重复调用可以覆盖“窗口关闭早于 PTY 创建完成”的竞态。
      return invoke('close_ssh_terminal', { terminalId }).catch(() => false)
    }
    closeTerminalRef.current = closeBackend

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
    fitTerminalRef.current = scheduleFit
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
    let pendingResize = null
    let resizeInFlight = false
    // 原生尺寸命令可能乱序完成；每个 PTY 串行发送，并合并等待期间的中间尺寸。
    const syncTerminalSize = async (columns, rows) => {
      pendingResize = { columns, rows }
      if (resizeInFlight || disposed || !backendReadyRef.current) return
      resizeInFlight = true
      try {
        while (pendingResize && !disposed && backendReadyRef.current) {
          const size = pendingResize
          pendingResize = null
          await invoke('resize_ssh_terminal', { terminalId, ...size }).catch(() => undefined)
        }
      } finally {
        resizeInFlight = false
      }
    }
    const resizeDisposable = terminal.onResize(({ cols, rows }) => {
      if (disposed || !backendReadyRef.current) return
      void syncTerminalSize(cols, rows)
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
        // 初始化在途时字号或窗口可能变化，fit 未改变本地尺寸也必须同步一次远端 PTY。
        void syncTerminalSize(terminal.cols, terminal.rows)
        focusTerminalIfAvailable()
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
      pendingResize = null
      if (fitFrame) window.cancelAnimationFrame(fitFrame)
      window.cancelAnimationFrame(firstFrame)
      window.cancelAnimationFrame(secondFrame)
      window.removeEventListener('resize', fitTerminal)
      resizeObserver?.disconnect()
      backendReadyRef.current = false
      dataDisposable.dispose()
      resizeDisposable.dispose()
      releaseSearch()
      searchOutputDisposable.dispose()
      searchResizeDisposable.dispose()
      terminalContainer.removeEventListener('pointerdown', pauseSearchWhileSelecting, true)
      document.removeEventListener('pointerup', resumeSearchAfterSelecting, true)
      document.removeEventListener('pointercancel', resumeSearchAfterSelecting, true)
      window.removeEventListener('blur', resumeSearchAfterSelecting)
      if (searchRefreshTimerRef.current !== null) window.clearTimeout(searchRefreshTimerRef.current)
      searchRefreshTimerRef.current = null
      listenerCleanups.forEach(cleanup => cleanup())
      if (motionPreference?.removeEventListener) motionPreference.removeEventListener('change', handleMotionChange)
      else motionPreference?.removeListener?.(handleMotionChange)
      closeBackend()
      fitAddon.dispose()
      terminal.dispose()
      terminalRef.current = null
      runSearchRef.current = () => undefined
      fitTerminalRef.current = () => undefined
      closeTerminalRef.current = () => Promise.resolve()
    }
  }, [ connectionId, focusTerminalIfAvailable ])

  // 宿主回调身份变化只重新注册清理函数，不应重启正在使用的 PTY。
  useEffect(() => {
    onCloseReady?.(closeTerminalRef.current)
    return () => onCloseReady?.(() => Promise.resolve())
  }, [ connectionId, onCloseReady ])

  useEffect(() => {
    onControlsReady?.(controls)
    return () => onControlsReady?.(null)
  }, [ controls, onControlsReady ])

  useEffect(() => {
    const terminal = terminalRef.current
    if (!terminal) return
    if (terminal.options.fontSize !== fontSize) terminal.options.fontSize = fontSize
    fitTerminalRef.current()
  }, [ connectionId, fontSize ])

  // 隐藏标签重新显示后，按新的可用区域校正 PTY 行列并把输入焦点交还终端。
  useEffect(() => {
    const explicitlyRequested = focusRequest !== previousFocusRequestRef.current
    previousFocusRequestRef.current = focusRequest
    if (!active) return undefined
    const frame = window.requestAnimationFrame(() => {
      fitTerminalRef.current()
      if (explicitlyRequested && activeRef.current && !searchOpenRef.current && (!document.hasFocus || document.hasFocus())) {
        terminalRef.current?.focus()
      } else {
        focusTerminalIfAvailable()
      }
    })
    return () => window.cancelAnimationFrame(frame)
  }, [ active, focusRequest, focusTerminalIfAvailable ])

  // 搜索只读取当前 xterm 缓冲区，结果装饰启用后插件才会报告匹配数量。
  useEffect(() => {
    if (!searchOpen || !searchOpenRef.current || !terminalRef.current) return
    if (!searchTerm) {
      searchAddonRef.current?.dispose()
      searchAddonRef.current = null
      terminalRef.current?.clearSelection()
      setSearchResults(current => current.resultCount === 0 && current.resultIndex === -1
        ? current
        : { resultIndex: -1, resultCount: 0 })
      return
    }
    runSearchRef.current()
  }, [ connectionId, searchOpen, searchTerm ])

  useEffect(() => {
    if (searchOpen && activeRef.current && (!document.hasFocus || document.hasFocus())) {
      searchInputRef.current?.focus()
    }
  }, [searchOpen])

  const findSearchResult = direction => {
    const term = searchTermRef.current
    if (!term) return
    runSearchRef.current(direction, false)
  }

  const closeSearch = () => {
    if (searchRefreshTimerRef.current !== null) window.clearTimeout(searchRefreshTimerRef.current)
    searchRefreshTimerRef.current = null
    searchAddonRef.current?.dispose()
    searchAddonRef.current = null
    searchTermRef.current = ''
    setSearchTerm('')
    setSearchResults({ resultIndex: -1, resultCount: 0 })
    setSearchOpen(false)
    if (activeRef.current && (!document.hasFocus || document.hasFocus())) terminalRef.current?.focus()
  }

  const handleSearchKeyDown = event => {
    // 输入法组合中的 Enter/Escape 应留给输入法处理。
    if (event.nativeEvent?.isComposing || event.isComposing || event.keyCode === 229) return
    if (event.key === 'Enter') {
      event.preventDefault()
      event.stopPropagation()
      findSearchResult(event.shiftKey ? 'previous' : 'next')
    } else if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      closeSearch()
    }
  }

  const handleSearchShortcut = event => {
    if (!activeRef.current || event.nativeEvent?.isComposing || !isTerminalSearchShortcut(event)) return
    event.preventDefault()
    event.stopPropagation()
    openSearch()
  }

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

  useEffect(() => {
    onStatusChange?.({ status, message: statusMessage })
  }, [ onStatusChange, status, statusMessage ])

  const resultCountLabel = searchResults.resultCount >= SEARCH_HIGHLIGHT_LIMIT
    ? `≥${ SEARCH_HIGHLIGHT_LIMIT }`
    : String(searchResults.resultCount)
  const searchResultLabel = searchResults.resultCount
    ? `${ searchResults.resultIndex >= 0 ? searchResults.resultIndex + 1 : '—' } / ${ resultCountLabel }`
    : '0 / 0'

  return (
    <div
      className="terminal-view"
      style={{ position: 'relative', '--terminal-font-size': `${ fontSize }px` }}
      onKeyDownCapture={handleSearchShortcut}
    >
      {showConnectionMeta && (
        <div className="terminal-connection-meta">
          <AppIcon name="terminal" />
          <span>{connection?.username || '用户'}@{connection?.host || '服务器'}:{connection?.port || 22}</span>
          <span className={`terminal-status is-${ status }`}>
            {statusLabel}
          </span>
          <div style={{ display: 'flex', flex: '0 0 auto', alignItems: 'center', gap: 2 }}>
            <Button
              type="text"
              size="small"
              title="搜索终端缓冲区"
              aria-label="搜索终端缓冲区"
              onClick={openSearch}
              icon={(
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true" focusable="false">
                  <circle cx="10.5" cy="10.5" r="6.5" />
                  <path d="m15.5 15.5 4.5 4.5" />
                </svg>
              )}
            />
            <Button type="text" size="small" title="缩小终端字号" aria-label="缩小终端字号" disabled={fontSize <= MIN_TERMINAL_FONT_SIZE} onClick={() => adjustFontSize(-1)}>A−</Button>
            <Button type="text" size="small" title={`恢复默认字号（${ DEFAULT_TERMINAL_FONT_SIZE }px）`} aria-label={`恢复默认字号（${ DEFAULT_TERMINAL_FONT_SIZE }px），当前 ${ fontSize } 像素`} onClick={resetFontSize}>{fontSize}px</Button>
            <Button type="text" size="small" title="放大终端字号" aria-label="放大终端字号" disabled={fontSize >= MAX_TERMINAL_FONT_SIZE} onClick={() => adjustFontSize(1)}>A+</Button>
          </div>
        </div>
      )}
      <div
        ref={containerRef}
        className="terminal-emulator"
        role="application"
        aria-label="远程终端"
        onClick={() => {
          if (activeRef.current && (!document.hasFocus || document.hasFocus())) terminalRef.current?.focus()
        }}
      />
      {searchOpen && (
        <div
          role="search"
          aria-label="终端缓冲区搜索"
          onKeyDown={event => {
            if (event.key === 'Escape') handleSearchKeyDown(event)
          }}
          style={{
            position: 'absolute',
            top: showConnectionMeta ? 46 : 6,
            right: 8,
            zIndex: 2,
            display: 'flex',
            alignItems: 'center',
            gap: 3,
            width: 'min(360px, calc(100% - 16px))',
            padding: 5,
            border: '1px solid rgba(103, 199, 209, 0.35)',
            borderRadius: 6,
            background: '#292b2f',
            boxShadow: '0 4px 14px rgba(0, 0, 0, 0.3)'
          }}
        >
          <Input
            ref={searchInputRef}
            size="small"
            aria-label="搜索终端内容"
            placeholder="搜索终端内容"
            value={searchTerm}
            autoComplete="off"
            spellCheck={false}
            style={{ flex: '1 1 auto', minWidth: 0 }}
            onChange={event => setSearchTerm(event.target.value)}
            onKeyDown={handleSearchKeyDown}
          />
          <span role="status" aria-live="polite" style={{ flex: '0 0 auto', minWidth: 46, textAlign: 'center', fontSize: 11 }}>
            {searchResultLabel}
          </span>
          <Button type="text" size="small" title="上一个匹配项 (Shift+Enter)" aria-label="上一个匹配项" disabled={!searchTerm} icon={<AppIcon name="chevronUp" />} onMouseDown={event => event.preventDefault()} onClick={() => findSearchResult('previous')} />
          <Button type="text" size="small" title="下一个匹配项 (Enter)" aria-label="下一个匹配项" disabled={!searchTerm} icon={<AppIcon name="chevronDown" />} onMouseDown={event => event.preventDefault()} onClick={() => findSearchResult('next')} />
          <Button type="text" size="small" title="关闭搜索 (Esc)" aria-label="关闭搜索" icon={<AppIcon name="close" />} onClick={closeSearch} />
        </div>
      )}
      {showFooter && (
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
      )}
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
      mask={{ closable: true }}
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
