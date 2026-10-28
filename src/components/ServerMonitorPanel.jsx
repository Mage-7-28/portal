/**
 * 服务器资源概览和进程列表；通过 Ant Design 展示统一的远端监控快照。
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Alert, Card, Empty, Progress, Segmented, Spin, Table, Tag, Tooltip, Typography } from 'antd'
import { serverMonitorManager } from '../utils/serverMonitor.js'
import { formatFileSize } from '../utils/constants.js'
import AppIcon from './AppIcon.jsx'

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
 * @param {{connectionId: string, active?: boolean, onInitialStateChange?: (state: {status: 'ready'|'error', message: string}) => void}} props - 监控连接、采集开关和首次采集结果回调。
 * @returns {JSX.Element} 同时包含资源指标和进程表的监控面板。
 */
const ServerMonitorPanel = ({ connectionId, active = true, onInitialStateChange }) => {
  const [ state, setState ] = useState({ snapshot: null, error: '', loading: true, refreshing: false })
  const [ sortBy, setSortBy ] = useState('memory')
  const [ tableHeight, setTableHeight ] = useState(120)
  const tableWrapRef = useRef(null)
  const tableRef = useRef(null)
  const snapshot = state.snapshot
  const hasSnapshot = snapshot != null
  const initialStatus = snapshot ? 'ready' : state.error ? 'error' : ''
  const initialMessage = snapshot ? '' : state.error

  useEffect(() => {
    if (initialStatus) onInitialStateChange?.({ status: initialStatus, message: initialMessage })
  }, [ initialMessage, initialStatus, onInitialStateChange ])

  // 百分比高度在多层 flex 和固定表头之间不可靠，按实际剩余空间设置唯一滚动区。
  useLayoutEffect(() => {
    const container = tableWrapRef.current
    if (!container) return undefined
    const header = container.querySelector('.ant-table-header')
    const updateHeight = () => {
      const headerHeight = header?.getBoundingClientRect().height || 32
      setTableHeight(Math.max(1, Math.floor(container.clientHeight - headerHeight)))
    }
    updateHeight()
    const observer = new window.ResizeObserver(updateHeight)
    observer.observe(container)
    if (header) observer.observe(header)
    return () => observer.disconnect()
  }, [hasSnapshot])

  useEffect(() => {
    if (!connectionId || !active) return undefined
    return serverMonitorManager.subscribe(connectionId, setState, active ? 5000 : 30000)
  }, [ active, connectionId ])

  const processColumns = useMemo(() => [
    {
      title: 'PID',
      dataIndex: 'pid',
      key: 'pid',
      width: 64,
      className: 'server-process-pid',
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
      width: 74,
      className: 'server-process-number',
      align: 'right',
      render: value => `${ Number(value || 0).toFixed(1) }%`
    },
    {
      title: '内存',
      dataIndex: 'memoryBytes',
      key: 'memoryBytes',
      width: 88,
      className: 'server-process-number',
      align: 'right',
      render: value => formatFileSize(Number(value) || 0)
    }
  ], [])

  const processes = useMemo(() => {
    const source = sortBy === 'memory' && snapshot?.memoryProcesses?.length
      ? snapshot.memoryProcesses
      : snapshot?.processes
    const rows = [...(source || [])]
    rows.sort((left, right) => sortBy === 'cpu'
      ? right.cpuPercent - left.cpuPercent || left.pid - right.pid
      : right.memoryBytes - left.memoryBytes || left.pid - right.pid)
    return rows
  }, [ sortBy, snapshot?.memoryProcesses, snapshot?.processes ])

  const processCount = snapshot?.processCount ?? processes.length
  const hasLimitedProcesses = processCount > processes.length
  const memoryPercent = snapshot?.memoryTotalBytes > 0
    ? snapshot.memoryUsedBytes / snapshot.memoryTotalBytes * 100
    : 0

  return (
    <Card
      className="server-monitor-card"
      size="small"
      title={(
        <div className="server-monitor-title">
          <AppIcon name="server" size={14} />
          <span>服务器状态</span>
          {snapshot && <Tag className="server-monitor-platform-tag">{getPlatformLabel(snapshot.platform)}</Tag>}
        </div>
      )}
      extra={(
        <Text type="secondary" className="server-monitor-updated" title="每 5 秒自动采集；下方时间为最近一次成功采样时间">
          <span className={`server-monitor-live-dot${ state.error ? ' is-stale' : '' }`} aria-hidden="true" />
          {snapshot ? new Date(snapshot.collectedAt).toLocaleTimeString('zh-CN', { hour12: false }) : '等待采样'}
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
            title={snapshot ? '暂时无法刷新，保留上次采样' : '无法获取服务器监控数据'}
            description={state.error}
          />
        )}
        {state.loading && !snapshot ? (
          <div className="server-monitor-loading" role="status"><Spin size="small" /><span>正在采集服务器状态...</span></div>
        ) : snapshot ? (
          <>
            <div className="server-monitor-metrics" role="group" aria-label="服务器资源使用率">
              <div className="server-monitor-metric is-cpu">
                <div className="server-monitor-metric-heading">
                  <span>CPU · {snapshot.cpuCount || '未知'} 核</span>
                  <strong>{snapshot.cpuPercent == null ? '采样中' : `${ Number(snapshot.cpuPercent).toFixed(1) }%`}</strong>
                </div>
                <Progress
                  percent={snapshot.cpuPercent ?? 0}
                  strokeColor="#eb9070"
                  showInfo={false}
                  size="small"
                />
              </div>
              <div className="server-monitor-metric is-memory">
                <div className="server-monitor-metric-heading">
                  <span>内存 <small className="server-monitor-memory-detail">{formatFileSize(snapshot.memoryUsedBytes)} / {formatFileSize(snapshot.memoryTotalBytes)}</small></span>
                  <strong>{memoryPercent.toFixed(1)}%</strong>
                </div>
                <Progress percent={memoryPercent} strokeColor="#67c7d1" showInfo={false} size="small" />
              </div>
            </div>
            <div className="server-process-heading">
              <div className="server-process-summary">
                <Text strong>进程</Text>
                <Tooltip title={hasLimitedProcesses
                  ? `当前账户可见 ${ processCount } 个进程，当前显示按${ sortBy === 'cpu' ? ' CPU' : '内存' }排名的前 ${ processes.length } 项；可滚动查看。`
                  : '当前账户可见的全部进程；可在表格内滚动查看。'}>
                  <Text type="secondary" className="server-process-count" tabIndex={0}>
                    {hasLimitedProcesses ? `${ processes.length } / ${ processCount }` : `${ processCount } 项`}
                  </Text>
                </Tooltip>
              </div>
              <Segmented
                size="small"
                value={sortBy}
                options={[{ label: 'CPU', value: 'cpu' }, { label: '内存', value: 'memory' }]}
                onChange={value => {
                  setSortBy(value)
                  tableRef.current?.scrollTo({ top: 0 })
                }}
                aria-label="进程排序方式"
              />
            </div>
            <div className="server-process-table-wrap" ref={tableWrapRef}>
              <Table
                ref={tableRef}
                className="server-process-table"
                size="small"
                rowKey="pid"
                columns={processColumns}
                dataSource={processes}
                pagination={false}
                locale={{ emptyText: snapshot
                  ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="当前没有进程数据" />
                  : '等待服务器数据' }}
                scroll={{ y: tableHeight, x: 340, scrollToFirstRowOnChange: false }}
              />
            </div>
          </>
        ) : null}
      </div>
    </Card>
  )
}

export default ServerMonitorPanel
