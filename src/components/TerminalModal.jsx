/**
 * 远程终端 UI。
 * xterm 只处理显示和输入，PTY 生命周期由 Tauri 命令与 Channel 完成闭环。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button, Input, Spin } from 'antd'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { Terminal } from '@xterm/xterm'
import { Channel, invoke } from '@tauri-apps/api/core'
import AppIcon from './AppIcon'
import { getErrorCode, getErrorDetails, normalizeError, StoreKeys } from '../utils/constants.js'
import { notification } from '../utils/notificationUtils.js'
import { store, useStoreValue } from '../utils/storeUtils.js'
import { normalizeTerminalFontSize } from '../utils/workspacePreferences.js'
import { createInputQueue, createOutputReceiver, createResizeQueue, normalizeTerminalDimensions } from '../utils/terminalTransport.js'
import { createTerminalOutputDecorator } from '../utils/terminalOutput.js'

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

// 即使随机数回退值相同，同一 WebView 的不同打开操作也使用不同代次。
let nextTerminalGeneration = 0

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
// 与 @xterm/addon-fit 0.11.0 的默认滚动条宽度一致。
const XTERM_6_SCROLLBAR_WIDTH = 14
// 原生输出背压上限为 256 KiB，最后一个数据包最多再携带 32 KiB。
const STARTUP_OUTPUT_MAX_BYTES = (256 + 32) * 1024
// 空数据包也可能占用接收器条目；额外允许错误和退出包。
const STARTUP_OUTPUT_MAX_PACKETS = STARTUP_OUTPUT_MAX_BYTES + 2

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

/**
 * 使用渲染器的设备像素单元计算完整网格，避免 CSS 画布舍入造成重复 fit 来回缩放。
 *
 * @param {Terminal} terminal - 当前终端实例。
 * @param {FitAddon} fitAddon - 已加载的尺寸插件。
 * @returns {{cols: number, rows: number}|undefined} 可容纳的列数和行数。
 */
const proposeStableTerminalDimensions = (terminal, fitAddon) => {
  const proposed = fitAddon.proposeDimensions()
  if (!proposed || !Number.isFinite(proposed.cols) || !Number.isFinite(proposed.rows)) return undefined

  // xterm 6.0.0 没有公开字符单元尺寸；此适配依赖其 DOM 渲染器的内部结构，升级时须复核。
  const cell = terminal._core?._renderService?.dimensions?.device?.cell
  const dpr = window.devicePixelRatio
  const element = terminal.element
  if (!element?.parentElement || !Number.isFinite(dpr) || dpr <= 0
    || !Number.isFinite(cell?.width) || cell.width <= 0
    || !Number.isFinite(cell?.height) || cell.height <= 0) return proposed

  const parentStyle = window.getComputedStyle(element.parentElement)
  const terminalStyle = window.getComputedStyle(element)
  const padding = side => Number.parseFloat(terminalStyle.getPropertyValue(`padding-${ side }`)) || 0
  const scrollbar = terminal.options.scrollback === 0 ? 0 : (terminal.options.overviewRuler?.width || XTERM_6_SCROLLBAR_WIDTH)
  const width = Number.parseFloat(parentStyle.getPropertyValue('width')) - padding('left') - padding('right') - scrollbar
  const height = Number.parseFloat(parentStyle.getPropertyValue('height')) - padding('top') - padding('bottom')
  if (!Number.isFinite(width) || !Number.isFinite(height)) return proposed

  const cellsThatFit = (available, deviceCell, minimum) => {
    // DOM 渲染器先将整块画布取整，再均分到各行列；按相同规则避免边界溢出。
    let count = Math.max(minimum, Math.floor((Math.floor(available) + 0.5) * dpr / deviceCell))
    if (count > minimum && Math.round(deviceCell * count / dpr) > available) count -= 1
    return count
  }
  return { cols: cellsThatFit(width, cell.width, 2), rows: cellsThatFit(height, cell.height, 1) }
}

/**
 * 终端视图只负责 xterm 与后端 PTY 的生命周期，外层可以是工作区或独立窗口。
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
 * @param {(controls: {openSearch: () => void, adjustFontSize: (delta: number) => void, resetFontSize: () => void, requestFit: () => void}|null) => void} [props.onControlsReady] - 注册不暴露终端实例的工具操作。
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

  useEffect(() => () => {
    // 已卸载的视图不能由在途偏好写入的完成回调再次更新。
    fontWriteRevisionRef.current += 1
    pendingFontWriteRef.current = false
  }, [])

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

  const requestFit = useCallback(() => fitTerminalRef.current(), [])
  const controls = useMemo(() => ({ openSearch, adjustFontSize, resetFontSize, requestFit }), [ openSearch, adjustFontSize, resetFontSize, requestFit ])

  // 自动聚焦只在窗口和终端都可交互、且用户没有聚焦其他控件时发生。
  const focusTerminalIfAvailable = useCallback(() => {
    if (!activeRef.current || searchOpenRef.current || (document.hasFocus && !document.hasFocus())) return
    const focusedElement = document.activeElement
    if (focusedElement && focusedElement !== document.body && !containerRef.current?.contains(focusedElement)) return
    terminalRef.current?.focus()
  }, [])

  // connectionId 变化时重建 xterm、IPC Channel 和 PTY；清理必须先关后端再销毁视图。
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
    const terminalId = createTerminalId()
    const generation = `${ createTerminalId() }-${ ++nextTerminalGeneration }`
    let closeRequested = false
    let endReceived = false
    let sessionErrored = false
    let transportErrorShown = false
    let inputQueue
    let resizeQueue
    let outputReceiver
    let outputChannel
    let startupConfirmed = false
    let startupOutput = []
    let startupOutputBytes = 0
    let startupPacketCount = 0
    backendReadyRef.current = false
    setStatus('connecting')
    setStatusMessage('正在建立终端连接...')

    const reportTerminalError = (label, error, kind) => {
      void notification.error(label, normalizeError(error), {
        delivery: 'in-app',
        duration: Infinity,
        details: getErrorDetails(error),
        id: `${ generation }-${ kind }`
      })
    }

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
      closeRequested = true
      // 旧连接的异步清理不能更改新实例的 PTY 状态。
      if (terminalRef.current === terminal) {
        backendReadyRef.current = false
      }
      inputQueue?.dispose()
      resizeQueue?.dispose()
      outputReceiver?.dispose()
      startupOutput = []
      startupOutputBytes = 0
      if (outputChannel) outputChannel.onmessage = () => undefined
      // 关闭命令幂等，重复调用可以覆盖“窗口关闭早于 PTY 创建完成”的竞态。
      return invoke('close_ssh_terminal', { terminalId, generation }).catch(() => false)
    }
    closeTerminalRef.current = closeBackend

    let fontMetricsDirty = false
    let initialResizePending = false
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
        if (fontMetricsDirty) {
          fontMetricsDirty = false
          // xterm 缓存字符尺寸；字体加载后通过公开的字体选项重新测量，不改变实际字体栈。
          const fontFamily = terminal.options.fontFamily
          terminal.options.fontFamily = `${ fontFamily } `
          terminal.options.fontFamily = fontFamily
        }
        const dimensions = proposeStableTerminalDimensions(terminal, fitAddon)
        if (dimensions && (terminal.cols !== dimensions.cols || terminal.rows !== dimensions.rows)) {
          terminal.resize(dimensions.cols, dimensions.rows)
        }
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
        if (initialResizePending) {
          initialResizePending = false
          if (!disposed && !closeRequested && !endReceived && backendReadyRef.current) {
            resizeQueue.request(terminal.cols, terminal.rows)
          }
        }
      })
    }
    const scheduleFontFit = () => {
      if (disposed) return
      fontMetricsDirty = true
      scheduleFit()
    }
    fitTerminalRef.current = scheduleFit
    const ResizeObserverConstructor = typeof window !== 'undefined' ? window.ResizeObserver : undefined
    const resizeObserver = typeof ResizeObserverConstructor === 'function'
      ? new ResizeObserverConstructor(scheduleFit)
      : null
    resizeObserver?.observe(containerRef.current)

    const fontSet = document.fonts
    fontSet?.ready?.then(scheduleFontFit, () => undefined)
    fontSet?.addEventListener?.('loadingdone', scheduleFontFit)

    // 分辨率媒体查询在 DPR 变化后必须重新订阅；xterm 自身会同步刷新字符尺寸。
    let resolutionQuery
    const removeResolutionListener = () => {
      if (resolutionQuery?.removeEventListener) resolutionQuery.removeEventListener('change', handleResolutionChange)
      else resolutionQuery?.removeListener?.(handleResolutionChange)
    }
    const watchResolution = () => {
      removeResolutionListener()
      if (disposed || !window.matchMedia) return
      resolutionQuery = window.matchMedia(`(resolution: ${ window.devicePixelRatio }dppx)`)
      if (resolutionQuery.addEventListener) resolutionQuery.addEventListener('change', handleResolutionChange)
      else resolutionQuery.addListener?.(handleResolutionChange)
    }
    const handleResolutionChange = () => {
      watchResolution()
      scheduleFit()
    }
    watchResolution()
    const handleVisibilityChange = () => {
      if (!document.hidden) scheduleFit()
    }
    window.addEventListener('resize', scheduleFit)
    window.addEventListener('focus', scheduleFit)
    document.addEventListener('visibilitychange', handleVisibilityChange)
    terminalContainer.addEventListener('focusin', scheduleFit)

    const failTransport = (label, error, allowAfterEnd = false) => {
      if (disposed || closeRequested || (endReceived && !allowAfterEnd) || transportErrorShown) return
      transportErrorShown = true
      sessionErrored = true
      backendReadyRef.current = false
      inputQueue?.dispose()
      resizeQueue?.dispose()
      terminal.options.disableStdin = true
      terminal.writeln(`\r\n\x1b[31m[${ label }] ${ normalizeError(error) }\x1b[0m`)
      reportTerminalError(label, error, 'transport')
      setStatus('error')
      setStatusMessage(label)
    }

    const failStartupOutput = () => {
      if (disposed || closeRequested) return
      failTransport('终端输出失败', new Error('终端启动前输出缓冲区已满'), true)
      void closeBackend()
    }

    inputQueue = createInputQueue({
      terminalId,
      generation,
      invoke,
      onOverflow: () => {
        if (!disposed && !closeRequested) terminal.writeln('\r\n\x1b[31m[终端输入失败] 输入队列已满，请稍后重试\x1b[0m')
      },
      onError: error => {
        // 读取线程可能已经移除会话，而最终输出和退出包仍在 Channel 中途。
        // 输入队列已停止，等待结束包按消费顺序处理，避免抢先禁用输入或误报失败。
        if (getErrorCode(error) === 'TerminalNotFound') return
        failTransport('终端输入失败', error)
      }
    })

    // 只应用仍对应当前 xterm 尺寸的后端响应，避免旧响应覆盖后续窗口变化。
    const applyEffectiveDimensions = (size, requested) => {
      if (disposed || closeRequested || !size || !Number.isFinite(size.columns) || !Number.isFinite(size.rows)) return
      const current = normalizeTerminalDimensions(terminal.cols, terminal.rows)
      if (current.columns !== requested.columns || current.rows !== requested.rows) return
      const effective = normalizeTerminalDimensions(size.columns, size.rows)
      if (terminal.cols !== effective.columns || terminal.rows !== effective.rows) {
        terminal.resize(effective.columns, effective.rows)
      }
    }
    let lastResizeFailure = ''
    const invokeResize = async (command, args) => {
      try {
        const result = await invoke(command, args)
        lastResizeFailure = ''
        return result
      } catch (error) {
        const code = getErrorCode(error)
        // 重试状态不是失败；结束包可能晚于会话移除到达，也不能将其误报为调整失败。
        if (!disposed && !closeRequested && !endReceived && !sessionErrored
          && code !== 'BackgroundBusy' && code !== 'TerminalResizePending' && code !== 'TerminalNotFound') {
          const failure = `${ code }\0${ getErrorDetails(error) }`
          if (failure !== lastResizeFailure) {
            lastResizeFailure = failure
            reportTerminalError('调整终端大小失败', error, 'resize')
          }
        }
        // 保留原始错误，交由单飞队列处理其重试与取消规则。
        throw error
      }
    }
    resizeQueue = createResizeQueue({ terminalId, generation, invoke: invokeResize, onResize: applyEffectiveDimensions })

    const decorateTerminalOutput = createTerminalOutputDecorator()
    const startupOutputEncoder = new globalThis.TextEncoder()
    const writeTerminalOutput = (data, consumed) => terminal.write(decorateTerminalOutput(data), consumed)
    const flushStartupOutput = () => {
      let index = 0
      // 保持暂存状态直到队列完全写入，避免同步重入时新数据插到旧数据之前。
      while (index < startupOutput.length && !disposed && !closeRequested) {
        const item = startupOutput[index]
        startupOutput[index++] = null
        startupOutputBytes -= item.bytes
        writeTerminalOutput(item.data, item.consumed)
      }
      startupOutput = []
      startupOutputBytes = 0
      startupConfirmed = true
    }
    outputReceiver = createOutputReceiver({
      terminalId,
      generation,
      invoke,
      // xterm 自带 VT/ANSI 解析器；普通日志只增强关键词颜色，交互式控制序列原样传递。
      write: (data, consumed) => {
        if (startupConfirmed) {
          writeTerminalOutput(data, consumed)
          return
        }
        const remaining = STARTUP_OUTPUT_MAX_BYTES - startupOutputBytes
        // 先限制 UTF-16 长度，避免为超大包分配无界的临时编码缓冲区。
        if (data.length > remaining) {
          failStartupOutput()
          return
        }
        const bytes = startupOutputEncoder.encode(data).byteLength
        if (bytes > remaining) {
          failStartupOutput()
          return
        }
        startupOutput.push({ data, consumed, bytes })
        startupOutputBytes += bytes
      },
      onEndReceived: () => { endReceived = true },
      onError: packet => {
        if (disposed || closeRequested) return
        sessionErrored = true
        backendReadyRef.current = false
        inputQueue.dispose()
        resizeQueue.dispose()
        terminal.options.disableStdin = true
        terminal.writeln(`\r\n\x1b[31m[终端错误] ${ String(packet.message || '终端连接发生错误') }\x1b[0m`)
        reportTerminalError('终端读取失败', packet.message || '终端连接发生错误', 'read')
        setStatus('error')
        setStatusMessage('终端连接发生错误')
      },
      onExit: packet => {
        if (disposed || closeRequested) return
        backendReadyRef.current = false
        inputQueue.dispose()
        resizeQueue.dispose()
        terminal.options.disableStdin = true
        const message = String(packet.message || '远程终端已关闭')
        terminal.writeln(`\r\n\x1b[90m[${ message }]\x1b[0m`)
        if (!sessionErrored) {
          setStatus('closed')
          setStatusMessage(message)
        }
      },
      onAckError: error => {
        // 读取线程发送最终包后可能先删除会话，再由 WebView 收到退出/错误包。
        // 此时不再需要 ACK，也不能提前销毁 Channel，否则会丢失尚在途的结束包。
        if (getErrorCode(error) === 'TerminalNotFound') return
        failTransport('终端输出失败', error)
        // 停止后端读取，避免无法确认的输出永久占满背压窗口。
        if (!disposed && !closeRequested && !endReceived) void closeBackend()
      }
    })
    const dataDisposable = terminal.onData(data => {
      if (disposed || closeRequested || endReceived || !backendReadyRef.current) return
      inputQueue.enqueue(data)
    })
    const resizeDisposable = terminal.onResize(({ cols, rows }) => {
      if (disposed || closeRequested || endReceived || !backendReadyRef.current || initialResizePending) return
      resizeQueue.request(cols, rows)
    })

    /**
     * 通过会话专属 Channel 创建后端 PTY，成功后开启 xterm 输入。
     *
     * @returns {Promise<void>} 终端初始化完成或失败清理完成后的 Promise。
     */
    const setupTerminal = async () => {
      try {
        outputChannel = new Channel(packet => {
          if (disposed || closeRequested) return
          if (!startupConfirmed && packet?.terminalId === terminalId && packet.generation === generation
            && ++startupPacketCount > STARTUP_OUTPUT_MAX_PACKETS) {
            failStartupOutput()
            return
          }
          outputReceiver.receive(packet)
        })
        fitTerminal()
        const requested = normalizeTerminalDimensions(terminal.cols, terminal.rows)
        const size = await invoke('open_ssh_terminal', {
          id: connectionId,
          terminalId,
          ...requested,
          generation,
          onOutput: outputChannel
        })
        if (disposed || closeRequested) {
          closeBackend()
          return
        }
        // 退出可能早于 open 命令返回；仍需消费其前序输出，但不能复活终端。
        if (endReceived || sessionErrored) {
          flushStartupOutput()
          return
        }
        applyEffectiveDimensions(size, requested)
        backendReadyRef.current = true
        terminal.options.disableStdin = false
        flushStartupOutput()
        if (disposed || closeRequested || endReceived || sessionErrored) return
        setStatus('connected')
        setStatusMessage('已连接')
        // 初始化在途时字号或窗口可能变化；等待 fit 后同步，即使本地尺寸未改变也发送一次。
        initialResizePending = true
        scheduleFit()
        focusTerminalIfAvailable()
      } catch (error) {
        if (disposed || closeRequested) return
        if (sessionErrored || (endReceived && startupOutput.length === 0)) {
          closeBackend()
          return
        }
        terminal.options.disableStdin = true
        terminal.writeln(`\r\n\x1b[31m[终端启动失败] ${ normalizeError(error) }\x1b[0m`)
        reportTerminalError('终端启动失败', error, 'open')
        setStatus('error')
        setStatusMessage('终端启动失败')
        closeBackend()
      }
    }

    void setupTerminal()
    scheduleFit()

    return () => {
      disposed = true
      if (fitFrame) window.cancelAnimationFrame(fitFrame)
      window.removeEventListener('resize', scheduleFit)
      window.removeEventListener('focus', scheduleFit)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      terminalContainer.removeEventListener('focusin', scheduleFit)
      fontSet?.removeEventListener?.('loadingdone', scheduleFontFit)
      removeResolutionListener()
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
    fitTerminalRef.current()
    const frame = window.requestAnimationFrame(() => {
      if (explicitlyRequested && activeRef.current && !searchOpenRef.current && (!document.hasFocus || document.hasFocus())) {
        terminalRef.current?.focus()
      } else {
        focusTerminalIfAvailable()
      }
    })
    return () => window.cancelAnimationFrame(frame)
  }, [ active, connectionId, focusRequest, focusTerminalIfAvailable ])

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
        className="terminal-emulator"
        role="application"
        aria-label="远程终端"
        onClick={() => {
          if (activeRef.current && (!document.hasFocus || document.hasFocus())) terminalRef.current?.focus()
        }}
      >
        {/* FitAddon 按父元素的 CSS 高度计算行数，使用无边框和内边距的容器避免把装饰空间算入终端。 */}
        <div ref={containerRef} className="terminal-fit-container" />
      </div>
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
