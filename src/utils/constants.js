/**
 * 前端共享常量、状态枚举和跨边界错误转换。
 * 这里的值同时服务 React UI、Tauri IPC 和本地持久化，不应在组件中重复定义。
 */
import PubSub from 'pubsub-js'

// 跨平台字体回退链，优先使用应用字体，缺失时回退到 macOS、Windows、Linux 常见字体。
export const GlobalFontFamily = '"Lora Variable", "Lora", "Source Serif Pro", "Source Serif 4", "Noto Serif SC", "Noto Serif TC", "Noto Serif JP", "Noto Serif KR", "Source Han Serif SC", "Source Han Serif TC", "Source Han Serif", "Songti SC", "STSong", "STSongti-SC-Regular", "PingFang SC", "SimSun", "NSimSun", "宋体", "FangSong", "仿宋", "KaiTi", "楷体", Georgia, "Times New Roman", Cambria, "Liberation Serif", ui-serif, serif'

// Tauri Store 使用的稳定键名；新增键必须同步考虑版本迁移和默认值。
export const StoreKeys = {
  DOWNLOAD_PATH: 'download_path',
  SSH_CONNECTIONS: 'ssh_connections',
  SSH_CONNECTIONS_REVISION: 'ssh_connections_revision',
  STORE_VERSION: 'store_version',
  UPDATE_SKIPPED_VERSION: 'update_skipped_version',
  SHOW_HIDDEN_FILES: 'show_hidden_files',
  TERMINAL_FONT_SIZE: 'terminal_font_size',
  WORKSPACE_LAYOUTS: 'workspace_layouts'
}

// PubSub 传输状态总线的主题和发送入口。
export const PubSubBusinessKeyEnum = {
  MASK: 'mask',
  SEND_MASK: (data) => PubSub.publish('mask', data)
}

// 以 1024 为进位的文件大小单位，前端显示和目录统计共用。
const FileSizeUnits = [ 'B', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB' ]

/**
 * 将字节数格式化为适合列表展示的二进制单位。
 *
 * @param {number} bytes - 要格式化的字节数。
 * @param {number} [decimals=2] - 小数位数；负数会按 0 处理。
 * @returns {string} 带单位的用户可读大小，例如 `1.5 MB`。
 */
export const formatFileSize = (bytes, decimals = 2) => {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'

  const unitIndex = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), FileSizeUnits.length - 1)
  const value = bytes / Math.pow(1024, unitIndex)
  return `${ parseFloat(value.toFixed(Math.max(0, decimals))) } ${ FileSizeUnits[unitIndex] }`
}

// 前端连接生命周期状态，名称需与连接管理器和 UI loading 分支保持一致。
export const SftpConnectionStatus = {
  DISCONNECTED: 'disconnected',
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  RECONNECTING: 'reconnecting',
  ERROR: 'error'
}

// SSH 连接与进度节流的跨模块保护参数。
export const CONNECTION_TIMEOUT_MS = 30_000
export const PROGRESS_UPDATE_INTERVAL_MS = 100

// Ant Design 调色板使用兼容的十六进制强调色。
export const THEME_PRIMARY_COLOR_FALLBACK = '#eb9070'
// 基于 IDEA 深色新界面的炭灰分层：画布、岛屿面板和浮层保持明确层级。
export const THEME_BG_PRIMARY = '#1e1f22'
export const THEME_BG_SECONDARY = '#2b2d30'
export const THEME_BG_INPUT = '#313438'
export const THEME_BORDER_COLOR = '#45474d'
export const THEME_TEXT_PRIMARY = '#e6e8eb'
export const THEME_TEXT_SECONDARY = '#a9adb6'
export const THEME_TEXT_LINK = '#67c7d1'
export const THEME_SUCCESS = '#8fb996'
export const THEME_WARNING = '#d0a965'
export const THEME_DANGER = '#d86f6f'

// 摘要只用于展示；业务分类继续读取原始错误码，不能匹配翻译后的文案。
const ERROR_SUMMARIES = {
  ConnectionNotFound: '连接已失效，请重新连接服务器',
  ConnectionGenerationChanged: '连接会话已更新，请重新操作',
  ConnectionFailed: '无法连接服务器，请检查地址、端口和网络',
  HandshakeFailed: 'SSH 握手失败，请检查服务器协议配置',
  AuthFailed: '认证失败，请检查账户和密码',
  AuthFailedUnknown: '认证失败，请检查账户和密码',
  UnsupportedAuth: '当前认证方式不受支持',
  HostKeyVerificationRequired: '请先确认服务器主机指纹',
  HostKeyMismatch: '服务器指纹发生变化，请核实服务器身份',
  PermissionDenied: '没有访问权限，请检查账户和目标目录权限',
  FileOperationFailed: '文件操作失败，请查看错误详情',
  ReadDirFailed: '无法读取目录，请检查权限或重新刷新',
  ReadFailed: '读取远程数据失败',
  SftpFailed: 'SFTP 通道暂不可用，请重试或重新连接',
  InvalidTargetPath: '目标路径无效，请检查路径',
  TargetExists: '目标已存在，请确认是否覆盖',
  TargetNameCollision: '目标名称冲突，请更换名称',
  UnsupportedFilesystem: '文件系统不支持所需的安全操作',
  ArchiveUnsupported: '服务器不支持安全归档传输',
  AtomicRenameUnsupported: '服务器不支持安全覆盖',
  SourceChanged: '源文件发生变化，请刷新后重试',
  CommitOutcomeUnknown: '提交结果待核对，请刷新确认后再操作',
  DeleteVerificationFailed: '目标仍存在，未能确认删除完成',
  TransferOutcomeUnknown: '操作结果待核对，请刷新确认后再操作',
  OutcomeUnknown: '操作结果待核对，请刷新确认后再操作',
  TransferStateUnavailable: '无法获取任务结果，请刷新确认后再操作',
  TransferCancelled: '操作已取消',
  TransferStartExpired: '任务启动请求已过期，未执行该请求',
  TransferRejected: '任务未能启动，请查看错误详情',
  TaskStartFailed: '后台任务启动失败，请稍后重试',
  BackgroundBusy: '后台任务已达到并发上限，请稍后重试',
  DirectorySizeCancelled: '目录大小统计已取消',
  DirectorySizeLimitReached: '目录大小统计任务已达到上限',
  PreviewTooLarge: '文件超过预览大小限制，请下载后查看',
  PreviewCancelled: '文件预览已取消',
  MonitorUnavailable: '服务器监控暂不可用',
  TerminalNotFound: '终端会话已结束',
  TerminalInputTooLong: '终端输入超过大小限制',
  TerminalFailed: '终端会话发生错误，请查看详情'
}

/** 只提取错误码和说明，不序列化可能包含凭据的请求或连接对象。 */
export const getErrorDetails = (error) => {
  if (!error) return ''
  if (typeof error === 'string') {
    try {
      const parsed = JSON.parse(error)
      if (parsed && typeof parsed === 'object') return getErrorDetails(parsed)
    } catch {
      // 普通文本保留为诊断信息。
    }
    return error
  }
  if (error.code === 'HostKeyMismatch') {
    // 仅允许已知的指纹字段通过，绝不展开连接配置或凭据对象。
    const fingerprints = error.message && typeof error.message === 'object' ? error.message : error
    return [
      'HostKeyMismatch',
      typeof fingerprints.expected === 'string' ? `已保存指纹：${ fingerprints.expected }` : '',
      typeof fingerprints.actual === 'string' ? `当前指纹：${ fingerprints.actual }` : ''
    ].filter(Boolean).join('\n')
  }
  const message = typeof error.message === 'string' ? error.message
    : typeof error.message?.message === 'string' ? error.message.message
      : typeof error.details === 'string' ? error.details : ''
  const code = typeof error.code === 'string' ? error.code : ''
  return [ code, message ].filter(Boolean).join('：')
}

/**
 * 将跨边界错误转换为中文摘要；原始诊断通过 getErrorDetails 单独展示。
 *
 * @param {unknown} error - 原始异常或 IPC 错误负载。
 * @returns {string} 不改变现有字符串返回契约的用户提示。
 */
export const normalizeError = (error) => {
  const code = getErrorCode(error)
  if (ERROR_SUMMARIES[code]) return ERROR_SUMMARIES[code]
  const detail = getErrorDetails(error)
  if (!detail) return '未知错误'
  if (/[\u3400-\u9fff]/.test(detail)) return detail
  if (/permission denied|access denied/i.test(detail)) return ERROR_SUMMARIES.PermissionDenied
  if (/timed? ?out|timeout/i.test(detail)) return '操作超时，请检查网络后重试'
  if (/connection refused|network unreachable/i.test(detail)) return ERROR_SUMMARIES.ConnectionFailed
  return '操作失败，请查看错误详情'
}

/**
 * 从 Tauri 序列化错误或普通错误对象中提取错误码。
 *
 * @param {unknown} error - 原始异常或 IPC 错误负载。
 * @returns {string} 错误码；不存在或无法解析时返回空字符串。
 */
export const getErrorCode = (error) => {
  if (!error) return ''
  if (typeof error === 'string') {
    try {
      return getErrorCode(JSON.parse(error))
    } catch {
      return ''
    }
  }
  return typeof error.code === 'string' ? error.code : ''
}

/**
 * 判断错误是否属于用户名、密码或认证权限问题。
 *
 * @param {unknown} error - 待分类的原始异常或 IPC 错误负载。
 * @returns {boolean} 错误表明认证凭据无效时返回 true。
 */
export const isCredentialError = (error) => {
  const normalized = getErrorDetails(error).toLowerCase()
  if (normalized.includes('用户名不能为空')) return false
  return normalized.includes('authfailed')
    || normalized.includes('authentication failed')
    || normalized.includes('auth failed')
    || normalized.includes('认证失败')
    || normalized.includes('password')
    || normalized.includes('permission denied')
}

/**
 * 将底层 SSH 错误转换成用户可以直接处理的提示。
 *
 * @param {unknown} error - 原始 SSH、Tauri IPC 或网络错误。
 * @returns {string} 不暴露 libssh2 实现细节的用户可读连接错误。
 */
export const getReadableConnectionError = (error) => {
  const normalized = getErrorDetails(error).toLowerCase()

  if (normalized.includes('用户名不能为空')) {
    return '用户名不能为空，请检查连接配置'
  }
  if (normalized.includes('hostkeymismatch') || normalized.includes('主机密钥不匹配')) {
    return '服务器指纹发生变化，请确认服务器身份后重试'
  }
  if (normalized.includes('hostkeyverificationrequired') || normalized.includes('主机密钥需要确认')) {
    return '服务器需要确认主机指纹，请重新连接并确认服务器身份'
  }
  if (isCredentialError(error)) {
    return '账户密码错误，请检查后重试'
  }
  if (normalized.includes('unsupportedauth') || normalized.includes('认证方式不支持')) {
    return '当前认证方式不可用，请检查认证配置'
  }
  if (
    normalized.includes('timeout')
    || normalized.includes('timed out')
    || normalized.includes('超时')
  ) {
    return '连接超时，请检查服务器地址、端口和网络'
  }
  if (
    normalized.includes('connectionfailed')
    || normalized.includes('connection refused')
    || normalized.includes('拒绝连接')
    || normalized.includes('无法连接到服务器')
  ) {
    return '无法连接服务器，请检查地址、端口和 SSH 服务'
  }
  if (
    normalized.includes('handshakefailed')
    || normalized.includes('握手失败')
  ) {
    return 'SSH 握手失败，请检查服务器地址、端口和协议配置'
  }
  if (normalized.includes('connectionnotfound') || normalized.includes('连接不存在')) {
    return '连接已失效，请重新连接服务器'
  }
  return '连接失败，请检查服务器地址、端口和认证信息'
}

export const msgBoxStyle = {
  background: THEME_BG_SECONDARY,
  color: THEME_TEXT_PRIMARY,
  border: `1px solid ${ THEME_BORDER_COLOR }`,
  fontSize: '14px'
}
