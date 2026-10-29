import { formatFileSize } from './constants.js'
import { getCurrentProgress } from './progressState.js'

const operationLabels = {
  upload: '↑ 上传',
  'upload-directory': '↑ 上传文件夹',
  download: '↓ 下载',
  'download-directory': '↓ 下载文件夹',
  delete: '删除',
  rename: '重命名'
}

// 文件名不能把原生标题变成多行，也不能利用双向控制字符反转进度提示。
const compactText = (value, limit) => {
  const text = Array.from(String(value || '').replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim())
  return text.length > limit ? `${ text.slice(0, limit - 1).join('') }…` : text.join('')
}

const positiveCount = value => Math.max(0, Math.trunc(Number(value) || 0))
const percentage = value => Math.max(0, Math.min(100, Math.round(Number(value) || 0)))

/**
 * 把文件、文件夹和批量操作进度压缩为一行可读描述。
 * 文件夹优先使用总体进度和总字节数；扫描尚未结束时不展示虚假的百分比。
 *
 * @param {Object} task - 进度总线中的单个活动任务。
 * @returns {string} 不含路径和凭据、适合原生标题或取消菜单的进度摘要。
 */
export const formatProgressTask = task => {
  const directory = task.operation === 'upload-directory' || task.operation === 'download-directory'
  const transfer = directory || task.operation === 'upload' || task.operation === 'download'
  const folderTotal = positiveCount(task.folderQueueTotal)
  const hasOverall = task.overallProgress !== undefined && task.overallProgress !== null && Number.isFinite(Number(task.overallProgress))
  const progress = percentage(directory && hasOverall ? task.overallProgress : task.progress)
  const currentValue = directory ? task.completedBytes : task.current
  const totalValue = directory ? task.totalBytes : task.total
  const current = currentValue == null ? NaN : Number(currentValue)
  const total = totalValue == null ? NaN : Number(totalValue)
  const unknownTotal = transfer && totalValue === null && task.status !== 'queued' && task.status !== 'starting'
  const scanning = directory && folderTotal === 0 && progress < 100 && !(Number.isFinite(current) && current > 0)
  const parts = [
    `${ operationLabels[task.operation] || '正在处理' }${ scanning || unknownTotal ? '' : ` ${ progress }%` }`
  ]
  if (scanning) parts.push('正在扫描文件夹')
  const queueTotal = positiveCount(task.queueTotal)
  if (queueTotal > 1) parts.push(`第 ${ Math.min(positiveCount(task.queueIndex) + 1, queueTotal) }/${ queueTotal } 项`)
  if (directory && folderTotal > 0) {
    parts.push(`文件 ${ Math.min(positiveCount(task.folderQueueIndex) + 1, folderTotal) }/${ folderTotal }`)
  }
  if (!scanning && Number.isFinite(current) && Number.isFinite(total) && total > 0 && current >= 0) {
    parts.push(`${ formatFileSize(Math.min(current, total)) } / ${ formatFileSize(total) }`)
  } else if (!scanning && unknownTotal && Number.isFinite(current) && current >= 0) {
    parts.push(formatFileSize(current))
  }
  const fileName = compactText(task.fileName, 32)
  if (fileName) parts.push(fileName)
  const message = compactText(task.message, 24)
  if (message && !scanning) parts.push(message)
  return parts.join(' · ')
}

/**
 * 为当前窗口合成传输标题；任务全部结束后恢复最新的连接标题。
 *
 * @param {string} baseTitle - 不含进度的窗口原始标题。
 * @param {Object} state - 当前窗口独立的进度状态。
 * @returns {string} 包含活动任务数量和固定当前任务的原生窗口标题。
 */
export const formatProgressWindowTitle = (baseTitle, state) => {
  const task = getCurrentProgress(state)
  if (!task) return baseTitle
  const count = state.order.filter(key => state.tasks[key]).length
  return `${ count > 1 ? `${ count } 个任务 · ` : '' }${ formatProgressTask(task) } — ${ baseTitle }`
}

/**
 * 串行、限频地写入原生标题，只保留积压更新中的最新一条。
 * 避免异步 IPC 返回顺序不同，把已恢复的标题重新覆盖为旧进度。
 *
 * @param {(title: string) => Promise<void>} setTitle - 原生窗口标题写入接口。
 * @param {number} [interval=250] - 两次原生写入的最小间隔，单位为毫秒。
 * @param {(error: unknown) => void} [onError] - 原生接口异常回调。
 * @returns {{update: (title: string) => void, dispose: () => void}} 最新标题写入和资源清理接口。
 */
export const createProgressTitleUpdater = (setTitle, interval = 250, onError = error => console.warn('更新窗口传输标题失败：', error)) => {
  let requestedTitle
  let writtenTitle
  let writing = false
  let disposed = false
  let timer
  let lastWriteAt = 0

  const flush = async () => {
    timer = undefined
    if (disposed || writing || requestedTitle === undefined || requestedTitle === writtenTitle) return
    const delay = Math.max(0, lastWriteAt + interval - Date.now())
    if (delay > 0) {
      timer = setTimeout(flush, delay)
      return
    }
    const title = requestedTitle
    writing = true
    lastWriteAt = Date.now()
    try {
      await setTitle(title)
      writtenTitle = title
    } catch (error) {
      onError(error)
    } finally {
      writing = false
      // 同一条失败写入不自动重试，后续新进度仍可继续更新。
      if (!disposed && requestedTitle !== title) void flush()
    }
  }

  return {
    update: title => {
      if (disposed) return
      requestedTitle = title
      if (!writing && timer === undefined) void flush()
    },
    dispose: () => {
      disposed = true
      clearTimeout(timer)
    }
  }
}
