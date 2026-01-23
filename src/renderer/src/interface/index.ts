export interface ServerConnectionValues {
  host: string
  username: string
  password: string
  port: number
}

export interface Store {
  layout: {
    showPanel: boolean,
    panelWidth: number
  }
  server: ServerConnectionValues[]
}
