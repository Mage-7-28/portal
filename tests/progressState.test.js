import test from 'node:test'
import assert from 'node:assert/strict'
import {
  PROGRESS_END,
  PROGRESS_UPDATE,
  createInitialProgressState,
  getCurrentProgress,
  getProgressKey,
  progressReducer
} from '../src/utils/progressState.js'

const update = (state, payload) => progressReducer(state, {
  type: PROGRESS_UPDATE,
  payload
})

const end = (state, ids) => progressReducer(state, {
  type: PROGRESS_END,
  ...ids
})

const ids = (taskId) => ({ taskId, maskId: `${ taskId }-mask` })

test('isolates interleaved tasks and ends only the addressed task', () => {
  let state = createInitialProgressState()
  state = update(state, { ...ids('A'), progress: 10, fileName: 'a.txt' })
  state = update(state, { ...ids('B'), progress: 20, fileName: 'b.txt' })
  state = update(state, { ...ids('A'), progress: 40, fileName: 'a.txt' })

  state = end(state, ids('A'))

  assert.equal(getCurrentProgress(state).taskId, 'B')
  assert.equal(state.tasks[getProgressKey(ids('A'))], undefined)
  assert.equal(state.tasks[getProgressKey(ids('B'))].progress, 20)
})

test('suppresses a late update after a task has ended', () => {
  let state = createInitialProgressState()
  state = update(state, { ...ids('A'), progress: 10 })
  state = update(state, { ...ids('B'), progress: 20 })
  state = end(state, ids('A'))
  state = update(state, { ...ids('A'), progress: 100 })

  assert.equal(getCurrentProgress(state).taskId, 'B')
  assert.equal(state.tasks[getProgressKey(ids('A'))], undefined)
  assert.equal(state.endedIds.includes(getProgressKey(ids('A'))), true)
})

test('selects the current task cancel callback by most recent mask', () => {
  const cancelA = () => 'A'
  const cancelB = () => 'B'
  let state = createInitialProgressState()
  state = update(state, { ...ids('A'), onCancel: cancelA })
  state = update(state, { ...ids('B'), onCancel: cancelB })

  assert.equal(getCurrentProgress(state).onCancel, cancelB)

  state = end(state, ids('B'))

  assert.equal(getCurrentProgress(state).onCancel, cancelA)
})

test('bounds ended task tombstones while retaining recent late-event protection', () => {
  let state = createInitialProgressState(2)
  state = end(state, ids('A'))
  state = update(state, { ...ids('A'), progress: 100 })
  state = end(state, ids('B'))
  state = end(state, ids('C'))

  assert.equal(state.endedIds.length, 2)
  assert.equal(state.endedIds.includes(getProgressKey(ids('A'))), false)
  assert.equal(state.endedIds.includes(getProgressKey(ids('B'))), true)
  assert.equal(state.endedIds.includes(getProgressKey(ids('C'))), true)
  assert.equal(state.tasks[getProgressKey(ids('A'))], undefined)
})
