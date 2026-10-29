/**
 * 远程文件浏览器视图。
 * 父组件负责连接和目录数据，本组件负责路径工具栏、选择、上传、批量操作和预览交互。
 */
import React from 'react'
import { Alert, Button, Dropdown, Input, List, Modal, Space, Spin, Tooltip, Upload } from 'antd'
import VirtualList from '@rc-component/virtual-list'
import AppIcon from './AppIcon'
import { resolveFileIcon } from '../utils/fileIconUtils.js'
import FileItem from './FileItem'
import TransferCancelButton from './TransferCancelButton.jsx'
import { invoke } from '@tauri-apps/api/core'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import * as dialog from '@tauri-apps/plugin-dialog'
import { confirm } from '@tauri-apps/plugin-dialog'
import { PubSubBusinessKeyEnum } from '../utils/common'
import { normalizeError } from '../utils/constants.js'
import { sftpManager } from '../utils/sftpUtils'
import { notification } from '../utils/notificationUtils'
import { openTerminalWindow } from '../utils/terminalWindow.js'
import { PROGRESS_EVENT_END, createProgressIds } from '../utils/progressState.js'
import { getUploadDropResultAction, isUploadSessionActive } from '../utils/uploadUtils.js'
import { createKeyedOperationLocks, createNativeBatchWorkflow, createOperationLock, getKeyboardFileIndex } from '../utils/transferWorkflow.js'

// 按 macOS 实际拖拽反馈校准 30 个 CSS 像素，只影响纵向命中位置。
const MACOS_DROP_TARGET_Y_OFFSET = 30

/**
 * 从本地路径中提取用于上传列表展示的最后一级名称。
 *
 * @param {string} path - 本地文件或目录路径。
 * @returns {string} 最后一级名称；无法识别时返回空字符串。
 */
const localPathName = (path) => String(path || '')
  .replace(/[\\/]+$/, '')
  .split(/[\\/]/)
  .pop() || ''

/**
 * 统一原生文件选择器返回的单路径、路径数组和空值。
 *
 * @param {string|string[]|null|undefined} result - Tauri 目录选择器的原始结果。
 * @returns {string[]} 去重且非空的本地路径数组。
 */
const normalizeSelectedPaths = (result) => {
  const paths = result ? (Array.isArray(result) ? result : [result]) : []
  return [...new Set(paths.filter(path => typeof path === 'string' && path))]
}

/**
 * 合并待上传项目并按本地路径去重，避免重复选择造成重复传输。
 *
 * @param {Array<{localPath: string, fileName: string, kind: 'file'|'directory'}>} previous - 当前上传队列。
 * @param {Array<{localPath: string, fileName: string, kind: 'file'|'directory'}>} items - 新选择的上传项目。
 * @returns {Array<{localPath: string, fileName: string, kind: 'file'|'directory'}>} 合并后的上传队列。
 */
const mergeUploadItems = (previous, items) => {
  const existingPaths = new Set(previous.map(item => item.localPath))
  return [
    ...previous,
    ...items.filter(item => !existingPaths.has(item.localPath))
  ]
}

/**
 * 获取列表项稳定键；远程路径优先于名称。
 *
 * @param {{path?: string, name?: string}|null|undefined} entry - 远程文件条目。
 * @returns {string} 可用于选中状态的稳定键；条目无有效信息时返回空字符串。
 */
const getEntryKey = (entry) => entry?.path || entry?.name || ''

/**
 * 将原生拖放坐标归一到 CSS 视口后判断是否落在目标列表区域。
 * 每次读取列表的实时边界，使分栏缩放和面板间距调整自动反映到拖放命中区。
 * macOS 单独校准纵向偏差，不改变左右边界，也不混入窗口屏幕位置。
 *
 * @param {{x: number, y: number}|null|undefined} position - Tauri 原生拖放坐标。
 * @param {Element|null} element - 文件列表的目标 DOM 元素。
 * @returns {boolean} 坐标位于目标元素矩形范围内时返回 true。
 */
const isPositionInsideElement = (position, element) => {
  if (!position || !element || typeof window === 'undefined') return false
  const rect = element.getBoundingClientRect()
  const platform = window.navigator?.userAgentData?.platform
    || window.navigator?.platform
    || window.navigator?.userAgent
    || ''
  const scale = /^win/i.test(platform) ? window.devicePixelRatio || 1 : 1
  const yOffset = /^mac/i.test(platform) ? MACOS_DROP_TARGET_Y_OFFSET : 0
  const x = Number(position.x) / scale
  const y = Number(position.y) / scale - yOffset
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom
}

/**
 * 拼接远程路径；SFTP 端始终使用 `/`，不跟随本机平台分隔符。
 *
 * @param {string} basePath - 当前远程目录路径。
 * @param {string} name - 要追加的文件或目录名称。
 * @returns {string} 规范化后的远程子路径。
 */
const joinRemotePath = (basePath, name) => `${ basePath.replace(/\/+$/, '') || '' }/${ name }` || `/${ name }`

/**
 * 渲染已连接服务器的远程文件浏览器和批量操作入口。
 *
 * @param {Object} props - 文件浏览器属性。
 * @param {boolean} [props.showTerminalAction=true] - 是否显示独立终端快捷操作。
 * @param {string} props.currentPath - 当前显示的远程目录路径。
 * @param {string} props.pathInput - 尚未提交的路径输入，不参与远程操作目标计算。
 * @param {Array<Object>} props.files - 当前目录的远程条目。
 * @param {boolean} props.loading - 当前目录是否正在加载。
 * @param {string|null} props.error - 目录读取错误信息。
 * @param {Object|null} props.currentConnection - 当前连接的非敏感配置。
 * @param {string|null} props.currentConnectionId - 当前 SSH 连接 ID。
 * @param {boolean} [props.showConnectionSummary=true] - 是否展示当前服务器名称和地址。
 * @param {boolean} [props.showDisconnectAction=true] - 是否展示主动断开连接按钮。
 * @param {boolean} props.showHiddenFiles - 是否显示隐藏项目。
 * @param {string} props.homeDir - 远程用户主目录。
 * @param {string[]} props.drives - 可切换的远程盘符列表。
 * @param {() => void} props.handleGoBack - 返回上级目录回调。
 * @param {(event: Object) => void} props.handlePathChange - 路径输入变更回调。
 * @param {(event: Object) => void} props.handlePathSubmit - 路径表单提交回调。
 * @param {(target?: {connectionId: string, path: string, connection: Object}) => Promise<void>|void} props.handleRefresh - 手动刷新或按上传时捕获的目录和会话刷新。
 * @param {(entry: Object) => void} props.handleItemClick - 进入目录或打开文件回调。
 * @param {(name: string) => Promise<void>} props.handleCreateDirectory - 创建目录回调。
 * @param {(entry: Object) => Promise<void>} props.handleDeleteItem - 删除单个项目回调。
 * @param {(entries: Object[], onComplete: () => void) => Promise<void>} props.handleDeleteItems - 批量删除回调。
 * @param {(entries: Object[], onComplete: () => void) => Promise<void>} props.handleDownloadItems - 批量下载回调。
 * @param {(entry: Object, name: string) => Promise<void>} props.handleRenameItem - 重命名回调。
 * @param {(path: string) => void} props.handleDriveSelect - 选择远程盘符回调。
 * @param {() => Promise<void>} props.handleDisconnect - 断开当前连接回调。
 * @param {(connection: Object) => void|Promise<void>} [props.onOpenTerminal] - 在主窗口创建终端标签的回调。
 * @returns {JSX.Element} 路径工具栏、远程条目、上传对话框和批量操作控件。
 */
const FileBrowser = ({
  currentPath,
  pathInput = currentPath,
  files,
  loading,
  error,
  currentConnection,
  currentConnectionId,
  showConnectionSummary = true,
  showDisconnectAction = true,
  showHiddenFiles,
  homeDir,
  drives,
  handleGoBack,
  handlePathChange,
  handlePathCancel,
  handlePathSubmit,
  handleRefresh,
  handleItemClick,
  handleCreateDirectory,
  handleDeleteItem,
  handleDeleteItems,
  handleDownloadItems,
  handleRenameItem,
  handleDriveSelect,
  handleDisconnect,
  onOpenTerminal,
  showTerminalAction = true
}) => {
  // 新建目录弹窗及其表单提交状态。
  const [ directoryModalOpen, setDirectoryModalOpen ] = React.useState(false)
  const [ directoryName, setDirectoryName ] = React.useState('')
  const [ directorySubmitting, setDirectorySubmitting ] = React.useState(false)
  // 上传弹窗、待上传项目队列和原生选择器状态。
  const [ uploadModalOpen, setUploadModalOpen ] = React.useState(false)
  const [ uploadItems, setUploadItems ] = React.useState([])
  const [ uploadPicking, setUploadPicking ] = React.useState(null)
  const [ uploadSubmitting, setUploadSubmitting ] = React.useState(false)
  // Tauri 拖放悬停区域和路径检查状态。
  const [ uploadDragActive, setUploadDragActive ] = React.useState(false)
  const [ directoryDropActive, setDirectoryDropActive ] = React.useState(false)
  const [ uploadDropProcessing, setUploadDropProcessing ] = React.useState(false)
  // 当前目录中的多选结果和批量操作 loading 状态。
  const [ selectedKeys, setSelectedKeys ] = React.useState([])
  const [ renameTarget, setRenameTarget ] = React.useState(null)
  const [ renameValue, setRenameValue ] = React.useState('')
  const [ renaming, setRenaming ] = React.useState(false)
  const [ listHeight, setListHeight ] = React.useState(128)
  const virtualListRef = React.useRef(null)
  const virtualMetricsRef = React.useRef(null)
  const [ , setItemOperationsVersion ] = React.useState(0)
  const selectedKeySet = React.useMemo(() => new Set(selectedKeys), [selectedKeys])
  const fileIndexByKey = React.useMemo(() => {
    const indexes = new Map()
    files.forEach((entry, index) => {
      const key = getEntryKey(entry)
      if (!indexes.has(key)) indexes.set(key, index)
    })
    return indexes
  }, [files])
  const [ batchDeleting, setBatchDeleting ] = React.useState(false)
  const [ batchDownloading, setBatchDownloading ] = React.useState(false)
  // 终端工作区打开状态，以及用于并发调用计数的引用。
  const [ terminalOpening, setTerminalOpening ] = React.useState(false)
  const terminalOpeningCountRef = React.useRef(0)
  // 原生拖放目标、上传队列回调和多选锚点均需跨渲染保持稳定引用。
  const fileListDropRef = React.useRef(null)
  const startUploadQueueRef = React.useRef(null)
  const selectionAnchorRef = React.useRef(null)
  const selectionLocationRef = React.useRef(`${ currentConnectionId }\u0000${ currentPath }`)
  const pendingFocusKeyRef = React.useRef(null)
  const navigationKeyRef = React.useRef(null)
  const focusFrameRef = React.useRef(null)
  const focusAttemptsRef = React.useRef(0)
  const filesRef = React.useRef(files)
  const fileIndexByKeyRef = React.useRef(fileIndexByKey)
  const batchStateRef = React.useRef({ batchDeleting, batchDownloading })
  const batchActionLockRef = React.useRef(null)
  const directoryActionLockRef = React.useRef(null)
  const uploadPickingLockRef = React.useRef(null)
  const mountedRef = React.useRef(false)
  const itemLocksRef = React.useRef(null)
  const directoryTargetRef = React.useRef(null)
  if (!batchActionLockRef.current) batchActionLockRef.current = createOperationLock()
  if (!directoryActionLockRef.current) directoryActionLockRef.current = createOperationLock()
  if (!uploadPickingLockRef.current) uploadPickingLockRef.current = createOperationLock()
  if (!itemLocksRef.current) itemLocksRef.current = createKeyedOperationLocks(() => {
    if (mountedRef.current) setItemOperationsVersion(version => version + 1)
  })
  const itemActionRefs = React.useRef({ handleItemClick, handleDeleteItem, handleRenameItem })
  const uploadModalOpenRef = React.useRef(uploadModalOpen)
  const uploadSubmittingRef = React.useRef(uploadSubmitting)
  const uploadDropProcessingRef = React.useRef(uploadDropProcessing)
  const uploadSessionRef = React.useRef(0)
  const uploadViewRef = React.useRef(null)
  const uploadModalTargetRef = React.useRef(null)
  const uploadRecord = sftpManager.getConnectionInfo(currentConnectionId)
  uploadViewRef.current = {
    connectionId: currentConnectionId,
    path: currentPath,
    files,
    connection: { record: uploadRecord, generation: uploadRecord?.generation }
  }
  filesRef.current = files
  fileIndexByKeyRef.current = fileIndexByKey
  batchStateRef.current = { batchDeleting, batchDownloading }
  itemActionRefs.current = { handleItemClick, handleDeleteItem, handleRenameItem }
  uploadModalOpenRef.current = uploadModalOpen
  uploadSubmittingRef.current = uploadSubmitting
  uploadDropProcessingRef.current = uploadDropProcessing
  // 使用 antd 官方 List 虚拟列表方案，滚动容器高度跟随工作区布局。
  React.useLayoutEffect(() => {
    const shell = fileListDropRef.current
    if (!shell) return undefined
    const observer = new window.ResizeObserver(() => setListHeight(Math.max(1, shell.clientHeight)))
    observer.observe(shell)
    setListHeight(Math.max(1, shell.clientHeight))
    return () => observer.disconnect()
  }, [])

  const focusPendingRow = React.useCallback(function restorePendingFocus() {
    const key = pendingFocusKeyRef.current
    if (!key) return
    const index = fileIndexByKeyRef.current.get(key)
    if (index === undefined) return
    const row = fileListDropRef.current?.querySelector(`[data-index="${ index }"] .file-item-row`)
    if (row) {
      const bounds = fileListDropRef.current.getBoundingClientRect()
      const rowBounds = row.getBoundingClientRect()
      const offset = rowBounds.top < bounds.top
        ? rowBounds.top - bounds.top
        : Math.max(0, rowBounds.bottom - bounds.bottom)
      if (offset) virtualListRef.current?.scrollTo(virtualListRef.current.getScrollInfo().y + offset)
      pendingFocusKeyRef.current = null
      row.focus({ preventScroll: true })
    } else if (focusAttemptsRef.current < 32) {
      // Home/End 首次定位使用估算行高；新行测量后继续修正，不能停在目标行之前。
      const metrics = virtualMetricsRef.current?.(key)
      const list = virtualListRef.current
      const shell = fileListDropRef.current
      if (!metrics || !list || !shell) return
      const top = list.getScrollInfo().y
      if (metrics.top < top) list.scrollTo(metrics.top)
      else if (metrics.bottom > top + shell.clientHeight) list.scrollTo(metrics.bottom - shell.clientHeight)
      focusAttemptsRef.current += 1
      focusFrameRef.current = window.requestAnimationFrame(restorePendingFocus)
    }
  }, [])

  const schedulePendingFocus = React.useCallback(() => {
    window.cancelAnimationFrame(focusFrameRef.current)
    focusFrameRef.current = window.requestAnimationFrame(focusPendingRow)
  }, [focusPendingRow])

  const captureVirtualMetrics = React.useCallback(({ getSize }) => {
    virtualMetricsRef.current = getSize
    return null
  }, [])

  React.useEffect(() => () => window.cancelAnimationFrame(focusFrameRef.current), [])

  React.useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  // 当前目录或文件列表变化后，移除已经不存在的选中项并校正 Shift 选择锚点。
  React.useEffect(() => {
    const location = `${ currentConnectionId }\u0000${ currentPath }`
    if (selectionLocationRef.current !== location) {
      selectionLocationRef.current = location
      selectionAnchorRef.current = null
      navigationKeyRef.current = null
      pendingFocusKeyRef.current = null
      setRenameTarget(null)
      setSelectedKeys([])
      return
    }
    setSelectedKeys(previous => {
      const next = previous.filter(key => fileIndexByKey.has(key))
      return next.length === previous.length ? previous : next
    })
    if (selectionAnchorRef.current && !fileIndexByKey.has(selectionAnchorRef.current)) {
      selectionAnchorRef.current = null
    }
  }, [ currentConnectionId, currentPath, fileIndexByKey ])

  /**
   * 处理单选、Command/Ctrl 多选和 Shift 范围选择，并维护键盘操作锚点。
   *
   * @param {Object} entry - 被选择的远程条目。
   * @param {{shiftKey: boolean, ctrlKey: boolean, metaKey: boolean}} event - 选择触发事件。
   * @returns {void}
   */
  const handleItemSelect = React.useCallback((entry, event) => {
    const currentFiles = filesRef.current
    const { batchDeleting: isBatchDeleting, batchDownloading: isBatchDownloading } = batchStateRef.current
    if (isBatchDeleting || isBatchDownloading) return
    const key = getEntryKey(entry)
    if (!key) return
    if (event.type === 'click') {
      navigationKeyRef.current = key
      pendingFocusKeyRef.current = null
    }
    const currentIndex = fileIndexByKeyRef.current.get(key) ?? -1
    const anchorIndex = fileIndexByKeyRef.current.get(selectionAnchorRef.current) ?? -1
    const rangeSelection = event.shiftKey && anchorIndex >= 0 && currentIndex >= 0
      ? currentFiles
        .slice(Math.min(anchorIndex, currentIndex), Math.max(anchorIndex, currentIndex) + 1)
        .map(getEntryKey)
      : null
    const togglesSelection = event.ctrlKey || event.metaKey

    if (rangeSelection) {
      setSelectedKeys(previous => togglesSelection
        ? [...new Set([ ...previous, ...rangeSelection ])]
        : rangeSelection)
    } else if (togglesSelection) {
      setSelectedKeys(previous => previous.includes(key)
        ? previous.filter(itemKey => itemKey !== key)
        : [ ...previous, key ])
    } else {
      setSelectedKeys([key])
    }
    if (!rangeSelection) selectionAnchorRef.current = key
  }, [])

  const handleItemKeyDown = React.useCallback((entry, event) => {
    const currentFiles = filesRef.current
    // DOM 焦点可能仍位于前一行；逻辑游标不能随虚拟行挂载或测量而倒退。
    const index = fileIndexByKeyRef.current.get(navigationKeyRef.current)
      ?? fileIndexByKeyRef.current.get(getEntryKey(entry))
    if (index === undefined) return
    const nextIndex = getKeyboardFileIndex(event.key, index, currentFiles.length)
    if (nextIndex === null) {
      navigationKeyRef.current = null
      return
    }
    event.preventDefault()
    if (nextIndex === index) return
    const nextEntry = currentFiles[nextIndex]
    const nextKey = getEntryKey(nextEntry)
    navigationKeyRef.current = nextKey
    if (event.shiftKey && !selectionAnchorRef.current) selectionAnchorRef.current = getEntryKey(entry)
    if (event.shiftKey || (!event.metaKey && !event.ctrlKey)) handleItemSelect(nextEntry, event)
    pendingFocusKeyRef.current = nextKey
    focusAttemptsRef.current = 0
    // 行测量和挂载期间由稳定容器接收连按，下一帧再聚焦行，不能在列表 layout effect 内更新焦点状态。
    const shell = fileListDropRef.current
    shell?.focus({ preventScroll: true })
    const metrics = virtualMetricsRef.current?.(nextKey)
    const list = virtualListRef.current
    if (metrics && list && shell) {
      const top = list.getScrollInfo().y
      // 使用组件提供的行高缓存和数值滚动接口，避免快速连按触发索引滚动的同步重测循环。
      if (metrics.top < top) list.scrollTo(metrics.top)
      else if (metrics.bottom > top + shell.clientHeight) list.scrollTo(metrics.bottom - shell.clientHeight)
    }
    schedulePendingFocus()
  }, [ handleItemSelect, schedulePendingFocus ])
  // 重命名弹窗由列表持有，虚拟行滚出视口后不会丢失输入或连接快照。
  const requestRename = React.useCallback(entry => {
    try {
      const target = { connectionId: currentConnectionId, path: currentPath, connection: sftpManager.captureConnection(currentConnectionId), entry }
      setRenameValue(entry.name)
      setRenameTarget(target)
    } catch (error) {
      void notification.error('重命名失败', normalizeError(error))
    }
  }, [ currentConnectionId, currentPath ])

  const acquireItemOperation = React.useCallback((entry, action) => (
    itemLocksRef.current.acquire(`${ currentConnectionId }\u0000${ getEntryKey(entry) }`, action)
  ), [currentConnectionId])

  const handleItemActivate = React.useCallback((entry) => {
    return itemActionRefs.current.handleItemClick(entry)
  }, [])

  const handleItemDelete = React.useCallback((entry) => {
    return itemActionRefs.current.handleDeleteItem(entry)
  }, [])

  const submitRename = async () => {
    const name = renameValue.trim()
    if (!renameTarget || !name || /[\\/\0]/.test(name) || name === '.' || name === '..') return
    const { entry, connectionId, connection } = renameTarget
    const release = itemLocksRef.current.acquire(`${ connectionId }\u0000${ getEntryKey(entry) }`, 'rename')
    if (!release) return
    if (!sftpManager.isCurrentConnection(connectionId, connection)) {
      release()
      void notification.error('重命名失败', '连接已更改，请重新打开重命名窗口')
      return
    }
    setRenaming(true)
    try {
      await itemActionRefs.current.handleRenameItem(entry, name, renameTarget)
      if (mountedRef.current) setRenameTarget(null)
    } catch (error) {
      if (mountedRef.current) void notification.error('重命名失败', normalizeError(error))
    } finally {
      if (mountedRef.current) setRenaming(false)
      release()
    }
  }

  /**
   * 批量删除当前选中项目，具体进度通过窗口标题展示。
   *
   * @returns {Promise<void>} 删除回调和选中状态清理完成后的 Promise。
   */
  const handleBatchDelete = async () => {
    if (batchDeleting || batchDownloading || selectedKeys.length < 2 || !handleDeleteItems) return
    const selectedEntries = files.filter(entry => selectedKeySet.has(getEntryKey(entry)))
    if (selectedEntries.length < 2) return
    const release = batchActionLockRef.current.acquire()
    if (!release) return
    batchStateRef.current = { batchDeleting: true, batchDownloading: false }
    setBatchDeleting(true)
    try {
      await handleDeleteItems(selectedEntries, () => {
        selectionAnchorRef.current = null
        setSelectedKeys([])
      })
    } catch (error) {
      void notification.error(`批量删除失败：${ normalizeError(error) }`)
    } finally {
      batchStateRef.current = { batchDeleting: false, batchDownloading: false }
      setBatchDeleting(false)
      release()
    }
  }

  // 将稳定键还原为当前目录条目，批量操作只处理仍存在的可见项目。
  const selectedEntries = React.useMemo(
    () => files.filter(entry => selectedKeySet.has(getEntryKey(entry))),
    [ files, selectedKeySet ]
  )

  /**
   * 打开当前连接的终端工作区；没有标签宿主时兼容旧版独立窗口。
   *
   * @returns {Promise<void>} 窗口创建流程完成后的 Promise；错误通过通知展示。
   */
  const handleOpenTerminal = async () => {
    if (!currentConnectionId || !currentConnection) return
    terminalOpeningCountRef.current += 1
    setTerminalOpening(true)
    try {
      const connection = { ...currentConnection, id: currentConnectionId }
      if (onOpenTerminal) {
        await onOpenTerminal(connection)
      } else {
        await openTerminalWindow(connection)
      }
    } catch (openError) {
      void notification.error(`打开终端失败：${ openError?.message || '未知错误' }`)
    } finally {
      terminalOpeningCountRef.current = Math.max(0, terminalOpeningCountRef.current - 1)
      if (terminalOpeningCountRef.current === 0) setTerminalOpening(false)
    }
  }

  /**
   * 统一确认并启动选中项目的批量下载。
   *
   * @returns {Promise<void>} 下载回调和选中状态清理完成后的 Promise。
   */
  const handleBatchDownload = async () => {
    if (batchDeleting || batchDownloading || selectedEntries.length < 2 || !handleDownloadItems) return
    const release = batchActionLockRef.current.acquire()
    if (!release) return
    batchStateRef.current = { batchDeleting: false, batchDownloading: true }
    setBatchDownloading(true)
    try {
      await handleDownloadItems(selectedEntries, () => {
        selectionAnchorRef.current = null
        setSelectedKeys([])
      })
    } catch (error) {
      void notification.error(`批量下载失败：${ normalizeError(error) }`)
    } finally {
      batchStateRef.current = { batchDeleting: false, batchDownloading: false }
      setBatchDownloading(false)
      release()
    }
  }

  /**
   * 校验目录名称并创建远程目录。
   *
   * @returns {Promise<void>} 创建目录及弹窗状态更新完成后的 Promise。
   */
  const submitDirectory = async () => {
    const name = directoryName.trim()
    if (!name || /[\\/]/.test(name) || name === '.' || name === '..') return
    const release = directoryActionLockRef.current.acquire()
    if (!release) return
    const target = directoryTargetRef.current
    if (!sftpManager.isCurrentConnection(target?.connectionId, target?.connection)) {
      release()
      void notification.error('创建目录失败', '连接已更改，请重新打开新建目录窗口')
      return
    }
    setDirectorySubmitting(true)
    try {
      await handleCreateDirectory(name, target)
      if (!sftpManager.isCurrentConnection(target.connectionId, target.connection)) return
      setDirectoryModalOpen(false)
      setDirectoryName('')
    } catch (error) {
      notification.error('创建目录失败', error.message || error.toString() || '未知错误')
    } finally {
      setDirectorySubmitting(false)
      release()
    }
  }
  /**
   * 打开上传队列弹窗，并清空上次尚未提交的选择。
   *
   * @returns {void}
   */
  const handleUpload = () => {
    if (uploadSubmittingRef.current || uploadModalOpenRef.current) return
    const target = uploadViewRef.current
    if (!sftpManager.isCurrentConnection(target?.connectionId, target?.connection)) return
    uploadModalTargetRef.current = target
    uploadSessionRef.current += 1
    setUploadItems([])
    setUploadPicking(null)
    uploadModalOpenRef.current = true
    setUploadModalOpen(true)
  }

  /**
   * 从原生选择器追加文件或文件夹，并在列表中按路径去重。
   *
   * @param {'file'|'directory'} kind - 要选择的本地项目类型。
   * @returns {Promise<void>} 选择器关闭并更新上传队列后的 Promise。
   */
  const addUploadItems = async (kind) => {
    if (uploadPicking || uploadSubmittingRef.current || !uploadModalOpenRef.current) return
    const release = uploadPickingLockRef.current.acquire()
    if (!release) return
    const sessionId = uploadSessionRef.current
    const target = uploadModalTargetRef.current
    setUploadPicking(kind)
    try {
      if (!sftpManager.isCurrentConnection(target?.connectionId, target?.connection)) return
      const result = await dialog.open({
        title: kind === 'directory' ? '选择要上传的文件夹' : '选择要上传的文件',
        multiple: true,
        directory: kind === 'directory',
        recursive: kind === 'directory'
      })
      if (!sftpManager.isCurrentConnection(target.connectionId, target.connection) || !isUploadSessionActive(sessionId, {
        sessionId: uploadSessionRef.current,
        modalOpen: uploadModalOpenRef.current,
        submitting: uploadSubmittingRef.current
      })) return
      const items = normalizeSelectedPaths(result)
        .map(localPath => ({
          localPath,
          fileName: localPathName(localPath),
          kind
        }))
        .filter(item => item.fileName)
      setUploadItems(previous => isUploadSessionActive(sessionId, {
        sessionId: uploadSessionRef.current,
        modalOpen: uploadModalOpenRef.current,
        submitting: uploadSubmittingRef.current
      }) ? mergeUploadItems(previous, items) : previous)
    } catch (error) {
      if (sessionId !== uploadSessionRef.current || !uploadModalOpenRef.current
        || !sftpManager.isCurrentConnection(target?.connectionId, target?.connection)) return
      notification.error(
        kind === 'directory' ? '添加文件夹失败' : '添加文件失败',
        error.message || error.toString() || '未知错误'
      )
    } finally {
      if (sessionId === uploadSessionRef.current) setUploadPicking(null)
      release()
    }
  }

  /**
   * 处理系统拖放路径，过滤符号链接和不支持的项目类型后加入上传队列。
   *
   * @param {string[]} paths - Tauri 原生拖放事件提供的本地路径。
   * @returns {Promise<void>} 路径检查和上传队列更新完成后的 Promise。
   */
  const handleDroppedPaths = React.useCallback(async (paths) => {
    if (uploadSubmittingRef.current || uploadDropProcessingRef.current || !paths?.length) return
    const appendToQueue = uploadModalOpenRef.current
    const sessionId = uploadSessionRef.current
    const target = appendToQueue ? uploadModalTargetRef.current : uploadViewRef.current
    const dropOrigin = { appendToQueue, sessionId }
    uploadDropProcessingRef.current = true
    setUploadDropProcessing(true)
    try {
      const entries = await invoke('inspect_local_paths', { paths })
      if (!sftpManager.isCurrentConnection(target?.connectionId, target?.connection)) return
      const items = (Array.isArray(entries) ? entries : [])
        .map(entry => ({
          localPath: entry.path,
          fileName: localPathName(entry.path),
          kind: entry.isDirectory ? 'directory' : 'file'
        }))
        .filter(item => item.fileName && typeof item.localPath === 'string')
      const action = getUploadDropResultAction(
        dropOrigin,
        {
          modalOpen: uploadModalOpenRef.current,
          sessionId: uploadSessionRef.current,
          submitting: uploadSubmittingRef.current
        }
      )
      if (items.length > 0 && action === 'append') {
        const targetSessionId = uploadSessionRef.current
        setUploadItems(previous => isUploadSessionActive(targetSessionId, {
          sessionId: uploadSessionRef.current,
          modalOpen: uploadModalOpenRef.current,
          submitting: uploadSubmittingRef.current
        }) ? mergeUploadItems(previous, items) : previous)
      } else if (items.length > 0 && action === 'upload'
        && sftpManager.isCurrentConnection(target.connectionId, target.connection)) {
        await startUploadQueueRef.current?.(items, true, target)
      }
    } catch (error) {
      const action = getUploadDropResultAction(dropOrigin, {
        modalOpen: uploadModalOpenRef.current,
        sessionId: uploadSessionRef.current,
        submitting: uploadSubmittingRef.current
      })
      if (action === 'ignore') return
      notification.error('添加拖拽内容失败', error.message || error.toString() || '无法读取拖拽路径')
    } finally {
      uploadDropProcessingRef.current = false
      setUploadDropProcessing(false)
    }
  }, [])

  // 注册 Tauri 原生拖放事件；清理阶段撤销监听并恢复悬停状态。
  React.useEffect(() => {
    let disposed = false
    let unlisten
    /**
     * 注册当前 WebView 的原生拖放监听，并把文件路径交给上传队列处理。
     *
     * @returns {Promise<void>} 监听注册流程完成后的 Promise。
     */
    const registerDragDrop = async () => {
      try {
        const dispose = await getCurrentWebview().onDragDropEvent(event => {
          if (disposed) return
          const payload = event.payload
          if (payload.type === 'enter' || payload.type === 'over') {
            if (uploadModalOpenRef.current) {
              setUploadDragActive(true)
              setDirectoryDropActive(false)
            } else {
              setUploadDragActive(false)
              setDirectoryDropActive(isPositionInsideElement(payload.position, fileListDropRef.current))
            }
          } else if (payload.type === 'leave') {
            setUploadDragActive(false)
            setDirectoryDropActive(false)
          } else if (payload.type === 'drop') {
            setUploadDragActive(false)
            const isDirectoryDrop = isPositionInsideElement(payload.position, fileListDropRef.current)
            setDirectoryDropActive(false)
            if (!uploadModalOpenRef.current && !isDirectoryDrop) return
            void handleDroppedPaths(payload.paths)
          }
        })
        if (disposed) {
          dispose()
        } else {
          unlisten = dispose
        }
      } catch {
        // 浏览器预览不会提供 Tauri 原生文件拖放事件。
      }
    }
    void registerDragDrop()

    return () => {
      disposed = true
      unlisten?.()
      setUploadDragActive(false)
      setDirectoryDropActive(false)
    }
  }, [handleDroppedPaths])

  /**
   * 将上传队列提交为一个原生批次，只对冲突项询问覆盖并重试。
   *
   * @param {Array<{localPath: string, fileName: string, kind: 'file'|'directory'}>} uploadQueue - 要提交的本地项目队列。
   * @param {boolean} [fromDrop=false] - 是否由已完成路径检查的直接拖放启动。
   * @param {Object} [uploadTarget=uploadModalTargetRef.current] - 整个队列共用的目录、条目和原始会话。
   * @returns {Promise<void>} 批次处理、目录刷新和状态清理完成后的 Promise。
   */
  const startUploadQueue = async (uploadQueue, fromDrop = false, uploadTarget = uploadModalTargetRef.current) => {
    if (
      uploadSubmittingRef.current
      || (!fromDrop && (uploadPicking !== null || uploadPickingLockRef.current.locked))
      || uploadQueue.length === 0
      || (uploadDropProcessingRef.current && !fromDrop)
      || !sftpManager.isCurrentConnection(uploadTarget?.connectionId, uploadTarget?.connection)
    ) return
    const duplicateNames = uploadQueue
      .map(item => item.fileName)
      .filter((name, index, names) => names.indexOf(name) !== index)
    if (duplicateNames.length > 0) {
      notification.error(
        '无法开始上传',
        `选择的文件和文件夹存在同名项目：${ [...new Set(duplicateNames)].join('、') }`
      )
      return
    }

    uploadSessionRef.current += 1
    uploadSubmittingRef.current = true
    uploadModalOpenRef.current = false
    setUploadSubmitting(true)
    setUploadModalOpen(false)
    const isCurrent = () => sftpManager.isCurrentConnection(uploadTarget.connectionId, uploadTarget.connection)
    const progressIds = createProgressIds('upload')
    const items = uploadQueue.map(item => ({
      ...item,
      remotePath: joinRemotePath(uploadTarget.path, item.fileName),
      isDirectory: item.kind === 'directory'
    }))
    const invalid = items.filter(item => {
      const existing = uploadTarget.files.find(entry => entry.name === item.fileName)
      return existing && Boolean(existing.isDirectory) !== item.isDirectory
    })
    const initialOutcomes = {
      failed: invalid.map(job => ({
        job,
        error: { code: 'TargetTypeMismatch', message: '远程目录中已存在类型不同的同名项目' }
      }))
    }
    const validItems = items.filter(item => !invalid.includes(item))
    let workflow
    const publishProgress = (progress, payload = {}) => {
      const fileIndex = Number(payload.fileIndex)
      const fileTotal = Number(payload.fileTotal)
      PubSubBusinessKeyEnum.SEND_MASK({
        ...progressIds,
        progress: Math.round(Number(progress) || 0),
        fileName: payload.fileName || `${ uploadQueue.length } 个项目`,
        operation: 'upload',
        queueIndex: Number.isFinite(Number(payload.queueIndex)) ? Number(payload.queueIndex) : 0,
        queueTotal: uploadQueue.length,
        pendingCount: Number.isFinite(Number(payload.pendingCount)) ? Number(payload.pendingCount) : undefined,
        folderQueueIndex: Number.isFinite(fileIndex) ? fileIndex : undefined,
        folderQueueTotal: Number.isFinite(fileTotal) ? fileTotal : undefined,
        overallProgress: Number.isFinite(Number(payload.overallProgress)) ? Number(payload.overallProgress) : undefined,
        current: payload.current,
        total: payload.total,
        completedBytes: payload.completedBytes,
        totalBytes: payload.totalBytes,
        onCancel: workflow ? () => workflow.cancel() : undefined
      })
    }
    workflow = createNativeBatchWorkflow({
      isCurrent,
      cancelTransfer: id => sftpManager.cancelTransfer(id),
      onProgress: publishProgress,
      transfer: (batch, context, overwrite) => sftpManager.transferBatch(
        uploadTarget.connectionId,
        batch.map(({ localPath, remotePath, isDirectory }) => ({ localPath, remotePath, isDirectory })),
        {
          direction: 'upload',
          connection: uploadTarget.connection,
          shouldStart: context.isCurrent,
          overwrite,
          onProgress: context.reportProgress,
          onTransferId: id => {
            context.registerTransferId(id)
            if (context.isCurrent()) publishProgress(0)
          }
        }
      ),
      confirmOverwrite: item => confirm(
        item.isDirectory
          ? `远程目录中已存在文件夹“${ item.remotePath }”，是否合并并覆盖其中的同名文件？`
          : `远程目录中已存在“${ item.remotePath }”，是否覆盖？`,
        {
          title: '确认覆盖',
          kind: 'warning',
          okLabel: item.isDirectory ? '合并并覆盖' : '覆盖',
          cancelLabel: '跳过'
        }
      )
    })

    try {
      publishProgress(0)
      const result = await workflow.run(validItems, initialOutcomes)
      if (!isCurrent()) return
      const { succeeded, failed, skipped, notStarted, unknown, unlistedSkipped, directoryCount } = result
      const names = failed.map(outcome => outcome.item?.remotePath || outcome.job.fileName).join('、')
      const skippedCount = skipped.length + unlistedSkipped
      const summary = `已上传 ${ succeeded.length } 个文件${ directoryCount ? `、${ directoryCount } 个目录` : '' }${ skippedCount ? `，跳过 ${ skippedCount } 个` : '' }${ failed.length ? `，${ failed.length } 个失败` : '' }${ notStarted.length ? `，${ notStarted.length } 个未开始` : '' }${ unknown.length ? `，${ unknown.length } 个结果待核对` : '' }${ names ? `：${ names }` : '' }`
      if (failed.length || unknown.length || notStarted.length || result.cancelled) notification.error(result.cancelled ? '上传已取消' : '上传未全部完成', summary)
      else notification.success('上传完成', summary)
    } catch (error) {
      if (isCurrent()) notification.error('上传文件失败', normalizeError(error))
    } finally {
      PubSubBusinessKeyEnum.SEND_MASK({ ...progressIds, event: PROGRESS_EVENT_END })
      try {
        if (isCurrent()) {
          await handleRefresh(uploadTarget)
        }
      } catch (error) {
        if (isCurrent()) notification.error('刷新目录失败', normalizeError(error))
      } finally {
        uploadSubmittingRef.current = false
        setUploadSubmitting(false)
        setUploadItems([])
      }
    }
  }

  startUploadQueueRef.current = startUploadQueue

  const menuItems = [
    ...(drives?.length ? [] : [{
      key: 'root',
      label: '根目录 /',
      onClick: () => handleDriveSelect('/')
    }]),
    {
      key: 'home',
      label: homeDir || '用户目录',
      onClick: () => handleDriveSelect(homeDir)
    },
    ...(drives && drives.length > 0 ? [{
      key: 'divider',
      type: 'divider'
    }] : []),
    ...(drives && drives.length > 0 ? drives.map((drive, index) => ({
      key: `drive-${ index }`,
      label: drive,
      onClick: () => handleDriveSelect(drive)
    })) : [])
  ]

  const renderFileItem = React.useCallback(entry => (
    <FileItem
      entry={entry}
      currentPath={currentPath}
      connectionId={currentConnectionId}
      showHiddenFiles={showHiddenFiles}
      selected={selectedKeySet.has(getEntryKey(entry))}
      downloading={itemLocksRef.current.isLocked(`${ currentConnectionId }\u0000${ getEntryKey(entry) }`, 'download')}
      deleting={itemLocksRef.current.isLocked(`${ currentConnectionId }\u0000${ getEntryKey(entry) }`, 'delete')}
      acquireOperation={acquireItemOperation}
      onSelect={handleItemSelect}
      onNavigate={handleItemKeyDown}
      onActivate={handleItemActivate}
      onDelete={handleItemDelete}
      onRequestRename={requestRename}
    />
  ), [ currentPath, currentConnectionId, showHiddenFiles, selectedKeySet, handleItemSelect, handleItemKeyDown, acquireItemOperation, handleItemActivate, handleItemDelete, requestRename ])

  return (
    <div className="file-browser">
      <div className="file-workspace-header">
        {showConnectionSummary && (
          <div className="connection-toolbar">
            <div
              className="connection-summary"
              title={`${ currentConnection?.name || '未知' } (${ currentConnection?.host || '未知' }:${ currentConnection?.port || '未知' })`}
            >
              <span className="connection-status-dot" aria-hidden="true" />
              <span className="connection-name">{currentConnection?.name || '未知'}</span>
              <span className="connection-endpoint">
                {currentConnection?.host || '未知'}:{currentConnection?.port || '未知'}
              </span>
            </div>
          </div>
        )}

        <div className="path-toolbar">
          <Tooltip title="返回上级目录">
            <Button
              className="toolbar-icon-button"
              size="small"
              onClick={handleGoBack}
              icon={<AppIcon name="chevronUp" />}
              aria-label="返回上级目录"
            />
          </Tooltip>

          <div className="remote-path-bar">
            <AppIcon name="folderOpen" className="remote-path-icon" />
            <Input
              className="remote-path-input"
              variant="borderless"
              value={pathInput}
              onChange={handlePathChange}
              onPressEnter={handlePathSubmit}
              onKeyDown={event => {
                if (event.key !== 'Escape') return
                event.preventDefault()
                handlePathCancel?.()
                event.currentTarget.blur()
              }}
              aria-label="远程路径"
            />

            <Dropdown
              menu={{ items: menuItems }}
              trigger={['click']}
            >
              <Button
                className="path-menu-button"
                type="text"
                size="small"
                icon={<AppIcon name="chevronDown" />}
                aria-label="快速定位目录"
              />
            </Dropdown>
          </div>

          <Tooltip title="刷新目录">
            <Button
              className="toolbar-icon-button"
              size="small"
              onClick={handleRefresh}
              icon={<AppIcon name="reload" />}
              aria-label="刷新目录"
            />
          </Tooltip>
          <div className="file-action-toolbar" role="toolbar" aria-label="远程文件操作">
            <TransferCancelButton />
            <Button
              className="upload-action-button"
              type="primary"
              size="small"
              icon={<AppIcon name="upload" />}
              loading={uploadSubmitting}
              onClick={handleUpload}
              aria-label="上传文件"
              title="上传文件"
            >
              <span>上传</span>
            </Button>
            <Button
              className="mkdir-action-button"
              size="small"
              icon={<AppIcon name="folderAdd" />}
              onClick={() => {
                const target = uploadViewRef.current
                if (!sftpManager.isCurrentConnection(target?.connectionId, target?.connection)) return
                directoryTargetRef.current = target
                setDirectoryModalOpen(true)
              }}
              aria-label="新建文件夹"
              title="新建文件夹"
            >
              <span>新建目录</span>
            </Button>
            {showTerminalAction && (
              <Tooltip title="打开远程终端">
                <Button
                  className="file-terminal-action"
                  size="small"
                  icon={<AppIcon name="terminal" />}
                  loading={terminalOpening}
                  onClick={handleOpenTerminal}
                  aria-label="打开远程终端"
                />
              </Tooltip>
            )}
            {showDisconnectAction && (
              <Tooltip title="断开连接">
                <Button
                  className="file-disconnect-action"
                  size="small"
                  danger
                  icon={<AppIcon name="disconnect" />}
                  onClick={() => handleDisconnect()}
                  aria-label="断开连接"
                />
              </Tooltip>
            )}
          </div>
        </div>
      </div>

      <div
        ref={fileListDropRef}
        className={`file-list-shell${ directoryDropActive ? ' is-upload-drop-target' : '' }`}
        tabIndex={-1}
        onKeyDown={event => {
          if (event.target !== event.currentTarget) return
          const index = fileIndexByKeyRef.current.get(navigationKeyRef.current)
          if (index !== undefined) handleItemKeyDown(filesRef.current[index], event)
        }}
      >
        {error ? (
          <Alert
            type="error"
            showIcon
            icon={<AppIcon name="warningCircle" />}
            title="目录加载失败"
            description={error}
            className="file-list-alert"
          />
        ) : loading ? (
          <div className="file-list-state">
            <Spin size="small" />
            <span>加载中...</span>
          </div>
        ) : files.length === 0 ? (
          <div className="file-list-state">
            该目录为空
          </div>
        ) : (
          <List className="file-list" split={false}>
            <VirtualList
              ref={virtualListRef}
              data={files}
              height={listHeight}
              itemHeight={42}
              itemKey={getEntryKey}
              onVisibleChange={schedulePendingFocus}
              extraRender={captureVirtualMetrics}
            >
              {(entry, index) => <div data-index={index}>{renderFileItem(entry)}</div>}
            </VirtualList>
          </List>
        )}
      </div>
      {selectedKeys.length > 1 && (
        <div className="selection-action-bar" role="toolbar" aria-label="批量操作">
          <span className="selection-count">已选择 {selectedKeys.length} 项</span>
          <Tooltip title="批量下载选中的文件和文件夹">
            <span>
              <Button
                size="small"
                icon={<AppIcon name="download" />}
                loading={batchDownloading}
                disabled={batchDeleting || batchDownloading}
                onClick={event => {
                  event.stopPropagation()
                  void handleBatchDownload()
                }}
              >
                批量下载
              </Button>
            </span>
          </Tooltip>
          <Button
            danger
            size="small"
            icon={<AppIcon name="trash" />}
            loading={batchDeleting}
            disabled={batchDownloading}
            onClick={event => {
              event.stopPropagation()
              void handleBatchDelete()
            }}
          >
            批量删除
          </Button>
        </div>
      )}
      <Modal
        rootClassName="compact-modal upload-modal"
        title="选择上传内容"
        open={uploadModalOpen}
        centered
        onCancel={() => {
          uploadSessionRef.current += 1
          uploadModalOpenRef.current = false
          uploadModalTargetRef.current = null
          setUploadPicking(null)
          setUploadModalOpen(false)
        }}
        onOk={() => void startUploadQueue([...uploadItems])}
        okText="开始上传"
        cancelText="取消"
        okButtonProps={{ disabled: uploadItems.length === 0 || uploadDropProcessing || uploadPicking !== null }}
        width="min(520px, calc(100vw - 24px))"
        destroyOnHidden
      >
        <Space className="upload-picker-actions" size={6}>
          <Button
            icon={<AppIcon name="file" />}
            loading={uploadPicking === 'file'}
            onClick={() => void addUploadItems('file')}
          >
            添加文件
          </Button>
          <Button
            icon={<AppIcon name="folder" />}
            loading={uploadPicking === 'directory'}
            onClick={() => void addUploadItems('directory')}
          >
            添加文件夹
          </Button>
        </Space>
        <Upload.Dragger
          className={`upload-drop-zone${ uploadDragActive ? ' is-dragging' : '' }`}
          openFileDialogOnClick={false}
          showUploadList={false}
          multiple
          beforeUpload={() => false}
          onDrop={event => event.preventDefault()}
        >
          {uploadItems.length === 0 ? (
            <div className="upload-drop-content">
              <AppIcon name="inbox" className="upload-drop-icon" />
              <span>{uploadDropProcessing ? '正在读取拖拽内容...' : '拖拽文件或文件夹到这里'}</span>
              <small className="upload-drop-empty">尚未选择上传内容</small>
              <small>也可以使用上方按钮选择</small>
            </div>
          ) : (
            <>
              <div className="upload-drop-hint">
                <AppIcon name="inbox" className="upload-drop-hint-icon" />
                <span>{uploadDropProcessing ? '正在读取拖拽内容...' : '继续拖拽内容到此处添加'}</span>
              </div>
              <div className="upload-picker-list">
                <List
                  size="small"
                  dataSource={uploadItems}
                  rowKey={item => item.localPath}
                  renderItem={item => {
                    const fileIcon = item.kind === 'directory'
                      ? { name: 'folder', type: 'directory' }
                      : resolveFileIcon(item.fileName)
                    return (
                      <List.Item
                        actions={[
                          <Tooltip key="remove" title="移除">
                            <Button
                              type="text"
                              danger
                              size="small"
                              icon={<AppIcon name="trash" />}
                              aria-label={`移除 ${ item.fileName }`}
                              onClick={() => setUploadItems(previous => previous.filter(current => current.localPath !== item.localPath))}
                            />
                          </Tooltip>
                        ]}
                      >
                        <List.Item.Meta
                          avatar={<AppIcon
                            name={fileIcon.name}
                            className={`upload-picker-item-icon is-${ fileIcon.type }`}
                          />}
                          title={item.fileName}
                          description={item.localPath}
                        />
                      </List.Item>
                    )
                  }}
                />
              </div>
            </>
          )}
        </Upload.Dragger>
      </Modal>
      <Modal
        rootClassName="compact-modal"
        title={`重命名 ${ renameTarget?.entry.name || '' }`}
        open={Boolean(renameTarget)}
        onCancel={() => { if (!renaming) setRenameTarget(null) }}
        onOk={submitRename}
        okText="保存"
        cancelText="取消"
        confirmLoading={renaming}
        width="min(360px, calc(100vw - 24px))"
        destroyOnHidden
      >
        <Input
          autoFocus
          autoCapitalize="none"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          value={renameValue}
          onChange={event => setRenameValue(event.target.value)}
          onKeyDown={event => event.stopPropagation()}
          onKeyUp={event => event.stopPropagation()}
        />
      </Modal>
      <Modal
        rootClassName="compact-modal"
        title="新建远程文件夹"
        open={directoryModalOpen}
        centered
        onCancel={() => setDirectoryModalOpen(false)}
        onOk={submitDirectory}
        okText="创建"
        cancelText="取消"
        confirmLoading={directorySubmitting}
        width="min(360px, calc(100vw - 24px))"
        destroyOnHidden
      >
        <Input
          autoFocus
          value={directoryName}
          placeholder="文件夹名称"
          onChange={event => setDirectoryName(event.target.value)}
          onKeyDown={event => event.stopPropagation()}
          onKeyUp={event => event.stopPropagation()}
        />
      </Modal>
    </div>
  )
}

export default FileBrowser
