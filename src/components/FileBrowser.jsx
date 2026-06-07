import React from 'react'
import { Button, Dropdown, Input, List, Spin } from 'antd'
import { DisconnectOutlined, DownOutlined, ReloadOutlined, UploadOutlined, UpOutlined } from '@ant-design/icons'
import FileItem from './FileItem'
import * as dialog from '@tauri-apps/plugin-dialog'
import { PubSubBusinessKeyEnum } from '../utils/common'
import { sftpManager } from '../utils/sftpUtils'
import { notification } from '../utils/notificationUtils'

const FileBrowser = ({
  currentPath,
  files,
  loading,
  currentConnection,
  currentConnectionId,
  homeDir,
  drives,
  handleGoBack,
  handlePathChange,
  handlePathSubmit,
  handleRefresh,
  handleItemClick,
  handleDriveSelect,
  handleDisconnect
}) => {
  // 上传文件
  const handleUpload = async () => {
    try {
      const result = await dialog.open({
        title: '选择要上传的文件',
        filters: [
          {
            name: '所有文件',
            extensions: ['/*']
          }
        ]
      })

      if (result) {
        const localPath = Array.isArray(result) ? result[0] : result
        if (!localPath) {
          return
        }

        const fileName = localPath.split('/').pop()
        const remotePath = currentPath.endsWith('/') ? currentPath + fileName : currentPath + '/' + fileName

        PubSubBusinessKeyEnum.SEND_MASK({
          progress: 0,
          fileName: fileName,
          operation: 'upload'
        })

        const onProgress = (progress) => {
          PubSubBusinessKeyEnum.SEND_MASK({
            progress: Math.round(progress),
            fileName: fileName,
            operation: 'upload'
          })
        }

        setTimeout(() => {
          sftpManager.uploadFile(currentConnectionId, localPath, remotePath, onProgress)
            .then(result => {
              PubSubBusinessKeyEnum.SEND_MASK(null)
              if (result) {
                notification.success('上传成功', `文件 ${ fileName } 上传成功`)
                handleRefresh()
              } else {
                notification.error('上传失败', '文件上传失败')
              }
            })
            .catch(error => {
              PubSubBusinessKeyEnum.SEND_MASK(null)
              const errorMessage = error.message || error.toString() || '未知错误'
              notification.error('上传失败', `文件 ${ fileName } 上传失败: ${ errorMessage }`)
            })
        }, 100)
      }
    } catch (error) {
      notification.error('上传文件失败', error.message || error.toString() || '未知错误')
    }
  }

  const menuItems = [
    {
      key: 'home',
      label: (
        <div onClick={() => {
          handleDriveSelect(homeDir)
        }}>
          {homeDir}
        </div>
      )
    },
    ...(drives && drives.length > 0 ? [{
      key: 'divider',
      type: 'divider'
    }] : []),
    ...(drives && drives.length > 0 ? drives.map((drive, index) => ({
      key: index,
      label: (
        <div onClick={() => handleDriveSelect(drive)}>
          {drive}
        </div>
      )
    })) : [])
  ]

  return (
    <div style={{ borderRadius: '10px', backgroundColor: '#101113', padding: 16, display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 16 }}>
        <Button
          onClick={handleGoBack}
          icon={<UpOutlined />}
          style={{
            backgroundColor: '#2B2D30',
            border: '1px solid #3E4148',
            color: '#ffffff',
            borderTopRightRadius: 0,
            borderBottomRightRadius: 0
          }}
        />

        <Input
          value={currentPath}
          onChange={handlePathChange}
          onKeyPress={handlePathSubmit}
          style={{
            flex: 1,
            backgroundColor: '#2B2D30',
            border: '1px solid #3E4148',
            borderLeft: 'none',
            borderRight: 'none',
            color: '#ffffff'
          }}
        />

        <Dropdown menu={{ items: menuItems }}>
          <Button
            icon={<DownOutlined />}
            style={{
              backgroundColor: '#2B2D30',
              border: '1px solid #3E4148',
              borderLeft: 'none',
              borderRight: 'none',
              color: '#ffffff'
            }}
          />
        </Dropdown>

        <Button
          onClick={handleRefresh}
          icon={<ReloadOutlined />}
          style={{
            backgroundColor: '#2B2D30',
            border: '1px solid #3E4148',
            borderLeft: 'none',
            color: '#ffffff',
            borderTopLeftRadius: 0,
            borderBottomLeftRadius: 0
          }}
        />
      </div>

      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: 16,
        padding: '8px 12px',
        backgroundColor: '#1E1E1E',
        borderRadius: '4px'
      }}>
        <span style={{ color: '#4EC9B0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {currentConnection?.name || '未知'} ({currentConnection?.host || '未知'}:{currentConnection?.port || '未知'})
        </span>
        <div style={{ display: 'flex', gap: '8px' }}>
          <Button
            icon={<UploadOutlined />}
            onClick={handleUpload}
            style={{
              backgroundColor: '#2B2D30',
              border: '1px solid #3E4148',
              color: '#ffffff'
            }}
          >
            上传
          </Button>
          <Button
            danger
            icon={<DisconnectOutlined />}
            onClick={handleDisconnect}
          >
            断开连接
          </Button>
        </div>
      </div>

      <div
        style={{
          height: 'calc(100vh - 148px)',
          overflow: 'auto',
          backgroundColor: '#0C0D0E',
          borderRadius: '4px',
          border: '1px solid transparent'
        }}
      >
        {loading ? (
          <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '200px' }}>
            <Spin description="加载中..." />
          </div>
        ) : files.length === 0 ? (
          <div style={{ padding: '40px', textAlign: 'center', color: '#888888' }}>
            该目录为空
          </div>
        ) : (
          <List
            itemLayout="horizontal"
            dataSource={files}
            renderItem={(entry, index) => (
              <FileItem
                entry={entry}
                currentPath={currentPath}
                connectionId={currentConnectionId}
                onClick={() => handleItemClick(entry)}
              />
            )}
          />
        )}
      </div>
    </div>
  )
}

export default FileBrowser