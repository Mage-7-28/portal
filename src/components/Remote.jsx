import React, { useState, useEffect } from 'react'
import { Input, Button, Dropdown, List, Spin, Typography, Modal, Form, message, Space } from 'antd'
import { UpOutlined, DownOutlined, ReloadOutlined, FolderOutlined, FileOutlined, PlusOutlined, DeleteOutlined, DisconnectOutlined } from '@ant-design/icons'
import { invoke } from '@tauri-apps/api/core'
import { store } from '../utils/storeUtils'

const { Title } = Typography

// 存储键名
const SSH_CONNECTIONS_KEY = 'ssh_connections'

function Remote() {
  // 连接相关状态
  const [ connections, setConnections ] = useState([])
  const [ currentConnection, setCurrentConnection ] = useState(null)
  const [ isConnected, setIsConnected ] = useState(false)

  // 文件浏览相关状态
  const [ currentPath, setCurrentPath ] = useState('/')
  const [ files, setFiles ] = useState([])
  const [ loading, setLoading ] = useState(false)

  // 弹窗状态
  const [ addModalVisible, setAddModalVisible ] = useState(false)
  const [addForm] = Form.useForm()

  // 初始化：加载历史连接
  useEffect(() => {
    loadConnections()
  }, [])

  // 加载存储的连接列表
  const loadConnections = async () => {
    try {
      const savedConnections = await store.get(SSH_CONNECTIONS_KEY) || []
      setConnections(savedConnections)
    } catch (error) {
      console.error('加载连接列表失败:', error)
      message.error('加载连接列表失败')
    }
  }

  // 保存连接列表到 store
  const saveConnections = async (newConnections) => {
    try {
      await store.set(SSH_CONNECTIONS_KEY, newConnections)
      setConnections(newConnections)
    } catch (error) {
      console.error('保存连接列表失败:', error)
      message.error('保存连接列表失败')
    }
  }

  // 添加新连接
  const handleAddConnection = async (values) => {
    try {
      const newConnection = {
        id: `${ values.host }-${ values.port }-${ Date.now() }`,
        host: values.host,
        port: values.port,
        username: values.username,
        password: values.password,
        name: values.name || `${ values.username }@${ values.host }:${ values.port }`,
        createdAt: new Date().toISOString()
      }

      const newConnections = [ ...connections, newConnection ]
      await saveConnections(newConnections)

      message.success('连接添加成功')
      setAddModalVisible(false)
      addForm.resetFields()
    } catch (error) {
      console.error('添加连接失败:', error)
      message.error('添加连接失败: ' + error)
    }
  }

  // 删除连接
  const handleDeleteConnection = async (connectionId) => {
    try {
      const newConnections = connections.filter(c => c.id !== connectionId)
      await saveConnections(newConnections)
      message.success('连接删除成功')
    } catch (error) {
      console.error('删除连接失败:', error)
      message.error('删除连接失败')
    }
  }

  // 连接到远程服务器
  const handleConnect = async (connection) => {
    try {
      setLoading(true)

      // 先添加到后端 SSH 管理
      await invoke('add_ssh_connection', {
        host: connection.host,
        port: connection.port,
        username: connection.username,
        password: connection.password
      })

      // 尝试连接
      const connectionId = `${ connection.host }-${ connection.port }`
      await invoke('connect_ssh', { id: connectionId })

      setCurrentConnection(connection)
      setIsConnected(true)
      setCurrentPath('/home/' + connection.username) // 默认进入用户主目录

      // 加载远程目录内容
      await loadRemoteDirectory('/home/' + connection.username)

      message.success('连接成功')
    } catch (error) {
      console.error('连接失败:', error)
      message.error('连接失败: ' + error)
    } finally {
      setLoading(false)
    }
  }

  // 断开连接
  const handleDisconnect = async () => {
    try {
      if (currentConnection) {
        const connectionId = `${ currentConnection.host }-${ currentConnection.port }`
        await invoke('disconnect_ssh', { id: connectionId })
      }

      setCurrentConnection(null)
      setIsConnected(false)
      setCurrentPath('/')
      setFiles([])
      message.success('已断开连接')
    } catch (error) {
      console.error('断开连接失败:', error)
      message.error('断开连接失败')
    }
  }

  // 加载远程目录内容
  const loadRemoteDirectory = async (path) => {
    try {
      setLoading(true)

      // 这里应该调用后端命令获取远程目录内容
      // 暂时模拟数据，后续需要实现远程文件列表获取
      const connectionId = `${ currentConnection.host }-${ currentConnection.port }`

      // 使用 SSH 命令获取目录内容
      const result = await invoke('execute_ssh_command', {
        id: connectionId,
        command: `ls -la "${ path }"`
      })

      // 解析 ls -la 的输出
      const lines = result.split('\n').filter(line => line.trim())
      const parsedFiles = []

      for (let i = 1; i < lines.length; i++) { // 跳过第一行总计
        const line = lines[i]
        const parts = line.split(/\s+/)
        if (parts.length >= 9) {
          const isDirectory = parts[0].startsWith('d')
          const name = parts.slice(8).join(' ')
          const size = isDirectory ? 0 : parseInt(parts[4]) || 0

          if (name !== '.' && name !== '..') {
            parsedFiles.push({
              name,
              isDirectory,
              size
            })
          }
        }
      }

      // 排序：目录在前，文件在后
      parsedFiles.sort((a, b) => {
        if (a.isDirectory && !b.isDirectory) return -1
        if (!a.isDirectory && b.isDirectory) return 1
        return a.name.localeCompare(b.name)
      })

      setFiles(parsedFiles)
      setCurrentPath(path)
    } catch (error) {
      console.error('加载远程目录失败:', error)
      message.error('加载远程目录失败: ' + error)
      setFiles([])
    } finally {
      setLoading(false)
    }
  }

  // 处理地址栏变化
  const handlePathChange = (e) => {
    setCurrentPath(e.target.value)
  }

  // 处理地址栏回车
  const handlePathSubmit = async (e) => {
    if (e.key === 'Enter') {
      await loadRemoteDirectory(currentPath)
    }
  }

  // 处理刷新
  const handleRefresh = async () => {
    await loadRemoteDirectory(currentPath)
  }

  // 处理文件/目录点击
  const handleItemClick = async (entry) => {
    if (entry.isDirectory) {
      const newPath = currentPath.endsWith('/')
        ? currentPath + entry.name
        : currentPath + '/' + entry.name
      await loadRemoteDirectory(newPath)
    }
  }

  // 处理返回上一级
  const handleGoBack = async () => {
    if (currentPath === '/') return

    const lastSlashIndex = currentPath.lastIndexOf('/')
    if (lastSlashIndex > 0) {
      const parentPath = currentPath.substring(0, lastSlashIndex) || '/'
      await loadRemoteDirectory(parentPath)
    } else {
      await loadRemoteDirectory('/')
    }
  }

  // 格式化文件大小
  const formatFileSize = (bytes) => {
    if (bytes === 0) return ''
    const k = 1024
    const sizes = [ 'B', 'KB', 'MB', 'GB', 'TB' ]
    const i = Math.floor(Math.log(bytes) / Math.log(k))
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]
  }

  // 渲染连接列表视图（未连接状态）
  const renderConnectionList = () => (
    <div style={{ padding: '16px', height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{ marginBottom: '16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h3 style={{ color: '#ffffff', margin: 0, fontSize: '16px', fontWeight: '600' }}>SSH 连接管理</h3>
        <Button
          type="primary"
          icon={<PlusOutlined />}
          size="small"
          style={{
            backgroundColor: 'rgb(224, 82, 156)',
            border: '1px solid rgb(224, 82, 156)',
            color: '#ffffff',
            height: '32px',
            fontSize: '12px'
          }}
          onClick={() => setAddModalVisible(true)}
        >
          新建连接
        </Button>
      </div>

      <div style={{ flex: 1, overflow: 'auto' }}>
        {connections.length === 0 ? (
          <div style={{
            padding: '40px 20px',
            textAlign: 'center',
            color: '#888888',
            backgroundColor: '#0C0D0E',
            borderRadius: '8px',
            marginTop: '20px'
          }}>
            <p>暂无历史连接</p>
            <p style={{ fontSize: '12px', marginTop: '8px' }}>点击上方"新建连接"按钮添加 SSH 连接</p>
          </div>
        ) : (
          <List
            itemLayout="horizontal"
            dataSource={connections}
            style={{ maxHeight: '100%' }}
            renderItem={item => (
              <List.Item
                style={{
                  backgroundColor: '#1E1E1E',
                  borderRadius: '8px',
                  marginBottom: '10px',
                  padding: '12px',
                  border: '1px solid #2B2D30'
                }}
                actions={[
                  <Button
                    type="primary"
                    size="small"
                    style={{
                      backgroundColor: 'rgb(224, 82, 156)',
                      border: '1px solid rgb(224, 82, 156)',
                      color: '#ffffff',
                      fontSize: '12px'
                    }}
                    onClick={() => handleConnect(item)}
                    loading={loading}
                  >
                    连接
                  </Button>,
                  <Button
                    danger
                    size="small"
                    icon={<DeleteOutlined />}
                    style={{
                      fontSize: '12px'
                    }}
                    onClick={() => handleDeleteConnection(item.id)}
                  >
                    删除
                  </Button>
                ]}
              >
                <List.Item.Meta
                  title={<span style={{ color: '#ffffff', fontSize: '14px' }}>{item.name}</span>}
                  description={
                    <span style={{ color: '#888888', fontSize: '12px' }}>
                      {item.host}:{item.port} ({item.username})
                    </span>
                  }
                />
              </List.Item>
            )}
          />
        )}
      </div>

      {/* 添加连接弹窗 */}
      <Modal
        title="新建 SSH 连接"
        open={addModalVisible}
        onCancel={() => {
          setAddModalVisible(false)
          addForm.resetFields()
        }}
        centered={true}
        footer={null}
        width={500}
        style={{
          backgroundColor: '#101113',
          borderRadius: '8px'
        }}
        bodyStyle={{
          padding: 0
        }}
      >
        <div style={{ padding: '24px' }}>
          <Form
            form={addForm}
            onFinish={handleAddConnection}
            layout="vertical"
          >
            {/* 连接基本信息 */}
            <div style={{ marginBottom: '24px' }}>
              <h4 style={{ 
                color: '#ffffff', 
                marginBottom: '16px', 
                fontSize: '14px', 
                fontWeight: '600',
                borderBottom: '1px solid #3E4148',
                paddingBottom: '8px'
              }}>
                连接基本信息
              </h4>
              <Form.Item
                name="name"
                label="连接名称"
                rules={[{ required: true, message: '请输入连接名称' }]}
              >
                <Input placeholder="例如：我的服务器" />
              </Form.Item>
            </div>

            {/* 服务器信息 */}
            <div style={{ marginBottom: '24px' }}>
              <h4 style={{ 
                color: '#ffffff', 
                marginBottom: '16px', 
                fontSize: '14px', 
                fontWeight: '600',
                borderBottom: '1px solid #3E4148',
                paddingBottom: '8px'
              }}>
                服务器信息
              </h4>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
                <Form.Item
                  name="host"
                  label="主机地址"
                  rules={[{ required: true, message: '请输入主机地址' }]}
                >
                  <Input placeholder="例如：192.168.1.1" />
                </Form.Item>
                <Form.Item
                  name="port"
                  label="端口"
                  initialValue={22}
                  rules={[{ required: true, message: '请输入端口' }]}
                >
                  <Input type="number" placeholder="22" />
                </Form.Item>
              </div>
            </div>

            {/* 认证信息 */}
            <div style={{ marginBottom: '24px' }}>
              <h4 style={{ 
                color: '#ffffff', 
                marginBottom: '16px', 
                fontSize: '14px', 
                fontWeight: '600',
                borderBottom: '1px solid #3E4148',
                paddingBottom: '8px'
              }}>
                认证信息
              </h4>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
                <Form.Item
                  name="username"
                  label="用户名"
                  rules={[{ required: true, message: '请输入用户名' }]}
                >
                  <Input placeholder="例如：root" />
                </Form.Item>
                <Form.Item
                  name="password"
                  label="密码"
                  rules={[{ required: true, message: '请输入密码' }]}
                >
                  <Input.Password placeholder="请输入密码" />
                </Form.Item>
              </div>
            </div>

            {/* 操作按钮 */}
            <Form.Item style={{ marginBottom: 0 }}>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '16px' }}>
                <Button onClick={() => {
                  setAddModalVisible(false)
                  addForm.resetFields()
                }}>
                  取消
                </Button>
                <Button type="primary" htmlType="submit">
                  保存
                </Button>
              </div>
            </Form.Item>
          </Form>
        </div>
      </Modal>
    </div>
  )

  // 渲染文件浏览器视图（已连接状态）
  const renderFileBrowser = () => (
    <div style={{ borderRadius: '8px', backgroundColor: '#101113', padding: 12, display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* 地址栏 */}
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 12 }}>
        <Button
          onClick={handleGoBack}
          icon={<UpOutlined />}
          size="small"
          style={{
            backgroundColor: '#2B2D30',
            border: '1px solid #3E4148',
            color: '#ffffff',
            borderTopRightRadius: 0,
            borderBottomRightRadius: 0,
            height: '32px'
          }}
        />

        <Input
          value={currentPath}
          onChange={handlePathChange}
          onKeyPress={handlePathSubmit}
          size="small"
          style={{
            flex: 1,
            backgroundColor: '#2B2D30',
            border: '1px solid #3E4148',
            borderLeft: 'none',
            borderRight: 'none',
            color: '#ffffff',
            height: '32px',
            fontSize: '13px'
          }}
        />

        <Button
          onClick={handleRefresh}
          icon={<ReloadOutlined />}
          size="small"
          style={{
            backgroundColor: '#2B2D30',
            border: '1px solid #3E4148',
            borderLeft: 'none',
            color: '#ffffff',
            borderTopLeftRadius: 0,
            borderBottomLeftRadius: 0,
            height: '32px'
          }}
        />
      </div>

      {/* 连接信息栏 */}
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: 12,
        padding: '6px 10px',
        backgroundColor: '#1E1E1E',
        borderRadius: '4px',
        fontSize: '12px'
      }}>
        <span style={{ color: '#4EC9B0', fontSize: '12px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          已连接: {currentConnection?.name} ({currentConnection?.host}:{currentConnection?.port})
        </span>
        <Button
          danger
          size="small"
          icon={<DisconnectOutlined />}
          style={{
            fontSize: '11px',
            height: '28px'
          }}
          onClick={handleDisconnect}
        >
          断开
        </Button>
      </div>

      {/* 文件列表 */}
      <div style={{ flex: 1, overflow: 'auto', backgroundColor: '#0C0D0E', borderRadius: '4px' }}>
        {loading ? (
          <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '150px' }}>
            <Spin size="small" description="加载中..." />
          </div>
        ) : files.length === 0 ? (
          <div style={{ padding: '30px', textAlign: 'center', color: '#888888', fontSize: '13px' }}>
            该目录为空
          </div>
        ) : (
          <List
            itemLayout="horizontal"
            dataSource={files}
            renderItem={(entry, index) => (
              <List.Item
                key={index}
                onClick={() => handleItemClick(entry)}
                style={{
                  cursor: entry.isDirectory ? 'pointer' : 'default',
                  borderBottom: '1px solid #1E1E1E',
                  padding: '10px',
                  fontSize: '13px'
                }}
              >
                <List.Item.Meta
                  avatar={
                    entry.isDirectory ?
                      <FolderOutlined style={{ color: '#4EC9B0', fontSize: '14px' }} /> :
                      <FileOutlined style={{ color: '#ffffff', fontSize: '14px' }} />
                  }
                  title={
                    <span style={{ color: entry.isDirectory ? '#4EC9B0' : '#ffffff', fontSize: '13px' }}>
                      {entry.name}
                    </span>
                  }
                />
                <span style={{ color: '#888888', fontSize: '11px' }}>
                  {entry.isDirectory ? '' : formatFileSize(entry.size)}
                </span>
              </List.Item>
            )}
          />
        )}
      </div>
    </div>
  )

  return isConnected ? renderFileBrowser() : renderConnectionList()
}

export default Remote