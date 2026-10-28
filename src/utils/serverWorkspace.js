/**
 * 从当前窗口 URL 中读取服务器工作区连接信息。
 *
 * @returns {Object|null} 连接 ID 和非敏感展示字段；普通窗口返回 null。
 */
export const SERVER_WORKSPACE_WINDOW_PREFIX = 'PortalWorkspace-'
// 已经确认的应用退出和连接删除使用定向事件，避免重复触发窗口关闭确认。
export const SERVER_WORKSPACE_CLOSE_EVENT = 'portal-workspace-close'

/**
 * 按登录用户名和远端地址生成工作窗口标题。
 *
 * @param {{username?: string, host?: string, port?: number|string}} connection - 当前连接配置。
 * @returns {string} 包含用户、主机和端口的原生窗口标题。
 */
export const formatServerWorkspaceTitle = connection => {
  const username = String(connection?.username || '用户')
  const rawHost = String(connection?.host || '服务器')
  const host = rawHost.includes(':') && !rawHost.startsWith('[') ? `[${ rawHost }]` : rawHost
  const port = Number(connection?.port) || 22
  return `${ username }@${ host }:${ port } · Portal`
}

export const getServerWorkspaceParams = () => {
  const params = new window.URLSearchParams(window.location.search)
  if (params.get('window') !== 'workspace') return null
  const connectionId = params.get('connectionId') || ''
  if (!connectionId) return null
  return {
    connectionId,
    connection: {
      id: connectionId,
      name: params.get('name') || '',
      host: params.get('host') || '',
      username: params.get('username') || '',
      port: Number(params.get('port')) || 22
    }
  }
}

/**
 * 为连接配置 ID 生成稳定且不含敏感信息的原生窗口标签。
 *
 * @param {string} connectionId - 持久化连接配置 ID。
 * @returns {string} 可跨 WebView 查找的工作窗口标签。
 */
export const getServerWorkspaceWindowLabel = connectionId => {
  let hash = 0xcbf29ce484222325n
  for (let index = 0; index < connectionId.length; index += 1) {
    hash ^= BigInt(connectionId.charCodeAt(index))
    hash = BigInt.asUintN(64, hash * 0x100000001b3n)
  }
  return `${ SERVER_WORKSPACE_WINDOW_PREFIX }${ hash.toString(16).padStart(16, '0') }`
}
