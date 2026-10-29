import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import PubSub from 'pubsub-js'
import { getErrorDetails, PROGRESS_UPDATE_INTERVAL_MS, PubSubBusinessKeyEnum, normalizeError } from '../utils/constants.js'
import { ProgressContext } from '../utils/progressContext.js'
import { PROGRESS_END, PROGRESS_EVENT_END, PROGRESS_UPDATE, createInitialProgressState, getProgressKey, progressReducer } from '../utils/progressState.js'
import { createProgressTitleUpdater, formatProgressWindowTitle } from '../utils/progressTitle.js'
import { notification } from '../utils/notificationUtils.js'

/**
 * 管理当前窗口的进度订阅、原生标题及取消回调，不渲染底部进度面板。
 * 所有消费者复用一个订阅，文件工具栏与窗口标题不会分别维护相互冲突的任务状态。
 *
 * @param {{baseTitle: string, children: React.ReactNode}} props - 原始窗口标题及工作区内容。
 * @returns {JSX.Element} 为工作区提供传输状态的无布局容器。
 */
const TransferProgressProvider = ({ baseTitle, children }) => {
  const [ state, dispatch ] = useReducer(progressReducer, undefined, createInitialProgressState)
  const [ cancellingKeys, setCancellingKeys ] = useState(new Set())
  const stateRef = useRef(state)
  const mountedRef = useRef(false)
  const pendingCancelsRef = useRef(new Set())
  const titleUpdaterRef = useRef(null)
  const title = formatProgressWindowTitle(baseTitle, state)
  stateRef.current = state

  useEffect(() => {
    mountedRef.current = true
    const pendingUpdates = new Map()
    let timer
    const flushPendingUpdates = () => {
      timer = undefined
      pendingUpdates.forEach(payload => dispatch({ type: PROGRESS_UPDATE, payload }))
      pendingUpdates.clear()
    }
    const token = PubSub.subscribe(PubSubBusinessKeyEnum.MASK, (_, data) => {
      if (!data?.taskId || !data?.maskId) return
      if (data.event === PROGRESS_EVENT_END) {
        pendingUpdates.delete(getProgressKey(data))
        dispatch({ type: PROGRESS_END, taskId: data.taskId, maskId: data.maskId })
        return
      }
      pendingUpdates.set(getProgressKey(data), data)
      if (timer === undefined) timer = setTimeout(flushPendingUpdates, PROGRESS_UPDATE_INTERVAL_MS)
    })
    const updater = createProgressTitleUpdater(nextTitle => getCurrentWindow().setTitle(nextTitle))
    titleUpdaterRef.current = updater
    return () => {
      mountedRef.current = false
      PubSub.unsubscribe(token)
      clearTimeout(timer)
      pendingUpdates.clear()
      updater.dispose()
      titleUpdaterRef.current = null
    }
  }, [])

  useEffect(() => {
    // 同步文档标题，让非原生预览也能观察状态；真实桌面窗口仍由 setTitle 更新。
    document.title = title
    titleUpdaterRef.current?.update(title)
  }, [title])

  const cancelTask = useCallback(async key => {
    const task = stateRef.current.tasks[key]
    if (typeof task?.onCancel !== 'function' || pendingCancelsRef.current.has(key)) return
    pendingCancelsRef.current.add(key)
    setCancellingKeys(new Set(pendingCancelsRef.current))
    try {
      await task.onCancel()
    } catch (error) {
      void notification.error('取消操作失败', normalizeError(error), { delivery: 'in-app', details: getErrorDetails(error) })
    } finally {
      // 等待生产者发送结束事件，不在取消请求刚被受理时伪造任务已完成。
      pendingCancelsRef.current.delete(key)
      if (mountedRef.current) setCancellingKeys(new Set(pendingCancelsRef.current))
    }
  }, [])

  const context = useMemo(() => ({
    tasks: state.order.map(key => state.tasks[key]).filter(Boolean),
    cancellingKeys,
    cancelTask
  }), [ state, cancellingKeys, cancelTask ])

  return <ProgressContext.Provider value={context}>{children}</ProgressContext.Provider>
}

export default TransferProgressProvider
