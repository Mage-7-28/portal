/**
 * 本机文件系统 IPC 适配层，统一处理桌面端路径和平台差异。
 *
 * 所有原生调用都通过 Tauri 命令完成，浏览器环境保留可测试的降级路径。
 */
import { invoke } from '@tauri-apps/api/core'
import { FileSizeUnits } from './common.js'

/**
 * 获取当前登录用户的主目录绝对路径。
 *
 * @returns {Promise<string>} 用户主目录；IPC 失败时返回 `/` 作为跨平台降级值。
 */
export const getUserHomeDir = async () => {
  try {
    const homeDir = await invoke('get_home_dir')
    return homeDir
  } catch (error) {
    console.error('获取用户主目录失败:', error)
    // 降级方案：使用默认路径
    return '/'
  }
}

/**
 * 获取指定路径下的直接子项，并在前端排除隐藏文件。
 *
 * @param {string} targetPath - 目标路径，可以是绝对路径或包含 `~/` 的路径。
 * @returns {Promise<Array<{name: string, isDirectory: boolean, size: number}>>} 按目录优先、名称排序的本地条目；读取失败时返回空数组。
 */
export const getDirectoryContents = async (targetPath) => {
  try {
    // 处理 ~/ 路径
    let resolvedPath = targetPath
    if (targetPath.startsWith('~/')) {
      const homeDir = await getUserHomeDir()
      resolvedPath = targetPath.replace('~', homeDir)
    }

    // 调用 Rust 命令读取目录内容
    const entries = await invoke('read_directory', { path: resolvedPath })

    // 过滤出文件和目录，排除隐藏文件
    const filteredEntries = entries.filter(entry => {
      return !entry.name.startsWith('.')
    })

    // 按名称排序，目录在前
    filteredEntries.sort((a, b) => {
      if (a.isDirectory && !b.isDirectory) return -1
      if (!a.isDirectory && b.isDirectory) return 1
      return a.name.localeCompare(b.name)
    })

    return filteredEntries
  } catch (error) {
    console.error('获取目录内容失败:', error)
    return []
  }
}

/**
 * 获取系统平台。
 *
 * @returns {Promise<string>} Rust 平台标识；IPC 失败时返回 `unknown`。
 */
export const getPlatform = async () => {
  try {
    const platform = await invoke('get_platform')
    return platform
  } catch (error) {
    console.error('获取系统平台失败:', error)
    return 'unknown'
  }
}

/**
 * 获取系统驱动器列表（Windows）或根目录（macOS/Linux）。
 *
 * @returns {Promise<string[]>} 可用于本地文件浏览器的根路径列表；调用失败时返回 `/`。
 */
export const getDrives = async () => {
  try {
    const platform = await getPlatform()
    let driveList = []

    if (platform === 'win32') {
      // Windows 系统获取所有驱动器
      try {
        const drives = await invoke('list_drives')
        driveList = drives
      } catch (error) {
        console.error('获取驱动器列表失败:', error)
        driveList = ['C:'] // 默认 C 盘
      }
    } else if (platform === 'darwin') {
      // macOS 系统获取根目录和用户目录
      driveList = [ '/', '/Users' ]
    } else {
      // Linux 系统获取根目录
      driveList = ['/']
    }

    return driveList
  } catch (error) {
    console.error('获取驱动器失败:', error)
    return ['/'] // 默认根目录
  }
}
