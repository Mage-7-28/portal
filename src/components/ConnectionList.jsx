import React, { useState } from 'react'
import { Button, List, Spin, Tooltip } from 'antd'
import { CloudServerOutlined, DeleteOutlined, PlusOutlined } from '@ant-design/icons'
import AddConnectionModal from './AddConnectionModal'

const ConnectionList = ({
  connections,
  handleConnect,
  handleDeleteConnection,
  onAddSuccess,
  connectingId
}) => {
  // 弹窗状态
  const [ addModalVisible, setAddModalVisible ] = useState(false)

  return (
    <div
      className="connection-page"
      aria-busy={Boolean(connectingId)}
    >
      <header className="connection-header">
        <div>
          <h1>SSH 连接</h1>
          <span>{connections.length} 个配置</span>
        </div>
        <Button
          type="primary"
          size="small"
          icon={<PlusOutlined />}
          onClick={() => setAddModalVisible(true)}
          disabled={Boolean(connectingId)}
        >
          新建连接
        </Button>
      </header>

      <div className="connection-list-region">
        <div className={`connection-scroll${ connectingId ? ' is-connecting' : '' }`}>
          {connections.length === 0 ? (
            <div className="connection-empty">
              <CloudServerOutlined />
              <span>暂无连接配置</span>
            </div>
          ) : (
            <List
              className="connection-list"
              itemLayout="horizontal"
              dataSource={connections}
              rowKey={item => item.id}
              renderItem={item => (
                <List.Item
                  className="connection-row"
                  actions={[
                    <Button
                      key={`${ item.id }-connect`}
                      type="primary"
                      size="small"
                      onClick={() => handleConnect(item)}
                      disabled={connectingId !== null && connectingId !== item.id}
                      loading={connectingId === item.id}
                    >
                      连接
                    </Button>,
                    <Tooltip title="删除连接" key={`${ item.id }-delete-tooltip`}>
                      <Button
                        key={`${ item.id }-delete`}
                        className="compact-icon-button"
                        danger
                        size="small"
                        icon={<DeleteOutlined />}
                        aria-label={`删除 ${ item.name }`}
                        onClick={() => handleDeleteConnection(item.id)}
                        disabled={connectingId !== null}
                      />
                    </Tooltip>
                  ]}
                >
                  <List.Item.Meta
                    avatar={<CloudServerOutlined className="connection-row-icon" />}
                    title={<span className="connection-row-name">{item.name}</span>}
                    description={
                      <span className="connection-row-endpoint">
                        {item.username}@{item.host}:{item.port}
                      </span>
                    }
                  />
                </List.Item>
              )}
            />
          )}
        </div>
        {connectingId && (
          <div
            role="status"
            className="connection-loading"
          >
            <Spin size="small" />
            <span>正在连接服务器...</span>
          </div>
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

export default ConnectionList
