/** 仅装饰普通日志；跨包控制序列和远端文本属性始终优先交给 xterm。 */

const LOG_HIGHLIGHT_COLORS = {
  FATAL: '38;2;225;132;125',
  ERROR: '38;2;225;132;125',
  EXCEPTION: '38;2;225;132;125',
  TRACEBACK: '38;2;225;132;125',
  WARN: '38;2;220;177;105',
  WARNING: '38;2;220;177;105',
  INFO: '38;2;145;181;151',
  NOTICE: '38;2;145;181;151',
  SUCCESS: '38;2;145;181;151',
  DEBUG: '38;2;158;162;173',
  TRACE: '38;2;158;162;173'
}
const LOG_HIGHLIGHT_PATTERN = /\b(FATAL|ERROR|EXCEPTION|TRACEBACK|WARN(?:ING)?|INFO|NOTICE|SUCCESS|DEBUG|TRACE)\b/gi
const CONTROL_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/
const SGR_RESETS = { 22: [ 1, 2 ], 23: [ 3, 20 ], 24: [4], 25: [5], 27: [7], 28: [8], 29: [9], 50: [26], 54: [51], 55: [53], 65: [60], 75: [73]}
const SGR_ATTRIBUTES = new Set([ 1, 2, 3, 4, 5, 7, 8, 9, 20, 26, 51, 53, 60, 73 ])

/**
 * 为一个 PTY 代次创建有界、流式的输出装饰器。
 * 不缓存 OSC/DCS 载荷；只记录解析状态和最多 256 个 CSI 字符。未知样式保守地禁用装饰，直到显式重置。
 *
 * @returns {(data: string) => string} 不改变控制序列和远端属性的文本转换器。
 */
export const createTerminalOutputDecorator = () => {
  let state = 'ground'
  let parameters = ''
  let overflow = false
  let styles = new Set()
  const savedStyles = [ new Set(), new Set() ]
  let alternate = false
  const saveStyles = () => { savedStyles[Number(alternate)] = new Set(styles) }
  const restoreStyles = () => { styles = new Set(savedStyles[Number(alternate)]) }

  const applySgr = () => {
    if (overflow || !/^[\d;:]*$/.test(parameters)) {
      styles.add('unknown')
      return
    }
    const values = parameters.split(';')
    for (let index = 0; index < values.length; index += 1) {
      const parts = values[index].split(':')
      const code = Number(parts[0])
      if (code === 0) styles.clear()
      else if (code === 38 || code === 48 || code === 58) {
        styles.add(code === 38 ? 'foreground' : code === 48 ? 'background' : 'underlineColor')
        // 分号颜色参数中的 0 是颜色分量，不能误当作 SGR 重置。
        if (parts.length === 1) {
          const mode = Number(values[index + 1])
          if (mode === 2) index += 4
          else if (mode === 5) index += 2
          else styles.add('unknown')
        }
      } else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) styles.add('foreground')
      else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) styles.add('background')
      else if (code === 39) styles.delete('foreground')
      else if (code === 49) styles.delete('background')
      else if (code === 59) styles.delete('underlineColor')
      else if (code === 10) styles.delete('font')
      else if (code >= 11 && code <= 19) styles.add('font')
      else if (code === 4 && parts[1] === '0') styles.delete(4)
      else if (SGR_RESETS[code]) SGR_RESETS[code].forEach(attribute => styles.delete(attribute))
      else {
        const attribute = code === 21 ? 4 : code === 6 ? 5 : code === 52 ? 51 : code >= 60 && code <= 64 ? 60 : code === 74 ? 73 : code
        styles.add(SGR_ATTRIBUTES.has(attribute) ? attribute : 'unknown')
      }
    }
  }

  const finishCsi = final => {
    if (final === 'm') applySgr()
    else if (final === 's' && /^[\d;:]*$/.test(parameters)) saveStyles()
    else if (final === 'u' && /^[\d;:]*$/.test(parameters)) restoreStyles()
    else if (final === 'p' && parameters === '!') styles.clear()
    else if ((final === 'h' || final === 'l') && /^\?[\d;]+$/.test(parameters)) {
      for (const mode of parameters.slice(1).split(';').map(Number)) {
        if (mode === 1048) {
          if (final === 'h') saveStyles()
          else restoreStyles()
          continue
        }
        if (mode !== 47 && mode !== 1047 && mode !== 1049) continue
        if (mode === 1049 && final === 'h') saveStyles()
        alternate = final === 'h'
        if (mode === 1049 && final === 'l') restoreStyles()
      }
    }
  }

  return data => {
    if (!data) return data
    const containsControls = CONTROL_PATTERN.test(data)
    if (state === 'ground' && !containsControls) {
      if (alternate || styles.size > 0) return data
      return data.replace(LOG_HIGHLIGHT_PATTERN, value => `\x1b[${ LOG_HIGHLIGHT_COLORS[value.toUpperCase()] }m${ value }\x1b[0m`)
    }
    for (const character of data) {
      const code = character.charCodeAt(0)
      if (code === 0x1b) {
        state = 'escape'
        parameters = ''
      } else if (code === 0x18 || code === 0x1a || code === 0x9c) state = 'ground'
      else if (code === 0x9b) { state = 'csi'; parameters = ''; overflow = false }
      else if (code === 0x9d) state = 'osc'
      else if (code === 0x90 || code === 0x98 || code === 0x9e || code === 0x9f) state = 'string'
      else if (state === 'osc') {
        if (code === 0x07) state = 'ground'
      } else if (state === 'string') {
        // 字符串只由 ST、CAN、SUB 或新的 ESC 终止，不积累任何远端载荷。
      } else if (state === 'escape') {
        if (character === '[' && !parameters) { state = 'csi'; overflow = false }
        else if (character === ']' && !parameters) state = 'osc'
        else if ((character === 'P' || character === 'X' || character === '^' || character === '_') && !parameters) state = 'string'
        else if (code >= 0x20 && code <= 0x2f) parameters = 'intermediate'
        else if (code >= 0x30) {
          if (!parameters) {
            if (character === '7') saveStyles()
            else if (character === '8') restoreStyles()
            else if (character === 'c') { styles.clear(); savedStyles.forEach(value => value.clear()); alternate = false }
          }
          state = 'ground'
        }
      } else if (state === 'csi') {
        if (code >= 0x40 && code <= 0x7e) {
          finishCsi(character)
          state = 'ground'
        } else if (code >= 0x20) {
          if (parameters.length < 256) parameters += character
          else overflow = true
        }
      }
    }
    return data
  }
}
