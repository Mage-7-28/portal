import toast from 'react-hot-toast'
import { getCurrentWindow } from '@tauri-apps/api/window'
import {
  isPermissionGranted,
  requestPermission,
  sendNotification
} from '@tauri-apps/plugin-notification'
import { msgBoxStyle } from './constants.js'

const APP_TITLE = 'Portal'
const DEFAULT_TOAST_ID = 'msgBoxGlobal'

let permissionState = 'unknown'
let permissionPromise = null
let appWindow = null

const getWindow = () => {
  if (!appWindow) appWindow = getCurrentWindow()
  return appWindow
}

const getToastMessage = (title, body) => {
  const safeTitle = String(title || '').trim()
  const safeBody = String(body || '').trim()
  if (!safeTitle) return safeBody
  if (!safeBody) return safeTitle
  return `${ safeTitle }：${ safeBody }`
}

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

const getToastMethod = (type) => {
  if (type === 'success' && typeof toast.success === 'function') return toast.success
  if (type === 'error' && typeof toast.error === 'function') return toast.error
  if (type === 'loading' && typeof toast.loading === 'function') return toast.loading
  return toast
}

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
 */
export class NotificationUtils {
  /** 判断当前是否允许发送系统通知。 */
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

  /** 请求系统通知权限。 */
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

  /** 只在首次确实需要系统通知时申请权限，避免启动应用时打扰用户。 */
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

  /** 获取当前窗口状态，供需要时调试或测试。 */
  static async isForeground() {
    return isWindowFocused()
  }

  /**
   * 根据窗口状态分发通知。
   * @returns {Promise<boolean>} 通知是否成功发送或显示
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

  /** 发送普通通知。 */
  static async send(options = {}) {
    const { title = APP_TITLE, body = '', type = 'info', ...rest } = options
    return NotificationUtils.dispatch(type, title, body, rest)
  }

  /** 发送信息通知。 */
  static async info(title, body, options = {}) {
    return NotificationUtils.dispatch('info', title, body, options)
  }

  /** 发送成功通知。 */
  static async success(title, body, options = {}) {
    return NotificationUtils.dispatch('success', title, body, options)
  }

  /** 发送错误通知。 */
  static async error(title, body, options = {}) {
    return NotificationUtils.dispatch('error', title, body, options)
  }

  /** 发送警告通知。 */
  static async warning(title, body, options = {}) {
    return NotificationUtils.dispatch('warning', title, body, options)
  }

  /** 保留兼容性；系统通知按钮需通过 Tauri actionTypeId 配置，当前只发送文本通知。 */
  static async withButtons(title, body, _buttons, options = {}) {
    return NotificationUtils.dispatch('info', title, body, options)
  }

  /** 延迟发送通知。 */
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

/** 初始化通知模块；权限会在第一次后台通知时按需申请。 */
export const initNotification = async () => {
  permissionState = 'unknown'
}
