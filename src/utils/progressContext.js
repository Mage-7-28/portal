import { createContext, useContext } from 'react'

export const ProgressContext = createContext({ tasks: [], cancellingKeys: new Set(), cancelTask: async () => {} })

/**
 * 读取当前窗口独立的传输状态和取消入口；没有活动任务时不会占用布局。
 *
 * @returns {{tasks: Object[], cancellingKeys: Set<string>, cancelTask: (key: string) => Promise<void>}} 任务及操作状态。
 */
export const useProgressContext = () => useContext(ProgressContext)
