import React, { useState, useEffect } from 'react'
import { Input, Button, Dropdown, List, Spin, Typography, Modal, Form, Space } from 'antd'
import { UpOutlined, DownOutlined, ReloadOutlined, FolderOutlined, FileOutlined, PlusOutlined, DeleteOutlined, DisconnectOutlined, CheckCircleOutlined, CloseCircleOutlined } from '@ant-design/icons'
import { store } from '../utils/storeUtils'
import sftpManager from '../utils/sftpUtils'
import toast from 'react-hot-toast'
import { msgBoxStyle } from '../style/LayoutStyle.js'

const { Title } = Typography

// 存储键名
const SSH_CONNECTIONS_KEY = 'ssh_connections'

function Remote() {
  // 连接相关状态
  const [ connections, setConnections ] = useState([])
  const [ currentConnection, setCurrentConnection ] = useState(null)
  const [ isConnected, setIsConnected ] = useState(false)
  const [ currentConnectionId, setCurrentConnectionId ] = useState(null)

  // 文件浏览相关状态
  const [ currentPath, setCurrentPath ] = useState('/')
  const [ files, setFiles ] = useState([])
  const [ loading, setLoading ] = useState(false)

  // 弹窗状态
  const [ addModalVisible, setAddModalVisible ] = useState(false)
  const [addForm] = Form.useForm()

  // 测试连接状态
  const [ testing, setTesting ] = useState(false)
  const [ testResult, setTestResult ] = useState(null)

  // 初始化：加载历史连接
  useEffect(() => {
    loadConnections()
  }, [])

  // 加载存储的连接列表
  const loadConnections = async () => {
    try {
      const savedConnections = await store.get(SSH_CONNECTIONS_KEY) || []
      // 按创建时间排序，最新的在前面
      savedConnections.sort((a, b) => {
        return new Date(b.createdAt) - new Date(a.createdAt)
      })
      setConnections(savedConnections)
    } catch (error) {
      console.error('加载连接列表失败:', error)
      toast.error('加载连接列表失败！', { id: 'msgBoxGlobal', style: msgBoxStyle })
    }
  }

  // 保存连接列表到 store
  const saveConnections = async (newConnections) => {
    try {
      // 按创建时间排序，最新的在前面
      newConnections.sort((a, b) => {
        return new Date(b.createdAt) - new Date(a.createdAt)
      })
      await store.set(SSH_CONNECTIONS_KEY, newConnections)
      setConnections(newConnections)
    } catch (error) {
      console.error('保存连接列表失败:', error)
      toast.error('保存连接列表失败！', { id: 'msgBoxGlobal', style: msgBoxStyle })
    }
  }

  // 添加新连接
  const handleAddConnection = async (values) => {
    try {
      const newConnection = {
        id: `${ values.host }-${ values.port }-${ values.username }-${ Date.now() }`,
        host: values.host,
        port: values.port,
        username: values.username,
        password: values.password,
        name: values.name || `${ values.username }@${ values.host }:${ values.port }`,
        createdAt: new Date().toISOString()
      }

      const newConnections = [ newConnection, ...connections ]
      await saveConnections(newConnections)

      toast.success('连接添加成功！', { id: 'msgBoxGlobal', style: msgBoxStyle })
      setAddModalVisible(false)
      addForm.resetFields()
      setTestResult(null)
    } catch (error) {
      console.error('添加连接失败:', error)
      toast.error(`添加连接失败: ${ error.message }`, { id: 'msgBoxGlobal', style: msgBoxStyle })
    }
  }

  // 测试连接
  const handleTestConnection = async () => {
    try {
      const values = await addForm.validateFields()
      setTesting(true)
      setTestResult(null)

      const result = await sftpManager.testConnection({
        host: values.host,
        port: parseInt(values.port),
        username: values.username,
        password: values.password
      })

      setTestResult(result)

      if (result.success) {
        toast.success('连接测试成功', { id: 'msgBoxGlobal', style: msgBoxStyle })
      } else {
        toast.error(`连接测试失败: ${ result.error }`, { id: 'msgBoxGlobal', style: msgBoxStyle })
      }
    } catch (error) {
      console.error('测试连接失败:', error)
      const result = {
        success: false,
        error: error.message || '测试连接失败'
      }
      setTestResult(result)
      toast.error(`测试连接失败: ${ result.error }`, { id: 'msgBoxGlobal', style: msgBoxStyle })
    } finally {
      setTesting(false)
    }
  }

  // 删除连接
  const handleDeleteConnection = async (connectionId) => {
    try {
      // 尝试从后端删除
      try {
        await sftpManager.disconnect(connectionId)
      } catch (error) {
        // 如果后端删除失败（例如连接不存在），仍然继续从前端删除
        console.warn('后端删除连接失败，继续从前端删除:', error)
      }

      // 从前端状态中删除
      const newConnections = connections.filter(c => c.id !== connectionId)
      await saveConnections(newConnections)

      toast.success('连接删除成功', { id: 'msgBoxGlobal', style: msgBoxStyle })
    } catch (error) {
      console.error('删除连接失败:', error)
      toast.error('删除连接失败', { id: 'msgBoxGlobal', style: msgBoxStyle })
    }
  }

  // 连接到远程服务器
  const handleConnect = async (connection) => {
    try {
      setLoading(true)

      setTimeout(async () => {
        try {
          // 创建连接
          const connectionId = await sftpManager.createConnection({
            host: connection.host,
            port: connection.port,
            username: connection.username,
            password: connection.password
          })

          // 连接到服务器
          await sftpManager.connect(connectionId)

          // 更新状态
          setCurrentConnection(connection)
          setCurrentConnectionId(connectionId)
          setIsConnected(true)
          setCurrentPath('/home/' + connection.username) // 默认进入用户主目录

          // 等待状态更新后再加载目录
          setTimeout(async () => {
            try {
              await loadRemoteDirectory('/home/' + connection.username, connectionId)
            } catch (error) {
              console.error('加载远程目录失败:', error)
              toast.error(`加载远程目录失败: ${ error.message }`, { id: 'msgBoxGlobal', style: msgBoxStyle })
            }
          }, 100)

          toast.success('连接成功', { id: 'msgBoxGlobal', style: msgBoxStyle })
        } catch (error) {
          console.error('连接失败:', error)
          toast.error(`连接失败: ${ error.message }`, { id: 'msgBoxGlobal', style: msgBoxStyle })
        } finally {
          setLoading(false)
        }
      }, 100)
    } catch (error) {
      console.error('连接失败:', error)
      toast.error(`连接失败: ${ error.message }`, { id: 'msgBoxGlobal', style: msgBoxStyle })
      setLoading(false)
    }
  }

  // 断开连接
  const handleDisconnect = async () => {
    try {
      if (currentConnectionId) {
        await sftpManager.disconnect(currentConnectionId)
      }

      setCurrentConnection(null)
      setCurrentConnectionId(null)
      setIsConnected(false)
      setCurrentPath('/')
      setFiles([])
      toast.success('已断开连接', { id: 'msgBoxGlobal', style: msgBoxStyle })
    } catch (error) {
      console.error('断开连接失败:', error)
      toast.error('断开连接失败', { id: 'msgBoxGlobal', style: msgBoxStyle })
    }
  }

  // 加载远程目录内容
  const loadRemoteDirectory = async (path, connId = currentConnectionId) => {
    try {
      setLoading(true)

      setTimeout(async () => {
        try {
          // 检查连接状态
          if (!connId) {
            throw new Error('未连接到服务器')
          }

          // 使用SFTP工具类获取目录内容
          const files = await sftpManager.listRemoteDirectory(connId, path)

          setFiles(files)
          setCurrentPath(path)
        } catch (error) {
          console.error('加载远程目录失败:', error)
          toast.error(`加载远程目录失败: ${ error.message }`, { id: 'msgBoxGlobal', style: msgBoxStyle })
          setFiles([])
        } finally {
          setLoading(false)
        }
      }, 100)
    } catch (error) {
      console.error('加载远程目录失败:', error)
      toast.error(`加载远程目录失败: ${ error.message }`, { id: 'msgBoxGlobal', style: msgBoxStyle })
      setFiles([])
      setLoading(false)
    }
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

  // 构建下拉菜单
  const menuItems = [
    // 添加根目录选项
    {
      key: 'root',
      label: (
        <div key="root" onClick={() => {
          setLoading(true)
          setTimeout(() => {
            loadRemoteDirectory('/')
          }, 100)
        }}>
          / (根目录)
        </div>
      )
    },
    // 添加分隔线
    {
      key: 'divider',
      type: 'divider'
    },
    // 添加用户主目录选项
    {
      key: 'home',
      label: (
        <div key="home" onClick={() => {
          const homePath = '/home/' + (currentConnection?.username || '')
          setLoading(true)
          setTimeout(() => {
            loadRemoteDirectory(homePath)
          }, 100)
        }}>
          /home/{currentConnection?.username || 'user'}
        </div>
      )
    }
  ]

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
    <div style={{ padding: '12px', height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{ marginBottom: '12px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h3 style={{ color: '#ffffff', margin: 0, fontSize: '14px', fontWeight: '600' }}>SSH 连接管理</h3>
        <Button
          type="primary"
          icon={<PlusOutlined />}
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
          setTestResult(null)
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
            <div style={{ marginBottom: '24px' }}>
              <Form.Item
                name="name"
                label="连接名称"
                rules={[{ required: true, message: '请输入连接名称' }]}
              >
                <Input placeholder="例如：我的服务器" />
              </Form.Item>
            </div>

            <div style={{ marginBottom: '24px' }}>
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

            <div style={{ marginBottom: '24px' }}>
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
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: '16px' }}>
                <div style={{ display: 'flex', gap: '16px' }}>
                  <Button onClick={() => {
                    setAddModalVisible(false)
                    addForm.resetFields()
                    setTestResult(null)
                  }}>
                    取消
                  </Button>
                  <Button
                    onClick={handleTestConnection}
                    loading={testing}
                    icon={testResult ? (testResult.success ? <CheckCircleOutlined /> : <CloseCircleOutlined />) : null}
                    style={{
                      borderColor: testResult ? (testResult.success ? '#52c41a' : '#ff4d4f') : undefined,
                      color: testResult ? (testResult.success ? '#52c41a' : '#ff4d4f') : undefined
                    }}
                  >
                    {testing ? '测试中...' : '测试连接'}
                  </Button>
                </div>
                <Button type="primary" htmlType="submit">
                  保存
                </Button>
              </div>
            </Form.Item>

            {/* 测试结果提示 */}
            {testResult && (
              <div style={{
                marginTop: '16px',
                padding: '12px',
                borderRadius: '4px',
                backgroundColor: testResult.success ? 'rgba(82, 196, 26, 0.1)' : 'rgba(255, 77, 79, 0.1)',
                border: `1px solid ${ testResult.success ? '#52c41a' : '#ff4d4f' }`,
                color: testResult.success ? '#52c41a' : '#ff4d4f'
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  {testResult.success ? <CheckCircleOutlined /> : <CloseCircleOutlined />}
                  <span>{testResult.success ? '连接测试成功' : `连接失败: ${ testResult.error }`}</span>
                </div>
              </div>
            )}
          </Form>
        </div>
      </Modal>
    </div>
  )

  // 渲染文件浏览器视图（已连接状态）
  const renderFileBrowser = () => (
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
      <div style={{ height: 'calc(100vh - 135px)', overflow: 'auto', backgroundColor: '#0C0D0E', borderRadius: '4px' }}>
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
              <List.Item
                key={index}
                onClick={() => handleItemClick(entry)}
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
            )}
          />
        )}
      </div>
    </div>
  )

  return isConnected && currentConnection ? renderFileBrowser() : renderConnectionList()
}

export default Remote
