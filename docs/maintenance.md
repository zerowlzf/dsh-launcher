# 维护笔记 —— 上游跟踪、契约与实现细节

本文件收纳自 README 移出的完整记录：与官方桌面端的关系、各基线的吸收记录、依赖的上游契约核对表，以及使用、功能、配置、图标的细节。README 保留精简入口；两者冲突时以本文件为准。

## 与官方桌面端的关系

上游 DSH 已出现官方 Electron 桌面端（`apps/desktop` 2026-08-28 起在 master 出现、`apps/desktop-host` 2026-09-04 出现，随 dsh 0.1.5-alpha.1 首次进入发布；截至 dsh 0.2.1-rc.2 两个包仍在 master 且仍为 `private: true`，版本随发布号，实测 `@deepseek-ai/dsh-desktop` 与 `@deepseek-ai/dsh-desktop-host` 的 `version` 均为 `0.2.1-rc.2`；桌面端自 0.2.0-rc.1 起接入产品分析——新增 `device-info.ts`、`main.ts` 的 `track()` 接线与 `@deepseek-ai/dsh-client-product-analytics` 依赖，配套 composition 行以 `ctx.get('profileContext')?.name !== 'desktop'` 为 disabled 条件，**web profile 下不加载**，因此启动器走的这条 web 通道不产生任何遥测）：自有传输（`dsh-app://` 协议加载打包 Web 入口 + Node IPC 承载 boot 注入 / 就绪 / 关闭；应用 HTTP 经认证宿主中转，宿主绑定 `127.0.0.1`、0.2.1-rc.1 起改听 OS 分配端口（此前固定 19387，`webserver.config.port` 可覆盖），不与 web 的 3080 争用）、独占 `$DSH_HOME/profiles/desktop`、与 dsh 同版本发布，且 CLI 已禁止引导该 profile（`dsh --profile desktop` 报错）。启动器与官方桌面端互不冲突——启动器走 web 通道（3080 端口 + 源码模式），桌面端走自有通道与独立 profile。

按上方「可退役」设计原则，官方桌面端的出现不触发退役——退役只在用户显式决定时生效。本启动器继续使用与维护：官方桌面端面向打包分发与版本一体化场景，启动器覆盖源码模式跟随、托盘驻留与自动重启的既有工作流，两者互不替代。

**边界**：启动器不启动、不托管、不集成官方桌面端（`apps/desktop` / `apps/desktop-host`），不读写 `$DSH_HOME/profiles/desktop`，不传 `--profile desktop`。官方桌面端会发展出自己的完整生态（自有启动器、更新与分发体系），那是它的路；本启动器走自己的路——把源码模式跟随做到极致，不向它的生态伸手，也不等它来收编。两条路唯一的交集是同一个上游仓库，除此之外互为平行线。

**吸收记录（0.1.7-rc.1 轮，2026-09-24）**：对照桌面版 `apps/desktop/src` 当前实现逐文件评估后，吸收主窗口崩溃自愈三件套与 webview 访客 `render-process-gone` 恢复（见功能表「界面自愈」「访客崩溃自愈」）。评估后**不吸收**的项及理由：

- **crash-report 文件 + fatal 恢复对话框体系**（`crash-report.ts` / `fatal-recovery.ts`）：桌面端面向打包分发、需给非技术用户留完整诊断文件；本启动器 dsh.log 已持久化全部带时间戳输出，启动失败有原因翻译 + 窗口内日志 + 复制日志按钮，覆盖同类需求
- **IPC 优雅停机阶梯**（`host-process.ts` 的 shutdown → 10s → SIGTERM → 5s → SIGKILL）：桌面端走 Node 模式 IPC 通道有 `shutdown` 消息可发；CLI 拉起的 web 子进程没有 IPC 通道，Windows 上 detached 控制台进程也收不到优雅信号，`taskkill /T /F` 是惯用法，且 DSH 会话日志为追加写、强杀风险低
- **update / mandatory-update 自更新体系**：本启动器的分发即本 git 仓库，随源码模式显式更新，符合「可退役」哲学；自更新反而引入回滚与签名问题
- **并发 attempt 共享、stderr 有界缓冲、exitsWithin+unref、EADDRINUSE 特判、env 剥离名单、单实例锁**：在此前各轮已对齐（见 `main.js` 注释与 CHILD_ENV），本轮复核无漂移

**吸收记录（0.1.7-rc.2 轮，2026-09-26）**：对照桌面端 rc.1→rc.2 增量（`46a7f68b09..477b4f4205`，`apps/desktop` + `apps/desktop-host` 共 103 文件 +5191/−377）按 14 个主题逐项评估、0 遗漏。唯一吸收项为**托盘图标逐尺寸渲染**（本轮已落地：`make-tray-ico.js` + `assets/tray.ico` + `main.js` 托盘加载接线，见功能表「托盘图标」与「图标」段），其余 13 主题不吸收。结论与理由（判据 = 上方设计原则；短哈希为主仓区间内提交）：

| # | 主题 | 判定 | 理由 |
|---|---|---|---|
| 1 | 关闭即隐藏 + 首次关闭确认框（47459346834、5637311d5ab） | 不吸收（已对齐） | desktop 因 close 语义**从退出改为隐藏**才需要模态教导框 + 共享 shell 对话框；启动器 close→hide + 一次性托盘气泡已是更轻的「看得见的回路」，且每会话提醒优于持久化标记 |
| 2 | 可中断退出 / 退出前任务确认（47459346834、e6f135f15cf、fbb3fb770f9） | 不吸收 | 依赖 desktop-host IPC 的活动任务查询（quit-inspection.ts）；启动器退出不中断 DSH（「退出（DSH 继续运行）」菜单语义自说明），无任务面；quitting 标志 + 停止确认 3s 既有语义已覆盖竞态 |
| 3 | 托盘图标逐尺寸渲染（47459346834 render-tray-icon.ts、eec2b5fa6ed） | **吸收** | 托盘 16 逻辑像素 @100%–400% 显示缩放，逐尺寸原生栅格化 + Windows 按 DPI 自选位图 = 各缩放边缘清晰，优于缩小一张大位图；已落地（见功能表「托盘图标」）。官方的鲸鱼放大 1.2 倍**不适用**：那是「瓷砖底板 + 图形内缩」布局的修正，启动器是全幅白鲸 |
| 4 | 更新重启抬升窗口（d2a5490fa0b） | 不吸收 | desktop 自更新体系专属；启动器无自更新（分发即本 git 仓库，rc.1 轮已拒绝自更新体系） |
| 5 | 启动器代理约束（8b609392204） | 不吸收 | 实测为 macOS `start-desktop.command` / `启动Desktop.command` 启动脚本把代理设置收窄到 runtime preparation；与启动器代码面无关 |
| 6 | flock 惰性加载 / native 按需构建（0126d5be205） | 不吸收 | flock-entry.ts + macos-notarization-proxy 是 desktop 启动性能与 macOS 构建优化；启动器薄壳无对应面 |
| 7 | Platform 存储清理 / 身份发布（fff88f7375c） | 不吸收 | 账户生态（platform-view 存储清理 + 匿名身份发布），哲学边界 |
| 8 | 账户 / 公告 / onboarding / 登出 / 欢迎页族（3970cc974f1、081526aa3e9、8f180cf45f6、b8df537f072、9987cae3eab 等 15 提交） | 不吸收 | desktop 产品生态；启动器不向它的生态伸手 |
| 9 | 快捷键重构族（4fdcaf16b51、91423ea1b44、6a82709a2b6、bca9cecc7d9） | 不吸收 | keyboard.ts / keybindings.ts 是 desktop 主进程的原生菜单拦截与快捷键录制；Web 端键盘快捷键随 rc.2 的 web 构建自动继承（内嵌 webview 直接受益）；启动器无快捷键面 |
| 10 | 蓝色焦点环 / API key 自动填充 / UI 材料统一（4f1a1289f55、11c0511271d、fdd14a09898、6000dcdda55、df2372fefed） | 不吸收 | client/web 端视觉与功能，随 rc.2 web 构建自动继承 |
| 11 | boot 跳过包一次性报告（c8b10a16be9） | 不吸收 | packages/boot/app-boot 的 stdout 去重改进，经启动器日志透传自动受益，契约面无变化 |
| 12 | 安装器 / 构建 / 测试加固（037bed1f41c、4e41ccadcc6、63c7e370ce7、e44a4d4dd3a、ac586cefca8、20dae9b6fa6、a67119845d4、06717aebbb7、59d2e01575f） | 不吸收 | desktop 打包与测试基建（安装器前置校验、import 记录检查与 wine gate、bundle 顺序、fixture 隔离、分支本地启动器回收） |
| 13 | 托盘菜单重构 / 共享对话框技术（47459346834 tray.ts、5637311d5ab） | 不吸收 | 启动器托盘菜单为自有设计（重启/停止/开机自启等 DSH 生命周期项）；「无父窗口原生对话框」技术仅在有退出确认对话框时才有用武之地——记录备忘，将来若加退出对话框可回看 5637311d5ab |
| 14 | LibreOffice Kit 0.1.1 / 翻译记录 re-key / 发布与合并提交（03bd8258c3f、e7def469e13、787b746b807、各 merge） | 不吸收 | harness 侧依赖与仓库机制已随主仓同步处理；merge 无独立内容 |

**吸收记录（0.2.0-rc.1 轮，2026-09-29）**：对照桌面端 0.1.7-rc.2→0.2.0-rc.1 增量（`477b4f4205..4878cdabd8`，`apps/desktop` + `apps/desktop-host` 共 50 文件 +784/−179；其中 `apps/desktop-host/src` 零改动）按 8 个主题逐项评估、0 遗漏。**本轮吸收项为 0**：增量整体是「打包分发 + 账户生态 + 自更新闸门」三条 desktop 专属线，无一落在启动器的作用面。结论与理由（判据 = 上方设计原则）：

| # | 主题 | 判定 | 理由 |
|---|---|---|---|
| 1 | 欢迎窗口 / 首次运行 onboarding（`welcome-window.ts`、`welcome-backend.ts`、`welcome-api.ts`、`preload-welcome.ts`、`client/WelcomePage.tsx`、`ipc.ts` 及 `welcome-*.spec.*`） | 不吸收 | desktop 面向打包分发的首次运行与账户体验；启动器探测 3080 即直接进正文，无 onboarding 面 |
| 2 | 强制更新闸门 / 更新策略与登录校验（`mandatory-update-window.ts`、`renderer/mandatory-update.css`、`update-coordinator.ts`、`expected/mandatory-update-zh.json`、`expected/policy-login-en.json`） | 不吸收 | 自更新体系在 rc.1 轮已拒绝（分发即本 git 仓库）；本轮只多出「该版本不再受支持」的强制更新闸门与签发校验 |
| 3 | 产品分析 / 设备信息（新增 `device-info.ts`、`main.ts` 的 `track()`、`apps/desktop` 新增 analytics 依赖，以及 composition 的 `desktop-product-telemetry` / `product-analytics` 两行） | 不吸收 | 两行以 `profileContext.name !== 'desktop'` 为 disabled 条件，web profile（`name='web'`）下不加载，启动器这条通道零遥测；把账户与遥测引入轻量壳违背设计原则 |
| 4 | 全屏语义扩展到 win32（`main.ts`：`platform === 'darwin'` → `'darwin' \|\| 'win32'`，全屏时推 `windowFullscreen` 让覆盖层收起原生按钮留白） | 不吸收（无对应缺陷） | 启动器的原生按钮留白是 `#titlebar-spacer { flex: 1; min-width: 150px }`，属弹性留白：全屏必然使窗口变宽、`min-width` 永不生效，而窗口化（窄）时按钮本就可见。加一条 IPC 不产生任何可观察变化 |
| 5 | 本地化文案重组（`locale.ts` 130 行、`README.i18n.yaml`、`expected/update-restart-{darwin,win32}-*.json`） | 不吸收 | 启动器界面中文硬编码（rc.1 轮已评估）；本轮 `locale.ts` 变动全部是更新流程文案 |
| 6 | 打包 / 签名 / 编译面配置（`electron-builder.config.d.mts`、`scripts/electron-builder-config.mjs`、`scripts/macos-entitlements.plist`、`tsconfig.client.json`、`tsconfig.host.json`、`koffi` 精确锁 `3.1.1`） | 不吸收 | 发布级基础设施；启动器分发即本 git 仓库 |
| 7 | `apps/desktop-host` 增量（仅 `package.json` 版本号与 `tests/platform-session.spec.ts`） | 不吸收 | 宿主进程 `src` 零改动，传输与线程面无变化 |
| 8 | 文档与测试基建（`apps/desktop/README*.md`、`tests/acl-skill.built.e2e.ts`、`tests/fixtures/workspace-updates.mjs`、`macos-signature.spec.ts`、`preload.e2e.ts`、`main-startup.spec.ts`） | 不吸收 | 文档与 desktop 专属测试面 |

回归观察（本区间是否影响启动器已实现行为，逐文件核验）：桌面端这轮改动集中在 `apps/desktop/src` 自有的欢迎/更新/分析三条线，启动器不共享这些代码；`apps/desktop-host/src/host-process.ts` 不在改动清单内，此前吸收评估过的 env 剥离名单、停止阶梯与就绪信号**无漂移**；`packages/subprocess/subprocess-local/src/spawn.ts`、`windows-job.ts` 与 `packages/host/frontend-static/src/index.ts` 在本区间**未动**，`packages/bundle/web-app/src` 整个目录**零改动**，`windowsHide` 主题在 subprocess / web-app / sdk 三个包内**零提交**——启动器此前对齐的窗口隐藏与前端静态服务行为均保持原状。

**吸收记录（0.2.1-rc.1 轮，2026-10-17）**：对照桌面端 0.2.0-rc.1→0.2.1-rc.1 增量（`4878cdabd8..1600d8a1e1`，`apps/desktop` + `apps/desktop-host` 共 190 个提交、227 文件 +10274/−845，其中 `src` 21 文件）按 12 个主题逐项评估、0 遗漏。**本轮吸收项为 0**：增量是「打包分发基建收口 + 桌面安装器命令链路 + 自更新细化 + 账户/会话线」几路 desktop 专属线；唯一触及网络面的 `desktop-host` 端口改动也只发生在桌面自有通道内。结论与理由（判据 = 上方设计原则；短哈希为主仓区间内提交）：

| # | 主题 | 判定 | 理由 |
|---|---|---|---|
| 1 | 捆绑 CLI 与命令管理（新增 `command-installation.ts` / `command-management.ts` / `command-manager-entry.ts` 与原生菜单入口；`5f99386fa8a`、`9c8f5c2bf31`、`d796ae1efd7` 等） | 不吸收 | 桌面安装器把自带 CLI 注册为 `dsh` 命令（可逆 command-link 所有权 + 指纹 / 备份 / 回滚）；启动器零安装、不动 PATH，两条路互不相干 |
| 2 | Windows 控制台信号投递（新增 `windows-cli-signals.ts`；`e21ed97f29f`） | 不吸收 | 为桌面捆绑 CLI 的进程注册 `SetConsoleCtrlHandler`（koffi 回调转发 SIGINT / SIGBREAK）；启动器子进程无控制台、停止走既有 `taskkill /T /F` 阶梯（rc.1 轮已论证），无适用面 |
| 3 | macOS 登录 shell 环境（新增 `login-shell-environment.ts`；`4f26143bf2b`） | 不吸收 | 打包 GUI 应用补读登录 shell 环境变量；macOS 平台专属，启动器不读登录 shell |
| 4 | 桌面壳设置（新增 `settings.ts`；`e8226b2a84e`） | 不吸收 | 桌面自有设置文档（测试认证弹窗本地 opt-in 等），与启动器 `settings.json` 无交集 |
| 5 | 自更新体系细化（新增 `update-channel.ts` / `duration-env.ts`，改动 `update-coordinator.ts` / `update-dialog.ts` / `update-schedule.ts` / `mandatory-update-policy.ts`；`fdbe2bce475`、`4fe2381cb5a`） | 不吸收 | 自更新体系 rc.1 轮已拒绝；本轮是 nightly / latest 通道、时长环境变量与弹窗时序的实现细化 |
| 6 | 账户与平台会话（`account-backend.ts`、`platform-session.ts`；`9e1df327ae1`、`dff4dfbe75a`） | 不吸收 | 桌面账户生态（赠金与身份通知、登录错误码） |
| 7 | Office 交付面（`office-engine.ts` / `office.ts`；`f12fa3bad18`、`a59beb8ae30`） | 不吸收 | 桌面内置办公引擎的解析、渲染检查与 HMR 维护 |
| 8 | desktop-host 传输与端口（`index.ts` 改听 OS 分配端口、显式 `--host 127.0.0.1`，ready URL 改用 `webServer.protocol`；`ecd9bf92735`） | 不吸收 | 桌面自有通道（Electron 转发 + Node IPC）；与 web 的 3080 无交集（备忘：固定端口→OS 分配的变化，与启动器按 URL 行自报跟随端口的既有取向一致） |
| 9 | 打包 / 签名 / 发布基建（`scripts` 75 文件、publishing 6、installer 5、windows-signing 3 等） | 不吸收 | 发布级基础设施（签名默认开启、COS 桶、Task Scheduler 监督 runner、安装器目录锁重试）；启动器分发即本 git 仓库 |
| 10 | 构建与依赖（Electron `^44.0.0`→`^44.7.0`、electron-builder `^26.15.3`→`^26.17.0`、`packageManager pnpm@11.28.5`、`build:artifacts` / `build:check`、tsdown `--config-loader native`） | 不吸收 | 构建系统面；启动器自持 Electron 与脚本 |
| 11 | 测试面加固（`tests` 93 文件、host 测试、fixtures 与期望更新） | 不吸收 | 不产生产品行为 |
| 12 | 文档与 i18n（`README*.md` 重构、`locale.ts` 文案、`docs`） | 不吸收 | 文档面 |

回归观察（本区间是否影响启动器已实现行为，逐文件核验）：`apps/desktop-host/src/host-process.ts` 不在改动清单内，此前对齐的 env 剥离名单、停止阶梯与就绪信号**无漂移**；`packages/subprocess/subprocess-local` 重构 Linux scope 选择器（新增 `linux-scope-selector.ts`）并把 Windows 终端切到 node-pty 自带 console host（`useConptyDll: true`，`59ba1321eba`）——`spawn.ts` / `windows-job.ts` 未动，`windowsHide` 对齐面不受影响（本地补丁仍在 web-app `index.ts` 原位），终端宿主进程随 DSH 进程树被启动器停止阶梯一并结束；`packages/host/frontend-static` 仅文档 / 版本 / 测试面变化（`src` 零改动）；`packages/bundle/web-app/src` 本轮有实质改动（见下方契约段），启动器数据面（令牌行、401 探测、就绪门控、dist 锚点）逐项复测无异动。

**吸收记录（0.2.1-rc.2 轮，2026-10-17）**：桌面端 0.2.1-rc.1→0.2.1-rc.2 增量仅为 `apps/desktop` 与 `apps/desktop-host` 两包 `package.json` 的版本串（各 ±1 行：实测均为 `0.2.1-rc.2`、仍 `private: true`），`src` 零改动，无主题可评、吸收项 0；契约面复核结论见下节。

**补记（2026-10-18，对端复核轮）**：rc.2 复核（基线 `c99d155bdb`）之后，对端在 fork 上又推送 6 个提交——1 个 `tool-cordis` 输入再解析修复（声明 `string` 输入的方法不再被 JSON 再解析，带钉住测试）、1 个 `session-format` v1→v2 保留链测试、4 个文档重构与勘误提交；契约承载文件（`apps/cli/src/args.ts`、`apps/cli/src/bin.ts`、`packages/bundle/web-app/src/startup.ts`、`packages/bundle/web-app/src/index.ts`、`packages/client/connection/src/browser-auth.ts`）逐字节零改动，`cordis.patch.yml` 默认值行号仍为 183/184/202，下节九条契约结论全部继续成立（当前 fork tip `3ccde0b48e`，rc.2 之上 52 个本地提交）。

- 体验官方桌面端（与启动器无关，仅备忘）：仓库根执行 `pnpm run dev:desktop`（构建后可直接 `pnpm run start:desktop`）；正式 Windows 安装包走 `pnpm run package:desktop:win:x64`（发布级需 EV 签名基础设施，`:dir` 变体产出免安装目录）
- 若用户显式决定退役：直接删除本目录即可，DSH 本体与官方桌面端不受影响（配置与日志见「卸载」）

## 依赖的上游契约

启动器只依赖下列上游契约，不读 DSH 内部 API。DSH 更新后按本表逐项核对（`核对基线：dsh 0.2.1-rc.2，上游 HEAD 687f282e86 + 本地工作树 HEAD c99d155bdb`；本轮上游核对覆盖 `1600d8a1e1..687f282e86` 的 9 个提交（本地另有 46 个提交叠在其上），九条契约全部仍然成立，**契约承载文件本区间零改动**——上游 9 个提交全部为发布登记与 Web 侧纯增量：约 230 个 package.json 各 ±1 行版本号；新增 `packages/web/web-deepseek-api`（搜索/抓取 provider；`packages/web/web` 的 provider 选择改为活引用配置，属 Web 侧内部机制、不触契约）与 `packages/client/ui-deepseek-model-label-1017`（标注徽标，`cordis.patch.yml` 仅 +3 行、`bundle/base` 补丁 +8/−1）；承载契约核心事实的文件（`apps/cli/src/args.ts` 与入口 `bin.ts`、`packages/bundle/web-app/src/startup.ts`、`packages/bundle/web-app/src/index.ts`、`packages/client/connection/src/browser-auth.ts`）在该区间内逐字节零改动；上一轮（0.2.0-rc.1 → 0.2.1-rc.1，2103 个提交）**契约面首见承载文件实质改动——全部为等价改写或纯增量、无破坏**——承载契约核心事实的文件当时均有改动，逐项核验后全部为「等价改写或纯增量」：`packages/bundle/web-app/src/index.ts`（改动 158 行）不再在 URL 行追加 `(LAN: ...)` 后缀（启动器只按 `dsh web:` 前缀捕获首个 URL，从未解析该后缀），对外 URL 由新增 `public-url.ts`（39 行）校验收口、经 `webApp` 服务发布；打印路径（`announceReady` + `ANNOUNCED_ROOTS` 门控）与 `resolveDistIndex` 未动，本地补丁 `windowsHide: true` 一行仍在原位；`packages/bundle/web-app/src/startup.ts`（改动 54 行）参数族新增 `--public-url` 与 `--tls-cert` / `--tls-key`，`--host` 收窄为「本机具体接口地址、拒绝通配」（启动器只用默认值与 `--no-open`）；`packages/client/connection/src/browser-auth.ts`（改动 137 行）新增 API operator 的 v2 cookie 与 `/connect`——浏览器面语义不变：无令牌 `/` 仍 401、令牌 URL 仍铸 cookie 后 303 回干净路径（该轮活体复核）；`apps/cli/src/args.ts` 与入口 `bin.ts`（合计 37 行）新增 `manageDesktopProfile`（打包桌面载体专用；源码启动仍拒 `desktop` profile，行为探针复测）；其余承载文件的变化均不触契约事实：`cordis.patch.yml` 新增 schedule / ui-schedule / harness-dev-context / ui-secret-mask 四行、移出 tool-ralph 行，信任围栏由绑定后快照的 `webRuntime` 改为 Connection 行直读 `webStartup`（web-runtime 行承接 `tls` / `publicUrl`；`host ?? '127.0.0.1'` / `port ?? 3080` 与 `printUrl` 未动，行号下移至 183/184/202）、根 `package.json` 为版本号、`packageManager pnpm@11.7.0 → 11.28.5` 与构建脚本重构（`build:artifacts` / `build:check` 取代旧构建脚本、tsdown 增 `--config-loader native`；`engines.node` 与 `start:web` 未动——更早一轮正面确认的 `start:web` 逐字一致继续成立）、`apps/cli` 与 `web-app` 的 `package.json` 仅增删插件依赖。更早一轮（0.1.5-rc.2 → 0.1.7-alpha.2，3009 个提交）需要改写的只有别名来源一条：`dsh <name>` 已成为**通用**缩写规则，`dsh web` 走的就是它；web 参数族由 web bundle 的 `startup.ts` 声明——两者都已并入下表。更早一轮记入的三项正面影响（Web 端内置浏览器默认关闭、源码启动的运行时模块解析修复、插件兼容性准入只约束插件包）继续成立。**2026-10-17 工作树复核（基线 `c99d155bdb`，dsh 0.2.1-rc.2）**：本地分支已 rebase 到上游 `687f282e86`（`release(dsh): 0.2.1-rc.2`，merge #6408）之上，叠 46 个本地提交。九条契约在当前工作树（含全部本地提交）上以**静态核验 + 行为探针 + 真实启动冒烟**三证成立：`dsh --profile desktop` 拒绝（`error: profile "desktop" is managed exclusively by the Electron application`，退出码 1）、`dsh web --help` 参数族完整（`--host` / `--no-open` / `--port` / `--trusted-host` 加新增 `--public-url` / `--tls-cert` / `--tls-key`，退出码 0）、根 `package.json` `engines.node` 读取为 `^22.19.0 || >=24.0.0`、`node --import tsx/esm apps/cli/src/bin.ts` 源码启动可解析（`node_modules/tsx` 与入口均在树）、前端 dist 锚点 `@deepseek-ai/dsh-web-frontend` 仍为 web-app 依赖且 `apps/web/dist/index.html` 在树、出自本轮全量清理重建（`pnpm run clean` 361 条路径 + 手工删 dist 后 9/9 门禁、191.13 s、327 个客户端产物）、`cordis.patch.yml` 默认 `host ?? '127.0.0.1'` / `port ?? 3080` 与 `printUrl: true` 均在（实测仍在 183/184/202 行——rc.2 的 +3 行徽标插在更后位，未移位）；探测语义由活体复核——`dsh web` 冷启动打印 `dsh web: http://127.0.0.1:3080/?token=...`（无 LAN 后缀、token 长 43），无令牌 `/` 401、令牌 URL 303（`Set-Cookie` 后 `location: ./`）、携带 cookie 的干净路径 200，401 响应体为上游原文（`dsh web authentication required; reopen the URL printed by dsh web.`）；启动器级 `npm test` 全绿（test-race 20 项 + webview 快加载 5 / 慢加载 1 / 访客崩溃自愈 1）；启动器级真实冒烟闭环（冷启动捕获令牌（settings.json）、3080 就绪、内嵌访客加载 `http://127.0.0.1:3080/` 并渲染、CDP 目标复核）沿用 rc.1 轮记录——本轮启动器代码与承载源文件均零改动。

| 契约 | 上游位置 | 启动器如何依赖 |
|---|---|---|
| `dsh <name>` 缩写 `dsh --profile <name>`（通用规则，`dsh web` 即 `--profile web`）；web 参数族含 `--no-open`、`--host`、`--port`、`--trusted-host`（0.2.1-rc.1 起另有 `--public-url` / `--tls-cert` / `--tls-key`，`--host` 拒绝通配——纯增量，启动器只用默认值与 `--no-open`） | `apps/cli/src/args.ts`（通用缩写的规则与文档）、`packages/bundle/web-app/src/startup.ts`（参数族声明） | `startCmd` 启动参数；`--no-open` 缺失时自动补，上游不认时自动回退 |
| 启动令牌 URL 行 `dsh web: <url>?token=...`（`printUrl` 默认 true；0.2.1-rc.1 起不再追加 `(LAN: ...)` 后缀——启动器按 `dsh web:` 前缀捕获首个 URL，从未解析该后缀） | `packages/bundle/web-app/src/index.ts` | 从 stdout 捕获令牌，拼认证 URL 加载内嵌页面 |
| URL 行同时是**就绪信号**：只在 Loader 全部激活、Connection 可用后打印 | `packages/bundle/web-app/src/index.ts`（`announceReady` 注释与实现）、`packages/bundle/web-app/README.md` | 捕获令牌即翻转为运行中，不必等探测周期 |
| 探测语义：2xx/3xx = 服务在；401 = 需令牌；其余 = 未就绪 | `packages/client/connection/src/browser-auth.ts` | 探测状态机（ready / 需认证 / degraded） |
| 前端静态资源位置：前端包的 `dist/index.html`。解析锚点不硬编码目录：上游用 `require.resolve('@deepseek-ai/dsh-web-frontend/package.json')` 从 web-app 自身解析（等价于先查 web-app bundle 内的 `node_modules` 链接，再回退根 `node_modules`）；**dist 文件缺失**时服务照样绑定、令牌行照打、`/` 返回 404（上游只对缺失的 client bundle 给构建提示），而前端**包本身不可解析**时 web-app 在装配期直接抛错 | `packages/bundle/web-app/src/index.ts`（`resolveDistIndex`）、`packages/host/frontend-static/src/index.ts` | 预检据此在 dist 缺失时告警（不拦截），避免内嵌窗口静默 404；两种失败模式分别记日志 |
| 默认 host `127.0.0.1`、默认 port `3080` | `packages/bundle/web-app/cordis.patch.yml` | 探测与内嵌 URL 默认值；端口以 URL 行自报值为准（端口漂移跟随） |
| 源码启动须走 tsx 的 ESM 钩子（`node --import tsx/esm apps/cli/src/bin.ts`），仓库依赖中需有 `tsx`、入口文件需存在 | 根 `package.json`、`apps/cli/src/bin.ts`、`.agents/notes/implemented/architecture/2026-07-29-dsh-source-launch-tsx-esm.md` | 启动预检（缺 `node_modules/tsx` 提示 `pnpm install`、缺入口提示 `dshDir` 配错） |
| 根 `package.json` 的 `engines.node` 是源码运行的 node 版本要求 | 根 `package.json` | 启动预检实时读取（读不到回退 `^22.19.0 \|\| >=24.0.0`；读到但解析不了则跳过检查，不拿旧约束误拦），每次拉起现查 |
| `dsh --profile desktop` 由 CLI 拒绝（官方桌面端独占该 profile；0.2.1-rc.1 起打包载体经 `manageDesktopProfile` 例外，源码路径不变） | `apps/cli/src/args.ts`（`rejectElectronProfile`） | 保证两条通道互不干扰，启动器不会误接管桌面端 |

## 使用

- **双击 `Start-Launcher.vbs`** 启动（首次自动安装依赖，之后秒开）。
- 或命令行：`npx electron .`（目录内）。
- 回归测试：`npm test` = 纯桩竞态用例（`test-race.js`）+ webview 加载竞态用例（`test-webview.js`，会拉起隐藏窗口的 Electron，约 10 秒；不启动真实 DSH；`test-webview.js` 与 `Start-Launcher.vbs` 都会剥离 `ELECTRON_RUN_AS_NODE`，从 Electron 宿主的集成终端里也能直接跑）。

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
| 托盘图标 | 逐尺寸渲染的多尺寸 ICO（`assets/tray.ico`，16/20/24/32/40/48/64 px 七档 PNG 条目，吸收官方 desktop 0.1.7-rc.2 的做法）：Windows 按显示缩放自挑最合适的位图，100%–400% 缩放下边缘都清晰；ico 缺失或不可用时回退单尺寸 `tray-32.png` |
| 退出语义 | 「退出」保留 DSH 后台运行；「退出并停止 DSH」先杀服务 |
| 单实例 | 二次启动聚焦已有窗口；`--hidden` 参数 = 托盘驻留启动（开机自启用） |
| 断线横幅 | DSH 挂掉自动检测并提示，恢复后重连 |
| 内嵌加载兜底 | 状态早于 `<webview>` 自定义元素升级就绪时（DSH 已在运行 → 首个探测立刻成功），旧的 `view.src = …` 赋值会被元素升级丢弃、访客停在 `about:blank`，表现为标题栏"运行中"而内容区全黑。改为 `setAttribute('src')` 下发，并以"访客是否真的开始加载"为准补发（仅未开始加载时重试，不打断正在启动的页面）；`test-webview.js` 把这条锁死（2026-09-09 事故） |
| 托盘唤醒 | 点托盘图标时在 `show()`/`focus()` 之后 `moveTop()`，规避 Windows 前台锁导致的"点两次才打开" |
| 界面自愈 | 吸收官方桌面端（`apps/desktop/src/main.ts`）主窗口三件套：`render-process-gone`（非 clean-exit）/ `preload-error` / `did-fail-load`（主框架、非 -3）统一收尾——记日志 + 延迟 500ms reload 自愈；**限速 3 次/分钟**，超限停手留日志（防反复崩溃形成 reload 风暴）。官方对该三件套出 fatal 恢复对话框，本启动器页面是本地静态资源，崩溃多为一时性，自愈优于打断用户 |
| 访客崩溃自愈 | 内嵌 webview 的**渲染进程**崩溃（`render-process-gone`，对应官方 platform-view/browser-guests 的处理）：横幅提示 + reload 恢复 + 强制重发 src 兜底。访客崩溃对服务端探测不可见（仍 2xx），不接住就是"标题栏运行中、内容区黑屏"的静默故障；`test-webview.js` 阶段三用 CDP `Page.crash` 故障注入锁死该路径 |
| 重试语义 | 窗口内的「重试 / 启动 DSH」与托盘「重新启动 DSH」共用一条停止→等端口→拉起流程：先校验端口上进程确实是 DSH（`looksLikeDsh`），是则停止并由本启动器重新拉起；端口被无关服务占用时不动作，仅在日志提示。拉起被拒绝时分两类收尾：预检类（node 版本 / 依赖缺失 / 入口缺失）置失败态并弹泡给出可行动的原因；守卫类（停止进行中、已有子进程）只记日志并保持可自愈状态等下一轮探测重试，用户点击触发的路径额外弹泡告知本次未生效。若启动时端口被正在冷启动的另一个 DSH 实例占用（EADDRINUSE），保持探测等待、就绪后自动转为运行中 |
| 端口漂移告警 | 检测到 DSH 输出中自报的监听端口与配置 `port` 不一致时，弹泡提醒修改 settings.json |
| **启动令牌认证** | 新版 DSH web 需要 `?token=` 启动令牌才能访问。启动器会在 DSH 输出行 `dsh web: http://127.0.0.1:PORT/?token=...` 中自动捕获令牌，并使用带令牌的认证 URL 加载 webview 页面。令牌会持久化到 settings.json，重启启动器后若 DSH 进程仍在运行，可复用令牌直接认证。 |

## 配置细节

- `dshDir` 默认会优先使用启动器同级的 `deepseek-harness` 目录；如果不存在，再回退到旧版位置（主目录下 `Desktop\dsh\deepseek-harness`，按当前用户主目录推导）。
- 如果旧配置里的 `startCmd` 是 `web` 且缺少 `--no-open`，启动器会自动补上并写回配置。
- `noOpen` 控制是否自动追加 `--no-open`；如果某天 DSH 不再支持该参数，启动器会自动去掉它并写回 `"noOpen": false`。
- 启动 DSH 子进程时会剥离 `NODE_OPTIONS`、`NODE_PATH`、`DSH_DESKTOP_*` 与 `npm_*`/`pnpm_*`/`corepack_*` 环境变量（剥离名单对齐官方桌面端 `apps/desktop/src/host-process.ts`），避免终端里的调试配置（如 `--inspect`）或遗留的 CJS 全局解析路径污染 DSH 依赖树、也不让桌面端私有变量漏进 web 子进程；其余变量（含 `PATH`、`DSH_HOME`、代理变量）正常继承，需要给 DSH 传 Node 选项时请直接写进 `startCmd`（如 `"node", "--max-old-space-size=4096", ...`）。
- `settings.json` 采用「临时文件 + fsync + rename」原子写（含令牌；`mode 0600` 在 Windows 上基本无效，实际靠用户目录 ACL）：窗口拖动/令牌捕获这类高频写入即使进程被杀或掉电，最多退回上一个完整版本，不会留下截断的 JSON。
- 改完重启启动器生效。窗口位置/大小自动记忆。

## 图标

- 应用/任务栏图标：官方 favicon 黑鲸鱼（透明底，`assets/icon-*.png`；`icon.ico` 由 `make-icon-ico.js` 生成）。
- 托盘图标：白色鲸鱼（Win11 深色任务栏上黑色图标不可见，故托盘用白色，与任务栏应用图标不同）。托盘用逐尺寸渲染的多尺寸 ICO `assets/tray.ico`（16/20/24/32/40/48/64 px 七档 PNG 条目，吸收官方 desktop 的做法）：每个尺寸独立从矢量原生栅格化而非缩小一张大位图，Windows 按显示缩放自挑最合适的位图，100%–400% 缩放下边缘都清晰。改 `assets/whale-white.svg` 后在仓库根执行 `node make-tray-ico.js` 再生成（sharp 借 DSH 仓库的 pnpm 安装，零新依赖）；ico 缺失或不可用时启动器自动回退单尺寸 `tray-32.png`。
