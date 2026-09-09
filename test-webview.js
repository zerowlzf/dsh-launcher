// webview 加载竞态回归测试（2026-09-09 事故）：
// DSH 已在运行时，启动器首个探测立刻成功、状态在渲染层加载早期就变成 ready。
// 旧代码此时给 <webview>.src 赋值，元素尚未升级（custom element 未定义），赋值被静默丢弃，
// 访客永远停在 about:blank —— 窗口标题栏显示"运行中"而内容区全黑；且旧重试条件
// （lastSetUrl !== currentUrl）永不成立，无法自愈。
// 本测试用桩 preload 立刻回一个 ready 状态，验证 webview 最终真的加载出内容。
// 运行：node test-webview.js   （需要 devDependency electron；窗口全程隐藏）
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const net = require('net')
const { spawn } = require('child_process')

const ITERATIONS = Number(process.env.WEBVIEW_ITER || 5)
const BODY_MARKER = 'WEBVIEW_OK_MARKER'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 直接解析二进制路径，不用 require('electron')：后者在 path.txt 缺失时会同步跑
// install.js 重新下载解包整个 Electron（实测会在运行时改写 node_modules/electron/dist，
// 恰好在此期间启动的启动器会加载到半拆包状态、preload 加载失败）。
const ELECTRON_EXE = path.join(__dirname, 'node_modules', 'electron', 'dist', 'electron.exe')

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port
      srv.close(() => resolve(p))
    })
  })
}

function startStubServer(port) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(`<!doctype html><meta charset="utf-8"><title>stub</title><body>${BODY_MARKER}</body>`)
    })
    srv.listen(port, '127.0.0.1', () => resolve(srv))
  })
}

// 被测渲染层的宿主：真实 renderer/ + 桩 preload（状态立刻 ready）
function buildHarness(rootDir, pageUrl) {
  const appDir = path.join(rootDir, 'app')
  fs.mkdirSync(path.join(appDir, 'renderer'), { recursive: true })
  fs.mkdirSync(path.join(appDir, 'assets'), { recursive: true })
  for (const rel of ['renderer/index.html', 'renderer/renderer.js', 'renderer/style.css']) {
    fs.copyFileSync(path.join(__dirname, rel), path.join(appDir, rel))
  }
  fs.copyFileSync(path.join(__dirname, 'assets', 'whale-white.svg'), path.join(appDir, 'assets', 'whale-white.svg'))
  fs.writeFileSync(path.join(appDir, 'preload.js'), `const { contextBridge } = require('electron')
const STATE = ${JSON.stringify({ state: 'ready', port: 0, url: pageUrl, pid: null, log: [] })}
contextBridge.exposeInMainWorld('launcher', {
  getState: () => Promise.resolve(STATE),
  onStatus: () => () => {},
  retry: () => Promise.resolve(),
  stopDsh: () => Promise.resolve(),
  openBrowser: () => Promise.resolve(),
  copyLog: () => Promise.resolve(''),
})`)
  fs.writeFileSync(path.join(appDir, 'main.js'), `const { app, BrowserWindow } = require('electron')
const path = require('path')
app.whenReady().then(() => {
  const win = new BrowserWindow({ show: false, webPreferences: {
    preload: path.join(__dirname, 'preload.js'),
    contextIsolation: true, nodeIntegration: false, webviewTag: true, sandbox: true,
  } })
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'))
})`)
  fs.writeFileSync(path.join(appDir, 'package.json'), JSON.stringify({ name: 'dsh-launcher-webview-test', version: '0.0.0', main: 'main.js' }))
  return appDir
}

async function targets(port) {
  try { return await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() } catch { return [] }
}

function evaluate(wsUrl, expression) {
  return new Promise((resolve) => {
    const ws = new WebSocket(wsUrl)
    const timer = setTimeout(() => { try { ws.close() } catch { /* 已关闭 */ } ; resolve(null) }, 8000)
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }))
    ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data))
      if (msg.id === 1) {
        clearTimeout(timer)
        try { ws.close() } catch { /* 已关闭 */ }
        resolve(msg.result && msg.result.result ? msg.result.result.value : null)
      }
    }
    ws.onerror = () => { clearTimeout(timer); resolve(null) }
  })
}

async function runOnce(appDir, pageUrl, index) {
  const stubPort = new URL(pageUrl).port
  const cdpPort = await freePort()
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), `launcher-webview-ud-${index}-`))
  const child = spawn(ELECTRON_EXE, [
    appDir, '--hidden', `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${userData}`,
  ], { cwd: appDir, stdio: 'ignore' })

  try {
    for (let i = 0; i < 24; i++) {
      const list = await targets(cdpPort)
      const guest = list.find((t) => t.url.includes(`127.0.0.1:${stubPort}`))
      if (guest) {
        const text = await evaluate(guest.webSocketDebuggerUrl, 'document.body ? document.body.innerText : ""')
        if (typeof text === 'string' && text.includes(BODY_MARKER)) return { ok: true }
        // 已导航但内容未就绪：继续等（最多 24 轮）
      }
      await sleep(500)
    }
    const list = await targets(cdpPort)
    const urls = list.map((t) => t.url).join(' | ') || '(无 target)'
    return { ok: false, detail: `12 秒内 webview 未加载出内容（targets: ${urls}）` }
  } finally {
    child.kill()
    await sleep(400)
    fs.rmSync(userData, { recursive: true, force: true })
  }
}

;(async () => {
  if (!fs.existsSync(ELECTRON_EXE)) {
    console.error(`找不到 Electron 可执行文件：${ELECTRON_EXE}`)
    console.error('请先在启动器目录执行 npm install。本测试不会自行下载，避免改写 node_modules。')
    process.exit(1)
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'launcher-webview-test-'))
  const stubPort = await freePort()
  const pageUrl = `http://127.0.0.1:${stubPort}/?token=test-token`
  const server = await startStubServer(stubPort)
  const appDir = buildHarness(root, pageUrl)

  let failed = 0
  try {
    for (let i = 0; i < ITERATIONS; i++) {
      const r = await runOnce(appDir, pageUrl, i)
      if (r.ok) console.log(`PASS: webview 第 ${i + 1} 次加载成功（状态早期就绪也不丢 src）`)
      else { failed++; console.log(`FAIL: 第 ${i + 1} 次 ${r.detail}`) }
    }
  } finally {
    server.close()
    fs.rmSync(root, { recursive: true, force: true })
  }

  if (failed > 0) {
    console.error(`\n${failed}/${ITERATIONS} 次失败：webview 竞态回归`)
    process.exit(1)
  }
  console.log(`\n全部通过 ✓（${ITERATIONS} 次）`)
  process.exit(0)
})().catch((e) => { console.error(e); process.exit(1) })
