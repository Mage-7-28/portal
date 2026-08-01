import Prism from 'prismjs'
import { formatJsonContent } from './jsonFormat.js'

export const MAX_PREVIEW_BYTES = 5 * 1024 * 1024
export const MAX_HIGHLIGHT_BYTES = 1024 * 1024
const JSON_WORKER_THRESHOLD = 256 * 1024

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

const languagePromises = new Map()

const loadLanguage = async (language) => {
  if (!language || Prism.languages[language]) return Boolean(Prism.languages[language])
  const loader = languageLoaders[language]
  if (!loader) return false
  if (!languagePromises.has(language)) {
    languagePromises.set(language, loader().then(() => Boolean(Prism.languages[language])))
  }
  return languagePromises.get(language)
}

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

const textExtensions = new Set([ 'txt', 'text', 'log', 'rst', 'adoc' ])

const unsupportedExtensions = new Set([
  'jar', 'war', 'ear', 'class',
  'exe', 'dll', 'so', 'dylib', 'bin',
  'zip', '7z', 'rar', 'tar', 'tar.gz', 'gz', 'bz2', 'xz', 'tgz',
  'apk', 'aab', 'dmg', 'iso', 'deb', 'rpm', 'msi',
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
  'woff', 'woff2', 'ttf', 'otf', 'eot',
  'mp3', 'wav', 'ogg', 'flac', 'mp4', 'mov', 'avi', 'mkv'
])

const specialFiles = {
  dockerfile: { kind: 'code', language: 'docker' },
  makefile: { kind: 'text' },
  readme: { kind: 'text' },
  license: { kind: 'text' },
  '.env': { kind: 'text' }
}

const extensionOf = (name) => {
  const lowerName = String(name || '').toLowerCase()
  if (lowerName.endsWith('.tar.gz')) return 'tar.gz'
  const lastDot = lowerName.lastIndexOf('.')
  return lastDot >= 0 ? lowerName.slice(lastDot + 1) : lowerName
}

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

let jsonWorker = null
let jsonWorkerSequence = 0
const jsonWorkerJobs = new Map()

// 大型 JSON 格式化放到独立线程执行，小文件保持同步处理。
const getJsonWorker = () => {
  if (jsonWorker) return jsonWorker
  jsonWorker = new Worker(
    new URL('../workers/previewWorker.js', import.meta.url),
    { type: 'module' }
  )
  jsonWorker.onmessage = event => {
    const { id, content, formatted } = event.data || {}
    const job = jsonWorkerJobs.get(id)
    if (!job) return
    jsonWorkerJobs.delete(id)
    job.resolve({ content, formatted })
  }
  jsonWorker.onerror = event => {
    const error = new Error(event.message || 'JSON 格式化线程失败')
    jsonWorkerJobs.forEach(job => job.reject(error))
    jsonWorkerJobs.clear()
    jsonWorker?.terminate()
    jsonWorker = null
  }
  return jsonWorker
}

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
