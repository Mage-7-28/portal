// JSON 格式化仅用于界面展示，不会修改远程文件内容。
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
