/**
 * Gitee Release 更新检查与 SemVer 比较工具。
 *
 * 本模块只负责读取最新版本和比较版本号，不执行安装包下载或替换。
 */
const UPDATE_API_URL = 'https://gitee.com/api/v5/repos/Mage-7-28/portal/releases/latest'

export const PROJECT_REPOSITORY_URL = 'https://gitee.com/Mage-7-28/portal'

// Gitee 当前 API 未稳定提供可直接打开的 Release 详情地址，使用固定的发行版列表页。
export const UPDATE_RELEASES_URL = `${ PROJECT_REPOSITORY_URL }/releases`

const VERSION_PATTERN = /^(?:v)?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/i
const REQUEST_TIMEOUT_MS = 8_000

/**
 * @typedef {Object} ParsedVersion
 * @property {string} normalized - 去掉可选 `v` 前缀后的 SemVer 文本。
 * @property {string} major - 主版本数字标识。
 * @property {string} minor - 次版本数字标识。
 * @property {string} patch - 修订版本数字标识。
 * @property {string[]} prerelease - 预发布标识数组；正式版为空数组。
 */

/**
 * @typedef {Object} ReleaseUpdate
 * @property {string} currentVersion - 当前已安装的规范化版本。
 * @property {string} latestVersion - Gitee 最新发行版的规范化版本。
 * @property {string} tagName - Gitee Release 返回的原始标签名。
 * @property {string} releaseUrl - 应在浏览器中打开的发行版列表地址。
 */

/**
 * 比较不含前导零的数字标识，避免直接按字符串排序造成 10 小于 2。
 *
 * @param {string} left - 左侧数字标识。
 * @param {string} right - 右侧数字标识。
 * @returns {-1|0|1} 左侧较小、相等或较大时分别返回 -1、0、1。
 */
const compareNumericIdentifiers = (left, right) => {
  if (left.length !== right.length) return left.length > right.length ? 1 : -1
  if (left === right) return 0
  return left > right ? 1 : -1
}

/**
 * 解析带可选 `v` 前缀和预发布标识的 SemVer。
 *
 * @param {unknown} value - 可能来自 package.json 或 Gitee 标签的版本值。
 * @returns {ParsedVersion|null} 解析成功的版本对象；格式不合法时返回 null。
 */
const parseVersion = (value) => {
  if (typeof value !== 'string') return null

  const normalized = value.trim()
  const match = normalized.match(VERSION_PATTERN)
  if (!match) return null

  return {
    normalized: normalized.replace(/^v/i, ''),
    major: match[1],
    minor: match[2],
    patch: match[3],
    prerelease: match[4] ? match[4].split('.') : []
  }
}

/**
 * 按 SemVer 规则比较两个预发布标识。
 *
 * @param {string} left - 左侧预发布标识。
 * @param {string} right - 右侧预发布标识。
 * @returns {-1|0|1} 左侧较小、相等或较大时分别返回 -1、0、1。
 */
const comparePrereleaseIdentifiers = (left, right) => {
  const leftNumeric = /^\d+$/.test(left)
  const rightNumeric = /^\d+$/.test(right)

  if (leftNumeric && rightNumeric) return compareNumericIdentifiers(left, right)
  if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1
  if (left === right) return 0
  return left < right ? -1 : 1
}

/**
 * 比较两组预发布标识；正式版优先于同主次修订号的预发布版。
 *
 * @param {string[]} left - 左侧预发布标识数组。
 * @param {string[]} right - 右侧预发布标识数组。
 * @returns {-1|0|1} 左侧较小、相等或较大时分别返回 -1、0、1。
 */
const comparePrerelease = (left, right) => {
  if (left.length === 0 && right.length === 0) return 0
  if (left.length === 0) return 1
  if (right.length === 0) return -1

  const count = Math.min(left.length, right.length)
  for (let index = 0; index < count; index += 1) {
    const result = comparePrereleaseIdentifiers(left[index], right[index])
    if (result !== 0) return result
  }

  if (left.length === right.length) return 0
  return left.length > right.length ? 1 : -1
}

/**
 * 比较两个已解析的 SemVer 对象。
 *
 * @param {ParsedVersion} left - 左侧已解析版本。
 * @param {ParsedVersion} right - 右侧已解析版本。
 * @returns {-1|0|1} 左侧较小、相等或较大时分别返回 -1、0、1。
 */
const compareParsedVersions = (left, right) => {
  for (const key of [ 'major', 'minor', 'patch' ]) {
    const result = compareNumericIdentifiers(left[key], right[key])
    if (result !== 0) return result
  }
  return comparePrerelease(left.prerelease, right.prerelease)
}

/**
 * 比较两个 SemVer 版本。返回 null 表示任一版本格式不合法。
 * 支持 Tauri/Git 常见的 v2.1.0 与 2.1.0 写法，并正确处理预发布版本。
 *
 * @param {unknown} left - 左侧版本值。
 * @param {unknown} right - 右侧版本值。
 * @returns {-1|0|1|null} 比较结果；任一版本格式不合法时返回 null。
 */
export const compareVersions = (left, right) => {
  const leftVersion = parseVersion(left)
  const rightVersion = parseVersion(right)
  if (!leftVersion || !rightVersion) return null
  return compareParsedVersions(leftVersion, rightVersion)
}

/**
 * 请求最新 Release。检查失败由调用方决定是否记录日志或提示用户；更新检查不应阻塞应用启动。
 *
 * @param {string} currentVersion - 当前已安装应用的版本号。
 * @returns {Promise<ReleaseUpdate|null>} 存在更高版本时返回更新信息；否则返回 null。
 * @throws {Error} 当本地版本、Release 标签、网络请求或响应状态无效时抛出。
 */
export const checkLatestRelease = async (currentVersion) => {
  const current = parseVersion(currentVersion)
  if (!current) {
    throw new Error(`本地应用版本格式无效：${ currentVersion }`)
  }

  const controller = new globalThis.AbortController()
  const timeoutId = globalThis.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

  try {
    const response = await globalThis.fetch(UPDATE_API_URL, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      signal: controller.signal
    })

    if (!response.ok) {
      throw new Error(`Release 请求失败（HTTP ${ response.status }）`)
    }

    const release = await response.json()
    const tagName = typeof release?.tag_name === 'string' ? release.tag_name.trim() : ''
    const latest = parseVersion(tagName)
    if (!latest) {
      throw new Error('Release 的 tag_name 不是有效的 SemVer 版本')
    }

    if (compareParsedVersions(latest, current) <= 0) return null

    return {
      currentVersion: current.normalized,
      latestVersion: latest.normalized,
      tagName,
      releaseUrl: UPDATE_RELEASES_URL
    }
  } finally {
    globalThis.clearTimeout(timeoutId)
  }
}
