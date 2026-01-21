import { ElectronAPI } from '@electron-toolkit/preload'

// 定义文件信息接口
export interface FileInfo {
  name: string
  path: string
  isDirectory: boolean
  size: number
  mtime: number
}

// 定义读取目录返回结果接口
export interface ReadDirectoryResult {
  success: boolean
  data?: FileInfo[]
  currentPath?: string
  error?: string
}

// 定义API接口
export interface API {
  readDirectory: (path: string) => Promise<ReadDirectoryResult>
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: API
  }
}
