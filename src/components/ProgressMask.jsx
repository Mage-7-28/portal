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
  const downloadQueueLabel = operation === 'download' && Number(queueTotal) > 1
    ? `（第 ${ Number(queueIndex) + 1 }/${ queueTotal } 个）`
    : ''

  const handleCancel = async () => {
    if (!onCancel || cancelling) return
    setCancelling(true)
    try {
      await onCancel()
    } finally {
      setCancelling(false)
    }
  }

  if (operation === 'upload' || operation === 'upload-directory' || operation === 'delete' || operation === 'rename') {
    const isDirectoryUpload = operation === 'upload-directory'
    const isMutation = operation === 'delete' || operation === 'rename'
    const operationLabel = isMutation
      ? (operation === 'delete' ? '删除' : '重命名')
      : (isDirectoryUpload ? '上传文件夹' : '上传中')
    const showItemPosition = !isMutation || (operation === 'delete' && phase === 'deleting' && queueTotal > 0)
    const pendingLabel = isDirectoryUpload && Number.isFinite(overallProgress)
      ? Number(folderQueueTotal) > 0
        ? `总进度 ${ Math.round(overallProgress) }% · 文件待处理 ${ Math.max(Number(folderQueueTotal) - Number(folderQueueIndex) - 1, 0) } 个`
        : `队列待处理 ${ pendingCount } 个`
      : `待上传 ${ pendingCount } 个`
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
              : isDirectoryUpload && Number(folderQueueTotal) > 0
                ? `项目 ${ queueIndex + 1 }/${ queueTotal } · 文件 ${ Math.min(Number(folderQueueIndex) + 1, Number(folderQueueTotal)) }/${ folderQueueTotal }`
                : `项目 ${ queueIndex + 1 }/${ queueTotal }`}
          </span>
        )}
        <span className="transfer-inline-file" title={fileName}>{fileName || '准备中'}</span>
        <Progress
          className="transfer-inline-progress"
          percent={Math.round(progress)}
          status={isMutation ? 'active' : undefined}
          strokeColor={THEME_PRIMARY_COLOR}
          railColor={THEME_BORDER_COLOR}
          showInfo={false}
          size="small"
        />
        <span className="transfer-inline-percent">{Math.round(progress)}%</span>
        <span className={`transfer-inline-pending${ isMutation ? ' transfer-inline-message' : '' }`}>
          {isMutation ? message : pendingLabel}
        </span>
        {onCancel && (
          <Tooltip title="取消上传">
            <Button
              className="transfer-inline-cancel"
              type="text"
              size="small"
              danger
              icon={<StopOutlined />}
              loading={cancelling}
              onClick={handleCancel}
              aria-label="取消上传"
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
            {operation === 'download' ? (
              <DownloadOutlined style={styles.icon} />
            ) : (
              <UploadOutlined style={styles.icon} />
            )}
          </div>
        </div>

        <Text style={styles.title}>
          {operation === 'download' ? `下载中${ downloadQueueLabel }` : '上传中'}
        </Text>

        <Text style={styles.fileName} ellipsis={{ tooltip: fileName }}>
          {fileName}
        </Text>

        <div style={styles.progressWrapper}>
          <Progress
            percent={Math.round(progress)}
            strokeColor={THEME_PRIMARY_COLOR}
            railColor={THEME_BORDER_COLOR}
            showInfo={false}
            size="small"
          />
          <Text style={styles.percentText}>{Math.round(progress)}%</Text>
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
