/**
 * 主窗口工作区标签栏。
 * 连接首页固定保留，文件和终端标签由上层维护生命周期。
 */
import React, { useEffect, useRef } from 'react'
import AppIcon from './AppIcon.jsx'

/** 固定连接首页的标签 ID。 */
export const CONNECTIONS_WORKSPACE_ID = 'workspace-connections'

/**
 * 渲染主窗口工作区标签栏。
 *
 * @param {Object} props - 标签栏属性。
 * @param {Array<Object>} props.tabs - 文件和终端工作区标签。
 * @param {string} props.activeTabId - 当前激活的标签 ID。
 * @param {(tabId: string) => void} props.onSelect - 切换标签回调。
 * @param {(tabId: string) => void|Promise<void>} props.onClose - 关闭可关闭标签的回调。
 * @returns {JSX.Element} 可横向滚动的工作区标签栏。
 */
const WorkspaceTabBar = ({ tabs, activeTabId, onSelect, onClose }) => {
  const activeTabRef = useRef(null)
  const sessionListRef = useRef(null)
  const allTabs = [
    {
      id: CONNECTIONS_WORKSPACE_ID,
      title: '连接',
      icon: 'server',
      closable: false
    },
    ...tabs
  ]
  const [ connectionTab, ...sessionTabs ] = allTabs

  // 新建或切换到容器可视区外的标签时，自动滚动到刚好可见的位置。
  useEffect(() => {
    if (activeTabId === CONNECTIONS_WORKSPACE_ID) return undefined
    const frame = window.requestAnimationFrame(() => {
      activeTabRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [activeTabId])

  /**
   * 将标签区上的纵向滚轮转换为水平滚动，便于没有横向滚轮的鼠标使用。
   *
   * @param {React.WheelEvent<HTMLDivElement>} event - 标签列表滚轮事件。
   * @returns {void}
   */
  const handleWheel = event => {
    const list = sessionListRef.current
    if (!list) return
    if (list.scrollWidth <= list.clientWidth + 1) return
    const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY
    if (!delta) return
    const previousScrollLeft = list.scrollLeft
    list.scrollLeft += delta
    if (list.scrollLeft !== previousScrollLeft) event.preventDefault()
  }

  /**
   * 构建单个工作区标签；固定连接首页与会话标签共享完全相同的选择和关闭行为。
   *
   * @param {Object} tab - 工作区标签配置。
   * @param {boolean} isHome - 是否为固定在左侧的连接首页标签。
   * @returns {JSX.Element} 可选择并按配置决定是否可关闭的标签。
   */
  const renderWorkspaceTab = (tab, isHome = false) => {
    const active = tab.id === activeTabId
    return (
      <div
        key={tab.id}
        ref={active ? activeTabRef : null}
        className={`workspace-tab${ active ? ' is-active' : '' }${ isHome ? ' is-home' : '' }`}
        role="presentation"
      >
        <button
          type="button"
          className="workspace-tab-select"
          role="tab"
          aria-selected={active}
          tabIndex={active ? 0 : -1}
          onClick={() => onSelect(tab.id)}
        >
          <AppIcon name={tab.icon || 'file'} />
          <span>{tab.title}</span>
        </button>
        {tab.closable !== false && (
          <button
            type="button"
            className="workspace-tab-close"
            aria-label={`关闭 ${ tab.title }`}
            onClick={event => {
              event.stopPropagation()
              void onClose(tab.id)
            }}
          >
            <AppIcon name="close" />
          </button>
        )}
      </div>
    )
  }

  return (
    <nav
      className="workspace-tabbar"
      role="tablist"
      aria-label="工作区选项卡"
      aria-orientation="horizontal"
      onWheel={handleWheel}
    >
      {renderWorkspaceTab(connectionTab, true)}
      <div
        ref={sessionListRef}
        className="workspace-tab-list"
        role="presentation"
      >
        {sessionTabs.map(tab => renderWorkspaceTab(tab))}
      </div>
    </nav>
  )
}

export default WorkspaceTabBar
