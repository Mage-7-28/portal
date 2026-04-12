import { Col, ConfigProvider, Row, theme } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import { GlobalFontFamily } from './utils/GlobalEnum.js'
import { Toaster } from 'react-hot-toast'
import Remote from './components/Remote'

function App() {

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
