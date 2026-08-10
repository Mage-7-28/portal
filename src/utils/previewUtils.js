/**
 * 预览类型识别、按需加载语法高亮和大型 JSON 工作线程调度。
 *
 * 大文件格式化会切换到 Worker，避免阻塞文件浏览器主线程。
 */
import Prism from 'prismjs'
import { formatJsonContent } from './jsonFormat.js'

// 远程文件预览和语法高亮的内存上限，避免把大型二进制或文本一次性加载进 WebView。
export const MAX_PREVIEW_BYTES = 5 * 1024 * 1024
export const MAX_HIGHLIGHT_BYTES = 1024 * 1024
// 超过该阈值的 JSON 转交 Worker，较小内容直接格式化以减少线程通信开销。
const JSON_WORKER_THRESHOLD = 256 * 1024

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

// language -> Promise，合并同一语言的并发动态 import。
const languagePromises = new Map()

/**
 * 按需加载 Prism 语言定义，并共享并发加载 Promise。
 *
 * @param {string} language - Prism 语言标识。
 * @returns {Promise<boolean>} 语言定义已可用时返回 true；不支持时返回 false。
 */
const loadLanguage = async (language) => {
  if (!language || Prism.languages[language]) return Boolean(Prism.languages[language])
  const loader = languageLoaders[language]
  if (!loader) return false
  if (!languagePromises.has(language)) {
    languagePromises.set(language, loader().then(() => Boolean(Prism.languages[language])))
  }
  return languagePromises.get(language)
}

// Prism 语言模块的按需加载器；依赖语言先加载父语法再加载具体扩展。
const languageLoaders = {
  markup: () => import('prismjs/components/prism-markup.js'),
  css: () => import('prismjs/components/prism-css.js'),
  scss: async () => {
    await loadLanguage('css')
    await import('prismjs/components/prism-scss.js')
  },
  less: async () => {
    await loadLanguage('css')
    await import('prismjs/components/prism-less.js')
  },
  clike: () => import('prismjs/components/prism-clike.js'),
  javascript: async () => {
    await loadLanguage('clike')
    await import('prismjs/components/prism-javascript.js')
  },
  jsx: async () => {
    await loadLanguage('markup')
    await loadLanguage('javascript')
    await import('prismjs/components/prism-jsx.js')
  },
  typescript: async () => {
    await loadLanguage('javascript')
    await import('prismjs/components/prism-typescript.js')
  },
  tsx: async () => {
    await loadLanguage('jsx')
    await loadLanguage('typescript')
    await import('prismjs/components/prism-tsx.js')
  },
  json: () => import('prismjs/components/prism-json.js'),
  json5: async () => {
    await loadLanguage('json')
    await import('prismjs/components/prism-json5.js')
  },
  python: () => import('prismjs/components/prism-python.js'),
  java: async () => {
    await loadLanguage('clike')
    await import('prismjs/components/prism-java.js')
  },
  go: async () => {
    await loadLanguage('clike')
    await import('prismjs/components/prism-go.js')
  },
  rust: () => import('prismjs/components/prism-rust.js'),
  sql: () => import('prismjs/components/prism-sql.js'),
  bash: () => import('prismjs/components/prism-bash.js'),
  yaml: () => import('prismjs/components/prism-yaml.js'),
  toml: () => import('prismjs/components/prism-toml.js'),
  markdown: async () => {
    await loadLanguage('markup')
    await import('prismjs/components/prism-markdown.js')
  },
  c: async () => {
    await loadLanguage('clike')
    await import('prismjs/components/prism-c.js')
  },
  cpp: async () => {
    await loadLanguage('c')
    await import('prismjs/components/prism-cpp.js')
  },
  csharp: async () => {
    await loadLanguage('clike')
    await import('prismjs/components/prism-csharp.js')
  },
  php: async () => {
    await loadLanguage('markup')
    await import('prismjs/components/prism-markup-templating.js')
    await import('prismjs/components/prism-php.js')
  },
  kotlin: async () => {
    await loadLanguage('clike')
    await import('prismjs/components/prism-kotlin.js')
  },
  swift: () => import('prismjs/components/prism-swift.js'),
  docker: () => import('prismjs/components/prism-docker.js'),
  ini: () => import('prismjs/components/prism-ini.js'),
  properties: () => import('prismjs/components/prism-properties.js'),
  csv: () => import('prismjs/components/prism-csv.js')
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

// Worker 延迟创建并复用；任务表用于把异步消息路由回对应 Promise。
let jsonWorker = null
let jsonWorkerSequence = 0
const jsonWorkerJobs = new Map()

// 大型 JSON 格式化放到独立线程执行，小文件保持同步处理。
/**
 * 创建并复用 JSON 格式化 Worker，同时集中处理任务回调和线程异常。
 *
 * @returns {Worker} 可接收 `format-json` 请求的浏览器 Worker 实例。
 */
const getJsonWorker = () => {
  if (jsonWorker) return jsonWorker
  jsonWorker = new Worker(
    new URL('../workers/previewWorker.js', import.meta.url),
    { type: 'module' }
  )
  // Worker 完成消息按任务 ID 还原到对应 Promise，并立即移除任务引用。
  jsonWorker.onmessage = event => {
    const { id, content, formatted } = event.data || {}
    const job = jsonWorkerJobs.get(id)
    if (!job) return
    jsonWorkerJobs.delete(id)
    job.resolve({ content, formatted })
  }
  // Worker 发生线程级错误时拒绝全部等待任务并销毁实例，下一次请求会重新创建。
  jsonWorker.onerror = event => {
    const error = new Error(event.message || 'JSON 格式化线程失败')
    jsonWorkerJobs.forEach(job => job.reject(error))
    jsonWorkerJobs.clear()
    jsonWorker?.terminate()
    jsonWorker = null
  }
  return jsonWorker
}

/**
 * 小 JSON 同步格式化，大 JSON 转交 Worker 避免阻塞界面线程。
 *
 * @param {string|unknown} content - 待格式化的原始文本或可转换为文本的值。
 * @returns {Promise<JsonFormatResult>} 原始或格式化后的 JSON 文本及成功状态。
 */
export const formatJsonPreviewAsync = (content) => {
  const source = String(content || '').replace(/^\uFEFF/, '')
  if (source.length <= JSON_WORKER_THRESHOLD) return Promise.resolve(formatJsonContent(source))
  if (typeof window === 'undefined' || typeof Worker === 'undefined') {
    return Promise.resolve(formatJsonContent(source))
  }

  return new Promise((resolve, reject) => {
    const id = `json-${ ++jsonWorkerSequence }`
    jsonWorkerJobs.set(id, { resolve, reject })
    getJsonWorker().postMessage({ id, type: 'format-json', content: source })
  })
}

/**
 * 在大小限制内异步加载语法并返回高亮 HTML；失败时保留原文。
 *
 * @param {string|unknown} content - 待高亮的源代码文本。
 * @param {string} language - Prism 语言标识。
 * @returns {Promise<HighlightResult>} 高亮 HTML，或保留原文的降级结果。
 */
export const highlightCode = async (content, language) => {
  const source = String(content || '')
  if (source.length > MAX_HIGHLIGHT_BYTES) {
    return {
      content: source,
      highlighted: false
    }
  }
  try {
    await loadLanguage(language)
    const grammar = Prism.languages[language]
    if (!grammar) {
      return {
        content: source,
        highlighted: false
      }
    }
    return {
      html: Prism.highlight(source, grammar, language),
      highlighted: true
    }
  } catch {
    return {
      content: source,
      highlighted: false
    }
  }
}
