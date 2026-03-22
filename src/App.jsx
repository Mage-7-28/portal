import { Col, ConfigProvider, Row, theme } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import { GlobalFontFamily } from './utils/GlobalEnum.js'
import SshManager from './components/SshManager'
import Local from './components/Local'
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
        <Col span={12}>
          <Local />
        </Col>
        <Col span={12}>
          <Remote />
        </Col>
      </Row>
    </ConfigProvider>
  )
}

export default App
