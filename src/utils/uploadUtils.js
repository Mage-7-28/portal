/**
 * 解析异步检查拖放路径完成后应执行的上传操作。
 *
 * @param {{appendToQueue: boolean, sessionId: number}} origin - 开始拖放时的上传弹窗状态。
 * @param {{modalOpen: boolean, sessionId: number, submitting: boolean}} current - 当前上传弹窗状态。
 * @returns {'append'|'upload'|'ignore'} 对已检查路径执行的安全操作。
 */
export const getUploadDropResultAction = ({ appendToQueue, sessionId }, { modalOpen, sessionId: currentSessionId, submitting }) => {
  if (submitting) return 'ignore'
  if (appendToQueue) {
    return sessionId === currentSessionId && modalOpen ? 'append' : 'ignore'
  }
  if (sessionId !== currentSessionId) {
    return modalOpen ? 'append' : 'ignore'
  }
  if (modalOpen) return 'append'
  return 'upload'
}

/**
 * 检查异步文件选择结果是否仍属于当前上传弹窗。
 *
 * @param {number} sessionId - 打开选择器时记录的会话编号。
 * @param {{sessionId: number, modalOpen: boolean, submitting: boolean}} current - 当前上传弹窗状态。
 * @returns {boolean} 选择器结果是否可以加入上传队列。
 */
export const isUploadSessionActive = (sessionId, { sessionId: currentSessionId, modalOpen, submitting }) => (
  sessionId === currentSessionId && modalOpen && !submitting
)
