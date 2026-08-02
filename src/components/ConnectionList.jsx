import React, { useState } from 'react'
import { Button, List, Spin, Tooltip } from 'antd'
import AppIcon from './AppIcon'
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
  const connectingConnection = connections.find(item => item.id === connectingId)

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
          icon={<AppIcon name="plus" />}
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
              <AppIcon name="ssh" />
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
                  className={`connection-row${ connectingId === item.id ? ' is-connecting' : '' }`}
                  aria-busy={connectingId === item.id}
                  title={`双击连接 ${ item.name }`}
                  onDoubleClick={event => {
                    // 操作区只负责自身操作，避免双击删除按钮时误触发连接。
                    if (event.target.closest('button')) return
                    if (connectingId) return
                    void handleConnect(item)
                  }}
                  actions={[
                    ...(connectingId === item.id ? [
                      <span
                        key={`${ item.id }-connecting`}
                        className="connection-row-loading"
                        role="status"
                        aria-label="正在连接"
                      >
                        <Spin size="small" />
                      </span>
                    ] : []),
                    <Tooltip title="删除连接" key={`${ item.id }-delete-tooltip`}>
                      <Button
                        key={`${ item.id }-delete`}
                        className="compact-icon-button"
                        danger
                        size="small"
                        icon={<AppIcon name="trash" />}
                        aria-label={`删除 ${ item.name }`}
                        onClick={() => handleDeleteConnection(item.id)}
                        disabled={connectingId !== null}
                      />
                    </Tooltip>
                  ]}
                >
                  <List.Item.Meta
                    avatar={<AppIcon name="ssh" className="connection-row-icon" />}
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
            <span>{connectingConnection ? `正在连接 ${ connectingConnection.name }...` : '正在连接服务器...'}</span>
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
