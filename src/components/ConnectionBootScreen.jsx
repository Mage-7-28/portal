/** 服务器工作窗口连接期间展示真实的通道状态。 */
import AppIcon from './AppIcon.jsx'

const describeStage = (state, activeLabel, waitingLabel) => {
  if (state === 'ready') return '已就绪'
  if (state === 'error') return '暂不可用'
  if (state === 'waiting') return waitingLabel
  if (state === 'idle') return '未启动'
  return activeLabel
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
  const filesReady = sessionState.status === 'connected'
  const fileState = sessionError ? 'error' : sessionIdle ? 'idle' : waitingForUser ? 'waiting' : filesReady ? 'ready' : sessionState.phase === 'files' ? 'connecting' : 'idle'
  // 文件会话建立前，终端和监控尚未挂载，不能把宿主的初始状态当作实际连接进度。
  const terminalState = !filesReady ? 'idle' : terminalStatus.status === 'connected'
    ? 'ready'
    : terminalStatus.status === 'error' || terminalStatus.status === 'closed' ? 'error' : 'connecting'
  const monitorHealth = monitorState.currentHealth ?? monitorState.status
  const monitorStageState = !filesReady ? 'idle' : monitorHealth === 'ready'
    ? 'ready'
    : monitorHealth === 'error' ? 'error' : 'connecting'
  const auxiliaryError = terminalState === 'error' || monitorStageState === 'error'
  const allReady = filesReady && terminalState === 'ready' && monitorStageState === 'ready'
  const visualState = sessionError ? 'error' : sessionIdle ? 'idle' : waitingForUser ? 'waiting' : allReady ? 'ready' : 'connecting'
  const title = sessionError ? '连接未成功'
    : sessionIdle ? '尚未连接'
      : sessionState.status === 'password' ? '等待输入密码'
        : waitingForUser ? sessionState.phase === 'host-key' ? '等待确认服务器身份' : '等待安全确认'
          : allReady ? '工作区已就绪'
            : auxiliaryError ? '部分功能暂不可用' : '正在初始化工作区'
  const message = waitingForUser
    ? sessionState.message || '确认完成后将继续连接'
    : sessionError ? sessionState.message || '请检查连接配置后重试'
      : sessionIdle ? sessionState.message || '可以重新连接服务器'
        : allReady ? '文件、终端与资源监控均已就绪'
          : auxiliaryError ? '文件通道已就绪，部分功能暂不可用'
            : filesReady ? '文件通道已就绪，正在准备其他功能'
              : sessionState.message || '正在建立安全连接'
  const stages = [
    { key: 'files', label: '文件通道', state: fileState, activeLabel: '连接中', waitingLabel: sessionState.status === 'password' ? '等待输入' : '等待确认' },
    { key: 'terminal', label: '远程终端', state: terminalState, activeLabel: '连接中' },
    { key: 'monitor', label: '资源监控', state: monitorStageState, activeLabel: '采集中' }
  ]

  return (
    <section className="connection-boot-screen" data-state={visualState} aria-label="远程工作区连接状态">
      <div className="connection-boot-panel">
        <div className="connection-boot-brand" aria-hidden="true">
          <img src="/portal-logo.svg" width="24" height="24" alt="" />
          <span>PORTAL</span>
          <span className="connection-boot-brand-caption">远程工作区</span>
        </div>
        <div className="connection-boot-scene" aria-hidden="true">
          <span className="connection-boot-halo" />
          <svg className="connection-boot-art" viewBox="0 0 360 190" fill="none" focusable="false">
            <g className="connection-boot-circuit">
              <path d="M264 73h25l15-15h45M264 117h25l15 15h45M271 95h64" />
              <circle cx="349" cy="58" r="2.5" />
              <circle cx="349" cy="132" r="2.5" />
              <circle cx="335" cy="95" r="2.5" />
            </g>
            <path className="connection-boot-energy is-output" d="M264 73h25l15-15h45" pathLength="100" />
            <path className="connection-boot-energy is-output" d="M264 117h25l15 15h45" pathLength="100" />
            <path className="connection-boot-energy is-output" d="M271 95h64" pathLength="100" />
            <g className="connection-boot-plug">
              <path className="connection-boot-cable-shadow" d="M-35 122C24 122 32 95 73 95h21" />
              <path className="connection-boot-cable" d="M-35 122C24 122 32 95 73 95h21" />
              <path className="connection-boot-cable-highlight" d="M-35 120C24 120 32 93 73 93h21" />
              <path className="connection-boot-energy is-input" d="M-35 122C24 122 32 95 73 95h25" pathLength="100" />
              <rect className="connection-boot-plug-collar" x="83" y="82" width="17" height="26" rx="5" />
              <path className="connection-boot-plug-body" d="M99 72h29l13 6h18v34h-18l-13 6H99a7 7 0 0 1-7-7V79a7 7 0 0 1 7-7Z" />
              <path className="connection-boot-plug-highlight" d="M100 77h27l12 6M100 113h27l12-6" />
              <path className="connection-boot-plug-grip" d="M105 84v22m7-22v22m7-22v22" />
              <path className="connection-boot-plug-tip" d="M159 79h27l12 5v22l-12 5h-27Z" />
              <path className="connection-boot-plug-pins" d="M168 84v22m7-22v22m7-22v22m7-20v18" />
            </g>
            <g className="connection-boot-socket">
              <rect className="connection-boot-socket-shadow" x="208" y="53" width="68" height="86" rx="10" />
              <rect className="connection-boot-socket-body" x="206" y="51" width="68" height="86" rx="10" />
              <path className="connection-boot-socket-detail" d="M220 59h41M220 129h41" />
              <circle className="connection-boot-screw" cx="262" cy="66" r="2" />
              <circle className="connection-boot-screw" cx="262" cy="122" r="2" />
              <rect className="connection-boot-socket-bezel" x="191" y="64" width="51" height="62" rx="7" />
              <rect className="connection-boot-socket-opening" x="198" y="71" width="37" height="48" rx="3" />
              <path className="connection-boot-socket-detail" d="M220 79h8M220 111h8" />
              <circle className="connection-boot-socket-light" cx="261" cy="95" r="3" />
            </g>
            <path className="connection-boot-socket-rim" d="M198 64a7 7 0 0 0-7 7v48a7 7 0 0 0 7 7" />
          </svg>
        </div>
        <div className="connection-boot-status" role="status" aria-live="polite" aria-atomic="true">
          <div className="connection-boot-copy">
            <h1>{title}</h1>
            <strong title={connection?.name || connection?.host || '远程服务器'}>
              {connection?.name || connection?.host || '远程服务器'}
            </strong>
            <p>{message}</p>
          </div>
          <ul className="connection-boot-stages" aria-label="连接初始化状态">
            {stages.map(stage => (
              <li className={`connection-boot-stage is-${ stage.state }`} key={stage.key}>
                <span className="connection-boot-stage-indicator" aria-hidden="true" />
                <span className="connection-boot-stage-label">{stage.label}</span>
                <span className="connection-boot-stage-status">
                  {describeStage(stage.state, stage.activeLabel, stage.waitingLabel)}
                </span>
              </li>
            ))}
          </ul>
        </div>
        {(sessionError || sessionIdle) && (
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
