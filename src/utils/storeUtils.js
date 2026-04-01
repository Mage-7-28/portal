import { Store } from '@tauri-apps/plugin-store'
import { proxy, useSnapshot } from 'valtio'

/**
 * 响应式状态管理工具类
 * 基于 Tauri Store 和 Valtio 实现
 */
export class ReactiveStore {
  constructor(storeName = 'store.bin') {
    // 初始化 Tauri Store
    this.store = new Store(storeName)
    // 初始化响应式状态
    this.state = proxy({})
    // 标记是否已加载
    this.loaded = false
  }

  /**
   * 加载存储数据到响应式状态
   */
  async load() {
    try {
      // 从 Store 中获取所有数据
      const keys = await this.store.keys()
      for (const key of keys) {
        const value = await this.store.get(key)
        this.state[key] = value
      }
      this.loaded = true
      console.log('存储加载成功')
    } catch (error) {
      console.error('加载存储失败:', error)
    }
  }

  /**
   * 设置值（支持对象）
   * @param {string} key - 键
   * @param {any} value - 值（可以是对象）
   */
  async set(key, value) {
    try {
      // 更新响应式状态
      this.state[key] = value
      // 更新 Store
      await this.store.set(key, value)
      // 保存到磁盘
      await this.save()
    } catch (error) {
      console.error('设置值失败:', error)
    }
  }

  /**
   * 获取值
   * @param {string} key - 键
   * @returns {any} 值
   */
  get(key) {
    return this.state[key]
  }

  /**
   * 删除值
   * @param {string} key - 键
   */
  async delete(key) {
    try {
      // 从响应式状态中删除
      delete this.state[key]
      // 从 Store 中删除
      await this.store.delete(key)
      // 保存到磁盘
      await this.save()
    } catch (error) {
      console.error('删除值失败:', error)
    }
  }

  /**
   * 清空所有数据
   */
  async clear() {
    try {
      // 清空响应式状态
      Object.keys(this.state).forEach(key => {
        delete this.state[key]
      })
      // 清空 Store
      const keys = await this.store.keys()
      for (const key of keys) {
        await this.store.delete(key)
      }
      // 保存到磁盘
      await this.save()
    } catch (error) {
      console.error('清空存储失败:', error)
    }
  }

  /**
   * 保存数据到磁盘
   */
  async save() {
    try {
      await this.store.save()
      console.log('存储保存成功')
    } catch (error) {
      console.error('保存存储失败:', error)
    }
  }

  /**
   * 获取所有键
   * @returns {Promise<string[]>} 键列表
   */
  async keys() {
    try {
      return await this.store.keys()
    } catch (error) {
      console.error('获取键列表失败:', error)
      return []
    }
  }

  /**
   * 检查键是否存在
   * @param {string} key - 键
   * @returns {Promise<boolean>} 是否存在
   */
  async has(key) {
    try {
      const keys = await this.store.keys()
      return keys.includes(key)
    } catch (error) {
      console.error('检查键存在失败:', error)
      return false
    }
  }
}

// 创建全局实例
export const store = new ReactiveStore()

// 导出自定义 Hook，用于在 React 组件中使用响应式状态
export const useStore = () => {
  return useSnapshot(store.state)
}

// 导出工具函数
export const useStoreValue = (key) => {
  const snapshot = useSnapshot(store.state)
  return snapshot[key]
}

// 初始化函数，在应用启动时调用
export const initStore = async () => {
  await store.load()
}