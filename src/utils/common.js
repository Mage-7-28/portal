/**
 * 业务常量与工具函数
 * @deprecated 请优先从 ./constants.js 导入常量，本文件保留用于向后兼容
 *
 * 新代码请直接导入：
 *   import { StoreKeys, GlobalFontFamily, formatFileSize } from './constants'
 */

// ============================================================================
// 从 constants.js 重导出所有常量（保持向后兼容）
// ============================================================================

export {
  GlobalFontFamily,
  StoreKeys,
  PubSubBusinessKeyEnum,
  FileSizeUnits,
  formatFileSize,
  SftpConnectionStatus,
  layoutStyle,
  msgBoxStyle,
  headerStyle,
  contentStyle,
  footerStyle,
  CONNECTION_TIMEOUT_MS,
  TRANSFER_BUFFER_SIZE,
  PROGRESS_UPDATE_INTERVAL_MS,
  UI_DELAY_MS,
  THEME_PRIMARY_COLOR,
  THEME_BG_PRIMARY,
  THEME_BG_SECONDARY,
  THEME_BG_INPUT,
  THEME_BORDER_COLOR,
  THEME_TEXT_PRIMARY,
  THEME_TEXT_SECONDARY,
  THEME_TEXT_LINK,
  THEME_SUCCESS,
  THEME_DANGER,
  PROGRESS_GRADIENT,
  WINDOW_DEFAULT_WIDTH,
  WINDOW_DEFAULT_HEIGHT,
  WINDOW_MIN_WIDTH,
  WINDOW_MIN_HEIGHT,
  ENCRYPTION_KEY,
  encryptData,
  decryptData
} from './constants'

// ============================================================================
// 以下为原有加密工具函数（已迁移至 constants.js，本文件保留避免大规模重构）
// ============================================================================

import CryptoJS from 'crypto-js'
import {
  ENCRYPTION_KEY,
  encryptData,
  decryptData
} from './constants'

// 保留原有导入引用（内部使用 constants.js 中的实现）
export { ENCRYPTION_KEY, encryptData, decryptData }