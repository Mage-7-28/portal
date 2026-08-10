/**
 * SSH 连接配置列表。
 * 连接、删除和新增配置由父组件提供，列表只负责展示与交互事件分发。
 */
import React, { useState } from 'react'
import { Button, List, Spin, Tooltip } from 'antd'
import AppIcon from './AppIcon'
import AddConnectionModal from './AddConnectionModal'

/**
 * 渲染 SSH 连接配置列表，并分发连接、删除和新增事件。
 *
 * @param {Object} props - 连接列表属性。
 * @param {Array<Object>} props.connections - 已保存的连接配置数组。
 * @param {(connection: Object) => void} props.handleConnect - 用户选择连接时的回调。
 * @param {(connectionId: string) => Promise<void>} props.handleDeleteConnection - 删除连接配置的回调。
 * @param {(profile: Object, credentials: {password: string}) => Promise<void>} props.onAddSuccess - 新连接保存回调。
 * @param {string|null} props.connectingId - 当前正在连接的配置 ID。
 * @returns {JSX.Element} 连接列表、空状态和新建连接弹窗。
 */
const ConnectionList = ({
  connections,
  handleConnect,
  handleDeleteConnection,
  onAddSuccess,
  connectingId
}) => {
  // 新建连接弹窗的显示状态；连接中的配置会暂时禁止打开弹窗。
  const [ addModalVisible, setAddModalVisible ] = useState(false)
  // 用于在遮罩层显示当前连接名称，避免只显示不可读的 ID。
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
          {connections.length > 0 && <span className="connection-header-hint">双击连接</span>}
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
