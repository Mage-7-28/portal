import React, { useState } from 'react'
import { Button, Input, List, Modal, Tooltip } from 'antd'
import { DeleteOutlined, DownloadOutlined, EditOutlined, FileOutlined, FolderOutlined } from '@ant-design/icons'
import { confirm } from '@tauri-apps/plugin-dialog'
import { formatFileSize, PubSubBusinessKeyEnum } from '../utils/common'
import sftpManager from '../utils/sftpUtils'
import { notification } from '../utils/notificationUtils'
import { joinLocalPath, resolveDownloadPath } from '../utils/downloadUtils.js'

const FileItem = ({ entry, currentPath, connectionId, selected, onSelect, onActivate, onDelete, onRename }) => {
  const [ downloading, setDownloading ] = useState(false)
  const [ deleting, setDeleting ] = useState(false)
  const [ renameOpen, setRenameOpen ] = useState(false)
  const [ renameValue, setRenameValue ] = useState(entry.name)
  const [ renaming, setRenaming ] = useState(false)

  const joinRemotePath = (base, name) => `${ base.replace(/\/+$/, '') || '' }/${ name }` || `/${ name }`

  const handleDownload = async (event) => {
    event.stopPropagation()
    if (downloading) return
    let downloadPath
    try {
      downloadPath = await resolveDownloadPath()
      if (!downloadPath) return
    } catch (error) {
      notification.error('下载失败', error.message || error.toString() || '无法选择本地下载目录')
      return
    }
    const remotePath = joinRemotePath(currentPath, entry.name)
    const localPath = joinLocalPath(downloadPath, entry.name)
    const accepted = await confirm(
      `确定下载“${ entry.name }”吗？\n\n保存到：${ localPath }`,
      {
        title: '确认下载',
        kind: 'warning',
        okLabel: '下载',
        cancelLabel: '取消'
      }
    )
    if (!accepted) return
    let overwrite = false
    let transferId = null
    try {
      setDownloading(true)
      PubSubBusinessKeyEnum.SEND_MASK({
        progress: 0,
        fileName: entry.name,
        operation: 'download',
        onCancel: () => transferId && sftpManager.cancelTransfer(transferId)
      })
      await sftpManager.downloadFile(connectionId, remotePath, localPath, progress => {
        PubSubBusinessKeyEnum.SEND_MASK({
          progress: Math.round(progress),
          fileName: entry.name,
          operation: 'download',
          onCancel: () => transferId && sftpManager.cancelTransfer(transferId)
        })
      }, overwrite, id => {
        transferId = id
        PubSubBusinessKeyEnum.SEND_MASK({
          progress: 0,
          fileName: entry.name,
          operation: 'download',
          onCancel: () => sftpManager.cancelTransfer(transferId)
        })
      })
      notification.success('下载成功', `文件 ${ entry.name } 已保存到 ${ localPath }`)
    } catch (error) {
      const message = error.message || error.toString() || '未知错误'
      if (message.includes('已存在')) {
        const accepted = await confirm(`本地文件已存在：\n${ localPath }\n是否覆盖？`, {
          title: '确认覆盖',
          kind: 'warning',
          okLabel: '覆盖',
          cancelLabel: '取消'
        })
        if (accepted) {
          overwrite = true
          try {
            await sftpManager.downloadFile(connectionId, remotePath, localPath, progress => {
              PubSubBusinessKeyEnum.SEND_MASK({
                progress: Math.round(progress),
                fileName: entry.name,
                operation: 'download',
                onCancel: () => transferId && sftpManager.cancelTransfer(transferId)
              })
            }, overwrite, id => {
              transferId = id
              PubSubBusinessKeyEnum.SEND_MASK({
                progress: 0,
                fileName: entry.name,
                operation: 'download',
                onCancel: () => sftpManager.cancelTransfer(transferId)
              })
            })
            notification.success('下载成功', `文件 ${ entry.name } 已覆盖`)
            return
          } catch (retryError) {
            notification.error('下载失败', retryError.message || retryError.toString() || '未知错误')
          }
        }
      } else {
        notification.error('下载失败', `文件 ${ entry.name }：${ message }`)
      }
    } finally {
      setDownloading(false)
      PubSubBusinessKeyEnum.SEND_MASK(null)
    }
  }

  const submitRename = async (event) => {
    event?.preventDefault()
    event?.stopPropagation()
    const name = renameValue.trim()
    if (!name || /[\\/]/.test(name) || name === '.' || name === '..') return
    setRenaming(true)
    try {
      await onRename(name)
      setRenameOpen(false)
    } catch (error) {
      notification.error('重命名失败', error.message || error.toString() || '未知错误')
    } finally {
      setRenaming(false)
    }
  }

  const handleDelete = async (event) => {
    event.stopPropagation()
    if (deleting) return
    setDeleting(true)
    try {
      await onDelete()
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div
      className={`file-item-row${ selected ? ' is-selected' : '' }`}
      title={entry.isDirectory ? '单击选择，双击进入目录' : '单击选择，双击预览文件'}
      onClick={onSelect}
      onDoubleClick={event => {
        event.stopPropagation()
        onActivate()
      }}
      onKeyDown={event => {
        // Keyboard activation belongs to the row itself. Events from action
        // buttons and the rename modal must never activate the row.
        if (event.target !== event.currentTarget) return
        if (event.key === 'Enter') {
          event.preventDefault()
          onActivate()
        } else if (event.key === ' ') {
          event.preventDefault()
          onSelect(event)
        }
      }}
      role="button"
      tabIndex={0}
      aria-pressed={selected}
    >
      <List.Item
        className="file-list-item"
      >
        <List.Item.Meta
          className="file-item-meta"
          avatar={
            entry.isDirectory ?
              <FolderOutlined className="file-type-icon is-directory" /> :
              <FileOutlined className="file-type-icon" />
          }
          title={
            <span className={`file-item-name${ entry.isDirectory ? ' is-directory' : '' }`}>
              {entry.name}
            </span>
          }
        />
        <div className="file-item-actions" onDoubleClick={event => event.stopPropagation()}>
          <span className="file-item-size">
            {entry.isDirectory ? '' : formatFileSize(entry.size)}
          </span>
          {!entry.isDirectory && (
            <Tooltip title="下载文件">
              <Button
                className="compact-icon-button"
                size="small"
                icon={<DownloadOutlined />}
                loading={downloading}
                aria-label={`下载 ${ entry.name }`}
                onClick={handleDownload}
              >
              </Button>
            </Tooltip>
          )}
          <Tooltip title="重命名">
            <Button
              className="compact-icon-button"
              size="small"
              icon={<EditOutlined />}
              aria-label={`重命名 ${ entry.name }`}
              onClick={event => {
                event.stopPropagation()
                setRenameValue(entry.name)
                setRenameOpen(true)
              }}
            />
          </Tooltip>
          <Tooltip title="删除">
            <Button
              className="compact-icon-button"
              danger
              size="small"
              icon={<DeleteOutlined />}
              loading={deleting}
              aria-label={`删除 ${ entry.name }`}
              onClick={event => void handleDelete(event)}
            />
          </Tooltip>
        </div>
      </List.Item>
      <div
        onClick={event => event.stopPropagation()}
        onDoubleClick={event => event.stopPropagation()}
        onMouseDown={event => event.stopPropagation()}
        onPointerDown={event => event.stopPropagation()}
        onKeyDown={event => event.stopPropagation()}
        onKeyUp={event => event.stopPropagation()}
      >
        <Modal
          rootClassName="compact-modal"
          title={`重命名 ${ entry.name }`}
          open={renameOpen}
          onCancel={event => {
            event?.stopPropagation()
            setRenameOpen(false)
          }}
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
      </div>
    </div>
  )
}

export default FileItem
