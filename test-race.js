// 竞态回归测试：旧进程的退出事件迟到时，不得清掉新进程的全局引用 / 误置状态。
// 重现 2026-08-22 事故：重试强杀 #1 后立即启动 #2，#1 的 exit 事件晚到 →
// 旧代码把全局 child 置 null → 下一次重试不再先停止就重复拉起 → EADDRINUSE 连环失败。
// 运行：node test-race.js   （纯桩环境，不启动真实 DSH；可用 RACE_MAIN=路径 指定被测 main.js）
const fs = require('fs')
const path = require('path')
const os = require('os')
const Module = require('module')
const { EventEmitter } = require('events')

const mainPath = process.env.RACE_MAIN || path.join(__dirname, 'main.js')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'launcher-race-'))

const spawned = []
function fakeSpawn(cmd, args, opts) {
  const c = new EventEmitter()
  c.pid = 5000 + spawned.length
  c.stdout = new EventEmitter()
  c.stderr = new EventEmitter()
  c.unref = () => {}
  c.kill = () => {}
  spawned.push(c)
  return c
}

const stubs = {
  electron: {
    app: {
      setAppUserModelId() {},
      getPath: () => tmp,
      getAppPath: () => tmp,
      whenReady: () => Promise.resolve(),
      on() {},
      quit() {},
      requestSingleInstanceLock: () => true,
      getLoginItemSettings: () => ({ openAtLogin: false }),
      setLoginItemSettings() {},
    },
    BrowserWindow: class {
      constructor() { this.webContents = { send() {}, on() {}, getURL: () => '', setWindowOpenHandler() {}, getTitle: () => '' } }
      loadFile() { return Promise.resolve() }
      on() {} once() {} hide() {} show() {} isDestroyed() { return false } isVisible() { return false }
      isMinimized() { return false } focus() {} restore() {} setBounds() {} isMaximized() { return false } getBounds() { return {} }
    },
    Tray: class { constructor() {} setToolTip() {} setContextMenu() {} on() {} displayBalloon() {} },
    Menu: { buildFromTemplate: () => ({}) },
    shell: { openExternal() {}, openPath() {} },
    nativeImage: { createFromPath: () => ({}) },
    ipcMain: { handle() {} },
    screen: { getAllDisplays: () => [{ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }] },
    clipboard: { writeText() {} },
    session: { fromPartition: () => ({
      setPermissionRequestHandler() {},
      setPermissionCheckHandler() {},
    }) },
  },
  child_process: {
    spawn: fakeSpawn,
    // 所有 execFile（netstat/powershell/taskkill）一律立即成功、空输出：
    // findPidOnPort → null，looksLikeDsh → false，taskkill → 无操作。
    // 签名无关：兼容 (cmd, args, cb) 与 (cmd, args, options, cb) 两种形式。
    execFile: (...a) => {
      const cb = a.find((x) => typeof x === 'function')
      if (cb) cb(null, '')
    },
  },
}

const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request]
  return origLoad.apply(this, arguments)
}

// 加载 main.js 并把内部函数暴露出来供测试驱动
const src = fs.readFileSync(mainPath, 'utf8')
const wrapped = src + '\nmodule.exports.__test = { startDsh, stopDsh, restartDsh, getChild: () => child, getState: () => state, setState, getChildStartAt: () => childStartAt }'
const m = new Module(mainPath, module)
m.filename = mainPath
m.paths = Module._nodeModulePaths(path.dirname(mainPath))
m._compile(wrapped, mainPath)

const T = m.exports.__test

;(async () => {
  await new Promise((r) => setTimeout(r, 120))   // 等 whenReady 回调跑完
  const g = T.getState()

  // --- 场景 1：重试强杀 #1，其 exit 事件在 #2 启动后才到达 ---
  g.value = 'starting'
  T.startDsh()                       // #1
  const c1 = T.getChild()
  console.log('#1 spawned pid =', c1 && c1.pid)
  if (!c1 || c1.pid !== 5000) throw new Error('FAIL: #1 未启动')

  await T.stopDsh()                  // 模拟重试：停止（taskkill 强杀，execFile 桩立即返回）
  g.value = 'starting'
  T.startDsh()                       // #2
  const c2 = T.getChild()
  console.log('#2 spawned pid =', c2 && c2.pid)
  if (!c2 || c2.pid !== 5001) throw new Error('FAIL: #2 未启动')

  // 迟到事件：旧进程 #1 的 exit 现在才到达
  c1.emit('exit', 1, null)

  const cAfter = T.getChild()
  console.log('after stale exit: child =', cAfter && cAfter.pid, '| state =', g.value)
  if (cAfter !== c2) throw new Error(`FAIL: 旧进程退出事件清掉了新进程引用 (got ${cAfter && cAfter.pid}, want ${c2.pid})`)
  if (g.value === 'failed') throw new Error('FAIL: 旧进程退出事件错误地把状态置为 failed')
  console.log('PASS: 旧进程迟到退出不再影响新进程')

  // --- 场景 2：当前进程自然退出（未就绪）仍正确置 failed ---
  g.value = 'starting'
  c2.emit('exit', 1, null)
  if (T.getChild() !== null) throw new Error('FAIL: 当前进程退出后 child 应为 null')
  if (g.value !== 'failed') throw new Error(`FAIL: 当前进程退出后应为 failed，实际 ${g.value}`)
  console.log('PASS: 当前进程退出仍正确置 failed')

  // --- 场景 3：restartDsh 停止 → 端口释放 → 重新拉起 ---
  await T.restartDsh()
  const c3 = T.getChild()
  console.log('#3 spawned pid =', c3 && c3.pid, '| state =', g.value)
  if (!c3 || c3.pid !== 5002) throw new Error('FAIL: restartDsh 未重新拉起')
  console.log('PASS: restartDsh 停止→等端口释放→拉起 正常')

  // --- 场景 4：EADDRINUSE 快速退出不误置 failed（端口被另一实例占用时保持等待） ---
  // 场景：用户先手动启动 DSH（冷启动未监听）→ 启动器探测 down 误拉第二实例 →
  // 外部实例先绑端口 → 第二实例 EADDRINUSE 退出。旧代码误置 failed，
  // 外部实例就绪后 failed 防翻转保护会让 UI 卡死；新代码保持 starting + 恢复
  // 启动时间戳，探测循环就绪后自动翻转 ready。
  c3.emit('exit', 0, null)   // 先让场景 3 的进程退出，释放 child
  g.value = 'starting'
  T.startDsh()                       // #4
  const c4 = T.getChild()
  if (!c4 || c4.pid !== 5003) throw new Error('FAIL: #4 未启动')
  const startedAt4 = T.getChildStartAt()
  await new Promise((r) => setTimeout(r, 30))   // 让启动时间戳与退出时刻拉开
  c4.stdout.emit('data', 'Error: listen EADDRINUSE: address already in use 127.0.0.1:3080\n')
  c4.emit('exit', 1, null)
  if (T.getChild() !== null) throw new Error('FAIL: EADDRINUSE 退出后 child 应为 null')
  if (g.value !== 'starting') throw new Error(`FAIL: EADDRINUSE 应保持 starting 等待，实际 ${g.value}`)
  const restoredAt = T.getChildStartAt()
  if (restoredAt !== startedAt4) throw new Error(`FAIL: EADDRINUSE 应恢复启动时间戳 (got ${restoredAt}, want ${startedAt4})`)
  console.log('PASS: EADDRINUSE 快速退出保持 starting 并恢复启动时间戳')

  // --- 场景 5：普通快速失败（非 EADDRINUSE）仍正确置 failed ---
  g.value = 'starting'
  T.startDsh()                       // #5
  const c5 = T.getChild()
  if (!c5 || c5.pid !== 5004) throw new Error('FAIL: #5 未启动')
  c5.stdout.emit('data', 'SyntaxError: Unexpected token in config\n')
  c5.emit('exit', 1, null)
  if (g.value !== 'failed') throw new Error(`FAIL: 普通快速失败应为 failed，实际 ${g.value}`)
  console.log('PASS: 非端口占用的快速失败仍正确置 failed')

  console.log('\n全部通过 ✓')
  process.exit(0)
})().catch((e) => { console.error(e); process.exit(1) })
