export interface ServerConnectionValues {
  host: string
  username: string
  password: string
  port: number
}

export interface SshFileInfo {
  accessTime: number
  group: number
  longname: string
  modifyTime: number
  name: string
  owner: number
  rights: {
    user: string
    group: string
    other: string
  }
  size: number
  type: string
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
