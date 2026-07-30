import React, { useState } from 'react'
import { Button, Input, List, Modal, Tooltip } from 'antd'
import { DeleteOutlined, DownloadOutlined, EditOutlined, FileOutlined, FolderOutlined } from '@ant-design/icons'
import { confirm } from '@tauri-apps/plugin-dialog'
import * as dialog from '@tauri-apps/plugin-dialog'
import { formatFileSize, PubSubBusinessKeyEnum, StoreKeys } from '../utils/common'
import sftpManager from '../utils/sftpUtils'
import { notification } from '../utils/notificationUtils'
import { store } from '../utils/storeUtils.js'

const FileItem = ({ entry, currentPath, connectionId, onClick, onDelete, onRename }) => {
  const [ downloading, setDownloading ] = useState(false)
  const [ renameOpen, setRenameOpen ] = useState(false)
  const [ renameValue, setRenameValue ] = useState(entry.name)
  const [ renaming, setRenaming ] = useState(false)

  const joinRemotePath = (base, name) => `${ base.replace(/\/+$/, '') || '' }/${ name }` || `/${ name }`
  const joinLocalPath = (base, name) => {
    const separator = base.includes('\\') && !base.includes('/') ? '\\' : '/'
    return `${ base.replace(/[\\/]+$/, '') }${ separator }${ name }`
  }

  const handleDownload = async (event) => {
    event.stopPropagation()
    if (downloading) return
    let downloadPath
    try {
      downloadPath = await store.get(StoreKeys.DOWNLOAD_PATH)
      if (!downloadPath) {
        const selected = await dialog.open({
          title: '选择本地下载目录',
          directory: true,
          multiple: false,
          canCreateDirectories: true
        })
        if (typeof selected !== 'string' || !selected) return
        await store.set(StoreKeys.DOWNLOAD_PATH, selected)
        downloadPath = selected
      }
    } catch (error) {
      notification.error('下载失败', error.message || error.toString() || '无法选择本地下载目录')
      return
    }
    const remotePath = joinRemotePath(currentPath, entry.name)
    const localPath = joinLocalPath(downloadPath, entry.name)
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

  const submitRename = async () => {
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

  return (
    <div
      style={{
        cursor: entry.isDirectory ? 'pointer' : 'default'
      }}
      onClick={onClick}
      onKeyDown={event => {
        if (entry.isDirectory && (event.key === 'Enter' || event.key === ' ')) {
          event.preventDefault()
          onClick()
        }
      }}
      role={entry.isDirectory ? 'button' : undefined}
      tabIndex={entry.isDirectory ? 0 : undefined}
    >
      <List.Item
        style={{
          cursor: entry.isDirectory ? 'pointer' : 'default',
          borderBottom: '1px solid #1E1E1E',
          padding: '12px'
        }}
      >
        <List.Item.Meta
          avatar={
            entry.isDirectory ?
              <FolderOutlined style={{ color: '#4EC9B0' }} /> :
              <FileOutlined style={{ color: '#ffffff' }} />
          }
          title={
            <span style={{ color: entry.isDirectory ? '#4EC9B0' : '#ffffff' }}>
              {entry.name}
            </span>
          }
        />
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <span style={{ color: '#888888', fontSize: 12 }}>
            {entry.isDirectory ? '' : formatFileSize(entry.size)}
          </span>
          {!entry.isDirectory && (
            <Tooltip title="下载文件">
              <Button
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
              danger
              size="small"
              icon={<DeleteOutlined />}
              aria-label={`删除 ${ entry.name }`}
              onClick={event => {
                event.stopPropagation()
                void onDelete()
              }}
            />
          </Tooltip>
        </div>
      </List.Item>
      <Modal
        title={`重命名 ${ entry.name }`}
        open={renameOpen}
        onCancel={() => setRenameOpen(false)}
        onOk={submitRename}
        okText="保存"
        cancelText="取消"
        confirmLoading={renaming}
        destroyOnHidden
      >
        <Input
          autoFocus
          value={renameValue}
          onChange={event => setRenameValue(event.target.value)}
          onPressEnter={submitRename}
        />
      </Modal>
    </div>
  )
}

export default FileItem
