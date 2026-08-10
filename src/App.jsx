/**
 * Portal 主窗口入口。
 * 负责应用级菜单、持久化偏好、更新检查和主文件浏览页面的编排。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, ConfigProvider, Modal } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import * as dialog from '@tauri-apps/plugin-dialog'
import { openUrl } from '@tauri-apps/plugin-opener'
import { confirm } from '@tauri-apps/plugin-dialog'
import { Toaster } from 'react-hot-toast'
import { normalizeError, StoreKeys } from './utils/common.js'
import { AntdThemeConfig } from './theme/antdTheme.js'
import { store, useStoreValue } from './utils/storeUtils.js'
import { notification } from './utils/notificationUtils.js'
import { checkLatestRelease, PROJECT_REPOSITORY_URL } from './utils/updateUtils.js'
import FileBrowserPanel from './components/FileBrowserPanel'
import ProgressMask from './components/ProgressMask'
import TerminalWindow from './components/TerminalWindow.jsx'
import UpdateAvailableModal from './components/UpdateAvailableModal.jsx'
import AppIcon from './components/AppIcon'
import { closeTerminalWindows } from './utils/terminalWindow.js'
import portalLogo from '../src-tauri/icons/128x128.png'
import packageInfo from '../package.json'

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
 * 主窗口应用壳，集中管理菜单事件和当前连接页面。
 * 文件操作细节由 FileBrowserPanel 负责，本组件只协调应用级状态。
 *
 * @returns {JSX.Element} 主窗口布局及其应用级弹窗。
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
  // 控制“关于”弹窗的显示状态；关闭弹窗不会销毁应用级更新数据。
  const [ aboutOpen, setAboutOpen ] = useState(false)
  // 保存当前待展示的发布信息；null 表示没有需要提示的更新。
  const [ availableUpdate, setAvailableUpdate ] = useState(null)
  // 标记手动或启动检查是否正在请求，供菜单和关于弹窗显示 loading。
  const [ checkingUpdate, setCheckingUpdate ] = useState(false)
  // 防止重复打开项目仓库时连续触发多个外部窗口。
  const [ openingRepository, setOpeningRepository ] = useState(false)
  // 防止退出确认框重复打开；useRef 不触发渲染，适合处理竞态事件。
  const exitConfirmingRef = useRef(false)
  // 标记退出命令是否已经提交，避免关闭事件再次进入退出流程。
  const exitRequestedRef = useRef(false)
  // 启动检查只允许执行一次，即使 React StrictMode 在开发环境重复挂载。
  const updateCheckStartedRef = useRef(false)

  /**
   * 防止重复弹出确认框，并在退出前释放所有独立终端窗口。
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
      await closeTerminalWindows().catch(() => undefined)
      await invoke('exit_application')
    } catch (error) {
      exitRequestedRef.current = false
      void notification.error('退出应用失败：' + normalizeError(error))
    } finally {
      exitConfirmingRef.current = false
    }
  }, [])

  /**
   * 检查 Gitee 最新发布版本。
   * 启动检查静默失败，手动检查则向用户反馈网络或版本解析错误。
   *
   * @param {{manual?: boolean}} [options={}] - 是否由用户从菜单主动发起检查。
   * @returns {Promise<boolean>} 发现并展示新版本时返回 true，否则返回 false。
   */
  const checkApplicationUpdate = useCallback(async ({ manual = false } = {}) => {
    setCheckingUpdate(true)
    try {
      const update = await checkLatestRelease(packageInfo.version)
      if (!update) {
        if (manual) void notification.info('当前已是最新版本')
        return false
      }

      const skippedVersion = await store.get(StoreKeys.UPDATE_SKIPPED_VERSION)
      if (!manual && skippedVersion === update.latestVersion) return false

      setAvailableUpdate({
        ...update,
        // 启动时允许用户跳过当前版本；手动检查始终不显示跳过选项。
        canSkipVersion: !manual
      })
      return true
    } catch (error) {
      // 启动检查失败不应打断用户进入应用；手动检查则提供可见反馈。
      console.warn('检查应用更新失败:', error)
      if (manual) void notification.error('检查更新失败：' + normalizeError(error))
      return false
    } finally {
      setCheckingUpdate(false)
    }
  }, [])

  // 首次挂载时静默检查更新；依赖回调保持稳定，卸载时没有外部资源需要释放。
  useEffect(() => {
    if (updateCheckStartedRef.current) return undefined
    updateCheckStartedRef.current = true
    void checkApplicationUpdate()
  }, [checkApplicationUpdate])

  /**
   * 关闭更新弹窗，并在用户选择跳过时持久化版本号。
   *
   * @param {{skipVersion?: boolean, version?: string}} options - 当前弹窗的跳过选项和版本号。
   * @returns {Promise<void>} 状态关闭及跳过设置保存完成后的 Promise。
   */
  const dismissAvailableUpdate = useCallback(async ({ skipVersion, version }) => {
    if (skipVersion) {
      try {
        await store.set(StoreKeys.UPDATE_SKIPPED_VERSION, version)
      } catch (error) {
        console.warn('保存跳过的更新版本失败:', error)
      }
    }
    setAvailableUpdate(null)
  }, [])

  /**
   * 打开发布页供用户手动下载安装包，并处理“跳过此版本”设置。
   *
   * @param {{skipVersion?: boolean, version?: string, releaseUrl: string}} options - 发布页地址和跳过设置。
   * @returns {Promise<void>} 外部页面打开及本地设置保存完成后的 Promise。
   */
  const openReleasePage = useCallback(async ({ skipVersion, version, releaseUrl }) => {
    try {
      await openUrl(releaseUrl)
    } catch (error) {
      void notification.error('打开更新页面失败：' + normalizeError(error))
      return
    }

    if (skipVersion) {
      try {
        await store.set(StoreKeys.UPDATE_SKIPPED_VERSION, version)
      } catch (error) {
        console.warn('保存跳过的更新版本失败:', error)
      }
    }
    setAvailableUpdate(null)
  }, [])

  /**
   * 打开项目开源地址；按钮 loading 状态防止重复触发外部打开操作。
   *
   * @returns {Promise<void>} 外部地址打开完成后的 Promise。
   */
  const openProjectRepository = useCallback(async () => {
    if (openingRepository) return

    setOpeningRepository(true)
    try {
      await openUrl(PROJECT_REPOSITORY_URL)
    } catch (error) {
      void notification.error('打开开源地址失败：' + normalizeError(error))
    } finally {
      setOpeningRepository(false)
    }
  }, [openingRepository])

  // 注册“设置下载路径”菜单事件；异步注册完成前若组件卸载则立即释放监听器。
  useEffect(() => {
    let active = true
    let unlisten

    /**
     * 注册下载路径菜单监听，并把用户选择的目录写入持久化 Store。
     *
     * @returns {Promise<void>} 菜单监听注册流程完成后的 Promise。
     */
    const listenForDownloadPathMenu = async () => {
      try {
        const dispose = await listen('menu-download-path', async () => {
          try {
            const result = await dialog.open({
              title: '选择本地下载路径',
              directory: true,
              multiple: false,
              canCreateDirectories: true
            })
            if (typeof result !== 'string' || !result) return
            await store.set(StoreKeys.DOWNLOAD_PATH, result)
            void notification.success('下载路径已更新')
          } catch (error) {
            void notification.error('设置下载路径失败：' + normalizeError(error))
          }
        })
        if (active) {
          unlisten = dispose
        } else {
          dispose()
        }
      } catch (error) {
        console.error('注册下载路径菜单失败:', error)
      }
    }

    void listenForDownloadPathMenu()
    return () => {
      active = false
      unlisten?.()
    }
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
            void notification.error('保存显示隐藏文件设置失败：' + normalizeError(error))
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

  // 统一注册窗口关闭、退出、更新和关于菜单事件，并在卸载时逐一撤销。
  useEffect(() => {
    let disposed = false
    let unlistenCloseRequested
    let unlistenMenuExit
    let unlistenMenuUpdate
    let unlistenMenuAbout

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

        const updateListener = await listen('menu-update', () => {
          void checkApplicationUpdate({ manual: true })
        })
        if (disposed) {
          updateListener()
          return
        }
        unlistenMenuUpdate = updateListener

        const aboutListener = await listen('menu-about', () => {
          setAboutOpen(true)
        })
        if (disposed) {
          aboutListener()
          return
        }
        unlistenMenuAbout = aboutListener
      } catch (error) {
        console.error('注册应用菜单事件失败:', error)
      }
    }

    void registerApplicationEvents()
    return () => {
      disposed = true
      unlistenCloseRequested?.()
      unlistenMenuExit?.()
      unlistenMenuUpdate?.()
      unlistenMenuAbout?.()
    }
  }, [ checkApplicationUpdate, requestApplicationExit ])

  return (
    <ConfigProvider theme={ AntdThemeConfig } locale={ zhCN } componentSize="small">
      <div className="app-shell">
        <div className="app-frame">
          <div className="app-content">
            <FileBrowserPanel showHiddenFiles={showHiddenFiles} />
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
            <div className="download-status-transfer">
              <ProgressMask />
            </div>
          </div>
        </div>
      </div>
      <UpdateAvailableModal
        open={Boolean(availableUpdate)}
        update={availableUpdate}
        canSkipVersion={availableUpdate?.canSkipVersion}
        onCancel={dismissAvailableUpdate}
        onDownload={openReleasePage}
      />
      <Modal
        rootClassName="compact-modal about-modal"
        open={aboutOpen}
        title={null}
        centered
        width="min(410px, calc(100vw - 24px))"
        onCancel={() => setAboutOpen(false)}
        footer={(
          <div className="modal-actions">
            <Button
              icon={<AppIcon name="reload" />}
              loading={checkingUpdate}
              onClick={() => void checkApplicationUpdate({ manual: true })}
            >
              检查更新
            </Button>
            <Button type="primary" onClick={() => setAboutOpen(false)}>关闭</Button>
          </div>
        )}
        destroyOnHidden
      >
        <section className="about-content" aria-label="关于 Portal">
          <div className="about-brand">
            <img className="about-logo" src={portalLogo} alt="Portal 标志" />
            <div className="about-brand-copy">
              <h1 className="about-title">Portal</h1>
              <p className="about-description">SSH / SFTP 文件管理工具</p>
            </div>
          </div>
          <p className="about-summary">
            面向 macOS 的桌面应用，支持连接远程服务器、管理文件和使用 SSH 终端。
          </p>
          <div className="about-meta" aria-label="应用信息">
            <div className="about-meta-item">
              <span>版本</span>
              <strong>{packageInfo.version}</strong>
            </div>
            <div className="about-meta-item">
              <span>许可证</span>
              <strong>{packageInfo.license}</strong>
            </div>
            <div className="about-meta-item">
              <span>主要发布平台</span>
              <strong>macOS</strong>
            </div>
          </div>
          <Button
            type="text"
            className="about-repository"
            loading={openingRepository}
            icon={<AppIcon name="externalLink" size="16" />}
            onClick={() => void openProjectRepository()}
          >
            <span className="about-repository-copy">
              <span className="about-repository-label">开源地址</span>
              <span className="about-repository-url">gitee.com/Mage-7-28/portal</span>
            </span>
          </Button>
        </section>
      </Modal>
      <Toaster />
    </ConfigProvider>
  )
}

/**
 * 根据窗口 URL 在主窗口和独立终端窗口之间选择渲染入口。
 *
 * @returns {JSX.Element} 主窗口或独立终端窗口的 React 根组件。
 */
function App() {
  const terminalWindowParams = getTerminalWindowParams()
  if (terminalWindowParams) {
    return <TerminalWindow {...terminalWindowParams} />
  }
  return <MainApp />
}

export default App
