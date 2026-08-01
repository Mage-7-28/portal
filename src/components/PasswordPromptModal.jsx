import React, { useEffect } from 'react'
import { Button, Form, Input, Modal } from 'antd'
import AppIcon from './AppIcon'

const PasswordPromptModal = ({ visible, connection, onCancel, onSubmit, loading }) => {
  const [form] = Form.useForm()

  useEffect(() => {
    if (!visible) form.resetFields()
  }, [ form, visible ])

  return (
    <Modal
      rootClassName="compact-modal"
      title={`输入 ${ connection?.name || '服务器' } 的${ connection?.authMethod === 'key' ? '私钥口令' : '密码' }`}
      open={visible}
      onCancel={onCancel}
      footer={null}
      centered
      width="min(360px, calc(100vw - 24px))"
      destroyOnHidden
    >
      <Form className="compact-form" form={form} layout="vertical" onFinish={onSubmit}>
        <Form.Item label="用户名" help="凭据只会保存在本次运行的内存中">
          <Input value={connection?.username || ''} readOnly prefix={<AppIcon name="lock" />} />
        </Form.Item>
        <Form.Item
          name="password"
          label={connection?.authMethod === 'key' ? '私钥口令' : '密码'}
          rules={connection?.authMethod === 'key'
            ? []
            : [{ required: true, message: '请输入密码' }]}
        >
          <Input.Password
            autoFocus
            placeholder={connection?.authMethod === 'key' ? '无口令私钥可留空' : '请输入密码'}
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
