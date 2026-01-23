import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import { ServerConnectionValues } from '../renderer/src/interface'
import Client from 'ssh2-sftp-client'

// Custom APIs for renderer
const api = {
  readDirectory: (path: string) => ipcRenderer.invoke('read-directory', path),
  sshReadDirectory: (server: ServerConnectionValues, path: string): Promise<Client.FileInfo[]> =>
    ipcRenderer.invoke('ssh-read-directory', server, path),
  uploadFileToServer: (localFilePath: string, remoteDirectory: string) =>
    ipcRenderer.invoke('upload-file-to-server', localFilePath, remoteDirectory),
  downloadFileFromServer: (remoteFilePath: string, localDirectory: string) =>
    ipcRenderer.invoke('download-file-from-server', remoteFilePath, localDirectory)
}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
