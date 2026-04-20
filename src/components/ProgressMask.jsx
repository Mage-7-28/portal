import React, { useState, useEffect, useMemo } from 'react'
import { Progress, Typography } from 'antd'
import { DownloadOutlined, UploadOutlined } from '@ant-design/icons'
import PubSub from 'pubsub-js'
import { PubSubBusinessKeyEnum } from '../utils/common'

const { Text } = Typography

const ProgressMask = () => {
  const [ maskData, setMaskData ] = useState(null)
  const [ windowSize, setWindowSize ] = useState({
    width: window.innerWidth,
    height: window.innerHeight
  })

  useEffect(() => {
    const token = PubSub.subscribe(PubSubBusinessKeyEnum.MASK, (_, data) => {
      setMaskData(data)
    })

    const handleResize = () => {
      setWindowSize({
        width: window.innerWidth,
        height: window.innerHeight
      })
    }

    window.addEventListener('resize', handleResize)
    return () => {
      PubSub.unsubscribe(token)
      window.removeEventListener('resize', handleResize)
    }
  }, [])

  // 响应式计算容器大小
  const containerStyle = useMemo(() => {
    const maxWidth = Math.min(windowSize.width * 0.8, 400)
    const minWidth = 300
    const width = Math.max(minWidth, maxWidth)

    return {
      ...styles.container,
      width: `${ width }px`
    }
  }, [windowSize])

  if (!maskData) {
    return null
  }

  // 确保 maskData 有必要的属性
  const { progress = 0, fileName = '', operation = 'download' } = maskData

  return (
    <div style={styles.overlay}>
      <div style={containerStyle}>
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
            strokeColor={{
              '0%': '#8B5CF6',
              '100%': '#EC4899'
            }}
            trailColor="rgba(255, 255, 255, 0.1)"
            showInfo={false}
            size="small"
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
    backgroundColor: 'rgba(0, 0, 0, 0.8)',
    backdropFilter: 'blur(8px)',
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 99999,
    animation: 'fadeIn 0.2s ease-out'
  },
  container: {
    background: 'linear-gradient(135deg, #1E293B 0%, #0F172A 100%)',
    borderRadius: '16px',
    padding: '32px 36px',
    textAlign: 'center',
    boxShadow: '0 20px 60px rgba(0, 0, 0, 0.6), 0 0 0 1px rgba(255, 255, 255, 0.08)',
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
    background: 'linear-gradient(135deg, #8B5CF6 0%, #EC4899 100%)',
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    boxShadow: '0 8px 24px rgba(139, 92, 246, 0.4)'
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
    letterSpacing: '0.3px'
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
    background: 'linear-gradient(135deg, #8B5CF6 0%, #EC4899 100%)',
    WebkitBackgroundClip: 'text',
    WebkitTextFillColor: 'transparent',
    marginTop: '12px',
    display: 'block',
    textShadow: '0 0 15px rgba(139, 92, 246, 0.3)'
  }
}

export default ProgressMask
