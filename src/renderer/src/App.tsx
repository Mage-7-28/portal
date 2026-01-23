import zhCN from 'antd/locale/zh_CN'
import { Button, ConfigProvider, Form, Input, Layout, Modal, theme, Tooltip } from 'antd'
import { GlobalFontFamily, PubSubTopic } from './util/GlobalEnum'
import PubSub from 'pubsub-js'
import Sider from 'antd/es/layout/Sider'
import { Toaster } from 'react-hot-toast'
import { Content } from 'antd/es/layout/layout'
import { DeleteFilled, HddFilled, PlusSquareFilled } from '@ant-design/icons'
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Group, Panel, Separator } from 'react-resizable-panels'
import { useStore, store } from './store/store'
import './app.css'
import Portal from '@renderer/components/Portal'
import { ServerConnectionValues } from '@renderer/interface'

function App(): React.JSX.Element {
  const navigate = useNavigate()
  const [current, setCurrent] = useState('/home')
  const [showMask, setShowMask] = useState(false)
  // 使用store中的状态
  const storeState = useStore()
  // 选中的服务器索引
  const [selectedServerIndex, setSelectedServerIndex] = useState<number | null>(null)

  // 新建服务器链接模态框状态
  const [isModalVisible, setIsModalVisible] = useState(false)
  // 表单实例
  const [form] = Form.useForm<ServerConnectionValues>()

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
  const showModal = (): void => {
    setIsModalVisible(true)
  }

  // 关闭新建服务器链接模态框
  const handleCancel = (): void => {
    setIsModalVisible(false)
    form.resetFields()
  }

  // 提交新建服务器链接表单
  const handleSubmit = (values: ServerConnectionValues): void => {
    console.log('提交服务器连接信息:', values)
    window.api.sshReadDirectory(values, '/').then((o) => {
      console.log('读取目录结果:', o)
    })
    store.server.unshift(values)
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
                            <PlusSquareFilled />
                          </div>
                        </Tooltip>
                        <Tooltip placement="bottom" title={'删除选中服务器'}>
                          <div
                            className="panel-button"
                            onClick={() => {
                              if (selectedServerIndex !== null) {
                                store.server.splice(selectedServerIndex, 1)
                                setSelectedServerIndex(null)
                              }
                            }}
                            style={{
                              opacity: selectedServerIndex !== null ? 1 : 0.5,
                              cursor: selectedServerIndex !== null ? 'pointer' : 'not-allowed'
                            }}
                          >
                            <DeleteFilled />
                          </div>
                        </Tooltip>
                      </div>
                      <div
                        style={{
                          height: 'calc(100% - 60px)',
                          padding: 10,
                          overflow: 'auto'
                        }}
                      >
                        {storeState.server.length === 0 ? (
                          <div style={{ textAlign: 'center', color: '#888', padding: '20px 0' }}>
                            暂无服务器，请点击上方按钮添加
                          </div>
                        ) : (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                            {storeState.server.map((server, index) => (
                              <div
                                key={index}
                                style={{
                                  backgroundColor:
                                    index === selectedServerIndex
                                      ? 'rgb(36, 41, 51)'
                                      : 'rgb(30, 31, 34)',
                                  padding: '12px',
                                  borderRadius: '6px',
                                  border:
                                    index === selectedServerIndex
                                      ? '1px solid #4E9CEF'
                                      : '1px solid #1E1E1E',
                                  boxShadow:
                                    index === selectedServerIndex
                                      ? '0 0 0 2px rgba(78, 156, 239, 0.3)'
                                      : 'none',
                                  transition: 'all 0.2s',
                                  cursor: 'pointer'
                                }}
                                onClick={() =>
                                  setSelectedServerIndex(
                                    index === selectedServerIndex ? null : index
                                  )
                                }
                                onMouseEnter={(e) => {
                                  if (index !== selectedServerIndex) {
                                    e.currentTarget.style.backgroundColor = 'rgb(36, 37, 41)'
                                    e.currentTarget.style.borderColor = '#404040'
                                  }
                                }}
                                onMouseLeave={(e) => {
                                  if (index !== selectedServerIndex) {
                                    e.currentTarget.style.backgroundColor = 'rgb(30, 31, 34)'
                                    e.currentTarget.style.borderColor = '#1E1E1E'
                                  }
                                }}
                              >
                                <div
                                  style={{
                                    fontSize: '14px',
                                    fontWeight: '500',
                                    marginBottom: '6px'
                                  }}
                                >
                                  {server.host}
                                </div>
                                <div
                                  style={{
                                    fontSize: '12px',
                                    color: '#888',
                                    display: 'flex',
                                    gap: '16px'
                                  }}
                                >
                                  <span>用户: {server.username}</span>
                                  <span>端口: {server.port}</span>
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
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
              <Panel>
                <Group orientation="horizontal" style={{ height: '100%', width: '100%' }}>
                  {/* 左边：本机文件传输面板 */}
                  <Panel defaultSize={50} minSize={20} maxSize={80}>
                    <div
                      style={{
                        height: '100%',
                        width: '100%',
                        display: 'flex',
                        flexDirection: 'column'
                      }}
                    >
                      <div
                        style={{
                          borderBottom: '1px solid #1E1E1E',
                          height: 30,
                          display: 'flex',
                          alignItems: 'center',
                          padding: '0 10px',
                          backgroundColor: '#2B2D30'
                        }}
                      >
                        本机文件
                      </div>
                      <div style={{ flex: 1, overflow: 'auto' }}>
                        <Portal type="local" />
                      </div>
                    </div>
                  </Panel>
                  <Separator
                    style={{
                      width: '1px',
                      backgroundColor: '#1E1E1E',
                      cursor: 'col-resize'
                    }}
                  />
                  {/* 右边：服务器文件传输面板 */}
                  <Panel defaultSize={50} minSize={20} maxSize={80}>
                    <div
                      style={{
                        height: '100%',
                        width: '100%',
                        display: 'flex',
                        flexDirection: 'column'
                      }}
                    >
                      <div
                        style={{
                          borderBottom: '1px solid #1E1E1E',
                          height: 30,
                          display: 'flex',
                          alignItems: 'center',
                          padding: '0 10px',
                          backgroundColor: '#2B2D30'
                        }}
                      >
                        服务器文件
                      </div>
                      <div style={{ flex: 1, overflow: 'auto' }}>
                        <Portal type="server" />
                      </div>
                    </div>
                  </Panel>
                </Group>
              </Panel>
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
                添加
              </Button>
            </Form.Item>
          </Form>
        </Modal>
      </ConfigProvider>
    </>
  )
}

export default App
