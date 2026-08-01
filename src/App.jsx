import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, ConfigProvider, Modal, theme } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import * as dialog from '@tauri-apps/plugin-dialog'
import { confirm } from '@tauri-apps/plugin-dialog'
import toast from 'react-hot-toast'
import { GlobalFontFamily, msgBoxStyle, normalizeError, StoreKeys, THEME_BG_INPUT, THEME_BG_PRIMARY, THEME_BG_SECONDARY, THEME_BORDER_COLOR, THEME_PRIMARY_COLOR_FALLBACK, THEME_TEXT_LINK, THEME_TEXT_PRIMARY, THEME_TEXT_SECONDARY } from './utils/common.js'
import { store, useStoreValue } from './utils/storeUtils.js'
import { Toaster } from 'react-hot-toast'
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
      toast.error('退出应用失败：' + normalizeError(error), { id: 'msgBoxGlobal', style: msgBoxStyle })
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
            toast.success('下载路径已更新', { id: 'msgBoxGlobal', style: msgBoxStyle })
          } catch (error) {
            toast.error('设置下载路径失败：' + normalizeError(error), { id: 'msgBoxGlobal', style: msgBoxStyle })
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
    <ConfigProvider theme={ {
      token: {
        colorPrimary: THEME_PRIMARY_COLOR_FALLBACK,
        colorBgBase: THEME_BG_PRIMARY,
        colorBgContainer: THEME_BG_SECONDARY,
        colorBgElevated: THEME_BG_INPUT,
        colorBorder: THEME_BORDER_COLOR,
        colorText: THEME_TEXT_PRIMARY,
        colorTextSecondary: THEME_TEXT_SECONDARY,
        colorLink: THEME_TEXT_LINK,
        borderRadius: 5,
        fontFamily: GlobalFontFamily,
        fontSize: 14,
        fontSizeSM: 13,
        controlHeight: 32,
        controlHeightSM: 28,
        lineHeight: 1.4
      },
      algorithm: [ theme.darkAlgorithm, theme.compactAlgorithm ],
      components: {
        Popover: {
          colorBgElevated: THEME_BG_INPUT
        },
        Card: {
          headerBg: THEME_BG_SECONDARY,
          actionsBg: THEME_BG_SECONDARY
        },
        Modal: {
          titleFontSize: 15
        }
      }
    } } locale={ zhCN } componentSize="small">
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
