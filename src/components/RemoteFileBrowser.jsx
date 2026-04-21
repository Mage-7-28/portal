import React from 'react'
import { Button, Dropdown, Input, List, Spin } from 'antd'
import { DisconnectOutlined, DownOutlined, ReloadOutlined, UploadOutlined, UpOutlined } from '@ant-design/icons'
import RemoteFileItem from './RemoteFileItem'
import * as dialog from '@tauri-apps/plugin-dialog'
import { PubSubBusinessKeyEnum } from '../utils/common'
import { sftpManager } from '../utils/sftpUtils'
import { notification } from '../utils/notificationUtils'

const RemoteFileBrowser = ({
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
      console.log('开始上传文件...')
      console.log('当前目录:', currentPath)

      // 弹出系统级文件选择对话框，只能选择文件
      const result = await dialog.open({
        title: '选择要上传的文件',
        filters: [
          {
            name: '所有文件',
            extensions: ['/*']
          }
        ]
      })

      console.log('对话框返回结果:', result)

      if (result) {
        // 处理返回结果，可能是字符串或数组
        const localPath = Array.isArray(result) ? result[0] : result
        if (!localPath) {
          console.log('本地路径为空')
          return
        }
        console.log('选择的本地文件路径:', localPath)

        // 获取文件名
        const fileName = localPath.split('/').pop()
        console.log('文件名:', fileName)

        // 构建远程路径
        const remotePath = currentPath.endsWith('/') ? currentPath + fileName : currentPath + '/' + fileName
        console.log('远程路径:', remotePath)

        // 开启进度遮罩
        PubSubBusinessKeyEnum.SEND_MASK({
          progress: 0,
          fileName: fileName,
          operation: 'upload'
        })

        // 定义进度回调函数
        const onProgress = (progress) => {
          // 更新进度遮罩
          PubSubBusinessKeyEnum.SEND_MASK({
            progress: Math.round(progress),
            fileName: fileName,
            operation: 'upload'
          })
        }

        // 添加延迟，确保进度遮罩有足够的时间显示
        setTimeout(() => {
          // 调用sftpManager上传文件，传入进度回调
          sftpManager.uploadFile(currentConnectionId, localPath, remotePath, onProgress)
            .then(result => {
              // 关闭进度遮罩
              PubSubBusinessKeyEnum.SEND_MASK(null)
              if (result) {
                notification.success('上传成功', `文件 ${ fileName } 上传成功`)
                // 刷新文件列表
                handleRefresh()
              } else {
                notification.error('上传失败', '文件上传失败')
              }
            })
            .catch(error => {
              console.error('上传文件失败:', error)
              // 关闭进度遮罩
              PubSubBusinessKeyEnum.SEND_MASK(null)
              const errorMessage = error.message || error.toString() || '未知错误'
              notification.error('上传失败', `文件 ${ fileName } 上传失败: ${ errorMessage }`)
            })
        }, 100)
      } else {
        console.log('用户取消了文件选择')
      }
    } catch (error) {
      console.error('上传文件失败:', error)
      toast.error(`上传文件失败: ${ error.message || error.toString() || '未知错误' }`, { id: 'msgBoxGlobal', style: msgBoxStyle })
    }
  }
  // 构建下拉菜单
  const menuItems = [
    // 添加用户主目录选项
    {
      key: 'home',
      label: (
        <div key={homeDir} onClick={() => {
          // 使用与驱动器选择相同的逻辑，直接传入路径并加载
          handleDriveSelect(homeDir)
        }}>
          {homeDir}
        </div>
      )
    },
    // 当有驱动器时添加分隔线
    ...(drives && drives.length > 0 ? [{
      key: 'divider',
      type: 'divider'
    }] : []),
    // 添加驱动器选项
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
      {/* 地址栏 */}
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

      {/* 连接信息栏 */}
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

      {/* 文件列表 */}
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
              <RemoteFileItem
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

export default RemoteFileBrowser