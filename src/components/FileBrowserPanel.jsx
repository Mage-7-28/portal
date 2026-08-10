/**
 * 文件浏览器业务容器。
 * 负责连接配置、凭据生命周期、远程目录请求、预览资源和页面级错误恢复。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { confirm } from '@tauri-apps/plugin-dialog'
import { Modal, Progress } from 'antd'
import { store } from '../utils/storeUtils.js'
import sftpManager from '../utils/sftpUtils.js'
import { getReadableConnectionError, isCredentialError, SftpConnectionStatus, StoreKeys, normalizeError } from '../utils/constants.js'
import { formatFileSize, PubSubBusinessKeyEnum } from '../utils/common.js'
import { joinLocalPath, resolveDownloadPath } from '../utils/downloadUtils.js'
import { formatJsonPreviewAsync, getPreviewDescriptor, highlightCode, MAX_PREVIEW_BYTES } from '../utils/previewUtils.js'
import FileBrowser from './FileBrowser.jsx'
import ConnectionList from './ConnectionList.jsx'
import PasswordPromptModal from './PasswordPromptModal.jsx'
import { notification } from '../utils/notificationUtils.js'
import { closeTerminalWindows } from '../utils/terminalWindow.js'

/**
 * @typedef {Object} ConnectionProfile
 * @property {string} id - 持久化连接配置的稳定标识。
 * @property {string} name - 列表中展示的连接名称。
 * @property {string} host - SSH 服务器主机名或 IP 地址。
 * @property {number} port - SSH 服务端口。
 * @property {string} username - 登录用户名。
 * @property {'password'} authMethod - 当前支持的认证方式。
 * @property {string|null} hostKeyFingerprint - 用户确认过的主机密钥指纹。
 * @property {string} createdAt - 配置创建时间。
 * @property {string} updatedAt - 配置最近更新时间。
 */

/**
 * @typedef {Object} ConnectionCredentials
 * @property {string} password - 仅保存在当前进程内存中的会话密码。
 */

/**
 * @typedef {Object} RemoteEntry
 * @property {string} name - 当前目录中展示的文件或目录名称。
 * @property {string} path - 服务器返回的完整远程路径。
 * @property {boolean} isDirectory - 是否为目录。
 * @property {string} [kind] - 远程条目类型，例如 file、directory 或 symlink。
 * @property {number} [size] - 文件或链接自身的字节数。
 * @property {number} [modifiedAt] - 服务器返回的修改时间戳。
 */

/**
 * @typedef {Object} OperationStatus
 * @property {(message: string) => void} start - 发布操作开始状态。
 * @property {(progress: number, message: string, details?: Object) => void} update - 发布操作进度状态。
 * @property {() => void} dismiss - 关闭本次操作状态。
 */

/**
 * 将旧版本或外部存储中的连接配置迁移为当前统一结构。
 *
 * @param {unknown} profile - 外部存储中读取到的原始配置。
 * @param {number} index - 原始配置数组中的索引，用于生成旧配置 ID。
 * @returns {ConnectionProfile|null} 可用的当前配置；缺少必要字段时返回 null。
 */
const normalizeProfile = (profile, index) => {
  if (!profile || typeof profile !== 'object' || !profile.host || !profile.username) return null
  return {
    id: profile.id || `legacy-${ profile.host }-${ profile.port || 22 }-${ profile.username }-${ index }`,
    name: profile.name || `${ profile.username }@${ profile.host }`,
    host: profile.host,
    port: Number(profile.port) || 22,
    username: profile.username,
    // 旧版本可能保存过私钥或 SSH Agent 配置，统一迁移为账户密码认证。
    authMethod: 'password',
    hostKeyFingerprint: profile.hostKeyFingerprint || null,
    createdAt: profile.createdAt || new Date().toISOString(),
    updatedAt: profile.updatedAt || profile.createdAt || new Date().toISOString()
  }
}

/**
 * 按最近更新时间排序连接配置，保证最近使用的项目优先展示。
 *
 * @param {ConnectionProfile[]} profiles - 待排序的连接配置。
 * @returns {ConnectionProfile[]} 新数组，原数组不会被修改。
 */
const sortProfiles = (profiles) => [...profiles].sort((a, b) => new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt))

/**
 * 规范化跨平台远程路径，同时保留 Windows 盘符根目录。
 *
 * @param {string|undefined|null} path - 用户输入或服务器返回的远程路径。
 * @returns {string} 使用 `/` 分隔符的远程路径。
 */
const normalizeRemotePath = (path) => {
  const normalized = String(path || '/').trim().replaceAll('\\', '/')
  const driveOnly = /^([A-Za-z]):$/.exec(normalized)
  if (driveOnly) return `${ driveOnly[1] }:/`
  return normalized || '/'
}

/**
 * 在远程路径上追加一个文件名或目录名。
 *
 * @param {string} base - 当前远程目录路径。
 * @param {string} name - 要追加的项目名称。
 * @returns {string} 规范化后的远程子路径。
 */
const joinRemotePath = (base, name) => {
  const normalizedBase = normalizeRemotePath(base)
  if (normalizedBase === '/') return `/${ name }`
  return `${ normalizedBase.replace(/\/+$/, '') }/${ name }`
}

/**
 * 计算当前远程路径的父级，根目录和 Windows 盘符根目录保持不变。
 *
 * @param {string} path - 当前远程目录路径。
 * @returns {string} 可安全进入的父目录路径。
 */
const parentRemotePath = (path) => {
  const normalized = normalizeRemotePath(path)
  if (normalized === '/') return '/'
  if (/^[A-Za-z]:\/?$/.test(normalized)) return normalized.slice(0, 2) + '/'
  const withoutTrailingSlash = normalized.replace(/\/+$/, '')
  const parent = withoutTrailingSlash.slice(0, withoutTrailingSlash.lastIndexOf('/'))
  if (/^[A-Za-z]:$/.test(parent)) return `${ parent }/`
  return parent || '/'
}

/**
 * 从远程用户主目录推导 Windows 盘符；POSIX 路径返回空列表。
 *
 * @param {string} path - 服务器返回的用户主目录。
 * @returns {string[]} Windows 盘符根路径数组，或空数组。
 */
const deriveRemoteDrives = (path) => {
  const match = /^([A-Za-z]):(?:[/\\]|$)/.exec(path || '')
  return match ? [`${ match[1] }:/`] : []
}

// rAF 回调发生在重绘前，再通过宏任务让浏览器先完成 loading 绘制，然后才调用原生 SSH 接口。
const CONNECTION_LOADING_DELAY_MS = 80
/**
 * 等待一次绘制再触发原生连接调用，让 loading 状态先被用户看到。
 *
 * @returns {Promise<void>} 下一次浏览器绘制及最小 loading 展示时间结束后的 Promise。
 */
const waitForNextPaint = () => new Promise(resolve => {
  if (typeof window === 'undefined') {
    setTimeout(resolve, CONNECTION_LOADING_DELAY_MS)
    return
  }

  let fallbackTimer
  let settled = false
  const settleAfterPaint = () => {
    if (settled) return
    settled = true
    if (fallbackTimer) window.clearTimeout(fallbackTimer)
    window.setTimeout(resolve, CONNECTION_LOADING_DELAY_MS)
  }

  if (typeof window.requestAnimationFrame === 'function') {
    // 窗口最小化时部分 WebView 会暂停 rAF，兜底定时器避免连接流程被无限推迟。
    fallbackTimer = window.setTimeout(() => {
      if (!settled) {
        settled = true
        resolve()
      }
    }, CONNECTION_LOADING_DELAY_MS * 2)
    window.requestAnimationFrame(settleAfterPaint)
    return
  }
  window.setTimeout(resolve, CONNECTION_LOADING_DELAY_MS)
})

/**
 * 管理 SSH 连接、远程目录、传输、预览和会话密码生命周期。
 *
 * @param {Object} props - 文件浏览器容器属性。
 * @param {boolean} [props.showHiddenFiles=false] - 是否请求并统计以点开头的远程项目。
 * @returns {JSX.Element} 连接列表、密码弹窗或已连接的文件浏览器视图。
 */
function FileBrowserPanel({ showHiddenFiles = false }) {
  // 只把以点开头视为隐藏项目。这是各类 SSH/SFTP 服务端可稳定提供的共同语义。
  const includeHiddenFiles = showHiddenFiles === true
  // 持久化连接配置及当前进程内的临时凭据缓存。
  const [ connections, setConnections ] = useState([])
  const [ credentials, setCredentials ] = useState(new Map())
  // 当前活动连接的展示配置和 SFTP 会话 ID。
  const [ currentConnection, setCurrentConnection ] = useState(null)
  const [ currentConnectionId, setCurrentConnectionId ] = useState(null)
  // 远程文件浏览位置、列表数据及目录加载状态。
  const [ currentPath, setCurrentPath ] = useState('/')
  const [ files, setFiles ] = useState([])
  const [ loading, setLoading ] = useState(false)
  const [ error, setError ] = useState(null)
  // 远程用户主目录和可选 Windows 盘符，用于路径栏快捷定位。
  const [ homeDir, setHomeDir ] = useState('')
  const [ drives, setDrives ] = useState([])
  // 密码输入流程及连接按钮的异步状态。
  const [ passwordPrompt, setPasswordPrompt ] = useState(null)
  const [ passwordPromptError, setPasswordPromptError ] = useState('')
  const [ passwordLoading, setPasswordLoading ] = useState(false)
  const [ connectingId, setConnectingId ] = useState(null)
  // 文件预览内容、阶段、目标名称和读取进度。
  const [ preview, setPreview ] = useState(null)
  const [ previewLoading, setPreviewLoading ] = useState(false)
  const [ previewStage, setPreviewStage ] = useState('reading')
  const [ previewTargetName, setPreviewTargetName ] = useState('')
  const [ previewProgress, setPreviewProgress ] = useState(null)
  // 请求序号用于丢弃过期响应；预览 URL 用于在替换或卸载时释放 Blob 资源。
  const requestId = useRef(0)
  const previewRequestId = useRef(0)
  const previewUrlRef = useRef(null)
  // 不触发渲染的连接标记，供断线监听和异步探测判断事件是否仍属于当前会话。
  const activeConnectionIdRef = useRef(null)
  const connectingIdRef = useRef(null)
  // 为删除/重命名进度生成单调序号，避免相同毫秒时间戳导致 maskId 冲突。
  const operationStatusSequence = useRef(0)

  /**
   * 创建带 maskId 的操作状态发布器，保证过期事件不能清理新操作的状态栏。
   *
   * @param {'delete'|'rename'} operation - 当前远程变更操作类型。
   * @param {string} fileName - 进度区域展示的文件或目录名称。
   * @returns {OperationStatus} 发布开始、更新和关闭事件的操作状态对象。
   */
  const createOperationStatus = (operation, fileName) => {
    const maskId = `file-operation-${ operation }-${ Date.now() }-${ ++operationStatusSequence.current }`
    /**
     * 向共享状态栏发布当前操作的统一载荷。
     *
     * @param {number} progress - 0 到 100 的操作进度。
     * @param {string} message - 状态栏主提示文本。
     * @param {Object} [details={}] - 队列位置、阶段等附加字段。
     * @returns {void}
     */
    const publish = (progress, message, details = {}) => {
      PubSubBusinessKeyEnum.SEND_MASK({
        maskId,
        operation,
        fileName,
        progress,
        message,
        ...details
      })
    }
    return {
      start: message => publish(0, message),
      update: (progress, message, details) => publish(progress, message, details),
      dismiss: () => PubSubBusinessKeyEnum.SEND_MASK({ dismissMaskId: maskId })
    }
  }

  /**
   * 释放上一张图片预览生成的 Object URL，避免反复预览造成内存增长。
   *
   * @returns {void}
   */
  const releasePreviewUrl = useCallback(() => {
    if (!previewUrlRef.current) return
    window.URL.revokeObjectURL(previewUrlRef.current)
    previewUrlRef.current = null
  }, [])

  /**
   * 关闭预览并递增请求序号，使尚未完成的旧请求无法回写页面。
   *
   * @returns {void}
   */
  const closePreview = useCallback(() => {
    previewRequestId.current += 1
    releasePreviewUrl()
    setPreview(null)
    setPreviewTargetName('')
    setPreviewProgress(null)
    setPreviewLoading(false)
    setPreviewStage('reading')
  }, [releasePreviewUrl])

  /**
   * 清空远程视图并关闭当前连接相关的终端与缓存任务。
   *
   * @returns {void}
   */
  const resetRemoteView = useCallback(() => {
    void closeTerminalWindows().catch(() => undefined)
    activeConnectionIdRef.current = null
    requestId.current += 1
    setCurrentConnection(null)
    setCurrentConnectionId(null)
    setCurrentPath('/')
    setFiles([])
    setHomeDir('')
    setDrives([])
    setError(null)
    closePreview()
    setLoading(false)
  }, [closePreview])

  // 首次加载连接配置；配置迁移失败由上层错误边界或通知流程处理。
  useEffect(() => {
    void loadConnections()
  }, [])

  // 组件卸载时释放最后一次图片预览的 Object URL。
  useEffect(() => () => releasePreviewUrl(), [releasePreviewUrl])

  // 将当前会话 ID镜像到 ref，供不应重新订阅的异步回调读取最新值。
  useEffect(() => {
    activeConnectionIdRef.current = currentConnectionId
  }, [currentConnectionId])

  // 订阅 SFTP 管理器的意外断线事件，并仅处理当前活动会话。
  useEffect(() => sftpManager.subscribeConnectionLost(({ id, reason }) => {
    if (activeConnectionIdRef.current !== id) return
    resetRemoteView()
    void notification.error(`连接已断开：${ reason || '服务器无响应，请重新连接' }`)
  }), [resetRemoteView])

  // SSH 保活可以避免空闲 NAT 过期；主动探测也能在用户停留目录页面时
  // 及时发现服务器关闭连接。
  useEffect(() => {
    if (!currentConnectionId) return undefined
    const connectionId = currentConnectionId
    let disposed = false
    let probing = false
    /**
     * 对当前会话执行一次轻量探测；同一时间只允许一个探测在途。
     *
     * @returns {Promise<void>} 探测完成或断线清理完成后的 Promise。
     */
    const probe = async () => {
      if (disposed || probing || activeConnectionIdRef.current !== connectionId) return
      probing = true
      try {
        await sftpManager.checkConnection(connectionId)
      } catch (probeError) {
        // 探测失败本身就说明当前会话不可用，不能只依赖连接管理器是否已经更新状态。
        if (!disposed && activeConnectionIdRef.current === connectionId) {
          resetRemoteView()
          void notification.error(`连接已断开：${ normalizeError(probeError) }`)
        }
      } finally {
        probing = false
      }
    }
    const timer = window.setInterval(() => void probe(), 15_000)
    return () => {
      disposed = true
      window.clearInterval(timer)
    }
  }, [ currentConnectionId, resetRemoteView ])

  /**
   * 从持久化 Store 读取连接配置并迁移旧数据结构。
   *
   * @returns {Promise<void>} 连接状态更新和必要的数据迁移完成后的 Promise。
   */
  const loadConnections = async () => {
    const saved = await store.get(StoreKeys.SSH_CONNECTIONS)
    const profiles = Array.isArray(saved)
      ? sortProfiles(saved.map(normalizeProfile).filter(Boolean))
      : []
    setConnections(profiles)
    if (JSON.stringify(saved || []) !== JSON.stringify(profiles)) {
      await store.set(StoreKeys.SSH_CONNECTIONS, profiles)
    }
  }

  /**
   * 按最近使用时间排序后保存连接配置。
   *
   * @param {ConnectionProfile[]} profiles - 要持久化的连接配置。
   * @returns {Promise<void>} Store 和 React 状态更新完成后的 Promise。
   * @throws {Error} 当本地 Store 写入失败时抛出。
   */
  const saveConnections = async (profiles) => {
    const sorted = sortProfiles(profiles)
    await store.set(StoreKeys.SSH_CONNECTIONS, sorted)
    setConnections(sorted)
  }

  /**
   * 保存新建连接配置，并将密码仅缓存于本次进程内存。
   *
   * @param {ConnectionProfile} profile - 已通过表单校验的新连接配置。
   * @param {ConnectionCredentials} credentialsForProfile - 不会持久化的会话密码。
   * @returns {Promise<void>} 配置保存和内存凭据更新完成后的 Promise。
   * @throws {Error} 当配置持久化失败时抛出。
   */
  const handleAddConnection = async (profile, credentialsForProfile) => {
    const next = [ profile, ...connections.filter(item => item.id !== profile.id) ]
    await saveConnections(next)
    setCredentials(previous => {
      const updated = new Map(previous)
      updated.set(profile.id, { password: credentialsForProfile?.password || '' })
      return updated
    })
  }

  /**
   * 经用户确认后删除连接配置、内存密码及相关远程会话。
   *
   * @param {string} connectionId - 要删除的连接配置 ID。
   * @returns {Promise<void>} 删除或取消确认流程完成后的 Promise。
   */
  const handleDeleteConnection = async (connectionId) => {
    if (!(await confirm('删除连接配置？当前会话中的密码也会被清除。', { title: '删除连接', kind: 'warning' }))) return
    if (currentConnectionId === connectionId) await handleDisconnect({ skipConfirm: true })
    await sftpManager.removeConnection(connectionId).catch(() => undefined)
    await saveConnections(connections.filter(connection => connection.id !== connectionId))
    setCredentials(previous => {
      const updated = new Map(previous)
      updated.delete(connectionId)
      return updated
    })
    void notification.success('连接已删除')
  }

  /**
   * 合并并保存单个连接配置的字段变更。
   *
   * @param {string} connectionId - 要更新的连接配置 ID。
   * @param {Partial<ConnectionProfile>} changes - 需要覆盖的配置字段。
   * @returns {Promise<ConnectionProfile|undefined>} 更新后的配置；未找到时返回 undefined。
   * @throws {Error} 当本地 Store 写入失败时抛出。
   */
  const updateProfile = async (connectionId, changes) => {
    const next = connections.map(profile => profile.id === connectionId
      ? { ...profile, ...changes, updatedAt: new Date().toISOString() }
      : profile)
    await saveConnections(next)
    return next.find(profile => profile.id === connectionId)
  }

  /**
   * 执行连接、主机指纹确认、首个目录加载和凭据内存缓存。
   *
   * 错误会转换为用户可读通知；认证失败时会重新打开密码输入框。
   *
   * @param {ConnectionProfile} connection - 要连接的持久化配置。
   * @param {ConnectionCredentials|string} credentialsForProfile - 本次会话的密码对象或兼容旧调用的密码字符串。
   * @returns {Promise<void>} 连接成功、失败清理或重试提示完成后的 Promise。
   */
  const connectWithPassword = async (connection, credentialsForProfile) => {
    if (connectingIdRef.current) return
    connectingIdRef.current = connection.id
    // 提交凭据后立即关闭输入框，让连接列表的 loading 状态先呈现出来。
    setPasswordPrompt(null)
    setPasswordPromptError('')
    setConnectingId(connection.id)
    setPasswordLoading(true)
    setLoading(true)
    await waitForNextPaint()
    const credentialsValue = typeof credentialsForProfile === 'string'
      ? { password: credentialsForProfile }
      : { password: credentialsForProfile?.password || '' }
    let connectionId = null
    let retryMessage = ''
    try {
      connectionId = await sftpManager.createConnection({ ...connection, ...credentialsValue })
      let result = await sftpManager.connect(connectionId)

      if (result.requiresHostKeyConfirmation) {
        const accepted = await confirm(
          `首次连接 ${ connection.host } 需要确认服务器身份。\n\n服务器指纹：${ result.hostKey.fingerprint }\n算法：${ result.hostKey.algorithm }\n\n只有确认这是你的目标服务器时才信任。Portal 会保存该指纹，后续如果同一服务器指纹变化会阻止连接。`,
          { title: '确认 SSH 主机密钥', kind: 'warning', okLabel: '信任并继续', cancelLabel: '取消' }
        )
        if (!accepted) throw new Error('已取消主机密钥确认')
        await sftpManager.updateHostKey(connectionId, result.hostKey.fingerprint)
        await updateProfile(connection.id, { hostKeyFingerprint: result.hostKey.fingerprint })
        result = await sftpManager.connect(connectionId)
      }

      if (!result.connected) throw new Error('服务器连接失败')
      const home = await sftpManager.getRemoteUserHome(connectionId)
      const profile = {
        ...(connections.find(item => item.id === connection.id) || connection),
        hostKeyFingerprint: result.hostKey?.fingerprint || connection.hostKeyFingerprint
      }
      activeConnectionIdRef.current = connectionId
      setCurrentConnection(profile)
      setCurrentConnectionId(connectionId)
      setHomeDir(home || '/')
      setDrives(deriveRemoteDrives(home || '/'))
      setCurrentPath(home || '/')
      await loadRemoteDirectory(home || '/', connectionId)
      if (
        activeConnectionIdRef.current !== connectionId
        || sftpManager.getConnectionStatus(connectionId) !== SftpConnectionStatus.CONNECTED
      ) {
        throw new Error('连接已断开')
      }
      setCredentials(previous => {
        const updated = new Map(previous)
        updated.set(connection.id, credentialsValue)
        return updated
      })
      void notification.success('连接成功')
    } catch (error) {
      if (connectionId) {
        await sftpManager.removeConnection(connectionId).catch(() => undefined)
      } else {
        await sftpManager.removeConnection(connection.id).catch(() => undefined)
      }
      setCredentials(previous => {
        const updated = new Map(previous)
        updated.delete(connection.id)
        return updated
      })
      const readableError = getReadableConnectionError(error)
      retryMessage = isCredentialError(error) ? readableError : ''
      void notification.error(readableError)
    } finally {
      if (connectingIdRef.current === connection.id) {
        connectingIdRef.current = null
        setLoading(false)
        setPasswordLoading(false)
        setConnectingId(null)
      }
      if (retryMessage) {
        setPasswordPrompt(connection)
        setPasswordPromptError(retryMessage)
      } else {
        setPasswordPrompt(null)
        setPasswordPromptError('')
      }
    }
  }

  /**
   * 处理用户点击连接；没有缓存密码时先显示密码输入框。
   *
   * @param {ConnectionProfile} connection - 用户选择的连接配置。
   * @returns {Promise<void>} 密码弹窗显示或连接流程完成后的 Promise。
   */
  const handleConnect = async (connection) => {
    if (connectingId || connectingIdRef.current) return
    const credentialsValue = credentials.get(connection.id) || { password: '' }
    if (!credentialsValue.password) {
      setPasswordLoading(false)
      setPasswordPromptError('')
      setPasswordPrompt(connection)
      return
    }
    await connectWithPassword(connection, credentialsValue)
  }

  /**
   * 关闭密码输入框并清理当前认证错误状态。
   *
   * @returns {void}
   */
  const handlePasswordPromptCancel = () => {
    setPasswordPrompt(null)
    setPasswordPromptError('')
    setPasswordLoading(false)
  }

  /**
   * 提交密码输入框，并异步开始建立连接。
   *
   * @param {{password: string}} values - 密码表单提交值。
   * @returns {void}
   */
  const handlePasswordPromptSubmit = ({ password }) => {
    if (!passwordPrompt || connectingId || connectingIdRef.current) return
    const connection = passwordPrompt
    void connectWithPassword(
      connection,
      { password }
    )
  }

  /**
   * 主动断开当前连接，并清理终端、会话和远程视图状态。
   * 关闭路径会抑制重复的连接丢失提示。
   *
   * @param {{skipConfirm?: boolean}} [options={}] - 是否跳过断开确认弹窗。
   * @returns {Promise<void>} 终端、SSH 会话和远程视图清理完成后的 Promise。
   */
  const handleDisconnect = async ({ skipConfirm = false } = {}) => {
    if (currentConnectionId && !skipConfirm) {
      const accepted = await confirm(
        `确定断开与“${ currentConnection?.name || currentConnection?.host || '当前服务器' }”的连接吗？`,
        {
          title: '断开连接',
          kind: 'warning',
          okLabel: '断开',
          cancelLabel: '取消'
        }
      )
      if (!accepted) return
    }
    const connectionId = currentConnectionId
    // 用户主动断开时忽略正在传输中的连接事件；只有意外断开才显示重连提示。
    activeConnectionIdRef.current = null
    await closeTerminalWindows().catch(() => undefined)
    if (connectionId) await sftpManager.disconnect(connectionId).catch(() => undefined)
    resetRemoteView()
  }

  /**
   * 加载远程目录，并通过请求序号丢弃已经过期的响应。
   *
   * @param {string} path - 要加载的远程目录路径。
   * @param {string|null} [connectionId=currentConnectionId] - 使用的 SSH 连接 ID。
   * @returns {Promise<void>} 目录列表加载或错误状态更新完成后的 Promise。
   */
  const loadRemoteDirectory = useCallback(async (path, connectionId = currentConnectionId) => {
    if (!connectionId) {
      setError('尚未连接服务器')
      return
    }
    const normalizedPath = normalizeRemotePath(path)
    const currentRequest = ++requestId.current
    setLoading(true)
    setError(null)
    // 目录统计属于低优先级任务，切换和刷新目录时必须先让出同一条 SFTP 会话。
    sftpManager.cancelDirectorySizeRequests(connectionId, '正在切换目录')
    try {
      const result = await sftpManager.listRemoteDirectory(connectionId, normalizedPath, {
        showHiddenFiles: includeHiddenFiles
      })
      if (currentRequest !== requestId.current) return
      setFiles(result)
      setCurrentPath(normalizedPath)
    } catch (requestError) {
      if (currentRequest === requestId.current) {
        setFiles([])
        const connectionStillActive = activeConnectionIdRef.current === connectionId
        if (sftpManager.getConnectionStatus(connectionId) !== SftpConnectionStatus.CONNECTED) {
          if (connectionStillActive) {
            resetRemoteView()
            void notification.error(`连接已断开：${ normalizeError(requestError) }`)
          }
        } else if (!connectionStillActive) {
          // 连接丢失事件已经完成页面重置，忽略这次过期请求的错误。
          return
        } else {
          setError(normalizeError(requestError))
        }
      }
    } finally {
      if (currentRequest === requestId.current) setLoading(false)
    }
  }, [ currentConnectionId, includeHiddenFiles, resetRemoteView ])

  // 记录已经应用到远程列表的隐藏文件偏好，避免首次渲染重复刷新目录。
  const appliedHiddenFilesPreferenceRef = useRef(includeHiddenFiles)
  // 偏好切换后重新加载当前目录，使列表和目录大小统计使用同一过滤规则。
  useEffect(() => {
    const preferenceChanged = appliedHiddenFilesPreferenceRef.current !== includeHiddenFiles
    appliedHiddenFilesPreferenceRef.current = includeHiddenFiles
    if (!preferenceChanged || !currentConnectionId) return

    // 设置变更后重新读取当前目录；该调用也会取消旧视图的目录大小任务。
    void loadRemoteDirectory(currentPath, currentConnectionId)
  }, [ currentConnectionId, currentPath, includeHiddenFiles, loadRemoteDirectory ])

  /**
   * 处理远程路径输入框的回车提交。
   *
   * @param {React.KeyboardEvent<HTMLInputElement>} event - 路径输入框键盘事件。
   * @returns {void}
   */
  const handlePathSubmit = (event) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      void loadRemoteDirectory(event.currentTarget.value.trim() || '/')
    }
  }

  /**
   * 处理目录进入或文件预览请求；超过大小限制的文件直接提示下载。
   *
   * @param {RemoteEntry} entry - 用户点击的远程文件或目录条目。
   * @returns {Promise<void>} 目录加载、文件读取或预览状态更新完成后的 Promise。
   */
  const handleItemClick = async (entry) => {
    if (entry.isDirectory) {
      await loadRemoteDirectory(joinRemotePath(currentPath, entry.name))
      return
    }
    const descriptor = getPreviewDescriptor(entry.name)
    if (descriptor.kind === 'unsupported') {
      void notification.error(`暂不支持预览“${ entry.name }”，请下载后使用本地应用打开`)
      return
    }
    if (Number(entry.size) > MAX_PREVIEW_BYTES) {
      void notification.error(`文件超过 ${ formatFileSize(MAX_PREVIEW_BYTES) } 的预览限制，请下载后打开`)
      return
    }
    const currentPreviewRequest = ++previewRequestId.current
    const previewId = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `preview-${ Date.now() }-${ Math.random().toString(16).slice(2) }`
    releasePreviewUrl()
    setPreview(null)
    setPreviewTargetName(entry.name)
    setPreviewProgress({ current: 0, total: Number(entry.size) || 0, percent: 0 })
    setPreviewStage('reading')
    setPreviewLoading(true)
    try {
      const bytes = await sftpManager.getRemoteFileContent(
        currentConnectionId,
        joinRemotePath(currentPath, entry.name),
        previewId,
        (progress, payload) => {
          if (currentPreviewRequest !== previewRequestId.current) return
          setPreviewProgress(previous => ({
            current: Number(payload.current) || previous?.current || 0,
            total: Number(payload.total) || previous?.total || 0,
            percent: Number(progress) || 0
          }))
        }
      )
      if (currentPreviewRequest !== previewRequestId.current) return

      if (descriptor.kind === 'image') {
        const objectUrl = window.URL.createObjectURL(new window.Blob([bytes], { type: descriptor.mime }))
        previewUrlRef.current = objectUrl
        setPreview({
          kind: 'image',
          name: entry.name,
          url: objectUrl,
          mime: descriptor.mime
        })
      } else {
        const content = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
        setPreviewStage('processing')
        const jsonPreview = descriptor.language === 'json' ? await formatJsonPreviewAsync(content) : null
        const displayContent = jsonPreview?.content ?? content
        const highlighted = descriptor.kind === 'code'
          ? await highlightCode(displayContent, descriptor.language)
          : null
        if (currentPreviewRequest !== previewRequestId.current) return
        setPreview({
          kind: descriptor.kind,
          name: entry.name,
          content: displayContent,
          html: highlighted?.html,
          plainContent: highlighted?.content,
          highlighted: highlighted?.highlighted,
          language: descriptor.language,
          formattedJson: jsonPreview?.formatted || false
        })
      }
    } catch (previewError) {
      if (currentPreviewRequest === previewRequestId.current) {
        void notification.error(`预览失败：${ normalizeError(previewError) }`)
      }
    } finally {
      if (currentPreviewRequest === previewRequestId.current) {
        setPreviewLoading(false)
        setPreviewProgress(null)
        setPreviewStage('reading')
      }
    }
  }

  /**
   * 返回当前远程目录的父目录。
   *
   * @returns {void}
   */
  const handleGoBack = () => {
    if (currentPath === '/' || !currentConnectionId) return
    void loadRemoteDirectory(parentRemotePath(currentPath))
  }

  /**
   * 重新读取当前远程目录。
   *
   * @returns {void}
   */
  const handleRefresh = () => void loadRemoteDirectory(currentPath)

  /**
   * 在当前远程目录创建子目录并刷新列表。
   *
   * @param {string} name - 已通过界面校验的新目录名称。
   * @returns {Promise<void>} 目录创建和当前列表刷新完成后的 Promise。
   * @throws {Error} 当远程目录创建或列表刷新失败时抛出。
   */
  const handleCreateDirectory = async (name) => {
    const targetPath = joinRemotePath(currentPath, name)
    await sftpManager.createRemoteDirectory(currentConnectionId, targetPath)
    await loadRemoteDirectory(currentPath)
  }

  /**
   * 批量下载选中的远程项目，逐项处理覆盖确认并发布进度。
   *
   * @param {RemoteEntry[]} entries - 要下载的远程文件或目录条目。
   * @param {() => void} [onConfirmed] - 用户确认下载后调用的回调。
   * @returns {Promise<boolean>} 全部项目成功下载时返回 true，否则返回 false。
   */
  const handleDownloadItems = async (entries, onConfirmed) => {
    if (!Array.isArray(entries) || entries.length < 2) return false

    let downloadPath
    try {
      downloadPath = await resolveDownloadPath()
      if (!downloadPath) return false
    } catch (error) {
      void notification.error(`下载失败：${ normalizeError(error) }`)
      return false
    }

    const previewNames = entries.slice(0, 3).map(entry => entry.name).join('、')
    const omittedCount = entries.length - Math.min(entries.length, 3)
    const accepted = await confirm(
      `确定下载选中的 ${ entries.length } 个项目吗？\n\n${ previewNames }${ omittedCount > 0 ? ` 等 ${ omittedCount } 项` : '' }\n\n保存到：${ downloadPath }`,
      {
        title: '确认批量下载',
        kind: 'warning',
        okLabel: '下载全部',
        cancelLabel: '取消'
      }
    )
    if (!accepted) return false
    onConfirmed?.()

    const failedEntries = []
    let downloadedCount = 0
    let skippedCount = 0
    let transferId = null
    let cancelled = false
    /**
     * 把单项下载回调转换为批量队列状态栏可消费的进度载荷。
     *
     * @param {number} progress - 当前文件进度百分比。
     * @param {RemoteEntry} entry - 当前队列中的远程项目。
     * @param {number} queueIndex - 当前项目在批量队列中的索引。
     * @param {Object} [payload={}] - 目录下载返回的文件级进度信息。
     * @returns {void}
     */
    const publishProgress = (progress, entry, queueIndex, payload = {}) => {
      const isDirectoryDownload = Boolean(entry.isDirectory)
      const fileIndex = Number(payload.fileIndex)
      const fileTotal = Number(payload.fileTotal)
      PubSubBusinessKeyEnum.SEND_MASK({
        progress: Math.round(Number(progress) || 0),
        fileName: isDirectoryDownload ? (payload.fileName || entry.name) : entry.name,
        operation: isDirectoryDownload ? 'download-directory' : 'download',
        queueIndex,
        queueTotal: entries.length,
        pendingCount: Math.max(entries.length - queueIndex - 1, 0),
        folderQueueIndex: Number.isFinite(fileIndex) ? fileIndex : undefined,
        folderQueueTotal: Number.isFinite(fileTotal) ? fileTotal : undefined,
        overallProgress: Number.isFinite(Number(payload.overallProgress))
          ? Number(payload.overallProgress)
          : undefined,
        onCancel: transferId ? () => sftpManager.cancelTransfer(transferId) : undefined
      })
    }
    /**
     * 下载队列中的单个项目，并在结束时清空可取消的传输 ID。
     *
     * @param {RemoteEntry} entry - 要下载的远程项目。
     * @param {number} queueIndex - 项目在队列中的索引。
     * @param {boolean} overwrite - 是否覆盖已存在的本地目标。
     * @returns {Promise<void>} 单项下载完成后的 Promise。
     */
    const downloadOne = async (entry, queueIndex, overwrite) => {
      transferId = null
      const remotePath = joinRemotePath(currentPath, entry.name)
      const localPath = joinLocalPath(downloadPath, entry.name)
      publishProgress(0, entry, queueIndex)
      try {
        const download = entry.isDirectory
          ? sftpManager.downloadDirectory.bind(sftpManager)
          : sftpManager.downloadFile.bind(sftpManager)
        await download(
          currentConnectionId,
          remotePath,
          localPath,
          (progress, payload) => publishProgress(progress, entry, queueIndex, payload),
          overwrite,
          id => {
            transferId = id
            publishProgress(0, entry, queueIndex)
          }
        )
      } finally {
        transferId = null
      }
    }

    try {
      for (const [ queueIndex, entry ] of entries.entries()) {
        if (sftpManager.getConnectionStatus(currentConnectionId) !== SftpConnectionStatus.CONNECTED) break
        try {
          await downloadOne(entry, queueIndex, false)
          downloadedCount += 1
          continue
        } catch (downloadError) {
          const message = normalizeError(downloadError)
          if (!message.includes('已存在')) {
            failedEntries.push({ entry, error: message })
            cancelled = message.includes('传输已取消')
            if (cancelled || sftpManager.getConnectionStatus(currentConnectionId) !== SftpConnectionStatus.CONNECTED) break
            continue
          }

          const itemLabel = entry.isDirectory ? '文件夹' : '文件'
          const overwriteAccepted = await confirm(
            `本地${ itemLabel }已存在：\n${ joinLocalPath(downloadPath, entry.name) }\n${ entry.isDirectory ? '是否合并并覆盖其中的文件？' : '是否覆盖？' }`,
            {
              title: '确认覆盖',
              kind: 'warning',
              okLabel: entry.isDirectory ? '合并并覆盖' : '覆盖',
              cancelLabel: '跳过'
            }
          )
          if (!overwriteAccepted) {
            skippedCount += 1
            continue
          }
          try {
            await downloadOne(entry, queueIndex, true)
            downloadedCount += 1
          } catch (retryError) {
            const retryMessage = normalizeError(retryError)
            failedEntries.push({ entry, error: retryMessage })
            cancelled = retryMessage.includes('传输已取消')
            if (cancelled || sftpManager.getConnectionStatus(currentConnectionId) !== SftpConnectionStatus.CONNECTED) break
          }
        }
      }
    } finally {
      transferId = null
      PubSubBusinessKeyEnum.SEND_MASK(null)
    }

    if (cancelled || sftpManager.getConnectionStatus(currentConnectionId) !== SftpConnectionStatus.CONNECTED) {
      return false
    }
    if (failedEntries.length === 0 && skippedCount === 0 && downloadedCount === entries.length) {
      void notification.success(`已下载 ${ entries.length } 个项目`)
      return true
    }
    const failedNames = failedEntries.map(item => item.entry.name).join('、')
    const summary = `已下载 ${ downloadedCount } 个项目${ skippedCount > 0 ? `，跳过 ${ skippedCount } 个` : '' }${ failedEntries.length > 0 ? `，${ failedEntries.length } 个失败` : '' }`
    const summaryMessage = `${ summary }${ failedNames ? `：${ failedNames }` : '' }`
    if (failedEntries.length > 0) {
      void notification.error(summaryMessage)
    } else {
      void notification.success(summaryMessage)
    }
    return false
  }

  /**
   * 删除一个远程项目，并将递归删除进度映射到共享操作状态栏。
   *
   * @param {RemoteEntry} entry - 要删除的远程文件或目录条目。
   * @param {OperationStatus} status - 发布删除进度的操作状态对象。
   * @param {{queueIndex?: number, queueTotal?: number, showBatchPosition?: boolean}} [options={}] - 批量删除进度配置。
   * @returns {Promise<void>} 远程删除任务完成后的 Promise。
   * @throws {Error} 当远程删除失败或连接不可用时抛出。
   */
  const deleteRemoteEntry = async (entry, status, options = {}) => {
    const {
      queueIndex = 0,
      queueTotal = 1,
      showBatchPosition = false
    } = options
    await sftpManager.deleteRemoteItem(
      currentConnectionId,
      joinRemotePath(currentPath, entry.name),
      entry.isDirectory,
      (progress, payload = {}) => {
        const itemTotal = Number(payload.itemTotal) || 0
        const itemIndex = Number(payload.itemIndex) || 0
        const phase = payload.phase || 'deleting'
        const currentItem = payload.fileName || entry.name
        let operationMessage = itemTotal > 0 ? '正在删除文件...' : '正在删除...'
        if (phase === 'scanning') operationMessage = '正在扫描文件夹...'
        if (phase === 'cleaning') operationMessage = '正在清理文件夹...'
        if (showBatchPosition && itemTotal > 0) {
          operationMessage += ` (${ Math.min(itemIndex + 1, itemTotal) }/${ itemTotal })`
        }
        status.update(
          Math.round(Number(progress) || 0),
          showBatchPosition
            ? `第 ${ queueIndex + 1 }/${ queueTotal } 项：${ operationMessage }`
            : operationMessage,
          {
            phase,
            fileName: currentItem,
            queueIndex: showBatchPosition
              ? queueIndex
              : (itemTotal > 0 ? Math.min(itemIndex, itemTotal - 1) : 0),
            queueTotal: showBatchPosition ? queueTotal : (itemTotal > 0 ? itemTotal : 1),
            pendingCount: showBatchPosition
              ? Math.max(queueTotal - queueIndex - 1, 0)
              : (itemTotal > 0 ? Math.max(itemTotal - itemIndex - 1, 0) : 0)
          }
        )
      }
    )
  }

  /**
   * 询问确认后删除单个远程项目，并刷新当前目录。
   *
   * @param {RemoteEntry} entry - 要删除的远程文件或目录条目。
   * @returns {Promise<void>} 删除、刷新和通知处理完成后的 Promise。
   */
  const handleDeleteItem = async (entry) => {
    const description = entry.isDirectory
      ? `确定删除文件夹“${ entry.name }”及其所有内容吗？此操作无法撤销。`
      : `确定删除“${ entry.name }”吗？`
    const accepted = await confirm(description, {
      title: '删除远程项目',
      kind: 'warning',
      okLabel: '删除',
      cancelLabel: '取消'
    })
    if (!accepted) return

    const status = createOperationStatus('delete', entry.name)
    status.start(entry.isDirectory ? '正在删除文件夹及其内容...' : '正在删除文件...')
    try {
      await deleteRemoteEntry(entry, status)
      status.update(92, '正在刷新目录...', { phase: 'refreshing' })
      await loadRemoteDirectory(currentPath)
      void notification.success('已删除')
    } catch (deleteError) {
      const message = normalizeError(deleteError)
      void notification.error(`删除失败：${ message }`)
    } finally {
      status.dismiss()
    }
  }

  /**
   * 询问确认后批量删除远程项目，并汇总成功与失败结果。
   *
   * @param {RemoteEntry[]} entries - 要删除的远程文件或目录条目。
   * @param {() => void} [onConfirmed] - 用户确认删除后调用的回调。
   * @returns {Promise<boolean>} 全部项目删除成功时返回 true，否则返回 false。
   */
  const handleDeleteItems = async (entries, onConfirmed) => {
    if (!Array.isArray(entries) || entries.length < 2) return false
    const previewNames = entries.slice(0, 3).map(entry => entry.name).join('、')
    const omittedCount = entries.length - Math.min(entries.length, 3)
    const accepted = await confirm(
      `确定删除选中的 ${ entries.length } 个项目吗？\n\n${ previewNames }${ omittedCount > 0 ? ` 等 ${ omittedCount } 项` : '' }\n\n文件夹及其内容也会被删除，此操作无法撤销。`,
      {
        title: '批量删除远程项目',
        kind: 'warning',
        okLabel: '删除全部',
        cancelLabel: '取消'
      }
    )
    if (!accepted) return false
    onConfirmed?.()

    const status = createOperationStatus('delete', `${ entries.length } 个项目`)
    status.start(`正在删除 ${ entries.length } 个项目...`)
    const failedEntries = []
    let deletedCount = 0
    try {
      for (const [ queueIndex, entry ] of entries.entries()) {
        if (sftpManager.getConnectionStatus(currentConnectionId) !== SftpConnectionStatus.CONNECTED) break
        try {
          await deleteRemoteEntry(entry, status, {
            queueIndex,
            queueTotal: entries.length,
            showBatchPosition: true
          })
          deletedCount += 1
        } catch (deleteError) {
          failedEntries.push({ entry, error: normalizeError(deleteError) })
          if (sftpManager.getConnectionStatus(currentConnectionId) !== SftpConnectionStatus.CONNECTED) break
        }
      }

      if (sftpManager.getConnectionStatus(currentConnectionId) !== SftpConnectionStatus.CONNECTED) {
        return false
      }
      status.update(92, '正在刷新目录...', {
        phase: 'refreshing',
        queueIndex: entries.length,
        queueTotal: entries.length,
        pendingCount: 0
      })
      await loadRemoteDirectory(currentPath)
      if (failedEntries.length === 0 && deletedCount === entries.length) {
        void notification.success(`已删除 ${ entries.length } 个项目`)
        return true
      }
      const failedNames = failedEntries.map(item => item.entry.name).join('、')
      void notification.error(`已删除 ${ deletedCount } 个项目，${ failedEntries.length } 个失败${ failedNames ? `：${ failedNames }` : '' }`)
      return false
    } finally {
      status.dismiss()
    }
  }

  /**
   * 重命名远程项目并刷新当前目录；目录大小缓存由管理器统一失效。
   *
   * @param {RemoteEntry} entry - 待重命名的远程文件或目录条目。
   * @param {string} name - 用户输入的新名称。
   * @returns {Promise<void>} 重命名和目录刷新完成后的 Promise。
   * @throws {Error} 当名称无效或远程重命名失败时抛出。
   */
  const handleRenameItem = async (entry, name) => {
    const trimmedName = name.trim()
    if (!trimmedName || trimmedName === entry.name) return
    const status = createOperationStatus('rename', `${ entry.name } -> ${ trimmedName }`)
    status.start('正在重命名...')
    try {
      await sftpManager.renameRemoteItem(
        currentConnectionId,
        joinRemotePath(currentPath, entry.name),
        joinRemotePath(currentPath, trimmedName)
      )
      status.update(82, '正在刷新目录...')
      await loadRemoteDirectory(currentPath)
      void notification.success('已重命名')
    } catch (renameError) {
      // 保持弹窗打开，让用户修正名称或重新尝试。
      throw renameError
    } finally {
      status.dismiss()
    }
  }

  /**
   * 按预览描述符渲染图片、文本、代码或加载状态。
   *
   * @returns {JSX.Element|null} 当前预览内容；没有预览时返回 null。
   */
  const renderPreviewContent = () => {
    if (previewLoading) {
      const current = previewProgress?.current || 0
      const total = previewProgress?.total || 0
      const percent = previewProgress?.percent || 0
      return (
        <div className="preview-loading">
          <span>{previewStage === 'processing' ? '正在整理预览...' : '正在读取文件...'}</span>
          <Progress
            className="preview-progress"
            percent={total > 0 ? percent : 0}
            status="active"
            showInfo={false}
          />
          <div className="preview-progress-meta">
            <span>{total > 0 ? `${ formatFileSize(current) } / ${ formatFileSize(total) }` : '正在建立传输通道'}</span>
            {total > 0 && <span>{percent}%</span>}
          </div>
        </div>
      )
    }
    if (!preview) return null
    if (preview.kind === 'image') {
      return (
        <div className="image-preview-shell">
          <img className="image-preview" src={preview.url} alt={preview.name} />
        </div>
      )
    }
    if (preview.kind === 'code') {
      return (
        <>
          {!preview.highlighted && (
            <div className="preview-note">
              {preview.formattedJson ? 'JSON 已格式化显示；文件较大，已关闭语法高亮以保持流畅。' : '文件较大或语法规则不可用，已关闭语法高亮。'}
            </div>
          )}
          {/* 大文件未高亮时直接渲染文本，避免额外构造 HTML。 */}
          {preview.highlighted ? (
            <pre
              className="file-preview code-preview"
              dangerouslySetInnerHTML={{ __html: preview.html || '' }}
            />
          ) : (
            <pre className="file-preview code-preview">{preview.plainContent ?? preview.content}</pre>
          )}
        </>
      )
    }
    return <pre className="file-preview">{preview.content}</pre>
  }

  if (currentConnectionId && currentConnection) {
    return (
      <>
        <FileBrowser
          currentPath={currentPath}
          files={files}
          loading={loading}
          error={error}
          currentConnection={currentConnection}
          currentConnectionId={currentConnectionId}
          showHiddenFiles={includeHiddenFiles}
          homeDir={homeDir}
          drives={drives}
          handleGoBack={handleGoBack}
          handlePathChange={event => setCurrentPath(event.target.value)}
          handlePathSubmit={handlePathSubmit}
          handleRefresh={handleRefresh}
          handleItemClick={handleItemClick}
          handleCreateDirectory={handleCreateDirectory}
          handleDeleteItem={handleDeleteItem}
          handleDeleteItems={handleDeleteItems}
          handleDownloadItems={handleDownloadItems}
          handleRenameItem={handleRenameItem}
          handleDriveSelect={path => void loadRemoteDirectory(path)}
          handleDisconnect={handleDisconnect}
        />
        <Modal
          rootClassName="compact-modal preview-modal"
          title={`预览：${ preview?.name || previewTargetName || '' }`}
          open={Boolean(preview) || previewLoading}
          onCancel={closePreview}
          footer={null}
          width="min(900px, calc(100vw - 32px))"
          destroyOnHidden
        >
          {renderPreviewContent()}
        </Modal>
        <PasswordPromptModal
          visible={Boolean(passwordPrompt)}
          connection={passwordPrompt}
          loading={passwordLoading}
          errorMessage={passwordPromptError}
          onCancel={handlePasswordPromptCancel}
          onSubmit={handlePasswordPromptSubmit}
        />
      </>
    )
  }

  return (
    <>
      <ConnectionList
        connections={connections}
        handleConnect={handleConnect}
        handleDeleteConnection={handleDeleteConnection}
        onAddSuccess={handleAddConnection}
        connectingId={connectingId}
      />
      <PasswordPromptModal
        visible={Boolean(passwordPrompt)}
        connection={passwordPrompt}
        loading={passwordLoading}
        errorMessage={passwordPromptError}
        onCancel={handlePasswordPromptCancel}
        onSubmit={handlePasswordPromptSubmit}
      />
    </>
  )
}

export default FileBrowserPanel
