import React from 'react'

// 本地图标路径集中维护，保证桌面端离线可用，也避免业务组件直接依赖外部图标资源。
// 后续如需接入已确认授权的 SVG，只需要替换这里的路径，业务组件无需改动。
const FILE_FRAME = (
  <>
    <path d="M6.5 3.5h7l4 4v12.5h-11a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1z" />
    <path d="M13.5 3.5v4.2h4.2" />
  </>
)

const ICON_PATHS = {
  plus: (
    <>
      <path d="M12 5v14M5 12h14" />
    </>
  ),
  server: (
    <>
      <rect x="4" y="4" width="16" height="6" rx="1.5" />
      <rect x="4" y="14" width="16" height="6" rx="1.5" />
      <path d="M7 7h.01M7 17h.01M10 7h7M10 17h7" />
    </>
  ),
  ssh: (
    <>
      <rect x="3.5" y="5" width="17" height="13.5" rx="2" />
      <path d="M7 9.5 10 12l-3 2.5M12.5 14.5h4" />
      <path d="M8 3.5h8" />
    </>
  ),
  terminal: (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
      <path d="m7 9.5 3 2.5-3 2.5M12.5 14.5h4" />
    </>
  ),
  trash: (
    <>
      <path d="M7.5 7.5h9l-.8 11.2a2 2 0 0 1-2 1.8h-3.4a2 2 0 0 1-2-1.8z" fill="currentColor" fillOpacity=".16" />
      <path d="M5 7.5h14M8 7.5l1-3h6l1 3M10.2 11v5.5M13.8 11v5.5" />
    </>
  ),
  stop: <rect x="6" y="6" width="12" height="12" rx="1.5" />,
  download: (
    <>
      <path d="M12 3v11M7 10l5 5 5-5M5 20h14" />
    </>
  ),
  upload: (
    <>
      <path d="M12 21V10M7 14l5-5 5 5M5 4h14" />
    </>
  ),
  file: (
    <>{FILE_FRAME}<path d="M9 13h6M9 17h6" /></>
  ),
  fileImage: (
    <>
      {FILE_FRAME}
      <circle cx="15.5" cy="12" r="1.2" />
      <path d="m8.5 17 2.8-3 2 2 1.4-1.4 2.8 2.4" />
    </>
  ),
  fileJson: (
    <>
      {FILE_FRAME}
      <path d="M11 11c-1 0-1.5.6-1.5 1.5S10 14 11 14M13 11c1 0 1.5.6 1.5 1.5S14 14 13 14" />
    </>
  ),
  fileStyle: (
    <>
      {FILE_FRAME}
      <path d="M9 12h6M9 15h4M9 18h6" />
      <path d="M9 9h6" />
    </>
  ),
  fileJavaScript: (
    <>
      {FILE_FRAME}
      <path d="m14 10-3 4h2l-1 3 4-5h-2z" />
    </>
  ),
  fileTypeScript: (
    <>
      {FILE_FRAME}
      <path d="M9 11h5M11.5 11v5M14.5 14.5c.8 1 2.5 1 2.5 0 0-.8-.6-1-1.3-1.2-.7-.2-1.2-.4-1.2-1.1 0-.8 1.1-1.2 2-.4" />
    </>
  ),
  fileMarkup: (
    <>
      {FILE_FRAME}
      <path d="m10.5 11-2 2 2 2M13.5 11l2 2-2 2M12.5 10.5l-1 5" />
    </>
  ),
  fileCode: (
    <>
      {FILE_FRAME}
      <path d="m10 11-2 2 2 2M14 11l2 2-2 2" />
    </>
  ),
  fileArchive: (
    <>
      {FILE_FRAME}
      <path d="M10 9h4M10 12h4M10 15h4M10 18h4" />
      <path d="M12 8v2M12 11v2M12 14v2M12 17v1" />
    </>
  ),
  fileJava: (
    <>
      {FILE_FRAME}
      <path d="m9 12 3-2 3 2-3 2zM9 12v3l3 2 3-2v-3M12 14v3" />
    </>
  ),
  filePdf: (
    <>
      {FILE_FRAME}
      <path d="M9 12h6M9 15h5M9 18h4" />
      <path d="M9 9h3" />
    </>
  ),
  fileMedia: (
    <>
      {FILE_FRAME}
      <circle cx="12.5" cy="14" r="3" />
      <path d="m12 12.5 2 1.5-2 1.5z" />
    </>
  ),
  fileAudio: (
    <>
      {FILE_FRAME}
      <path d="M11 17V11l5-1v6" />
      <ellipse cx="10" cy="17" rx="2" ry="1.5" />
      <ellipse cx="15" cy="16" rx="2" ry="1.5" />
    </>
  ),
  fileFont: (
    <>
      {FILE_FRAME}
      <path d="m9 17 2.5-7L14 17M10 14h3M15 12h2M16 12v5" />
    </>
  ),
  fileData: (
    <>
      {FILE_FRAME}
      <path d="M9 11h6M9 14h6M9 17h4" />
      <circle cx="16.5" cy="17" r=".7" />
    </>
  ),
  fileDocument: (
    <>
      {FILE_FRAME}
      <path d="M9 11h6M9 14h6M9 17h6" />
    </>
  ),
  fileDatabase: (
    <>
      {FILE_FRAME}
      <ellipse cx="12.5" cy="11" rx="3" ry="1.4" />
      <path d="M9.5 11v5c0 .8 1.3 1.4 3 1.4s3-.6 3-1.4v-5M9.5 13.5c0 .8 1.3 1.4 3 1.4s3-.6 3-1.4" />
    </>
  ),
  folder: (
    <>
      <path d="M3.5 8a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v8.5a1.5 1.5 0 0 1-1.5 1.5h-14A1.5 1.5 0 0 1 4 18.5z" />
      <path d="M4 10h16.5" />
    </>
  ),
  folderOpen: (
    <>
      <path d="M3.5 8.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v1h-14z" />
      <path d="m3.5 11.5 1.4 6.1a2 2 0 0 0 2 1.5h10.4a2 2 0 0 0 1.9-1.4l1.8-5.2H3.5z" />
    </>
  ),
  folderAdd: (
    <>
      <path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />
      <path d="M12 10.5v6M9 13.5h6" />
    </>
  ),
  chevronDown: <path d="m6 9 6 6 6-6" />,
  chevronUp: <path d="m6 15 6-6 6 6" />,
  reload: (
    <>
      <path d="M19 8a7 7 0 1 0 1 5" />
      <path d="M19 4v4h-4" />
    </>
  ),
  externalLink: (
    <>
      <path d="M14 5h5v5" />
      <path d="m13 11 6-6" />
      <path d="M19 13v5a1.5 1.5 0 0 1-1.5 1.5h-12A1.5 1.5 0 0 1 4 18V6.5A1.5 1.5 0 0 1 5.5 5H10" />
    </>
  ),
  disconnect: (
    <>
      <path d="M9 3v4M15 3v4M7 7h10v2a5 5 0 0 1-10 0zM12 14v7" />
    </>
  ),
  inbox: (
    <>
      <path d="M4 5h16v14H4z" />
      <path d="M4 14h4l1.5 2h5L16 14h4" />
    </>
  ),
  edit: (
    <>
      <path d="m4 16.5-.5 4 4-.5L18.7 8.8l-3.5-3.5z" />
      <path d="m13.5 7.5 3.5 3.5" />
    </>
  ),
  wifi: (
    <>
      <path d="M3 9a14 14 0 0 1 18 0M6 13a9 9 0 0 1 12 0M9.5 17a4 4 0 0 1 5 0" />
      <path d="M12 21h.01" />
    </>
  ),
  lock: (
    <>
      <rect x="5" y="10" width="14" height="10" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v2" />
    </>
  ),
  key: (
    <>
      <circle cx="8" cy="15" r="4" />
      <path d="m11 12 8-8M15 8l2 2M17 6l2 2" />
    </>
  ),
  user: (
    <>
      <circle cx="12" cy="8" r="3.5" />
      <path d="M5 20a7 7 0 0 1 14 0" />
    </>
  ),
  checkCircle: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="m8 12 2.5 2.5L16 9" />
    </>
  ),
  warningCircle: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 8v5M12 16.5h.01" />
    </>
  ),
  eye: (
    <>
      <path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6z" />
      <circle cx="12" cy="12" r="2.5" />
    </>
  ),
  eyeOff: (
    <>
      <path d="m3 3 18 18M10.6 6.2A10.9 10.9 0 0 1 12 6c6 0 9.5 6 9.5 6a16.7 16.7 0 0 1-3.1 3.7M6.2 6.8C3.8 8.4 2.5 12 2.5 12s3.5 6 9.5 6c.8 0 1.6-.1 2.3-.3" />
      <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
    </>
  )
}

const AppIcon = ({ name, className = '', size = '1em', title, ...props }) => {
  const content = ICON_PATHS[name] || ICON_PATHS.file
  const labelled = Boolean(title)
  return (
    <svg
      className={`app-icon${ className ? ` ${ className }` : '' }`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={labelled ? undefined : 'true'}
      aria-label={labelled ? title : undefined}
      role={labelled ? 'img' : undefined}
      focusable="false"
      {...props}
    >
      {labelled && <title>{title}</title>}
      {content}
    </svg>
  )
}

export default AppIcon
