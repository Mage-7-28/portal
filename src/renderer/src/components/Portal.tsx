import { ReactElement, useEffect, useState } from 'react'
import { Tree } from 'antd'
import { FileOutlined, FolderOutlined } from '@ant-design/icons'

interface PortalProps {
  type: 'local' | 'server'
}

interface FileItem {
  key: string
  title: string
  isLeaf?: boolean
  children?: FileItem[]
  path: string
}

/**
 * @description: 文件传输组件
 * @return {ReactElement}
 */
const Portal = ({ type }: PortalProps): ReactElement => {
  const [fileTree, setFileTree] = useState<FileItem[]>([])

  // 模拟获取本机文件列表
  const fetchLocalFiles = async (): Promise<void> => {
    try {
      // 这里应该调用electron的ipcRenderer来获取本机文件
      // 暂时模拟数据
      const mockFiles: FileItem[] = [
        {
          key: '/',
          title: '/',
          path: '/',
          children: [
            {
              key: '/Users',
              title: 'Users',
              path: '/Users',
              children: [
                {
                  key: '/Users/cherry',
                  title: 'cherry',
                  path: '/Users/cherry',
                  children: [
                    {
                      key: '/Users/cherry/Documents',
                      title: 'Documents',
                      path: '/Users/cherry/Documents',
                      isLeaf: false
                    },
                    {
                      key: '/Users/cherry/Desktop',
                      title: 'Desktop',
                      path: '/Users/cherry/Desktop',
                      isLeaf: false
                    },
                    {
                      key: '/Users/cherry/Downloads',
                      title: 'Downloads',
                      path: '/Users/cherry/Downloads',
                      isLeaf: false
                    },
                    {
                      key: '/Users/cherry/test.txt',
                      title: 'test.txt',
                      path: '/Users/cherry/test.txt',
                      isLeaf: true
                    }
                  ]
                }
              ]
            },
            {
              key: '/Applications',
              title: 'Applications',
              path: '/Applications',
              isLeaf: false
            },
            {
              key: '/System',
              title: 'System',
              path: '/System',
              isLeaf: false
            }
          ]
        }
      ]
      setFileTree(mockFiles)
    } catch (error) {
      console.error('获取文件列表失败:', error)
    }
  }

  useEffect(() => {
    if (type === 'local') {
      fetchLocalFiles()
    }
  }, [type])

  const renderTreeNodes = (data: FileItem[]): React.ReactNode => {
    return data.map((item) => {
      return (
        <Tree.TreeNode
          title={item.title}
          key={item.key}
          icon={item.isLeaf ? <FileOutlined /> : <FolderOutlined />}
        >
          {item.children && item.children.length > 0 ? renderTreeNodes(item.children) : null}
        </Tree.TreeNode>
      )
    })
  }

  return (
    <div style={{ height: '100%', width: '100%' }}>
      <Tree defaultExpandAll showLine style={{ height: '100%', overflow: 'auto' }}>
        {renderTreeNodes(fileTree)}
      </Tree>
    </div>
  )
}
export default Portal
