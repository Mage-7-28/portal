/**
 * 预览专用 Worker：执行有预算的 JSON 格式化和源代码高亮。
 *
 * 每个实例只服务一个任务；取消和超时由调用方终止实例。
 */
import { formatJsonContent } from '../utils/jsonFormat.js'

/**
 * 处理主线程发来的格式化或高亮任务。
 *
 * @param {MessageEvent<{type?: string, content?: string, language?: string}>} event - Worker 消息事件。
 * @returns {Promise<void>} 无效消息直接忽略；有效任务通过 `postMessage` 返回结果。
 */
globalThis.onmessage = async event => {
  const { type, content, language } = event.data || {}
  if (type === 'format-json') {
    globalThis.postMessage(formatJsonContent(content))
  } else if (type === 'highlight') {
    // Prism 默认会给 Worker 安装 JSON 字符串消息监听器，必须在加载前关闭。
    globalThis.Prism = { disableWorkerMessageHandler: true, manual: true }
    const { highlightCodeContent } = await import('../utils/highlightUtils.js')
    globalThis.postMessage(await highlightCodeContent(String(content || ''), language))
  }
}
