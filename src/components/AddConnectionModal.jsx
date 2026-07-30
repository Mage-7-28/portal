import React, { useEffect, useState } from 'react'
import { Button, Form, Input, Modal, Radio, Space, Typography } from 'antd'
import { CheckCircleOutlined, CloudServerOutlined, FileOutlined, KeyOutlined, LockOutlined, UserOutlined, WifiOutlined } from '@ant-design/icons'
import * as dialog from '@tauri-apps/plugin-dialog'
import toast from 'react-hot-toast'
import sftpManager from '../utils/sftpUtils.js'
import { msgBoxStyle, normalizeError, THEME_DANGER, THEME_SUCCESS, THEME_TEXT_SECONDARY } from '../utils/constants.js'

const { Text } = Typography

const newId = () => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return `connection-${ Date.now() }`
}

const AddConnectionModal = ({ visible, onCancel, onAddSuccess }) => {
  const [form] = Form.useForm()
  const [ testing, setTesting ] = useState(false)
  const [ testResult, setTestResult ] = useState(null)
  const authMethod = Form.useWatch('authMethod', form) || 'password'

  useEffect(() => {
    if (!visible) {
      form.resetFields()
      setTestResult(null)
      setTesting(false)
    }
  }, [ form, visible ])

  const handleTestConnection = async () => {
    try {
      const values = await form.validateFields()
      setTesting(true)
      const result = await sftpManager.testConnection({
        host: values.host.trim(),
        port: Number(values.port),
        username: values.username.trim(),
        password: values.password,
        authMethod: values.authMethod,
        privateKeyPath: values.privateKeyPath,
        passphrase: values.passphrase,
        hostKeyFingerprint: testResult?.hostKey?.fingerprint
      })
      setTestResult(result)
      if (result.success) {
        toast.success('连接测试成功', { id: 'msgBoxGlobal', style: msgBoxStyle })
      } else if (result.requiresHostKeyConfirmation) {
        toast.success('已获取服务器指纹，保存后将用于校验', { id: 'msgBoxGlobal', style: msgBoxStyle })
      } else {
        toast.error(`连接测试失败：${ result.error }`, { id: 'msgBoxGlobal', style: msgBoxStyle })
      }
    } catch (error) {
      if (error?.errorFields) return
      toast.error(`连接测试失败：${ normalizeError(error) }`, { id: 'msgBoxGlobal', style: msgBoxStyle })
    } finally {
      setTesting(false)
    }
  }

  const handleSubmit = async (values) => {
    const profile = {
      id: newId(),
      name: values.name.trim(),
      host: values.host.trim(),
      port: Number(values.port),
      username: values.username.trim(),
      authMethod: values.authMethod,
      privateKeyPath: values.privateKeyPath || null,
      hostKeyFingerprint: testResult?.hostKey?.fingerprint || null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }

    try {
      await onAddSuccess(profile, { password: values.password || '', passphrase: values.passphrase || '' })
      toast.success('连接配置已保存，凭据仅保存在当前会话', { id: 'msgBoxGlobal', style: msgBoxStyle })
      onCancel()
    } catch (error) {
      toast.error(`保存连接失败：${ normalizeError(error) }`, { id: 'msgBoxGlobal', style: msgBoxStyle })
    }
  }

  return (
    <Modal
      title="新建 SSH 连接"
      open={visible}
      onCancel={onCancel}
      centered
      footer={null}
      width="min(480px, calc(100vw - 32px))"
      destroyOnHidden
    >
      <Form
        form={form}
        layout="vertical"
        onFinish={handleSubmit}
        onValuesChange={() => setTestResult(null)}
        requiredMark="optional"
      >
        <Form.Item
          name="name"
          label={<span><WifiOutlined /> 连接名称</span>}
          rules={[{ required: true, whitespace: true, message: '请输入连接名称' }]}
        >
          <Input placeholder="例如：生产服务器" autoFocus />
        </Form.Item>

        <Space.Compact block>
          <Form.Item
            name="host"
            label={<span><CloudServerOutlined /> 主机地址</span>}
            rules={[{ required: true, whitespace: true, message: '请输入主机地址' }]}
            style={{ flex: 1 }}
          >
            <Input placeholder="example.com 或 192.168.1.10" />
          </Form.Item>
          <Form.Item
            name="port"
            label="端口"
            initialValue={22}
            rules={[{ required: true, type: 'number', min: 1, max: 65535, message: '端口范围为 1-65535' }]}
            getValueFromEvent={event => Number(event.target.value)}
          >
            <Input type="number" min={1} max={65535} style={{ width: 110 }} />
          </Form.Item>
        </Space.Compact>

        <Form.Item name="authMethod" label="认证方式" initialValue="password">
          <Radio.Group optionType="button" buttonStyle="solid">
            <Radio.Button value="password"><LockOutlined /> 密码</Radio.Button>
            <Radio.Button value="key"><KeyOutlined /> 私钥</Radio.Button>
            <Radio.Button value="agent">SSH Agent</Radio.Button>
          </Radio.Group>
        </Form.Item>

        {authMethod === 'key' && (
          <>
            <Form.Item
              name="privateKeyPath"
              label={<span><KeyOutlined /> 私钥文件</span>}
              rules={[{ required: true, message: '请选择私钥文件' }]}
            >
              <Input
                readOnly
                placeholder="选择 ~/.ssh/id_ed25519"
                addonAfter={<Button
                  type="text"
                  icon={<FileOutlined />}
                  aria-label="选择私钥文件"
                  onClick={async () => {
                    const selected = await dialog.open({ title: '选择 SSH 私钥', multiple: false, directory: false })
                    if (typeof selected === 'string') form.setFieldValue('privateKeyPath', selected)
                  }}
                />}
              />
            </Form.Item>
            <Form.Item name="passphrase" label="私钥口令（可选）">
              <Input.Password placeholder="私钥有口令时填写" />
            </Form.Item>
          </>
        )}

        <Space.Compact block>
          <Form.Item
            name="username"
            label={<span><UserOutlined /> 用户名</span>}
            rules={[{ required: true, whitespace: true, message: '请输入用户名' }]}
            style={{ flex: 1 }}
          >
            <Input placeholder="root" />
          </Form.Item>
          {authMethod === 'password' && <Form.Item
            name="password"
            label={<span><LockOutlined /> 密码</span>}
            rules={[{ required: true, message: '请输入密码' }]}
            style={{ flex: 1 }}
          >
            <Input.Password placeholder="仅保存在当前会话" autoComplete="current-password" />
          </Form.Item>}
        </Space.Compact>

        {testResult && (
          <div className="connection-test-result" style={{ borderColor: testResult.success ? THEME_SUCCESS : THEME_DANGER }}>
            <CheckCircleOutlined style={{ color: testResult.success ? THEME_SUCCESS : THEME_DANGER }} />
            <div>
              <Text strong>{testResult.success ? '连接测试成功' : testResult.requiresHostKeyConfirmation ? '请确认服务器指纹' : '连接测试失败'}</Text>
              {testResult.hostKey && (
                <Text copyable={{ text: testResult.hostKey.fingerprint }} type="secondary" className="fingerprint-text">
                  {testResult.hostKey.algorithm} · {testResult.hostKey.fingerprint}
                </Text>
              )}
              {testResult.error && <Text type="danger">{testResult.error}</Text>}
            </div>
          </div>
        )}

        <Text type="secondary" style={{ display: 'block', marginBottom: 16, color: THEME_TEXT_SECONDARY }}>
          <KeyOutlined /> 密码和私钥口令不会写入本地配置文件，只在本次运行期间保留。
        </Text>

        <div className="modal-actions">
          <Button onClick={onCancel}>取消</Button>
          <Button onClick={handleTestConnection} loading={testing}>测试连接</Button>
          <Button type="primary" htmlType="submit">保存配置</Button>
        </div>
      </Form>
    </Modal>
  )
}

export default AddConnectionModal
