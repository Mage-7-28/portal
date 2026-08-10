/**
 * 远程文件列表项。
 * 负责单项预览、下载、重命名、删除和可见范围内的目录大小统计。
 */
import React, { useEffect, useRef, useState } from 'react'
import { Button, Input, List, Modal, Spin, Tooltip } from 'antd'
import AppIcon from './AppIcon'
import { resolveFileIcon } from '../utils/fileIconUtils.js'
import { confirm } from '@tauri-apps/plugin-dialog'
import { formatFileSize, PubSubBusinessKeyEnum } from '../utils/common'
import sftpManager from '../utils/sftpUtils'
import { notification } from '../utils/notificationUtils'
import { joinLocalPath, resolveDownloadPath } from '../utils/downloadUtils.js'

/**
 * 拼接远程 POSIX 风格路径，避免重复分隔符影响 SFTP 调用。
 *
 * @param {string} base - 当前远程目录路径。
 * @param {string} name - 要追加的文件或目录名称。
 * @returns {string} 规范化后的远程子路径。
 */
const joinRemotePath = (base, name) => `${ base.replace(/\/+$/, '') || '' }/${ name }` || `/${ name }`

/**
 * 将 Rust 返回的目录大小统一为可展示的聚合结果。
 *
 * @param {number|Object} result - Rust 返回的旧版数字结果或统计对象。
 * @returns {{size: number, complete: boolean, inaccessibleCount: number, scannedEntries: number}} 规范化统计结果。
 * @throws {Error} 当结果不是非负有限大小时抛出。
 */
const normalizeDirectorySizeResult = (result) => {
  const size = Number(typeof result === 'object' ? result?.size : result)
  if (!Number.isFinite(size) || size < 0) throw new Error('目录大小无效')
  return {
    size,
    complete: result?.complete !== false,
    inaccessibleCount: Math.max(0, Math.trunc(Number(result?.inaccessibleCount) || 0)),
    scannedEntries: Math.max(0, Math.trunc(Number(result?.scannedEntries) || 0))
  }
}

/**
 * 为权限不足或目录已变化的非完整统计生成可解释提示。
 *
 * @param {Object} details - 部分统计信息。
 * @param {number} details.inaccessibleCount - 无法访问的子目录数。
 * @param {number} details.scannedEntries - 已扫描的目录条目数。
 * @returns {string} 适合 Tooltip 展示的部分统计说明。
 */
const getPartialDirectorySizeHint = ({ inaccessibleCount, scannedEntries }) => {
  const inaccessibleHint = inaccessibleCount > 0
    ? `${ inaccessibleCount } 个子目录无法读取`
    : '部分子目录无法读取'
  const scannedHint = scannedEntries > 0 ? `，已扫描 ${ scannedEntries } 项` : ''
  return `已统计可访问项目；${ inaccessibleHint }，实际大小可能更大${ scannedHint }`
}

/**
 * 渲染远程文件列表中的单项，并按需统计目录大小。
 *
 * @param {Object} props - 文件项属性。
 * @param {{name: string, path?: string, isDirectory: boolean, size?: number, modifiedAt?: number}} props.entry - 远程条目数据。
 * @param {string} props.currentPath - 当前远程目录路径。
 * @param {string} props.connectionId - 当前 SSH 连接 ID。
 * @param {boolean} [props.showHiddenFiles=false] - 是否按显示隐藏文件设置统计目录大小。
 * @param {boolean} props.selected - 当前条目是否被选中。
 * @param {(entry: Object, event: Object) => void} props.onSelect - 条目选中回调。
 * @param {() => void} props.onActivate - 双击进入目录或打开文件的回调。
 * @param {() => Promise<void>} props.onDelete - 删除条目回调。
 * @param {(name: string) => Promise<void>} props.onRename - 重命名条目回调。
 * @returns {JSX.Element} 远程文件/目录列表行。
 */
const FileItem = ({ entry, currentPath, connectionId, showHiddenFiles = false, selected, onSelect, onActivate, onDelete, onRename }) => {
  // 单项传输、删除和重命名的 loading 状态，分别阻止同一操作重复提交。
  const [ downloading, setDownloading ] = useState(false)
  const [ deleting, setDeleting ] = useState(false)
  const [ renameOpen, setRenameOpen ] = useState(false)
  const [ renameValue, setRenameValue ] = useState(entry.name)
  const [ renaming, setRenaming ] = useState(false)
  // 目录大小的异步结果、加载/错误状态及可见性开关。
  const [ directorySize, setDirectorySize ] = useState(null)
  const [ directorySizeLoading, setDirectorySizeLoading ] = useState(false)
  const [ directorySizeError, setDirectorySizeError ] = useState(false)
  const [ directorySizeVisible, setDirectorySizeVisible ] = useState(false)
  // 行节点供 IntersectionObserver 使用；缓存键用于避免同一版本重复统计。
  const rowRef = useRef(null)
  const completedDirectorySizeKeyRef = useRef('')
  const fileIcon = entry.isDirectory ? { name: 'folder', type: 'directory' } : resolveFileIcon(entry.name)
  const remotePath = entry.path || joinRemotePath(currentPath, entry.name)
  const directorySizeCacheVersion = entry.modifiedAt
  const includeHiddenFiles = showHiddenFiles === true
  const directorySizeKey = `${ connectionId }\u0000${ remotePath }\u0000${ directorySizeCacheVersion ?? '' }\u0000${ includeHiddenFiles ? 'with-hidden' : 'without-hidden' }`

  // 仅在目录行进入可视区域附近时触发统计，减少大目录列表的并发扫描。
  useEffect(() => {
    if (!entry.isDirectory) {
      setDirectorySizeVisible(false)
      return undefined
    }

    const row = rowRef.current
    if (!row || typeof window === 'undefined' || typeof window.IntersectionObserver !== 'function') {
      setDirectorySizeVisible(true)
      return undefined
    }

    const observer = new window.IntersectionObserver(entries => {
      setDirectorySizeVisible(Boolean(entries[0]?.isIntersecting))
    }, {
      root: row.closest('.file-list-shell'),
      // 预先计算即将进入视区的少量目录，滚动时无需等待新的完整扫描。
      rootMargin: '160px 0px',
      threshold: 0
    })
    observer.observe(row)
    return () => observer.disconnect()
  }, [ entry.isDirectory, remotePath ])

  // 当前条目、连接或隐藏文件偏好变化时，废弃旧统计结果并恢复等待状态。
  useEffect(() => {
    completedDirectorySizeKeyRef.current = ''
    setDirectorySize(null)
    setDirectorySizeLoading(false)
    setDirectorySizeError(false)
  }, [ directorySizeKey, entry.isDirectory ])

  // 目录可见时发起递归大小请求；卸载或滚出有效生命周期时取消信号请求。
  useEffect(() => {
    let disposed = false
    const abortController = typeof window !== 'undefined' && typeof window.AbortController === 'function'
      ? new window.AbortController()
      : null

    if (!entry.isDirectory || !directorySizeVisible) {
      setDirectorySizeLoading(false)
      return undefined
    }

    if (completedDirectorySizeKeyRef.current === directorySizeKey) return undefined

    setDirectorySizeLoading(true)
    setDirectorySizeError(false)
    sftpManager.getRemoteDirectorySize(connectionId, remotePath, {
      signal: abortController?.signal,
      cacheVersion: directorySizeCacheVersion,
      showHiddenFiles: includeHiddenFiles
    })
      .then(result => {
        if (disposed) return
        completedDirectorySizeKeyRef.current = directorySizeKey
        setDirectorySize(normalizeDirectorySizeResult(result))
        setDirectorySizeLoading(false)
      })
      .catch(() => {
        if (disposed) return
        setDirectorySizeLoading(false)
        setDirectorySizeError(true)
      })

    return () => {
      disposed = true
      abortController?.abort()
    }
  }, [ connectionId, directorySizeCacheVersion, directorySizeKey, directorySizeVisible, entry.isDirectory, includeHiddenFiles, remotePath ])

  /**
   * 统一处理单文件和文件夹下载，并在覆盖前再次确认。
   *
   * @param {Object} event - 点击事件，用于阻止列表行激活。
   * @returns {Promise<void>} 下载、覆盖确认和进度状态清理完成后的 Promise。
   */
  const handleDownload = async (event) => {
    event.stopPropagation()
    if (downloading) return
    let downloadPath
    try {
      downloadPath = await resolveDownloadPath()
      if (!downloadPath) return
    } catch (error) {
      notification.error('下载失败', error.message || error.toString() || '无法选择本地下载目录')
      return
    }
    const remotePath = joinRemotePath(currentPath, entry.name)
    const localPath = joinLocalPath(downloadPath, entry.name)
    const itemLabel = entry.isDirectory ? '文件夹' : '文件'
    const accepted = await confirm(
      `确定下载${ itemLabel }“${ entry.name }”吗？\n\n保存到：${ localPath }`,
      {
        title: '确认下载',
        kind: 'warning',
        okLabel: '下载',
        cancelLabel: '取消'
      }
    )
    if (!accepted) return
    let transferId = null
    /**
     * 将单项下载回调转换为状态栏进度，并关联可取消的传输 ID。
     *
     * @param {number} progress - 当前下载进度百分比。
     * @param {Object} [payload={}] - 目录下载返回的文件级和总进度信息。
     * @returns {void}
     */
    const publishProgress = (progress, payload = {}) => {
      const fileIndex = Number(payload.fileIndex)
      const fileTotal = Number(payload.fileTotal)
      PubSubBusinessKeyEnum.SEND_MASK({
        progress: Math.round(Number(progress) || 0),
        fileName: entry.isDirectory ? (payload.fileName || entry.name) : entry.name,
        operation: entry.isDirectory ? 'download-directory' : 'download',
        folderQueueIndex: Number.isFinite(fileIndex) ? fileIndex : undefined,
        folderQueueTotal: Number.isFinite(fileTotal) ? fileTotal : undefined,
        overallProgress: Number.isFinite(Number(payload.overallProgress))
          ? Number(payload.overallProgress)
          : undefined,
        onCancel: () => transferId && sftpManager.cancelTransfer(transferId)
      })
    }
    /**
     * 执行一次文件或目录下载；覆盖重试会复用同一进度发布逻辑。
     *
     * @param {boolean} overwrite - 是否允许覆盖本地同名目标。
     * @returns {Promise<void>} 下载任务完成后的 Promise。
     */
    const performDownload = async (overwrite) => {
      transferId = null
      const download = entry.isDirectory
        ? sftpManager.downloadDirectory.bind(sftpManager)
        : sftpManager.downloadFile.bind(sftpManager)
      try {
        await download(
          connectionId,
          remotePath,
          localPath,
          (progress, payload) => publishProgress(progress, payload),
          overwrite,
          id => {
            transferId = id
            publishProgress(0)
          }
        )
      } finally {
        transferId = null
      }
    }

    try {
      setDownloading(true)
      publishProgress(0)
      await performDownload(false)
      notification.success('下载成功', `${ itemLabel } ${ entry.name } 已保存到 ${ localPath }`)
    } catch (error) {
      const message = error.message || error.toString() || '未知错误'
      if (!message.includes('已存在')) {
        notification.error('下载失败', `${ itemLabel } ${ entry.name }：${ message }`)
      } else {
        const overwriteAccepted = await confirm(
          `本地${ itemLabel }已存在：\n${ localPath }\n${ entry.isDirectory ? '是否合并并覆盖其中的文件？' : '是否覆盖？' }`,
          {
            title: '确认覆盖',
            kind: 'warning',
            okLabel: entry.isDirectory ? '合并并覆盖' : '覆盖',
            cancelLabel: '取消'
          }
        )
        if (overwriteAccepted) {
          try {
            await performDownload(true)
            notification.success('下载成功', `${ itemLabel } ${ entry.name } 已覆盖`)
          } catch (retryError) {
            notification.error('下载失败', retryError.message || retryError.toString() || '未知错误')
          }
        }
      }
    } finally {
      setDownloading(false)
      PubSubBusinessKeyEnum.SEND_MASK(null)
    }
  }

  /**
   * 校验远程名称后提交重命名请求，禁止路径分隔符和特殊目录名。
   *
   * @param {Object} [event] - 来自表单提交或键盘事件的可选事件对象。
   * @returns {Promise<void>} 重命名及状态清理完成后的 Promise。
   */
  const submitRename = async (event) => {
    event?.preventDefault()
    event?.stopPropagation()
    const name = renameValue.trim()
    if (!name || /[\\/]/.test(name) || name === '.' || name === '..') return
    setRenaming(true)
    try {
      await onRename(name)
      setRenameOpen(false)
    } catch (error) {
      notification.error('重命名失败', error.message || error.toString() || '未知错误')
    } finally {
      setRenaming(false)
    }
  }

  /**
   * 删除当前远程项目；实际递归和进度由父级及 SFTP 管理器负责。
   *
   * @param {Object} event - 删除按钮点击事件。
   * @returns {Promise<void>} 删除回调和本地 loading 状态清理完成后的 Promise。
   */
  const handleDelete = async (event) => {
    event.stopPropagation()
    if (deleting) return
    setDeleting(true)
    try {
      await onDelete()
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div
      ref={rowRef}
      className={`file-item-row${ selected ? ' is-selected' : '' }`}
      title={entry.isDirectory ? '单击选择，双击进入目录' : '单击选择，双击预览文件'}
      onClick={onSelect}
      onDoubleClick={event => {
        event.stopPropagation()
        onActivate()
      }}
      onKeyDown={event => {
        // 键盘激活只属于当前文件行；操作按钮和重命名弹窗的事件不能激活文件行。
        if (event.target !== event.currentTarget) return
        if (event.key === 'Enter') {
          event.preventDefault()
          onActivate()
        } else if (event.key === ' ') {
          event.preventDefault()
          onSelect(event)
        }
      }}
      role="button"
      tabIndex={0}
      aria-pressed={selected}
    >
      <List.Item
        className="file-list-item"
      >
        <List.Item.Meta
          className="file-item-meta"
          avatar={
            <AppIcon
              name={fileIcon.name}
              className={`file-type-icon is-${ fileIcon.type }`}
            />
          }
          title={
            <span className={`file-item-name${ entry.isDirectory ? ' is-directory' : '' }`}>
              {entry.name}
            </span>
          }
        />
        <div className="file-item-actions" onDoubleClick={event => event.stopPropagation()}>
          <span className="file-item-size">
            {entry.isDirectory ? (
              directorySizeLoading ? (
                <span className="directory-size-loading" aria-label="正在计算目录大小">
                  <Spin className="directory-size-spinner" size="small" />
                  <span>计算中</span>
                </span>
              ) : directorySizeError ? (
                <Tooltip title="暂时无法统计目录大小">
                  <span className="directory-size-unavailable">不可用</span>
                </Tooltip>
              ) : directorySize?.complete === false ? (
                <Tooltip title={getPartialDirectorySizeHint(directorySize)}>
                  <span className="directory-size-partial">≥ {formatFileSize(directorySize.size)}</span>
                </Tooltip>
              ) : directorySize ? formatFileSize(directorySize.size) : (
                <span className="directory-size-pending" aria-label="等待计算目录大小">--</span>
              )
            ) : formatFileSize(entry.size)}
          </span>
          <Tooltip title={entry.isDirectory ? '下载文件夹' : '下载文件'}>
            <Button
              className="compact-icon-button"
              size="small"
              icon={<AppIcon name="download" />}
              loading={downloading}
              aria-label={`下载 ${ entry.name }`}
              onClick={handleDownload}
            />
          </Tooltip>
          <Tooltip title="重命名">
            <Button
              className="compact-icon-button"
              size="small"
              icon={<AppIcon name="edit" />}
              aria-label={`重命名 ${ entry.name }`}
              onClick={event => {
                event.stopPropagation()
                setRenameValue(entry.name)
                setRenameOpen(true)
              }}
            />
          </Tooltip>
          <Tooltip title="删除">
            <Button
              className="compact-icon-button"
              danger
              size="small"
              icon={<AppIcon name="trash" />}
              loading={deleting}
              aria-label={`删除 ${ entry.name }`}
              onClick={event => void handleDelete(event)}
            />
          </Tooltip>
        </div>
      </List.Item>
      <div
        onClick={event => event.stopPropagation()}
        onDoubleClick={event => event.stopPropagation()}
        onMouseDown={event => event.stopPropagation()}
        onPointerDown={event => event.stopPropagation()}
        onKeyDown={event => event.stopPropagation()}
        onKeyUp={event => event.stopPropagation()}
      >
        <Modal
          rootClassName="compact-modal"
          title={`重命名 ${ entry.name }`}
          open={renameOpen}
          onCancel={event => {
            event?.stopPropagation()
            setRenameOpen(false)
          }}
          onOk={submitRename}
          okText="保存"
          cancelText="取消"
          confirmLoading={renaming}
          width="min(360px, calc(100vw - 24px))"
          destroyOnHidden
        >
          <Input
            autoFocus
            autoCapitalize="none"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            value={renameValue}
            onChange={event => setRenameValue(event.target.value)}
            onKeyDown={event => event.stopPropagation()}
            onKeyUp={event => event.stopPropagation()}
          />
        </Modal>
      </div>
    </div>
  )
}

export default FileItem
