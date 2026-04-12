import React, { useEffect, useState } from 'react'
import { store } from '../utils/storeUtils'
import sftpManager from '../utils/sftpUtils'
import toast from 'react-hot-toast'
import { msgBoxStyle } from '../style/LayoutStyle.js'
import RemoteFileBrowser from './RemoteFileBrowser'
import RemoteConnectionList from './RemoteConnectionList'

// 存储键名
const SSH_CONNECTIONS_KEY = 'ssh_connections'

function Remote() {
  // 连接相关状态
  const [ connections, setConnections ] = useState([])
  const [ currentConnection, setCurrentConnection ] = useState(null)
  const [ currentConnectionId, setCurrentConnectionId ] = useState(null)

  // 文件浏览相关状态
  const [ currentPath, setCurrentPath ] = useState('/')
  const [ files, setFiles ] = useState([])
  const [ loading, setLoading ] = useState(false)
  const [ drives, setDrives ] = useState([])
  const [ homeDir, setHomeDir ] = useState('')

  // 初始化：加载历史连接
  useEffect(() => {
    loadConnections()
  }, [])

  // 加载存储的连接列表
  const loadConnections = async () => {
    const savedConnections = await store.get(SSH_CONNECTIONS_KEY) || []
    // 按创建时间排序，最新的在前面
    savedConnections.sort((a, b) => {
      return new Date(b.createdAt) - new Date(a.createdAt)
    })
    setConnections(savedConnections)
  }

  // 保存连接列表到 store
  const saveConnections = async (newConnections) => {
    // 按创建时间排序，最新的在前面
    newConnections.sort((a, b) => {
      return new Date(b.createdAt) - new Date(a.createdAt)
    })
    await store.set(SSH_CONNECTIONS_KEY, newConnections)
    setConnections(newConnections)
  }

  // 删除连接
  const handleDeleteConnection = async (connectionId) => {
    // 尝试从后端删除
    // await sftpManager.disconnect(connectionId)

    // 从前端状态中删除
    const newConnections = connections.filter(c => c.id !== connectionId)
    await saveConnections(newConnections)

    toast.success('连接删除成功', { id: 'msgBoxGlobal', style: msgBoxStyle })
  }

  // 连接到远程服务器
  const handleConnect = async (connection) => {
    setLoading(true)

    setTimeout(async () => {
      // 确保port是数字类型
      const port = parseInt(connection.port)

      // 创建连接
      const connectionId = await sftpManager.createConnection({
        host: connection.host,
        port: port,
        username: connection.username,
        password: connection.password
      })

      // 连接到服务器
      await sftpManager.connect(connectionId)

      // 获取用户主目录
      const homeDir = await sftpManager.getRemoteUserHome(connectionId)

      // 获取远程服务器驱动器
      const driveList = await sftpManager.getRemoteDrives(connectionId)

      // 更新状态
      setCurrentConnection(connection)
      setCurrentConnectionId(connectionId)
      setCurrentPath(homeDir) // 默认进入用户主目录
      setHomeDir(homeDir)
      setDrives(driveList)

      // 等待状态更新后再加载目录
      setTimeout(async () => {
        await loadRemoteDirectory(homeDir, connectionId)
      }, 100)

      toast.success('连接成功', { id: 'msgBoxGlobal', style: msgBoxStyle })
      setLoading(false)
    }, 100)
  }

  // 断开连接
  const handleDisconnect = async () => {
    if (currentConnectionId) {
      await sftpManager.disconnect(currentConnectionId)
    }

    setCurrentConnection(null)
    setCurrentConnectionId(null)
    setCurrentPath('/')
    setFiles([])
    setHomeDir('')
    setDrives([])
    toast.success('已断开连接', { id: 'msgBoxGlobal', style: msgBoxStyle })
  }

  // 加载远程目录内容
  const loadRemoteDirectory = async (path, connId = currentConnectionId) => {
    setLoading(true)

    setTimeout(async () => {
      // 检查连接状态
      if (!connId) {
        notification.error('连接错误', '未连接到服务器')
        return
      }

      // 使用SFTP工具类获取目录内容
      const files = await sftpManager.listRemoteDirectory(connId, path)

      setFiles(files)
      setCurrentPath(path)
      setLoading(false)
    }, 100)
  }

  // 处理地址栏变化
  const handlePathChange = (e) => {
    setCurrentPath(e.target.value)
  }

  // 处理地址栏回车
  const handlePathSubmit = async (e) => {
    if (e.key === 'Enter' && currentConnectionId) {
      await loadRemoteDirectory(currentPath)
    }
  }

  // 处理刷新
  const handleRefresh = async () => {
    if (currentConnectionId) {
      await loadRemoteDirectory(currentPath)
    }
  }

  // 处理文件/目录点击
  const handleItemClick = async (entry) => {
    if (entry.isDirectory && currentConnectionId) {
      setLoading(true)
      setTimeout(async () => {
        const newPath = currentPath.endsWith('/')
          ? currentPath + entry.name
          : currentPath + '/' + entry.name
        await loadRemoteDirectory(newPath)
      }, 100)
    }
  }

  // 处理返回上一级
  const handleGoBack = async () => {
    if (currentPath === '/' || !currentConnectionId) return

    setLoading(true)
    setTimeout(async () => {
      const lastSlashIndex = currentPath.lastIndexOf('/')
      if (lastSlashIndex > 0) {
        const parentPath = currentPath.substring(0, lastSlashIndex) || '/'
        await loadRemoteDirectory(parentPath)
      } else {
        await loadRemoteDirectory('/')
      }
    }, 100)
  }

  // 处理驱动器选择
  const handleDriveSelect = async (drive) => {
    setCurrentPath(drive)
    setLoading(true)
    setTimeout(async () => {
      await loadRemoteDirectory(drive)
    }, 100)
  }

  return currentConnectionId && currentConnection ? (
    <RemoteFileBrowser
      currentPath={currentPath}
      files={files}
      loading={loading}
      currentConnection={currentConnection}
      homeDir={homeDir}
      drives={drives}
      handleGoBack={handleGoBack}
      handlePathChange={handlePathChange}
      handlePathSubmit={handlePathSubmit}
      handleRefresh={handleRefresh}
      handleItemClick={handleItemClick}
      handleDriveSelect={handleDriveSelect}
      handleDisconnect={handleDisconnect}
    />
  ) : (
    <RemoteConnectionList
      connections={connections}
      handleConnect={handleConnect}
      handleDeleteConnection={handleDeleteConnection}
      onAddSuccess={loadConnections}
    />
  )
}

export default Remote