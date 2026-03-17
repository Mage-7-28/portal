import PubSub from 'pubsub-js'

export const GlobalFontFamily = 'AlimamaDongFangDaKai, sans-serif'

export const PubSubBusinessKeyEnum = {
  /* 全局遮罩 */
  MASK: 'mask',
  /* 清除store用户信息 */
  CLEAR_USER_INFO: 'cleanUserInfo',
  /* 统计未读消息数量 */
  COUNT_UNREAD_MSG: 'countUnReadMsg',
  /* 发布全局遮罩事件 */
  SEND_MASK: (data) => PubSub.publish(PubSubBusinessKeyEnum.MASK, data),
  /* 发布清除store用户信息事件 */
  SEND_CLEAR_USER_INFO: (data) => PubSub.publish(PubSubBusinessKeyEnum.CLEAR_USER_INFO, data),
  /* 发布统计未读消息数量事件 */
  SEND_COUNT_UNREAD_MSG: (data) => PubSub.publish(PubSubBusinessKeyEnum.COUNT_UNREAD_MSG, data)
}
