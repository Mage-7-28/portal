import {
  isPermissionGranted,
  requestPermission,
  sendNotification
} from '@tauri-apps/plugin-notification'

/**
 * 通知工具类
 * 封装 Tauri 通知功能，提供更灵活的 API
 */
export class NotificationUtils {
  /**
   * 检查是否有通知权限
   * @returns {Promise<boolean>} 是否有通知权限
   */
  static async checkPermission() {
    try {
      const granted = await isPermissionGranted()
      console.log('通知权限检查结果:', granted ? '已授予' : '未授予')
      return granted
    } catch (error) {
      console.error('检查通知权限失败:', error)
      return false
    }
  }

  /**
   * 请求通知权限
   * @returns {Promise<boolean>} 是否获得权限
   */
  static async requestPermission() {
    try {
      const permission = await requestPermission()
      const granted = permission === 'granted'
      console.log('请求通知权限结果:', granted ? '已授予' : '被拒绝')
      return granted
    } catch (error) {
      console.error('请求通知权限失败:', error)
      return false
    }
  }

  /**
   * 确保有通知权限
   * @returns {Promise<boolean>} 是否有通知权限
   */
  static async ensurePermission() {
    let permissionGranted = await this.checkPermission()
    if (!permissionGranted) {
      permissionGranted = await this.requestPermission()
    }
    return permissionGranted
  }

  /**
   * 发送通知
   * @param {Object} options - 通知选项
   * @param {string} options.title - 通知标题
   * @param {string} options.body - 通知内容
   * @param {string} [options.icon] - 通知图标路径
   * @param {string} [options.sound] - 通知声音
   * @param {Object} [options.data] - 附加数据
   * @param {Function} [options.onClick] - 点击通知时的回调
   * @returns {Promise<boolean>} 是否发送成功
   */
  static async send(options) {
    try {
      const permissionGranted = await this.ensurePermission()
      if (!permissionGranted) {
        console.warn('没有通知权限，无法发送通知')
        return false
      }

      // 发送通知
      await sendNotification(options)
      console.log('通知发送成功:', options.title)
      return true
    } catch (error) {
      console.error('发送通知失败:', error)
      return false
    }
  }

  /**
   * 发送普通通知
   * @param {string} title - 通知标题
   * @param {string} body - 通知内容
   * @param {Object} [options] - 其他选项
   * @returns {Promise<boolean>} 是否发送成功
   */
  static async info(title, body, options = {}) {
    return this.send({ title, body, ...options })
  }

  /**
   * 发送成功通知
   * @param {string} title - 通知标题
   * @param {string} body - 通知内容
   * @param {Object} [options] - 其他选项
   * @returns {Promise<boolean>} 是否发送成功
   */
  static async success(title, body, options = {}) {
    return this.send({
      title,
      body,
      ...options,
      icon: options.icon || '/icons/success.png'
    })
  }

  /**
   * 发送错误通知
   * @param {string} title - 通知标题
   * @param {string} body - 通知内容
   * @param {Object} [options] - 其他选项
   * @returns {Promise<boolean>} 是否发送成功
   */
  static async error(title, body, options = {}) {
    return this.send({
      title,
      body,
      ...options,
      icon: options.icon || '/icons/error.png'
    })
  }

  /**
   * 发送警告通知
   * @param {string} title - 通知标题
   * @param {string} body - 通知内容
   * @param {Object} [options] - 其他选项
   * @returns {Promise<boolean>} 是否发送成功
   */
  static async warning(title, body, options = {}) {
    return this.send({
      title,
      body,
      ...options,
      icon: options.icon || '/icons/warning.png'
    })
  }

  /**
   * 发送带按钮的通知
   * @param {string} title - 通知标题
   * @param {string} body - 通知内容
   * @param {Array} buttons - 按钮配置
   * @param {Object} [options] - 其他选项
   * @returns {Promise<boolean>} 是否发送成功
   */
  static async withButtons(title, body, buttons, options = {}) {
    return this.send({
      title,
      body,
      buttons,
      ...options
    })
  }

  /**
   * 发送带延迟的通知
   * @param {number} delay - 延迟时间（毫秒）
   * @param {Object} options - 通知选项
   * @returns {Promise<boolean>} 是否发送成功
   */
  static async sendWithDelay(delay, options) {
    return new Promise((resolve) => {
      setTimeout(async () => {
        const result = await this.send(options)
        resolve(result)
      }, delay)
    })
  }
}

// 导出默认实例
export const notification = NotificationUtils

// 导出快捷方法
export const sendInfo = NotificationUtils.info
export const sendSuccess = NotificationUtils.success
export const sendError = NotificationUtils.error
export const sendWarning = NotificationUtils.warning
export const sendNotificationWithDelay = NotificationUtils.sendWithDelay

// 初始化函数，在应用启动时调用
export const initNotification = async () => {
  // 检查并请求通知权限
  const granted = await NotificationUtils.ensurePermission()
  if (granted) {
    console.log('通知权限已就绪')
  } else {
    console.log('通知权限未授予，部分功能可能无法使用')
  }
}