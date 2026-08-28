// Generate launcher icons from the official DSH whale favicon (black, transparent bg).
// Uses the sharp build already present in the DSH checkout (no new native deps).
const fs = require('fs')
const path = require('path')

// 源码仓库固定为启动器同级的 deepseek-harness（与运行时 dshDir 的探测规则一致）
const repoDir = path.resolve(__dirname, '..', 'deepseek-harness')
const svgFile = path.join(repoDir, 'apps/web/public/favicon.svg')

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

const outDir = path.join(__dirname, 'assets')
fs.mkdirSync(outDir, { recursive: true })

const svgText = fs.readFileSync(svgFile, 'utf8')
// Strip the media-query style block so attribute fills are authoritative.
const flatSvg = svgText.replace(/<style>[\s\S]*?<\/style>/, '')
// Black whale (as shipped): fill="#000" on transparent background.
const blackSvg = flatSvg
// White variant for dark surfaces (tray, dark title bar).
const whiteSvg = flatSvg.replace('fill="#000"', 'fill="#ffffff"')

fs.writeFileSync(path.join(outDir, 'whale-white.svg'), whiteSvg)
fs.writeFileSync(path.join(outDir, 'whale.svg'), blackSvg)

async function main() {
  const black = sharp(Buffer.from(blackSvg), { density: 600 })
  const white = sharp(Buffer.from(whiteSvg), { density: 600 })

  await Promise.all([
    black.clone().resize(256, 256).png().toFile(path.join(outDir, 'icon-256.png')),
    black.clone().resize(32, 32).png().toFile(path.join(outDir, 'icon-32.png')),
    black.clone().resize(16, 16).png().toFile(path.join(outDir, 'icon-16.png')),
    white.clone().resize(16, 16).png().toFile(path.join(outDir, 'tray-16.png')),
    white.clone().resize(32, 32).png().toFile(path.join(outDir, 'tray-32.png')),
  ])
  console.log('icons written to', outDir)
}

main().catch((e) => { console.error(e); process.exit(1) })