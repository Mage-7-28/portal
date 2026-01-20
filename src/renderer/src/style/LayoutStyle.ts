import type { CSSProperties } from 'react'

export const layoutStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  minHeight: '100vh', // 设置最小高度为视口高度
  backgroundSize: 'cover'
}

export const msgBoxStyle: CSSProperties = {
  background: 'rgb(30, 31, 34)',
  color: 'rgba(255, 255, 255, 0.85)',
  border: '1px solid #36383a',
  fontSize: '12px'
}

export const headerStyle: CSSProperties = {
  textAlign: 'center',
  color: '#fff',
  height: 50,
  paddingInline: 50,
  lineHeight: '50px',
  backgroundColor: 'rgba(0, 0, 0, 0.3)',
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  width: '100%',
  paddingLeft: '10px'
}

export const contentStyle: CSSProperties = {
  flex: 1,
  color: '#fff',
  overflow: 'auto',
  height: 'calc(100vh - 50px)',
  backgroundColor: 'transparent'
}

export const footerStyle: CSSProperties = {
  textAlign: 'center',
  color: '#fff',
  height: 55,
  backgroundColor: '#212121'
}
