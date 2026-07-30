import { Col, ConfigProvider, Row, theme } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import { GlobalFontFamily } from './utils/common.js'
import { Toaster } from 'react-hot-toast'
import FileBrowserPanel from './components/FileBrowserPanel'
import ProgressMask from './components/ProgressMask'

function App() {
  return (
    <ConfigProvider theme={ {
      token: {
        colorPrimary: '#4f8cff',
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
