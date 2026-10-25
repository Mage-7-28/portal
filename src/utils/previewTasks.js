// 全部文件标签共享限额；取消任务会终止其 Worker，不把过期工作留在线程内。
const MAX_ACTIVE_TASKS = 2
const MAX_QUEUED_TASKS = 4
const MAX_QUEUED_CHARS = 10 * 1024 * 1024
const TASK_TIMEOUT_MS = 10_000

/**
 * 创建有界、可取消的预览任务调度器；每个 Worker 只处理一个任务。
 *
 * @param {() => Worker} createWorker - 创建模块 Worker 的工厂。
 * @returns {(type: string, payload: Object, signal?: AbortSignal) => Promise<Object>} 失败或超时返回原文，取消抛出 AbortError。
 */
export const createPreviewTaskRunner = createWorker => {
  const queue = []
  let active = 0
  let queuedChars = 0
  const drain = () => {
    while (active < MAX_ACTIVE_TASKS && queue.length > 0) {
      const next = queue.shift()
      queuedChars -= next.chars
      next.start()
    }
  }

  return (type, payload, signal) => new Promise((resolve, reject) => {
    const fallback = type === 'format-json'
      ? { content: payload.content, formatted: false }
      : { content: payload.content, highlighted: false }
    let worker
    let timer
    let running = false
    let settled = false
    const finish = (result, error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      const queuedIndex = queue.findIndex(job => job.start === start)
      if (queuedIndex >= 0) {
        queuedChars -= queue[queuedIndex].chars
        queue.splice(queuedIndex, 1)
      }
      if (worker) {
        worker.onmessage = null
        worker.onerror = null
        worker.onmessageerror = null
        worker.terminate()
      }
      if (running) active -= 1
      if (error) reject(error)
      else resolve(result)
      drain()
    }
    const abort = () => {
      const error = new Error('预览已取消')
      error.name = 'AbortError'
      finish(null, error)
    }
    const start = () => {
      running = true
      active += 1
      try {
        worker = createWorker()
        worker.onmessage = event => finish(event.data || fallback)
        worker.onerror = event => {
          event.preventDefault?.()
          finish(fallback)
        }
        worker.onmessageerror = () => finish(fallback)
        worker.postMessage({ type, ...payload })
      } catch {
        finish(fallback)
      }
    }

    if (signal?.aborted) {
      abort()
      return
    }
    const inputChars = payload.content.length
    const maxInputChars = (type === 'format-json' ? 5 : 1) * 1024 * 1024
    if (inputChars > maxInputChars || (active >= MAX_ACTIVE_TASKS
      && (queue.length >= MAX_QUEUED_TASKS || queuedChars + inputChars > MAX_QUEUED_CHARS))) {
      resolve(fallback)
      return
    }
    signal?.addEventListener('abort', abort, { once: true })
    timer = setTimeout(() => finish(fallback), TASK_TIMEOUT_MS)
    if (active < MAX_ACTIVE_TASKS) start()
    else {
      queuedChars += inputChars
      queue.push({ start, chars: inputChars })
    }
  })
}
