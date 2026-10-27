/**
 * 单个 SSH 连接配置的独立工作窗口，集中展示 SFTP、终端与服务器状态。
 */
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { Alert, Button, Card, ConfigProvider, Empty, Splitter, Tag, Typography } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { listen } from '@tauri-apps/api/event'
import { AntdThemeConfig } from '../theme/antdTheme.js'
import { useStoreValue } from '../utils/storeUtils.js'
import { normalizeError, StoreKeys } from '../utils/common.js'
import FileBrowserPanel from './FileBrowserPanel.jsx'
import ProgressMask from './ProgressMask.jsx'
import ServerMonitorPanel from './ServerMonitorPanel.jsx'
import sftpManager from '../utils/sftpUtils.js'

const LazyTerminalView = lazy(() => import('./TerminalModal.jsx').then(module => ({
  default: module.TerminalView
})))

const { Text } = Typography

/**
 * 为当前连接提供完整的多窗工作区与关闭清理。
 *
 * @param {{connectionId: string, connection: Object}} props - URL 中读取的连接展示信息。
 * @returns {JSX.Element} 包含文件区、终端和服务器状态的工作窗口。
 */
const ServerWorkspaceWindow = ({ connectionId, connection }) => {
  const [ connectedProfile, setConnectedProfile ] = useState(null)
  const [ connectionProfile, setConnectionProfile ] = useState(connection)
  const storedConnections = useStoreValue(StoreKeys.SSH_CONNECTIONS)
  const showHiddenFiles = useStoreValue(StoreKeys.SHOW_HIDDEN_FILES) === true
  const activeConnection = connectedProfile || connectionProfile
  const closingRef = useRef(false)
  const currentWindow = useRef(null)
  const [ terminalFocusRequest, setTerminalFocusRequest ] = useState(0)

  if (!currentWindow.current) currentWindow.current = getCurrentWindow()

  const closeWindow = useCallback(async () => {
    if (closingRef.current) return
    closingRef.current = true
    const disconnectRequest = sftpManager.disconnect(connectionId).catch(error => {
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
    await currentWindow.current?.destroy().catch(() => undefined)
  }, [connectionId])

  useEffect(() => {
    let disposed = false
    let unlistenClose
    const registerClose = async () => {
      try {
        const dispose = await currentWindow.current.onCloseRequested(event => {
          if (closingRef.current) return
          event.preventDefault()
          void closeWindow()
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
  }, [closeWindow])

  useEffect(() => {
    if (!Array.isArray(storedConnections)) return
    const profile = storedConnections.find(item => item?.id === connectionId)
    if (!profile) return
    setConnectionProfile(current => ({ ...current, ...profile }))
    void currentWindow.current?.setTitle(`${ profile.name || profile.host || '服务器' } · Portal`)
  }, [ connectionId, storedConnections ])

  const openTerminal = useCallback(() => {
    setTerminalFocusRequest(request => request + 1)
  }, [])

  const handleConnectionDeleted = useCallback(async () => {
    await currentWindow.current?.destroy().catch(() => undefined)
  }, [])

  const updateWindowTitle = useCallback(profile => {
    if (!profile?.id || profile.id !== connectionId) return
    setConnectionProfile(current => ({ ...current, ...profile }))
    void currentWindow.current?.setTitle(`${ profile.name || profile.host || '服务器' } · Portal`)
  }, [connectionId])

  useEffect(() => {
    let disposed = false
    let unlisten
    const listenForConnectionLoss = async () => {
      try {
        const dispose = await listen('ssh-disconnected', event => {
          if (event.payload?.id !== connectionId) return
          setConnectedProfile(null)
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
  }, [connectionId])

  return (
    <ConfigProvider theme={AntdThemeConfig} locale={zhCN} componentSize="small">
      <main className="server-workspace-shell">
        <header className="server-workspace-header">
          <div className="server-workspace-identity">
            <Text strong className="server-workspace-name">
              {connectionProfile.name || connectedProfile?.name || connectionProfile.host || '服务器工作区'}
            </Text>
            <Text type="secondary" className="server-workspace-endpoint">
              {activeConnection.username || '用户'}@{activeConnection.host || '服务器'}:{activeConnection.port || 22}
            </Text>
            <Tag color={connectedProfile ? 'success' : 'default'}>
              {connectedProfile ? '已连接' : '未连接'}
            </Tag>
          </div>
          <Button type="text" onClick={() => void closeWindow()}>关闭工作窗口</Button>
        </header>
        <div className="server-workspace-main">
          <Splitter className="server-workspace-horizontal" orientation="horizontal">
            <Splitter.Panel defaultSize="42%" min="30%" max="62%">
              <FileBrowserPanel
                workspaceMode="session"
                showHiddenFiles={showHiddenFiles}
                initialConnection={connectionProfile}
                connectRequestId={1}
                onOpenTerminal={openTerminal}
                onConnectionDeleted={handleConnectionDeleted}
                onConnectionSaved={updateWindowTitle}
                onWorkspaceClose={closeWindow}
                onSessionConnected={profile => setConnectedProfile({
                  id: profile.id,
                  name: profile.name,
                  host: profile.host,
                  username: profile.username,
                  port: profile.port
                })}
                onSessionClose={() => {
                  setConnectedProfile(null)
                }}
                sessionCloseLabel="关闭窗口"
              />
            </Splitter.Panel>
            <Splitter.Panel min="38%">
              <Splitter className="server-workspace-vertical" orientation="vertical">
                <Splitter.Panel defaultSize="54%" min="32%" max="70%">
                  <Card
                    className="server-terminal-card"
                    size="small"
                    title="远程终端"
                    styles={{ body: { minHeight: 0 }}}
                  >
                    {connectedProfile ? (
                      <Suspense fallback={<div className="server-terminal-placeholder">正在加载终端...</div>}>
                        <LazyTerminalView
                          key={connectionId}
                          connectionId={connectionId}
                          connection={connectedProfile}
                          active
                          showFooter={false}
                          focusRequest={terminalFocusRequest}
                        />
                      </Suspense>
                    ) : (
                      <div className="server-terminal-placeholder">
                        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="连接服务器后可使用终端" />
                      </div>
                    )}
                  </Card>
                </Splitter.Panel>
                <Splitter.Panel defaultSize="46%" min="30%">
                  {connectedProfile ? (
                    <ServerMonitorPanel connectionId={connectionId} />
                  ) : (
                    <Card className="server-monitor-card" size="small" title="服务器状态">
                      <Alert
                        type="info"
                        showIcon
                        message="连接服务器后显示 CPU、内存和进程信息"
                        description="若远端策略禁用命令执行，SFTP 与终端连接仍可独立使用。"
                      />
                    </Card>
                  )}
                </Splitter.Panel>
              </Splitter>
            </Splitter.Panel>
          </Splitter>
        </div>
        <footer className="server-workspace-footer"><ProgressMask /></footer>
      </main>
    </ConfigProvider>
  )
}

export default ServerWorkspaceWindow
