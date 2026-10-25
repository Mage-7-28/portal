/**
 * 预览类型识别与有界、可取消的 JSON 格式化和高亮任务。
 *
 * 浏览器中的格式化和高亮均交给 Worker，避免阻塞文件浏览器主线程。
 */
import { createPreviewTaskRunner } from './previewTasks.js'
import { formatJsonContent } from './jsonFormat.js'

// 远程文件预览和语法高亮的内存上限，避免把大型二进制或文本一次性加载进 WebView。
export const MAX_PREVIEW_BYTES = 5 * 1024 * 1024
const MAX_HIGHLIGHT_CHARS = 1024 * 1024

/**
 * @typedef {Object} PreviewDescriptor
 * @property {'image'|'text'|'code'|'unsupported'} kind - 前端应使用的预览渲染方式。
 * @property {string} name - 原始文件名或路径。
 * @property {string} [mime] - 图片预览需要的 MIME 类型。
 * @property {string} [language] - Prism 代码高亮语言标识。
 */

/**
 * @typedef {Object} JsonFormatResult
 * @property {string} content - 原始或格式化后的 JSON 文本。
 * @property {boolean} formatted - JSON 解析和格式化是否成功。
 */

/**
 * @typedef {Object} HighlightResult
 * @property {boolean} highlighted - 是否已生成 Prism 高亮 HTML。
 * @property {string} [html] - 高亮成功时可安全插入代码视图的 HTML。
 * @property {string} [content] - 不支持或失败时保留的原始文本。
 */

// 图片扩展名到 MIME 的映射，供 Blob URL 和预览元素选择正确的解码器。
const imageMimes = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  avif: 'image/avif'
}

// 文件扩展名到 Prism 语言标识的映射；语言代码按需动态加载。
const codeLanguages = {
  js: 'javascript',
  jsx: 'jsx',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'typescript',
  tsx: 'tsx',
  json: 'json',
  json5: 'json5',
  html: 'markup',
  htm: 'markup',
  xml: 'markup',
  xhtml: 'markup',
  css: 'css',
  scss: 'scss',
  less: 'less',
  md: 'markdown',
  markdown: 'markdown',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  py: 'python',
  python: 'python',
  java: 'java',
  kt: 'kotlin',
  kts: 'kotlin',
  go: 'go',
  rs: 'rust',
  c: 'c',
  h: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  php: 'php',
  swift: 'swift',
  sql: 'sql',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  dockerfile: 'docker',
  ini: 'ini',
  conf: 'ini',
  properties: 'properties',
  csv: 'csv'
}

// 无需语法高亮即可安全展示的纯文本扩展名。
const textExtensions = new Set([ 'txt', 'text', 'log', 'rst', 'adoc' ])

// 明确不在预览层解码的二进制、办公和媒体扩展名，提示用户下载后打开。
const unsupportedExtensions = new Set([
  'jar', 'war', 'ear', 'class',
  'exe', 'dll', 'so', 'dylib', 'bin',
  'zip', '7z', 'rar', 'tar', 'tar.gz', 'gz', 'bz2', 'xz', 'tgz',
  'apk', 'aab', 'dmg', 'iso', 'deb', 'rpm', 'msi',
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
  'woff', 'woff2', 'ttf', 'otf', 'eot',
  'mp3', 'wav', 'ogg', 'flac', 'mp4', 'mov', 'avi', 'mkv'
])

// 无扩展名但具有约定语义的文件名，优先于普通扩展名识别。
const specialFiles = {
  dockerfile: { kind: 'code', language: 'docker' },
  makefile: { kind: 'text' },
  readme: { kind: 'text' },
  license: { kind: 'text' },
  '.env': { kind: 'text' }
}

/**
 * 从文件名中提取预览分类使用的扩展名，保留 `.tar.gz` 这样的复合扩展名。
 *
 * @param {string} name - 文件名或完整路径。
 * @returns {string} 小写扩展名；无扩展名时返回小写文件名。
 */
const extensionOf = (name) => {
  const lowerName = String(name || '').toLowerCase()
  if (lowerName.endsWith('.tar.gz')) return 'tar.gz'
  const lastDot = lowerName.lastIndexOf('.')
  return lastDot >= 0 ? lowerName.slice(lastDot + 1) : lowerName
}

/**
 * 根据文件名判断图片、文本、代码或不支持的预览类型。
 *
 * @param {string} name - 文件名或完整路径。
 * @returns {PreviewDescriptor} 供预览组件选择渲染器的描述对象。
 */
export const getPreviewDescriptor = (name) => {
  const fileName = String(name || '')
  const lowerName = fileName.toLowerCase()
  const baseName = lowerName.split(/[\\/]/).pop() || lowerName
  const special = specialFiles[baseName]
  if (special) return { ...special, name: fileName }

  const extension = extensionOf(fileName)
  if (imageMimes[extension]) {
    return {
      kind: 'image',
      mime: imageMimes[extension],
      name: fileName
    }
  }
  if (unsupportedExtensions.has(extension) || unsupportedExtensions.has(baseName)) {
    return { kind: 'unsupported', name: fileName }
  }
  if (codeLanguages[extension]) {
    return {
      kind: 'code',
      language: codeLanguages[extension],
      name: fileName
    }
  }
  if (textExtensions.has(extension)) return { kind: 'text', name: fileName }

  return { kind: 'unsupported', name: fileName }
}

// 不在调用线程执行 Prism；每个任务拥有独立线程，关闭时可以立即终止。
const runPreviewTask = createPreviewTaskRunner(() => new Worker(
  new URL('../workers/previewWorker.js', import.meta.url),
  { type: 'module' }
))

/**
 * 在 Worker 中格式化 JSON；无 Worker 的环境仍使用有预算的共享格式化器。
 *
 * @param {string|unknown} content - 待格式化文本。
 * @param {{signal?: AbortSignal}} [options={}] - 当前预览生命周期的取消信号。
 * @returns {Promise<JsonFormatResult>} 格式化文本或保留原文的降级结果。
 */
export const formatJsonPreviewAsync = async (content, { signal } = {}) => {
  const source = String(content || '').replace(/^\uFEFF/, '')
  if (signal?.aborted) {
    const error = new Error('预览已取消')
    error.name = 'AbortError'
    throw error
  }
  if (typeof Worker === 'undefined') return formatJsonContent(source)
  return runPreviewTask('format-json', { content: source }, signal)
}

/**
 * 在 Worker 中高亮源代码；失败、超时或超预算时保留原文。
 *
 * @param {string|unknown} content - 待高亮文本。
 * @param {string} language - Prism 语言标识。
 * @param {{signal?: AbortSignal}} [options={}] - 当前预览生命周期的取消信号。
 * @returns {Promise<HighlightResult>} 已转义的 HTML 或原文降级结果。
 */
export const highlightCode = async (content, language, { signal } = {}) => {
  const source = String(content || '')
  if (source.length > MAX_HIGHLIGHT_CHARS || typeof Worker === 'undefined') {
    return { content: source, highlighted: false }
  }
  return runPreviewTask('highlight', { content: source, language }, signal)
}
