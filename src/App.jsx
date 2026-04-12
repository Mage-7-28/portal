import { Col, ConfigProvider, Row, theme } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import { GlobalFontFamily } from './utils/common.js'
import { Toaster } from 'react-hot-toast'
import Remote from './components/Remote'
import { store } from './utils/storeUtils.js'
import * as dialog from '@tauri-apps/plugin-dialog'
import { useEffect } from 'react'

function App() {

  // 检查本地下载路径
  useEffect(() => {
    const checkDownloadPath = async () => {
      try {
        // 检查store中是否有下载路径
        const downloadPath = await store.get('download_path')
        console.log('当前存储的下载路径:', downloadPath)
        if (!downloadPath) {
          // 弹出系统级文件夹选择对话框
          console.log('开始选择下载路径...')
          const result = await dialog.open({
            title: '选择本地下载路径',
            directory: true,
            multiple: false,
            canCreateDirectories: true
          })

          console.log('选择结果:', result)
          if (result && result.length > 0) {
            // 保存下载路径到store
            const selectedPath = result[0]
            console.log('准备保存的下载路径:', selectedPath)
            await store.set('download_path', selectedPath)
            console.log('下载路径已设置:', selectedPath)
            // 验证保存是否成功
            const savedPath = await store.get('download_path')
            console.log('保存后存储的下载路径:', savedPath)
          } else {
            // 如果用户取消选择，再次弹出对话框
            console.log('用户取消选择，重新弹出对话框...')
            checkDownloadPath()
          }
        } else {
          console.log('下载路径已存在:', downloadPath)
        }
      } catch (error) {
        console.error('检查下载路径失败:', error)
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
          <Remote />
        </Col>
      </Row>
      <Toaster />
    </ConfigProvider>
  )
}

export default App
