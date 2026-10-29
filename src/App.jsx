/**
 * Portal 主窗口入口。
 * 负责窗口入口选择、主窗口偏好和连接列表的编排。
 */
import { lazy, Suspense, useCallback, useEffect, useRef } from 'react'
import { ConfigProvider } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { confirm } from '@tauri-apps/plugin-dialog'
import { getErrorDetails, normalizeError, StoreKeys } from './utils/constants.js'
import { AntdThemeConfig } from './theme/antdTheme.js'
import { store, useStoreValue } from './utils/storeUtils.js'
import { notification } from './utils/notificationUtils.js'
import TransferProgressProvider from './components/TransferProgressProvider.jsx'
import NotificationHost from './components/NotificationHost.jsx'
import WindowMenuHost from './components/WindowMenuHost.jsx'
import {
  closeServerWorkspaceWindow,
  closeServerWorkspaceWindows,
  openServerWorkspaceWindow,
  updateServerWorkspaceWindow
} from './utils/terminalWindow.js'
import { getServerWorkspaceParams } from './utils/serverWorkspace.js'

// 终端依赖体积较大，只有用户打开终端标签或独立终端窗口时才加载。
const LazyTerminalWindow = lazy(() => import('./components/TerminalWindow.jsx'))
// 工作区和连接列表仅由各自窗口入口加载，避免独立终端引入文件浏览器。
const LazyServerWorkspaceWindow = lazy(() => import('./components/ServerWorkspaceWindow.jsx'))
const LazyFileBrowserPanel = lazy(() => import('./components/FileBrowserPanel.jsx'))

/**
 * 终端异步模块加载期间的轻量占位，避免首屏同步引入 xterm。
 *
 * @param {{standalone?: boolean}} props - 是否用于独立终端窗口。
 * @returns {JSX.Element} 终端加载状态占位。
 */
const TerminalLoading = ({ standalone = false }) => (
  <div
    className={`terminal-loading${ standalone ? ' terminal-loading-standalone' : '' }`}
    role="status"
    aria-live="polite"
  >
    <span className="terminal-loading-indicator" aria-hidden="true" />
    <span>正在加载终端...</span>
  </div>
)

/**
 * 从窗口 URL 中读取独立终端窗口参数。
 * 终端 WebView 只接收连接展示信息，不接收密码等敏感凭据。
 *
 * @returns {{connectionId: string, connection: {id: string, host: string, username: string, port: number}}|null} 终端窗口参数；普通主窗口返回 null。
 */
const getTerminalWindowParams = () => {
  const params = new window.URLSearchParams(window.location.search)
  if (params.get('window') !== 'terminal') return null
  const connectionId = params.get('connectionId') || ''
  return {
    connectionId,
    connection: {
      id: connectionId,
      host: params.get('host') || '',
      username: params.get('username') || '',
      port: Number(params.get('port')) || 22
    }
  }
}

/**
 * 主窗口应用壳，集中管理退出事件、偏好和连接列表。
 * 文件操作由 FileBrowserPanel 负责，窗口菜单弹窗由共享宿主承接。
 *
 * @returns {JSX.Element} 主窗口布局及下载目录状态。
 */
function MainApp() {
  // 从响应式 Store 读取当前下载目录和隐藏文件偏好，值变化会驱动底部提示及列表刷新。
  const storedDownloadPath = useStoreValue(StoreKeys.DOWNLOAD_PATH)
  const storedShowHiddenFiles = useStoreValue(StoreKeys.SHOW_HIDDEN_FILES)
  // 仅允许字符串路径进入标题属性；缺省提示不写回 Store。
  const downloadPath = typeof storedDownloadPath === 'string' ? storedDownloadPath : ''
  const downloadPathHint = downloadPath || '尚未设置（首次下载时选择）'
  // 仅保留用户明确开启的偏好；旧版没有该设置时默认不显示以点开头的远程项目。
  const showHiddenFiles = storedShowHiddenFiles === true
  // 防止退出确认框重复打开；useRef 不触发渲染，适合处理竞态事件。
  const exitConfirmingRef = useRef(false)
  // 标记退出命令是否已经提交，避免关闭事件再次进入退出流程。
  const exitRequestedRef = useRef(false)

  /**
   * 防止重复弹出确认框，并在退出前释放所有服务器工作窗口。
   *
   * @returns {Promise<void>} 用户确认后退出应用，取消或失败时完成清理。
   */
  const requestApplicationExit = useCallback(async () => {
    if (exitConfirmingRef.current || exitRequestedRef.current) return

    exitConfirmingRef.current = true
    try {
      const confirmed = await confirm('确定要退出 Portal 吗？', {
        title: '确认退出',
        kind: 'warning',
        okLabel: '退出',
        cancelLabel: '取消'
      })
      if (!confirmed) return

      exitRequestedRef.current = true
      await closeServerWorkspaceWindows().catch(() => undefined)
      await invoke('exit_application')
    } catch (error) {
      exitRequestedRef.current = false
      void notification.error('退出应用失败', normalizeError(error), { delivery: 'in-app', details: getErrorDetails(error) })
    } finally {
      exitConfirmingRef.current = false
    }
  }, [])

  /**
   * 打开或聚焦指定连接配置对应的服务器工作窗口。
   *
   * 同一连接配置复用现有窗口，不同配置分别创建窗口。
   *
   * @param {Object} connection - 用户从连接列表选择的配置。
   * @returns {Promise<void>} 窗口创建或聚焦完成后的 Promise。
   */
  const openConnectionWorkspace = useCallback(async connection => {
    try {
      await openServerWorkspaceWindow(connection)
    } catch (error) {
      void notification.error('打开服务器工作窗口失败', normalizeError(error), { delivery: 'in-app', details: getErrorDetails(error) })
    }
  }, [])

  /**
   * 关闭已删除连接对应的服务器工作窗口。
   *
   * @param {string} connectionId - 已断开或删除的连接 ID。
   * @returns {void} 异步开始窗口关闭流程。
   */
  const closeConnectionWorkspace = useCallback(connectionId => {
    if (!connectionId) return
    void closeServerWorkspaceWindow(connectionId).catch(error => {
      void notification.error('关闭服务器工作窗口失败', normalizeError(error), { delivery: 'in-app', details: getErrorDetails(error) })
    })
  }, [])

  /**
   * 将连接编辑结果同步到已经打开的文件和终端标签标题。
   *
   * @param {Object} connection - 最新持久化连接配置。
   * @returns {void}
   */
  const updateWorkspaceConnection = useCallback(connection => {
    void updateServerWorkspaceWindow(connection).catch(error => {
      console.warn('更新服务器工作窗口标题失败：', normalizeError(error))
    })
  }, [])

  // Store 里的隐藏文件偏好变化时，同步更新 Rust 原生菜单的勾选状态。
  useEffect(() => {
    // 原生菜单在前端 Store 初始化前已创建，需要将持久化偏好同步回勾选状态。
    void invoke('set_show_hidden_files_menu_checked', { showHiddenFiles }).catch(error => {
      console.warn('同步显示隐藏文件菜单状态失败:', error)
    })
  }, [showHiddenFiles])

  // 注册原生菜单的隐藏文件切换事件；清理时取消 IPC 监听，避免重复写入偏好。
  useEffect(() => {
    let active = true
    let unlisten

    /**
     * 注册显示/隐藏文件菜单监听，并持久化菜单传来的布尔值。
     *
     * @returns {Promise<void>} 菜单监听注册流程完成后的 Promise。
     */
    const listenForShowHiddenFilesMenu = async () => {
      try {
        const dispose = await listen('menu-show-hidden-files', event => {
          if (typeof event.payload !== 'boolean') return
          void store.set(StoreKeys.SHOW_HIDDEN_FILES, event.payload).catch(error => {
            void notification.error('保存显示隐藏文件设置失败', normalizeError(error), { delivery: 'in-app', details: getErrorDetails(error) })
          })
        })
        if (active) {
          unlisten = dispose
        } else {
          dispose()
        }
      } catch (error) {
        console.error('注册显示隐藏文件菜单失败:', error)
      }
    }

    void listenForShowHiddenFilesMenu()
    return () => {
      active = false
      unlisten?.()
    }
  }, [])

  // 主窗口统一承接应用退出，其余窗口菜单由共享宿主定向处理。
  useEffect(() => {
    let disposed = false
    let unlistenCloseRequested
    let unlistenMenuExit

    /**
     * 注册应用窗口及菜单事件，异步注册期间用 disposed 防止泄漏监听器。
     *
     * @returns {Promise<void>} 所有可用事件监听注册完成后的 Promise。
     */
    const registerApplicationEvents = async () => {
      try {
        const closeListener = await getCurrentWindow().onCloseRequested(async event => {
          event.preventDefault()
          await requestApplicationExit()
        })
        if (disposed) {
          closeListener()
          return
        }
        unlistenCloseRequested = closeListener

        const exitListener = await listen('menu-request-exit', () => {
          void requestApplicationExit()
        })
        if (disposed) {
          exitListener()
          return
        }
        unlistenMenuExit = exitListener
      } catch (error) {
        console.error('注册应用菜单事件失败:', error)
      }
    }

    void registerApplicationEvents()
    return () => {
      disposed = true
      unlistenCloseRequested?.()
      unlistenMenuExit?.()
    }
  }, [requestApplicationExit])

  return (
    <ConfigProvider theme={ AntdThemeConfig } locale={ zhCN } componentSize="small">
      <div className="app-shell">
        <div className="app-frame">
          <div className="app-content">
            <Suspense fallback={null}>
              <LazyFileBrowserPanel
                workspaceMode="launcher"
                showHiddenFiles={showHiddenFiles}
                onOpenConnection={openConnectionWorkspace}
                onConnectionDeleted={closeConnectionWorkspace}
                onConnectionSaved={updateWorkspaceConnection}
              />
            </Suspense>
          </div>
          <div
            className="download-status"
            title={downloadPath || '尚未设置下载地址，首次下载时会提示选择'}
          >
            <div className="download-status-location">
              <span className="download-status-label">下载地址</span>
              <span className="download-status-path" title={downloadPathHint}>
                {downloadPathHint}
              </span>
            </div>
          </div>
        </div>
      </div>
    </ConfigProvider>
  )
}

/**
 * 根据窗口 URL 选择主窗口、服务器工作区或独立终端，并挂载共享弹窗宿主。
 *
 * @returns {JSX.Element} 主窗口或独立终端窗口的 React 根组件。
 */
function App() {
  const serverWorkspaceParams = getServerWorkspaceParams()
  const terminalWindowParams = getTerminalWindowParams()
  let content
  if (serverWorkspaceParams) {
    content = (
      <Suspense fallback={null}>
        <LazyServerWorkspaceWindow {...serverWorkspaceParams} />
      </Suspense>
    )
  } else if (terminalWindowParams) {
    content = (
      <Suspense fallback={<TerminalLoading standalone />}>
        <LazyTerminalWindow {...terminalWindowParams} />
      </Suspense>
    )
  } else {
    content = <TransferProgressProvider baseTitle="Portal"><MainApp /></TransferProgressProvider>
  }
  return (
    <>
      {content}
      <WindowMenuHost checkOnStartup={!serverWorkspaceParams && !terminalWindowParams} />
      <NotificationHost />
    </>
  )
}

export default App
