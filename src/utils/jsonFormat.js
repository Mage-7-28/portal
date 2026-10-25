// 输入按 UTF-16 码元计数；格式化输出单独设预算，避免缩进把小输入放大。
export const MAX_JSON_INPUT_CHARS = 5 * 1024 * 1024
export const MAX_JSON_OUTPUT_CHARS = 5 * 1024 * 1024
export const MAX_JSON_DEPTH = 128

/**
 * 在解析前检查容器深度，字符串内的括号和转义不会参与层级计算。
 *
 * @param {string} source - JSON 原文。
 * @returns {boolean} 未超过允许的容器嵌套深度时返回 true。
 */
const hasBoundedDepth = source => {
  let depth = 0
  let inString = false
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]
    if (inString) {
      if (character === '\\') index += 1
      else if (character === '"') inString = false
    } else if (character === '"') {
      inString = true
    } else if (character === '{' || character === '[') {
      depth += 1
      if (depth > MAX_JSON_DEPTH) return false
    } else if (character === '}' || character === ']') {
      depth -= 1
    }
  }
  return true
}

/**
 * 估算两空格 JSON 输出长度；超过预算立即停止，不提前构造派生字符串。
 *
 * @param {unknown} value - JSON.parse 生成的值，不包含自定义序列化行为。
 * @param {number} [depth=0] - 当前值之前的容器层数。
 * @returns {number} 预计 UTF-16 码元数，超限时可大于输出预算。
 */
const formattedLength = (value, depth = 0) => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value).length
  const array = Array.isArray(value)
  const keys = array ? null : Object.keys(value)
  const count = array ? value.length : keys.length
  if (count === 0) return 2
  // 括号、逗号、换行及每个成员和闭合括号前的两空格缩进。
  let length = 2 + count - 1 + count + 1 + (count * (depth + 1) + depth) * 2
  for (let index = 0; index < count && length <= MAX_JSON_OUTPUT_CHARS; index += 1) {
    const key = array ? index : keys[index]
    if (!array) length += JSON.stringify(key).length + 2
    length += formattedLength(value[key], depth + 1)
  }
  return length
}

/**
 * 尝试格式化 JSON 文本；该函数仅用于界面展示，不会修改远程文件内容。
 *
 * @param {string|unknown} content - 待格式化的原始文本或可转换为文本的值。
 * @returns {{content: string, formatted: boolean}} 预算内的格式化文本；非法或超预算时返回原文。
 */
export const formatJsonContent = (content) => {
  const source = String(content || '').replace(/^\uFEFF/, '')
  const fallback = { content: source, formatted: false }
  if (source.length > MAX_JSON_INPUT_CHARS || !hasBoundedDepth(source)) return fallback
  try {
    const value = JSON.parse(source)
    if (formattedLength(value) > MAX_JSON_OUTPUT_CHARS) return fallback
    return {
      content: JSON.stringify(value, null, 2),
      formatted: true
    }
  } catch {
    return fallback
  }
}
