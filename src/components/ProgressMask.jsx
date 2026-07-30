import React, { useState, useEffect } from 'react'
import { Button, Progress, Typography } from 'antd'
import { DownloadOutlined, StopOutlined, UploadOutlined } from '@ant-design/icons'
import PubSub from 'pubsub-js'
import { PubSubBusinessKeyEnum, THEME_BORDER_COLOR, THEME_PRIMARY_COLOR, THEME_TEXT_LINK, THEME_TEXT_PRIMARY, THEME_TEXT_SECONDARY } from '../utils/common'

const { Text } = Typography

const ProgressMask = () => {
  const [ maskData, setMaskData ] = useState(null)
  const [ cancelling, setCancelling ] = useState(false)

  useEffect(() => {
    const token = PubSub.subscribe(PubSubBusinessKeyEnum.MASK, (_, data) => {
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
  const { progress = 0, fileName = '', operation = 'download', onCancel } = maskData

  const handleCancel = async () => {
    if (!onCancel || cancelling) return
    setCancelling(true)
    try {
      await onCancel()
    } finally {
      setCancelling(false)
    }
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
          {operation === 'download' ? '下载中' : '上传中'}
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
