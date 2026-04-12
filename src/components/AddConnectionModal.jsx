import React, { useState, useEffect } from 'react'
import { Modal, Form, Input, Button, Space, Tooltip } from 'antd'
import { CheckCircleOutlined, CloseCircleOutlined, LockOutlined, UserOutlined, FieldTimeOutlined, CloudServerOutlined, WifiOutlined } from '@ant-design/icons'
import { store } from '../utils/storeUtils'
import sftpManager from '../utils/sftpUtils'
import toast from 'react-hot-toast'
import { msgBoxStyle } from '../style/LayoutStyle.js'

const SSH_CONNECTIONS_KEY = 'ssh_connections'

const AddConnectionModal = ({ visible, onCancel, onAddSuccess }) => {
  const [addForm] = Form.useForm()
  const [ testing, setTesting ] = useState(false)
  const [ testResult, setTestResult ] = useState(null)
  const [ isAnimating, setIsAnimating ] = useState(false)

  useEffect(() => {
    if (visible) {
      setIsAnimating(true)
      setTimeout(() => setIsAnimating(false), 300)
    }
  }, [visible])

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
    onAddSuccess()
    onCancel()
    addForm.resetFields()
    setTestResult(null)
  }

  return (
    <Modal
      title={null}
      open={visible}
      onCancel={() => {
        onCancel()
        addForm.resetFields()
        setTestResult(null)
      }}
      centered={true}
      footer={null}
      width={480}
      closable={false}
      style={{
        backgroundColor: '#1a1b1f',
        borderRadius: '10px',
        boxShadow: '0 15px 30px rgba(0, 0, 0, 0.4)',
        transform: isAnimating ? 'scale(0.95)' : 'scale(1)',
        opacity: isAnimating ? 0 : 1,
        transition: 'all 0.3s ease-out'
      }}
      styles={{
        body: {
          padding: '16px',
          border: 'none'
        },
        mask: {
          backgroundColor: 'rgba(0, 0, 0, 0.7)',
          backdropFilter: 'blur(8px)'
        }
      }}
    >
      {/* 标题区域 */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        marginBottom: '24px',
        paddingBottom: '12px',
        borderBottom: '1px solid #2d2e32'
      }}>
        <CloudServerOutlined style={{ fontSize: '20px', color: '#4caf50', marginRight: '10px' }} />
        <h2 style={{
          fontSize: '18px',
          fontWeight: '600',
          color: '#ffffff',
          margin: 0
        }}>新建 SSH 连接</h2>
      </div>

      <Form
        form={addForm}
        onFinish={handleAddConnection}
        layout="vertical"
      >
        {/* 连接名称 */}
        <Form.Item
          name="name"
          label={
            <div style={{ display: 'flex', alignItems: 'center', color: '#b0b0b0' }}>
              <WifiOutlined style={{ marginRight: '8px' }} />
              连接名称
            </div>
          }
          rules={[{ required: true, message: '请输入连接名称' }]}
          style={{
            marginBottom: '16px'
          }}
        >
          <Input
            placeholder="例如：我的服务器"
            style={{
              backgroundColor: '#25262a',
              border: '1px solid #3a3b3f',
              borderRadius: '6px',
              color: '#ffffff',
              height: '42px',
              fontSize: '14px',
              '&:focus': {
                borderColor: '#4caf50',
                boxShadow: '0 0 0 2px rgba(76, 175, 80, 0.2)'
              }
            }}
          />
        </Form.Item>

        {/* 主机和端口 */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '16px' }}>
          <Form.Item
            name="host"
            label={
              <div style={{ display: 'flex', alignItems: 'center', color: '#b0b0b0' }}>
                <CloudServerOutlined style={{ marginRight: '8px', fontSize: '14px' }} />
                主机地址
              </div>
            }
            rules={[{ required: true, message: '请输入主机地址' }]}
          >
            <Input
              placeholder="例如：192.168.1.1"
              style={{
                backgroundColor: '#25262a',
                border: '1px solid #3a3b3f',
                borderRadius: '6px',
                color: '#ffffff',
                height: '42px',
                fontSize: '14px',
                '&:focus': {
                  borderColor: '#4caf50',
                  boxShadow: '0 0 0 2px rgba(76, 175, 80, 0.2)'
                }
              }}
            />
          </Form.Item>
          <Form.Item
            name="port"
            label={
              <div style={{ display: 'flex', alignItems: 'center', color: '#b0b0b0' }}>
                <FieldTimeOutlined style={{ marginRight: '8px', fontSize: '14px' }} />
                端口
              </div>
            }
            initialValue={22}
            rules={[{ required: true, message: '请输入端口' }]}
          >
            <Input
              type="number"
              placeholder="22"
              style={{
                backgroundColor: '#25262a',
                border: '1px solid #3a3b3f',
                borderRadius: '6px',
                color: '#ffffff',
                height: '42px',
                fontSize: '14px',
                '&:focus': {
                  borderColor: '#4caf50',
                  boxShadow: '0 0 0 2px rgba(76, 175, 80, 0.2)'
                }
              }}
            />
          </Form.Item>
        </div>

        {/* 用户名和密码 */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '24px' }}>
          <Form.Item
            name="username"
            label={
              <div style={{ display: 'flex', alignItems: 'center', color: '#b0b0b0' }}>
                <UserOutlined style={{ marginRight: '8px', fontSize: '14px' }} />
                用户名
              </div>
            }
            rules={[{ required: true, message: '请输入用户名' }]}
          >
            <Input
              placeholder="例如：root"
              style={{
                backgroundColor: '#25262a',
                border: '1px solid #3a3b3f',
                borderRadius: '6px',
                color: '#ffffff',
                height: '42px',
                fontSize: '14px',
                '&:focus': {
                  borderColor: '#4caf50',
                  boxShadow: '0 0 0 2px rgba(76, 175, 80, 0.2)'
                }
              }}
            />
          </Form.Item>
          <Form.Item
            name="password"
            label={
              <div style={{ display: 'flex', alignItems: 'center', color: '#b0b0b0' }}>
                <LockOutlined style={{ marginRight: '8px', fontSize: '14px' }} />
                密码
              </div>
            }
            rules={[{ required: true, message: '请输入密码' }]}
          >
            <Input.Password
              placeholder="请输入密码"
              style={{
                backgroundColor: '#25262a',
                border: '1px solid #3a3b3f',
                borderRadius: '6px',
                color: '#ffffff',
                height: '42px',
                fontSize: '14px',
                '&:focus': {
                  borderColor: '#4caf50',
                  boxShadow: '0 0 0 2px rgba(76, 175, 80, 0.2)'
                }
              }}
              iconRender={(visible) => (
                <LockOutlined
                  style={{
                    color: visible ? '#4caf50' : '#666',
                    fontSize: '14px'
                  }}
                />
              )}
            />
          </Form.Item>
        </div>

        {/* 测试结果提示 */}
        {testResult && (
          <div style={{
            marginBottom: '16px',
            padding: '12px',
            borderRadius: '6px',
            backgroundColor: testResult.success ? 'rgba(76, 175, 80, 0.1)' : 'rgba(244, 67, 54, 0.1)',
            border: `1px solid ${ testResult.success ? '#4caf50' : '#f44336' }`,
            color: testResult.success ? '#4caf50' : '#f44336',
            animation: 'slideIn 0.3s ease-out'
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              {testResult.success ?
                <CheckCircleOutlined style={{ fontSize: '16px' }} /> :
                <CloseCircleOutlined style={{ fontSize: '16px' }} />
              }
              <span style={{ fontSize: '13px', fontWeight: '500' }}>
                {testResult.success ? '连接测试成功' : `连接失败: ${ testResult.error }`}
              </span>
            </div>
          </div>
        )}

        {/* 操作按钮 */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
          <Button
            onClick={() => {
              onCancel()
              addForm.resetFields()
              setTestResult(null)
            }}
            style={{
              backgroundColor: '#25262a',
              border: '1px solid #3a3b3f',
              borderRadius: '6px',
              color: '#ffffff',
              height: '36px',
              minWidth: '80px',
              fontSize: '13px',
              fontWeight: '500',
              '&:hover': {
                backgroundColor: '#2d2e32',
                borderColor: '#4a4b4f'
              }
            }}
          >
            取消
          </Button>
          <Button
            onClick={handleTestConnection}
            loading={testing}
            style={{
              backgroundColor: 'transparent',
              border: `1px solid ${ testResult ? (testResult.success ? '#4caf50' : '#f44336') : '#3a3b3f' }`,
              borderRadius: '6px',
              color: testResult ? (testResult.success ? '#4caf50' : '#f44336') : '#ffffff',
              height: '36px',
              minWidth: '100px',
              fontSize: '13px',
              fontWeight: '500',
              '&:hover': {
                backgroundColor: testResult ? (testResult.success ? 'rgba(76, 175, 80, 0.1)' : 'rgba(244, 67, 54, 0.1)') : 'rgba(255, 255, 255, 0.05)'
              }
            }}
            icon={testResult ? (testResult.success ? <CheckCircleOutlined style={{ fontSize: '14px' }} /> : <CloseCircleOutlined style={{ fontSize: '14px' }} />) : null}
          >
            {testing ? '测试中...' : '测试连接'}
          </Button>
          <Button
            type="primary"
            htmlType="submit"
            style={{
              backgroundColor: '#4caf50',
              border: 'none',
              borderRadius: '6px',
              color: '#ffffff',
              height: '36px',
              minWidth: '80px',
              fontSize: '13px',
              fontWeight: '500',
              '&:hover': {
                backgroundColor: '#45a049'
              },
              '&:active': {
                backgroundColor: '#3d8b40'
              }
            }}
          >
            保存
          </Button>
        </div>
      </Form>

      {/* 样式 */}
      <style jsx>{`
        @keyframes slideIn {
          from {
            opacity: 0;
            transform: translateY(-10px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }
      `}</style>
    </Modal>
  )
}

export default AddConnectionModal