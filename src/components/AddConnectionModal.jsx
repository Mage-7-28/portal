import React, { useState } from 'react'
import { Modal, Form, Input, Button } from 'antd'
import { CheckCircleOutlined, CloseCircleOutlined } from '@ant-design/icons'
import { store } from '../utils/storeUtils'
import sftpManager from '../utils/sftpUtils'
import toast from 'react-hot-toast'
import { msgBoxStyle } from '../style/LayoutStyle.js'

const SSH_CONNECTIONS_KEY = 'ssh_connections'

const AddConnectionModal = ({ visible, onCancel }) => {
  const [addForm] = Form.useForm()
  const [ testing, setTesting ] = useState(false)
  const [ testResult, setTestResult ] = useState(null)

  // 测试连接
  const handleTestConnection = async () => {
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
    setTesting(false)
  }

  // 保存连接列表到 store
  const saveConnections = async (newConnections) => {
    // 按创建时间排序，最新的在前面
    newConnections.sort((a, b) => {
      return new Date(b.createdAt) - new Date(a.createdAt)
    })
    await store.set(SSH_CONNECTIONS_KEY, newConnections)
  }

  // 添加新连接
  const handleAddConnection = async (values) => {
    const newConnection = {
      id: `${ values.host }-${ values.port }-${ values.username }-${ Date.now() }`,
      host: values.host,
      port: values.port,
      username: values.username,
      password: values.password,
      name: values.name || `${ values.username }@${ values.host }:${ values.port }`,
      createdAt: new Date().toISOString()
    }

    // 加载现有连接
    const existingConnections = await store.get(SSH_CONNECTIONS_KEY) || []
    const newConnections = [ newConnection, ...existingConnections ]
    await saveConnections(newConnections)

    toast.success('连接添加成功！', { id: 'msgBoxGlobal', style: msgBoxStyle })
    onCancel()
    addForm.resetFields()
    setTestResult(null)
  }

  return (
    <Modal
      title="新建 SSH 连接"
      open={visible}
      onCancel={() => {
        onCancel()
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
                  onCancel()
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
  )
}

export default AddConnectionModal