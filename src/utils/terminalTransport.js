/** 终端 IPC 的有界输入、尺寸合并和消费确认；每个实例只属于一个会话代次。 */
import { getErrorCode } from './constants.js'

export const TERMINAL_INPUT_CHUNK_BYTES = 16 * 1024
export const TERMINAL_INPUT_QUEUE_BYTES = 8 * 1024 * 1024
const TERMINAL_RETRY_DELAY_MS = 50

/**
 * 统一前后端使用的 PTY 尺寸范围，零值和无效值使用默认尺寸。
 *
 * @param {number} columns - 请求的列数。
 * @param {number} rows - 请求的行数。
 * @returns {{columns: number, rows: number}} 规范化的列数与行数。
 */
export const normalizeTerminalDimensions = (columns, rows) => {
  const normalize = (value, fallback, maximum) => {
    if (!Number.isFinite(value) || value === 0) return fallback
    return Math.max(1, Math.min(maximum, Math.trunc(value)))
  }
  return { columns: normalize(columns, 100, 4096), rows: normalize(rows, 30, 2048) }
}

/**
 * 按 UTF-8 字节计算输入体积并记录不会切断 Unicode 码点的分片边界。
 *
 * @param {string} data - 本次完整输入。
 * @param {number} available - 队列剩余字节。
 * @returns {{start: number, end: number, bytes: number}[]|null} 全部边界，容量不足时返回 null。
 */
const inputBoundaries = (data, available) => {
  const boundaries = []
  let total = 0
  let start = 0
  let bytes = 0
  for (let index = 0; index < data.length;) {
    const point = data.codePointAt(index)
    const units = point > 0xffff ? 2 : 1
    const size = point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4
    total += size
    if (total > available) return null
    if (bytes + size > TERMINAL_INPUT_CHUNK_BYTES) {
      boundaries.push({ start, end: index, bytes })
      start = index
      bytes = 0
    }
    bytes += size
    index += units
  }
  if (bytes) boundaries.push({ start, end: data.length, bytes })
  return boundaries
}

/**
 * 创建包含在途数据的 8 MiB 输入队列，并严格串行发送分片。
 *
 * @param {Object} options - 输入队列配置。
 * @param {string} options.terminalId - 终端会话标识。
 * @param {string} options.generation - 本次打开的独立代次。
 * @param {(command: string, args: Object) => Promise<unknown>} options.invoke - Tauri 命令调用。
 * @param {() => void} [options.onOverflow] - 单次输入因队列容量不足被整体拒绝时调用。
 * @param {(error: unknown) => void} [options.onError] - 输入发送失败或序号耗尽时调用。
 * @returns {{enqueue: (data: string) => boolean, dispose: () => void}} 输入队列。
 */
export const createInputQueue = ({ terminalId, generation, invoke, onOverflow, onError }) => {
  const encoder = new globalThis.TextEncoder()
  // 每个分片都是独立解码；保留开头的 U+FEFF，不能把用户输入当作 BOM 丢弃。
  const decoder = new globalThis.TextDecoder('utf-8', { ignoreBOM: true })
  let active = true
  let inFlight = false
  let nextSequence = 1
  let queuedBytes = 0
  let queue = []
  let head = 0
  let retryTimer = null

  const dispose = () => {
    active = false
    queue = []
    head = 0
    queuedBytes = 0
    globalThis.clearTimeout(retryTimer)
    retryTimer = null
  }

  const pump = async () => {
    if (!active || inFlight || retryTimer !== null || head >= queue.length) return
    inFlight = true
    try {
      while (active && head < queue.length) {
        if (!Number.isSafeInteger(nextSequence)) throw new Error('终端输入序号已耗尽')
        const chunk = queue[head]
        const sequence = nextSequence
        try {
          await invoke('write_ssh_terminal', { terminalId, data: chunk.data, generation, sequence })
        } catch (error) {
          // BackgroundBusy 在执行写入前返回；只对这一明确未执行状态重试原分片和原序号。
          if (!active || getErrorCode(error) !== 'BackgroundBusy') throw error
          retryTimer = globalThis.setTimeout(() => {
            retryTimer = null
            void pump()
          }, TERMINAL_RETRY_DELAY_MS)
          return
        }
        if (!active) break
        nextSequence += 1
        queuedBytes -= chunk.bytes
        queue[head++] = null
        if (head === queue.length) {
          queue = []
          head = 0
        } else if (head >= 1024 && head * 2 >= queue.length) {
          queue = queue.slice(head)
          head = 0
        }
      }
    } catch (error) {
      if (active) {
        dispose()
        onError?.(error)
      }
    } finally {
      inFlight = false
    }
  }

  return {
    enqueue(data) {
      if (!active || typeof data !== 'string') return false
      const boundaries = inputBoundaries(data, TERMINAL_INPUT_QUEUE_BYTES - queuedBytes)
      if (!boundaries) {
        onOverflow?.()
        return false
      }
      // TextEncoder 将孤立代理项替换为 U+FFFD，保证序列化到 Rust 的字符串有效。
      for (const boundary of boundaries) {
        const chunk = decoder.decode(encoder.encode(data.slice(boundary.start, boundary.end)))
        queue.push({ data: chunk, bytes: boundary.bytes })
        queuedBytes += boundary.bytes
      }
      void pump()
      return true
    },
    dispose
  }
}

/**
 * 尺寸请求按顺序单飞；在途期间只保留最新尺寸。
 *
 * @param {Object} options - 尺寸队列配置。
 * @param {string} options.terminalId - 终端会话标识。
 * @param {string} options.generation - 本次打开的独立代次。
 * @param {(command: string, args: Object) => Promise<unknown>} options.invoke - Tauri 命令调用。
 * @param {(size: Object, requested: Object) => void} [options.onResize] - 收到实际尺寸后的回调。
 * @returns {{request: (columns: number, rows: number) => void, dispose: () => void}} 尺寸队列。
 */
export const createResizeQueue = ({ terminalId, generation, invoke, onResize }) => {
  let active = true
  let inFlight = false
  let pending = null
  let retryTimer = null

  const pump = async () => {
    if (!active || inFlight || retryTimer !== null || !pending) return
    inFlight = true
    try {
      while (active && pending) {
        const requested = pending
        pending = null
        try {
          const size = await invoke('resize_ssh_terminal', { terminalId, generation, ...requested })
          if (active) onResize?.(size, requested)
        } catch (error) {
          const code = getErrorCode(error)
          if (active && (code === 'BackgroundBusy' || code === 'TerminalResizePending')) {
            // 保留最新需求，即使不再触发 resize 也继续完成远端尺寸同步。
            pending ||= requested
            retryTimer = globalThis.setTimeout(() => {
              retryTimer = null
              void pump()
            }, TERMINAL_RETRY_DELAY_MS)
            return
          }
          // 其他调整错误不重试，以免把可能已经执行的请求无限重复。
        }
      }
    } finally {
      inFlight = false
    }
  }

  return {
    request(columns, rows) {
      if (!active) return
      pending = normalizeTerminalDimensions(columns, rows)
      void pump()
    },
    dispose() {
      active = false
      pending = null
      globalThis.clearTimeout(retryTimer)
      retryTimer = null
    }
  }
}

/**
 * 创建有序输出接收器；仅在 xterm 消费完成后合并、串行发送累计 ACK。
 *
 * @param {Object} options - 输出接收器配置。
 * @param {string} options.terminalId - 终端会话标识。
 * @param {string} options.generation - 本次打开的独立代次。
 * @param {(command: string, args: Object) => Promise<unknown>} options.invoke - Tauri 命令调用。
 * @param {(data: string, consumed: () => void) => void} options.write - 写入 xterm，并在解析完成后调用 consumed。
 * @param {(packet: Object) => void} [options.onEndReceived] - 收到有效退出或错误包时立即调用。
 * @param {(packet: Object) => void} [options.onExit] - 先前输出消费完成后处理退出包。
 * @param {(packet: Object) => void} [options.onError] - 先前输出消费完成后处理错误包。
 * @param {(error: unknown) => void} [options.onAckError] - 存活会话的 ACK 或输出协议失败时调用。
 * @returns {{receive: (packet: Object) => void, dispose: () => void}} 输出接收器。
 */
export const createOutputReceiver = ({ terminalId, generation, invoke, write, onEndReceived, onExit, onError, onAckError }) => {
  let active = true
  let ended = false
  let lastReceived = 0
  let lastConsumed = 0
  let lastAcknowledged = 0
  let ackInFlight = false
  let ackScheduled = false
  let ackFailed = false
  const pending = new Map()

  const scheduleAck = () => {
    if (!active || ackFailed || ackInFlight || ackScheduled || lastConsumed <= lastAcknowledged) return
    ackScheduled = true
    Promise.resolve().then(async () => {
      ackScheduled = false
      if (!active || ackFailed || ackInFlight || lastConsumed <= lastAcknowledged) return
      ackInFlight = true
      const sequence = lastConsumed
      try {
        const acknowledged = await invoke('ack_ssh_terminal_output', { terminalId, generation, sequence })
        if (acknowledged === false) throw new Error('终端输出确认序号无效')
        lastAcknowledged = sequence
      } catch (error) {
        ackFailed = true
        if (active && !ended) onAckError?.(error)
      } finally {
        ackInFlight = false
        scheduleAck()
      }
    })
  }

  const advance = () => {
    while (active && pending.get(lastConsumed + 1)?.done) {
      const packet = pending.get(++lastConsumed).packet
      pending.delete(lastConsumed)
      if (packet.event === 'exit') onExit?.(packet)
      else if (packet.event === 'error') onError?.(packet)
    }
    scheduleAck()
  }

  return {
    receive(packet) {
      if (!active || ended || !packet || packet.terminalId !== terminalId || packet.generation !== generation) return
      if (!Number.isSafeInteger(packet.sequence) || packet.sequence <= lastReceived) return
      if (packet.sequence !== lastReceived + 1 || ![ 'data', 'exit', 'error' ].includes(packet.event)
        || (packet.event === 'data' && typeof packet.data !== 'string')) {
        ackFailed = true
        onAckError?.(new Error('终端输出序号或数据无效'))
        return
      }
      lastReceived = packet.sequence
      if (packet.event === 'exit') ended = true
      const item = { packet, done: packet.event !== 'data' || !packet.data }
      pending.set(packet.sequence, item)
      if (packet.event !== 'data') onEndReceived?.(packet)
      if (!item.done) {
        try {
          write(packet.data, () => {
            if (!active || item.done) return
            item.done = true
            advance()
          })
        } catch (error) {
          ackFailed = true
          onAckError?.(error)
          return
        }
      }
      advance()
    },
    dispose() {
      active = false
      pending.clear()
    }
  }
}
