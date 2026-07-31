import { formatJsonContent } from '../utils/jsonFormat.js'

globalThis.onmessage = event => {
  const { id, type, content } = event.data || {}
  if (type !== 'format-json' || !id) return
  const result = formatJsonContent(content)
  globalThis.postMessage({ id, ...result })
}
