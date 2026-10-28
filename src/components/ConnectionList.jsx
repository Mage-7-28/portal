/**
 * SSH 连接配置列表。
 * 连接、删除和新增配置由父组件提供，列表只负责展示与交互事件分发。
 */
import React, { useEffect, useState } from 'react'
import { Button, Card, Col, Descriptions, Dropdown, Empty, Input, List, Row, Space, Spin } from 'antd'
import AppIcon from './AppIcon'
import AddConnectionModal from './AddConnectionModal'

/**
 * 渲染 SSH 连接配置列表和所选配置详情，并分发连接、删除和新增事件。
 *
 * @param {Object} props - 连接列表属性。
 * @param {Array<Object>} props.connections - 已保存的连接配置数组。
 * @param {(connection: Object) => void} props.handleConnect - 用户选择连接时的回调。
 * @param {(connectionId: string) => Promise<void>} props.handleDeleteConnection - 删除连接配置的回调。
 * @param {(connection: Object) => void} props.handleEditConnection - 编辑连接配置的回调。
 * @param {(profile: Object, credentials: {password: string}) => Promise<void>} props.onAddSuccess - 新连接保存回调。
 * @param {string|null} props.connectingId - 当前正在连接的配置 ID。
 * @returns {JSX.Element} 连接列表、详情、空状态和新建连接弹窗。
 */
const ConnectionList = ({
  connections,
  handleConnect,
  handleDeleteConnection,
  handleEditConnection,
  onAddSuccess,
  connectingId
}) => {
  const [ addModalVisible, setAddModalVisible ] = useState(false)
  const [ searchText, setSearchText ] = useState('')
  const [ selectedId, setSelectedId ] = useState(() => connections[0]?.id ?? null)
  const isConnecting = Boolean(connectingId)
  const connectingConnection = connections.find(item => item.id === connectingId)
  const searchQuery = searchText.trim().toLowerCase()
  // 只搜索可展示的配置字段，不将密码或密文纳入匹配范围。
  const visibleConnections = connections.filter(item => !searchQuery || [
    item.name, item.host, item.username, item.port
  ].some(value => String(value ?? '').toLowerCase().includes(searchQuery)))
  const selectedConnection = visibleConnections.find(item => item.id === selectedId) || visibleConnections[0] || null
  const visibleSelectedId = selectedConnection?.id ?? null

  // 过滤或删除使选中项消失时，立即展示首个可见项，并同步后续选择状态。
  useEffect(() => {
    if (selectedId !== visibleSelectedId) setSelectedId(visibleSelectedId)
  }, [ selectedId, visibleSelectedId ])

  return (
    <div className="connection-page" aria-busy={isConnecting}>
      <header className="connection-header">
        <div className="connection-brand">
          <img className="connection-brand-logo" src="/portal-logo.svg" width="26" height="26" alt="" />
          <h1>Portal</h1>
          <span>{connections.length} 个配置</span>
        </div>
        <div className="connection-header-controls">
          <Input
            className="connection-search"
            aria-label="搜索名称、主机、用户或端口"
            placeholder="搜索连接"
            title="搜索名称、主机、用户或端口"
            value={searchText}
            onChange={event => setSearchText(event.target.value)}
            allowClear
            disabled={isConnecting}
          />
          <Button
            type="primary"
            size="small"
            icon={<AppIcon name="plus" />}
            onClick={() => setAddModalVisible(true)}
            disabled={isConnecting}
          >
            新建连接
          </Button>
        </div>
      </header>

      <Row className="connection-list-region" gutter={12} wrap={false}>
        <Col
          flex="auto"
          className={`connection-scroll connection-list-scroll${ isConnecting ? ' is-connecting' : '' }`}
        >
          {connections.length === 0 ? (
            <Empty className="connection-list-empty" image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无连接配置">
              <Button type="primary" onClick={() => setAddModalVisible(true)} disabled={isConnecting}>
                新建连接
              </Button>
            </Empty>
          ) : visibleConnections.length === 0 ? (
            <Empty className="connection-list-empty" image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有匹配的连接">
              <Button onClick={() => setSearchText('')} disabled={isConnecting}>清除搜索</Button>
            </Empty>
          ) : (
            <List
              className="connection-list connection-profiles-list"
              itemLayout="horizontal"
              dataSource={visibleConnections}
              rowKey={item => item.id}
              split={false}
              renderItem={item => (
                <List.Item
                  className={`connection-row${ visibleSelectedId === item.id ? ' is-selected' : '' }${ connectingId === item.id ? ' is-connecting' : '' }`}
                  aria-busy={connectingId === item.id}
                  aria-label={`${ item.name }，按空格选择，按 Enter 连接`}
                  aria-current={visibleSelectedId === item.id ? 'true' : undefined}
                  aria-disabled={isConnecting}
                  tabIndex={isConnecting ? -1 : 0}
                  title={`单击选择，双击连接 ${ item.name }`}
                  onClick={() => {
                    if (!isConnecting) setSelectedId(item.id)
                  }}
                  onDoubleClick={() => {
                    if (isConnecting) return
                    setSelectedId(item.id)
                    void handleConnect(item)
                  }}
                  onKeyDown={event => {
                    if (isConnecting || event.repeat) return
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      setSelectedId(item.id)
                      void handleConnect(item)
                    } else if (event.key === ' ') {
                      event.preventDefault()
                      setSelectedId(item.id)
                    }
                  }}
                  actions={[
                    ...(visibleSelectedId === item.id ? [
                      <span key={`${ item.id }-selected`} className="connection-row-selected">已选择</span>
                    ] : []),
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
                    <span
                      key={`${ item.id }-menu`}
                      className="connection-row-menu"
                      onClick={event => event.stopPropagation()}
                      onDoubleClick={event => event.stopPropagation()}
                      onKeyDown={event => event.stopPropagation()}
                    >
                      <Dropdown
                        trigger={['click']}
                        disabled={isConnecting}
                        menu={{
                          items: [{ key: 'delete', label: '删除连接', icon: <AppIcon name="trash" />, danger: true }],
                          onClick: ({ key, domEvent }) => {
                            domEvent.stopPropagation()
                            if (key === 'delete' && !isConnecting) void handleDeleteConnection(item.id)
                          }
                        }}
                      >
                        <Button size="small" aria-label={`${ item.name } 的更多操作`} disabled={isConnecting}>更多</Button>
                      </Dropdown>
                    </span>
                  ]}
                >
                  <List.Item.Meta
                    className="connection-row-main"
                    avatar={<AppIcon name="ssh" className="connection-row-icon" />}
                    title={<span className="connection-row-name">{item.name}</span>}
                    description={<span className="connection-row-endpoint">{item.username}@{item.host}:{item.port}</span>}
                  />
                </List.Item>
              )}
            />
          )}
        </Col>

        <Col flex="280px" className="connection-scroll connection-details-scroll connection-details-panel">
          <Card className="connection-details-card" title="连接详情" size="small">
            {selectedConnection ? (
              <>
                <Descriptions
                  className="connection-details-fields"
                  column={1}
                  size="small"
                  layout="vertical"
                  colon={false}
                  items={[
                    { key: 'name', label: '名称', children: selectedConnection.name },
                    { key: 'host', label: '主机地址', children: selectedConnection.host },
                    { key: 'port', label: '端口', children: selectedConnection.port },
                    { key: 'username', label: '用户名', children: selectedConnection.username }
                  ]}
                />
                <Space className="connection-details-actions">
                  <Button
                    type="primary"
                    icon={<AppIcon name="ssh" />}
                    loading={connectingId === selectedConnection.id}
                    disabled={isConnecting}
                    onClick={() => void handleConnect(selectedConnection)}
                  >
                    连接
                  </Button>
                  <Button
                    icon={<AppIcon name="edit" />}
                    disabled={isConnecting}
                    onClick={() => handleEditConnection(selectedConnection)}
                  >
                    编辑
                  </Button>
                </Space>
              </>
            ) : (
              <Empty
                className="connection-details-empty"
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description="暂无可显示的连接详情"
              />
            )}
          </Card>
        </Col>

        {isConnecting && (
          <div role="status" className="connection-loading">
            <Spin size="small" />
            <span>{connectingConnection ? `正在连接 ${ connectingConnection.name }...` : '正在连接服务器...'}</span>
          </div>
        )}
      </Row>

      <AddConnectionModal
        visible={addModalVisible}
        onCancel={() => setAddModalVisible(false)}
        onAddSuccess={onAddSuccess}
      />
    </div>
  )
}

export default ConnectionList
