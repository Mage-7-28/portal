/**
 * 预览专用 Worker：只执行可能阻塞主线程的大型 JSON 格式化任务。
 *
 * Worker 只接收带任务 ID 的 JSON 格式化消息，并将结果原样回传给调用方。
 */
import { formatJsonContent } from '../utils/jsonFormat.js'

/**
 * 处理主线程发来的 JSON 格式化任务。
 *
 * @param {MessageEvent<{id?: string, type?: string, content?: string}>} event - Worker 消息事件。
 * @returns {void} 无效消息直接忽略；有效任务通过 `postMessage` 返回结果。
 */
globalThis.onmessage = event => {
  const { id, type, content } = event.data || {}
  if (type !== 'format-json' || !id) return
  const result = formatJsonContent(content)
  globalThis.postMessage({ id, ...result })
}
