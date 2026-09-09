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
// 初始化失败收尾 / 子进程环境剥离的观测点
const dialogCalls = []
const exitCalls = []
// 预检的 node --version 输出可被场景调节（fakeNodeVersion），默认满足回退 engines
let fakeNodeVersion = 'v24.15.0'
function fakeSpawn(cmd, args, opts) {
  const c = new EventEmitter()
  c.pid = 5000 + spawned.length
  c.stdout = new EventEmitter()
  c.stderr = new EventEmitter()
  // 与真实 ChildProcess 同形：运行中 exitCode/signalCode 为 null，
  // exitsWithin 的"已退出"判定才走真实分支
  c.exitCode = null
  c.signalCode = null
  c.unref = () => {}
  // 真实 kill 会异步触发 exit：停止路径的"确认退出"等待才能在测试里走通
  c.kill = () => { setImmediate(() => emitExit(c, 0, null)) }
  spawned.push(c)
  return c
}

// 统一的退出注入：先同步 exitCode/signalCode，再发 exit 事件（顺序与真实 ChildProcess 一致）
function emitExit(c, code, signal) {
  c.exitCode = code
  c.signalCode = signal
  c.emit('exit', code, signal)
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
      exit: (code) => { exitCalls.push(code) },
    },
    dialog: { showErrorBox: (title, content) => { dialogCalls.push([title, content]) } },
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
    // 预检的 node --version 用固定输出，不依赖机器真实 node（版本可用 fakeNodeVersion 调节）
    spawnSync: () => ({ status: 0, stdout: fakeNodeVersion + '\n', stderr: '' }),
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
// CHILD_ENV 在模块加载时快照 process.env：先注入污染变量，再编译，验证剥离名单。
process.env.NODE_OPTIONS = '--inspect=127.0.0.1:9229'
process.env.npm_config_registry = 'https://mirror.invalid/'
process.env.PNPM_HOME = 'C:\\pnpm-home'
process.env.corepack_home = 'C:\\corepack'
process.env.DSH_DESKTOP_SEED = 'C:\\desktop-seed'
const PATH_BEFORE = process.env.PATH
const src = fs.readFileSync(mainPath, 'utf8')
const wrapped = src + '\nmodule.exports.__test = { startDsh, startDshOrFail, stopDsh, relaunchDsh, setCfg, runPreflight, parseVersionTuple, parseEnginesRange, readEnginesRange, isTsxArg, handleInitFailure, CHILD_ENV, classifyExit, writeFileAtomicSync, webDistIndex, getChild: () => child, getState: () => state, setState, getChildStartAt: () => childStartAt }'
const m = new Module(mainPath, module)
m.filename = mainPath
m.paths = Module._nodeModulePaths(path.dirname(mainPath))
m._compile(wrapped, mainPath)

const T = m.exports.__test

// 纯桩环境：预检指向伪造 DSH 根（真实落盘的夹具目录，
// node --version 由 spawnSync 桩固定），既有竞态场景不依赖机器真实状态
const preflightDshRoot = path.join(tmp, 'preflight-dsh-root')
fs.mkdirSync(path.join(preflightDshRoot, 'apps/cli/src'), { recursive: true })
fs.writeFileSync(path.join(preflightDshRoot, 'apps/cli/src/bin.ts'), '// stub\n')
fs.mkdirSync(path.join(preflightDshRoot, 'node_modules/tsx'), { recursive: true })
fs.writeFileSync(path.join(preflightDshRoot, 'package.json'), JSON.stringify({ engines: { node: '>=20.0.0' } }))
T.setCfg({ dshDir: preflightDshRoot })

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
  emitExit(c1, 1, null)

  const cAfter = T.getChild()
  console.log('after stale exit: child =', cAfter && cAfter.pid, '| state =', g.value)
  if (cAfter !== c2) throw new Error(`FAIL: 旧进程退出事件清掉了新进程引用 (got ${cAfter && cAfter.pid}, want ${c2.pid})`)
  if (g.value === 'failed') throw new Error('FAIL: 旧进程退出事件错误地把状态置为 failed')
  console.log('PASS: 旧进程迟到退出不再影响新进程')

  // --- 场景 2：当前进程自然退出（未就绪）仍正确置 failed ---
  g.value = 'starting'
  emitExit(c2, 1, null)
  if (T.getChild() !== null) throw new Error('FAIL: 当前进程退出后 child 应为 null')
  if (g.value !== 'failed') throw new Error(`FAIL: 当前进程退出后应为 failed，实际 ${g.value}`)
  console.log('PASS: 当前进程退出仍正确置 failed')

  // --- 场景 3：relaunchDsh 停止 → 端口释放 → 重新拉起 ---
  await T.relaunchDsh()
  const c3 = T.getChild()
  console.log('#3 spawned pid =', c3 && c3.pid, '| state =', g.value)
  if (!c3 || c3.pid !== 5002) throw new Error('FAIL: relaunchDsh 未重新拉起')
  console.log('PASS: relaunchDsh 停止→等端口释放→拉起 正常')

  // --- 场景 4：EADDRINUSE 快速退出不误置 failed（端口被另一实例占用时保持等待） ---
  // 场景：用户先手动启动 DSH（冷启动未监听）→ 启动器探测 down 误拉第二实例 →
  // 外部实例先绑端口 → 第二实例 EADDRINUSE 退出。旧代码误置 failed，
  // 外部实例就绪后 failed 防翻转保护会让 UI 卡死；新代码保持 starting + 恢复
  // 启动时间戳，探测循环就绪后自动翻转 ready。
  emitExit(c3, 0, null)   // 先让场景 3 的进程退出，释放 child
  g.value = 'starting'
  T.startDsh()                       // #4
  const c4 = T.getChild()
  if (!c4 || c4.pid !== 5003) throw new Error('FAIL: #4 未启动')
  const startedAt4 = T.getChildStartAt()
  await new Promise((r) => setTimeout(r, 30))   // 让启动时间戳与退出时刻拉开
  c4.stdout.emit('data', 'Error: listen EADDRINUSE: address already in use 127.0.0.1:3080\n')
  emitExit(c4, 1, null)
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
  emitExit(c5, 1, null)
  if (g.value !== 'failed') throw new Error(`FAIL: 普通快速失败应为 failed，实际 ${g.value}`)
  console.log('PASS: 非端口占用的快速失败仍正确置 failed')

  // --- 场景 6：启动预检拒绝时不拉起子进程，原因经 startDsh 返回 ---
  // 真实预检走 tsx 依赖分支拒绝：临时移除夹具的 node_modules
  g.value = 'starting'
  fs.rmSync(path.join(preflightDshRoot, 'node_modules'), { recursive: true, force: true })
  const rejection6 = T.startDsh()
  if (!rejection6 || !rejection6.reason.includes('pnpm install')) throw new Error(`FAIL: 预检拒绝应返回依赖原因，实际 ${JSON.stringify(rejection6)}`)
  if (rejection6.transient !== false) throw new Error('FAIL: 预检拒绝应标记 transient=false（重试不会自愈）')
  if (T.getChild() !== null) throw new Error('FAIL: 预检拒绝后不应拉起子进程')
  if (g.value !== 'starting') throw new Error(`FAIL: startDsh 只返回原因不改状态（收尾由调用方负责），实际 ${g.value}`)
  console.log('PASS: 预检拒绝不拉起子进程并返回原因')

  // --- 场景 6b：startDshOrFail 统一收尾——relaunchDsh 遇预检拒绝置 failed ---
  await T.relaunchDsh()
  if (g.value !== 'failed') throw new Error(`FAIL: relaunchDsh 应置 failed，实际 ${g.value}`)
  if (T.getChild() !== null) throw new Error('FAIL: relaunchDsh 拒绝后不应有子进程')
  fs.mkdirSync(path.join(preflightDshRoot, 'node_modules/tsx'), { recursive: true })   // 恢复夹具
  console.log('PASS: relaunchDsh 预检拒绝置 failed（统一收尾）')

  // --- 场景 6c：--no-open 兜底递归走 startDshOrFail 成功路径：重新拉起并持久化回退 ---
  g.value = 'starting'
  T.startDsh()                          // #6
  const c6 = T.getChild()
  if (!c6) throw new Error('FAIL: 兜底场景未拉起')
  c6.stdout.emit('data', "error: unknown option '--no-open'\n")
  emitExit(c6, 1, null)              // 快速失败 + no-open 报错 → 触发回退递归
  const c6b = T.getChild()
  if (!c6b || c6b.pid === c6.pid) throw new Error('FAIL: 兜底递归未重新拉起')
  if (g.value !== 'starting') throw new Error(`FAIL: 兜底递归成功后应为 starting，实际 ${g.value}`)
  const persisted = JSON.parse(fs.readFileSync(path.join(tmp, 'settings.json'), 'utf8'))
  if (persisted.noOpen !== false || persisted.startCmd.includes('--no-open')) {
    throw new Error(`FAIL: 兜底递归应持久化 noOpen:false，实际 ${JSON.stringify(persisted)}`)
  }
  console.log('PASS: --no-open 兜底递归重新拉起并持久化回退')

  // --- 场景 6d：守卫类拒绝标记 transient，startDshOrFail 保持状态等重试 ---
  // 复用 6c 留下的存活子进程：child 非空，任何拉起都会被守卫拒绝
  g.value = 'idle'
  const rejection6d = T.startDsh()
  if (!rejection6d || rejection6d.transient !== true) throw new Error(`FAIL: 已有子进程应标记 transient=true，实际 ${JSON.stringify(rejection6d)}`)
  const ret6d = T.startDshOrFail()
  if (g.value !== 'idle') throw new Error(`FAIL: 守卫类拒绝应保持 idle 等下一轮探测，实际 ${g.value}`)
  if (!ret6d || ret6d.reason !== rejection6d.reason) throw new Error('FAIL: startDshOrFail 应把拒绝原因原样返回')
  if (ret6d.transient !== true) throw new Error('FAIL: startDshOrFail 应把 transient 标记原样返回')
  emitExit(T.getChild(), 0, null)     // 收尾：释放子进程，避免影响后续场景
  if (T.getChild() !== null) throw new Error('FAIL: 收尾后 child 应为 null')
  console.log('PASS: 守卫类拒绝保持状态等重试，不翻 failed')

  // --- 场景 7：版本元组解析；不可解析（预发布后缀等）返回 null 走 fail-open ---
  for (const [v, want] of [
    ['v22.19.0', [22, 19, 0]], ['24.15.0', [24, 15, 0]],
    ['v24.0.0-rc.1', null], ['garbage', null], ['', null],
  ]) {
    const got = T.parseVersionTuple(v)
    if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`FAIL: parseVersionTuple(${JSON.stringify(v)}) = ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
  }
  console.log('PASS: 版本元组解析符合预期')

  // --- 场景 8：engines 约束解析与判定（^ / >= / 精确 / ||）---
  for (const [range, v, want] of [
    ['^22.19.0 || >=24.0.0', [22, 19, 0], true],
    ['^22.19.0 || >=24.0.0', [22, 19, 5], true],
    ['^22.19.0 || >=24.0.0', [22, 18, 9], false],
    ['^22.19.0 || >=24.0.0', [23, 1, 4], false],
    ['^22.19.0 || >=24.0.0', [24, 0, 0], true],
    ['^22.19.0 || >=24.0.0', [26, 3, 0], true],
    ['>=20.0.0', [21, 0, 0], true],
    ['>=20.0.0', [20, 0, 0], true],
    ['>=20.0.0', [19, 9, 0], false],
    ['^22.19.0', [23, 0, 0], false],
    ['^0.2.3', [0, 2, 9], true],      // npm caret 语义：0.x 锁次版本、允许补丁升级
    ['^0.2.3', [0, 3, 0], false],
    ['^0.0.3', [0, 0, 3], true],      // 0.0.z 等价精确
    ['^0.0.3', [0, 0, 4], false],
    ['22.19.0', [22, 19, 0], true],
    ['22.19.0', [22, 19, 1], false],
    ['>=22 <24', [22, 20, 0], null],   // 无法识别的子句 → 整体 null
  ]) {
    const rangeObj = T.parseEnginesRange(range)
    if (rangeObj === null) {
      if (want !== null) throw new Error(`FAIL: parseEnginesRange(${JSON.stringify(range)}) 应解析成功`)
      continue
    }
    const got = rangeObj.satisfied(v)
    if (got !== want) throw new Error(`FAIL: ${range} 对 v${v.join('.')} 判定 ${got}, want ${want}`)
  }
  console.log('PASS: engines 约束解析与判定符合预期')

  // --- 场景 9：runPreflight 各分支（真实实现 + existsSync 桩驱动）---
  // 存在性检查对预检夹具目录桩化：路径集合即"磁盘"，与机器真实文件无关
  const saveExists = fs.existsSync
  const fakeFiles = new Set()
  fs.existsSync = (p) => {
    const s = String(p)
    if (s.startsWith(preflightDshRoot)) return fakeFiles.has(s.slice(preflightDshRoot.length).replace(/\\/g, '/'))
    return saveExists(p)
  }
  const cfgBackup = { startCmd: ['node', '--import', 'tsx/esm', 'apps/cli/src/bin.ts', 'web', '--no-open'], dshDir: preflightDshRoot }
  try {
    T.setCfg({ dshDir: preflightDshRoot })
    // 9a：完整目录 + 桩 node v24.15.0 → 通过
    fakeFiles.add('/apps/cli/src/bin.ts'); fakeFiles.add('/node_modules/tsx')
    if (T.runPreflight() !== null) throw new Error('FAIL: 完整目录 + 合格 node 不应拒绝')
    // 9b：缺 tsx → 依赖未安装
    fakeFiles.delete('/node_modules/tsx')
    let r = T.runPreflight()
    if (!r || !r.includes('pnpm install')) throw new Error(`FAIL: 缺 tsx 应提示 pnpm install，实际 ${JSON.stringify(r)}`)
    // 9c：自定义命令带 my-tool.tsx 参数不得误触发依赖检查（正则收紧回归）
    fakeFiles.add('/node_modules/tsx')
    T.setCfg({ startCmd: ['node', 'my-tool.tsx'] })
    if (T.runPreflight() !== null) throw new Error('FAIL: my-tool.tsx 不应触发 tsx 依赖检查')
    // 9d：--flag=tsx 同样不触发
    T.setCfg({ startCmd: ['node', '--flag=tsx', 'x.js'] })
    if (T.runPreflight() !== null) throw new Error('FAIL: --flag=tsx 不应触发 tsx 依赖检查')
    // 9e：真正的 --import tsx/esm 仍会触发
    T.setCfg({ startCmd: ['node', '--import', 'tsx/esm', 'x.js'] })
    fakeFiles.delete('/node_modules/tsx')
    r = T.runPreflight()
    if (!r || !r.includes('pnpm install')) throw new Error(`FAIL: tsx/esm 应触发依赖检查，实际 ${JSON.stringify(r)}`)
    // 9f：引用 bin.ts 但文件不存在 → dshDir 提示
    fakeFiles.add('/node_modules/tsx'); fakeFiles.delete('/apps/cli/src/bin.ts')
    T.setCfg({ startCmd: ['node', '--import', 'tsx/esm', 'apps/cli/src/bin.ts', 'web'] })
    r = T.runPreflight()
    if (!r || !r.includes('bin.ts')) throw new Error(`FAIL: 缺 bin.ts 应提示 dshDir 问题，实际 ${JSON.stringify(r)}`)
    // 9g：startCmd 不引用 bin.ts/tsx 时跳过对应检查（检查跟随命令引用）
    fakeFiles.delete('/node_modules/tsx')
    T.setCfg({ startCmd: ['node', 'server.js'] })
    if (T.runPreflight() !== null) throw new Error('FAIL: 不引用 tsx/bin.ts 的命令不应被目录检查拦截')
    // 9h：DSH 源码命令 + node 版本不满足实时 engines → 版本拒绝（fakeNodeVersion 调节）
    fs.writeFileSync(path.join(preflightDshRoot, 'package.json'), JSON.stringify({ engines: { node: '^22.19.0 || >=24.0.0' } }))
    fakeFiles.add('/node_modules/tsx')
    T.setCfg({ startCmd: ['node', '--import', 'tsx/esm', 'x.js'] })
    fakeNodeVersion = 'v23.1.4'
    r = T.runPreflight()
    if (!r || !r.includes('^22.19.0 || >=24.0.0')) throw new Error(`FAIL: node 23 应被实时 engines 拒绝，实际 ${JSON.stringify(r)}`)
    fakeNodeVersion = 'v24.15.0'
    // 9i：同一命令、合格版本 → 通过（拒绝非永久，版本升级即恢复）
    if (T.runPreflight() !== null) throw new Error('FAIL: node 24 应通过实时 engines 检查')
    fs.writeFileSync(path.join(preflightDshRoot, 'package.json'), JSON.stringify({ engines: { node: '>=20.0.0' } }))
    fakeFiles.delete('/node_modules/tsx')
  } finally {
    fs.existsSync = saveExists
    T.setCfg(cfgBackup)
  }
  console.log('PASS: runPreflight 分支（tsx/bin.ts 引用门控）符合预期')

  // --- 场景 10：engines 实时读取（DSH package.json 优先，缺失回退内置）---
  const fakeDshRoot = path.join(tmp, 'dsh-root-test')
  fs.mkdirSync(fakeDshRoot, { recursive: true })
  fs.writeFileSync(path.join(fakeDshRoot, 'package.json'), JSON.stringify({ engines: { node: '>=20.0.0' } }))
  T.setCfg({ dshDir: fakeDshRoot })
  if (T.readEnginesRange().satisfied([21, 0, 0]) !== true) throw new Error('FAIL: 应读取 DSH 实时 engines（>=20 允许 21）')
  if (T.readEnginesRange().satisfied([19, 0, 0]) !== false) throw new Error('FAIL: 应读取 DSH 实时 engines（>=20 拒绝 19）')
  fs.rmSync(fakeDshRoot, { recursive: true, force: true })
  if (T.readEnginesRange().satisfied([23, 0, 0]) !== false) throw new Error('FAIL: engines 读不到时应回退内置约束（拒绝 23）')
  if (T.readEnginesRange().satisfied([22, 19, 0]) !== true) throw new Error('FAIL: engines 读不到时应回退内置约束（允许 22.19）')
  T.setCfg({ dshDir: preflightDshRoot })   // 恢复，避免悬空指向已删目录
  console.log('PASS: engines 实时读取 + 内置回退符合预期')

  // --- 场景 11：isTsxArg 门控（正则收紧回归）---
  for (const [arg, want] of [
    ['tsx/esm', true], ['--import', false], ['tsx', true], ['node_modules/tsx', true],
    ['my-tool.tsx', false], ['--flag=tsx', false], ['tsx.js', false], ['C:\\tools\\tsx\\esm', true],
  ]) {
    const got = T.isTsxArg(arg)
    if (got !== want) throw new Error(`FAIL: isTsxArg(${JSON.stringify(arg)}) = ${got}, want ${want}`)
  }
  console.log('PASS: isTsxArg 门控符合预期')

  // --- 场景 9j：前端静态资源缺失时告警但不拦截（锚点跟随 web-app bundle 的链接）---
  const feLink = path.join(preflightDshRoot, 'packages/bundle/web-app/node_modules/@deepseek-ai/dsh-web-frontend')
  fs.mkdirSync(path.join(feLink, 'dist'), { recursive: true })
  T.setCfg({ startCmd: ['node', '--import', 'tsx/esm', 'apps/cli/src/bin.ts', 'web', '--no-open'] })
  const logLen9j = g.log.length
  if (T.runPreflight() !== null) throw new Error('FAIL: 缺前端 dist 不应拦截启动（前端可用 Vite 开发）')
  if (!g.log.slice(logLen9j).some((l) => l.includes('前端资源未构建'))) throw new Error('FAIL: 缺前端 dist 应告警')
  fs.writeFileSync(path.join(feLink, 'dist/index.html'), '<html></html>')
  const logLen9k = g.log.length
  if (T.runPreflight() !== null) throw new Error('FAIL: 前端 dist 存在时不应告警')
  if (g.log.slice(logLen9k).some((l) => l.includes('前端资源未构建'))) throw new Error('FAIL: 前端 dist 存在时不应再告警')
  // 非 web 命令（如 headless）不检查前端资源
  fs.rmSync(path.join(feLink, 'dist/index.html'), { force: true })
  T.setCfg({ startCmd: ['node', '--import', 'tsx/esm', 'apps/cli/src/bin.ts', 'headless', 'x'] })
  const logLen9l = g.log.length
  T.runPreflight()
  if (g.log.slice(logLen9l).some((l) => l.includes('前端资源未构建'))) throw new Error('FAIL: 非 web 命令不应检查前端资源')
  fs.rmSync(path.join(preflightDshRoot, 'packages'), { recursive: true, force: true })   // 清理夹具
  T.setCfg({ startCmd: ['node', '--import', 'tsx/esm', 'apps/cli/src/bin.ts', 'web', '--no-open'] })
  console.log('PASS: 前端 dist 预检符合预期')

  // --- 场景 12：子进程环境剥离（NODE_OPTIONS / npm_ / pnpm_ / corepack_，保留 PATH）---
  const childEnv = T.CHILD_ENV
  for (const name of ['NODE_OPTIONS', 'npm_config_registry', 'PNPM_HOME', 'corepack_home', 'DSH_DESKTOP_SEED']) {
    if (childEnv[name] !== undefined) throw new Error(`FAIL: ${name} 应被剥离，实际 ${JSON.stringify(childEnv[name])}`)
  }
  // Windows 上 PATH 的实际键名是 `Path`：按大小写不敏感查找，避免误判为"被剥离"
  const pathKey = Object.keys(childEnv).find((k) => k.toUpperCase() === 'PATH')
  if (!pathKey || childEnv[pathKey] !== PATH_BEFORE) throw new Error(`FAIL: PATH 应原样继承（node 仍须能从 PATH 解析），键=${pathKey}`)
  console.log('PASS: 子进程环境剥离符合预期')

  // --- 场景 13：初始化失败不静默（日志 + 弹窗 + 非零退出码）---
  T.handleInitFailure(new Error('session 配置损坏'))
  const lastDialog = dialogCalls.at(-1)
  if (!lastDialog || !lastDialog[0].includes('初始化失败') || !lastDialog[1].includes('session 配置损坏')) {
    throw new Error(`FAIL: 初始化失败应弹窗报错，实际 ${JSON.stringify(lastDialog)}`)
  }
  if (exitCalls.at(-1) !== 1) throw new Error(`FAIL: 初始化失败应以退出码 1 退出，实际 ${JSON.stringify(exitCalls)}`)
  if (!g.log.some((l) => l.includes('启动器初始化失败'))) throw new Error('FAIL: 初始化失败应写日志')
  T.handleInitFailure('裸字符串异常')   // 非 Error 输入同样要有弹窗与退出码
  if (!dialogCalls.at(-1)[1].includes('裸字符串异常')) throw new Error('FAIL: 非 Error 输入应转成字符串进弹窗')
  if (exitCalls.at(-1) !== 1) throw new Error('FAIL: 非 Error 输入同样应以退出码 1 退出')
  console.log('PASS: 初始化失败走日志 + 弹窗 + 退出码 1')

  // --- 场景 14：令牌 URL 行即就绪信号，捕获后立即翻 ready（不等下一轮探测）---
  g.value = 'starting'
  T.startDsh()
  const c14 = T.getChild()
  if (!c14) throw new Error('FAIL: 场景 14 未拉起子进程')
  c14.stdout.emit('data', 'dsh web: http://127.0.0.1:3080/?token=tok-14\n')
  if (g.value !== 'ready') throw new Error(`FAIL: 捕获令牌后应立即 ready，实际 ${g.value}`)
  if (g.pid !== c14.pid) throw new Error(`FAIL: ready 应记录子进程 PID，实际 ${g.pid}`)
  emitExit(c14, 0, null)
  console.log('PASS: 令牌行即就绪信号')

  // --- 场景 15：退出原因分类（上游稳定的 stderr 前缀与退出码）---
  for (const [log, code, want] of [
    ['dsh: fatal load failure: Error: boom', 1, 'fatal load failure'],
    // 上游 fatal/用法错误都走 stderr，本启动器会给 stderr 行加 `ERR ` 前缀
    ['ERR dsh: fatal load failure: Error: boom', 1, 'fatal load failure'],
    ['dsh: plugin tree failed to load: web-app: boom', 1, 'plugin tree failed to load'],
    ['ERR dsh: host preparation failed: x', 1, 'host preparation failed'],
    ['Error [ERR_MODULE_NOT_FOUND]: Cannot find package "@deepseek-ai/dsh-app-boot"', 1, 'pnpm install'],
    ["error: unknown option '--nope'", 1, 'unknown option'],
    ["ERR error: unknown option '--nope'", 1, 'unknown option'],
    ['only noise', 1, null],
    ['whatever', 130, 'SIGINT'],
  ]) {
    const got = T.classifyExit(log, code)
    if (want === null ? got !== null : !String(got).includes(want)) {
      throw new Error(`FAIL: classifyExit(${JSON.stringify(log)}, ${code}) = ${JSON.stringify(got)}，应含 ${want}`)
    }
    if (got && got.startsWith('ERR ')) throw new Error(`FAIL: 分类结果不应带缓冲前缀，实际 ${JSON.stringify(got)}`)
  }
  // 分类结果要落到日志与状态：启动期致命错误不再只说"请查看日志"
  g.value = 'starting'
  T.startDsh()
  const c15 = T.getChild()
  c15.stderr.emit('data', 'dsh: plugin tree failed to load: web-app: boom\n')
  emitExit(c15, 1, null)
  if (g.value !== 'failed') throw new Error(`FAIL: 致命加载失败应置 failed，实际 ${g.value}`)
  if (!g.log.some((l) => l.includes('启动失败原因：dsh: plugin tree failed to load'))) {
    throw new Error('FAIL: 应把退出原因写进日志')
  }
  console.log('PASS: 退出原因分类符合预期')

  // --- 场景 16：settings.json 原子写（无残留临时文件、可反复覆盖）---
  const atomicFile = path.join(tmp, 'atomic-settings.json')
  T.writeFileAtomicSync(atomicFile, '{"a":1}')
  T.writeFileAtomicSync(atomicFile, '{"a":2}')
  if (JSON.parse(fs.readFileSync(atomicFile, 'utf8')).a !== 2) throw new Error('FAIL: 原子写覆盖后应为最新内容')
  const leftovers = fs.readdirSync(tmp).filter((n) => n.startsWith('atomic-settings.json.') && n.endsWith('.tmp'))
  if (leftovers.length) throw new Error(`FAIL: 原子写残留临时文件 ${JSON.stringify(leftovers)}`)
  console.log('PASS: 原子写配置符合预期')

  // --- 场景 17：停止确认（子进程退出事件到达才宣告停止）---
  g.value = 'starting'
  T.startDsh()
  if (!T.getChild()) throw new Error('FAIL: 场景 17 未拉起子进程')
  await T.stopDsh()
  if (T.getChild() !== null) throw new Error('FAIL: 停止后 child 应为 null')
  if (g.log.some((l) => l.includes('停止未确认'))) throw new Error('FAIL: 子进程已退出时不应报停止未确认')
  console.log('PASS: 停止确认符合预期')

  console.log('\n全部通过 ✓')
  process.exit(0)
})().catch((e) => { console.error(e); process.exit(1) })
