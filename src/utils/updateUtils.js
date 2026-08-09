const UPDATE_API_URL = 'https://gitee.com/api/v5/repos/Mage-7-28/portal/releases/latest'

// Gitee 当前 API 未稳定提供可直接打开的 Release 详情地址，使用固定的发行版列表页。
export const UPDATE_RELEASES_URL = 'https://gitee.com/Mage-7-28/portal/releases'

const VERSION_PATTERN = /^(?:v)?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/i
const REQUEST_TIMEOUT_MS = 8_000

const compareNumericIdentifiers = (left, right) => {
  if (left.length !== right.length) return left.length > right.length ? 1 : -1
  if (left === right) return 0
  return left > right ? 1 : -1
}

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

const comparePrereleaseIdentifiers = (left, right) => {
  const leftNumeric = /^\d+$/.test(left)
  const rightNumeric = /^\d+$/.test(right)

  if (leftNumeric && rightNumeric) return compareNumericIdentifiers(left, right)
  if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1
  if (left === right) return 0
  return left < right ? -1 : 1
}

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
 */
export const compareVersions = (left, right) => {
  const leftVersion = parseVersion(left)
  const rightVersion = parseVersion(right)
  if (!leftVersion || !rightVersion) return null
  return compareParsedVersions(leftVersion, rightVersion)
}

/**
 * 请求最新 Release。检查失败由调用方决定是否记录日志或提示用户；更新检查不应阻塞应用启动。
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
