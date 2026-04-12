import React from 'react'
import { List, Button, message } from 'antd'
import { FolderOutlined, FileOutlined, DownloadOutlined } from '@ant-design/icons'
import { formatFileSize } from '../utils/common'
import sftpManager from '../utils/sftpUtils'
import toast from 'react-hot-toast'
import { msgBoxStyle } from '../style/LayoutStyle.js'
import { store } from '../utils/storeUtils.js'

const RemoteFileItem = ({ entry, currentPath, connectionId, onClick }) => {
  return (
    <div
      style={{
        cursor: 'default'
      }}
      onClick={onClick}
    >
      <List.Item
        style={{
          cursor: entry.isDirectory ? 'pointer' : 'default',
          borderBottom: '1px solid #1E1E1E',
          padding: '12px'
        }}
        hoverable
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
            <Button
              key="download"
              size="small"
              icon={<DownloadOutlined />}
              style={{
                color: '#ffffff',
                borderColor: '#4EC9B0',
                '&:hover': {
                  color: '#4EC9B0',
                  borderColor: '#4EC9B0'
                }
              }}
              onClick={async (e) => {
                e.stopPropagation()
                try {
                  // 构建远程文件路径
                  const remotePath = currentPath.endsWith('/') ? currentPath + entry.name : currentPath + '/' + entry.name
                  // 从store中获取下载路径
                  const downloadPath = await store.get('download_path')
                  // 构建本地文件路径
                  const localPath = `${ downloadPath }/${ entry.name }`
                  // 调用sftpManager下载文件
                  const result = await sftpManager.downloadFile(connectionId, remotePath, localPath)
                  if (result) {
                    toast.success(`文件 ${ entry.name } 下载成功，保存在: ${ localPath }`, { id: 'msgBoxGlobal', style: msgBoxStyle })
                  } else {
                    toast.error('文件下载失败', { id: 'msgBoxGlobal', style: msgBoxStyle })
                  }
                } catch (error) {
                  console.error('下载文件失败:', error)
                  toast.error(`文件 ${ entry.name } 下载失败: ${ error.message }`, { id: 'msgBoxGlobal', style: msgBoxStyle })
                }
              }}
            >
              下载
            </Button>
          )}
        </div>
      </List.Item>
    </div>
  )
}

export default RemoteFileItem