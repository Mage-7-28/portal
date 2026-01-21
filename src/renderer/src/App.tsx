import zhCN from 'antd/locale/zh_CN'
import { Button, ConfigProvider, Form, Input, Layout, Modal, theme, Tooltip } from 'antd'
import { GlobalFontFamily, PubSubTopic } from './util/GlobalEnum'
import PubSub from 'pubsub-js'
import Sider from 'antd/es/layout/Sider'
import { Toaster } from 'react-hot-toast'
import { Content } from 'antd/es/layout/layout'
import { HddFilled, PlusCircleFilled } from '@ant-design/icons'
import { useEffect, useState } from 'react'
import routes from './router/routes'
import { useNavigate, useRoutes } from 'react-router-dom'
import { Group, Panel, Separator } from 'react-resizable-panels'
import { useStore, store } from './store/store'
import './app.css'

function App(): React.JSX.Element {
  const navigate = useNavigate()
  const elements = useRoutes(routes)
  const [current, setCurrent] = useState('/home')
  const [showMask, setShowMask] = useState(false)
  // 使用store中的状态
  const storeState = useStore()

  // 新建服务器链接模态框状态
  const [isModalVisible, setIsModalVisible] = useState(false)
  // 表单实例
  const [form] = Form.useForm()

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

  // 显示新建服务器链接模态框
  const showModal = () => {
    setIsModalVisible(true)
  }

  // 关闭新建服务器链接模态框
  const handleCancel = () => {
    setIsModalVisible(false)
    form.resetFields()
  }

  // 提交新建服务器链接表单
  const handleSubmit = (values: any) => {
    console.log('提交服务器连接信息:', values)
    // 这里可以添加连接服务器的逻辑
    setIsModalVisible(false)
    form.resetFields()
  }

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
              height: '100vh',
              borderRight: '1px solid #1E1E1E'
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
              <Tooltip placement="right" title={'服务器'}>
                <Button
                  style={{ marginBottom: 5 }}
                  danger={current === '/home'}
                  icon={<HddFilled />}
                  type={'primary'}
                  onClick={() => {
                    setCurrent('/home')
                    // 点击服务器按钮时，切换红色div的显示/隐藏状态
                    store.layout.showPanel = !storeState.layout.showPanel
                  }}
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
              overflow: 'auto'
            }}
          >
            <Group
              orientation="horizontal"
              style={{ height: '100%', width: '100%' }}
              // 面板布局变化时更新store中的宽度
              onLayoutChanged={(layout) => {
                // 获取红色面板的宽度
                const panelWidth = layout[Object.keys(layout)[0]] || 200
                store.layout.panelWidth = panelWidth
              }}
            >
              {/* 如果显示红色div，则添加可调整大小的面板和调整手柄 */}
              {storeState.layout.showPanel && (
                <>
                  <Panel defaultSize={storeState.layout.panelWidth} minSize={200} maxSize={400}>
                    <div
                      style={{
                        backgroundColor: '#2B2D30',
                        height: '100%',
                        width: '100%'
                      }}
                    >
                      <div
                        style={{
                          borderBottom: '1px solid #1E1E1E',
                          height: 30,
                          display: 'flex',
                          alignItems: 'center',
                          padding: '0 10px'
                        }}
                      >
                        服务器
                      </div>
                      <div
                        className={'hide-scrollbar'}
                        style={{
                          height: 30,
                          whiteSpace: 'nowrap',
                          overflow: 'auto',
                          borderBottom: '1px solid #1E1E1E',
                          display: 'flex',
                          alignItems: 'center',
                          padding: '0 5px',
                          gap: 3
                        }}
                      >
                        <Tooltip placement="bottom" title={'新建服务器链接'}>
                          <div className="panel-button" onClick={showModal}>
                            <PlusCircleFilled />
                          </div>
                        </Tooltip>
                      </div>
                      <div
                        style={{
                          height: 'calc(100% - 30px)',
                          padding: 10,
                          overflow: 'auto'
                        }}
                      >
                        内容
                      </div>
                    </div>
                  </Panel>
                  <Separator
                    style={{
                      width: '1px',
                      backgroundColor: 'transparent',
                      cursor: 'col-resize'
                    }}
                  />
                </>
              )}

              {/* 主内容区域 */}
              <Panel>{elements}</Panel>
            </Group>
          </Content>
        </Layout>
        {showMask && <div className="mask"></div>}
        <Toaster />

        {/* 新建服务器链接模态框 */}
        <Modal
          title="新建服务器链接"
          open={isModalVisible}
          width={350}
          onCancel={handleCancel}
          footer={null}
        >
          <Form form={form} layout="vertical" onFinish={handleSubmit}>
            <Form.Item
              name="host"
              label="服务器IP"
              rules={[{ required: true, message: '请输入服务器IP' }]}
            >
              <Input placeholder="请输入服务器IP" />
            </Form.Item>
            <Form.Item
              name="username"
              label="用户名"
              rules={[{ required: true, message: '请输入用户名' }]}
            >
              <Input placeholder="请输入用户名" />
            </Form.Item>
            <Form.Item
              name="password"
              label="密码"
              rules={[{ required: true, message: '请输入密码' }]}
            >
              <Input.Password placeholder="请输入密码" />
            </Form.Item>
            <Form.Item
              name="port"
              label="端口"
              initialValue={22}
              rules={[{ required: true, message: '请输入端口' }]}
            >
              <Input placeholder="请输入端口" />
            </Form.Item>
            <Form.Item style={{ textAlign: 'right' }}>
              <Button onClick={handleCancel} style={{ marginRight: 8 }}>
                取消
              </Button>
              <Button type="primary" htmlType="submit">
                连接
              </Button>
            </Form.Item>
          </Form>
        </Modal>
      </ConfigProvider>
    </>
  )
}

export default App
