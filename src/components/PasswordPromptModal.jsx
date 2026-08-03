import React, { useEffect } from 'react'
import { Alert, Button, Form, Input, Modal } from 'antd'
import AppIcon from './AppIcon'

const PasswordPromptModal = ({ visible, connection, onCancel, onSubmit, loading, errorMessage }) => {
  const [form] = Form.useForm()

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
