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

function ensureWebviewLoaded(retries) {
  const target = currentUrl
  if (lastSetUrl === target && viewReady) {
    clearTimeout(ensureTimer)
    return
  }

  view.style.display = ''
  viewReady = false
  if (lastSetUrl !== target) {
    lastSetUrl = target
    view.src = target
  }
  clearTimeout(ensureTimer)
  ensureTimer = setTimeout(() => {
    if (currentState === 'ready' && lastSetUrl !== currentUrl && retries > 0) {
      console.log('webview src 未生效，重试剩余', retries)
      ensureWebviewLoaded(retries - 1)
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
