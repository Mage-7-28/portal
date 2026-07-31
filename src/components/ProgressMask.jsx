import React, { useState, useEffect, useRef } from 'react'
import { Button, Progress, Tooltip, Typography } from 'antd'
import { DownloadOutlined, StopOutlined, UploadOutlined } from '@ant-design/icons'
import PubSub from 'pubsub-js'
import { PubSubBusinessKeyEnum, THEME_BORDER_COLOR, THEME_PRIMARY_COLOR, THEME_TEXT_LINK, THEME_TEXT_PRIMARY, THEME_TEXT_SECONDARY } from '../utils/common'

const { Text } = Typography

const ProgressMask = () => {
  const [ maskData, setMaskData ] = useState(null)
  const [ cancelling, setCancelling ] = useState(false)
  const dismissedMaskIds = useRef(new Set())

  useEffect(() => {
    const token = PubSub.subscribe(PubSubBusinessKeyEnum.MASK, (_, data) => {
      if (data?.dismissMaskId) {
        dismissedMaskIds.current.add(data.dismissMaskId)
        setMaskData(current => current?.maskId === data.dismissMaskId ? null : current)
        return
      }
      if (data?.maskId && dismissedMaskIds.current.has(data.maskId)) return
      setMaskData(data)
    })

    return () => {
      PubSub.unsubscribe(token)
    }
  }, [])

  if (!maskData) {
    return null
  }

  // 确保 maskData 有必要的属性
  const {
    progress = 0,
    fileName = '',
    operation = 'download',
    queueIndex = 0,
    queueTotal = 1,
    pendingCount = 0,
    overallProgress,
    folderQueueIndex,
    folderQueueTotal,
    message = '',
    phase = '',
    onCancel
  } = maskData
  const isDownloadOperation = operation === 'download' || operation === 'download-directory'
  const isDirectoryDownload = operation === 'download-directory'
  const directoryProgress = Number.isFinite(Number(overallProgress))
    ? Number(overallProgress)
    : Number(progress) || 0
  const downloadQueueLabel = isDownloadOperation && !isDirectoryDownload && Number(queueTotal) > 1
    ? `（第 ${ Number(queueIndex) + 1 }/${ queueTotal } 个）`
    : ''
  const isInlineOperation = [
    'upload',
    'upload-directory',
    'download',
    'download-directory',
    'delete',
    'rename'
  ].includes(operation)

  const handleCancel = async () => {
    if (!onCancel || cancelling) return
    setCancelling(true)
    try {
      await onCancel()
    } finally {
      setCancelling(false)
    }
  }

  if (isInlineOperation) {
    const isDirectoryUpload = operation === 'upload-directory'
    const isMutation = operation === 'delete' || operation === 'rename'
    const isDirectoryTransfer = isDirectoryUpload || isDirectoryDownload
    const folderIndex = Number(folderQueueIndex) || 0
    const folderTotal = Number(folderQueueTotal) || 0
    const displayProgress = isDirectoryDownload ? directoryProgress : Number(progress) || 0
    const operationLabel = isMutation
      ? (operation === 'delete' ? '删除' : '重命名')
      : isDirectoryDownload ? '下载文件夹' : isDirectoryUpload ? '上传文件夹' : isDownloadOperation ? '下载中' : '上传中'
    const showItemPosition = isMutation
      ? operation === 'delete' && phase === 'deleting' && queueTotal > 0
      : isDirectoryTransfer || Number(queueTotal) > 1
    let pendingLabel = message
    let pendingDetail = ''
    let pendingKind = ''
    let pendingCountLabel = ''

    if (!isMutation && isDirectoryDownload) {
      if (folderTotal > 0) {
        pendingDetail = `当前 ${ Math.round(Number(progress) || 0) }% ·`
        pendingKind = '待处理'
        pendingCountLabel = `${ Math.max(folderTotal - folderIndex - 1, 0) } 个`
      } else {
        pendingLabel = '正在扫描文件夹...'
      }
    } else if (!isMutation && isDirectoryUpload && Number.isFinite(Number(overallProgress))) {
      if (folderTotal > 0) {
        pendingDetail = `总进度 ${ Math.round(Number(overallProgress)) }% ·`
        pendingKind = '文件待处理'
        pendingCountLabel = `${ Math.max(folderTotal - folderIndex - 1, 0) } 个`
      } else {
        pendingKind = '队列待处理'
        pendingCountLabel = `${ pendingCount } 个`
      }
    } else if (!isMutation && Number(pendingCount) > 0) {
      pendingKind = isDownloadOperation ? '待下载' : '待上传'
      pendingCountLabel = `${ pendingCount } 个`
    }

    if (pendingCountLabel) {
      pendingLabel = [ pendingDetail, pendingKind, pendingCountLabel ].filter(Boolean).join(' ')
    }
    const cancelLabel = isMutation ? '取消操作' : isDownloadOperation ? '取消下载' : '取消上传'
    return (
      <div
        className={`transfer-inline-status${ isMutation ? ' is-operation' : '' }`}
        title={`${ operationLabel }：${ fileName }${ message ? ` - ${ message }` : '' }`}
      >
        <span className="transfer-inline-operation">{operationLabel}</span>
        {showItemPosition && (
          <span className="transfer-inline-position">
            {operation === 'delete'
              ? `第 ${ queueIndex + 1 }/${ queueTotal } 个文件`
              : isDirectoryTransfer && folderTotal > 0
                ? `项目 ${ queueIndex + 1 }/${ queueTotal } · 文件 ${ Math.min(folderIndex + 1, folderTotal) }/${ folderTotal }`
                : `项目 ${ queueIndex + 1 }/${ queueTotal }`}
          </span>
        )}
        <span className="transfer-inline-file" title={fileName}>{fileName || '准备中'}</span>
        <Progress
          className="transfer-inline-progress"
          percent={Math.round(displayProgress)}
          status={isMutation ? 'active' : undefined}
          strokeColor={THEME_PRIMARY_COLOR}
          railColor={THEME_BORDER_COLOR}
          showInfo={false}
          size="small"
        />
        <span className="transfer-inline-percent">{Math.round(displayProgress)}%</span>
        {pendingLabel && (
          <span className={`transfer-inline-pending${ isMutation ? ' transfer-inline-message' : '' }`} title={pendingLabel}>
            {pendingCountLabel ? (
              <>
                {pendingDetail && <span className="transfer-inline-pending-detail">{pendingDetail}</span>}
                <span className="transfer-inline-pending-kind">{pendingKind}</span>
                <span className="transfer-inline-pending-count">{pendingCountLabel}</span>
              </>
            ) : pendingLabel}
          </span>
        )}
        {onCancel && (
          <Tooltip title={cancelLabel}>
            <Button
              className="transfer-inline-cancel"
              type="text"
              size="small"
              danger
              icon={<StopOutlined />}
              loading={cancelling}
              onClick={handleCancel}
              aria-label={cancelLabel}
            />
          </Tooltip>
        )}
      </div>
    )
  }

  return (
    <div style={styles.overlay}>
      <div style={styles.container}>
        <div style={styles.iconContainer}>
          <div style={styles.operationIcon}>
            {isDownloadOperation ? (
              <DownloadOutlined style={styles.icon} />
            ) : (
              <UploadOutlined style={styles.icon} />
            )}
          </div>
        </div>

        <Text style={styles.title}>
          {isDirectoryDownload
            ? `下载文件夹中${ Number(folderQueueTotal) > 0 ? `（文件 ${ Math.min(Number(folderQueueIndex) + 1, Number(folderQueueTotal) ) }/${ folderQueueTotal }）` : '' }`
            : isDownloadOperation ? `下载中${ downloadQueueLabel }` : '上传中'}
        </Text>

        <Text style={styles.fileName} ellipsis={{ tooltip: fileName }}>
          {fileName}
        </Text>

        {isDirectoryDownload && Number(folderQueueTotal) > 0 && (
          <Text style={styles.folderProgressText}>
            当前文件 {Math.round(Number(progress) || 0)}% · 总体 {Math.round(directoryProgress)}%
          </Text>
        )}

        <div style={styles.progressWrapper}>
          <Progress
            percent={Math.round(directoryProgress)}
            strokeColor={THEME_PRIMARY_COLOR}
            railColor={THEME_BORDER_COLOR}
            showInfo={false}
            size="small"
          />
          <Text style={styles.percentText}>{Math.round(directoryProgress)}%</Text>
        </div>
        {onCancel && (
          <Button
            size="small"
            danger
            icon={<StopOutlined />}
            loading={cancelling}
            onClick={handleCancel}
            style={{ marginTop: 10 }}
          >
            取消传输
          </Button>
        )}
      </div>
    </div>
  )
}

const styles = {
  overlay: {
    position: 'fixed',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(7, 9, 12, 0.74)',
    backdropFilter: 'blur(4px)',
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 99999,
    animation: 'fadeIn 0.2s ease-out'
  },
  container: {
    background: '#252526',
    borderRadius: '8px',
    padding: '20px 24px',
    width: 'min(340px, calc(100vw - 24px))',
    boxSizing: 'border-box',
    textAlign: 'center',
    boxShadow: '0 16px 42px rgba(0, 0, 0, 0.48)',
    animation: 'scaleIn 0.2s ease-out',
    border: `1px solid ${ THEME_BORDER_COLOR }`
  },
  iconContainer: {
    margin: '0 auto 12px',
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center'
  },
  operationIcon: {
    width: '40px',
    height: '40px',
    borderRadius: '8px',
    background: THEME_PRIMARY_COLOR,
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    boxShadow: 'none'
  },
  icon: {
    fontSize: '18px',
    color: THEME_TEXT_PRIMARY
  },
  title: {
    fontSize: '15px',
    fontWeight: '600',
    color: THEME_TEXT_PRIMARY,
    marginBottom: '4px',
    display: 'block',
    letterSpacing: 0
  },
  fileName: {
    fontSize: '12px',
    color: THEME_TEXT_SECONDARY,
    marginBottom: '14px',
    display: 'block',
    maxWidth: '90%',
    margin: '0 auto 14px',
    lineHeight: '1.4'
  },
  folderProgressText: {
    display: 'block',
    margin: '-6px auto 10px',
    color: THEME_TEXT_SECONDARY,
    fontSize: '11px',
    lineHeight: '1.4'
  },
  progressWrapper: {
    position: 'relative',
    padding: '0 4px'
  },
  percentText: {
    fontSize: '18px',
    fontWeight: '700',
    color: THEME_TEXT_LINK,
    marginTop: '6px',
    display: 'block',
    textShadow: 'none'
  }
}

export default ProgressMask
