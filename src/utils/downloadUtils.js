/**
 * 本地下载目录解析与跨平台路径拼接工具。
 *
 * 路径处理同时兼容浏览器预览和 Tauri 桌面运行时。
 */
import * as dialog from '@tauri-apps/plugin-dialog'
import { StoreKeys } from './constants.js'
import { store } from './storeUtils.js'

/**
 * 按本机路径风格拼接目录和文件名，不把远程 SFTP 分隔符混入本地路径。
 *
 * @param {string} base - 本机目录路径。
 * @param {string} name - 要追加的文件或目录名称。
 * @returns {string} 使用检测到的本机分隔符拼接后的路径。
 */
export const joinLocalPath = (base, name) => {
  const separator = base.includes('\\') && !base.includes('/') ? '\\' : '/'
  return `${ base.replace(/[\\/]+$/, '') }${ separator }${ name }`
}

/**
 * 读取持久化下载目录；首次使用时通过原生目录选择器询问用户。
 *
 * @returns {Promise<string|null>} 已保存或新选择的本机目录；用户取消时返回 null。
 * @throws {Error} 当 Tauri Store 或原生目录选择器调用失败时抛出。
 */
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
