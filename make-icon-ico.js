// 打包多尺寸 ICO：sharp 生成各尺寸 PNG，按 ICO 规范（Vista+ PNG 条目）写入。
const fs = require('fs')
const path = require('path')

// 源码仓库固定为启动器同级的 deepseek-harness（与运行时 dshDir 的探测规则一致）
const repoDir = path.resolve(__dirname, '..', 'deepseek-harness')
const svgFile = path.join(repoDir, 'apps/web/public/favicon.svg')
const outIco = path.join(__dirname, 'assets', 'icon.ico')
const sizes = [16, 24, 32, 48, 64, 128, 256]

// pnpm 布局：sharp 在 .pnpm/sharp@<version>/node_modules/sharp，顶层无符号链接
function resolveSharp() {
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
  console.error('预期路径：', path.join(repoDir, 'node_modules', '.pnpm', 'sharp@*', 'node_modules', 'sharp'))
  process.exit(1)
}

async function main() {
  // 黑鲸鱼（去掉 media-query style，保持 fill="#000"）
  const svgText = fs.readFileSync(svgFile, 'utf8').replace(/<style>[\s\S]*?<\/style>/, '')
  const pngs = []
  for (const s of sizes) {
    const buf = await sharp(Buffer.from(svgText), { density: 600 })
      .resize(s, s).png().toBuffer()
    pngs.push({ size: s, data: buf })
  }

  // ICONDIR + ICONDIRENTRY
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)      // reserved
  header.writeUInt16LE(1, 2)      // type: icon
  header.writeUInt16LE(pngs.length, 4)

  const entries = Buffer.alloc(16 * pngs.length)
  let offset = 6 + entries.length
  pngs.forEach((p, i) => {
    const e = i * 16
    entries.writeUInt8(p.size >= 256 ? 0 : p.size, e + 0)   // width (256 -> 0)
    entries.writeUInt8(p.size >= 256 ? 0 : p.size, e + 1)   // height
    entries.writeUInt8(0, e + 2)                            // palette
    entries.writeUInt8(0, e + 3)                            // reserved
    entries.writeUInt16LE(1, e + 4)                         // planes
    entries.writeUInt16LE(32, e + 6)                        // bpp
    entries.writeUInt32LE(p.data.length, e + 8)             // bytesInRes
    entries.writeUInt32LE(offset, e + 12)                   // imageOffset
    offset += p.data.length
  })

  fs.writeFileSync(outIco, Buffer.concat([header, entries, ...pngs.map((p) => p.data)]))
  console.log(`icon.ico written: ${sizes.join('/')}px, ${fs.statSync(outIco).size} bytes`)
}

main().catch((e) => { console.error(e); process.exit(1) })