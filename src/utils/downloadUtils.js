import * as dialog from '@tauri-apps/plugin-dialog'
import { StoreKeys } from './constants.js'
import { store } from './storeUtils.js'

export const joinLocalPath = (base, name) => {
  const separator = base.includes('\\') && !base.includes('/') ? '\\' : '/'
  return `${ base.replace(/[\\/]+$/, '') }${ separator }${ name }`
}

export const resolveDownloadPath = async () => {
  let downloadPath = await store.get(StoreKeys.DOWNLOAD_PATH)
  if (downloadPath) return downloadPath

  const selected = await dialog.open({
    title: '选择本地下载目录',
    directory: true,
    multiple: false,
    canCreateDirectories: true
  })
  if (typeof selected !== 'string' || !selected) return null
  await store.set(StoreKeys.DOWNLOAD_PATH, selected)
  return selected
}
