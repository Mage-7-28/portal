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

const sortProfiles = (profiles) => [...profiles].sort((a, b) => new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt))

const normalizeRemotePath = (path) => {
  const normalized = String(path || '/').trim().replaceAll('\\', '/')
  const driveOnly = /^([A-Za-z]):$/.exec(normalized)
  if (driveOnly) return `${ driveOnly[1] }:/`
  return normalized || '/'
}

const joinRemotePath = (base, name) => {
  const normalizedBase = normalizeRemotePath(base)
  if (normalizedBase === '/') return `/${ name }`
  return `${ normalizedBase.replace(/\/+$/, '') }/${ name }`
}

const parentRemotePath = (path) => {
  const normalized = normalizeRemotePath(path)
  if (normalized === '/') return '/'
  if (/^[A-Za-z]:\/?$/.test(normalized)) return normalized.slice(0, 2) + '/'
  const withoutTrailingSlash = normalized.replace(/\/+$/, '')
  const parent = withoutTrailingSlash.slice(0, withoutTrailingSlash.lastIndexOf('/'))
  if (/^[A-Za-z]:$/.test(parent)) return `${ parent }/`
  return parent || '/'
}

const deriveRemoteDrives = (path) => {
  const match = /^([A-Za-z]):(?:[/\\]|$)/.exec(path || '')
  return match ? [`${ match[1] }:/`] : []
}

// rAF 回调发生在重绘前，再通过宏任务让浏览器先完成 loading 绘制，然后才调用原生 SSH 接口。
const CONNECTION_LOADING_DELAY_MS = 80
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

function FileBrowserPanel({ showHiddenFiles = false }) {
  // 只把以点开头视为隐藏项目。这是各类 SSH/SFTP 服务端可稳定提供的共同语义。
  const includeHiddenFiles = showHiddenFiles === true
  const [ connections, setConnections ] = useState([])
  const [ credentials, setCredentials ] = useState(new Map())
  const [ currentConnection, setCurrentConnection ] = useState(null)
  const [ currentConnectionId, setCurrentConnectionId ] = useState(null)
  const [ currentPath, setCurrentPath ] = useState('/')
  const [ files, setFiles ] = useState([])
  const [ loading, setLoading ] = useState(false)
  const [ error, setError ] = useState(null)
  const [ homeDir, setHomeDir ] = useState('')
  const [ drives, setDrives ] = useState([])
  const [ passwordPrompt, setPasswordPrompt ] = useState(null)
  const [ passwordPromptError, setPasswordPromptError ] = useState('')
  const [ passwordLoading, setPasswordLoading ] = useState(false)
  const [ connectingId, setConnectingId ] = useState(null)
  const [ preview, setPreview ] = useState(null)
  const [ previewLoading, setPreviewLoading ] = useState(false)
  const [ previewStage, setPreviewStage ] = useState('reading')
  const [ previewTargetName, setPreviewTargetName ] = useState('')
  const [ previewProgress, setPreviewProgress ] = useState(null)
  const requestId = useRef(0)
  const previewRequestId = useRef(0)
  const previewUrlRef = useRef(null)
  const activeConnectionIdRef = useRef(null)
  const connectingIdRef = useRef(null)
  const operationStatusSequence = useRef(0)

  const createOperationStatus = (operation, fileName) => {
    const maskId = `file-operation-${ operation }-${ Date.now() }-${ ++operationStatusSequence.current }`
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

  const releasePreviewUrl = useCallback(() => {
    if (!previewUrlRef.current) return
    window.URL.revokeObjectURL(previewUrlRef.current)
    previewUrlRef.current = null
  }, [])

  const closePreview = useCallback(() => {
    previewRequestId.current += 1
    releasePreviewUrl()
    setPreview(null)
    setPreviewTargetName('')
    setPreviewProgress(null)
    setPreviewLoading(false)
    setPreviewStage('reading')
  }, [releasePreviewUrl])

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

  useEffect(() => {
    void loadConnections()
  }, [])

  useEffect(() => () => releasePreviewUrl(), [releasePreviewUrl])

  useEffect(() => {
    activeConnectionIdRef.current = currentConnectionId
  }, [currentConnectionId])

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

  const saveConnections = async (profiles) => {
    const sorted = sortProfiles(profiles)
    await store.set(StoreKeys.SSH_CONNECTIONS, sorted)
    setConnections(sorted)
  }

  const handleAddConnection = async (profile, credentialsForProfile) => {
    const next = [ profile, ...connections.filter(item => item.id !== profile.id) ]
    await saveConnections(next)
    setCredentials(previous => {
      const updated = new Map(previous)
      updated.set(profile.id, { password: credentialsForProfile?.password || '' })
      return updated
    })
  }

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

  const updateProfile = async (connectionId, changes) => {
    const next = connections.map(profile => profile.id === connectionId
      ? { ...profile, ...changes, updatedAt: new Date().toISOString() }
      : profile)
    await saveConnections(next)
    return next.find(profile => profile.id === connectionId)
  }

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

  const handlePasswordPromptCancel = () => {
    setPasswordPrompt(null)
    setPasswordPromptError('')
    setPasswordLoading(false)
  }

  const handlePasswordPromptSubmit = ({ password }) => {
    if (!passwordPrompt || connectingId || connectingIdRef.current) return
    const connection = passwordPrompt
    void connectWithPassword(
      connection,
      { password }
    )
  }

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

  const appliedHiddenFilesPreferenceRef = useRef(includeHiddenFiles)
  useEffect(() => {
    const preferenceChanged = appliedHiddenFilesPreferenceRef.current !== includeHiddenFiles
    appliedHiddenFilesPreferenceRef.current = includeHiddenFiles
    if (!preferenceChanged || !currentConnectionId) return

    // 设置变更后重新读取当前目录；该调用也会取消旧视图的目录大小任务。
    void loadRemoteDirectory(currentPath, currentConnectionId)
  }, [ currentConnectionId, currentPath, includeHiddenFiles, loadRemoteDirectory ])

  const handlePathSubmit = (event) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      void loadRemoteDirectory(event.currentTarget.value.trim() || '/')
    }
  }

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

  const handleGoBack = () => {
    if (currentPath === '/' || !currentConnectionId) return
    void loadRemoteDirectory(parentRemotePath(currentPath))
  }

  const handleRefresh = () => void loadRemoteDirectory(currentPath)

  const handleCreateDirectory = async (name) => {
    const targetPath = joinRemotePath(currentPath, name)
    await sftpManager.createRemoteDirectory(currentConnectionId, targetPath)
    await loadRemoteDirectory(currentPath)
  }

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
