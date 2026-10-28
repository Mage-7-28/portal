export const PROGRESS_UPDATE = 'progress/update'
export const PROGRESS_END = 'progress/end'
export const PROGRESS_EVENT_END = 'end'
export const DEFAULT_ENDED_ID_LIMIT = 32

/**
 * 为进度任务及其展示生成稳定键。
 *
 * @param {{taskId?: string, maskId?: string}|null|undefined} ids - 任务标识。
 * @returns {string|null} 组合键；没有可用标识时返回 null。
 */
export const getProgressKey = (ids) => {
  const taskId = ids?.taskId || ''
  const maskId = ids?.maskId || ''
  if (!taskId && !maskId) return null
  return `${ taskId }\u0000${ maskId }`
}

/**
 * 创建不可变的初始进度状态。
 *
 * @param {number} [endedIdLimit=DEFAULT_ENDED_ID_LIMIT] - 最多保留的已结束任务键数量。
 * @returns {{tasks: Object, order: string[], endedIds: string[], endedIdLimit: number}} 初始状态。
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
 * 应用单条进度事件，避免一个任务清除另一个任务。
 *
 * @param {Object} state - 当前进度状态。
 * @param {{type: string, payload?: Object, taskId?: string, maskId?: string}} action - 进度操作。
 * @returns {Object} 下一状态。
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
      // 按启动顺序保留任务，避免并发传输的高频更新让窗口标题来回跳动。
      order: previous ? state.order : [ ...state.order, key ]
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
 * 返回最早启动且尚未结束的进度任务，其他任务更新时不抢占展示。
 *
 * @param {Object} state - 当前进度状态。
 * @returns {Object|null} 当前任务；没有活动任务时返回 null。
 */
export const getCurrentProgress = (state) => {
  if (!state) return null
  for (let index = 0; index < state.order.length; index += 1) {
    const task = state.tasks[state.order[index]]
    if (task) return task
  }
  return null
}

let progressSequence = 0

/**
 * 为进度生产者生成唯一标识。
 *
 * @param {string} [scope='progress'] - 便于阅读的生产者作用域。
 * @returns {{taskId: string, maskId: string}} 新的任务和进度展示标识。
 */
export const createProgressIds = (scope = 'progress') => {
  const taskId = `${ scope }-${ Date.now() }-${ ++progressSequence }`
  return {
    taskId,
    maskId: `${ taskId }-mask`
  }
}
