import toast from 'react-hot-toast'
import { getCurrentWindow } from '@tauri-apps/api/window'
import {
  isPermissionGranted,
  requestPermission,
  sendNotification
} from '@tauri-apps/plugin-notification'
import { msgBoxStyle } from './constants.js'

// 系统通知未提供标题时使用的应用名称，以及应用内 Toast 的默认去重 ID。
const APP_TITLE = 'Portal'
const DEFAULT_TOAST_ID = 'msgBoxGlobal'

/**
 * @typedef {Object} NotificationOptions
 * @property {string} [title] - 系统通知或应用内提示标题。
 * @property {string} [body] - 通知正文。
 * @property {string} [id] - 应用内 Toast 去重标识。
 * @property {number} [duration] - 应用内 Toast 持续时间（毫秒）。
 * @property {string} [position] - 应用内 Toast 位置。
 * @property {Object} [style] - 应用内 Toast 样式覆盖项。
 */

// 通知权限的进程级缓存，避免每次后台提示都重复查询或弹出授权请求。
let permissionState = 'unknown'
// 并发权限请求共享同一个 Promise，防止多个异步通知同时触发系统弹窗。
let permissionPromise = null
// Tauri 当前窗口实例只创建一次，浏览器预览环境仍可由异常分支降级。
let appWindow = null

/**
 * 获取并缓存当前 Tauri 窗口实例。
 *
 * @returns {Object} 当前应用窗口对象。
 */
const getWindow = () => {
  if (!appWindow) appWindow = getCurrentWindow()
  return appWindow
}

/**
 * 将标题和正文合并为统一的应用内提示文本。
 *
 * @param {unknown} title - 通知标题。
 * @param {unknown} body - 通知正文。
 * @returns {string} 去除空白并使用中文冒号连接的提示文本。
 */
const getToastMessage = (title, body) => {
  const safeTitle = String(title || '').trim()
  const safeBody = String(body || '').trim()
  if (!safeTitle) return safeBody
  if (!safeBody) return safeTitle
  return `${ safeTitle }：${ safeBody }`
}

/**
 * 判断当前窗口是否适合显示应用内 Toast。
 *
 * @returns {Promise<boolean>} 窗口可见、未最小化且聚焦时返回 true。
 */
const isWindowFocused = async () => {
  // 浏览器开发模式下没有可靠的 Tauri 窗口状态，先使用页面可见性作为降级判断。
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return false

  try {
    const window = getWindow()
    const [ focused, visible, minimized ] = await Promise.all([
      window.isFocused(),
      window.isVisible(),
      window.isMinimized()
    ])
    return Boolean(focused && visible && !minimized)
  } catch (error) {
    // Vite 浏览器预览或旧版运行环境不支持窗口查询时，回退到浏览器焦点状态。
    if (typeof document !== 'undefined' && typeof document.hasFocus === 'function') {
      return document.visibilityState !== 'hidden' && document.hasFocus()
    }
    console.debug('读取应用窗口状态失败，按前台处理:', error)
    return true
  }
}

/**
 * 根据通知类型选择 react-hot-toast 的显示方法。
 *
 * @param {string} type - `success`、`error`、`loading` 或普通信息类型。
 * @returns {Function} 与通知类型匹配的 Toast 方法。
 */
const getToastMethod = (type) => {
  if (type === 'success' && typeof toast.success === 'function') return toast.success
  if (type === 'error' && typeof toast.error === 'function') return toast.error
  if (type === 'loading' && typeof toast.loading === 'function') return toast.loading
  return toast
}

/**
 * 在应用内显示 Toast，并合并项目统一的提示样式。
 *
 * @param {string} type - Toast 类型。
 * @param {unknown} title - 提示标题。
 * @param {unknown} body - 提示正文。
 * @param {NotificationOptions} [options={}] - Toast 显示选项。
 * @returns {boolean} Toast 已提交给 react-hot-toast 时返回 true。
 */
const showToast = (type, title, body, options = {}) => {
  const toastMethod = getToastMethod(type)
  const toastOptions = {
    ...options,
    id: options.id || DEFAULT_TOAST_ID,
    style: { ...msgBoxStyle, ...(options.style || {}) }
  }
  toastMethod(getToastMessage(title, body), toastOptions)
  return true
}

/**
 * 移除仅适用于应用内 Toast 的字段，保留 Tauri 系统通知选项。
 *
 * @param {NotificationOptions} [options={}] - 混合通知选项。
 * @returns {Object} 可传给系统通知插件的选项对象。
 */
const pickSystemOptions = (options = {}) => {
  const {
    title: _title,
    body: _body,
    id: _id,
    style: _style,
    duration: _duration,
    position: _position,
    ...systemOptions
  } = options
  return systemOptions
}

/**
 * 统一的通知工具：窗口在前台时显示应用内提示，窗口失焦或最小化时发送系统通知。
 *
 * @class
 */
export class NotificationUtils {
  /**
   * 判断当前是否允许发送系统通知。
   *
   * @returns {Promise<boolean>} 系统通知权限已授予时返回 true。
   */
  static async checkPermission() {
    try {
      const granted = await isPermissionGranted()
      permissionState = granted ? 'granted' : 'denied'
      return granted
    } catch (error) {
      permissionState = 'denied'
      console.error('检查系统通知权限失败:', error)
      return false
    }
  }

  /**
   * 请求系统通知权限。
   *
   * @returns {Promise<boolean>} 用户授权系统通知时返回 true。
   */
  static async requestPermission() {
    try {
      const permission = await requestPermission()
      permissionState = permission === 'granted' ? 'granted' : 'denied'
      return permissionState === 'granted'
    } catch (error) {
      permissionState = 'denied'
      console.error('请求系统通知权限失败:', error)
      return false
    }
  }

  /**
   * 只在首次确实需要系统通知时申请权限，避免启动应用时打扰用户。
   *
   * @returns {Promise<boolean>} 当前是否具备发送系统通知的权限。
   */
  static async ensurePermission() {
    if (permissionState === 'granted') return true
    if (permissionState === 'denied') return false
    if (permissionPromise) return permissionPromise

    permissionPromise = (async () => {
      const granted = await this.checkPermission()
      if (granted) return true
      return NotificationUtils.requestPermission()
    })().finally(() => {
      permissionPromise = null
    })
    return permissionPromise
  }

  /**
   * 获取当前窗口状态，供需要时调试或测试。
   *
   * @returns {Promise<boolean>} 当前窗口处于前台且可交互时返回 true。
   */
  static async isForeground() {
    return isWindowFocused()
  }

  /**
   * 根据窗口状态分发通知。
   *
   * @param {string} type - Toast 类型或普通信息类型。
   * @param {unknown} title - 通知标题。
   * @param {unknown} [body=''] - 通知正文。
   * @param {NotificationOptions} [options={}] - 应用内和系统通知共用的选项。
   * @returns {Promise<boolean>} 通知是否成功发送或显示。
   */
  static async dispatch(type, title, body = '', options = {}) {
    const foreground = await isWindowFocused()
    if (foreground) return showToast(type, title, body, options)

    const permissionGranted = await NotificationUtils.ensurePermission()
    if (!permissionGranted) {
      // 用户关闭系统通知权限后仍保留应用内提示，避免重要错误被静默丢弃。
      return showToast(type, title, body, options)
    }

    try {
      sendNotification({
        title: String(title || APP_TITLE),
        body: String(body || ''),
        ...pickSystemOptions(options)
      })
      return true
    } catch (error) {
      console.error('发送系统通知失败:', error)
      return showToast(type, title, body, options)
    }
  }

  /**
   * 发送普通通知。
   *
   * @param {NotificationOptions & {type?: string}} [options={}] - 通知标题、正文、类型和显示选项。
   * @returns {Promise<boolean>} 通知是否成功发送或显示。
   */
  static async send(options = {}) {
    const { title = APP_TITLE, body = '', type = 'info', ...rest } = options
    return NotificationUtils.dispatch(type, title, body, rest)
  }

  /**
   * 发送信息通知。
   *
   * @param {unknown} title - 通知标题。
   * @param {unknown} body - 通知正文。
   * @param {NotificationOptions} [options={}] - 通知显示选项。
   * @returns {Promise<boolean>} 通知是否成功发送或显示。
   */
  static async info(title, body, options = {}) {
    return NotificationUtils.dispatch('info', title, body, options)
  }

  /**
   * 发送成功通知。
   *
   * @param {unknown} title - 通知标题。
   * @param {unknown} body - 通知正文。
   * @param {NotificationOptions} [options={}] - 通知显示选项。
   * @returns {Promise<boolean>} 通知是否成功发送或显示。
   */
  static async success(title, body, options = {}) {
    return NotificationUtils.dispatch('success', title, body, options)
  }

  /**
   * 发送错误通知。
   *
   * @param {unknown} title - 通知标题。
   * @param {unknown} body - 通知正文。
   * @param {NotificationOptions} [options={}] - 通知显示选项。
   * @returns {Promise<boolean>} 通知是否成功发送或显示。
   */
  static async error(title, body, options = {}) {
    return NotificationUtils.dispatch('error', title, body, options)
  }

  /**
   * 发送警告通知。
   *
   * @param {unknown} title - 通知标题。
   * @param {unknown} body - 通知正文。
   * @param {NotificationOptions} [options={}] - 通知显示选项。
   * @returns {Promise<boolean>} 通知是否成功发送或显示。
   */
  static async warning(title, body, options = {}) {
    return NotificationUtils.dispatch('warning', title, body, options)
  }

  /**
   * 保留兼容性；系统通知按钮需通过 Tauri actionTypeId 配置，当前只发送文本通知。
   *
   * @param {unknown} title - 通知标题。
   * @param {unknown} body - 通知正文。
   * @param {Object[]} _buttons - 兼容旧调用方的按钮描述，当前不会发送到系统通知。
   * @param {NotificationOptions} [options={}] - 通知显示选项。
   * @returns {Promise<boolean>} 通知是否成功发送或显示。
   */
  static async withButtons(title, body, _buttons, options = {}) {
    return NotificationUtils.dispatch('info', title, body, options)
  }

  /**
   * 延迟发送通知。
   *
   * @param {number} delay - 延迟时间（毫秒）。
   * @param {NotificationOptions & {type?: string}} options - 延迟发送的通知配置。
   * @returns {Promise<boolean>} 延迟后通知是否成功发送或显示。
   */
  static async sendWithDelay(delay, options) {
    return new Promise(resolve => {
      setTimeout(() => {
        void NotificationUtils.send(options).then(resolve)
      }, delay)
    })
  }
}

export const notification = NotificationUtils
export const sendInfo = NotificationUtils.info
export const sendSuccess = NotificationUtils.success
export const sendError = NotificationUtils.error
export const sendWarning = NotificationUtils.warning
export const sendNotificationWithDelay = NotificationUtils.sendWithDelay

/**
 * 初始化通知模块；权限会在第一次后台通知时按需申请。
 *
 * @returns {Promise<void>} 初始化状态重置完成后的 Promise。
 */
export const initNotification = async () => {
  permissionState = 'unknown'
}
