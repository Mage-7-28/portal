import { ReactElement, useEffect, useState, useCallback, useRef } from 'react'
import { FileOutlined, FolderOpenOutlined } from '@ant-design/icons'

interface FileInfo {
  name: string
  path: string
  isDirectory: boolean
  size: number
  mtime: number
}

/**
 * @description: 文件传输组件
 * @return {ReactElement}
 */
const PortalLocal = (): ReactElement => {
  const [currentPath, setCurrentPath] = useState<string>('/')
  const [files, setFiles] = useState<FileInfo[]>([])
  const [loading, setLoading] = useState<boolean>(false)
  // 跟踪组件是否已经初始化
  const initializedRef = useRef(false)

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
      const result = await window.api.readDirectory(path)
      if (result.success && result.data) {
        setFiles(result.data)
        setCurrentPath(path)
      } else {
        console.error('读取目录失败:', result.error)
      }
    } catch (error) {
      console.error('读取目录失败:', error)
    } finally {
      setLoading(false)
    }
  }, [])

  // 返回上一级目录
  const goToParentDirectory = useCallback((): void => {
    const parentPath = getParentPath(currentPath)
    readDirectory(parentPath)
  }, [currentPath, readDirectory, getParentPath])

  // 进入子目录
  const goToChildDirectory = useCallback(
    (file: FileInfo): void => {
      if (file.isDirectory) {
        readDirectory(file.path)
      }
    },
    [readDirectory]
  )

  // 双击事件处理
  const handleDoubleClick = useCallback(
    (file: FileInfo): void => {
      if (file.name === '..') {
        goToParentDirectory()
      } else {
        goToChildDirectory(file)
      }
    },
    [goToParentDirectory, goToChildDirectory]
  )

  // 初始加载
  useEffect(() => {
    // 使用ref确保初始化只运行一次，避免React.StrictMode导致的重复渲染
    if (!initializedRef.current) {
      // 只在组件挂载时初始化，使用固定的初始路径
      readDirectory('/')
      initializedRef.current = true
    }
  }, [readDirectory])

  // 准备文件列表数据
  const fileList = [
    {
      name: '..',
      path: getParentPath(currentPath),
      isDirectory: true,
      size: 0,
      mtime: Date.now()
    },
    ...files
  ]

  // 处理拖拽开始事件
  const handleDragStart = (e: React.DragEvent, file: FileInfo) => {
    e.dataTransfer.setData('text/plain', file.path)
    e.dataTransfer.effectAllowed = 'copy'
  }

  return (
    <div style={{ height: '100%', width: '100%', display: 'flex', flexDirection: 'column' }}>
      {/* 当前路径显示 */}
      <div
        style={{
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
          <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%', color: '#888' }}>
            加载中...
          </div>
        ) : (
          <div>
            {fileList.map((file) => (
              <div
                key={file.path}
                draggable
                onDragStart={(e) => handleDragStart(e, file)}
                onClick={() => goToChildDirectory(file)}
                onDoubleClick={() => handleDoubleClick(file)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  padding: '8px 16px',
                  borderBottom: '1px solid #1E1E1E',
                  cursor: file.isDirectory ? 'pointer' : 'default',
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
                <div style={{ marginRight: '12px', fontSize: '16px', color: file.isDirectory ? '#4E9CEF' : '#DFE1E5', flexShrink: 0 }}>
                  {file.isDirectory ? <FolderOpenOutlined /> : <FileOutlined />}
                </div>
                <div 
                  style={{ 
                    flex: 1, 
                    color: file.isDirectory ? '#4E9CEF' : '#DFE1E5', 
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
export default PortalLocal
