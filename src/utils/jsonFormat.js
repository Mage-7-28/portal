// Formats JSON for display only; the remote file is never modified.
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
