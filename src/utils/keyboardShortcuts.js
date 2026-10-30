/** Portal 中可用快捷键的唯一映射及平台显示格式。 */
export const SHORTCUT_GROUPS = [
  {
    id: 'window',
    title: '窗口与下载',
    description: '从当前活动窗口查看或设置本机下载目录。',
    items: [
      { id: 'showDownloadPath', title: '显示下载路径', keys: { mac: [ '⌘', '⇧', 'L' ], other: [ 'Ctrl', 'Shift', 'L' ]}},
      { id: 'chooseDownloadPath', title: '选择下载路径', keys: { mac: [ '⌘', '⌥', '⇧', 'L' ], other: [ 'Ctrl', 'Alt', 'Shift', 'L' ]}}
    ]
  },
  {
    id: 'files',
    title: '远程文件',
    description: '仅当焦点位于文件浏览区时生效。',
    items: [
      { id: 'upload', title: '打开上传窗口', keys: { mac: [ '⌘', '⇧', 'U' ], other: [ 'Ctrl', 'Shift', 'U' ]}},
      { id: 'newFolder', title: '新建文件夹', keys: { mac: [ '⌘', '⇧', 'N' ], other: [ 'Ctrl', 'Shift', 'N' ]}},
      { id: 'refresh', title: '刷新目录', keys: { mac: ['F5'], other: ['F5']}},
      { id: 'parentDirectory', title: '返回上一级目录', keys: { mac: [ '⌥', '↑' ], other: [ 'Alt', '↑' ]}}
    ]
  },
  {
    id: 'workspace',
    title: '终端与工作区',
    description: '仅当焦点位于当前服务器工作区时生效。',
    items: [
      { id: 'fontDown', title: '缩小终端字号', keys: { mac: [ '⌘', '−' ], other: [ 'Ctrl', '−' ]}},
      { id: 'fontUp', title: '放大终端字号', keys: { mac: [ '⌘', '=' ], other: [ 'Ctrl', '=' ]}},
      { id: 'resetFontSize', title: '重置终端字号', keys: { mac: [ '⌘', '0' ], other: [ 'Ctrl', '0' ]}},
      { id: 'focusMode', title: '切换专注模式', keys: { mac: [ '⌘', '⇧', '↵' ], other: [ 'Ctrl', 'Shift', '↵' ]}}
    ]
  }
]

const shortcutById = new Map(SHORTCUT_GROUPS.flatMap(group => group.items.map(item => [ item.id, item ])))

/** @returns {boolean} 当前 WebView 是否运行在 macOS。 */
export const isMacPlatform = () => /Mac|iPhone|iPad|iPod/i.test(
  globalThis.navigator?.userAgentData?.platform || globalThis.navigator?.platform || globalThis.navigator?.userAgent || ''
)

/** @param {string} id - 快捷键标识。 @returns {string[]} 当前平台显示用的键帽。 */
export const getShortcutKeys = id => {
  const shortcut = shortcutById.get(id)
  return shortcut ? [...(isMacPlatform() ? shortcut.keys.mac : shortcut.keys.other)] : []
}

/** @param {string} id - 快捷键标识。 @returns {string} 当前平台紧凑快捷键标签。 */
export const getShortcutLabel = id => getShortcutKeys(id).join(isMacPlatform() ? '' : '+')
