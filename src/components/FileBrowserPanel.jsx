import React, { useEffect, useRef, useState } from 'react'
import { confirm } from '@tauri-apps/plugin-dialog'
import { Modal } from 'antd'
import toast from 'react-hot-toast'
import { store } from '../utils/storeUtils.js'
import sftpManager from '../utils/sftpUtils.js'
import { StoreKeys, msgBoxStyle, normalizeError } from '../utils/constants.js'
import FileBrowser from './FileBrowser.jsx'
import ConnectionList from './ConnectionList.jsx'
import PasswordPromptModal from './PasswordPromptModal.jsx'

const normalizeProfile = (profile, index) => {
  if (!profile || typeof profile !== 'object' || !profile.host || !profile.username) return null
  return {
    id: profile.id || `legacy-${ profile.host }-${ profile.port || 22 }-${ profile.username }-${ index }`,
    name: profile.name || `${ profile.username }@${ profile.host }`,
    host: profile.host,
    port: Number(profile.port) || 22,
    username: profile.username,
    authMethod: profile.authMethod || 'password',
    privateKeyPath: profile.privateKeyPath || null,
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

function FileBrowserPanel() {
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
  const [ passwordLoading, setPasswordLoading ] = useState(false)
  const [ connectingId, setConnectingId ] = useState(null)
  const [ preview, setPreview ] = useState(null)
  const [ previewLoading, setPreviewLoading ] = useState(false)
  const requestId = useRef(0)

  useEffect(() => {
    void loadConnections()
  }, [])

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
      updated.set(profile.id, credentialsForProfile || { password: '', passphrase: '' })
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
    toast.success('连接已删除', { id: 'msgBoxGlobal', style: msgBoxStyle })
  }

  const updateProfile = async (connectionId, changes) => {
    const next = connections.map(profile => profile.id === connectionId
      ? { ...profile, ...changes, updatedAt: new Date().toISOString() }
      : profile)
    await saveConnections(next)
    return next.find(profile => profile.id === connectionId)
  }

  const connectWithPassword = async (connection, credentialsForProfile) => {
    setConnectingId(connection.id)
    setPasswordLoading(true)
    setLoading(true)
    const credentialsValue = typeof credentialsForProfile === 'string'
      ? { password: credentialsForProfile, passphrase: '' }
      : (credentialsForProfile || { password: '', passphrase: '' })
    try {
      setCredentials(previous => {
        const updated = new Map(previous)
        updated.set(connection.id, credentialsValue)
        return updated
      })
      const connectionId = await sftpManager.createConnection({ ...connection, ...credentialsValue })
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
      setCurrentConnection(profile)
      setCurrentConnectionId(connectionId)
      setHomeDir(home || '/')
      setDrives(deriveRemoteDrives(home || '/'))
      setCurrentPath(home || '/')
      await loadRemoteDirectory(home || '/', connectionId)
      toast.success('连接成功', { id: 'msgBoxGlobal', style: msgBoxStyle })
      setPasswordPrompt(null)
    } catch (error) {
      await sftpManager.removeConnection(connection.id).catch(() => undefined)
      toast.error(`连接失败：${ normalizeError(error) }`, { id: 'msgBoxGlobal', style: msgBoxStyle })
    } finally {
      setLoading(false)
      setPasswordLoading(false)
      setConnectingId(null)
    }
  }

  const handleConnect = async (connection) => {
    if (connectingId) return
    setConnectingId(connection.id)
    const credentialsValue = credentials.get(connection.id) || { password: '', passphrase: '' }
    if ((connection.authMethod === 'password' && !credentialsValue.password)
      || (connection.authMethod === 'key' && !credentials.has(connection.id))) {
      setConnectingId(null)
      setPasswordPrompt(connection)
      return
    }
    await connectWithPassword(connection, credentialsValue)
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
    requestId.current += 1
    if (currentConnectionId) await sftpManager.disconnect(currentConnectionId).catch(() => undefined)
    setCurrentConnection(null)
    setCurrentConnectionId(null)
    setCurrentPath('/')
    setFiles([])
    setHomeDir('')
    setDrives([])
    setError(null)
    setPreview(null)
    setPreviewLoading(false)
    setLoading(false)
  }

  const loadRemoteDirectory = async (path, connectionId = currentConnectionId) => {
    if (!connectionId) {
      setError('尚未连接服务器')
      return
    }
    const normalizedPath = normalizeRemotePath(path)
    const currentRequest = ++requestId.current
    setLoading(true)
    setError(null)
    try {
      const result = await sftpManager.listRemoteDirectory(connectionId, normalizedPath)
      if (currentRequest !== requestId.current) return
      setFiles(result)
      setCurrentPath(normalizedPath)
    } catch (requestError) {
      if (currentRequest === requestId.current) {
        setFiles([])
        setError(normalizeError(requestError))
      }
    } finally {
      if (currentRequest === requestId.current) setLoading(false)
    }
  }

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
    setPreviewLoading(true)
    try {
      const bytes = await sftpManager.getRemoteFileContent(currentConnectionId, joinRemotePath(currentPath, entry.name))
      const content = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
      setPreview({ name: entry.name, content })
    } catch (previewError) {
      toast.error(`预览失败：${ normalizeError(previewError) }`, { id: 'msgBoxGlobal', style: msgBoxStyle })
    } finally {
      setPreviewLoading(false)
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

  const handleDeleteItem = async (entry) => {
    const accepted = await confirm(`确定删除“${ entry.name }”吗？`, {
      title: '删除远程项目',
      kind: 'warning',
      okLabel: '删除',
      cancelLabel: '取消'
    })
    if (!accepted) return
    await sftpManager.deleteRemoteItem(currentConnectionId, joinRemotePath(currentPath, entry.name), entry.isDirectory)
    await loadRemoteDirectory(currentPath)
    toast.success('已删除', { id: 'msgBoxGlobal', style: msgBoxStyle })
  }

  const handleRenameItem = async (entry, name) => {
    const trimmedName = name.trim()
    if (!trimmedName || trimmedName === entry.name) return
    await sftpManager.renameRemoteItem(
      currentConnectionId,
      joinRemotePath(currentPath, entry.name),
      joinRemotePath(currentPath, trimmedName)
    )
    await loadRemoteDirectory(currentPath)
    toast.success('已重命名', { id: 'msgBoxGlobal', style: msgBoxStyle })
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
          homeDir={homeDir}
          drives={drives}
          handleGoBack={handleGoBack}
          handlePathChange={event => setCurrentPath(event.target.value)}
          handlePathSubmit={handlePathSubmit}
          handleRefresh={handleRefresh}
          handleItemClick={handleItemClick}
          handleCreateDirectory={handleCreateDirectory}
          handleDeleteItem={handleDeleteItem}
          handleRenameItem={handleRenameItem}
          handleDriveSelect={path => void loadRemoteDirectory(path)}
          handleDisconnect={handleDisconnect}
        />
        <Modal
          title={`预览：${ preview?.name || '' }`}
          open={Boolean(preview) || previewLoading}
          onCancel={() => setPreview(null)}
          footer={null}
          width="min(900px, calc(100vw - 32px))"
          destroyOnHidden
        >
          {previewLoading ? '读取中...' : <pre className="file-preview">{preview?.content}</pre>}
        </Modal>
        <PasswordPromptModal
          visible={Boolean(passwordPrompt)}
          connection={passwordPrompt}
          loading={passwordLoading}
          onCancel={() => setPasswordPrompt(null)}
          onSubmit={({ password }) => passwordPrompt && connectWithPassword(
            passwordPrompt,
            passwordPrompt.authMethod === 'key' ? { passphrase: password } : { password }
          )}
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
        onCancel={() => setPasswordPrompt(null)}
        onSubmit={({ password }) => passwordPrompt && connectWithPassword(
          passwordPrompt,
          passwordPrompt.authMethod === 'key' ? { passphrase: password } : { password }
        )}
      />
    </>
  )
}

export default FileBrowserPanel
