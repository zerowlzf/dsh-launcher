// DSH 启动器 — 渲染层
/* global launcher */
// 防御：preload 加载失败（路径损坏/被杀毒拦截）时 window.launcher 不存在，
// 后续所有 IPC 调用会抛 ReferenceError → 整个脚本中断 → 界面静默黑屏、无任何提示。
// 在此显式给出文案并终止，把"最难排查的黑屏"变成一眼可读的错误页。
if (!window.launcher) {
  const el0 = (id) => document.getElementById(id)
  if (el0('launch-status')) el0('launch-status').textContent = '启动器内部通信初始化失败（preload 未加载）。请关闭启动器后重新打开；若反复出现，请检查安装目录是否完整。'
  if (el0('spinner')) el0('spinner').style.display = 'none'
  throw new Error('launcher preload missing: renderer aborted')
}
const el = (id) => document.getElementById(id)
const view = el('view')
const launch = el('launch')
const banner = el('banner')
const logPre = el('log')
const statusText = el('launch-status')
const spinner = el('spinner')
const actions = el('actions')
const pill = el('status-pill')
const pillText = el('pill-text')
const bannerText = el('banner-text')
const bannerRetry = el('banner-retry')

let currentState = 'idle'
let currentUrl = 'http://127.0.0.1:3080'
let viewReady = false
let ensureTimer = null
let prevState = 'idle'
let everReady = false   // 页面曾成功加载过（区分首次加载与重新加载）

// 单次获取状态（加载时）
launcher.getState().then((s) => applyStatus(s))

// 推送订阅
launcher.onStatus(applyStatus)

function applyStatus(s) {
  // 页面曾加载过、且不是连续 ready 推送（degraded/stopped/failed/重启后 starting 而来）
  // → 强制重载 webview，避免停留在断线/旧会话页面。首次 ready 不 reload。
  const recovered = s.state === 'ready' && everReady && prevState !== 'ready'
  if (s.state === 'ready') everReady = true
  prevState = s.state
  currentState = s.state
  currentUrl = s.url

  // 标题栏状态点
  pill.className = s.state
  const labels = {
    idle: '连接中…',
    starting: '启动中…',
    ready: '运行中',
    degraded: '连接断开',
    stopped: '已停止',
    failed: '启动失败',
  }
  pillText.textContent = labels[s.state] || s.state

  // 启动覆盖层
  if (s.state === 'ready' || s.state === 'degraded') {
    launch.hidden = true
  } else {
    launch.hidden = false
    launch.className = s.state
  }

  // 非就绪/断线时隐藏 webview，避免后台加载无关页面
  const showWebview = s.state === 'ready' || s.state === 'degraded'
  view.style.display = showWebview ? '' : 'none'

  // 启动覆盖层内容
  const statusMsgs = {
    idle: '正在探测 DSH 服务…',
    starting: '正在启动 DSH，请稍候…',
    stopped: 'DSH 已停止',
    failed: 'DSH 启动失败，请查看日志后重试',
  }
  statusText.textContent = statusMsgs[s.state] || s.state

  // 日志
  if (s.log && s.log.length > 0) {
    launch.classList.add('has-log')
    // 仅当用户本就停留在底部附近时才自动跟随，避免翻阅历史时被拽回末尾
    const nearBottom = logPre.scrollHeight - logPre.scrollTop - logPre.clientHeight < 40
    logPre.textContent = s.log.join('\n')
    if (nearBottom) logPre.scrollTop = logPre.scrollHeight
  } else {
    launch.classList.remove('has-log')
  }

  // 操作按钮
  if (s.state === 'failed' || s.state === 'stopped') {
    actions.hidden = false
  } else {
    actions.hidden = true
  }

  // 横幅
  if (s.state === 'degraded') {
    banner.hidden = false
    bannerText.textContent = 'DSH 连接断开，正在等待恢复…'
    bannerRetry.textContent = '立即重连'
  } else if (s.state === 'stopped') {
    banner.hidden = false
    bannerText.textContent = 'DSH 已停止，点击“重新启动”恢复。'
    bannerRetry.textContent = '重新启动'
  } else if (s.state === 'failed') {
    banner.hidden = false
    bannerText.textContent = 'DSH 启动失败，请查看日志。'
    bannerRetry.textContent = '重试'
  } else {
    banner.hidden = true
  }

  // 就绪时确保 webview 加载（幂等：src 未生效则轮询重试）
  if (s.state === 'ready') {
    if (recovered) {
      viewReady = false
      // 仅当 webview 已在使用目标 URL（lastSetUrl 与 currentUrl 一致，token 未变）时
      // 才需要 reload（刷新断线/旧会话页面）；若 URL/令牌已变化，直接导航到新 URL，
      // 先 reload 旧 src 只会白加载一次（旧令牌 URL → 401）。
      // 注意不能比较 getAttribute('src')：DSH 认证 303 重定向会把该属性改写为 /，
      // 用它做比较会陷入"永远不匹配→反复设置 src→重定向→再比较"的闪烁循环。
      if (lastSetUrl === currentUrl) view.reload()
    }
    ensureWebviewLoaded(6)
  }
}

// 最后实际设置给 webview 的 src。webview 的 getAttribute('src') 会被 DSH 认证
// 303 重定向改写成 /（Cookie 已建立），因此不能用它判断"目标是否已生效"；
// 只能跟踪自己最后一次设置的值。
let lastSetUrl = ''

// 访客是否已开始加载：主框架正在加载、或已提交到非 about:blank 的 URL 都算开始。
// 元素未升级（方法不存在）或停在 about:blank 算没开始。
function guestLoadStarted() {
  try {
    if (typeof view.isLoadingMainFrame === 'function' && view.isLoadingMainFrame()) return true
    const url = view.getURL()
    return typeof url === 'string' && url !== '' && url !== 'about:blank'
  } catch { return false }
}

function ensureWebviewLoaded(retries, force) {
  const target = currentUrl
  if (lastSetUrl === target && viewReady) {
    clearTimeout(ensureTimer)
    return
  }

  view.style.display = ''
  viewReady = false
  // 关键：<webview> 自定义元素升级完成前给 .src 赋值只会写到一个普通属性上，元素升级后
  // 仍按初始 src="about:blank" 建访客，赋值被静默丢弃 —— 状态就绪得越早（DSH 已在运行、
  // 首个探测立刻成功）越容易踩中，表现是标题栏"运行中"而内容区全黑。
  // setAttribute 直接改 DOM 属性，升级前后都有效，所以同步路径只下发一次。
  // 只有目标变化、或到点仍未开始加载（force）才重发：主进程每次 appendLog 都会 push 状态，
  // 同步重发会把在途加载反复打断（实测 200ms 推送 + 3s 响应时服务端收到 119 次请求、
  // 页面永远加载不完）。
  if (lastSetUrl !== target || force) {
    lastSetUrl = target
    view.setAttribute('src', target)
  }

  clearTimeout(ensureTimer)
  ensureTimer = setTimeout(() => {
    if (currentState === 'ready' && !guestLoadStarted() && retries > 0) {
      console.log('webview 未开始加载，补发 src（剩余重试', retries - 1, '）')
      ensureWebviewLoaded(retries - 1, true)
    }
  }, 1200)
}

// webview 生命周期兜底 + 诊断转发
view.addEventListener('dom-ready', () => {
  if (currentState === 'ready') ensureWebviewLoaded(6)
})

// webview 内 window.open 的弹窗策略已上移到主进程统一接管
// （app.on('web-contents-created')，见 main.js）；此处不再逐实例接线
// （<webview>.getWebContents() 已废弃）。

view.addEventListener('did-finish-load', (e) => {
  // 子框架（iframe 等）完成加载不代表主页面就绪，误置 viewReady 会让
  // ensureWebviewLoaded 提前短路、跳过本该有的重试
  if (!e.isMainFrame) return
  viewReady = true
  if (currentState === 'ready') banner.hidden = true
})

view.addEventListener('did-fail-load', (e) => {
  // 子框架/子资源加载失败不代表页面坏了；-3(ERR_ABORTED) 是 reload()/导航
  // 中断的正常副作用（如 recovered 重载打断在途请求），两者都不弹横幅。
  if (!e.isMainFrame || e.errorCode === -3) return
  viewReady = false
  console.error('webview fail-load:', e.errorCode, e.errorDescription)
  banner.hidden = false
  bannerText.textContent = `页面加载失败 (${e.errorDescription || e.errorCode})，等待重连…`
  bannerRetry.textContent = '重试'
})

// 访客渲染进程崩溃自愈：吸收官方桌面端（platform-view / browser-guests）对
// render-process-gone 的处理——官方在宿主崩溃时释放视图，launcher 变体是横幅 +
// 恢复加载。DSH GUI 是本地服务上的健壮 Web 应用，崩溃多为一时性（GPU 复位/内存
// 压力），重载即可恢复；探测循环只看服务端，访客崩溃对它不可见，不在这里接住
// 就是静默黑屏。注意事件形状是 e.details.reason（与主进程 render-process-gone
// 的参数一致，不是 e.reason）。
view.addEventListener('render-process-gone', (e) => {
  const reason = (e && e.details && e.details.reason) || '未知原因'
  if (reason === 'clean-exit') return
  viewReady = false
  console.error('webview render-process-gone:', reason)
  banner.hidden = false
  bannerText.textContent = `页面渲染进程退出（${reason}），正在重新加载…`
  bannerRetry.textContent = '重试'
  try { view.reload() } catch { /* 访客已死时 reload 偶发抛错 */ }
  // 双保险：reload 只重载当前提交 URL；若 src 属性已被 303 认证重定向改写（或停在
  // about:blank），强制重发目标 src 走全新导航。属性值相同的情况下 setAttribute
  // 不触发变更，不会打断上面 reload 的在途加载。
  ensureWebviewLoaded(6, true)
})

view.addEventListener('console-message', (e) => {
  console.log(`[webview] ${e.message}`)
})

// 按钮事件
el('btn-retry').addEventListener('click', () => {
  launcher.retry()
  viewReady = false
})

el('btn-stop').addEventListener('click', () => launcher.stopDsh())
el('btn-browser').addEventListener('click', () => launcher.openBrowser())
el('btn-copy-log').addEventListener('click', () => {
  launcher.copyLog().then((text) => {
    const btn = el('btn-copy-log')
    btn.textContent = '已复制！'
    setTimeout(() => { btn.textContent = '复制日志' }, 1500)
  })
})

// 横幅按钮：统一语义 —— 确保 DSH 在运行（探测 + 必要时拉起），
// 端口恢复后状态推送会驱动 webview 自动加载。
bannerRetry.addEventListener('click', () => {
  bannerRetry.disabled = true
  bannerRetry.textContent = '正在处理…'
  // ready 状态下 retry() 不会翻转状态（prevState 仍为 ready → recovered=false），
  // 而 ensureWebviewLoaded 因 src 已匹配不会重设 → 加载失败后重试会卡死。
  // 因此 ready 时显式 reload webview。
  if (currentState === 'ready') {
    viewReady = false
    view.reload()
  }
  launcher.retry().finally(() => {
    // 只恢复可用态，不在此重写文案：retry 引发的状态推送会经 applyStatus
    // 重设横幅文字；这里再写会用错文案覆盖（如 failed 态应显示“重试”）
    bannerRetry.disabled = false
  })
})
