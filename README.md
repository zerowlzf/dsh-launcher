# DSH 桌面启动器

为源码版 DeepSeek Harness 打造的 Windows 桌面启动器：Win11 风格炭黑窗口 + 托盘驻留 + 自动探测/启动/停止 DSH。

## 设计原则

- **只做启动器**：不修改 DSH 源码、不注入运行时、不改变 DSH 行为，只负责拉起 `dsh web` 并内嵌显示其 Web GUI。
- **轻量、独立**：不依赖 DSH 内部 API；只通过 HTTP 探测服务状态，通过标准命令启动/停止。
- **可退役**：退役仅由用户显式决定触发，任何外部变化（包括官方桌面端的出现、上游演进）都不构成退役条件；退役时不留侵入式改动。
- **长期维护**：本启动器照常独立维护、持续演进；过程中会汲取官方桌面端中有益的理念与做法，但定位与轻量哲学不变。
- **默认不弹浏览器**：DSH 由启动器内嵌展示，因此启动命令自动带 `--no-open`。

## 与官方桌面端的关系

上游 DSH 已出现官方 Electron 桌面端（`apps/desktop` 2026-08-28 起在 master 出现、`apps/desktop-host` 2026-09-04 出现，随 dsh 0.1.5-alpha.1 首次进入发布；截至 dsh 0.1.5-rc.2 两个包仍在 master 且仍为 `private: true`）：无监听端口（`dsh-app://` 协议 + 字节管道传输）、独占 `$DSH_HOME/profiles/desktop`、与 dsh 同版本发布，且 CLI 已禁止引导该 profile（`dsh --profile desktop` 报错）。启动器与官方桌面端互不冲突——启动器走 web 通道（3080 端口 + 源码模式），桌面端走自有通道与独立 profile。

按上方「可退役」设计原则，官方桌面端的出现不触发退役——退役只在用户显式决定时生效。本启动器继续使用与维护：官方桌面端面向打包分发与版本一体化场景，启动器覆盖源码模式跟随、托盘驻留与自动重启的既有工作流，两者互不替代。

**边界**：启动器不启动、不托管、不集成官方桌面端（`apps/desktop` / `apps/desktop-host`），不读写 `$DSH_HOME/profiles/desktop`，不传 `--profile desktop`。官方桌面端会发展出自己的完整生态（自有启动器、更新与分发体系），那是它的路；本启动器走自己的路——把源码模式跟随做到极致，不向它的生态伸手，也不等它来收编。两条路唯一的交集是同一个上游仓库，除此之外互为平行线。

- 体验官方桌面端（与启动器无关，仅备忘）：仓库根执行 `pnpm run dev:desktop`（构建后可直接 `pnpm run start:desktop`）；正式 Windows 安装包走 `pnpm run package:desktop:win:x64`（发布级需 EV 签名基础设施，`:dir` 变体产出免安装目录）
- 若用户显式决定退役：直接删除本目录即可，DSH 本体与官方桌面端不受影响（配置与日志见「卸载」）

## 依赖的上游契约

启动器只依赖下列上游契约，不读 DSH 内部 API。DSH 更新后按本表逐项核对（`核对基线：dsh 0.1.5-rc.2，HEAD 032c94ad2b`；本次核对覆盖自 `0.1.5-alpha.1` / `05b4b0eaac` 起的 425 个提交，九条契约全部未变，期间契约面唯一改动是 `packages/client/modules/src/index.ts` 的内部重构——helper 迁入 `./client/manifest.ts`，构建提示行为不变）。

| 契约 | 上游位置 | 启动器如何依赖 |
|---|---|---|
| `dsh web` 是 `--profile web` 的硬编码别名；web 参数族含 `--no-open`、`--host`、`--port`、`--trusted-host` | `apps/cli/src/args.ts`、`packages/bundle/web-app/src/startup.ts` | `startCmd` 启动参数；`--no-open` 缺失时自动补，上游不认时自动回退 |
| 启动令牌 URL 行 `dsh web: <url>?token=...`（`printUrl` 默认 true；LAN 地址以 `(LAN: ...)` 追加在同一行） | `packages/bundle/web-app/src/index.ts` | 从 stdout 捕获令牌，拼认证 URL 加载内嵌页面 |
| URL 行同时是**就绪信号**：只在 Loader 全部激活、Connection 可用后打印 | `packages/bundle/web-app/src/index.ts`（`announceReady` 注释与实现）、`packages/bundle/web-app/README.md` | 捕获令牌即翻转为运行中，不必等探测周期 |
| 探测语义：2xx/3xx = 服务在；401 = 需令牌；其余 = 未就绪 | `packages/client/connection/src/browser-auth.ts` | 探测状态机（ready / 需认证 / degraded） |
| 前端静态资源位置：前端包的 `dist/index.html`。解析锚点不硬编码目录：上游用 `require.resolve('@deepseek-ai/dsh-web-frontend/package.json')` 从 web-app 自身解析（等价于先查 web-app bundle 内的 `node_modules` 链接，再回退根 `node_modules`）；**dist 文件缺失**时服务照样绑定、令牌行照打、`/` 返回 404（上游只对缺失的 client bundle 给构建提示），而前端**包本身不可解析**时 web-app 在装配期直接抛错 | `packages/bundle/web-app/src/index.ts`（`resolveDistIndex`）、`packages/host/frontend-static/src/index.ts` | 预检据此在 dist 缺失时告警（不拦截），避免内嵌窗口静默 404；两种失败模式分别记日志 |
| 默认 host `127.0.0.1`、默认 port `3080` | `packages/bundle/web-app/cordis.patch.yml` | 探测与内嵌 URL 默认值；端口以 URL 行自报值为准（端口漂移跟随） |
| 源码启动须走 tsx 的 ESM 钩子（`node --import tsx/esm apps/cli/src/bin.ts`），仓库依赖中需有 `tsx`、入口文件需存在 | 根 `package.json`、`apps/cli/src/bin.ts`、`.agents/notes/implemented/architecture/2026-07-29-dsh-source-launch-tsx-esm.md` | 启动预检（缺 `node_modules/tsx` 提示 `pnpm install`、缺入口提示 `dshDir` 配错） |
| 根 `package.json` 的 `engines.node` 是源码运行的 node 版本要求 | 根 `package.json` | 启动预检实时读取（读不到回退 `^22.19.0 \|\| >=24.0.0`；读到但解析不了则跳过检查，不拿旧约束误拦），每次拉起现查 |
| `dsh --profile desktop` 由 CLI 拒绝（官方桌面端独占该 profile） | `apps/cli/src/args.ts`（`rejectElectronProfile`） | 保证两条通道互不干扰，启动器不会误接管桌面端 |

## 使用

- **双击 `Start-Launcher.vbs`** 启动（首次自动安装依赖，之后秒开）。
- 或命令行：`npx electron .`（目录内）。
- 回归测试：`npm test` = 纯桩竞态用例（`test-race.js`）+ webview 加载竞态用例（`test-webview.js`，会拉起隐藏窗口的 Electron，约 10 秒；不启动真实 DSH）。

## 功能

| 功能 | 说明 |
|---|---|
| 自动探测 | 启动即检查 `http://127.0.0.1:3080`，已在运行则直接内嵌显示 GUI |
| 自动启动 | 未运行时用源码版命令拉起：`node --import tsx/esm apps/cli/src/bin.ts web --no-open`（cwd = deepseek-harness，避免重复打开系统浏览器） |
| 启动预检 | 拉起前静态检查：源码启动命令（引用 `tsx` 或 `apps/cli/src/bin.ts`）的 node 版本须满足 DSH 根 package.json 的 `engines.node`（实时读取；读不到回退 `^22.19.0 \|\| >=24.0.0`，读到但解析不了则跳过检查；每次拉起现查，升级 Node 无需重启启动器）；参数为 `tsx` / `tsx/esm` 或路径形式指向 tsx 时要求 `node_modules\tsx` 已安装；命令引用了 `apps/cli/src/bin.ts` 时确认入口存在。以上不满足则不启动，日志与托盘弹泡给出可行动的提示（如"请在 DSH 目录执行 pnpm install"），替代难懂的底层报错。只检查 startCmd 自身引用到的项，自定义命令（如 `node my-tool.tsx`、`node my-server.js`）不受影响。另有一项**只告警不拦截**的检查：源码启动 + `web` 时按前端包锚点解析 `dist\index.html`，缺文件时提示 `pnpm run build`（不拦截，避免误伤前端用 Vite 开发、只借启动器拉起 `dsh web` 的工作流；锚点解析不了时只记一行提示） |
| 就绪判定 | 以 DSH 打印的 `dsh web:` URL 行为就绪信号（上游契约：该行在 Loader 全部激活、Connection 可用后才打印），捕获令牌即翻转为运行中，不必等下一轮探测；探测循环继续负责存活与断线恢复 |
| 失败原因翻译 | 子进程启动期退出时按上游稳定输出分类并直接给出原因：`dsh: fatal load failure:` / `host preparation failed:` / `plugin tree failed to load:`（原样透出）、模块解析失败（提示 `pnpm install`）、`error:` 用法错误、退出码 130（用户中断）；无匹配才回退"请查看日志" |
| 停止确认 | 点停止立即切「已停止」保证 UI 响应，随后最多等 3 秒确认子进程退出事件；`taskkill` 失败只记日志（子进程随后仍可能正常退出），确认到未退出时才弹泡告知可能仍在运行（状态停在用户意图的「已停止」，下次拉起的端口等待会兜底） |
| 现代化窗口 | Win11 圆角、无边框、系统窗口按钮（titleBarOverlay）、淡炭黑主题 |
| 启动状态页 | 动画 + DSH 实时输出日志（滚动保留 200 行），失败可一键重试 |
| 托盘驻留 | 关窗 = 最小化到托盘；托盘菜单：显示窗口 / 浏览器打开 / 打开 DSH 目录 / 打开配置目录 / 重启 DSH / 停止 DSH / 开机自启 / 退出 |
| 退出语义 | 「退出」保留 DSH 后台运行；「退出并停止 DSH」先杀服务 |
| 单实例 | 二次启动聚焦已有窗口；`--hidden` 参数 = 托盘驻留启动（开机自启用） |
| 断线横幅 | DSH 挂掉自动检测并提示，恢复后重连 |
| 内嵌加载兜底 | 状态早于 `<webview>` 自定义元素升级就绪时（DSH 已在运行 → 首个探测立刻成功），旧的 `view.src = …` 赋值会被元素升级丢弃、访客停在 `about:blank`，表现为标题栏"运行中"而内容区全黑。改为 `setAttribute('src')` 下发，并以"访客是否真的开始加载"为准补发（仅未开始加载时重试，不打断正在启动的页面）；`test-webview.js` 把这条锁死（2026-09-09 事故） |
| 托盘唤醒 | 点托盘图标时在 `show()`/`focus()` 之后 `moveTop()`，规避 Windows 前台锁导致的"点两次才打开" |
| 重试语义 | 窗口内的「重试 / 启动 DSH」与托盘「重新启动 DSH」共用一条停止→等端口→拉起流程：先校验端口上进程确实是 DSH（`looksLikeDsh`），是则停止并由本启动器重新拉起；端口被无关服务占用时不动作，仅在日志提示。拉起被拒绝时分两类收尾：预检类（node 版本 / 依赖缺失 / 入口缺失）置失败态并弹泡给出可行动的原因；守卫类（停止进行中、已有子进程）只记日志并保持可自愈状态等下一轮探测重试，用户点击触发的路径额外弹泡告知本次未生效。若启动时端口被正在冷启动的另一个 DSH 实例占用（EADDRINUSE），保持探测等待、就绪后自动转为运行中 |
| 端口漂移告警 | 检测到 DSH 输出中自报的监听端口与配置 `port` 不一致时，弹泡提醒修改 settings.json |
| **启动令牌认证** | 新版 DSH web 需要 `?token=` 启动令牌才能访问。启动器会在 DSH 输出行 `dsh web: http://127.0.0.1:PORT/?token=...` 中自动捕获令牌，并使用带令牌的认证 URL 加载 webview 页面。令牌会持久化到 settings.json，重启启动器后若 DSH 进程仍在运行，可复用令牌直接认证。 |

## 配置

`%APPDATA%\dsh-launcher\settings.json`（首次运行后生成）：

```json
{
  "port": 3080,
  "dshDir": "C:\\Users\\Administrator\\Desktop\\DSH\\deepseek-harness",
  "startCmd": ["node", "--import", "tsx/esm", "apps/cli/src/bin.ts", "web", "--no-open"],
  "noOpen": true
}
```

- `dshDir` 默认会优先使用启动器同级的 `deepseek-harness` 目录；如果不存在，再回退到旧版硬编码路径。
- 如果旧配置里的 `startCmd` 是 `web` 且缺少 `--no-open`，启动器会自动补上并写回配置。
- `noOpen` 控制是否自动追加 `--no-open`；如果某天 DSH 不再支持该参数，启动器会自动去掉它并写回 `"noOpen": false`。
- 启动 DSH 子进程时会剥离 `NODE_OPTIONS`、`NODE_PATH`、`DSH_DESKTOP_*` 与 `npm_*`/`pnpm_*`/`corepack_*` 环境变量（剥离名单对齐官方桌面端 `apps/desktop/src/host-process.ts`），避免终端里的调试配置（如 `--inspect`）或遗留的 CJS 全局解析路径污染 DSH 依赖树、也不让桌面端私有变量漏进 web 子进程；其余变量（含 `PATH`、`DSH_HOME`、代理变量）正常继承，需要给 DSH 传 Node 选项时请直接写进 `startCmd`（如 `"node", "--max-old-space-size=4096", ...`）。
- `settings.json` 采用「临时文件 + fsync + rename」原子写（含令牌；`mode 0600` 在 Windows 上基本无效，实际靠用户目录 ACL）：窗口拖动/令牌捕获这类高频写入即使进程被杀或掉电，最多退回上一个完整版本，不会留下截断的 JSON。
- 改完重启启动器生效。窗口位置/大小自动记忆。

## 日志

DSH 输出同时写入 `%APPDATA%\dsh-launcher\dsh.log`（UTF-8 BOM，超 2MB 自动轮转保留末尾约 2000 行，时间戳带月日）。

注意：通过「退出（DSH 继续运行）」退出后，输出管道随启动器一起关闭，之后的 DSH 输出不再写入该文件（Node 子进程本身不受影响）。需要完整留存日志时，请保持启动器常驻托盘，或使用「退出并停止 DSH」。

## 图标

- 应用/任务栏图标：官方 favicon 黑鲸鱼（透明底，`assets/icon-*.png`）。
- 托盘图标：白色鲸鱼（Win11 深色任务栏上黑色图标不可见，故托盘用白色，与任务栏应用图标不同）。

## 卸载

- 若启用过「开机自动启动」，先在托盘菜单取消勾选（否则注册表 Run 项残留指向失效路径）。
- 直接删除 `dsh-launcher` 目录即可，DSH 本体不受影响。
- 配置与日志在 `%APPDATA%\dsh-launcher\`，可一并删除。
