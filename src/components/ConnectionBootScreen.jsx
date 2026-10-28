/** 服务器工作窗口的机甲风连接阶段提示。 */
import AppIcon from './AppIcon.jsx'

const describeStage = (state, fallback) => {
  if (state === 'ready') return '已就绪'
  if (state === 'error') return '暂不可用'
  if (state === 'waiting') return '等待确认'
  if (state === 'idle') return '等待连接'
  return fallback
}

const ConnectionBootScreen = ({
  connection,
  sessionState,
  terminalStatus,
  monitorState,
  onRetry
}) => {
  const sessionError = sessionState.status === 'error'
  const sessionIdle = sessionState.status === 'idle'
  const waitingForUser = sessionState.status === 'password' || sessionState.status === 'waiting-user'
  const fileState = sessionError
    ? 'error'
    : sessionIdle ? 'idle' : waitingForUser ? 'waiting' : sessionState.status === 'connected' ? 'ready' : 'connecting'
  const terminalState = terminalStatus.status === 'connected'
    ? 'ready'
    : terminalStatus.status === 'error' || terminalStatus.status === 'closed' ? 'error' : 'connecting'
  const monitorStageState = monitorState.status === 'ready'
    ? 'ready'
    : monitorState.status === 'error' ? 'error' : 'connecting'
  const title = sessionError ? '连接未成功' : sessionIdle ? '尚未连接' : waitingForUser ? '等待安全确认' : '正在初始化工作区'
  const filesReady = fileState === 'ready'
  const message = waitingForUser
    ? sessionState.message
    : sessionError ? sessionState.message : filesReady
      ? '文件通道已建立，正在启动终端与资源监控'
      : sessionState.message || '正在建立安全连接'

  return (
    <section className="connection-boot-screen" role="status" aria-live="polite">
      <div className="connection-boot-panel">
        <div className="connection-boot-mark" aria-hidden="true">
          <span className="connection-boot-grid" />
          <span className="connection-boot-ring">
            <span className="connection-boot-ring-core"><img src="/portal-logo.svg" width="56" height="56" alt="" /></span>
          </span>
          <i className="connection-boot-corner is-top-left" />
          <i className="connection-boot-corner is-top-right" />
          <i className="connection-boot-corner is-bottom-left" />
          <i className="connection-boot-corner is-bottom-right" />
        </div>
        <div className="connection-boot-copy">
          <span className="connection-boot-eyebrow">PORTAL // REMOTE LINK</span>
          <h1>{title}</h1>
          <strong title={connection?.name || connection?.host || '远程服务器'}>
            {connection?.name || connection?.host || '远程服务器'}
          </strong>
          <p>{message}</p>
        </div>
        <div className="connection-boot-stages" aria-label="连接初始化状态">
          {[
            { key: 'files', label: '文件通道', state: fileState, fallback: '建立连接' },
            { key: 'terminal', label: '远程终端', state: sessionIdle ? 'idle' : terminalState, fallback: filesReady ? '启动中' : '等待连接' },
            { key: 'monitor', label: '资源监控', state: sessionIdle ? 'idle' : monitorStageState, fallback: filesReady ? '采集中' : '等待连接' }
          ].map(stage => (
            <div className={`connection-boot-stage is-${ stage.state }`} key={stage.key}>
              <span className="connection-boot-stage-indicator" aria-hidden="true" />
              <span className="connection-boot-stage-label">{stage.label}</span>
              <span className="connection-boot-stage-status">
                {describeStage(stage.state, stage.fallback)}
              </span>
            </div>
          ))}
        </div>
        {(sessionError || sessionState.status === 'idle') && (
          <button className="connection-boot-retry" type="button" onClick={onRetry}>
            <AppIcon name="reload" />
            重新连接
          </button>
        )}
      </div>
    </section>
  )
}

export default ConnectionBootScreen
