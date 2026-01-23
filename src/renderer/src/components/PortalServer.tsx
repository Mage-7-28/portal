import { ReactElement, useEffect, useState } from 'react'
import PubSub from 'pubsub-js'
import { PubSubTopic } from '@renderer/util/GlobalEnum'
import { SshFileInfo } from '@renderer/interface'

/**
 * @description: 文件传输组件
 * @return {ReactElement}
 */
const PortalServer = (): ReactElement => {
  const [files, setFiles] = useState<SshFileInfo[]>([])

  useEffect(() => {
    const connect = PubSub.subscribe(PubSubTopic.CONNECT_SERVER, (_, data) => {
      window.api.sshReadDirectory(JSON.parse(JSON.stringify(data)), '/').then((o) => {
        console.log('读取目录结果:', o)
        setFiles(o)
      })
    })
    return () => {
      PubSub.unsubscribe(connect)
    }
  }, [])

  return (
    <div style={{ height: '100%', width: '100%', display: 'flex', flexDirection: 'column' }}>

    </div>
  )
}
export default PortalServer
