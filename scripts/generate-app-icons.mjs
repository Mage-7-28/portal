/**
 * 从 Icon Composer 图层生成应用内标志、原生材质资源及桌面平台静态回退图标。
 * 需要 macOS、Xcode 27 的 Icon Composer 和项目安装的 Tauri CLI。
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const icons = path.join(root, 'src-tauri/icons')
const documentPath = path.join(icons, 'Portal.icon')
const document = JSON.parse(readFileSync(path.join(documentPath, 'icon.json'), 'utf8'))
const layers = document.groups.flatMap(group => group.layers)
const nativeResource = path.join(icons, 'Assets.car')
const nativeSources = [
  path.join(documentPath, 'icon.json'),
  ...layers.map(layer => path.join(documentPath, 'Assets', layer['image-name']))
]
// 与常规增量构建一致：源文件更新才重新编译，避免无变化时反复调用 Xcode 工具。
const nativeCompilationNeeded = process.argv.includes('--force-native') || !existsSync(nativeResource)
  || nativeSources.some(source => statSync(source).mtimeMs > statSync(nativeResource).mtimeMs)

/**
 * 提取原始 SVG 图层，避免为应用内标志维护第二套图形。
 * 当前标志与原生图标采用相同画布；如在 Icon Composer 中变换图层，须同步调整此处。
 * @param {string} name Icon Composer 中的图层名称
 * @returns {string} SVG 图层的内部内容
 */
function readMarkLayer(name) {
  const layer = layers.find(item => item.name === name)
  if (!layer || layer.hidden || layer.position?.scale !== 1 ||
      layer.position?.['translation-in-points']?.some(value => value !== 0)) {
    throw new Error(`标志图层不存在、已隐藏或经过变换：${ name }`)
  }

  const source = readFileSync(path.join(documentPath, 'Assets', layer['image-name']), 'utf8')
  const content = source.match(/^<svg\b[^>]*>([\s\S]*)<\/svg>\s*$/)
  if (!content) throw new Error(`无效的 SVG 图层：${ layer['image-name'] }`)
  return content[1].trim()
}

/**
 * 固定 Tauri CLI 生成的 ICNS 块顺序；不同进程的哈希表遍历顺序可能不同。
 * @param {Buffer} data 原始 ICNS 数据
 * @returns {Buffer} 保留全部图像数据且顺序稳定的 ICNS 数据
 */
function canonicalizeIcns(data) {
  if (data.length < 8 || data.toString('ascii', 0, 4) !== 'icns' || data.readUInt32BE(4) !== data.length) {
    throw new Error('Tauri CLI 生成了无效的 ICNS 文件')
  }
  const chunks = []
  for (let offset = 8; offset < data.length;) {
    if (offset + 8 > data.length) throw new Error('ICNS 图像块头不完整')
    const size = data.readUInt32BE(offset + 4)
    if (size < 8 || offset + size > data.length) throw new Error('ICNS 图像块长度无效')
    chunks.push(data.subarray(offset, offset + size))
    offset += size
  }
  return Buffer.concat([ data.subarray(0, 8), ...chunks.sort(Buffer.compare) ])
}

const mark = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
  <!-- 由 scripts/generate-app-icons.mjs 从 Icon Composer 图层生成。 -->
  ${ readMarkLayer('Refractive gateway') }
  ${ readMarkLayer('Inner light') }
</svg>
`

const temporary = mkdtempSync(path.join(tmpdir(), 'portal-app-icons-'))
try {
  // 使用独立的非隐藏目录，避免原生工具依赖工作区或打包器中间目录的布局。
  const copiedDocument = path.join(temporary, 'Portal.icon')
  cpSync(documentPath, copiedDocument, { recursive: true })
  const actool = execFileSync('xcrun', [ '--find', 'actool' ], { encoding: 'utf8' }).trim()
  const ictool = path.resolve(path.dirname(actool), '../../../Applications/Icon Composer.app/Contents/Executables/ictool')
  const rendered = path.join(temporary, 'rendered.png')
  execFileSync(ictool, [
    copiedDocument, '--export-image', '--output-file', rendered,
    '--platform', 'macOS', '--rendition', 'Default', '--width', '1024', '--height', '1024',
    '--scale', '1', '--design-generation', '27'
  ], { stdio: 'inherit' })

  // 原生资源独立于打包器编译；失败时不会覆盖已验证的资源。
  const nativeOutput = path.join(temporary, 'native')
  if (nativeCompilationNeeded) {
    mkdirSync(nativeOutput)
    execFileSync('xcrun', [ 'actool',
      copiedDocument, '--compile', nativeOutput,
      '--output-format', 'human-readable-text', '--notices', '--warnings',
      '--output-partial-info-plist', path.join(nativeOutput, 'icon-info.plist'),
      '--app-icon', 'Portal', '--include-all-app-icons',
      '--enable-on-demand-resources', 'NO', '--development-region', 'en',
      '--target-device', 'mac', '--minimum-deployment-target', '26.0', '--platform', 'macosx'
    ], { stdio: 'inherit' })
  } else {
    console.log('原生图标源未变化，复用已编译的 Assets.car；使用 --force-native 可强制重新编译。')
  }

  // ictool 导出的原生图标占满画布；macOS 静态图标网格需要四周留白。
  const data = readFileSync(rendered).toString('base64')
  const padded = path.join(temporary, 'padded.svg')
  writeFileSync(padded, `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024"><image x="102" y="102" width="820" height="820" href="data:image/png;base64,${ data }"/></svg>`)

  const output = path.join(temporary, 'icons')
  execFileSync(path.join(root, 'node_modules/.bin/tauri'), [ 'icon', padded, '--output', output ], { stdio: 'inherit' })
  const icns = canonicalizeIcns(readFileSync(path.join(output, 'icon.icns')))
  for (const name of [ '32x32.png', '128x128.png', '128x128@2x.png', 'icon.icns', 'icon.ico' ]) {
    if (name === 'icon.icns') writeFileSync(path.join(icons, name), icns)
    else copyFileSync(path.join(output, name), path.join(icons, name))
  }
  if (nativeCompilationNeeded) copyFileSync(path.join(nativeOutput, 'Assets.car'), nativeResource)
  writeFileSync(path.join(root, 'public/portal-logo.svg'), mark)
  console.log('已从 Portal.icon 生成应用内标志、原生材质资源和桌面平台静态图标。')
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
