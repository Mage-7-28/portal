import React, { useState, useEffect } from 'react'
import { Input, Button, Dropdown, List, Spin, Typography, Space } from 'antd'
import { UpOutlined, DownOutlined, ReloadOutlined, FolderOutlined, FileOutlined } from '@ant-design/icons'
import { getUserHomeDir, getDirectoryContents, formatFileSize, getDrives } from '../utils/fsUtils'
import sftpManager from '../utils/sftpUtils'
import toast from 'react-hot-toast'
import { msgBoxStyle } from '../style/LayoutStyle.js'

const { Title } = Typography

// 文件项组件
const FileItem = ({ entry, currentPath, onClick }) => {
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
        <span style={{ color: '#888888', fontSize: 12 }}>
          {entry.isDirectory ? '' : formatFileSize(entry.size)}
        </span>
      </List.Item>
    </div>
  )
}

function Local() {
  const [ currentPath, setCurrentPath ] = useState('')
  const [ drives, setDrives ] = useState([])
  const [ files, setFiles ] = useState([])
  const [ loading, setLoading ] = useState(true)
  const [ homeDir, setHomeDir ] = useState('')

  // 初始化
  useEffect(() => {
    const init = async () => {
      try {
        setLoading(true)
        // 获取用户主目录
        const userHomeDir = await getUserHomeDir()
        setHomeDir(userHomeDir)
        setCurrentPath(userHomeDir)

        // 获取系统驱动器
        const driveList = await getDrives()
        setDrives(driveList)

        // 获取目录内容
        const contents = await getDirectoryContents(userHomeDir)
        setFiles(contents)
      } catch (error) {
        console.error('初始化错误:', error)
      } finally {
        setLoading(false)
      }
    }

    init()
  }, [])

  // 处理地址栏变化
  const handlePathChange = (e) => {
    setCurrentPath(e.target.value)
  }

  // 处理地址栏回车
  const handlePathSubmit = async (e) => {
    if (e.key === 'Enter') {
      await loadDirectoryContents(currentPath)
    }
  }

  // 加载目录内容
  const loadDirectoryContents = async (pathToLoad) => {
    try {
      setLoading(true)
      const contents = await getDirectoryContents(pathToLoad)
      setFiles(contents)
    } catch (error) {
      console.error('加载目录内容失败:', error)
      setFiles([])
    } finally {
      setLoading(false)
    }
  }

  // 处理驱动器选择
  const handleDriveSelect = async (drive) => {
    setCurrentPath(drive)
    await loadDirectoryContents(drive)
  }

  // 处理刷新
  const handleRefresh = async () => {
    await loadDirectoryContents(currentPath)
  }

  // 处理文件/目录点击
  const handleItemClick = async (entry) => {
    if (entry.isDirectory) {
      const newPath = currentPath.endsWith('/')
        ? currentPath + entry.name
        : currentPath + '/' + entry.name
      setCurrentPath(newPath)
      await loadDirectoryContents(newPath)
    }
  }

  // 处理返回上一级
  const handleGoBack = async () => {
    if (currentPath.includes('/')) {
      const parts = currentPath.split('/')
      // 移除最后一部分
      parts.pop()
      const parentPath = parts.join('/') || '/' // 确保根目录
      setCurrentPath(parentPath)
      await loadDirectoryContents(parentPath)
    }
  }

  // 构建下拉菜单
  const menuItems = [
    // 添加用户主目录选项
    {
      key: 'home',
      label: (
        <div key={homeDir} onClick={() => {
          setCurrentPath(homeDir)
          loadDirectoryContents(homeDir)
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
              color: '#ffffff',
              borderLeft: 'none',
              borderRight: 'none'
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

      {/* 文件列表 */}
      <div
        style={{
          height: 'calc(100vh - 85px)',
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
                key={index}
                entry={entry}
                currentPath={currentPath}
                onClick={() => handleItemClick(entry)}
              />
            )}
          />
        )}
      </div>
    </div>
  )
}

export default Local
