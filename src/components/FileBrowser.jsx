/**
 * 远程文件浏览器视图。
 * 父组件负责连接和目录数据，本组件负责路径工具栏、选择、上传、批量操作和预览交互。
 */
import React from 'react'
import { Alert, Button, Dropdown, Input, List, Modal, Space, Spin, Tooltip, Upload } from 'antd'
import AppIcon from './AppIcon'
import { resolveFileIcon } from '../utils/fileIconUtils.js'
import FileItem from './FileItem'
import { invoke } from '@tauri-apps/api/core'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import * as dialog from '@tauri-apps/plugin-dialog'
import { confirm } from '@tauri-apps/plugin-dialog'
import { PubSubBusinessKeyEnum, SftpConnectionStatus } from '../utils/common'
import { sftpManager } from '../utils/sftpUtils'
import { notification } from '../utils/notificationUtils'
import { openTerminalWindow } from '../utils/terminalWindow.js'

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
 * 将原生拖放坐标换算为 CSS 像素后判断是否落在目标列表区域。
 *
 * @param {{x: number, y: number}|null|undefined} position - Tauri 原生拖放坐标。
 * @param {Element|null} element - 文件列表的目标 DOM 元素。
 * @returns {boolean} 坐标位于目标元素矩形范围内时返回 true。
 */
const isPositionInsideElement = (position, element) => {
  if (!position || !element || typeof window === 'undefined') return false
  const rect = element.getBoundingClientRect()
  const scale = window.devicePixelRatio || 1
  const x = Number(position.x) / scale
  const y = Number(position.y) / scale
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
 * @param {string} props.currentPath - 当前显示的远程目录路径。
 * @param {Array<Object>} props.files - 当前目录的远程条目。
 * @param {boolean} props.loading - 当前目录是否正在加载。
 * @param {string|null} props.error - 目录读取错误信息。
 * @param {Object|null} props.currentConnection - 当前连接的非敏感配置。
 * @param {string|null} props.currentConnectionId - 当前 SSH 连接 ID。
 * @param {boolean} props.showHiddenFiles - 是否显示隐藏项目。
 * @param {string} props.homeDir - 远程用户主目录。
 * @param {string[]} props.drives - 可切换的远程盘符列表。
 * @param {() => void} props.handleGoBack - 返回上级目录回调。
 * @param {(path: string) => void} props.handlePathChange - 路径输入变更回调。
 * @param {(event: Object) => void} props.handlePathSubmit - 路径表单提交回调。
 * @param {() => Promise<void>} props.handleRefresh - 刷新当前目录回调。
 * @param {(entry: Object) => void} props.handleItemClick - 进入目录或打开文件回调。
 * @param {(name: string) => Promise<void>} props.handleCreateDirectory - 创建目录回调。
 * @param {(entry: Object) => Promise<void>} props.handleDeleteItem - 删除单个项目回调。
 * @param {(entries: Object[], onComplete: () => void) => Promise<void>} props.handleDeleteItems - 批量删除回调。
 * @param {(entries: Object[], onComplete: () => void) => Promise<void>} props.handleDownloadItems - 批量下载回调。
 * @param {(entry: Object, name: string) => Promise<void>} props.handleRenameItem - 重命名回调。
 * @param {(path: string) => void} props.handleDriveSelect - 选择远程盘符回调。
 * @param {() => Promise<void>} props.handleDisconnect - 断开当前连接回调。
 * @returns {JSX.Element} 路径工具栏、远程条目、上传对话框和批量操作控件。
 */
const FileBrowser = ({
  currentPath,
  files,
  loading,
  error,
  currentConnection,
  currentConnectionId,
  showHiddenFiles,
  homeDir,
  drives,
  handleGoBack,
  handlePathChange,
  handlePathSubmit,
  handleRefresh,
  handleItemClick,
  handleCreateDirectory,
  handleDeleteItem,
  handleDeleteItems,
  handleDownloadItems,
  handleRenameItem,
  handleDriveSelect,
  handleDisconnect
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
  const [ batchDeleting, setBatchDeleting ] = React.useState(false)
  const [ batchDownloading, setBatchDownloading ] = React.useState(false)
  // 独立终端窗口打开状态，以及用于并发调用计数的引用。
  const [ terminalOpening, setTerminalOpening ] = React.useState(false)
  const terminalOpeningCountRef = React.useRef(0)
  // 原生拖放目标、上传队列回调和多选锚点均需跨渲染保持稳定引用。
  const fileListDropRef = React.useRef(null)
  const startUploadQueueRef = React.useRef(null)
  const selectionAnchorRef = React.useRef(null)
  const selectionPathRef = React.useRef(currentPath)

  // 当前目录或文件列表变化后，移除已经不存在的选中项并校正 Shift 选择锚点。
  React.useEffect(() => {
    if (selectionPathRef.current !== currentPath) {
      selectionPathRef.current = currentPath
      selectionAnchorRef.current = null
      setSelectedKeys([])
      return
    }
    const availableKeys = new Set(files.map(getEntryKey))
    setSelectedKeys(previous => {
      const next = previous.filter(key => availableKeys.has(key))
      return next.length === previous.length ? previous : next
    })
    if (selectionAnchorRef.current && !availableKeys.has(selectionAnchorRef.current)) {
      selectionAnchorRef.current = null
    }
  }, [ currentPath, files ])

  /**
   * 处理单选、Command/Ctrl 多选和 Shift 范围选择，并维护键盘操作锚点。
   *
   * @param {Object} entry - 被选择的远程条目。
   * @param {{shiftKey: boolean, ctrlKey: boolean, metaKey: boolean}} event - 选择触发事件。
   * @returns {void}
   */
  const handleItemSelect = (entry, event) => {
    if (batchDeleting || batchDownloading) return
    const key = getEntryKey(entry)
    if (!key) return
    const currentIndex = files.findIndex(item => getEntryKey(item) === key)
    const anchorIndex = files.findIndex(item => getEntryKey(item) === selectionAnchorRef.current)
    const rangeSelection = event.shiftKey && anchorIndex >= 0 && currentIndex >= 0
      ? files
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
    selectionAnchorRef.current = key
  }

  /**
   * 批量删除当前选中项目，具体进度通过共享状态栏展示。
   *
   * @returns {Promise<void>} 删除回调和选中状态清理完成后的 Promise。
   */
  const handleBatchDelete = async () => {
    if (batchDeleting || batchDownloading || selectedKeys.length < 2 || !handleDeleteItems) return
    const selectedEntries = files.filter(entry => selectedKeys.includes(getEntryKey(entry)))
    if (selectedEntries.length < 2) return
    setBatchDeleting(true)
    try {
      await handleDeleteItems(selectedEntries, () => {
        selectionAnchorRef.current = null
        setSelectedKeys([])
      })
    } finally {
      setBatchDeleting(false)
    }
  }

  // 将稳定键还原为当前目录条目，批量操作只处理仍存在的可见项目。
  const selectedEntries = files.filter(entry => selectedKeys.includes(getEntryKey(entry)))

  /**
   * 打开当前连接的独立终端窗口，避免主窗口布局被 xterm 影响。
   *
   * @returns {Promise<void>} 窗口创建流程完成后的 Promise；错误通过通知展示。
   */
  const handleOpenTerminal = async () => {
    if (!currentConnectionId || !currentConnection) return
    terminalOpeningCountRef.current += 1
    setTerminalOpening(true)
    try {
      await openTerminalWindow({ ...currentConnection, id: currentConnectionId })
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
    setBatchDownloading(true)
    try {
      await handleDownloadItems(selectedEntries, () => {
        selectionAnchorRef.current = null
        setSelectedKeys([])
      })
    } finally {
      setBatchDownloading(false)
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
    setDirectorySubmitting(true)
    try {
      await handleCreateDirectory(name)
      setDirectoryModalOpen(false)
      setDirectoryName('')
    } catch (error) {
      notification.error('创建目录失败', error.message || error.toString() || '未知错误')
    } finally {
      setDirectorySubmitting(false)
    }
  }
  /**
   * 打开上传队列弹窗，并清空上次尚未提交的选择。
   *
   * @returns {void}
   */
  const handleUpload = () => {
    if (uploadSubmitting) return
    setUploadItems([])
    setUploadModalOpen(true)
  }

  /**
   * 从原生选择器追加文件或文件夹，并在列表中按路径去重。
   *
   * @param {'file'|'directory'} kind - 要选择的本地项目类型。
   * @returns {Promise<void>} 选择器关闭并更新上传队列后的 Promise。
   */
  const addUploadItems = async (kind) => {
    if (uploadPicking || uploadSubmitting) return
    setUploadPicking(kind)
    try {
      const result = await dialog.open({
        title: kind === 'directory' ? '选择要上传的文件夹' : '选择要上传的文件',
        multiple: true,
        directory: kind === 'directory',
        recursive: kind === 'directory'
      })
      const items = normalizeSelectedPaths(result)
        .map(localPath => ({
          localPath,
          fileName: localPathName(localPath),
          kind
        }))
        .filter(item => item.fileName)
      setUploadItems(previous => mergeUploadItems(previous, items))
    } catch (error) {
      notification.error(
        kind === 'directory' ? '添加文件夹失败' : '添加文件失败',
        error.message || error.toString() || '未知错误'
      )
    } finally {
      setUploadPicking(null)
    }
  }

  /**
   * 处理系统拖放路径，过滤符号链接和不支持的项目类型后加入上传队列。
   *
   * @param {string[]} paths - Tauri 原生拖放事件提供的本地路径。
   * @returns {Promise<void>} 路径检查和上传队列更新完成后的 Promise。
   */
  const handleDroppedPaths = React.useCallback(async (paths) => {
    if (uploadSubmitting || uploadDropProcessing || !paths?.length) return
    setUploadDropProcessing(true)
    try {
      const entries = await invoke('inspect_local_paths', { paths })
      const items = (Array.isArray(entries) ? entries : [])
        .map(entry => ({
          localPath: entry.path,
          fileName: localPathName(entry.path),
          kind: entry.isDirectory ? 'directory' : 'file'
        }))
        .filter(item => item.fileName && typeof item.localPath === 'string')
      if (items.length > 0 && uploadModalOpen) {
        setUploadItems(previous => mergeUploadItems(previous, items))
      } else if (items.length > 0) {
        await startUploadQueueRef.current?.(items)
      }
    } catch (error) {
      notification.error('添加拖拽内容失败', error.message || error.toString() || '无法读取拖拽路径')
    } finally {
      setUploadDropProcessing(false)
    }
  }, [ uploadDropProcessing, uploadModalOpen, uploadSubmitting ])

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
            if (uploadModalOpen) {
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
            if (!uploadModalOpen && !isDirectoryDrop) return
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
  }, [ handleDroppedPaths, uploadModalOpen ])

  /**
   * 顺序上传队列中的文件或文件夹，保留覆盖确认和取消回调语义。
   *
   * @param {Array<{localPath: string, fileName: string, kind: 'file'|'directory'}>} uploadQueue - 要提交的本地项目队列。
   * @returns {Promise<void>} 队列处理、目录刷新和状态清理完成后的 Promise。
   */
  const startUploadQueue = async (uploadQueue) => {
    if (uploadSubmitting || uploadQueue.length === 0) return
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

    setUploadSubmitting(true)
    setUploadModalOpen(false)
    try {
      for (const [ queueIndex, item ] of uploadQueue.entries()) {
        const { localPath, fileName, kind } = item
        if (sftpManager.getConnectionStatus(currentConnectionId) !== SftpConnectionStatus.CONNECTED) break
        let transferId = null
        let overwrite = false
        const existing = files.find(entry => entry.name === fileName)
        if (existing && ((kind === 'directory' && !existing.isDirectory)
          || (kind === 'file' && existing.isDirectory))) {
          notification.error(
            '上传失败',
            `远程目录中已存在类型不同的同名项目：${ fileName }`
          )
          continue
        }
        if (existing) {
          overwrite = await confirm(
            kind === 'directory'
              ? `远程目录中已存在文件夹“${ fileName }”，是否合并并覆盖其中的同名文件？`
              : `远程目录中已存在“${ fileName }”，是否覆盖？`,
            {
              title: '确认覆盖',
              kind: 'warning',
              okLabel: kind === 'directory' ? '合并并覆盖' : '覆盖',
              cancelLabel: '取消'
            }
          )
          if (!overwrite) continue
        }
        const remotePath = joinRemotePath(currentPath, fileName)
        /**
         * 发布队列及文件夹内部进度，并绑定当前传输的取消动作。
         *
         * @param {number} progress - 当前项目进度百分比。
         * @param {Object} [payload={}] - 目录上传返回的文件级进度信息。
         * @returns {void}
         */
        const publishProgress = (progress, payload = {}) => {
          const fileTotal = Number(payload.fileTotal) || 0
          const fileIndex = Number(payload.fileIndex) || 0
          PubSubBusinessKeyEnum.SEND_MASK({
            progress,
            overallProgress: kind === 'directory' && Number.isFinite(Number(payload.overallProgress))
              ? Number(payload.overallProgress)
              : undefined,
            fileName: payload.fileName || fileName,
            operation: kind === 'directory' ? 'upload-directory' : 'upload',
            queueIndex,
            queueTotal: uploadQueue.length,
            pendingCount: Math.max(uploadQueue.length - queueIndex - 1, 0),
            folderQueueIndex: kind === 'directory' ? fileIndex : undefined,
            folderQueueTotal: kind === 'directory' ? fileTotal : undefined,
            onCancel: transferId ? () => sftpManager.cancelTransfer(transferId) : undefined
          })
        }
        publishProgress(0)
        try {
          if (kind === 'directory') {
            await sftpManager.uploadDirectory(
              currentConnectionId,
              localPath,
              remotePath,
              (progress, payload) => publishProgress(Math.round(progress), payload),
              overwrite,
              id => {
                transferId = id
                publishProgress(0)
              }
            )
            notification.success('上传成功', `文件夹 ${ fileName } 上传成功`)
          } else {
            await sftpManager.uploadFile(
              currentConnectionId,
              localPath,
              remotePath,
              progress => publishProgress(Math.round(progress)),
              overwrite,
              id => {
                transferId = id
                publishProgress(0)
              }
            )
            notification.success('上传成功', `文件 ${ fileName } 上传成功`)
          }
        } catch (error) {
          notification.error(
            '上传失败',
            `${ kind === 'directory' ? '文件夹' : '文件' } ${ fileName } 上传失败：${ error.message || error.toString() || '未知错误' }`
          )
          const errorMessage = error.message || error.toString() || ''
          if (errorMessage.includes('传输已取消')
            || sftpManager.getConnectionStatus(currentConnectionId) !== SftpConnectionStatus.CONNECTED) {
            break
          }
        }
      }
      if (sftpManager.getConnectionStatus(currentConnectionId) === SftpConnectionStatus.CONNECTED) {
        handleRefresh()
      }
    } catch (error) {
      notification.error('上传文件失败', error.message || error.toString() || '未知错误')
    } finally {
      setUploadSubmitting(false)
      setUploadItems([])
      PubSubBusinessKeyEnum.SEND_MASK(null)
    }
  }

  startUploadQueueRef.current = startUploadQueue

  const menuItems = [
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

  return (
    <div className="file-browser">
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

        <div
          className="remote-path-bar"
        >
          <AppIcon name="folderOpen" className="remote-path-icon" />
          <Input
            className="remote-path-input"
            variant="borderless"
            value={currentPath}
            onChange={handlePathChange}
            onPressEnter={handlePathSubmit}
            aria-label="远程路径"
          />

          <Dropdown menu={{ items: menuItems }} trigger={['click']}>
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
      </div>

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
        <div className="connection-actions">
          <Button
            size="small"
            icon={<AppIcon name="terminal" />}
            loading={terminalOpening}
            onClick={handleOpenTerminal}
            aria-label="打开远程终端"
          >
            终端
          </Button>
          <Button size="small" icon={<AppIcon name="upload" />} loading={uploadSubmitting} onClick={handleUpload}>
            上传
          </Button>
          <Button
            size="small"
            icon={<AppIcon name="folderAdd" />}
            onClick={() => setDirectoryModalOpen(true)}
            aria-label="新建文件夹"
          >
            新建文件夹
          </Button>
          <Button
            size="small"
            danger
            icon={<AppIcon name="disconnect" />}
            onClick={() => handleDisconnect()}
          >
            断开连接
          </Button>
        </div>
      </div>

      <div
        ref={fileListDropRef}
        className={`file-list-shell${ directoryDropActive ? ' is-upload-drop-target' : '' }`}
      >
        {error ? (
          <Alert
            type="error"
            showIcon
            icon={<AppIcon name="warningCircle" />}
            message="目录加载失败"
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
          <List
            className="file-list"
            itemLayout="horizontal"
            dataSource={files}
            rowKey={entry => entry.path || entry.name}
            renderItem={entry => (
              <FileItem
                entry={entry}
                currentPath={currentPath}
                connectionId={currentConnectionId}
                showHiddenFiles={showHiddenFiles}
                selected={selectedKeys.includes(getEntryKey(entry))}
                onSelect={event => handleItemSelect(entry, event)}
                onActivate={() => handleItemClick(entry)}
                onDelete={() => handleDeleteItem(entry)}
                onRename={name => handleRenameItem(entry, name)}
              />
            )}
          />
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
        onCancel={() => setUploadModalOpen(false)}
        onOk={() => void startUploadQueue([...uploadItems])}
        okText="开始上传"
        cancelText="取消"
        okButtonProps={{ disabled: uploadItems.length === 0 }}
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
        title="新建远程文件夹"
        open={directoryModalOpen}
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
