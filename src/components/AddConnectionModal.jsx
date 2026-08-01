import React, { useEffect, useState } from 'react'
import { Button, Form, Input, Modal, Radio, Typography } from 'antd'
import AppIcon from './AppIcon'
import * as dialog from '@tauri-apps/plugin-dialog'
import toast from 'react-hot-toast'
import sftpManager from '../utils/sftpUtils.js'
import { msgBoxStyle, normalizeError, THEME_DANGER, THEME_SUCCESS, THEME_TEXT_SECONDARY, THEME_WARNING } from '../utils/constants.js'

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
  const testResultColor = testResult?.success
    ? THEME_SUCCESS
    : testResult?.requiresHostKeyConfirmation
      ? THEME_WARNING
      : THEME_DANGER

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
      const config = {
        host: values.host.trim(),
        port: Number(values.port),
        username: values.username.trim(),
        password: values.password,
        authMethod: values.authMethod,
        privateKeyPath: values.privateKeyPath,
        passphrase: values.passphrase
      }
      let result = await sftpManager.testConnection(config)
      setTestResult(result)

      if (result.requiresHostKeyConfirmation && result.hostKey?.fingerprint) {
        const accepted = await dialog.confirm(
          `首次连接 ${ config.host } 需要确认服务器身份。\n\n服务器指纹：${ result.hostKey.fingerprint }\n算法：${ result.hostKey.algorithm }\n\n只有确认这是你的目标服务器时才信任。信任后 Portal 会保存该指纹，后续如果指纹变化会阻止连接。`,
          {
            title: '确认 SSH 主机指纹',
            kind: 'warning',
            okLabel: '信任并继续测试',
            cancelLabel: '取消'
          }
        )
        if (!accepted) {
          setTestResult({ ...result, trusted: false })
          toast.error('未信任服务器指纹，连接测试已取消', { id: 'msgBoxGlobal', style: msgBoxStyle })
          return
        }

        const trustedHostKey = result.hostKey
        result = await sftpManager.testConnection({
          ...config,
          hostKeyFingerprint: trustedHostKey.fingerprint
        })
        setTestResult({ ...result, hostKey: result.hostKey || trustedHostKey, trusted: true })
      }

      if (result.success) {
        toast.success('连接测试成功，服务器指纹已信任', { id: 'msgBoxGlobal', style: msgBoxStyle })
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
      hostKeyFingerprint: testResult?.trusted ? testResult?.hostKey?.fingerprint || null : null,
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
      rootClassName="compact-modal"
      title="新建 SSH 连接"
      open={visible}
      onCancel={onCancel}
      centered
      footer={null}
      width="min(440px, calc(100vw - 24px))"
      destroyOnHidden
    >
      <Form
        className="compact-form"
        form={form}
        layout="vertical"
        onFinish={handleSubmit}
        onValuesChange={() => setTestResult(null)}
        requiredMark="optional"
      >
        <Form.Item
          name="name"
          label={<span><AppIcon name="wifi" /> 连接名称</span>}
          rules={[{ required: true, whitespace: true, message: '请输入连接名称' }]}
        >
          <Input placeholder="例如：生产服务器" autoFocus />
        </Form.Item>

        <div className="form-row form-row-host">
          <Form.Item
            name="host"
            label={<span><AppIcon name="server" /> 主机地址</span>}
            rules={[{ required: true, whitespace: true, message: '请输入主机地址' }]}
          >
            <Input placeholder="xxx.xxx.xxx.xxx" />
          </Form.Item>
          <Form.Item
            name="port"
            label="端口"
            initialValue={22}
            rules={[{ required: true, type: 'number', min: 1, max: 65535, message: '端口范围为 1-65535' }]}
            getValueFromEvent={event => Number(event.target.value)}
          >
            <Input type="number" min={1} max={65535} />
          </Form.Item>
        </div>

        <Form.Item name="authMethod" label="认证方式" initialValue="password">
          <Radio.Group optionType="button" buttonStyle="solid">
            <Radio.Button value="password"><AppIcon name="lock" /> 密码</Radio.Button>
            <Radio.Button value="key"><AppIcon name="key" /> 私钥</Radio.Button>
            <Radio.Button value="agent">SSH Agent</Radio.Button>
          </Radio.Group>
        </Form.Item>

        {authMethod === 'key' && (
          <>
            <Form.Item
              name="privateKeyPath"
              label={<span><AppIcon name="key" /> 私钥文件</span>}
              rules={[{ required: true, message: '请选择私钥文件' }]}
            >
              <Input
                readOnly
                placeholder="选择 ~/.ssh/id_ed25519"
                addonAfter={<Button
                  className="compact-icon-button"
                  type="text"
                  size="small"
                  icon={<AppIcon name="file" />}
                  aria-label="选择私钥文件"
                  onClick={async () => {
                    const selected = await dialog.open({ title: '选择 SSH 私钥', multiple: false, directory: false })
                    if (typeof selected === 'string') form.setFieldValue('privateKeyPath', selected)
                  }}
                />}
              />
            </Form.Item>
            <Form.Item name="passphrase" label="私钥口令（可选）">
              <Input.Password
                placeholder="私钥有口令时填写"
                iconRender={visible => <AppIcon name={visible ? 'eye' : 'eyeOff'} />}
              />
            </Form.Item>
          </>
        )}

        <div className="form-row">
          <Form.Item
            name="username"
            label={<span><AppIcon name="user" /> 用户名</span>}
            rules={[{ required: true, whitespace: true, message: '请输入用户名' }]}
          >
            <Input placeholder="root" />
          </Form.Item>
          {authMethod === 'password' && <Form.Item
            name="password"
            label={<span><AppIcon name="lock" /> 密码</span>}
            rules={[{ required: true, message: '请输入密码' }]}
          >
            <Input.Password
              placeholder="仅保存在当前会话"
              autoComplete="current-password"
              iconRender={visible => <AppIcon name={visible ? 'eye' : 'eyeOff'} />}
            />
          </Form.Item>}
        </div>

        {testResult && (
          <div className="connection-test-result" style={{ borderColor: testResultColor }}>
            {testResult.success ? (
              <AppIcon name="checkCircle" style={{ color: testResultColor }} />
            ) : testResult.requiresHostKeyConfirmation ? (
              <AppIcon name="key" style={{ color: testResultColor }} />
            ) : (
              <AppIcon name="warningCircle" style={{ color: testResultColor }} />
            )}
            <div>
              <Text strong>
                {testResult.success
                  ? '连接测试成功，主机指纹已信任'
                  : testResult.requiresHostKeyConfirmation
                    ? '检测到服务器主机指纹'
                    : '连接测试失败'}
              </Text>
              {testResult.hostKey && (
                <Text copyable={{ text: testResult.hostKey.fingerprint }} type="secondary" className="fingerprint-text">
                  {testResult.hostKey.algorithm} · {testResult.hostKey.fingerprint}
                </Text>
              )}
              {testResult.hostKey && (
                <Text type="secondary" className="fingerprint-help">
                  主机指纹用于确认服务器身份；保存后下次连接会校验它，发现变化会阻止连接。
                </Text>
              )}
              {testResult.error && <Text type="danger">{testResult.error}</Text>}
            </div>
          </div>
        )}

        <Text type="secondary" className="credential-note" style={{ color: THEME_TEXT_SECONDARY }}>
          <AppIcon name="key" /> 密码和私钥口令不会写入本地配置文件，只在本次运行期间保留。
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
