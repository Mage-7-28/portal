import React from 'react'
import { Alert, Button, Dropdown, Input, List, Modal, Spin, Tooltip } from 'antd'
import { DisconnectOutlined, DownOutlined, FolderAddOutlined, FolderOpenOutlined, ReloadOutlined, UploadOutlined, UpOutlined } from '@ant-design/icons'
import FileItem from './FileItem'
import * as dialog from '@tauri-apps/plugin-dialog'
import { confirm } from '@tauri-apps/plugin-dialog'
import { PubSubBusinessKeyEnum } from '../utils/common'
import { sftpManager } from '../utils/sftpUtils'
import { notification } from '../utils/notificationUtils'

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
    try {
      const result = await dialog.open({
        title: '选择要上传的文件',
        multiple: true,
        directory: false
      })
      const paths = result ? (Array.isArray(result) ? result : [result]) : []
      for (const localPath of paths) {
        const fileName = localPath.split(/[\\/]/).pop()
        if (!fileName) continue
        if (files.some(entry => entry.name === fileName)) {
          const overwrite = await confirm(`远程目录中已存在“${ fileName }”，是否覆盖？`, {
            title: '确认覆盖',
            kind: 'warning',
            okLabel: '覆盖',
            cancelLabel: '取消'
          })
          if (!overwrite) continue
        }
        const remotePath = `${ currentPath.replace(/\/+$/, '') || '' }/${ fileName }` || `/${ fileName }`
        let transferId = null
        PubSubBusinessKeyEnum.SEND_MASK({
          progress: 0,
          fileName,
          operation: 'upload',
          onCancel: () => transferId && sftpManager.cancelTransfer(transferId)
        })
        try {
          await sftpManager.uploadFile(currentConnectionId, localPath, remotePath, progress => {
            PubSubBusinessKeyEnum.SEND_MASK({
              progress: Math.round(progress),
              fileName,
              operation: 'upload',
              onCancel: () => transferId && sftpManager.cancelTransfer(transferId)
            })
          }, id => {
            transferId = id
            PubSubBusinessKeyEnum.SEND_MASK({
              progress: 0,
              fileName,
              operation: 'upload',
              onCancel: () => sftpManager.cancelTransfer(transferId)
            })
          })
          notification.success('上传成功', `文件 ${ fileName } 上传成功`)
        } catch (error) {
          notification.error('上传失败', `文件 ${ fileName } 上传失败：${ error.message || error.toString() || '未知错误' }`)
        } finally {
          PubSubBusinessKeyEnum.SEND_MASK(null)
        }
      }
      if (paths.length > 0) handleRefresh()
    } catch (error) {
      notification.error('上传文件失败', error.message || error.toString() || '未知错误')
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
          onPressEnter={submitDirectory}
        />
      </Modal>
    </div>
  )
}

export default FileBrowser
