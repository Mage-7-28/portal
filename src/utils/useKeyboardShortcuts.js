import { useEffect, useRef } from 'react'
import { isMacPlatform } from './keyboardShortcuts.js'

const isElement = target => target?.nodeType === 1 && typeof target.closest === 'function'

const hasActiveDialog = () => Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"]')).some(dialog => {
  if (dialog.getClientRects().length === 0) return false
  const style = window.getComputedStyle(dialog)
  return style.display !== 'none' && style.visibility !== 'hidden'
})

const isTextEntry = (target, scope) => isElement(target) && Boolean(target.closest(
  'input, textarea, select, [contenteditable="true"], [role="textbox"], [data-shortcuts-disabled]'
)) && !(scope === 'workspace' && target.closest('.xterm-helper-textarea'))

const hasRequiredModifiers = (event, { shift = false, alt = false } = {}, mac = isMacPlatform()) => {
  return (mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey)
    && event.shiftKey === shift
    && event.altKey === alt
}

export const matchesShortcut = (event, id, mac = isMacPlatform()) => {
  const key = event.key.toLowerCase()
  // macOS 的 Option 会把字母变成特殊字符，因此字母快捷键同时按物理键码匹配。
  const isLetter = letter => key === letter || event.code === `Key${ letter.toUpperCase() }`
  switch (id) {
  case 'showDownloadPath':
    return isLetter('l') && hasRequiredModifiers(event, { shift: true }, mac)
  case 'chooseDownloadPath':
    return isLetter('l') && hasRequiredModifiers(event, { shift: true, alt: true }, mac)
  case 'upload':
    return isLetter('u') && hasRequiredModifiers(event, { shift: true }, mac)
  case 'newFolder':
    return isLetter('n') && hasRequiredModifiers(event, { shift: true }, mac)
  case 'refresh':
    return key === 'f5' && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey
  case 'parentDirectory':
    return key === 'arrowup' && !event.metaKey && !event.ctrlKey && event.altKey && !event.shiftKey
  case 'fontDown':
    return (key === '-' || key === '_') && hasRequiredModifiers(event, {}, mac)
  case 'fontUp':
    return (key === '=' || key === '+') && hasRequiredModifiers(event, {}, mac)
  case 'resetFontSize':
    return key === '0' && hasRequiredModifiers(event, {}, mac)
  case 'focusMode':
    return key === 'enter' && hasRequiredModifiers(event, { shift: true }, mac)
  default:
    return false
  }
}

const isInScope = (scope, target) => {
  if (scope === 'window') return true
  if (!isElement(target)) return false
  if (scope === 'workspace') return Boolean(target.closest('[data-shortcut-scope="workspace"]'))
  if (scope === 'file-browser') return Boolean(target.closest('.file-browser'))
  return false
}

const isDocumentTarget = target => target === document.body || target === document.documentElement

/**
 * 在指定界面作用域内注册 Portal 快捷键；无焦点区域以最近的鼠标交互定位作用域，编辑文本、弹窗及 xterm 输入时不抢占按键。
 *
 * @param {{scope?: "window"|"workspace"|"file-browser", enabled?: boolean, handlers: Object<string, Function>}} options - 作用域与快捷键处理器。
 * @returns {void}
 */
const useKeyboardShortcuts = ({ scope = 'window', enabled = true, handlers }) => {
  const handlersRef = useRef(handlers)
  handlersRef.current = handlers

  useEffect(() => {
    if (!enabled) return undefined
    let lastPointerContext = null
    const handlePointerDown = event => {
      const target = event.target
      // 只保存区域状态而不保留 DOM 引用，避免文件刷新卸载节点后作用域丢失或滞留旧节点。
      lastPointerContext = {
        inScope: isInScope(scope, target),
        isTextEntry: isTextEntry(target, scope),
        isInert: isElement(target) && Boolean(target.closest('[inert]'))
      }
    }
    const handleKeyDown = event => {
      // 点击非 focusable 区域不会改变 activeElement；此时键盘事件会落到 body，沿用最近的鼠标交互区域。
      const usePointerContext = isDocumentTarget(event.target)
      const pointerContext = usePointerContext ? lastPointerContext : null
      const isScopeActive = pointerContext ? pointerContext.inScope : isInScope(scope, event.target)
      if (event.defaultPrevented || event.isComposing || event.repeat
        || isTextEntry(event.target, scope) || pointerContext?.isTextEntry
        || !isScopeActive) return
      if (pointerContext?.isInert || (isElement(event.target) && event.target.closest('[inert]'))) return
      if (hasActiveDialog()) return
      const action = [ 'showDownloadPath', 'chooseDownloadPath', 'upload', 'newFolder', 'refresh', 'parentDirectory', 'fontDown', 'fontUp', 'resetFontSize', 'focusMode' ]
        .find(id => typeof handlersRef.current?.[id] === 'function' && matchesShortcut(event, id))
      if (!action) return
      event.preventDefault()
      event.stopPropagation()
      handlersRef.current[action]()
    }
    document.addEventListener('pointerdown', handlePointerDown, true)
    document.addEventListener('keydown', handleKeyDown, true)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true)
      document.removeEventListener('keydown', handleKeyDown, true)
    }
  }, [ enabled, scope ])
}

export default useKeyboardShortcuts
