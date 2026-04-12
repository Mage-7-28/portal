import React from 'react'
import { List } from 'antd'
import { FolderOutlined, FileOutlined } from '@ant-design/icons'
import { formatFileSize } from '../utils/common'

const RemoteFileItem = ({ entry, currentPath, onClick }) => {
  return (
    <div
      style={{
        cursor: 'default'
      }}
      onClick={onClick}
    >
      <List.Item
        style={{
          cursor: entry.isDirectory ? 'pointer' : 'default',
          borderBottom: '1px solid #1E1E1E',
          padding: '12px'
        }}
        hoverable
      >
        <List.Item.Meta
          avatar={
            entry.isDirectory ?
              <FolderOutlined style={{ color: '#4EC9B0' }} /> :
              <FileOutlined style={{ color: '#ffffff' }} />
          }
          title={
            <span style={{ color: entry.isDirectory ? '#4EC9B0' : '#ffffff' }}>
              {entry.name}
            </span>
          }
        />
        <span style={{ color: '#888888', fontSize: 12 }}>
          {entry.isDirectory ? '' : formatFileSize(entry.size)}
        </span>
      </List.Item>
    </div>
  )
}

export default RemoteFileItem