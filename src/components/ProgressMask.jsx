import React, { useState, useEffect } from 'react'
import { Progress, Typography } from 'antd'
import { DownloadOutlined, UploadOutlined } from '@ant-design/icons'
import PubSub from 'pubsub-js'
import { PubSubBusinessKeyEnum } from '../utils/common'

const { Text } = Typography

const ProgressMask = () => {
  const [ maskData, setMaskData ] = useState(null)

  useEffect(() => {
    const token = PubSub.subscribe(PubSubBusinessKeyEnum.MASK, (_, data) => {
      setMaskData(data)
    })
    return () => PubSub.unsubscribe(token)
  }, [])

  if (!maskData) {
    return null
  }

  const { progress, fileName, operation } = maskData

  return (
    <div style={styles.overlay}>
      <div style={styles.container}>
        <div style={styles.iconWrapper}>
          <div style={styles.operationIcon}>
            {operation === 'download' ? (
              <DownloadOutlined style={styles.icon} />
            ) : (
              <UploadOutlined style={styles.icon} />
            )}
          </div>
        </div>

        <Text style={styles.title}>
          {operation === 'download' ? '正在下载文件' : '正在上传文件'}
        </Text>

        <Text style={styles.fileName} ellipsis={{ tooltip: fileName }}>
          {fileName}
        </Text>

        <div style={styles.progressWrapper}>
          <Progress
            percent={Math.round(progress)}
            strokeColor={{
              '0%': '#4EC9B0',
              '100%': '#52C9B0'
            }}
            trailColor="rgba(255, 255, 255, 0.1)"
            showInfo={false}
          />
          <Text style={styles.percentText}>{Math.round(progress)}%</Text>
        </div>
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
    backgroundColor: 'rgba(0, 0, 0, 0.85)',
    backdropFilter: 'blur(12px)',
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 99999,
    animation: 'fadeIn 0.3s ease-out'
  },
  container: {
    background: 'linear-gradient(145deg, #1a1a1a 0%, #0d0d0d 100%)',
    borderRadius: '20px',
    padding: '48px 56px',
    width: '420px',
    textAlign: 'center',
    boxShadow: '0 25px 80px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(255, 255, 255, 0.05)',
    animation: 'scaleIn 0.3s ease-out'
  },
  iconWrapper: {
    position: 'relative',
    width: '100px',
    height: '100px',
    margin: '0 auto 32px',
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center'
  },
  operationIcon: {
    position: 'absolute',
    bottom: '-8px',
    right: '-8px',
    width: '40px',
    height: '40px',
    borderRadius: '50%',
    backgroundColor: '#4EC9B0',
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    boxShadow: '0 4px 12px rgba(78, 201, 176, 0.4)'
  },
  icon: {
    fontSize: '20px',
    color: '#ffffff'
  },
  title: {
    fontSize: '22px',
    fontWeight: '600',
    color: '#ffffff',
    marginBottom: '12px',
    display: 'block',
    letterSpacing: '0.5px'
  },
  fileName: {
    fontSize: '14px',
    color: 'rgba(255, 255, 255, 0.6)',
    marginBottom: '32px',
    display: 'block',
    maxWidth: '300px',
    margin: '0 auto 32px'
  },
  progressWrapper: {
    position: 'relative',
    padding: '0 8px'
  },
  percentText: {
    fontSize: '28px',
    fontWeight: '700',
    color: '#4EC9B0',
    marginTop: '16px',
    display: 'block',
    textShadow: '0 0 20px rgba(78, 201, 176, 0.3)'
  }
}

export default ProgressMask
