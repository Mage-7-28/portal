import { ReactElement, useEffect, useState } from 'react'
import { List, Typography } from 'antd'
import { FileOutlined, FolderOpenOutlined } from '@ant-design/icons'

interface PortalProps {
  type: 'local' | 'server'
}

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
const Portal = ({ type }: PortalProps): ReactElement => {
  const [currentPath, setCurrentPath] = useState<string>('/')
  const [files, setFiles] = useState<FileInfo[]>([])
  const [loading, setLoading] = useState<boolean>(false)

  // 获取当前目录的上一级目录
  const getParentPath = (path: string): string => {
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
  }

  // 读取当前目录的文件
  const readDirectory = async (path: string): Promise<void> => {
    setLoading(true)
    try {
      const result = await window.api.readDirectory(path)
      console.log('读取目录结果:', result)
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
  }

  // 返回上一级目录
  const goToParentDirectory = (): void => {
    const parentPath = getParentPath(currentPath)
    readDirectory(parentPath)
  }

  // 进入子目录
  const goToChildDirectory = (file: FileInfo): void => {
    if (file.isDirectory) {
      readDirectory(file.path)
    }
  }

  // 双击事件处理
  const handleDoubleClick = (file: FileInfo): void => {
    if (file.name === '..') {
      goToParentDirectory()
    } else {
      goToChildDirectory(file)
    }
  }

  // 初始加载
  useEffect(() => {
    if (type === 'local') {
      // 只在组件挂载或类型变化时初始化，使用固定的初始路径
      readDirectory('/')
    }
  }, [type])

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
        <List
          loading={loading}
          dataSource={fileList}
          renderItem={(file) => (
            <List.Item
              key={file.path}
              onClick={() => goToChildDirectory(file)}
              onDoubleClick={() => handleDoubleClick(file)}
              style={{
                cursor: file.isDirectory ? 'pointer' : 'default',
                padding: '8px 16px',
                borderBottom: '1px solid #1E1E1E'
              }}
            >
              <List.Item.Meta
                avatar={file.isDirectory ? <FolderOpenOutlined /> : <FileOutlined />}
                title={
                  <Typography.Text style={{ color: file.isDirectory ? '#4E9CEF' : '#DFE1E5' }}>
                    {file.name}
                  </Typography.Text>
                }
                description={
                  <div style={{ display: 'flex', justifyContent: 'space-between', width: '100%' }}>
                    <span style={{ fontSize: '12px', color: '#888' }}>
                      {file.isDirectory ? '文件夹' : `${(file.size / 1024).toFixed(2)} KB`}
                    </span>
                    <span style={{ fontSize: '12px', color: '#888' }}>
                      {new Date(file.mtime).toLocaleString()}
                    </span>
                  </div>
                }
              />
            </List.Item>
          )}
          style={{ height: '100%' }}
        />
      </div>
    </div>
  )
}
export default Portal
