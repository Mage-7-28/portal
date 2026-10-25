/**
 * Worker 内的按需语法加载与高亮。输入和传回界面的 HTML 分别限制大小。
 */
import Prism from 'prismjs'

export const MAX_HIGHLIGHT_CHARS = 1024 * 1024
const MAX_HIGHLIGHT_HTML_CHARS = 5 * 1024 * 1024

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

/**
 * 生成预算内的 Prism HTML；不支持的语言或失败时保留原文。
 *
 * @param {string} source - 待高亮的源文本，以 UTF-16 码元限制大小。
 * @param {string} language - Prism 语言标识。
 * @returns {Promise<Object>} 已转义的 HTML，或原文降级结果。
 */
export const highlightCodeContent = async (source, language) => {
  const fallback = { content: source, highlighted: false }
  if (source.length > MAX_HIGHLIGHT_CHARS) return fallback
  try {
    await loadLanguage(language)
    const grammar = Prism.languages[language]
    if (!grammar) return fallback
    const html = Prism.highlight(source, grammar, language)
    return html.length <= MAX_HIGHLIGHT_HTML_CHARS
      ? { html, highlighted: true }
      : fallback
  } catch {
    return fallback
  }
}
