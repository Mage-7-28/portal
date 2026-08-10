/**
 * 输入已保存连接的会话密码。
 * 密码只通过内存回调传回连接流程，不写入持久化配置。
 */
import React, { useEffect } from 'react'
import { Alert, Button, Form, Input, Modal } from 'antd'
import AppIcon from './AppIcon'

/**
 * 输入已保存连接的会话密码。
 *
 * @param {Object} props - 密码弹窗属性。
 * @param {boolean} props.visible - 是否显示弹窗。
 * @param {Object|null} props.connection - 当前待连接的配置。
 * @param {() => void} props.onCancel - 取消输入并关闭弹窗的回调。
 * @param {(values: {password: string}) => void} props.onSubmit - 表单提交回调。
 * @param {boolean} props.loading - 是否正在建立连接。
 * @param {string} [props.errorMessage] - 需要展示的认证错误信息。
 * @returns {JSX.Element} 密码输入弹窗。
 */
const PasswordPromptModal = ({ visible, connection, onCancel, onSubmit, loading, errorMessage }) => {
  // 表单实例用于提交密码并在弹窗关闭时清除上次输入，避免残留敏感信息。
  const [form] = Form.useForm()

  // 每次关闭弹窗都重置密码字段；密码不会写入持久化 Store。
  useEffect(() => {
    if (!visible) form.resetFields()
  }, [ form, visible ])

  return (
    <Modal
      rootClassName="compact-modal"
      title={`输入 ${ connection?.name || '服务器' } 的密码`}
      open={visible}
      onCancel={onCancel}
      footer={null}
      centered
      width="min(360px, calc(100vw - 24px))"
      destroyOnHidden
    >
      {errorMessage && (
        <Alert
          className="password-prompt-error"
          type="error"
          showIcon
          icon={<AppIcon name="warningCircle" />}
          message={errorMessage}
        />
      )}
      <Form className="compact-form" form={form} layout="vertical" onFinish={onSubmit}>
        <Form.Item label="用户名" help="密码只会保存在本次运行的内存中">
          <Input value={connection?.username || ''} readOnly prefix={<AppIcon name="user" />} />
        </Form.Item>
        <Form.Item
          name="password"
          label="密码"
          rules={[{ required: true, message: '请输入密码' }]}
        >
          <Input.Password
            autoFocus
            placeholder="请输入密码"
            autoComplete="current-password"
            iconRender={visible => <AppIcon name={visible ? 'eye' : 'eyeOff'} />}
          />
        </Form.Item>
        <div className="modal-actions">
          <Button onClick={onCancel}>取消</Button>
          <Button type="primary" htmlType="submit" loading={loading}>连接</Button>
        </div>
      </Form>
    </Modal>
  )
}

export default PasswordPromptModal
