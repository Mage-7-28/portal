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

const localPathName = (path) => String(path || '')
  .replace(/[\\/]+$/, '')
  .split(/[\\/]/)
  .pop() || ''

const normalizeSelectedPaths = (result) => {
  const paths = result ? (Array.isArray(result) ? result : [result]) : []
  return [...new Set(paths.filter(path => typeof path === 'string' && path))]
}

const mergeUploadItems = (previous, items) => {
  const existingPaths = new Set(previous.map(item => item.localPath))
  return [
    ...previous,
    ...items.filter(item => !existingPaths.has(item.localPath))
  ]
}

const getEntryKey = (entry) => entry?.path || entry?.name || ''

const isPositionInsideElement = (position, element) => {
  if (!position || !element || typeof window === 'undefined') return false
  const rect = element.getBoundingClientRect()
  const scale = window.devicePixelRatio || 1
  const x = Number(position.x) / scale
  const y = Number(position.y) / scale
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom
}

const joinRemotePath = (basePath, name) => `${ basePath.replace(/\/+$/, '') || '' }/${ name }` || `/${ name }`

const FileBrowser = ({
  currentPath,
  files,
  loading,
  error,
  currentConnection,
  currentConnectionId,
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
  const [ directoryModalOpen, setDirectoryModalOpen ] = React.useState(false)
  const [ directoryName, setDirectoryName ] = React.useState('')
  const [ directorySubmitting, setDirectorySubmitting ] = React.useState(false)
  const [ uploadModalOpen, setUploadModalOpen ] = React.useState(false)
  const [ uploadItems, setUploadItems ] = React.useState([])
  const [ uploadPicking, setUploadPicking ] = React.useState(null)
  const [ uploadSubmitting, setUploadSubmitting ] = React.useState(false)
  const [ uploadDragActive, setUploadDragActive ] = React.useState(false)
  const [ directoryDropActive, setDirectoryDropActive ] = React.useState(false)
  const [ uploadDropProcessing, setUploadDropProcessing ] = React.useState(false)
  const [ selectedKeys, setSelectedKeys ] = React.useState([])
  const [ batchDeleting, setBatchDeleting ] = React.useState(false)
  const [ batchDownloading, setBatchDownloading ] = React.useState(false)
  const fileListDropRef = React.useRef(null)
  const startUploadQueueRef = React.useRef(null)
  const selectionAnchorRef = React.useRef(null)
  const selectionPathRef = React.useRef(currentPath)

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

  const selectedEntries = files.filter(entry => selectedKeys.includes(getEntryKey(entry)))

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
  const handleUpload = () => {
    if (uploadSubmitting) return
    setUploadItems([])
    setUploadModalOpen(true)
  }

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

  React.useEffect(() => {
    let disposed = false
    let unlisten
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
