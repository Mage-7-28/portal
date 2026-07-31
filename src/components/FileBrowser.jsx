import React from 'react'
import { Alert, Button, Dropdown, Input, List, Modal, Spin, Tooltip } from 'antd'
import { DisconnectOutlined, DownOutlined, FolderAddOutlined, FolderOpenOutlined, FolderOutlined, ReloadOutlined, UploadOutlined, UpOutlined } from '@ant-design/icons'
import FileItem from './FileItem'
import * as dialog from '@tauri-apps/plugin-dialog'
import { confirm } from '@tauri-apps/plugin-dialog'
import { PubSubBusinessKeyEnum, SftpConnectionStatus } from '../utils/common'
import { sftpManager } from '../utils/sftpUtils'
import { notification } from '../utils/notificationUtils'

const localPathName = (path) => String(path || '')
  .replace(/[\\/]+$/, '')
  .split(/[\\/]/)
  .pop() || ''

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
  handleRenameItem,
  handleDriveSelect,
  handleDisconnect
}) => {
  const [ directoryModalOpen, setDirectoryModalOpen ] = React.useState(false)
  const [ directoryName, setDirectoryName ] = React.useState('')
  const [ directorySubmitting, setDirectorySubmitting ] = React.useState(false)
  const [ folderUploading, setFolderUploading ] = React.useState(false)

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
  const handleUpload = async () => {
    let uploadQueue = []
    try {
      const result = await dialog.open({
        title: '选择要上传的文件',
        multiple: true,
        directory: false
      })
      const paths = result ? (Array.isArray(result) ? result : [result]) : []
      uploadQueue = paths
        .map(localPath => ({
          localPath,
          fileName: localPathName(localPath)
        }))
        .filter(item => item.fileName)

      for (const [ queueIndex, { localPath, fileName }] of uploadQueue.entries()) {
        if (sftpManager.getConnectionStatus(currentConnectionId) !== SftpConnectionStatus.CONNECTED) break
        let transferId = null
        let overwrite = false
        const publishProgress = progress => {
          PubSubBusinessKeyEnum.SEND_MASK({
            progress,
            fileName,
            operation: 'upload',
            queueIndex,
            queueTotal: uploadQueue.length,
            pendingCount: Math.max(uploadQueue.length - queueIndex - 1, 0),
            onCancel: transferId ? () => sftpManager.cancelTransfer(transferId) : undefined
          })
        }
        if (files.some(entry => entry.name === fileName)) {
          overwrite = await confirm(`远程目录中已存在“${ fileName }”，是否覆盖？`, {
            title: '确认覆盖',
            kind: 'warning',
            okLabel: '覆盖',
            cancelLabel: '取消'
          })
          if (!overwrite) continue
        }
        const remotePath = joinRemotePath(currentPath, fileName)
        publishProgress(0)
        try {
          await sftpManager.uploadFile(currentConnectionId, localPath, remotePath, progress => {
            publishProgress(Math.round(progress))
          }, overwrite, id => {
            transferId = id
            publishProgress(0)
          })
          notification.success('上传成功', `文件 ${ fileName } 上传成功`)
        } catch (error) {
          notification.error('上传失败', `文件 ${ fileName } 上传失败：${ error.message || error.toString() || '未知错误' }`)
          if (sftpManager.getConnectionStatus(currentConnectionId) !== SftpConnectionStatus.CONNECTED) break
        }
      }
      if (uploadQueue.length > 0
        && sftpManager.getConnectionStatus(currentConnectionId) === SftpConnectionStatus.CONNECTED) {
        handleRefresh()
      }
    } catch (error) {
      notification.error('上传文件失败', error.message || error.toString() || '未知错误')
    } finally {
      if (uploadQueue.length > 0) PubSubBusinessKeyEnum.SEND_MASK(null)
    }
  }

  const handleUploadDirectory = async () => {
    if (folderUploading) return

    let folderName = ''
    try {
      const selected = await dialog.open({
        title: '选择要上传的文件夹',
        multiple: false,
        directory: true
      })
      if (typeof selected !== 'string' || !selected) return

      folderName = localPathName(selected)
      if (!folderName) {
        throw new Error('无法识别所选文件夹名称')
      }

      const existing = files.find(entry => entry.name === folderName)
      if (existing && !existing.isDirectory) {
        notification.error('上传文件夹失败', `远程目录中已存在同名文件：${ folderName }`)
        return
      }

      let overwrite = false
      if (existing) {
        overwrite = await confirm(
          `远程目录中已存在“${ folderName }”，是否合并上传并覆盖其中的同名文件？`,
          {
            title: '确认合并文件夹',
            kind: 'warning',
            okLabel: '合并并覆盖',
            cancelLabel: '取消'
          }
        )
        if (!overwrite) return
      }

      const remotePath = joinRemotePath(currentPath, folderName)
      let transferId = null
      const publishProgress = (progress, payload = {}) => {
        const fileTotal = Number(payload.fileTotal) || 0
        const fileIndex = Number(payload.fileIndex) || 0
        PubSubBusinessKeyEnum.SEND_MASK({
          progress,
          overallProgress: Number.isFinite(Number(payload.overallProgress))
            ? Number(payload.overallProgress)
            : undefined,
          fileName: payload.fileName || folderName,
          operation: 'upload-directory',
          queueIndex: fileTotal > 0 ? Math.min(fileIndex, fileTotal - 1) : 0,
          queueTotal: fileTotal || 1,
          pendingCount: fileTotal > 0 ? Math.max(fileTotal - fileIndex - 1, 0) : 0,
          onCancel: transferId ? () => sftpManager.cancelTransfer(transferId) : undefined
        })
      }

      setFolderUploading(true)
      publishProgress(0)
      const message = await sftpManager.uploadDirectory(
        currentConnectionId,
        selected,
        remotePath,
        (progress, payload) => publishProgress(Math.round(progress), payload),
        overwrite,
        id => {
          transferId = id
          publishProgress(0)
        }
      )
      notification.success('文件夹上传成功', message || `文件夹 ${ folderName } 上传成功`)
      if (sftpManager.getConnectionStatus(currentConnectionId) === SftpConnectionStatus.CONNECTED) {
        handleRefresh()
      }
    } catch (error) {
      notification.error(
        '上传文件夹失败',
        `文件夹 ${ folderName || '所选文件夹' } 上传失败：${ error.message || error.toString() || '未知错误' }`
      )
    } finally {
      setFolderUploading(false)
      PubSubBusinessKeyEnum.SEND_MASK(null)
    }
  }

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
            icon={<UpOutlined />}
            aria-label="返回上级目录"
          />
        </Tooltip>

        <div
          className="remote-path-bar"
        >
          <FolderOpenOutlined className="remote-path-icon" />
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
              icon={<DownOutlined />}
              aria-label="快速定位目录"
            />
          </Dropdown>
        </div>

        <Tooltip title="刷新目录">
          <Button
            className="toolbar-icon-button"
            size="small"
            onClick={handleRefresh}
            icon={<ReloadOutlined />}
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
          <Button size="small" icon={<UploadOutlined />} onClick={handleUpload}>
            上传
          </Button>
          <Button
            size="small"
            icon={<FolderOutlined />}
            loading={folderUploading}
            onClick={handleUploadDirectory}
          >
            上传文件夹
          </Button>
          <Button
            size="small"
            icon={<FolderAddOutlined />}
            onClick={() => setDirectoryModalOpen(true)}
            aria-label="新建文件夹"
          >
            新建文件夹
          </Button>
          <Button
            size="small"
            danger
            icon={<DisconnectOutlined />}
            onClick={() => handleDisconnect()}
          >
            断开连接
          </Button>
        </div>
      </div>

      <div
        className="file-list-shell"
      >
        {error ? (
          <Alert type="error" showIcon message="目录加载失败" description={error} className="file-list-alert" />
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
                onClick={() => handleItemClick(entry)}
                onDelete={() => handleDeleteItem(entry)}
                onRename={name => handleRenameItem(entry, name)}
              />
            )}
          />
        )}
      </div>
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
