import React, { useState, useEffect } from 'react'
import { Button, Progress, Typography } from 'antd'
import { DownloadOutlined, StopOutlined, UploadOutlined } from '@ant-design/icons'
import PubSub from 'pubsub-js'
import { PubSubBusinessKeyEnum } from '../utils/common'

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
            strokeColor="#4f8cff"
            railColor="rgba(255, 255, 255, 0.1)"
            showInfo={false}
            size="small"
          />
          <Text style={styles.percentText}>{Math.round(progress)}%</Text>
        </div>
        {onCancel && (
          <Button
            danger
            icon={<StopOutlined />}
            loading={cancelling}
            onClick={handleCancel}
            style={{ marginTop: 16 }}
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
    backgroundColor: 'rgba(0, 0, 0, 0.8)',
    backdropFilter: 'blur(8px)',
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 99999,
    animation: 'fadeIn 0.2s ease-out'
  },
  container: {
    background: '#1b1e24',
    borderRadius: '8px',
    padding: '32px 36px',
    width: 'min(400px, calc(100vw - 32px))',
    boxSizing: 'border-box',
    textAlign: 'center',
    boxShadow: '0 20px 60px rgba(0, 0, 0, 0.6)',
    animation: 'scaleIn 0.2s ease-out',
    border: '1px solid rgba(255, 255, 255, 0.1)'
  },
  iconContainer: {
    margin: '0 auto 24px',
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center'
  },
  operationIcon: {
    width: '56px',
    height: '56px',
    borderRadius: '50%',
    background: '#4f8cff',
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    boxShadow: '0 8px 24px rgba(79, 140, 255, 0.35)'
  },
  icon: {
    fontSize: '24px',
    color: '#ffffff'
  },
  title: {
    fontSize: '18px',
    fontWeight: '600',
    color: '#ffffff',
    marginBottom: '8px',
    display: 'block',
    letterSpacing: 0
  },
  fileName: {
    fontSize: '13px',
    color: 'rgba(255, 255, 255, 0.6)',
    marginBottom: '24px',
    display: 'block',
    maxWidth: '90%',
    margin: '0 auto 24px',
    lineHeight: '1.4'
  },
  progressWrapper: {
    position: 'relative',
    padding: '0 4px'
  },
  percentText: {
    fontSize: '24px',
    fontWeight: '700',
    color: '#8ab4ff',
    marginTop: '12px',
    display: 'block',
    textShadow: 'none'
  }
}

export default ProgressMask
