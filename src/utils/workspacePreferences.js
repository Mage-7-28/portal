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
