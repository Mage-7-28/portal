import React from 'react'
import { Button, Dropdown, Input, List, Spin } from 'antd'
import { DisconnectOutlined, DownOutlined, ReloadOutlined, UpOutlined } from '@ant-design/icons'
import RemoteFileItem from './RemoteFileItem'

const RemoteFileBrowser = ({
  currentPath,
  files,
  loading,
  currentConnection,
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
  // 构建下拉菜单
  const menuItems = [
    // 添加用户主目录选项
    {
      key: 'home',
      label: (
        <div key={homeDir} onClick={() => {
          handlePathChange({ target: { value: homeDir }})
          handlePathSubmit({ key: 'Enter' })
        }}>
          {homeDir}
        </div>
      )
    },
    // 添加分隔线
    {
      key: 'divider',
      type: 'divider'
    },
    // 添加驱动器选项
    ...drives.map((drive, index) => ({
      key: index,
      label: (
        <div onClick={() => handleDriveSelect(drive)}>
          {drive}
        </div>
      )
    }))
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
        <Button
          danger
          icon={<DisconnectOutlined />}
          onClick={handleDisconnect}
        >
          断开连接
        </Button>
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
                connectionId={currentConnection?.id}
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