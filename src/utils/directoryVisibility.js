// 同一个滚动容器共享观察器；最后一行卸载后立即断开并释放容器引用。
const observersByRoot = new Map()

/**
 * 观察目录行是否接近可视区域，供按需目录大小统计使用。
 *
 * @param {Element|null} element - 目录行节点。
 * @param {(visible: boolean) => void} onChange - 行可见状态变化回调。
 * @returns {() => void} 移除当前行观察的清理函数。
 */
export const observeDirectoryVisibility = (element, onChange) => {
  if (!element || typeof window === 'undefined' || typeof window.IntersectionObserver !== 'function') {
    onChange(true)
    return () => {}
  }
  const root = element.closest('.file-list-shell')
  let group = observersByRoot.get(root)
  if (!group) {
    const callbacks = new Map()
    const observer = new window.IntersectionObserver(entries => {
      for (const entry of entries) callbacks.get(entry.target)?.(Boolean(entry.isIntersecting))
    }, { root, rootMargin: '160px 0px', threshold: 0 })
    group = { observer, callbacks }
    observersByRoot.set(root, group)
  }
  group.callbacks.set(element, onChange)
  group.observer.observe(element)
  return () => {
    group.callbacks.delete(element)
    group.observer.unobserve(element)
    if (group.callbacks.size === 0) {
      group.observer.disconnect()
      observersByRoot.delete(root)
    }
  }
}
