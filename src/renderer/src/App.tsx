import zhCN from 'antd/locale/zh_CN'
import { Button, ConfigProvider, Layout, theme, Tooltip } from 'antd'
import { GlobalFontFamily, PubSubTopic } from './util/GlobalEnum'
import PubSub from 'pubsub-js'
import Sider from 'antd/es/layout/Sider'
import { Toaster } from 'react-hot-toast'
import { Content } from 'antd/es/layout/layout'
import { HomeOutlined } from '@ant-design/icons'
import { useEffect, useState } from 'react'
import routes from './router/routes'
import { useNavigate, useRoutes } from 'react-router-dom'

function App(): React.JSX.Element {
  const navigate = useNavigate()
  const elements = useRoutes(routes)
  const [current, setCurrent] = useState('/home')
  const [showMask, setShowMask] = useState(false)

  useEffect(() => {
    navigate(current)
  }, [current, navigate])
  useEffect(() => {
    const mask = PubSub.subscribe(PubSubTopic.MASK, (_, data) => {
      setShowMask(data)
    })
    return () => {
      PubSub.unsubscribe(mask)
    }
  }, [])

  return (
    <>
      <ConfigProvider
        theme={{
          token: {
            colorPrimary: '#595f65',
            borderRadius: 5,
            fontFamily: GlobalFontFamily
          },
          algorithm: [theme.darkAlgorithm, theme.compactAlgorithm],
          components: {
            Popover: {
              colorBgElevated: 'rgb(54,57,61)'
            },
            Card: {
              headerBg: 'rgb(54,57,61)',
              actionsBg: 'rgb(54,57,61)'
            }
          }
        }}
        locale={zhCN}
        componentSize={'middle'}
      >
        <Layout>
          <Sider
            width={38}
            className={'hide-scrollbar'}
            style={{
              overflow: 'visible',
              background: 'rgb(43, 45, 48)',
              maxHeight: '100vh',
              height: '100vh'
            }}
          >
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 5,
                padding: '8px 5px',
                alignItems: 'center',
                justifyContent: 'center'
              }}
            >
              <Tooltip placement="right" title={'首页'}>
                <Button
                  style={{ marginBottom: 5 }}
                  danger={current === '/home'}
                  icon={<HomeOutlined />}
                  type={'primary'}
                  onClick={() => setCurrent('/home')}
                />
              </Tooltip>
            </div>
          </Sider>
          <Content
            className={'hide-scrollbar'}
            style={{
              background: 'rgb(30, 31, 34)',
              maxHeight: '100vh',
              height: '100vh',
              overflow: 'auto',
              display: 'flex',
              justifyContent: 'center'
            }}
          >
            {elements}
          </Content>
        </Layout>
        {showMask && <div className="mask"></div>}
        <Toaster />
      </ConfigProvider>
    </>
  )
}

export default App
