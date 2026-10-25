/**
 * 新建或编辑 SSH 连接配置弹窗。
 * 测试连接可选；已信任的主机指纹会随配置保存，密码交给当前进程内的连接管理器。
 */
import React, { useLayoutEffect, useRef, useState } from 'react'
import { Button, Form, Input, Modal, Typography } from 'antd'
import AppIcon from './AppIcon'
import * as dialog from '@tauri-apps/plugin-dialog'
import { createConnectionFormGuard } from '../utils/connectionFormGuard.js'
import sftpManager from '../utils/sftpUtils.js'
import { normalizeError, THEME_DANGER, THEME_SUCCESS, THEME_TEXT_SECONDARY, THEME_WARNING } from '../utils/constants.js'
import { notification } from '../utils/notificationUtils.js'

const { Text } = Typography

/**
 * 创建连接配置的稳定标识；浏览器环境没有 randomUUID 时使用时间戳兜底。
 *
 * @returns {string} 可用于连接配置和 Tauri 会话的唯一 ID。
 */
const newId = () => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return `connection-${ Date.now() }`
}

/**
 * 新建 SSH 连接配置弹窗。
 *
 * @param {Object} props - 组件属性。
 * @param {boolean} props.visible - 是否显示弹窗。
 * @param {() => void} props.onCancel - 关闭弹窗的回调。
 * @param {(profile: Object, credentials: {password: string}) => Promise<void>} props.onAddSuccess - 保存连接配置的回调。
 * @param {Object|null} [props.editingConnection=null] - 正在编辑的连接配置；为空时创建新配置。
 * @returns {JSX.Element} 连接表单、主机指纹确认结果和操作按钮。
 */
const AddConnectionModal = ({ visible, onCancel, onAddSuccess, editingConnection = null }) => {
  // Ant Design 表单实例，用于校验、读取和在弹窗关闭时重置字段。
  const [form] = Form.useForm()
  // 同步追踪弹窗会话、表单版本及异步操作，避免依赖 React 状态更新时序。
  const guardRef = useRef(null)
  if (!guardRef.current) guardRef.current = createConnectionFormGuard()
  const guard = guardRef.current
  // 连接测试请求状态及最近一次测试/指纹信任结果。
  const [ testing, setTesting ] = useState(false)
  const [ testResult, setTestResult ] = useState(null)
  const [ saving, setSaving ] = useState(false)
  // 根据测试结果决定结果面板的语义颜色（成功、待确认或失败）。
  const testResultColor = testResult?.success
    ? THEME_SUCCESS
    : testResult?.requiresHostKeyConfirmation
      ? THEME_WARNING
      : THEME_DANGER

  useLayoutEffect(() => {
    if (visible) {
      guard.openSession()
      form.setFieldsValue(editingConnection ? {
        name: editingConnection.name,
        host: editingConnection.host,
        port: editingConnection.port,
        username: editingConnection.username,
        password: ''
      } : { port: 22 })
      setTestResult(null)
      setTesting(false)
    } else {
      guard.closeSession()
      form.resetFields()
      setTestResult(null)
      setTesting(false)
    }

    return () => guard.closeSession()
  }, [ editingConnection, form, guard, visible ])

  /**
   * 关闭当前会话后通知受控弹窗的父组件。
   *
   * @returns {void}
   */
  const handleCancel = () => {
    guard.closeSession()
    onCancel()
  }

  /**
   * 记录表单编辑并清除基于旧值的测试和信任结果。
   *
   * @returns {void}
   */
  const handleValuesChange = () => {
    guard.changeForm()
    setTestResult(null)
    setTesting(false)
  }

  /**
   * 测试网络连接，并在需要时请求用户确认服务器主机指纹。
   *
   * @returns {Promise<void>} 测试流程完成后的 Promise；失败信息写入本地状态。
   */
  const handleTestConnection = async () => {
    const ticket = guard.beginTest()
    if (!ticket) return
    setTesting(true)

    try {
      const values = await form.validateFields()
      if (!guard.isCurrentTest(ticket)) return

      const host = values.host.trim()
      const port = Number(values.port)
      const endpointChanged = editingConnection
        && (editingConnection.host !== host || Number(editingConnection.port) !== port)
      const config = {
        host,
        port,
        username: values.username.trim(),
        password: values.password,
        authMethod: 'password',
        // 编辑已有配置时直接校验已保存指纹；新配置仍走首次确认流程。
        hostKeyFingerprint: endpointChanged ? null : editingConnection?.hostKeyFingerprint || null
      }
      let result = await sftpManager.testConnection(config)
      if (!guard.isCurrentTest(ticket)) return
      setTestResult({
        ...result,
        trusted: Boolean(result.success && config.hostKeyFingerprint),
        formTicket: ticket
      })

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
        if (!guard.isCurrentTest(ticket)) return
        if (!accepted) {
          setTestResult({ ...result, trusted: false, formTicket: ticket })
          void notification.error('未信任服务器指纹，连接测试已取消')
          return
        }

        const trustedHostKey = result.hostKey
        result = await sftpManager.testConnection({
          ...config,
          hostKeyFingerprint: trustedHostKey.fingerprint
        })
        if (!guard.isCurrentTest(ticket)) return
        setTestResult({
          ...result,
          hostKey: result.hostKey || trustedHostKey,
          trusted: Boolean(result.success),
          formTicket: ticket
        })
      } else if (result.success) {
        // 已有指纹验证成功，或测试环境直接返回成功时，保存当前指纹。
        setTestResult({ ...result, trusted: true, formTicket: ticket })
      }

      if (result.success) {
        void notification.success('连接测试成功，服务器指纹已信任')
      } else {
        void notification.error(`连接测试失败：${ result.error }`)
      }
    } catch (error) {
      if (!guard.isCurrentTest(ticket)) return
      if (error?.errorFields) return
      void notification.error(`连接测试失败：${ normalizeError(error) }`)
    } finally {
      if (guard.isCurrentTest(ticket)) setTesting(false)
    }
  }

  /**
   * 将表单值转换为连接配置；未经测试的配置也可以保存。
   *
   * @param {{name: string, host: string, port: number|string, username: string, password?: string}} values - Ant Design 表单值。
   * @returns {Promise<void>} 保存回调和成功/失败通知完成后的 Promise。
   */
  const handleSubmit = async (values) => {
    const ticket = guard.beginSave()
    if (!ticket) return
    setSaving(true)

    try {
      const host = values.host.trim()
      const port = Number(values.port)
      const endpointChanged = editingConnection
        && (editingConnection.host !== host || Number(editingConnection.port) !== port)
      const trustedFingerprint = guard.isCurrentForm(testResult?.formTicket) && testResult?.trusted
        ? testResult.hostKey?.fingerprint || null
        : endpointChanged
          ? null
          : editingConnection?.hostKeyFingerprint || null
      const profile = {
        id: editingConnection?.id || newId(),
        name: values.name.trim(),
        host,
        port,
        username: values.username.trim(),
        authMethod: 'password',
        hostKeyFingerprint: trustedFingerprint,
        createdAt: editingConnection?.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }

      await onAddSuccess(profile, { password: values.password || '' })
      void notification.success(editingConnection ? '连接配置已更新' : '连接配置已保存')
      if (guard.isCurrentSave(ticket)) handleCancel()
    } catch (error) {
      void notification.error(`保存连接失败：${ normalizeError(error) }`)
    } finally {
      guard.finishSave(ticket)
      setSaving(false)
    }
  }

  return (
    <Modal
      rootClassName="compact-modal"
      title={editingConnection ? '编辑 SSH 连接' : '新建 SSH 连接'}
      open={visible}
      onCancel={handleCancel}
      centered
      footer={null}
      width="min(420px, calc(100vw - 24px))"
      destroyOnHidden
    >
      <Form
        className="compact-form"
        form={form}
        layout="vertical"
        onFinish={handleSubmit}
        onValuesChange={handleValuesChange}
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

        <div className="form-row">
          <Form.Item
            name="username"
            label={<span><AppIcon name="user" /> 用户名</span>}
            rules={[{ required: true, whitespace: true, message: '请输入用户名' }]}
          >
            <Input placeholder="root" />
          </Form.Item>
          <Form.Item
            name="password"
            label={<span><AppIcon name="lock" /> 密码</span>}
            rules={[{ required: true, message: '请输入密码' }]}
          >
            <Input.Password
              placeholder="将以加密形式保存"
              autoComplete="current-password"
              iconRender={visible => <AppIcon name={visible ? 'eye' : 'eyeOff'} />}
            />
          </Form.Item>
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
          <AppIcon name="lock" /> 密码会以加密形式保存，使用时仅在内存中解密。
        </Text>

        <div className="modal-actions">
          <Button onClick={handleCancel}>取消</Button>
          <Button onClick={handleTestConnection} loading={testing}>测试连接</Button>
          <Button type="primary" htmlType="submit" loading={saving}>保存配置</Button>
        </div>
      </Form>
    </Modal>
  )
}

export default AddConnectionModal
