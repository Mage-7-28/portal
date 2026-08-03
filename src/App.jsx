import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, ConfigProvider, Modal } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import * as dialog from '@tauri-apps/plugin-dialog'
import { confirm } from '@tauri-apps/plugin-dialog'
import { Toaster } from 'react-hot-toast'
import { normalizeError, StoreKeys } from './utils/common.js'
import { AntdThemeConfig } from './theme/antdTheme.js'
import { store, useStoreValue } from './utils/storeUtils.js'
import { notification } from './utils/notificationUtils.js'
import FileBrowserPanel from './components/FileBrowserPanel'
import ProgressMask from './components/ProgressMask'
import portalLogo from '../src-tauri/icons/128x128.png'
import packageInfo from '../package.json'

function App() {
  const storedDownloadPath = useStoreValue(StoreKeys.DOWNLOAD_PATH)
  const downloadPath = typeof storedDownloadPath === 'string' ? storedDownloadPath : ''
  const downloadPathHint = downloadPath || '尚未设置（首次下载时选择）'
  const [ aboutOpen, setAboutOpen ] = useState(false)
  const exitConfirmingRef = useRef(false)
  const exitRequestedRef = useRef(false)

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
      await invoke('exit_application')
    } catch (error) {
      exitRequestedRef.current = false
      void notification.error('退出应用失败：' + normalizeError(error))
    } finally {
      exitConfirmingRef.current = false
    }
  }, [])

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
      unlistenMenuAbout?.()
    }
  }, [requestApplicationExit])

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
      <Modal
        rootClassName="compact-modal about-modal"
        open={aboutOpen}
        title={null}
        centered
        width="min(360px, calc(100vw - 24px))"
        onCancel={() => setAboutOpen(false)}
        footer={<Button type="primary" onClick={() => setAboutOpen(false)}>确定</Button>}
        destroyOnHidden
      >
        <section className="about-content" aria-label="关于 Portal">
          <img className="about-logo" src={portalLogo} alt="Portal 标志" />
          <h1 className="about-title">Portal</h1>
          <p className="about-description">跨平台 SSH / SFTP 文件管理工具</p>
          <div className="about-meta" aria-label="应用信息">
            <span>版本 {packageInfo.version}</span>
            <span>{packageInfo.license} License</span>
          </div>
        </section>
      </Modal>
      <Toaster />
    </ConfigProvider>
  )
}

export default App
