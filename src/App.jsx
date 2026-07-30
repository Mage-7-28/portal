import { useEffect } from 'react'
import { ConfigProvider, theme } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import { listen } from '@tauri-apps/api/event'
import * as dialog from '@tauri-apps/plugin-dialog'
import toast from 'react-hot-toast'
import { GlobalFontFamily, msgBoxStyle, normalizeError, StoreKeys, THEME_BG_INPUT, THEME_BG_PRIMARY, THEME_BG_SECONDARY, THEME_BORDER_COLOR, THEME_PRIMARY_COLOR, THEME_TEXT_LINK, THEME_TEXT_PRIMARY, THEME_TEXT_SECONDARY } from './utils/common.js'
import { store, useStoreValue } from './utils/storeUtils.js'
import { Toaster } from 'react-hot-toast'
import FileBrowserPanel from './components/FileBrowserPanel'
import ProgressMask from './components/ProgressMask'

function App() {
  const storedDownloadPath = useStoreValue(StoreKeys.DOWNLOAD_PATH)
  const downloadPath = typeof storedDownloadPath === 'string' ? storedDownloadPath : ''

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

  return (
    <ConfigProvider theme={ {
      token: {
        colorPrimary: THEME_PRIMARY_COLOR,
        colorBgBase: THEME_BG_PRIMARY,
        colorBgContainer: THEME_BG_SECONDARY,
        colorBgElevated: THEME_BG_INPUT,
        colorBorder: THEME_BORDER_COLOR,
        colorText: THEME_TEXT_PRIMARY,
        colorTextSecondary: THEME_TEXT_SECONDARY,
        colorLink: THEME_TEXT_LINK,
        borderRadius: 5,
        fontFamily: GlobalFontFamily,
        fontSize: 13,
        fontSizeSM: 12,
        controlHeight: 30,
        controlHeightSM: 26,
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
          titleFontSize: 14
        }
      }
    } } locale={ zhCN } componentSize="small">
      <div className="app-shell">
        <div className="app-content">
          <FileBrowserPanel />
        </div>
        <div
          className="download-status"
          title={downloadPath || '尚未设置下载地址，首次下载时会提示选择'}
        >
          <span className="download-status-label">下载地址</span>
          <span className="download-status-path">
            {downloadPath || '尚未设置（首次下载时选择）'}
          </span>
        </div>
      </div>
      <Toaster />
      <ProgressMask />
    </ConfigProvider>
  )
}

export default App
