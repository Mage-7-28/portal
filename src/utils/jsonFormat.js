/**
 * 尝试格式化 JSON 文本；该函数仅用于界面展示，不会修改远程文件内容。
 *
 * @param {string|unknown} content - 待格式化的原始文本或可转换为文本的值。
 * @returns {{content: string, formatted: boolean}} 格式化后的文本，以及 JSON 解析是否成功。
 */
export const formatJsonContent = (content) => {
  const source = String(content || '').replace(/^\uFEFF/, '')
  try {
    return {
      content: JSON.stringify(JSON.parse(source), null, 2),
      formatted: true
    }
  } catch {
    return {
      content: source,
      formatted: false
    }
  }
}
