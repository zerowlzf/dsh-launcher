// DSH 桌面启动器 — main process
// Win11 风格炭黑窗口 · 托盘驻留 · 自动探测/启动/停止 DSH（源码版）
const { app, BrowserWindow, Tray, Menu, shell, nativeImage, ipcMain, screen } = require('electron')
const { spawn, execFile } = require('child_process')
const fs = require('fs')
const path = require('path')
const http = require('http')

// ---------------------------------------------------------------- config
const LEGACY_DSH_DIR = 'C:\\Users\\Administrator\\Desktop\\dsh\\deepseek-harness'
const DEFAULT_DSH_DIR = path.join(__dirname, '..', 'deepseek-harness')

const DEFAULTS = {
  port: 3080,
  dshDir: fs.existsSync(DEFAULT_DSH_DIR)
    ? DEFAULT_DSH_DIR
    : (fs.existsSync(LEGACY_DSH_DIR) ? LEGACY_DSH_DIR : DEFAULT_DSH_DIR),
  startCmd: ['node', '--import', 'tsx/esm', 'apps/cli/src/bin.ts', 'web', '--no-open'],
  noOpen: true,
}

// 集中管理的关键阈值
const PROBE_INTERVAL_MS = 2000        // 服务探测周期
const START_BUDGET_MS = 200 * 1000    // 启动预算：探测循环超时仅提醒（进程活着可能只是启动慢）；手动重试超时才强杀重启
const PORT_FREE_TIMEOUT_MS = 8000     // 停止后等待端口释放的兜底窗口
const LOG_MAX_BYTES = 2 * 1024 * 1024 // dsh.log 轮转阈值
const LOG_KEEP_LINES = 2000           // 轮转保留行数
const RUNLOG_MAX_LINES = 4000         // 单次运行输出缓冲上限（防长期驻留内存膨胀）

const APP_ID = 'com.dsh.launcher'
app.setAppUserModelId(APP_ID)

const assetsDir = path.join(__dirname, 'assets')
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json')
const logFile = () => path.join(app.getPath('userData'), 'dsh.log')

// 启动器自带内嵌 Web GUI，因此 DSH 不应再调用系统默认浏览器。
// 兼容旧配置：如果 startCmd 是 web 且没有 --no-open，就自动补上。
function isWebCommand(cmd) {
  return cmd.some((arg, i) =>
    arg === 'web' ||
    arg === '--profile=web' ||
    (arg === '--profile' && cmd[i + 1] === 'web')
  )
}

function normalizeStartCmd(cmd, noOpen = true) {
  if (!Array.isArray(cmd) || cmd.length === 0) return [...DEFAULTS.startCmd]
  let normalized = [...cmd]
  if (noOpen) {
    if (!normalized.includes('--no-open') && isWebCommand(normalized)) normalized.push('--no-open')
  } else {
    normalized = normalized.filter((arg) => arg !== '--no-open')
  }
  return normalized
}

function sanitizePort(value) {
  const n = Number(value)
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : DEFAULTS.port
}

function loadSettings() {
  let s = { ...DEFAULTS, startCmd: [...DEFAULTS.startCmd] }
  try {
    const raw = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'))
    // 只接受普通对象：防止 settings.json 被写成字符串/数组时展开出垃圾字段
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) s = { ...s, ...raw }
  } catch {
    // 配置损坏：改名备份后回退默认值，避免每次启动都解析失败且无痕迹
    try { fs.renameSync(settingsFile(), settingsFile() + '.corrupt.bak') } catch { /* ignore */ }
  }
  if (!s.dshDir || !fs.existsSync(s.dshDir)) s.dshDir = DEFAULTS.dshDir
  s.port = sanitizePort(s.port)
  s.noOpen = s.noOpen !== false
  s.startCmd = normalizeStartCmd(s.startCmd, s.noOpen)
  return s
}

function saveSettings(patch) {
  const s = { ...loadSettings(), ...patch }
  try {
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true })
    fs.writeFileSync(settingsFile(), JSON.stringify(s, null, 2))
  } catch (e) {
    console.error('saveSettings failed:', e)
  }
}

// ---------------------------------------------------------------- state
let cfg = loadSettings()
// 确保标准化后的配置持久化（如旧配置缺少 --no-open）
saveSettings({ port: cfg.port, dshDir: cfg.dshDir, startCmd: cfg.startCmd })

let win = null
let tray = null
let child = null          // DSH 子进程（本启动器拉起的）
let childStartAt = 0
let noOpenFallbackUsed = false
let stopping = false
let stopPromise = null
let quitting = false
let probeTimer = null
let slowBootNotified = false
let tokenWaitNotified = false  // 令牌迟迟未捕获提示只弹一次
let probing = false       // 探测在飞标志：防止慢探测周期重叠堆积
let authHintShown = false // 401 无令牌提示只弹一次
let logDirReady = false   // 日志目录惰性创建缓存
let logSizeKnown = false  // 日志大小是否已与本会话同步
let logSize = 0

// 上次会话捕获的启动令牌（DSH web 输出 ?token=...，持久化以便重启启动器后
// 仍能直接认证仍在运行的 DSH；新进程会打印新令牌并被重新捕获）
const restoredToken = (typeof cfg.token === 'string' && cfg.token !== '') ? cfg.token : null

const state = {
  value: 'idle',          // idle | starting | ready | degraded | stopped | failed
  port: cfg.port,
  url: restoredToken
    ? `http://127.0.0.1:${cfg.port}/?token=${encodeURIComponent(restoredToken)}`
    : `http://127.0.0.1:${cfg.port}`,
  token: restoredToken,
  pid: null,
  log: [],                // 最近 200 行 DSH 输出
}

function baseUrl() {
  return `http://127.0.0.1:${state.port}`
}

function setState(patch) {
  Object.assign(state, patch)
  push()
}

function push() {
  if (win && !win.isDestroyed()) {
    win.webContents.send('launcher:status', {
      state: state.value,
      port: state.port,
      url: state.url,
      pid: state.pid,
      log: state.log.slice(-80),
    })
  }
}

// 统一日志时间戳：带月日（补零定宽），跨天的 dsh.log 才能区分日期且排序稳定
function ts() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

// 日志以 UTF-8 BOM 写入，保证记事本/旧版 PowerShell 查看中文不乱码。
function ensureLogBom() {
  try {
    fs.mkdirSync(path.dirname(logFile()), { recursive: true })
    logDirReady = true
    if (!fs.existsSync(logFile())) {
      fs.writeFileSync(logFile(), '\uFEFF', 'utf8')
      logSize = 3
      logSizeKnown = true
      return
    }
    const size = fs.statSync(logFile()).size
    const buf = Buffer.alloc(3)
    const fd = fs.openSync(logFile(), 'r')
    const n = fs.readSync(fd, buf, 0, 3, 0)
    fs.closeSync(fd)
    if (n >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
      logSize = size
      logSizeKnown = true
      return
    }
    // 旧文件无 BOM：重写补上，历史日志恢复可读；超大文件跳过重写，交给轮转处理
    logSize = size
    logSizeKnown = true
    if (size > 8 * 1024 * 1024) return
    const content = fs.readFileSync(logFile(), 'utf8')
    const out = '\uFEFF' + content
    fs.writeFileSync(logFile(), out, 'utf8')
    logSize = Buffer.byteLength(out)
  } catch { /* ignore */ }
}

function appendLog(line) {
  const t = ts()
  state.log.push(`[${t}] ${line}`)
  if (state.log.length > 200) state.log.shift()
  try {
    if (!logDirReady) {
      fs.mkdirSync(path.dirname(logFile()), { recursive: true })
      logDirReady = true
    }
    if (!logSizeKnown) {
      // 本会话首次写入：与磁盘现状同步一次，之后内存跟踪增量，
      // 免去每行 mkdir/exists/stat 三连系统调用。
      logSizeKnown = true
      try { logSize = fs.statSync(logFile()).size } catch { logSize = 0 }
    }
    // 超过阈值轮转：保留末尾 LOG_KEEP_LINES 行（重写时补 BOM），避免日志无限增长
    if (logSize > LOG_MAX_BYTES) {
      const old = fs.readFileSync(logFile(), 'utf8')
      const kept = '\uFEFF' + old.split('\n').slice(-LOG_KEEP_LINES).join('\n')
      fs.writeFileSync(logFile(), kept)
      logSize = Buffer.byteLength(kept)
    }
    const rec = `[${t}] ${line}\n`
    fs.appendFileSync(logFile(), rec)
    logSize += Buffer.byteLength(rec)
  } catch {
    // 目录可能被外部删除等：重置缓存，下次调用自动重建/重新同步
    logDirReady = false
    logSizeKnown = false
  }
  push()
}

function notify(title, body) {
  if (tray && process.platform === 'win32') {
    try { tray.displayBalloon({ title, content: body }) } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------- DSH control
// 探测服务状态：'up'（可访问，2xx/3xx）、'auth'（服务在但需令牌，仅 401）、'down'
function isUp() {
  return new Promise((resolve) => {
    const req = http.get(state.url, { timeout: 5000 }, (res) => {
      res.resume()
      const code = res.statusCode
      // 3xx 视为就绪：带令牌访问会 303 跳转到 /，无令牌访问 401。
      // 仅 401 视为"需要令牌"；404/403 等其它 4xx 归 down（端口被无关服务占用但不健康）。
      // 5xx 同样视为未就绪。
      if (code >= 200 && code < 400) return resolve('up')
      if (code === 401) return resolve('auth')
      resolve('down')
    })
    req.on('timeout', () => {
      req.destroy()
      resolve('down')
    })
    req.on('error', () => {
      resolve('down')
    })
  })
}

function findPidOnPort() {
  return new Promise((resolve) => {
    execFile('netstat', ['-ano', '-p', 'tcp'], { windowsHide: true }, (err, stdout) => {
      if (err) return resolve(null)
      // netstat 状态列是本地化的（中文系统为"监听"），需同时匹配中英文，
      // 否则非英文 Windows 上外部 DSH 停止功能会静默失效。
      for (const line of stdout.split(/\r?\n/)) {
        const m = line.trim().match(/^TCP\s+(\[[^\]]*\]|[^:]+):(\d+)\s+\S+\s+(?:LISTENING|监听)\s+(\d+)$/)
        if (m && Number(m[2]) === state.port) return resolve(Number(m[3]))
      }
      resolve(null)
    })
  })
}

// 停止后等待端口真正释放（taskkill 是强杀，但留一个兜底窗口），
// 避免"停止→立即重启"时旧端口未释放导致 EADDRINUSE。
function waitPortFree(timeoutMs = PORT_FREE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs
    const poll = async () => {
      if (!(await findPidOnPort())) return resolve(true)
      if (Date.now() >= deadline) {
        appendLog(`警告：端口 ${state.port} 停止后 ${Math.round(timeoutMs / 1000)} 秒仍未释放`)
        return resolve(false)
      }
      setTimeout(poll, 400)
    }
    poll()
  })
}

function startDsh() {
  // 返回 null=已启动；返回字符串=被守卫拒绝的原因（调用方负责回滚状态）
  if (child) return '已有 DSH 子进程在运行'
  if (stopping) return '停止进行中，请稍候再试'
  appendLog(`启动 DSH: ${cfg.startCmd.join(' ')}  (cwd: ${cfg.dshDir})`)
  childStartAt = Date.now()
  slowBootNotified = false
  authHintShown = false
  tokenWaitNotified = false
  // 新进程会打印新的 ?token=，旧令牌立即作废；就绪判定改为等待令牌捕获后的认证 URL
  state.token = null
  state.url = baseUrl()
  push()
  // 本次运行的独立输出缓冲：--no-open 兜底只检查这里。
  // 不能切片全局环形缓冲 state.log —— 它超过 200 行会 shift 轮转，索引失真后
  // 会混入上一轮历史（其中可能残留旧的 unknown-option 文本，导致误判误兜底）。
  const runLines = []
  let portDriftWarned = false
  // stdout/stderr 按 chunk 到达，行可能被 TCP/管道缓冲截断成两段。
  // 每个流独立维护尾部缓冲拼接残缺行，避免 `dsh web: ...?token=` 跨 chunk 丢失令牌。
  const makeLinePusher = (prefix) => {
    let tail = ''
    const push = (raw) => {
      // 按 \r?\n 切分（兼容 CRLF/LF），并保留尾部残缺段供下一 chunk 拼接。
      // 不能只 replace 末尾一个 \r：多行 chunk 的中间行也会残留 \r。
      const pieces = (tail + raw).split(/\r?\n/)
      tail = pieces.pop() ?? ''
      pieces.filter(Boolean).forEach((l) => logRun(prefix + l))
    }
    // 进程退出时冲刷尾部残缺行：最后一行往往没有换行符，且常常正是退出原因，
    // 不 flush 会随解绑监听一起丢失。
    push.flush = () => {
      if (tail) {
        const last = tail
        tail = ''
        logRun(prefix + last)
      }
    }
    return push
  }
  const pushStdout = makeLinePusher('')
  const pushStderr = makeLinePusher('ERR ')
  const logRun = (line) => {
    // 令牌捕获必须在脱敏前：从原始行提取令牌。
    // 主匹配 `dsh web:` 前缀（官方输出格式）；兜底匹配任意 loopback URL 携带
    // ?token= 查询参数的行，避免 DSH 输出格式微调（如改叫 "Web UI:"）导致
    // 令牌永远捕获不到、启动器卡在 401 循环提示。
    let rawUrl = null
    const m1 = line.match(/dsh web:\s*(https?:\/\/\S+)/i)
    if (m1) {
      rawUrl = m1[1]
    } else {
      const m2 = line.match(/https?:\/\/(?:127\.0\.0\.1|\[::1\]|localhost):\d+\/\?[^\s]*\btoken=[^\s&]+/i)
      if (m2) rawUrl = m2[0]
    }
    if (rawUrl) {
      try {
        const u = new URL(rawUrl)
        const token = u.searchParams.get('token')
        if (token && token !== state.token) {
          // 统一重建认证 URL：与恢复路径（encodeURIComponent）同构。若直接沿用
          // DSH 原始串，令牌含 +/= 等字符时两条路径的字面量不同，渲染层
          // lastSetUrl 严格比较会多触发一次无谓导航。
          state.token = token
          state.url = `${u.origin}${u.pathname}?token=${encodeURIComponent(token)}`
          // 同步真实端口（端口漂移时 baseUrl/findPidOnPort 才能对准进程）
          const realPort = Number(u.port)
          if (realPort && realPort !== state.port) {
            state.port = realPort
            portDriftWarned = true
            appendLog(`DSH 实际监听端口 ${realPort}，与配置 ${cfg.port} 不一致，已自动跟随。建议把 settings.json 的 port 改为 ${realPort} 后重启启动器。`)
            notify('DSH 端口漂移', `DSH 监听 ${realPort}，已自动跟随。建议更新 settings.json 的 port。`)
          }
          // 持久化令牌：重启启动器（DSH 仍由上次启动器拉起）时可直接复用认证
          saveSettings({ token })
          appendLog(`已捕获 DSH 启动令牌，切换到认证 URL`)
          if (tray) tray.setToolTip(`DSH 启动器 · ${baseUrl()}`)
        }
      } catch { /* 非 URL 行，忽略 */ }
    }
    // 落日志前对令牌脱敏：bearer 凭证不得进入 dsh.log/state.log/渲染层/剪贴板
    const safeLine = line.replace(/([?&]token=)[^&\s]+/gi, '$1***')
    appendLog(safeLine)
    // 运行缓冲只留脱敏行：no-open 兜底检测只看选项报错文本，无需令牌明文
    runLines.push(safeLine)
    if (runLines.length > RUNLOG_MAX_LINES) runLines.shift()
    // 端口漂移检测：DSH 自报的监听地址与配置探测端口不一致时提醒一次
    // 启用自动跟随：state.port 同步为实际端口（findPidOnPort 等函数用 state.port 查 PID）
    if (!portDriftWarned) {
      const m = line.match(/https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):(\d+)/i)
      if (m && Number(m[1]) !== cfg.port) {
        portDriftWarned = true
        state.port = Number(m[1])
        appendLog(`DSH 实际监听端口 ${m[1]}，与配置 ${cfg.port} 不一致，已自动跟随。建议把 settings.json 的 port 改为 ${m[1]} 后重启启动器，以避免下次启动时端口漂移重复出现。`)
        notify('DSH 端口漂移', `DSH 监听 ${m[1]}，已自动跟随。建议更新 settings.json 的 port。`)
        if (tray) tray.setToolTip(`DSH 启动器 · ${baseUrl()}`)
      }
    }
  }
  try {
    // 用局部变量保存本次 child：旧进程的退出事件可能在新进程接管后才到达
    // （停止→立即重启的竞态），只有"仍是当前进程"的退出才允许改写全局状态。
    const c = spawn(cfg.startCmd[0], cfg.startCmd.slice(1), {
      cwd: cfg.dshDir,
      windowsHide: true,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child = c
    c.unref()
    c.stdout.on('data', (d) => pushStdout(String(d)))
    c.stderr.on('data', (d) => pushStderr(String(d)))
    c.on('error', (e) => {
      appendLog(`启动失败: ${e.message}`)
      if (child !== c) return   // 迟到事件：新进程已接管，忽略
      child = null
      childStartAt = 0
      setState({ value: 'failed', pid: null })
    })
    c.on('exit', (code, sig) => {
      appendLog(`DSH 进程退出 (code=${code} sig=${sig})`)
      const isCurrent = child === c
      const elapsed = Date.now() - childStartAt
      const startedAt = childStartAt   // 置 0 前保存本次启动时刻，EADDRINUSE 等待路径要恢复它
      if (!isCurrent) return    // 旧进程退出事件迟到：仅留日志，不动全局状态
      child = null
      childStartAt = 0
      // 先冲刷输出缓冲的尾部残缺行（退出前的最后输出往往是失败原因），
      // 再解除流监听，防止缓冲中迟到的 data 事件在退出后重新捕获已失效的令牌。
      pushStdout.flush()
      pushStderr.flush()
      c.stdout.removeAllListeners('data')
      c.stderr.removeAllListeners('data')
      // 进程已退出，其启动令牌必然失效：清空内存与持久化副本并还原基础 URL，
      // 避免下次启动启动器时拿失效令牌去探测（401 白绕一圈）。
      // 崩溃退出不走 stopDsh，所以持久化清理只能在这里兜底。
      state.token = null
      state.url = baseUrl()
      saveSettings({ token: null })
      // 只匹配本次运行自身的输出（含 stderr），不受全局日志轮转影响
      const runLog = runLines.join('\n')
      const noOpenError = /unknown (option|argument)|invalid option/i.test(runLog) && runLog.includes('no-open')
      const failedFast = code !== 0 && state.value === 'starting' && elapsed < 10000
      // 端口被占导致快速退出（EADDRINUSE）：占用者极可能是正在冷启动的另一个
      // DSH 实例（如用户先手动启动 DSH、再打开启动器，启动器误拉了第二实例）。
      // 不置 failed —— failed 有防误翻转保护，外部实例就绪后 UI 会卡在"启动失败"；
      // 保持 starting 并恢复启动时间戳，探测循环在端口就绪后自动翻转 ready。
      if (!stopping && state.value === 'starting' && /EADDRINUSE|address already in use/i.test(runLog)) {
        childStartAt = startedAt
        appendLog('DSH 启动时端口已被占用（可能另一个 DSH 实例正在启动），保持探测等待；若长期未就绪请查看日志或用托盘“停止 DSH”处理。')
        return
      }
      if (!stopping && failedFast && !noOpenFallbackUsed && cfg.startCmd.includes('--no-open') && noOpenError) {
        noOpenFallbackUsed = true
        appendLog('--no-open 可能不受当前 DSH 支持，尝试去掉后重新启动')
        cfg.startCmd = cfg.startCmd.filter((arg) => arg !== '--no-open')
        cfg.noOpen = false
        saveSettings({ startCmd: cfg.startCmd, noOpen: false })
        setState({ value: 'starting' })
        startDsh()
        return
      }
      // 如果是主动停止触发的退出，不弹通知
      if (!stopping && (state.value === 'ready' || state.value === 'starting' || state.value === 'degraded')) {
        if (state.value === 'starting') {
          // 从未就绪就退出 = 启动失败（区别于用户主动停止）
          setState({ value: 'failed', pid: null })
          notify('DSH 启动失败', '进程在就绪前退出，请查看日志后重试。')
        } else {
          setState({ value: 'stopped', pid: null })
          notify('DSH 已停止', '进程已退出，可点击托盘菜单“重新启动 DSH”。')
        }
      }
    })
  } catch (e) {
    appendLog(`spawn 异常: ${e.message}`)
    childStartAt = 0
    setState({ value: 'failed', pid: null })
  }
}

// 通过命令行特征确认某个 PID 确实是 DSH（node bin.ts / dsh CLI），
// 避免"停止 DSH"误杀占用 3080 端口的无关服务。
function looksLikeDsh(pid) {
  return new Promise((resolve) => {
    execFile('powershell', ['-NoProfile', '-Command',
      `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`],
      { windowsHide: true },
      (err, stdout) => {
        if (err) return resolve(false)
        resolve(/bin\.ts|deepseek|(^|[\s/\\])dsh([\s/\\]|$)/i.test(stdout))
      })
  })
}

function stopDsh() {
  if (stopPromise) return stopPromise
  stopPromise = (async () => {
    stopping = true
    // 立即切换到 stopped：避免停止过程中探测循环误报"连接断开"通知
    setState({ value: 'stopped', pid: null })
    try {
      // 优先使用自己拉起的子进程 PID；非本启动器拉起的进程先确认它确实是 DSH
      let pid = child?.pid || await findPidOnPort()
      if (pid && !child && !(await looksLikeDsh(pid))) {
        appendLog(`端口 ${state.port} 由非 DSH 进程 (PID ${pid}) 占用，已跳过停止`)
        pid = null
      }
      if (pid) {
        appendLog(`停止 DSH (PID ${pid})`)
        await new Promise((res) => execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => res()))
      }
      if (child) {
        try { child.kill() } catch { /* ignore */ }
        child = null
      }
      childStartAt = 0
      // 进程已终止，旧令牌失效：还原为无令牌基础 URL，并从持久化配置中删除
      state.token = null
      state.url = baseUrl()
      saveSettings({ token: null })
      setState({ value: 'stopped', pid: null })
    } finally {
      stopping = false
      stopPromise = null
    }
  })()
  return stopPromise
}

async function restartDsh() {
  await stopDsh()
  setState({ value: 'starting' })
  if (await waitPortFree()) {
    startDsh()
  } else {
    appendLog('端口未释放，已取消自动重启；请稍后重试')
    setState({ value: 'failed', pid: null })
  }
}

// 探测循环：PROBE_INTERVAL_MS 一次。服务假死时单次探测可挂起数秒（超时 5s > 周期 2s），
// 用 probing 标志跳过重叠周期，避免请求无限堆积。
function ensureRunning() {
  if (probing) return
  probing = true
  isUp().then(async (status) => {
    if (stopping) return   // 停止过程中不推进状态机，避免竞态误报
    if (status === 'up') {
      // stopped/failed 是用户主动停止或启动失败的明确状态：端口被残留进程占用
      // 返回 2xx 时不得自动翻转为 ready（与用户停止意图矛盾），交给用户点"重试"。
      if (state.value === 'stopped' || state.value === 'failed') return
      if (state.value !== 'ready' && state.value !== 'degraded') {
        const pid = child?.pid || await findPidOnPort()
        setState({ value: 'ready', pid })
        notify('DSH 已就绪', `${baseUrl()} 可以访问了。`)
      } else if (state.value === 'degraded') {
        const pid = child?.pid || await findPidOnPort()
        setState({ value: 'ready', pid })
        notify('DSH 已恢复', '连接已重新建立。')
      }
      return
    }
    if (status === 'auth') {
      // 服务在响应但返回 401：需要启动令牌。
      // 若是自己拉起的子进程，令牌会在 DSH 输出 `dsh web: ...?token=` 时捕获；
      // 若是外部启动的 DSH（无子进程），本启动器拿不到它的令牌，只能提示用户。
      if (state.value === 'ready' || state.value === 'degraded') {
        setState({ value: 'degraded' })
        if (!authHintShown) {
          authHintShown = true
          appendLog('DSH 需要启动令牌（401）。若是外部启动的 DSH，请复制其打印的带 ?token= 的 URL，或通过托盘菜单“重新启动 DSH”让本启动器接管。')
          notify('DSH 需要认证', 'DSH 需要启动令牌才能显示，请通过“重新启动 DSH”接管。')
        }
        return
      }
      // idle/starting：可能是外部启动的 DSH，或持久化的令牌已失效。
      // 无子进程时无法自动接管，提示一次即可（探测循环会继续轮询）。
      if (!child && !authHintShown) {
        authHintShown = true
        appendLog('检测到 DSH 需要启动令牌（401）。若是外部启动的 DSH，请复制其打印的带 ?token= 的 URL 在浏览器打开，或通过托盘菜单“重新启动 DSH”让本启动器接管。')
        notify('DSH 需要认证', '请通过“重新启动 DSH”接管，或使用外部 DSH 打印的令牌 URL。')
      }
      // 自己拉起的子进程：令牌行迟迟未捕获时给出超时提示，避免永远“启动中”
      if (child && state.value === 'starting' && childStartAt > 0 && Date.now() - childStartAt > START_BUDGET_MS) {
        if (!tokenWaitNotified) {
          tokenWaitNotified = true
          appendLog(`DSH 已响应但启动令牌迟迟未捕获（已超过 ${Math.round(START_BUDGET_MS / 1000)} 秒）。请检查上方日志，或通过托盘菜单“重新启动 DSH”重置。`)
        }
      }
      return
    }
    // down
    if (state.value === 'ready') {
      setState({ value: 'degraded' })
      notify('DSH 连接断开', '服务无响应，正在等待恢复…')
      return
    }
    if (state.value === 'degraded') return
    if (state.value === 'idle') {
      setState({ value: 'starting' })
      startDsh()
      return
    }
    if (state.value === 'starting' && childStartAt > 0 && Date.now() - childStartAt > START_BUDGET_MS) {
      // 进程仍活着只是启动慢：不误报"超时失败"（就绪后会自动翻转回 ready），仅提醒一次
      if (!slowBootNotified) {
        slowBootNotified = true
        appendLog(`DSH 启动缓慢（已超过 ${Math.round(START_BUDGET_MS / 1000)} 秒），仍在等待就绪…`)
      }
      return
    }
    if (state.value === 'failed') return
  }).catch((e) => {
    console.error('probe error:', e)
  }).finally(() => {
    probing = false
  })
}

// ---------------------------------------------------------------- window
function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1000,
    minHeight: 640,
    title: 'DeepSeek Harness',
    icon: path.join(assetsDir, 'icon-32.png'),
    backgroundColor: '#2b2b2b',
    frame: false,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#2b2b2b', symbolColor: '#b9b9b9', height: 44 },
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      sandbox: true,
    },
  })

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'))

  // 兜底：万一 ready-to-show 没触发，非 --hidden 启动也要把窗口显示出来。
  // winShownOnce：窗口已显示过就不重复弹（避免与用户立即关窗到托盘冲突）。
  if (!startHidden) {
    setTimeout(() => {
      if (win && !win.isDestroyed() && !win.isVisible() && !winShownOnce) win.show()
    }, 1500)
  }

  // 防止顶层窗口被导航走或弹出奇怪窗口；需要开外部浏览器时走显式 IPC/托盘。
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    // 初始加载走 loadFile（程序化导航不触发本事件），任何页面发起的导航一律拦截
    if (url !== win.webContents.getURL()) e.preventDefault()
  })

  win.once('ready-to-show', () => {
    if (!startHidden) {
      win.show()
      winShownOnce = true
    }
  })

  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault()
      win.hide()
      if (!trayNotified) {
        trayNotified = true
        notify('DSH 仍在后台运行', '启动器已最小化到托盘，点击托盘图标恢复。')
      }
    }
  })

  const saveBounds = () => {
    if (!win.isMaximized()) saveSettings({ bounds: win.getBounds() })
  }
  win.on('resize', debounce(saveBounds, 500))
  win.on('move', debounce(saveBounds, 500))

  // 保存的窗口位置可能与当前显示器布局不重叠（换机/换分辨率后），
  // 此时忽略旧 bounds 交给系统默认摆放，避免窗口"消失"。
  function isVisibleOnSomeScreen(bounds) {
    if (!bounds || !bounds.width || !bounds.height) return false
    return screen.getAllDisplays().some((d) => {
      const wa = d.workArea
      return bounds.x < wa.x + wa.width && bounds.x + bounds.width > wa.x &&
             bounds.y < wa.y + wa.height && bounds.y + bounds.height > wa.y
    })
  }

  const b = cfg.bounds
  if (isVisibleOnSomeScreen(b)) win.setBounds(b)

  win.on('closed', () => { win = null })
}

function debounce(fn, ms) {
  let t = null
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms) }
}

function showWindow() {
  if (!win) createWindow()
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

// ---------------------------------------------------------------- tray
function createTray() {
  // 白色鲸鱼：Win11 深色任务栏上黑色图标不可见
  tray = new Tray(nativeImage.createFromPath(path.join(assetsDir, 'tray-32.png')))
  tray.setToolTip(`DSH 启动器 · ${baseUrl()}`)
  const menu = Menu.buildFromTemplate([
    { label: '显示启动器窗口', click: showWindow },
    { label: '在浏览器中打开', click: () => shell.openExternal(state.url) },
    { label: '打开 DSH 目录', click: () => shell.openPath(cfg.dshDir) },
    { label: '打开配置目录', click: () => shell.openPath(path.dirname(settingsFile())) },
    { type: 'separator' },
    { label: '重新启动 DSH', click: () => restartDsh() },
    { label: '停止 DSH', click: () => stopDsh() },
    { type: 'separator' },
    {
      label: '开机自动启动',
      type: 'checkbox',
      // 未打包应用必须传相同的 path/args，getLoginItemSettings 才能识别注册表状态
      checked: app.getLoginItemSettings({ path: process.execPath, args: [app.getAppPath(), '--hidden'] }).openAtLogin,
      click: (item) => {
        app.setLoginItemSettings({
          openAtLogin: item.checked,
          path: process.execPath,
          args: [app.getAppPath(), '--hidden'],
        })
      },
    },
    { type: 'separator' },
    { label: '退出（DSH 继续运行）', click: () => { quitting = true; app.quit() } },
    { label: '退出并停止 DSH', click: () => { quitting = true; stopDsh().finally(() => app.quit()) } },
  ])
  tray.setContextMenu(menu)
  tray.on('click', showWindow)
}

// ---------------------------------------------------------------- ipc
ipcMain.handle('launcher:getState', () => ({
  state: state.value, port: state.port, url: state.url, pid: state.pid, log: state.log.slice(-80),
}))
ipcMain.handle('launcher:openBrowser', () => shell.openExternal(state.url))
ipcMain.handle('launcher:retry', async () => {
  // 停止进行中（如刚点过"停止 DSH"）：先等它收尾再决策，
  // 否则可能读到尚未清空的 child 而误判，或 startDsh 被 stopping 守卫静默拒绝。
  if (stopPromise) await stopPromise
  // 统一语义：确保 DSH 在运行 —— 探测端口，不通则拉起（任何状态下可用）
  const status = await isUp()
  if (status === 'up') {
    const p = child?.pid || await findPidOnPort()
    // 与 stopDsh 对齐的进程身份校验：端口被无关服务占用时不得宣告就绪，
    // 否则 webview 会把陌生页面当作 DSH GUI 展示（stopped/failed 态重试同样适用）
    if (!child && p && !(await looksLikeDsh(p))) {
      appendLog(`端口 ${state.port} 由非 DSH 进程 (PID ${p}) 占用，已跳过就绪切换；如需停止它请用托盘“停止 DSH”。`)
      return
    }
    setState({ value: 'ready', pid: p })
    return
  }
  if (status === 'auth') {
    // 服务在但 401：自己拉起的子进程等令牌行；外部 DSH 则接管。
    if (child) {
      appendLog('DSH 已响应但尚未捕获启动令牌，继续等待…')
      setState({ value: 'starting' })
      return
    }
    // 无子进程：用户点了“重试/启动 DSH”即明确授权接管外部 DSH。
    // 只提示不动作会让窗口内无任何可用操作（idle 态不显示操作按钮），
    // 因此先确认端口上确实是 DSH，再停止并由本启动器重新拉起。
    const p = await findPidOnPort()
    if (p && !(await looksLikeDsh(p))) {
      appendLog(`端口 ${state.port} 由非 DSH 进程 (PID ${p}) 占用，无法接管；请先处理该端口占用。`)
      return
    }
    appendLog('接管外部 DSH：停止后由本启动器重新启动…')
    await stopDsh()
    await waitPortFree()
    const reason = startDsh()
    if (reason) {
      appendLog(`启动 DSH 被拒绝: ${reason}`)
      setState({ value: 'failed' })
    } else {
      setState({ value: 'starting' })
    }
    return
  }
  if (!child) {
    const reason = startDsh()
    if (reason) {
      // 守卫拒绝（停止进行中等极窄窗口）：回滚 starting，避免卡死等待
      appendLog(`启动 DSH 被拒绝: ${reason}`)
      setState({ value: state.value === 'starting' ? 'failed' : state.value })
    } else {
      setState({ value: 'starting' })
    }
    return
  }
  // 子进程仍在但服务未就绪：DSH 冷启动可能长达 2 分钟以上，
  // 过早强杀只会让冷启动从头再来。仅在超过启动预算（与 ensureRunning 一致）后才视为卡死。
  const elapsedMs = childStartAt > 0 ? Date.now() - childStartAt : 0
  if (elapsedMs > START_BUDGET_MS) {
    appendLog(`重试：DSH ${Math.round(elapsedMs / 1000)} 秒未就绪，终止后重新拉起`)
    await stopDsh()
    await waitPortFree()
    const reason = startDsh()
    if (reason) {
      appendLog(`重启 DSH 被拒绝: ${reason}`)
      setState({ value: 'failed' })
    } else {
      setState({ value: 'starting' })
    }
  } else {
    appendLog(`DSH 仍在启动中（已 ${Math.round(elapsedMs / 1000)} 秒），继续等待…`)
    setState({ value: 'starting' })
  }
})
ipcMain.handle('launcher:openExternal', (_e, url) => {
  // webview 内 window.open 的外部链接：仅放行 http/https，交给系统浏览器
  if (typeof url === 'string' && /^https?:\/\//i.test(url)) shell.openExternal(url)
})
ipcMain.handle('launcher:stopDsh', () => stopDsh())
ipcMain.handle('launcher:copyLog', () => {
  const text = state.log.join('\n')
  const { clipboard } = require('electron')
  clipboard.writeText(text)
  return text
})

// webview 弹窗策略统一在主进程接管：<webview>.getWebContents() 已废弃，
// 且渲染层逐实例接线脆弱。凡 webview 类型的 WebContents 一律：
// 外部 http(s) 链接交给系统浏览器，其余弹窗拒绝。
app.on('web-contents-created', (_event, wc) => {
  if (wc.getType() === 'webview') {
    wc.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) shell.openExternal(url)
      return { action: 'deny' }
    })
    // 导航拦截：仅放行 loopback 地址，防止不可信远程内容进入内嵌 webview
    // （DSH GUI 内的外部链接应被拦截并交给系统浏览器打开）。
    wc.on('will-navigate', (e, url) => {
      if (!/^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?(?:\/|$)/i.test(url)) {
        e.preventDefault()
        if (/^https?:\/\//i.test(url)) shell.openExternal(url)
      }
    })
  }
})

// ---------------------------------------------------------------- lifecycle
const startHidden = process.argv.includes('--hidden')
let trayNotified = false
let winShownOnce = false

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', showWindow)
  app.whenReady().then(() => {
    ensureLogBom()
    // webview 会话权限默认拒绝：DSH Web GUI 不需要通知/摄像头/地理位置等敏感权限，
    // 防止被导航进入的不可信页面申请权限。允许无害的剪贴板写入（复制按钮）。
    const { session } = require('electron')
    const webviewSession = session.fromPartition('persist:dsh-launcher')
    const allowedPermissions = new Set(['clipboard-sanitized-write'])
    webviewSession.setPermissionRequestHandler((_wc, permission, callback) => {
      callback(allowedPermissions.has(permission))
    })
    webviewSession.setPermissionCheckHandler((_wc, permission) => allowedPermissions.has(permission))
    createWindow()
    createTray()
    setState({ value: 'idle', log: [] })
    ensureRunning()
    probeTimer = setInterval(ensureRunning, PROBE_INTERVAL_MS)
  })
}

app.on('window-all-closed', () => { /* 托盘驻留，不退出 */ })

app.on('before-quit', () => { quitting = true })
