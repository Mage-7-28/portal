/**
 * 创建可在第一个异步边界前取得的操作锁，阻止快速重复提交。
 *
 * @returns {{acquire: () => (() => void)|null, locked: boolean}} 锁及幂等释放函数。
 */
export const createOperationLock = () => {
  let locked = false

  return {
    acquire() {
      if (locked) return null
      locked = true
      let released = false
      return () => {
        if (released) return
        released = true
        locked = false
      }
    },
    get locked() {
      return locked
    }
  }
}

/**
 * 维护独立于虚拟行生命周期的操作锁，并在最后一个操作释放时删除对应条目。
 *
 * @param {() => void} [onChange] - 锁状态变化时的通知。
 * @returns {{acquire: (key: string, action: string) => (() => void)|null, isLocked: (key: string, action: string) => boolean}} 锁管理器。
 */
export const createKeyedOperationLocks = onChange => {
  const entries = new Map()
  return {
    acquire(key, action) {
      let actions = entries.get(key)
      if (actions?.has(action)) return null
      if (!actions) {
        actions = new Set()
        entries.set(key, actions)
      }
      actions.add(action)
      onChange?.()
      let released = false
      return () => {
        if (released) return
        released = true
        actions.delete(action)
        if (actions.size === 0) entries.delete(key)
        onChange?.()
      }
    },
    isLocked(key, action) {
      return entries.get(key)?.has(action) === true
    }
  }
}

/**
 * 根据完整文件模型计算键盘导航目标，而不局限于当前挂载的虚拟行。
 *
 * @param {string} key - 键盘按键。
 * @param {number} index - 当前项目索引。
 * @param {number} count - 完整项目数量。
 * @returns {number|null} 目标索引；不处理的按键或空列表返回 null。
 */
export const getKeyboardFileIndex = (key, index, count) => {
  if (count <= 0) return null
  if (key === 'Home') return 0
  if (key === 'End') return count - 1
  if (key === 'ArrowUp') return Math.max(0, index - 1)
  if (key === 'ArrowDown') return Math.min(count - 1, index + 1)
  return null
}

/**
 * 只按原生结构化错误码判断目标冲突，不依赖本地化错误文案。
 *
 * @param {unknown} error - 原生调用或批量结果返回的错误。
 * @returns {boolean} 错误码为 `TargetExists` 时返回 true。
 */
export const isTargetExistsError = error => error?.code === 'TargetExists'

const OUTCOME_STATUSES = [ 'succeeded', 'skipped', 'failed', 'notStarted', 'unknown' ]

/**
 * 按并发上限执行一组工作项，并汇总结果及本批次拥有的可取消传输。
 *
 * @param {Array<unknown>} jobs - 待调度工作项；按原顺序保留未启动项。
 * @param {(job: unknown, context: Object) => Promise<unknown>|unknown} runJob - 执行单个工作项的回调。
 * @param {Object} [options={}] - 并发、连接代次、进度和取消配置。
 * @param {number} [options.concurrency=4] - 同时执行的工作项上限。
 * @param {() => boolean} [options.isCurrent=()=>true] - 判断原始连接快照是否仍有效。
 * @param {(transferId: string) => Promise<unknown>|unknown} [options.cancelTransfer] - 取消本批次拥有的原生传输。
 * @param {(progress: number, payload: Object) => void} [options.onProgress] - 传递聚合进度。
 * @param {(outcome: Object) => void} [options.onOutcome] - 工作项终态回调。
 * @returns {{promise: Promise<Object>, cancel: () => Promise<void>}} 批次结果和幂等取消入口。
 */
export const runTransferBatch = (jobs, runJob, options = {}) => {
  const queue = Array.isArray(jobs) ? jobs : []
  const concurrency = Math.max(1, Math.trunc(Number(options.concurrency) || 4))
  const isCurrent = typeof options.isCurrent === 'function' ? options.isCurrent : () => true
  const cancelTransfer = typeof options.cancelTransfer === 'function' ? options.cancelTransfer : async () => {}
  const result = Object.fromEntries(OUTCOME_STATUSES.map(status => [ status, [] ]))
  const activeTransferIds = new Set()
  const cancelRequests = new Set()
  const cancelErrors = []
  let nextIndex = 0
  let cancelRequested = false
  let cancelPromise = null

  const requestTransferCancel = transferId => {
    const request = Promise.resolve()
      .then(() => cancelTransfer(transferId))
      .catch(error => { cancelErrors.push(error) })
      .finally(() => cancelRequests.delete(request))
    cancelRequests.add(request)
    return request
  }

  const cancel = () => {
    if (!cancelRequested) {
      cancelRequested = true
      for (const transferId of activeTransferIds) requestTransferCancel(transferId)
    }
    if (!cancelPromise) {
      cancelPromise = Promise.resolve().then(async () => {
        while (cancelRequests.size > 0) await Promise.allSettled([...cancelRequests])
        if (cancelErrors.length) throw cancelErrors[0]
      })
    }
    return cancelPromise
  }

  const ensureCurrent = () => {
    if (cancelRequested) return false
    if (isCurrent()) return true
    void cancel().catch(() => undefined)
    return false
  }

  const recordOutcome = (status, job, details = {}) => {
    const normalizedStatus = OUTCOME_STATUSES.includes(status) ? status : 'unknown'
    const outcome = { job, ...details }
    result[normalizedStatus].push(outcome)
    try {
      options.onOutcome?.(normalizedStatus, outcome)
    } catch {
      // UI 通知或进度回调异常不能中断其余工作项的结算。
    }
    return outcome
  }

  const recordNativeResult = (job, nativeResult) => {
    if (OUTCOME_STATUSES.includes(nativeResult?.status)) {
      recordOutcome(nativeResult.status, job, { value: nativeResult, error: nativeResult.error })
      return
    }

    recordOutcome('succeeded', job, { value: nativeResult })
  }

  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (ensureCurrent()) {
      const index = nextIndex
      if (index >= queue.length) return
      nextIndex += 1
      const job = queue[index]
      const jobTransferIds = new Set()
      const context = {
        index,
        total: queue.length,
        get cancelled() {
          return cancelRequested
        },
        isCurrent: ensureCurrent,
        registerTransferId(transferId) {
          if (typeof transferId !== 'string' || transferId.length === 0) return
          jobTransferIds.add(transferId)
          activeTransferIds.add(transferId)
          if (cancelRequested) requestTransferCancel(transferId)
          else if (!isCurrent()) void cancel().catch(() => undefined)
        },
        releaseTransferId(transferId) {
          jobTransferIds.delete(transferId)
          activeTransferIds.delete(transferId)
        },
        reportProgress(progress, payload = {}) {
          if (!ensureCurrent()) return
          try {
            options.onProgress?.(progress, payload)
          } catch {
            // 观察者异常不能改变正在执行的传输结果。
          }
        }
      }

      try {
        const value = await runJob(job, context)
        recordNativeResult(job, value)
      } catch (error) {
        const status = error?.code === 'TransferOutcomeUnknown'
          || error?.code === 'OutcomeUnknown'
          || error?.code === 'TransferStateUnavailable'
          || (cancelRequested && error?.code === 'TransferCancelled')
          ? 'unknown'
          : 'failed'
        recordOutcome(status, job, { error })
      } finally {
        for (const transferId of jobTransferIds) activeTransferIds.delete(transferId)
        jobTransferIds.clear()
      }
    }
  })

  const promise = Promise.all(workers).then(() => {
    for (let index = nextIndex; index < queue.length; index += 1) {
      recordOutcome('notStarted', queue[index])
    }
    return { ...result, cancelled: cancelRequested }
  })

  return { promise, cancel }
}

/**
 * 为单次原生批次调用和冲突确认创建可跨重试使用的控制器。
 *
 * @param {Object} options - 原生批次执行、连接校验和 UI 回调。
 * @param {(entries: Object[], context: Object, overwrite: boolean) => Promise<Object>} options.transfer - 调用原生批次。
 * @param {(entry: Object, item: Object) => Promise<boolean>} options.confirmOverwrite - 单项覆盖确认。
 * @param {() => boolean} options.isCurrent - 原始连接是否仍有效。
 * @param {(id: string) => Promise<unknown>} options.cancelTransfer - 取消父任务。
 * @param {(progress: number, payload: Object) => void} [options.onProgress] - 原生聚合进度。
 * @returns {{run: (entries: Object[]) => Promise<Object>, cancel: () => Promise<void>}} 执行和取消入口。
 */
export const createNativeBatchWorkflow = options => {
  let activeBatch = null
  let cancelled = false

  const cancel = async () => {
    cancelled = true
    await activeBatch?.cancel()
  }

  const run = async (entries, initialOutcomes = {}) => {
    const outcomes = Object.fromEntries(OUTCOME_STATUSES.map(status => [ status, [] ]))
    for (const status of OUTCOME_STATUSES) outcomes[status].push(...(initialOutcomes[status] || []))
    const pending = [...entries]
    const current = () => !cancelled && options.isCurrent()

    const settle = (status, outcome) => outcomes[status].push(outcome)
    let directoryCount = 0
    let unlistedSkipped = 0
    const execute = async (batchEntries, overwrite) => {
      if (!batchEntries.length) return
      if (!current()) {
        batchEntries.forEach(job => settle('notStarted', { job }))
        return
      }
      activeBatch = runTransferBatch(
        [{ entries: batchEntries }],
        async (_, context) => {
          const nativeResult = await options.transfer(batchEntries, context, overwrite)
          if (!Array.isArray(nativeResult?.items)) {
            throw Object.assign(new Error('原生批次未返回完整结果，请核对传输状态'), { code: 'OutcomeUnknown' })
          }
          if (nativeResult.itemCount != null && (!Number.isSafeInteger(nativeResult.itemCount)
            || nativeResult.itemCount !== nativeResult.items.length)) {
            throw Object.assign(new Error('原生批次明细数量不完整，请核对传输状态'), { code: 'OutcomeUnknown' })
          }
          if (nativeResult.items.some(item => !Number.isSafeInteger(item.entryIndex)
            || item.entryIndex < 0 || item.entryIndex >= batchEntries.length)) {
            throw Object.assign(new Error('原生批次返回了无效的项目索引，请核对传输状态'), { code: 'OutcomeUnknown' })
          }
          const itemIds = nativeResult.items.map(item => item.itemId).filter(id => id != null)
          if (new Set(itemIds).size !== itemIds.length) {
            throw Object.assign(new Error('原生批次返回了重复的明细，请核对传输状态'), { code: 'OutcomeUnknown' })
          }
          // 任务状态和单文件状态同名；包装结果以免聚合调度器丢弃失败批次的明细。
          return { batchResult: nativeResult }
        },
        {
          concurrency: 1,
          isCurrent: current,
          cancelTransfer: options.cancelTransfer,
          onProgress: options.onProgress
        }
      )
      const result = await activeBatch.promise
      activeBatch = null
      for (const status of OUTCOME_STATUSES) {
        for (const outcome of result[status]) {
          if (status === 'succeeded' && Array.isArray(outcome.value?.batchResult?.items)) {
            const native = outcome.value.batchResult
            if (native.status === 'cancelled') cancelled = true
            directoryCount += Number(native.directoryCount) || 0
            const nativeSkips = Number(native.skipped) || 0
            unlistedSkipped += Math.max(0, nativeSkips - native.items.filter(item => item.status === 'skipped').length)
            for (const item of native.items) {
              const root = batchEntries[item.entryIndex]
              const job = {
                ...root,
                localPath: item.localPath || root.localPath,
                remotePath: item.remotePath || root.remotePath,
                isDirectory: item.isDirectory === true
              }
              const ambiguousConflict = root.isDirectory && item.status === 'failed' && isTargetExistsError(item.error)
                && (!item.localPath || !item.remotePath || typeof item.isDirectory !== 'boolean')
              const itemStatus = !ambiguousConflict && OUTCOME_STATUSES.includes(item.status) ? item.status : 'unknown'
              settle(itemStatus, { job, item, value: native })
            }
          } else if (Array.isArray(outcome.job?.entries)) {
            outcome.job.entries.forEach(job => settle(status, { job, error: outcome.error }))
          } else {
            settle(status, outcome)
          }
        }
      }
    }

    await execute(pending, false)
    if (!current()) return { ...outcomes, cancelled, directoryCount, unlistedSkipped }
    const conflicts = outcomes.failed.filter(outcome => isTargetExistsError(outcome.item?.error))
    const retry = []
    for (const outcome of conflicts) {
      if (!current()) break
      let accepted
      try {
        accepted = await options.confirmOverwrite(outcome.job, outcome.item)
      } catch (error) {
        const index = outcomes.failed.indexOf(outcome)
        if (index >= 0) outcomes.failed[index] = { ...outcome, error }
        continue
      }
      if (!current()) break
      const index = outcomes.failed.indexOf(outcome)
      if (index >= 0) outcomes.failed.splice(index, 1)
      if (accepted) retry.push(outcome.job)
      else settle('skipped', { ...outcome })
    }
    if (!current()) {
      retry.forEach(job => settle('notStarted', { job }))
      return { ...outcomes, cancelled, directoryCount, unlistedSkipped }
    }
    await execute(retry, true)
    return { ...outcomes, cancelled, directoryCount, unlistedSkipped }
  }

  return { run, cancel }
}

if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest

  describe('transfer workflow primitives', () => {
    it('acquires a synchronous lock once and releases it idempotently', () => {
      const lock = createOperationLock()
      const release = lock.acquire()

      expect(typeof release).toBe('function')
      expect(lock.acquire()).toBeNull()
      release()
      release()
      expect(typeof lock.acquire()).toBe('function')
    })

    it('keeps item locks across virtual row remounts and removes them after release', () => {
      const changes = []
      const locks = createKeyedOperationLocks(() => changes.push('changed'))
      const release = locks.acquire('/remote/a', 'download')
      expect(locks.isLocked('/remote/a', 'download')).toBe(true)
      expect(locks.acquire('/remote/a', 'download')).toBeNull()
      const releaseOther = locks.acquire('/remote/b', 'download')
      expect(typeof releaseOther).toBe('function')
      release()
      release()
      expect(locks.isLocked('/remote/a', 'download')).toBe(false)
      expect(locks.isLocked('/remote/b', 'download')).toBe(true)
      releaseOther()
      expect(changes).toHaveLength(4)
    })

    it('surfaces a cancellation request failure while retaining the task outcome', async () => {
      let finish
      const work = new Promise(resolve => { finish = resolve })
      const workflow = runTransferBatch(['file'], async (_, context) => {
        context.registerTransferId('parent')
        return work
      }, { cancelTransfer: async () => { throw new Error('取消请求失败') } })
      await expect(workflow.cancel()).rejects.toThrow('取消请求失败')
      finish({ status: 'succeeded' })
      expect((await workflow.promise).succeeded).toHaveLength(1)
    })

    it('navigates keyboard positions over the full model and clamps the ends', () => {
      expect(getKeyboardFileIndex('ArrowDown', 8, 100)).toBe(9)
      expect(getKeyboardFileIndex('ArrowUp', 0, 100)).toBe(0)
      expect(getKeyboardFileIndex('Home', 48, 100)).toBe(0)
      expect(getKeyboardFileIndex('End', 1, 100)).toBe(99)
      expect(getKeyboardFileIndex('Enter', 1, 100)).toBeNull()
      expect(getKeyboardFileIndex('End', 0, 0)).toBeNull()
    })

    it('does not launch queued jobs after the captured generation changes', async () => {
      let generation = 1
      let finishFirst
      const started = []
      const firstJob = new Promise(resolve => {
        finishFirst = resolve
      })
      const workflow = runTransferBatch(
        [{ id: 'first' }, { id: 'second' }, { id: 'third' }],
        async job => {
          started.push(job.id)
          if (job.id === 'first') await firstJob
          return { status: 'succeeded' }
        },
        { concurrency: 1, isCurrent: () => generation === 1 }
      )

      expect(started).toEqual(['first'])
      generation = 2
      finishFirst()
      const result = await workflow.promise

      expect(started).toEqual(['first'])
      expect(result.notStarted.map(item => item.job.id)).toEqual([ 'second', 'third' ])
    })

    it('stops dispatching and cancels all owned transfer IDs', async () => {
      const finishJobs = []
      const started = []
      const cancelledIds = []
      const workflow = runTransferBatch(
        [ 1, 2, 3, 4 ],
        (job, { registerTransferId }) => {
          started.push(job)
          registerTransferId(`transfer-${ job }`)
          return new Promise(resolve => finishJobs.push(resolve))
        },
        {
          concurrency: 2,
          cancelTransfer: async id => cancelledIds.push(id)
        }
      )

      expect(started).toEqual([ 1, 2 ])
      await workflow.cancel()
      expect(cancelledIds.sort()).toEqual([ 'transfer-1', 'transfer-2' ])

      finishJobs.forEach(resolve => resolve({ status: 'unknown' }))
      const result = await workflow.promise

      expect(started).toEqual([ 1, 2 ])
      expect(result.notStarted.map(item => item.job)).toEqual([ 3, 4 ])
      expect(result.unknown).toHaveLength(2)
    })

    it('keeps the number of active jobs within the configured bound', async () => {
      let active = 0
      let maximumActive = 0
      const workflow = runTransferBatch(
        Array.from({ length: 9 }, (_, index) => index),
        async () => {
          active += 1
          maximumActive = Math.max(maximumActive, active)
          await Promise.resolve()
          active -= 1
          return { status: 'succeeded' }
        },
        { concurrency: 4 }
      )

      await workflow.promise
      expect(maximumActive).toBeLessThanOrEqual(4)
      expect(maximumActive).toBe(4)
    })

    it('retains successes, skips, and failures from independent jobs', async () => {
      const workflow = runTransferBatch(
        [ 'success', 'skip', 'failure' ],
        async job => {
          if (job === 'skip') return { status: 'skipped' }
          if (job === 'failure') throw Object.assign(new Error('network failure'), { code: 'NetworkError' })
          return { status: 'succeeded', value: 'ok' }
        }
      )
      const result = await workflow.promise

      expect(result.succeeded.map(item => item.job)).toEqual(['success'])
      expect(result.skipped.map(item => item.job)).toEqual(['skip'])
      expect(result.failed.map(item => item.job)).toEqual(['failure'])
      expect(result.failed[0].error.code).toBe('NetworkError')
    })

    it('recognizes overwrite conflicts only by the structured error code', () => {
      expect(isTargetExistsError({ code: 'TargetExists', message: '目标已存在' })).toBe(true)
      expect(isTargetExistsError(new Error('目标已存在'))).toBe(false)
      expect(isTargetExistsError({ code: 'PermissionDenied', message: '目标已存在' })).toBe(false)
    })

    it('retries only confirmed native conflicts and retains successful and skipped outcomes', async () => {
      const calls = []
      const jobs = [{ name: 'success' }, { name: 'overwrite' }, { name: 'skip' }, { name: 'denied' }]
      const workflow = createNativeBatchWorkflow({
        isCurrent: () => true,
        cancelTransfer: async () => {},
        confirmOverwrite: async job => job.name === 'overwrite',
        transfer: async (batch, _context, overwrite) => {
          calls.push({ batch: batch.map(job => job.name), overwrite })
          return {
            items: batch.map((job, entryIndex) => ({
              entryIndex,
              status: overwrite || job.name === 'success' ? 'succeeded' : 'failed',
              error: job.name === 'denied' ? { code: 'PermissionDenied' } : { code: 'TargetExists' }
            }))
          }
        }
      })
      const result = await workflow.run(jobs)
      expect(calls).toEqual([
        { batch: [ 'success', 'overwrite', 'skip', 'denied' ], overwrite: false },
        { batch: ['overwrite'], overwrite: true }
      ])
      expect(result.succeeded.map(outcome => outcome.job.name)).toEqual([ 'success', 'overwrite' ])
      expect(result.skipped.map(outcome => outcome.job.name)).toEqual(['skip'])
      expect(result.failed.map(outcome => outcome.job.name)).toEqual(['denied'])
    })

    it('never retries a conflict after the connection generation changes during confirmation', async () => {
      let current = true
      let calls = 0
      const workflow = createNativeBatchWorkflow({
        isCurrent: () => current,
        cancelTransfer: async () => {},
        confirmOverwrite: async () => {
          current = false
          return true
        },
        transfer: async () => {
          calls += 1
          return { items: [{ entryIndex: 0, status: 'failed', error: { code: 'TargetExists' }}]}
        }
      })
      const result = await workflow.run([{ name: 'conflict' }])
      expect(calls).toBe(1)
      expect(result.failed).toHaveLength(1)
    })

    it('marks missing native results unknown instead of claiming success', async () => {
      const workflow = createNativeBatchWorkflow({
        isCurrent: () => true,
        cancelTransfer: async () => {},
        confirmOverwrite: async () => true,
        transfer: async () => ({})
      })
      const result = await workflow.run([{ name: 'missing' }])
      expect(result.succeeded).toHaveLength(0)
      expect(result.unknown).toHaveLength(1)
    })

    it('accepts an empty directory success with no file outcomes', async () => {
      const workflow = createNativeBatchWorkflow({
        isCurrent: () => true,
        cancelTransfer: async () => {},
        confirmOverwrite: async () => true,
        transfer: async () => ({ items: [], directoryCount: 1 })
      })
      const result = await workflow.run([{ isDirectory: true }])
      expect(result.unknown).toHaveLength(0)
      expect(result.failed).toHaveLength(0)
      expect(result.directoryCount).toBe(1)
    })

    it('does not retry or claim success when the returned item count is incomplete', async () => {
      let calls = 0
      const workflow = createNativeBatchWorkflow({
        isCurrent: () => true,
        cancelTransfer: async () => {},
        confirmOverwrite: async () => true,
        transfer: async () => {
          calls += 1
          return { itemCount: 2, items: [{ entryIndex: 0, itemId: 'one', status: 'failed', error: { code: 'TargetExists' }}]}
        }
      })
      const result = await workflow.run([{ isDirectory: true }])
      expect(calls).toBe(1)
      expect(result.unknown).toHaveLength(1)
      expect(result.succeeded).toHaveLength(0)
    })

    it('treats duplicated item ids as an uncertain result rather than retrying', async () => {
      let calls = 0
      const workflow = createNativeBatchWorkflow({
        isCurrent: () => true,
        cancelTransfer: async () => {},
        confirmOverwrite: async () => true,
        transfer: async () => {
          calls += 1
          return { itemCount: 2, items: [
            { entryIndex: 0, itemId: 'same', status: 'succeeded' },
            { entryIndex: 0, itemId: 'same', status: 'failed', error: { code: 'TargetExists' }}
          ]}
        }
      })
      const result = await workflow.run([{ isDirectory: true }])
      expect(calls).toBe(1)
      expect(result.unknown).toHaveLength(1)
    })

    it('never retries an ambiguous directory conflict without exact member paths', async () => {
      let calls = 0
      const workflow = createNativeBatchWorkflow({
        isCurrent: () => true,
        cancelTransfer: async () => {},
        confirmOverwrite: async () => true,
        transfer: async () => {
          calls += 1
          return { items: [{ entryIndex: 0, isDirectory: false, status: 'failed', error: { code: 'TargetExists' }}]}
        }
      })
      const result = await workflow.run([{ localPath: '/local/root', remotePath: '/remote/root', isDirectory: true }])
      expect(calls).toBe(1)
      expect(result.unknown).toHaveLength(1)
    })

    it('retains the details of a failed native batch', async () => {
      const workflow = createNativeBatchWorkflow({
        isCurrent: () => true,
        cancelTransfer: async () => {},
        confirmOverwrite: async () => false,
        transfer: async () => ({ status: 'failed', items: [
          { entryIndex: 0, status: 'failed', error: { code: 'PermissionDenied', message: '权限不足' }}
        ]})
      })
      const result = await workflow.run([{ localPath: '/local', remotePath: '/remote' }])
      expect(result.failed[0].item.error.code).toBe('PermissionDenied')
    })

    it('reports native cancellation even when no items were started', async () => {
      const workflow = createNativeBatchWorkflow({
        isCurrent: () => true,
        cancelTransfer: async () => {},
        confirmOverwrite: async () => true,
        transfer: async () => ({ status: 'cancelled', items: []})
      })
      const result = await workflow.run([{ isDirectory: true }])
      expect(result.cancelled).toBe(true)
    })

    it('retries conflicting directory members by their exact paths rather than the successful root', async () => {
      const calls = []
      const root = { localPath: '/local/dir', remotePath: '/remote/dir', isDirectory: true }
      const workflow = createNativeBatchWorkflow({
        isCurrent: () => true,
        cancelTransfer: async () => {},
        confirmOverwrite: async () => true,
        transfer: async (batch, _context, overwrite) => {
          calls.push(batch)
          if (overwrite) return { items: [{ entryIndex: 0, itemId: 'retry', status: 'succeeded', ...batch[0] }]}
          return { items: [
            { entryIndex: 0, itemId: 'ok', status: 'succeeded', localPath: '/local/dir/ok', remotePath: '/remote/dir/ok', isDirectory: false },
            { entryIndex: 0, itemId: 'conflict', status: 'failed', localPath: '/local/dir/conflict', remotePath: '/remote/dir/conflict', isDirectory: false, error: { code: 'TargetExists' }}
          ]}
        }
      })
      const result = await workflow.run([root])
      expect(calls[1]).toEqual([{ localPath: '/local/dir/conflict', remotePath: '/remote/dir/conflict', isDirectory: false }])
      expect(result.succeeded).toHaveLength(2)
    })
  })
}
