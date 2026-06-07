import React from 'react'
import { Button, List } from 'antd'
import { DownloadOutlined, FileOutlined, FolderOutlined } from '@ant-design/icons'
import { formatFileSize, PubSubBusinessKeyEnum, StoreKeys } from '../utils/common'
import sftpManager from '../utils/sftpUtils'
import { notification } from '../utils/notificationUtils'
import { store } from '../utils/storeUtils.js'

const FileItem = ({ entry, currentPath, connectionId, onClick }) => {
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
              onClick={(e) => {
                e.stopPropagation()
                // 构建远程文件路径
                const remotePath = currentPath.endsWith('/') ? currentPath + entry.name : currentPath + '/' + entry.name
                // 从store中获取下载路径
                store.get(StoreKeys.DOWNLOAD_PATH).then(downloadPath => {
                  // 构建本地文件路径
                  const localPath = `${ downloadPath }/${ entry.name }`

                  // 开启进度遮罩
                  PubSubBusinessKeyEnum.SEND_MASK({
                    progress: 0,
                    fileName: entry.name,
                    operation: 'download'
                  })

                  // 定义进度回调函数
                  const onProgress = (progress) => {
                    // 更新进度遮罩
                    PubSubBusinessKeyEnum.SEND_MASK({
                      progress: Math.round(progress),
                      fileName: entry.name,
                      operation: 'download'
                    })
                  }

                  // 添加延迟，确保进度遮罩有足够的时间显示
                  setTimeout(() => {
                    // 调用sftpManager下载文件，传入进度回调
                    sftpManager.downloadFile(connectionId, remotePath, localPath, onProgress)
                      .then(result => {
                        // 关闭进度遮罩
                        PubSubBusinessKeyEnum.SEND_MASK(null)
                        if (result) {
                          notification.success('下载成功', `文件 ${ entry.name } 下载成功，保存在: ${ localPath }`)
                        } else {
                          notification.error('下载失败', '文件下载失败')
                        }
                      })
                      .catch(error => {
                        console.error('下载文件失败:', error)
                        // 关闭进度遮罩
                        PubSubBusinessKeyEnum.SEND_MASK(null)
                        const errorMessage = error.message || error.toString() || '未知错误'
                        notification.error('下载失败', `文件 ${ entry.name } 下载失败: ${ errorMessage }`)
                      })
                  }, 100)
                })
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

export default FileItem