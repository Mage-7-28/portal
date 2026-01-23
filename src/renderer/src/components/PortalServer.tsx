import { ReactElement, useCallback, useEffect, useState } from 'react'
import PubSub from 'pubsub-js'
import { PubSubTopic } from '@renderer/util/GlobalEnum'
import Client from 'ssh2-sftp-client'
import { store } from '../store/store'
import { FileOutlined, FolderOpenOutlined } from '@ant-design/icons'

/**
 * @description: 文件传输组件
 * @return {ReactElement}
 */
const PortalServer = (): ReactElement => {
  const [files, setFiles] = useState<Client.FileInfo[]>([])
  const [loading, setLoading] = useState<boolean>(false)
  const [currentPath, setCurrentPath] = useState<string>('/')

  useEffect(() => {
    const connect = PubSub.subscribe(PubSubTopic.CONNECT_SERVER, (_, data) => {
      setLoading(true)
      window.api
        .sshReadDirectory(JSON.parse(JSON.stringify(data)), '/')
        .then((o) => {
          console.log('读取目录结果:', o)
          setFiles(o)
          setCurrentPath('/')
        })
        .finally(() => {
          setLoading(false)
        })
    })
    return () => {
      PubSub.unsubscribe(connect)
    }
  }, [])

  // 获取当前目录的上一级目录
  const getParentPath = useCallback((path: string): string => {
    // 处理Windows根目录，如 C:\ 或 C:/
    if (/^[a-zA-Z]:[/\\]?$/.test(path)) {
      return path
    }

    // 处理Unix根目录
    if (path === '/') return '/'

    // 标准化路径分隔符，将\替换为/
    const normalizedPath = path.replace(/\\/g, '/')

    // 移除末尾的/（如果有）
    const trimmedPath = normalizedPath.endsWith('/') ? normalizedPath.slice(0, -1) : normalizedPath

    // 找到最后一个/的位置
    const lastSlashIndex = trimmedPath.lastIndexOf('/')

    // 如果没有找到/或/在开头，说明是根目录下的直接子目录
    if (lastSlashIndex <= 0) {
      // 处理根目录下的直接子目录，返回根目录
      return '/'
    }

    // 截取到最后一个/之前的位置，确保不以/结尾
    const parentPath = trimmedPath.slice(0, lastSlashIndex)

    // 保持原始路径的分隔符类型
    // 如果原路径包含\，则返回带有\的路径
    // 否则返回带有/的路径
    return path.includes('\\') ? parentPath.replace(/\//g, '\\') : parentPath
  }, [])

  // 读取当前目录的文件
  const readDirectory = useCallback(async (path: string): Promise<void> => {
    setLoading(true)
    try {
      window.api
        .sshReadDirectory(JSON.parse(JSON.stringify(store.connect)), path)
        .then((o) => {
          console.log('读取目录结果:', o)
          setFiles(o)
          setCurrentPath(path)
        })
        .finally(() => {
          setLoading(false)
        })
    } catch (error) {
      console.error('读取目录失败:', error)
    }
  }, [])

  // 进入子目录
  const goToChildDirectory = useCallback(
    (file: Client.FileInfo): void => {
      if (file.type !== '-') {
        readDirectory(currentPath + '/' + file.name)
      }
    },
    [currentPath, readDirectory]
  )

  // 处理拖拽开始事件
  const handleDragStart = (e: React.DragEvent, file: Client.FileInfo): void => {
    e.dataTransfer.setData('text/plain', currentPath + '/' + file.name)
    e.dataTransfer.effectAllowed = 'copy'
  }

  return (
    <div style={{ height: '100%', width: '100%', display: 'flex', flexDirection: 'column' }}>
      {/* 当前路径显示 */}
      <div
        style={{
          height: 30,
          padding: '8px 16px',
          backgroundColor: '#2B2D30',
          borderBottom: '1px solid #1E1E1E',
          fontSize: '12px'
        }}
      >
        {currentPath}
      </div>

      {/* 文件列表 */}
      <div style={{ flex: 1, overflow: 'auto' }}>
        {loading ? (
          <div
            style={{
              display: 'flex',
              justifyContent: 'center',
              alignItems: 'center',
              height: '100%',
              color: '#888'
            }}
          >
            加载中...
          </div>
        ) : (
          <div>
            <div
              onDoubleClick={() => {
                readDirectory(getParentPath(currentPath))
              }}
              style={{
                display: 'flex',
                alignItems: 'center',
                padding: '8px 16px',
                borderBottom: '1px solid #1E1E1E',
                cursor: 'pointer',
                transition: 'background-color 0.2s',
                backgroundColor: '#303134'
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.backgroundColor = '#36373A'
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.backgroundColor = '#303134'
              }}
            >
              <div
                style={{
                  marginRight: '12px',
                  fontSize: '16px',
                  color: '#4E9CEF',
                  flexShrink: 0
                }}
              >
                {<FolderOpenOutlined />}
              </div>
              <div
                style={{
                  flex: 1,
                  color: '#4E9CEF',
                  fontSize: '14px',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap'
                }}
              >
                ..
              </div>
            </div>
            {files.map((file) => (
              <div
                key={currentPath + '/' + file.name}
                draggable
                onDragStart={(e) => handleDragStart(e, file)}
                onDoubleClick={() => goToChildDirectory(file)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  padding: '8px 16px',
                  borderBottom: '1px solid #1E1E1E',
                  cursor: 'pointer',
                  transition: 'background-color 0.2s',
                  backgroundColor: '#303134'
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = '#36373A'
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = '#303134'
                }}
              >
                <div
                  style={{
                    marginRight: '12px',
                    fontSize: '16px',
                    color: file.type !== '-' ? '#4E9CEF' : '#DFE1E5',
                    flexShrink: 0
                  }}
                >
                  {file.type !== '-' ? <FolderOpenOutlined /> : <FileOutlined />}
                </div>
                <div
                  style={{
                    flex: 1,
                    color: file.type !== '-' ? '#4E9CEF' : '#DFE1E5',
                    fontSize: '14px',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap'
                  }}
                  title={file.name}
                >
                  {file.name}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
export default PortalServer
