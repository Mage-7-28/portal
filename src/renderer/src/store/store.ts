import { proxy, subscribe, useSnapshot } from 'valtio'
import { cloneDeep, debounce } from 'lodash-es'

export const defaultData = {
  layout: {
    showPanel: false,
    panelWidth: 200
  }
}

const state = cloneDeep(defaultData)
const store = proxy(state)

// 从localStorage恢复状态
const restoreState = (): void => {
  try {
    const savedState = localStorage.getItem('store')
    if (savedState) {
      const parsedState = JSON.parse(savedState)
      // 只恢复需要持久化的字段
      Object.keys(store).forEach((key) => {
        // 使用更安全的方式检查属性是否存在
        if (Object.prototype.hasOwnProperty.call(parsedState, key)) {
          // 使用类型断言确保类型安全
          store[key as keyof typeof store] = parsedState[key] as (typeof store)[keyof typeof store]
        }
      })
    }
  } catch (error) {
    console.error('恢复状态失败:', error)
  }
}

// 保存状态到localStorage
const saveState = (): void => {
  try {
    localStorage.setItem('store', JSON.stringify(store))
  } catch (error) {
    console.error('保存状态失败:', error)
  }
}

// 使用lodash的debounce函数，避免频繁写入
const debouncedSave = debounce(saveState, 100)

// 监听状态变化，自动保存
subscribe(store, debouncedSave)

// 应用启动时恢复状态
restoreState()

// 导出store实例，用于直接修改状态
export { store }

export const useStore = (): ReturnType<typeof useSnapshot<typeof store>> => {
  return useSnapshot(store)
}
