import { Col, ConfigProvider, Row, theme } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import { GlobalFontFamily, StoreKeys } from './utils/common.js'
import { Toaster } from 'react-hot-toast'
import FileBrowserPanel from './components/FileBrowserPanel'
import ProgressMask from './components/ProgressMask'
import { store } from './utils/storeUtils.js'
import * as dialog from '@tauri-apps/plugin-dialog'
import { invoke } from '@tauri-apps/api/core'
import { useEffect } from 'react'

function App() {

  // 检查本地下载路径
  useEffect(() => {
    const checkDownloadPath = async () => {
      try {
        // 检查store中是否有下载路径
        const downloadPath = await store.get(StoreKeys.DOWNLOAD_PATH)

        if (!downloadPath) {
          // 弹出系统级文件夹选择对话框
          const result = await dialog.open({
            title: '选择本地下载路径',
            directory: true,
            multiple: false,
            canCreateDirectories: true
          })

          if (result) {
            // 保存下载路径到store
            await store.set(StoreKeys.DOWNLOAD_PATH, result)
          } else {
            // 用户取消选择，使用默认路径
            const homeResult = await invoke('get_home_dir')
            if (homeResult) {
              await store.set(StoreKeys.DOWNLOAD_PATH, homeResult)
            }
          }
        } else {
          // 下载路径已存在，无需处理
        }
      } catch (error) {
        // 检查下载路径失败，使用默认路径
        try {
          const homeResult = await invoke('get_home_dir')
          if (homeResult) {
            await store.set(StoreKeys.DOWNLOAD_PATH, homeResult)
          }
        } catch {
          // 无法获取默认路径，忽略错误
        }
      }
    }

    checkDownloadPath()
  }, [])

  return (
    <ConfigProvider theme={ {
      token: {
        colorPrimary: 'rgb(224, 82, 156)',
        borderRadius: 5,
        fontFamily: GlobalFontFamily
      },
      algorithm: [ theme.darkAlgorithm, theme.compactAlgorithm ],
      components: {
        Popover: {
          colorBgElevated: 'rgb(54,57,61)'
        },
        Card: {
          headerBg: 'rgb(54,57,61)',
          actionsBg: 'rgb(54,57,61)'
        }
      }
    } } locale={ zhCN } componentSize={ 'middle' }>
      <Row gutter={5} style={{ padding: '0 10px' }}>
        <Col span={24}>
          <FileBrowserPanel />
        </Col>
      </Row>
      <Toaster />
      <ProgressMask />
    </ConfigProvider>
  )
}

export default App
