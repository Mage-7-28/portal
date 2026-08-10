// 页面布局使用的基础样式对象；复杂交互样式在各组件模块中维护。
/** 根页面纵向布局和主题背景。 */
export const layoutStyle = {
  display: 'flex',
  flexDirection: 'column',
  minHeight: '100vh',
  backgroundSize: 'cover'
}

/** 兼容旧消息框组件的深色边框和文字样式。 */
export const msgBoxStyle = {
  background: '#252526',
  color: '#e1ded7',
  border: '1px solid #3c3f41',
  fontSize: '12px'
}

/** 旧版顶部栏布局对象，保留供兼容页面使用。 */
export const headerStyle = {
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

/** 旧版内容区域样式，自动占满头部以下的剩余高度。 */
export const contentStyle = {
  flex: 1, // 自动填充剩余空间
  color: '#fff',
  overflow: 'auto',
  height: 'calc(100vh - 50px)',
  backgroundColor: 'transparent'
}

/** 旧版底部栏样式，当前主窗口主要使用 CSS 状态栏。 */
export const footerStyle = {
  textAlign: 'center',
  color: '#fff',
  height: 55,
  backgroundColor: '#212121'
}
