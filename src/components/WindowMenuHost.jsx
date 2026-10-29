/** 每个 WebView 的菜单弹窗宿主，独立于主页面和连接状态。 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, ConfigProvider, Modal } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import * as dialog from '@tauri-apps/plugin-dialog'
import { openUrl } from '@tauri-apps/plugin-opener'
import { getErrorDetails, normalizeError, StoreKeys } from '../utils/constants.js'
import { store, useStoreValue } from '../utils/storeUtils.js'
import { notification } from '../utils/notificationUtils.js'
import { checkLatestRelease, PROJECT_REPOSITORY_URL } from '../utils/updateUtils.js'
import { AntdThemeConfig } from '../theme/antdTheme.js'
import AppIcon from './AppIcon.jsx'
import UpdateAvailableModal from './UpdateAvailableModal.jsx'
import packageInfo from '../../package.json'
import '../style/window-menu.css'

/**
 * 在收到菜单操作的窗口内展示关于、下载路径和更新弹窗。
 *
 * @param {{checkOnStartup?: boolean}} props - 仅主窗口执行启动更新检查。
 * @returns {JSX.Element} 当前窗口专属的菜单弹窗。
 */
const WindowMenuHost = ({ checkOnStartup = false }) => {
  const [ aboutOpen, setAboutOpen ] = useState(false)
  const [ downloadPathOpen, setDownloadPathOpen ] = useState(false)
  const [ availableUpdate, setAvailableUpdate ] = useState(null)
  const [ checkingUpdate, setCheckingUpdate ] = useState(false)
  const [ openingRepository, setOpeningRepository ] = useState(false)
  const [ copyingPath, setCopyingPath ] = useState(false)
  const updateCheckStartedRef = useRef(false)
  const selectingPathRef = useRef(false)
  const storedDownloadPath = useStoreValue(StoreKeys.DOWNLOAD_PATH)
  const downloadPath = typeof storedDownloadPath === 'string' ? storedDownloadPath : ''

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
        if (manual) void notification.info('当前已是最新版本', '', { delivery: 'in-app' })
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
      if (manual) void notification.error('检查更新失败', normalizeError(error), { delivery: 'in-app', details: getErrorDetails(error) })
      return false
    } finally {
      setCheckingUpdate(false)
    }
  }, [])

  // 首次挂载时静默检查更新；依赖回调保持稳定，卸载时没有外部资源需要释放。
  useEffect(() => {
    if (!checkOnStartup || updateCheckStartedRef.current) return undefined
    updateCheckStartedRef.current = true
    void checkApplicationUpdate()
  }, [ checkApplicationUpdate, checkOnStartup ])

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
      void notification.error('打开更新页面失败', normalizeError(error), { delivery: 'in-app', details: getErrorDetails(error) })
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
      void notification.error('打开开源地址失败', normalizeError(error), { delivery: 'in-app', details: getErrorDetails(error) })
    } finally {
      setOpeningRepository(false)
    }
  }, [openingRepository])

  /**
   * 在接收菜单操作的 WebView 中打开原生目录选择器；路径仍为全应用共享偏好。
   *
   * @returns {Promise<void>} 目录选择、持久化和结果提示处理完成后的 Promise。
   */
  const chooseDownloadPath = useCallback(async () => {
    if (selectingPathRef.current) return
    selectingPathRef.current = true
    try {
      const currentPath = await store.get(StoreKeys.DOWNLOAD_PATH)
      const selected = await dialog.open({
        title: '选择本地下载路径',
        directory: true,
        multiple: false,
        canCreateDirectories: true,
        ...(typeof currentPath === 'string' && currentPath ? { defaultPath: currentPath } : {})
      })
      if (typeof selected !== 'string' || !selected) return
      await store.set(StoreKeys.DOWNLOAD_PATH, selected)
      void notification.success('下载路径已更新', '', { delivery: 'in-app' })
    } catch (error) {
      void notification.error('设置下载路径失败', normalizeError(error), { delivery: 'in-app', details: getErrorDetails(error) })
    } finally {
      selectingPathRef.current = false
    }
  }, [])

  /** 复制完整本地目录；失败时保留可选中的路径，并在当前窗口反馈。 */
  const copyDownloadPath = async () => {
    if (!downloadPath || copyingPath) return
    setCopyingPath(true)
    try {
      await window.navigator.clipboard.writeText(downloadPath)
      void notification.success('下载路径已复制', '', { delivery: 'in-app' })
    } catch (error) {
      void notification.error('复制下载路径失败', normalizeError(error), { delivery: 'in-app', details: getErrorDetails(error) })
    } finally {
      setCopyingPath(false)
    }
  }

  useEffect(() => {
    let disposed = false
    const unlisteners = []
    const listeners = [
      [ 'menu-about', () => {
        setDownloadPathOpen(false)
        setAboutOpen(true)
      } ],
      [ 'menu-show-download-path', () => {
        setAboutOpen(false)
        setDownloadPathOpen(true)
        // 与下载入口读取同一 Store 键，避免使用首次挂载时的过期路径快照。
        void store.get(StoreKeys.DOWNLOAD_PATH)
      } ],
      [ 'menu-download-path', () => { void chooseDownloadPath() } ],
      [ 'menu-update', () => { void checkApplicationUpdate({ manual: true }) } ]
    ]
    const registerListeners = async () => {
      // 与原生层的 WebviewWindow 目标匹配，不接收其他窗口的菜单操作。
      const currentWindow = getCurrentWebviewWindow()
      await Promise.all(listeners.map(async ([ event, handler ]) => {
        const unlisten = await currentWindow.listen(event, message => {
          // 注册结果尚未返回时也可能收到事件，旧宿主不能重复执行菜单操作。
          if (!disposed) handler(message)
        })
        if (disposed) unlisten()
        else unlisteners.push(unlisten)
      }))
    }
    // 原生接口初始化失败不能让整个窗口的 React 根节点崩溃。
    void registerListeners().catch(error => {
      if (!disposed) void notification.error('注册窗口菜单失败', normalizeError(error), { delivery: 'in-app', details: getErrorDetails(error) })
    })
    return () => {
      disposed = true
      unlisteners.forEach(unlisten => unlisten())
    }
  }, [ checkApplicationUpdate, chooseDownloadPath ])

  return (
    <ConfigProvider theme={AntdThemeConfig} locale={zhCN} componentSize="small">
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
            <img className="about-logo" src="/portal-logo.svg" alt="Portal 标志" />
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
      <Modal
        rootClassName="compact-modal download-path-modal"
        open={downloadPathOpen}
        title="当前下载路径"
        centered
        width="min(520px, calc(100vw - 24px))"
        onCancel={() => setDownloadPathOpen(false)}
        footer={(
          <div className="modal-actions">
            <Button disabled={!downloadPath} loading={copyingPath} onClick={() => void copyDownloadPath()}>复制路径</Button>
            <Button type="primary" onClick={() => setDownloadPathOpen(false)}>关闭</Button>
          </div>
        )}
        destroyOnHidden
      >
        <p className="download-path-description">
          {downloadPath ? '下载文件将保存到以下本地目录。' : '首次下载时会提示选择本地目录，也可以通过菜单提前设置。'}
        </p>
        <div className={`download-path-location${ downloadPath ? '' : ' is-empty' }`}>
          <AppIcon name="folder" size={20} />
          <p className="download-path-value" aria-label="当前下载路径">{downloadPath || '尚未设置下载路径'}</p>
        </div>
      </Modal>
    </ConfigProvider>
  )
}

export default WindowMenuHost
