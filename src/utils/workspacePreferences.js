/** 工作区布局恢复与连接放行条件；均不接触会话凭据。 */

const normalizeRatio = (value, fallback, min, max) => typeof value === 'number' && Number.isFinite(value)
  ? Math.min(max, Math.max(min, value))
  : fallback

/**
 * 校验已保存的布局比例，旧配置或非法值回退到默认布局。
 *
 * @param {{fileRatio?: number, rightTerminalRatio?: number}|null} layout - 持久化布局。
 * @returns {{fileRatio: number, rightTerminalRatio: number}} 合法的面板比例。
 */
export const normalizeWorkspaceLayout = layout => ({
  fileRatio: normalizeRatio(layout?.fileRatio, 0.38, 0.30, 0.62),
  rightTerminalRatio: normalizeRatio(layout?.rightTerminalRatio, 0.62, 0.32, 0.70)
})

/**
 * 终端字号为全局偏好；非法、过期或越界值一律使用 13px。
 *
 * @param {unknown} value - Store 中保存的字号。
 * @returns {number} 10–22 范围内的整数字号。
 */
export const normalizeTerminalFontSize = value => Number.isInteger(value) && value >= 10 && value <= 22
  ? value
  : 13

/**
 * 文件通道可用后，完整就绪或明确的辅助错误均可进入工作区。
 * 12 秒超时由宿主计时放行，辅助请求仍按真实状态继续。
 *
 * @param {boolean} filesReady - 是否已有可用文件会话。
 * @param {string} terminalStatus - 终端当前状态。
 * @param {string} monitorStatus - 首次监控采集状态。
 * @returns {boolean} 是否满足非超时放行条件。
 */
export const shouldRevealWorkspace = (filesReady, terminalStatus, monitorStatus) => Boolean(filesReady) && (
  terminalStatus === 'error'
  || terminalStatus === 'closed'
  || monitorStatus === 'error'
  || (terminalStatus === 'connected' && monitorStatus === 'ready')
)

/**
 * 汇总独立 SSH 通道的健康状态，不把辅助通道故障升级成文件会话断线。
 *
 * @param {{files?: Object, terminal?: Object, monitor?: Object}} channels - 三个工作区通道的最新状态。
 * @returns {{status: 'connected'|'connecting'|'partial'|'disconnected', label: string, channels: Object[]}} 可直接用于状态条的摘要。
 */
export const getWorkspaceConnectionHealth = ({ files, terminal, monitor }) => {
  const fileConnected = files?.status === 'connected'
  const fileFailed = files?.status === 'error' || files?.status === 'idle'
  const terminalFailed = terminal?.status === 'error' || terminal?.status === 'closed'
  const monitorStatus = monitor?.currentHealth || monitor?.status
  const monitorFailed = monitorStatus === 'error'
  const channelsStatus = [
    { id: 'files', label: '文件', status: fileConnected ? 'connected' : fileFailed ? 'error' : 'connecting' },
    { id: 'terminal', label: '终端', status: terminal?.status === 'connected' ? 'connected' : terminalFailed ? 'error' : 'connecting' },
    { id: 'monitor', label: '监控', status: monitorStatus === 'ready' ? 'connected' : monitorFailed ? 'error' : 'connecting' }
  ]

  if (fileFailed) return { status: 'disconnected', label: '文件连接已断开', channels: channelsStatus }
  if (!fileConnected) return { status: 'connecting', label: '正在建立工作区连接', channels: channelsStatus }
  if (terminalFailed || monitorFailed) return { status: 'partial', label: '部分功能暂不可用 · 文件传输仍可使用', channels: channelsStatus }
  if (channelsStatus.every(channel => channel.status === 'connected')) {
    return { status: 'connected', label: '所有通道运行正常', channels: channelsStatus }
  }
  return { status: 'connecting', label: '文件已就绪，正在准备终端与监控', channels: channelsStatus }
}
