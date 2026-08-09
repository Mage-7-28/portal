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

function MainApp() {
  const storedDownloadPath = useStoreValue(StoreKeys.DOWNLOAD_PATH)
  const downloadPath = typeof storedDownloadPath === 'string' ? storedDownloadPath : ''
  const downloadPathHint = downloadPath || '尚未设置（首次下载时选择）'
  const [ aboutOpen, setAboutOpen ] = useState(false)
  const [ availableUpdate, setAvailableUpdate ] = useState(null)
  const [ checkingUpdate, setCheckingUpdate ] = useState(false)
  const [ openingRepository, setOpeningRepository ] = useState(false)
  const exitConfirmingRef = useRef(false)
  const exitRequestedRef = useRef(false)
  const updateCheckStartedRef = useRef(false)

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

  useEffect(() => {
    if (updateCheckStartedRef.current) return undefined
    updateCheckStartedRef.current = true
    void checkApplicationUpdate()
  }, [checkApplicationUpdate])

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

  useEffect(() => {
    let active = true
    let unlisten

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

  useEffect(() => {
    let disposed = false
    let unlistenCloseRequested
    let unlistenMenuExit
    let unlistenMenuUpdate
    let unlistenMenuAbout

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
            <FileBrowserPanel />
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

function App() {
  const terminalWindowParams = getTerminalWindowParams()
  if (terminalWindowParams) {
    return <TerminalWindow {...terminalWindowParams} />
  }
  return <MainApp />
}

export default App
