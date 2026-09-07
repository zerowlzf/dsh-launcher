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
// 预检的 node --version 输出可被场景调节（fakeNodeVersion），默认满足回退 engines
let fakeNodeVersion = 'v24.15.0'
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
const src = fs.readFileSync(mainPath, 'utf8')
const wrapped = src + '\nmodule.exports.__test = { startDsh, stopDsh, relaunchDsh, setCfg, runPreflight, parseVersionTuple, parseEnginesRange, readEnginesRange, isTsxArg, getChild: () => child, getState: () => state, setState, getChildStartAt: () => childStartAt }'
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

  // --- 场景 6：启动预检拒绝时不拉起子进程，原因经 startDsh 返回 ---
  // 真实预检走 tsx 依赖分支拒绝：临时移除夹具的 node_modules
  g.value = 'starting'
  fs.rmSync(path.join(preflightDshRoot, 'node_modules'), { recursive: true, force: true })
  const reason6 = T.startDsh()
  if (!reason6 || !reason6.includes('pnpm install')) throw new Error(`FAIL: 预检拒绝应返回依赖原因，实际 ${JSON.stringify(reason6)}`)
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
  c6.emit('exit', 1, null)              // 快速失败 + no-open 报错 → 触发回退递归
  const c6b = T.getChild()
  if (!c6b || c6b.pid === c6.pid) throw new Error('FAIL: 兜底递归未重新拉起')
  if (g.value !== 'starting') throw new Error(`FAIL: 兜底递归成功后应为 starting，实际 ${g.value}`)
  const persisted = JSON.parse(fs.readFileSync(path.join(tmp, 'settings.json'), 'utf8'))
  if (persisted.noOpen !== false || persisted.startCmd.includes('--no-open')) {
    throw new Error(`FAIL: 兜底递归应持久化 noOpen:false，实际 ${JSON.stringify(persisted)}`)
  }
  console.log('PASS: --no-open 兜底递归重新拉起并持久化回退')

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

  console.log('\n全部通过 ✓')
  process.exit(0)
})().catch((e) => { console.error(e); process.exit(1) })
