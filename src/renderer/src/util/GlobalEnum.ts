import PubSub from 'pubsub-js'
import { ServerConnectionValues } from '@renderer/interface'

export const GlobalFontFamily = 'AlimamaDongFangDaKai, sans-serif'

export enum PubSubTopic {
  /* 全局遮罩 */
  MASK = 'mask',
  /* 刷新文件列表 */
  CONNECT_SERVER = 'connect_server'
}

export const pubSubService = {
  /* 发布全局遮罩事件 */
  sendMask: (data: unknown): void => {
    PubSub.publish(PubSubTopic.MASK, data)
  },
  /* 发布服务器连接事件 */
  sendConnectServer: (data: ServerConnectionValues): void => {
    PubSub.publish(PubSubTopic.CONNECT_SERVER, data)
  }
}
