// 文件扩展名到图标类型的映射，统一用于远程文件列表和上传待选列表。
const FILE_EXTENSION_TYPES = {
  image: [ 'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'tif', 'tiff', 'ico', 'avif', 'heic' ],
  json: [ 'json', 'json5', 'jsonl', 'map' ],
  style: [ 'css', 'scss', 'sass', 'less', 'styl' ],
  javascript: [ 'js', 'mjs', 'cjs', 'jsx' ],
  typescript: [ 'ts', 'tsx', 'mts', 'cts' ],
  markup: [ 'html', 'htm', 'xhtml', 'xml', 'vue', 'svelte' ],
  code: [ 'java', 'kt', 'kts', 'py', 'rb', 'rs', 'go', 'c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'cs', 'php' ],
  data: [ 'yaml', 'yml', 'toml', 'ini', 'conf', 'cfg', 'env', 'properties', 'csv', 'tsv', 'sql' ],
  document: [ 'txt', 'log', 'md', 'markdown', 'rst', 'rtf', 'doc', 'docx', 'odt', 'xls', 'xlsx', 'ppt', 'pptx' ],
  database: [ 'db', 'sqlite', 'sqlite3' ],
  java: [ 'jar', 'war', 'ear', 'aar' ],
  archive: [ 'zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar', 'zst', 'apk', 'deb', 'rpm', 'dmg', 'msi' ],
  pdf: ['pdf'],
  media: [ 'mp4', 'mov', 'avi', 'mkv', 'webm' ],
  audio: [ 'mp3', 'wav', 'flac', 'ogg', 'm4a', 'aac' ],
  font: [ 'ttf', 'otf', 'woff', 'woff2', 'eot' ]
}

// 业务文件类型到 AppIcon 语义名称的映射；没有专用图标时统一回退到 file。
const FILE_ICON_NAMES = {
  image: 'fileImage',
  json: 'fileJson',
  style: 'fileStyle',
  javascript: 'fileJavaScript',
  typescript: 'fileTypeScript',
  markup: 'fileMarkup',
  code: 'fileCode',
  data: 'fileData',
  document: 'fileDocument',
  database: 'fileDatabase',
  archive: 'fileArchive',
  java: 'fileJava',
  pdf: 'filePdf',
  media: 'fileMedia',
  audio: 'fileAudio',
  font: 'fileFont'
}

// 将分组数组展平成扩展名索引，渲染时只需一次 O(1) 查找。
const FILE_TYPE_BY_EXTENSION = Object.entries(FILE_EXTENSION_TYPES).reduce((result, [ type, extensions ]) => {
  extensions.forEach(extension => {
    result[extension] = type
  })
  return result
}, {})

/**
 * 根据扩展名返回业务图标名称和文件类型。
 *
 * @param {string} [fileName=''] - 文件名或完整路径；扩展名比较不区分大小写。
 * @returns {{name: string, type: string}} 图标组件名称和用于样式分类的文件类型。
 */
export const resolveFileIcon = (fileName = '') => {
  const extension = String(fileName).toLowerCase().split('.').pop() || ''
  const type = FILE_TYPE_BY_EXTENSION[extension] || 'generic'
  return {
    name: FILE_ICON_NAMES[type] || 'file',
    type
  }
}
