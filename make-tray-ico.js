// 托盘多尺寸 ICO：从白鲸 SVG 逐尺寸原生栅格化，按 ICO 规范（Vista+ PNG 条目）写入。
// 吸收官方 desktop render-tray-icon 的做法：托盘以 16 逻辑像素显示，Windows 按显示
// 缩放（100%–400%）从 ICO 里挑最合适的位图；每个尺寸独立从矢量渲染，而不是缩小
// 一张大位图，各缩放下边缘都清晰。官方的鲸鱼放大 1.2 倍不适用：那是"瓷砖底板 +
// 图形内缩"布局的修正，本启动器是全幅白鲸。
const fs = require('fs')
const path = require('path')

const svgFile = path.join(__dirname, 'assets', 'whale-white.svg')
const outIco = path.join(__dirname, 'assets', 'tray.ico')
// 16px @100% 到 400% 显示缩放（对齐官方 desktop 的 TRAY_ICON_SIZES）
const sizes = [16, 20, 24, 32, 40, 48, 64]

// sharp 借用 DSH 仓库的 pnpm 安装（零新依赖），与 make-icon-ico.js 的解析手法一致
function resolveSharp() {
  const repoDir = path.resolve(__dirname, '..', 'deepseek-harness')
  const pnpmDir = path.join(repoDir, 'node_modules', '.pnpm')
  if (!fs.existsSync(pnpmDir)) return null
  const entry = fs.readdirSync(pnpmDir).find((e) => e.startsWith('sharp@'))
  if (!entry) return null
  const p = path.join(pnpmDir, entry, 'node_modules', 'sharp')
  return fs.existsSync(p) ? require(p) : null
}

const sharp = resolveSharp()
if (!sharp) {
  console.error('找不到 DSH 仓库内的 sharp。请确认 pnpm install 已执行。')
  console.error('预期路径：', path.join('..', 'deepseek-harness', 'node_modules', '.pnpm', 'sharp@*', 'node_modules', 'sharp'))
  process.exit(1)
}

// SVG 的 viewBox 坐标系边长（whale-white.svg 为 "0 0 50 50"）。sharp 的 SVG density
// 以 72 DPI 为基准：density = 72 * size / SOURCE_EDGE 即原生渲染出 size×size 像素。
const SOURCE_EDGE = 50
const SOURCE_DENSITY = 72

function pngDimensions(png) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  if (png.length < 24 || !png.subarray(0, 8).equals(sig)) throw new Error('渲染产物不是 PNG 流')
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) }
}

async function main() {
  const svgText = fs.readFileSync(svgFile, 'utf8')
  const pngs = []
  for (const s of sizes) {
    // 逐尺寸原生栅格化（非缩小大位图）；resize 兜底确保输出恰为 s×s
    const buf = await sharp(Buffer.from(svgText), { density: SOURCE_DENSITY * s / SOURCE_EDGE })
      .resize(s, s).png().toBuffer()
    const { width, height } = pngDimensions(buf)
    if (width !== s || height !== s) throw new Error(`尺寸 ${s} 渲染出 ${width}x${height}`)
    pngs.push({ size: s, data: buf })
  }

  // ICONDIR + ICONDIRENTRY（Windows Vista 起直接读 PNG 压缩条目），手法同 make-icon-ico.js
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)      // reserved
  header.writeUInt16LE(1, 2)      // type: icon
  header.writeUInt16LE(pngs.length, 4)

  const entries = Buffer.alloc(16 * pngs.length)
  let offset = 6 + entries.length
  pngs.forEach((p, i) => {
    const e = i * 16
    entries.writeUInt8(p.size % 256, e + 0)     // width（256 编码为 0；本表最大 64 用不到）
    entries.writeUInt8(p.size % 256, e + 1)     // height
    entries.writeUInt8(0, e + 2)                // palette
    entries.writeUInt8(0, e + 3)                // reserved
    entries.writeUInt16LE(1, e + 4)             // planes
    entries.writeUInt16LE(32, e + 6)            // bpp
    entries.writeUInt32LE(p.data.length, e + 8) // bytesInRes
    entries.writeUInt32LE(offset, e + 12)       // imageOffset
    offset += p.data.length
  })

  fs.writeFileSync(outIco, Buffer.concat([header, entries, ...pngs.map((p) => p.data)]))
  console.log(`tray.ico written: ${sizes.join('/')}px, ${fs.statSync(outIco).size} bytes`)
}

main().catch((e) => { console.error(e); process.exit(1) })
