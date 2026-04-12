import React, { useState, useEffect } from 'react'
import { Button, List } from 'antd'
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons'
import AddConnectionModal from './AddConnectionModal'

const RemoteConnectionList = ({
  connections,
  handleConnect,
  handleDeleteConnection,
  onAddSuccess
}) => {
  // 弹窗状态
  const [ addModalVisible, setAddModalVisible ] = useState(false)
  // 连接按钮loading状态
  const [ connectLoading, setConnectLoading ] = useState(false)
  const [ id, setId ] = useState('')

  // 当连接列表变化时重置loading状态
  useEffect(() => {
    setConnectLoading(false)
    setId('')
  }, [connections])

  return (
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
                    key={item.id + connectLoading}
                    type="primary"
                    size="small"
                    style={{
                      backgroundColor: 'rgb(224, 82, 156)',
                      border: '1px solid rgb(224, 82, 156)',
                      color: '#ffffff',
                      fontSize: '12px'
                    }}
                    onClick={() => {
                      setConnectLoading(true)
                      setId(item.id)
                      setTimeout(async () => {
                        await handleConnect(item)
                        setTimeout(() => {
                          setAddModalVisible(false)
                          setId('')
                        }, 100)
                      }, 100)
                    }}
                    disabled={connectLoading && id !== item.id}
                    loading={connectLoading && id === item.id}
                  >
                    连接
                  </Button>,
                  <Button
                    key={item.id + connectLoading}
                    danger
                    size="small"
                    icon={<DeleteOutlined />}
                    style={{
                      fontSize: '12px'
                    }}
                    onClick={() => handleDeleteConnection(item.id)}
                    disabled={connectLoading}
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
      <AddConnectionModal
        visible={addModalVisible}
        onCancel={() => setAddModalVisible(false)}
        onAddSuccess={onAddSuccess}
      />
    </div>
  )
}

export default RemoteConnectionList