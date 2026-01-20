import PubSub from 'pubsub-js'

export const GlobalFontFamily = 'AlimamaDongFangDaKai, sans-serif'

export enum PubSubTopic {
  /* 全局遮罩 */
  MASK = 'mask'
}

export const pubSubService = {
  /* 发布全局遮罩事件 */
  sendMask: (data: unknown): void => {
    PubSub.publish(PubSubTopic.MASK, data)
  }
}
