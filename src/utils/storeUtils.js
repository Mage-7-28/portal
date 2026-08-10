import { load } from '@tauri-apps/plugin-store'
import { proxy, useSnapshot } from 'valtio'

/**
 * 对 Tauri Store 的轻量串行封装。
 * 这里不会处理敏感信息；凭据只保存在进程内存中，绝不写入 Tauri Store。
 *
 * @class
 */
export class ReactiveStore {
  /**
   * 创建一个不自动保存的 Tauri Store 适配器，写入统一排队。
   *
   * @param {string} [storePath='store.json'] - Tauri Store 文件相对路径。
   * @returns {void}
   */
  constructor(storePath = 'store.json') {
    this.state = proxy({})
    this.storePath = storePath
    this.loaded = false
    this.store = null
    this.initPromise = null
    this.writeQueue = Promise.resolve()
  }

  /**
   * 延迟打开底层 Store，并共享并发初始化 Promise。
   *
   * @returns {Promise<Object>} 已打开的 Tauri Store 实例。
   * @throws {Error} 当 Store 文件无法打开或解析时抛出。
   */
  async init() {
    if (this.store) return this.store
    if (!this.initPromise) {
      this.initPromise = load(this.storePath, { autoSave: false })
        .then(store => {
          this.store = store
          return store
        })
        .finally(() => {
          this.initPromise = null
        })
    }
    return this.initPromise
  }

  /**
   * 将持久化键值同步到 Valtio 响应式状态。
   *
   * @returns {Promise<void>} 全部已保存键值加载进内存后的 Promise。
   * @throws {Error} 当底层 Store 读取失败时抛出。
   */
  async load() {
    const store = await this.init()
    const keys = await store.keys()
    for (const key of keys) {
      const value = await store.get(key)
      if (value !== undefined) this.state[key] = value
    }
    this.loaded = true
  }

  /**
   * 将写入操作串行化；前一次失败不会阻塞后续偏好保存。
   *
   * @param {() => Promise<unknown>} operation - 需要按顺序执行的异步写入操作。
   * @returns {Promise<unknown>} 当前写入操作完成后的 Promise。
   */
  enqueueWrite(operation) {
    // 单次写入失败不能永久阻塞后续设置变更。
    this.writeQueue = this.writeQueue.catch(() => undefined).then(operation)
    return this.writeQueue
  }

  /**
   * 更新响应式状态并持久化一个键值。
   *
   * @param {string} key - 要保存的设置键。
   * @param {unknown} value - 可序列化的设置值。
   * @returns {Promise<void>} 写入并保存完成后的 Promise。
   * @throws {Error} 当 Store 无法初始化或保存失败时抛出。
   */
  async set(key, value) {
    const store = await this.init()
    this.state[key] = value
    return this.enqueueWrite(async () => {
      await store.set(key, value)
      await store.save()
    })
  }

  /**
   * 读取键值，并在读取失败时回退到当前内存快照。
   *
   * @param {string} key - 要读取的设置键。
   * @returns {Promise<unknown|null>} 保存值、内存降级值或 null。
   */
  async get(key) {
    try {
      const store = await this.init()
      const value = await store.get(key)
      this.state[key] = value ?? null
      return value ?? null
    } catch (error) {
      console.error(`读取本地数据失败 [${ key }]`, error)
      return this.state[key] ?? null
    }
  }

  /**
   * 删除一个持久化键及其响应式状态。
   *
   * @param {string} key - 要删除的设置键。
   * @returns {Promise<void>} 删除并保存完成后的 Promise。
   * @throws {Error} 当 Store 无法初始化或保存失败时抛出。
   */
  async delete(key) {
    const store = await this.init()
    delete this.state[key]
    return this.enqueueWrite(async () => {
      await store.delete(key)
      await store.save()
    })
  }

  /**
   * 清空所有持久化设置和内存快照。
   *
   * @returns {Promise<void>} 清空并保存完成后的 Promise。
   * @throws {Error} 当 Store 无法初始化或保存失败时抛出。
   */
  async clear() {
    const store = await this.init()
    Object.keys(this.state).forEach(key => delete this.state[key])
    return this.enqueueWrite(async () => {
      await store.clear()
      await store.save()
    })
  }

  /**
   * 显式刷新底层 Store 的待写内容。
   *
   * @returns {Promise<void>} 底层 Store 保存完成后的 Promise。
   * @throws {Error} 当 Store 无法初始化或保存失败时抛出。
   */
  async save() {
    const store = await this.init()
    return this.enqueueWrite(() => store.save())
  }

  /**
   * 返回当前底层 Store 的键集合。
   *
   * @returns {Promise<string[]>} 已保存键名；读取失败时返回空数组。
   */
  async keys() {
    try {
      const store = await this.init()
      return store.keys()
    } catch (error) {
      console.error('读取本地数据键失败', error)
      return []
    }
  }

  /**
   * 判断底层 Store 是否包含指定键。
   *
   * @param {string} key - 要查询的设置键。
   * @returns {Promise<boolean>} 键存在时返回 true。
   */
  async has(key) {
    return (await this.keys()).includes(key)
  }
}

export const store = new ReactiveStore()

/**
 * 订阅整个响应式设置快照，供需要多个设置的 React 组件使用。
 *
 * @returns {Object} Valtio 提供的只读响应式状态快照。
 */
export const useStore = () => useSnapshot(store.state)

/**
 * 订阅单个设置值，减少不相关设置变化造成的组件更新。
 *
 * @param {string} key - 要订阅的设置键。
 * @returns {unknown} 当前响应式快照中的值；未设置时为 undefined。
 */
export const useStoreValue = (key) => {
  const snapshot = useSnapshot(store.state)
  return snapshot[key]
}

/**
 * 应用启动时加载持久化设置；失败时保留空的内存状态。
 *
 * @returns {Promise<void>} 初始化尝试完成后的 Promise；错误仅记录到控制台。
 */
export const initStore = async () => {
  try {
    await store.load()
  } catch (error) {
    console.error('本地数据初始化失败', error)
  }
}
