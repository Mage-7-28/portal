/**
 * 服务器资源概览和进程列表；通过 Ant Design 展示统一的远端监控快照。
 */
import { useEffect, useMemo, useState } from 'react'
import { Alert, Card, Col, Empty, Progress, Row, Segmented, Space, Spin, Statistic, Table, Tag, Typography } from 'antd'
import { serverMonitorManager } from '../utils/serverMonitor.js'
import { formatFileSize } from '../utils/constants.js'

const { Text } = Typography

/**
 * 将平台标识转换为简短展示名称。
 *
 * @param {string} platform - 后端识别的远端系统名称。
 * @returns {string} 用于状态标签的本地化系统名称。
 */
const getPlatformLabel = platform => ({
  linux: 'Linux',
  'gnu/linux': 'Linux',
  darwin: 'macOS',
  freebsd: 'FreeBSD',
  openbsd: 'OpenBSD',
  netbsd: 'NetBSD',
  dragonfly: 'DragonFly BSD',
  windows: 'Windows'
}[platform] || platform || '未知系统')

/**
 * 展示服务器 CPU、内存和进程负载。
 *
 * @param {{connectionId: string, active?: boolean}} props - 监控连接和面板可见状态。
 * @returns {JSX.Element} 同时包含资源指标和进程表的监控面板。
 */
const ServerMonitorPanel = ({ connectionId, active = true }) => {
  const [ state, setState ] = useState({ snapshot: null, error: '', loading: true, refreshing: false })
  const [ sortBy, setSortBy ] = useState('cpu')

  useEffect(() => {
    if (!connectionId || !active) return undefined
    return serverMonitorManager.subscribe(connectionId, setState, active ? 5000 : 30000)
  }, [ active, connectionId ])

  const processColumns = useMemo(() => [
    {
      title: 'PID',
      dataIndex: 'pid',
      key: 'pid',
      width: 76,
      ellipsis: true
    },
    {
      title: '进程',
      dataIndex: 'name',
      key: 'name',
      ellipsis: true,
      render: name => <Text className="server-process-name" title={name}>{name}</Text>
    },
    {
      title: 'CPU',
      dataIndex: 'cpuPercent',
      key: 'cpuPercent',
      width: 84,
      align: 'right',
      render: value => `${ Number(value || 0).toFixed(1) }%`
    },
    {
      title: '内存',
      dataIndex: 'memoryBytes',
      key: 'memoryBytes',
      width: 104,
      align: 'right',
      render: value => formatFileSize(Number(value) || 0)
    }
  ], [])

  const processes = useMemo(() => {
    const rows = [...(state.snapshot?.processes || [])]
    rows.sort((left, right) => sortBy === 'cpu'
      ? right.cpuPercent - left.cpuPercent
      : right.memoryBytes - left.memoryBytes)
    return rows
  }, [ sortBy, state.snapshot?.processes ])

  const snapshot = state.snapshot
  const memoryPercent = snapshot?.memoryTotalBytes > 0
    ? snapshot.memoryUsedBytes / snapshot.memoryTotalBytes * 100
    : 0

  return (
    <Card
      className="server-monitor-card"
      size="small"
      title={(
        <Space size={8}>
          <span>服务器状态</span>
          {snapshot && <Tag color="processing">{getPlatformLabel(snapshot.platform)}</Tag>}
        </Space>
      )}
      extra={(
        <Text type="secondary" className="server-monitor-updated">
          {snapshot ? `更新于 ${ new Date(snapshot.collectedAt).toLocaleTimeString() }` : '等待采样'}
        </Text>
      )}
      styles={{ body: { minHeight: 0 }}}
    >
      <div className="server-monitor-content">
        {state.error && (
          <Alert
            className="server-monitor-alert"
            type={snapshot ? 'warning' : 'error'}
            showIcon
            message={snapshot ? '监控数据暂时不可用，正在保留上次采样' : '无法获取服务器监控数据'}
            description={state.error}
          />
        )}
        {state.loading && !snapshot ? (
          <div className="server-monitor-loading"><Spin tip="正在采集服务器状态..." /></div>
        ) : (
          <>
            <Row gutter={[ 10, 10 ]} className="server-monitor-metrics">
              <Col xs={24} md={12}>
                <div className="server-monitor-metric">
                  <Statistic
                    title="CPU 使用率"
                    value={snapshot?.cpuPercent ?? 0}
                    precision={1}
                    suffix="%"
                    formatter={value => snapshot?.cpuPercent == null ? '采样中' : Number(value).toFixed(1)}
                  />
                  <Progress
                    percent={snapshot?.cpuPercent ?? 0}
                    showInfo={false}
                    size="small"
                    status={snapshot?.cpuPercent == null ? 'normal' : 'active'}
                  />
                </div>
              </Col>
              <Col xs={24} md={12}>
                <div className="server-monitor-metric">
                  <Statistic
                    title="内存占用"
                    value={memoryPercent}
                    precision={1}
                    suffix="%"
                  />
                  <Text type="secondary" className="server-monitor-memory-detail">
                    {snapshot
                      ? `${ formatFileSize(snapshot.memoryUsedBytes) } / ${ formatFileSize(snapshot.memoryTotalBytes) }`
                      : '等待采样'}
                  </Text>
                  <Progress percent={memoryPercent} showInfo={false} size="small" />
                </div>
              </Col>
            </Row>
            <div className="server-process-heading">
              <Space size={8}>
                <Text strong>进程</Text>
                <Text type="secondary">{snapshot ? `${ snapshot.processes.length } 项` : ''}</Text>
              </Space>
              <Segmented
                size="small"
                value={sortBy}
                options={[{ label: '按 CPU', value: 'cpu' }, { label: '按内存', value: 'memory' }]}
                onChange={setSortBy}
                aria-label="进程排序方式"
              />
            </div>
            <div className="server-process-table-wrap">
              <Table
                className="server-process-table"
                size="small"
                rowKey="pid"
                columns={processColumns}
                dataSource={processes}
                loading={state.refreshing && !snapshot}
                pagination={false}
                locale={{ emptyText: snapshot
                  ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="当前没有进程数据" />
                  : '等待服务器数据' }}
                scroll={{ y: 260, x: 360 }}
              />
            </div>
          </>
        )}
      </div>
    </Card>
  )
}

export default ServerMonitorPanel
