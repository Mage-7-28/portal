import { ConfigProvider, theme } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import { GlobalFontFamily } from './utils/GlobalEnum.js'
import SshManager from './components/SshManager'

function App() {

  return (
    <ConfigProvider theme={ {
      token: {
        colorPrimary: '#595f65',
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
      <div style={ { padding: '20px', backgroundColor: '#141414', minHeight: '100vh', color: '#ffffff' } }>
        <h1>传送门 (Portal)</h1>
        <h2>跨平台文件传输工具</h2>
        <SshManager />
      </div>
    </ConfigProvider>
  )
}

export default App
