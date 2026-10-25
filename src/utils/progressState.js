export const PROGRESS_UPDATE = 'progress/update'
export const PROGRESS_END = 'progress/end'
export const PROGRESS_EVENT_END = 'end'
export const DEFAULT_ENDED_ID_LIMIT = 32

/**
 * Create a stable key for a progress task and its rendered mask.
 *
 * @param {{taskId?: string, maskId?: string}|null|undefined} ids - Task identifiers.
 * @returns {string|null} Composite key or null when no identifier is available.
 */
export const getProgressKey = (ids) => {
  const taskId = ids?.taskId || ''
  const maskId = ids?.maskId || ''
  if (!taskId && !maskId) return null
  return `${ taskId }\u0000${ maskId }`
}

/**
 * Create the initial immutable progress state.
 *
 * @param {number} [endedIdLimit=DEFAULT_ENDED_ID_LIMIT] - Maximum retained ended task keys.
 * @returns {{tasks: Object, order: string[], endedIds: string[], endedIdLimit: number}} Initial state.
 */
export const createInitialProgressState = (endedIdLimit = DEFAULT_ENDED_ID_LIMIT) => ({
  tasks: {},
  order: [],
  endedIds: [],
  endedIdLimit: Math.max(0, Math.trunc(Number(endedIdLimit) || 0))
})

const hasEnded = (state, key) => state.endedIds.includes(key)

const rememberEnded = (state, key) => {
  if (state.endedIdLimit === 0) return []
  return [
    ...state.endedIds.filter(endedKey => endedKey !== key),
    key
  ].slice(-state.endedIdLimit)
}

/**
 * Apply one progress event without allowing a task to clear another task.
 *
 * @param {Object} state - Current progress state.
 * @param {{type: string, payload?: Object, taskId?: string, maskId?: string}} action - Progress action.
 * @returns {Object} Next progress state.
 */
export const progressReducer = (state, action) => {
  if (!state || !action) return state

  if (action.type === PROGRESS_UPDATE) {
    const payload = action.payload || {}
    const key = getProgressKey(payload)
    if (!key || hasEnded(state, key)) return state

    const previous = state.tasks[key]
    const task = {
      ...previous,
      ...payload,
      taskId: payload.taskId || previous?.taskId,
      maskId: payload.maskId || previous?.maskId
    }
    return {
      ...state,
      tasks: {
        ...state.tasks,
        [key]: task
      },
      order: [ ...state.order.filter(orderKey => orderKey !== key), key ]
    }
  }

  if (action.type === PROGRESS_END) {
    const key = getProgressKey(action)
    if (!key) return state

    const tasks = { ...state.tasks }
    delete tasks[key]
    return {
      ...state,
      tasks,
      order: state.order.filter(orderKey => orderKey !== key),
      endedIds: rememberEnded(state, key)
    }
  }

  return state
}

/**
 * Return the most recently updated active progress task.
 *
 * @param {Object} state - Current progress state.
 * @returns {Object|null} Current task or null when no task is active.
 */
export const getCurrentProgress = (state) => {
  if (!state) return null
  for (let index = state.order.length - 1; index >= 0; index -= 1) {
    const task = state.tasks[state.order[index]]
    if (task) return task
  }
  return null
}

let progressSequence = 0

/**
 * Create unique identifiers for a progress producer.
 *
 * @param {string} [scope='progress'] - Human-readable producer scope.
 * @returns {{taskId: string, maskId: string}} New task and mask identifiers.
 */
export const createProgressIds = (scope = 'progress') => {
  const taskId = `${ scope }-${ Date.now() }-${ ++progressSequence }`
  return {
    taskId,
    maskId: `${ taskId }-mask`
  }
}
