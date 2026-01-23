export interface ServerConnectionValues {
  host: string
  username: string
  password: string
  port: number
}

export interface FileInfo {
  name: string
  path: string
  isDirectory: boolean
  size: number
  mtime: number
}

export interface Store {
  layout: {
    showPanel: boolean
    panelWidth: number
  }
  server: ServerConnectionValues[]
  connect?: ServerConnectionValues
}
