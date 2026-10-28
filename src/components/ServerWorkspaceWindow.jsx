/**
 * 单个 SSH 连接配置的独立工作窗口，集中展示 SFTP、终端与服务器状态。
 */
import { Component, lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { Button, Card, ConfigProvider, Space, Splitter, Tag } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { confirm } from '@tauri-apps/plugin-dialog'
import { AntdThemeConfig } from '../theme/antdTheme.js'
import { useStoreValue } from '../utils/storeUtils.js'
import { normalizeError, StoreKeys } from '../utils/common.js'
import { formatServerWorkspaceTitle, SERVER_WORKSPACE_CLOSE_EVENT } from '../utils/serverWorkspace.js'
import { normalizeTerminalFontSize, normalizeWorkspaceLayout, shouldRevealWorkspace } from '../utils/workspacePreferences.js'
import ConnectionBootScreen from './ConnectionBootScreen.jsx'
import FileBrowserPanel from './FileBrowserPanel.jsx'
import ProgressMask from './ProgressMask.jsx'
import ServerMonitorPanel from './ServerMonitorPanel.jsx'
import sftpManager from '../utils/sftpUtils.js'

const LazyTerminalView = lazy(() => import('./TerminalModal.jsx').then(module => ({
  default: module.TerminalView
})))

class TerminalErrorBoundary extends Component {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  componentDidCatch(error) {
    this.props.onError?.(error)
  }

  render() {
    if (this.state.failed) {
      return <div className="server-terminal-placeholder">终端模块加载失败，可继续使用文件与监控；请重新打开工作窗口重试</div>
    }
    return this.props.children
  }
}

/**
 * 为当前连接提供完整的多窗工作区与关闭清理。
 *
 * @param {{connectionId: string, connection: Object}} props - URL 中读取的连接展示信息。
 * @returns {JSX.Element} 包含文件区、终端和服务器状态的工作窗口。
 */
const ServerWorkspaceWindow = ({ connectionId, connection }) => {
  const [ connectedProfile, setConnectedProfile ] = useState(null)
  const [ connectionProfile, setConnectionProfile ] = useState(connection)
  const [ terminalStatus, setTerminalStatus ] = useState({ status: 'connecting', message: '正在连接终端...' })
  const [ sessionState, setSessionState ] = useState({ status: 'connecting', message: '正在连接服务器...' })
  const [ connectRequestId, setConnectRequestId ] = useState(1)
  const [ monitorState, setMonitorState ] = useState({ status: 'connecting', message: '' })
  const [ workspaceReady, setWorkspaceReady ] = useState(false)
  const [ bootVisible, setBootVisible ] = useState(true)
  const [ focusMode, setFocusMode ] = useState(false)
  const [ terminalControls, setTerminalControls ] = useState(null)
  const [ sessionAttemptId, setSessionAttemptId ] = useState(0)
  const storedConnections = useStoreValue(StoreKeys.SSH_CONNECTIONS)
  const showHiddenFiles = useStoreValue(StoreKeys.SHOW_HIDDEN_FILES) === true
  const storedLayouts = useStoreValue(StoreKeys.WORKSPACE_LAYOUTS)
  const storedTerminalFontSize = useStoreValue(StoreKeys.TERMINAL_FONT_SIZE)
  const closingRef = useRef(false)
  const closeConfirmingRef = useRef(false)
  const currentWindow = useRef(null)
  const sessionDisconnectRef = useRef(null)
  const terminalCloseRef = useRef(null)
  const connectionProfileRef = useRef(connectionProfile)
  const workspaceMainRef = useRef(null)
  const activeAttemptRef = useRef(0)
  const [ terminalFocusRequest, setTerminalFocusRequest ] = useState(0)

  const savedLayout = storedLayouts && typeof storedLayouts === 'object'
    ? storedLayouts[connectionId]
    : null
  const [ layout, setLayout ] = useState(() => normalizeWorkspaceLayout(savedLayout))
  const [ availableHeight, setAvailableHeight ] = useState(() => Math.max(1, window.innerHeight - 16))
  const { fileRatio } = layout
  const terminalRatio = Math.max(0.32, Math.min(layout.rightTerminalRatio, 1 - 220 / availableHeight))
  const terminalFontSize = normalizeTerminalFontSize(storedTerminalFontSize)

  if (!currentWindow.current) currentWindow.current = getCurrentWindow()
  connectionProfileRef.current = connectionProfile

  const closeWindow = useCallback(async () => {
    if (closingRef.current) return
    closingRef.current = true
    const disconnectRequest = Promise.resolve()
      .then(() => Promise.allSettled([
        terminalCloseRef.current?.(),
        sessionDisconnectRef.current
          ? sessionDisconnectRef.current()
          : sftpManager.disconnect(connectionId)
      ]))
      .catch(error => {
        console.warn('关闭服务器工作区时释放 SSH 会话失败：', normalizeError(error))
      })
    let timeoutId
    try {
      await Promise.race([
        disconnectRequest,
        new Promise(resolve => {
          timeoutId = window.setTimeout(resolve, 1200)
        })
      ])
    } finally {
      if (timeoutId !== undefined) window.clearTimeout(timeoutId)
    }
    try {
      await currentWindow.current?.destroy()
    } catch (error) {
      closingRef.current = false
      console.error('关闭服务器工作窗口失败：', normalizeError(error))
    }
  }, [connectionId])

  const requestWindowClose = useCallback(async () => {
    if (closingRef.current || closeConfirmingRef.current) return
    closeConfirmingRef.current = true
    try {
      const profile = connectionProfileRef.current
      const confirmed = await confirm(
        `确定关闭 ${ profile?.username || '用户' }@${ profile?.host || '当前服务器' } 的工作窗口吗？\n\n关闭后将断开 SSH/SFTP 和远程终端，正在进行的文件传输也会中断。`,
        { title: '关闭服务器工作窗口', kind: 'warning', okLabel: '断开并关闭', cancelLabel: '保留连接' }
      )
      if (confirmed) await closeWindow()
    } catch (error) {
      // 确认框失败时保留连接，不能绕过防误关保护直接销毁窗口。
      console.error('确认关闭服务器工作窗口失败：', normalizeError(error))
    } finally {
      closeConfirmingRef.current = false
    }
  }, [closeWindow])

  useEffect(() => {
    let disposed = false
    let unlistenClose
    const registerClose = async () => {
      try {
        const dispose = await currentWindow.current.onCloseRequested(event => {
          // 重复点击关闭也必须拦截，避免原生默认行为提前销毁正在清理的 WebView。
          event.preventDefault()
          void requestWindowClose()
        })
        if (disposed) dispose()
        else unlistenClose = dispose
      } catch (error) {
        console.error('注册服务器工作区关闭事件失败：', error)
      }
    }
    void registerClose()
    return () => {
      disposed = true
      unlistenClose?.()
    }
  }, [requestWindowClose])

  useEffect(() => {
    let disposed = false
    let unlisten
    void currentWindow.current.listen(SERVER_WORKSPACE_CLOSE_EVENT, () => void closeWindow())
      .then(dispose => {
        if (disposed) dispose()
        else unlisten = dispose
      })
      .catch(error => console.error('监听工作窗口清理请求失败：', normalizeError(error)))
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [closeWindow])

  useEffect(() => {
    if (!Array.isArray(storedConnections)) return
    const profile = storedConnections.find(item => item?.id === connectionId)
    if (!profile) return
    setConnectionProfile(current => ({ ...current, ...profile }))
    void currentWindow.current?.setTitle(formatServerWorkspaceTitle(profile))
  }, [ connectionId, storedConnections ])

  const registerSessionDisconnect = useCallback(disconnectHandler => {
    sessionDisconnectRef.current = disconnectHandler
  }, [])

  const registerTerminalClose = useCallback(closeHandler => {
    terminalCloseRef.current = closeHandler
  }, [])

  const handleSessionStateChange = useCallback(state => {
    const attemptId = Number.isInteger(state?.attemptId) ? state.attemptId : activeAttemptRef.current
    if (attemptId < activeAttemptRef.current) return
    if (state?.phase === 'ssh' && attemptId !== activeAttemptRef.current) {
      activeAttemptRef.current = attemptId
      setConnectedProfile(null)
      setWorkspaceReady(false)
      setMonitorState({ status: 'connecting', message: '' })
      setTerminalStatus({ status: 'connecting', message: '正在连接终端...' })
      setTerminalControls(null)
    } else if (attemptId !== activeAttemptRef.current) {
      return
    }
    setSessionState(state)
    if (state.status === 'connected') return
    if (state.status === 'error' || state.status === 'idle') {
      setConnectedProfile(null)
      setWorkspaceReady(false)
      setMonitorState({ status: 'connecting', message: '' })
      setTerminalStatus({ status: 'connecting', message: '正在连接终端...' })
      setTerminalControls(null)
    }
  }, [])

  const handleSessionConnected = useCallback((profile, attemptId) => {
    if (attemptId !== activeAttemptRef.current) return
    setSessionAttemptId(attemptId)
    setConnectedProfile({
      id: profile.id,
      name: profile.name,
      host: profile.host,
      username: profile.username,
      port: profile.port
    })
  }, [])

  const handleMonitorStateChange = useCallback(state => {
    if (sessionAttemptId === activeAttemptRef.current) setMonitorState(state)
  }, [sessionAttemptId])
  const handleTerminalStatusChange = useCallback(state => {
    if (sessionAttemptId === activeAttemptRef.current) setTerminalStatus(state)
  }, [sessionAttemptId])
  const handleTerminalControlsReady = useCallback(controls => {
    if (sessionAttemptId === activeAttemptRef.current) setTerminalControls(controls)
  }, [sessionAttemptId])
  const handleTerminalLoadError = useCallback(error => {
    console.error('加载远程终端组件失败：', normalizeError(error))
    setTerminalStatus({ status: 'error', message: '终端模块加载失败' })
  }, [])

  useEffect(() => {
    if (shouldRevealWorkspace(Boolean(connectedProfile), terminalStatus.status, monitorState.status)) setWorkspaceReady(true)
  }, [ connectedProfile, monitorState.status, terminalStatus.status ])

  useEffect(() => {
    if (!connectedProfile || workspaceReady) return undefined
    // 辅助能力响应过慢时放行已就绪的 SFTP，面板保留各自真实的加载或错误状态。
    const timer = window.setTimeout(() => setWorkspaceReady(true), 12_000)
    return () => window.clearTimeout(timer)
  }, [ connectedProfile, workspaceReady ])

  useEffect(() => {
    if (!workspaceReady) {
      setBootVisible(true)
      return undefined
    }
    const timer = window.setTimeout(() => setBootVisible(false), 180)
    return () => window.clearTimeout(timer)
  }, [workspaceReady])

  const handleConnectionDeleted = useCallback(async () => {
    await closeWindow()
  }, [closeWindow])

  const updateWindowTitle = useCallback(profile => {
    if (!profile?.id || profile.id !== connectionId) return
    setConnectionProfile(current => ({ ...current, ...profile }))
    void currentWindow.current?.setTitle(formatServerWorkspaceTitle(profile))
  }, [connectionId])

  useEffect(() => {
    const container = workspaceMainRef.current
    if (!container) return undefined
    const observer = new window.ResizeObserver(entries => {
      const height = entries[0]?.contentRect.height
      if (height > 0) setAvailableHeight(height)
    })
    observer.observe(container)
    return () => observer.disconnect()
  }, [])

  const persistWorkspaceLayout = useCallback(() => {
    if (focusMode) return
    window.requestAnimationFrame(() => {
      const horizontal = workspaceMainRef.current?.querySelector('.server-workspace-horizontal')
      const vertical = workspaceMainRef.current?.querySelector('.server-workspace-vertical')
      if (!horizontal || !vertical) return
      const horizontalPanels = horizontal?.querySelectorAll(':scope > .ant-splitter-panel')
      const verticalPanels = vertical?.querySelectorAll(':scope > .ant-splitter-panel')
      const horizontalWidth = horizontal?.getBoundingClientRect().width || 0
      const verticalHeight = vertical?.getBoundingClientRect().height || 0
      const nextFileRatio = horizontalWidth > 0 && horizontalPanels?.[0]
        ? horizontalPanels[0].getBoundingClientRect().width / horizontalWidth
        : fileRatio
      const nextTerminalRatio = verticalHeight > 0 && verticalPanels?.[0]
        ? verticalPanels[0].getBoundingClientRect().height / verticalHeight
        : terminalRatio
      void invoke('update_workspace_layout', {
        connectionId,
        layout: normalizeWorkspaceLayout({ fileRatio: nextFileRatio, rightTerminalRatio: nextTerminalRatio })
      }).catch(error => console.warn('保存工作区布局失败：', normalizeError(error)))
    })
  }, [ connectionId, fileRatio, focusMode, terminalRatio ])

  useEffect(() => {
    let disposed = false
    let unlisten
    const listenForConnectionLoss = async () => {
      try {
        const dispose = await listen('ssh-disconnected', event => {
          if (event.payload?.id !== connectionId) return
          handleSessionStateChange({ status: 'error', message: event.payload?.reason || '连接已断开，请重新连接' })
        })
        if (disposed) dispose()
        else unlisten = dispose
      } catch (error) {
        console.warn('监听服务器断线状态失败：', normalizeError(error))
      }
    }
    void listenForConnectionLoss()
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [ connectionId, handleSessionStateChange ])

  const waitingForConnection = sessionState.status === 'connecting' || sessionState.status === 'waiting-user' || sessionState.status === 'password' || Boolean(connectedProfile)

  return (
    <ConfigProvider theme={AntdThemeConfig} locale={zhCN} componentSize="small">
      <main className={`server-workspace-shell${ focusMode ? ' is-terminal-focus' : '' }`} aria-busy={!workspaceReady && waitingForConnection}>
        <div
          ref={workspaceMainRef}
          className={`server-workspace-main${ workspaceReady ? '' : ' is-initializing' }`}
          aria-hidden={!workspaceReady}
          inert={!workspaceReady}
        >
          <Splitter
            className="server-workspace-horizontal"
            orientation="horizontal"
            onResize={sizes => {
              if (!focusMode && sizes[0] + sizes[1] > 0) setLayout(current => ({ ...current, fileRatio: sizes[0] / (sizes[0] + sizes[1]) }))
            }}
            onResizeEnd={persistWorkspaceLayout}
          >
            <Splitter.Panel size={`${ fileRatio * 100 }%`} min="30%" max="62%">
              <div className="server-workspace-pane" inert={focusMode} aria-hidden={focusMode}>
                <FileBrowserPanel
                  workspaceMode="session"
                  showHiddenFiles={showHiddenFiles}
                  initialConnection={connectionProfile}
                  connectRequestId={connectRequestId}
                  onSessionDisconnectReady={registerSessionDisconnect}
                  onConnectionDeleted={handleConnectionDeleted}
                  onConnectionSaved={updateWindowTitle}
                  onSessionConnected={handleSessionConnected}
                  onSessionStateChange={handleSessionStateChange}
                />
              </div>
            </Splitter.Panel>
            <Splitter.Panel size={`${ (1 - fileRatio) * 100 }%`} min="38%">
              <Splitter
                className="server-workspace-vertical"
                orientation="vertical"
                onResize={sizes => {
                  if (!focusMode && sizes[0] + sizes[1] > 0) setLayout(current => ({ ...current, rightTerminalRatio: sizes[0] / (sizes[0] + sizes[1]) }))
                }}
                onResizeEnd={persistWorkspaceLayout}
              >
                <Splitter.Panel size={`${ terminalRatio * 100 }%`} min="32%" max="70%">
                  <Card
                    className="server-terminal-card"
                    size="small"
                    title="远程终端"
                    extra={connectedProfile ? (
                      <Space size={4} className="server-terminal-controls">
                        <Tag
                          className="server-terminal-status"
                          color={{ connected: 'success', connecting: 'processing', error: 'error' }[terminalStatus.status] || 'default'}
                        >
                          {terminalStatus.message || (terminalStatus.status === 'connected'
                            ? '已连接'
                            : terminalStatus.status === 'connecting' ? '连接中' : '未连接')}
                        </Tag>
                        <Button size="small" type="text" onClick={() => terminalControls?.openSearch()} disabled={!terminalControls} aria-label="查找终端内容">查找</Button>
                        <Button size="small" type="text" onClick={() => terminalControls?.adjustFontSize(-1)} disabled={!terminalControls || terminalFontSize <= 10} aria-label="缩小终端字体">A−</Button>
                        <span className="terminal-font-size-label">{terminalFontSize}px</span>
                        <Button size="small" type="text" onClick={() => terminalControls?.adjustFontSize(1)} disabled={!terminalControls || terminalFontSize >= 22} aria-label="放大终端字体">A+</Button>
                        <Button
                          size="small"
                          type="text"
                          onClick={() => terminalControls?.resetFontSize()}
                          disabled={!terminalControls}
                          title="恢复默认字号（13px）"
                          aria-label="恢复默认终端字号（13px）"
                        >
                          重置字号
                        </Button>
                        <Button
                          size="small"
                          type="text"
                          aria-pressed={focusMode}
                          onClick={() => {
                            setFocusMode(mode => !mode)
                            setTerminalFocusRequest(request => request + 1)
                          }}
                        >
                          {focusMode ? '退出专注' : '专注'}
                        </Button>
                      </Space>
                    ) : null}
                    styles={{ body: { minHeight: 0 }}}
                  >
                    {connectedProfile ? (
                      <TerminalErrorBoundary onError={handleTerminalLoadError}>
                        <Suspense fallback={<div className="server-terminal-placeholder">正在加载终端...</div>}>
                          <LazyTerminalView
                            key={connectionId}
                            connectionId={connectionId}
                            connection={connectedProfile}
                            active={workspaceReady}
                            showFooter={false}
                            showConnectionMeta={false}
                            onStatusChange={handleTerminalStatusChange}
                            onCloseReady={registerTerminalClose}
                            onControlsReady={handleTerminalControlsReady}
                            focusRequest={terminalFocusRequest}
                          />
                        </Suspense>
                      </TerminalErrorBoundary>
                    ) : (
                      <div className="server-terminal-placeholder">
                        <span>正在准备远程终端...</span>
                      </div>
                    )}
                  </Card>
                </Splitter.Panel>
                <Splitter.Panel size={`${ (1 - terminalRatio) * 100 }%`} min={220}>
                  <div className="server-workspace-pane" inert={focusMode} aria-hidden={focusMode}>
                    {connectedProfile ? (
                      <ServerMonitorPanel connectionId={connectionId} onInitialStateChange={handleMonitorStateChange} />
                    ) : (
                      <Card className="server-monitor-card" size="small" title="服务器状态">
                        <div className="server-terminal-placeholder">正在准备服务器状态...</div>
                      </Card>
                    )}
                  </div>
                </Splitter.Panel>
              </Splitter>
            </Splitter.Panel>
          </Splitter>
        </div>
        {(!workspaceReady || bootVisible) && (
          <div className={`server-workspace-loading${ workspaceReady ? ' is-leaving' : '' }`} aria-hidden={workspaceReady}>
            <ConnectionBootScreen
              connection={connectionProfile}
              sessionState={sessionState}
              terminalStatus={terminalStatus}
              monitorState={monitorState}
              onRetry={() => setConnectRequestId(request => request + 1)}
            />
          </div>
        )}
        <footer className="server-workspace-footer" hidden={!workspaceReady}><ProgressMask /></footer>
      </main>
    </ConfigProvider>
  )
}

export default ServerWorkspaceWindow
