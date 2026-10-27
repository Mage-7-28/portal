/**
 * Resolve where inspected drag-and-drop paths should go after asynchronous inspection.
 *
 * @param {{appendToQueue: boolean, sessionId: number}} origin - Upload modal state when the drop began.
 * @param {{modalOpen: boolean, sessionId: number, submitting: boolean}} current - Current upload modal state.
 * @returns {'append'|'upload'|'ignore'} The safe action for the inspected paths.
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
 * Check whether an asynchronous file-picker result still belongs to the active upload modal.
 *
 * @param {number} sessionId - Session captured when the picker opened.
 * @param {{sessionId: number, modalOpen: boolean, submitting: boolean}} current - Current upload modal state.
 * @returns {boolean} Whether the picker result may be added to the queue.
 */
export const isUploadSessionActive = (sessionId, { sessionId: currentSessionId, modalOpen, submitting }) => (
  sessionId === currentSessionId && modalOpen && !submitting
)
