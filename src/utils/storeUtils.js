import { load } from '@tauri-apps/plugin-store'
import { proxy, useSnapshot } from 'valtio'

/**
 * 对 Tauri Store 的轻量串行封装。
 * 这里不会处理敏感信息；凭据只保存在进程内存中，绝不写入 Tauri Store。
 */
export class ReactiveStore {
  constructor(storePath = 'store.json') {
    this.state = proxy({})
    this.storePath = storePath
    this.loaded = false
    this.store = null
    this.initPromise = null
    this.writeQueue = Promise.resolve()
  }

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

  async load() {
    const store = await this.init()
    const keys = await store.keys()
    for (const key of keys) {
      const value = await store.get(key)
      if (value !== undefined) this.state[key] = value
    }
    this.loaded = true
  }

  enqueueWrite(operation) {
    // 单次写入失败不能永久阻塞后续设置变更。
    this.writeQueue = this.writeQueue.catch(() => undefined).then(operation)
    return this.writeQueue
  }

  async set(key, value) {
    const store = await this.init()
    this.state[key] = value
    return this.enqueueWrite(async () => {
      await store.set(key, value)
      await store.save()
    })
  }

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

  async delete(key) {
    const store = await this.init()
    delete this.state[key]
    return this.enqueueWrite(async () => {
      await store.delete(key)
      await store.save()
    })
  }

  async clear() {
    const store = await this.init()
    Object.keys(this.state).forEach(key => delete this.state[key])
    return this.enqueueWrite(async () => {
      await store.clear()
      await store.save()
    })
  }

  async save() {
    const store = await this.init()
    return this.enqueueWrite(() => store.save())
  }

  async keys() {
    try {
      const store = await this.init()
      return store.keys()
    } catch (error) {
      console.error('读取本地数据键失败', error)
      return []
    }
  }

  async has(key) {
    return (await this.keys()).includes(key)
  }
}

export const store = new ReactiveStore()

export const useStore = () => useSnapshot(store.state)

export const useStoreValue = (key) => {
  const snapshot = useSnapshot(store.state)
  return snapshot[key]
}

export const initStore = async () => {
  try {
    await store.load()
  } catch (error) {
    console.error('本地数据初始化失败', error)
  }
}
