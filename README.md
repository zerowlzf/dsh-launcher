# DSH 桌面启动器

为源码版 DeepSeek Harness 打造的 Windows 桌面启动器：Win11 风格炭黑窗口 + 托盘驻留 + 自动探测/启动/停止 DSH。

## 设计原则

- **只做启动器**：不修改 DSH 源码、不注入运行时、不改变 DSH 行为，只负责拉起 `dsh web` 并内嵌显示其 Web GUI。
- **轻量、独立**：不依赖 DSH 内部 API；只通过 HTTP 探测服务状态，通过标准命令启动/停止。
- **可退役**：退役仅由用户显式决定触发，任何外部变化（包括官方桌面端的出现、上游演进）都不构成退役条件；退役时不留侵入式改动。
- **默认不弹浏览器**：DSH 由启动器内嵌展示，因此启动命令自动带 `--no-open`。

## 与官方桌面端的关系

上游 DSH 已出现官方 Electron 桌面端（`apps/desktop`，随 dsh 0.1.3-alpha.2 合入）：无监听端口（`dsh-app://` 协议 + 字节管道传输）、独占 `$DSH_HOME/profiles/desktop`、与 dsh 同版本发布，且 CLI 已禁止引导该 profile（`dsh --profile desktop` 报错）。启动器与官方桌面端互不冲突——启动器走 web 通道（3080 端口 + 源码模式），桌面端走自有通道与独立 profile。

按上方「可退役」设计原则，官方桌面端的出现不触发退役——退役只在用户显式决定时生效。本启动器继续使用与维护：官方桌面端面向打包分发与版本一体化场景，启动器覆盖源码模式跟随、托盘驻留与自动重启的既有工作流，两者互不替代：

- 体验官方桌面端：仓库根执行 `pnpm run dev:desktop`（构建后可直接 `pnpm run start:desktop`）；正式 Windows 安装包走 `pnpm run package:desktop:win:x64`（发布级需 EV 签名基础设施，`:dir` 变体产出免安装目录）
- 若用户显式决定退役：直接删除本目录即可，DSH 本体与官方桌面端不受影响（配置与日志见「卸载」）

## 使用

- **双击 `Start-Launcher.vbs`** 启动（首次自动安装依赖，之后秒开）。
- 或命令行：`npx electron .`（目录内）。
- 回归测试：`npm test`（纯桩环境验证停止/重启竞态，不启动真实 DSH）。

## 功能

| 功能 | 说明 |
|---|---|
| 自动探测 | 启动即检查 `http://127.0.0.1:3080`，已在运行则直接内嵌显示 GUI |
| 自动启动 | 未运行时用源码版命令拉起：`node --import tsx/esm apps/cli/src/bin.ts web --no-open`（cwd = deepseek-harness，避免重复打开系统浏览器） |
| 启动预检 | 拉起前静态检查：源码启动命令（引用 `tsx` 或 `apps/cli/src/bin.ts`）的 node 版本须满足 DSH 根 package.json 的 `engines.node`（实时读取，读不到回退 `^22.19.0 \|\| >=24.0.0`；每次拉起现查，升级 Node 无需重启启动器）；参数为 `tsx` / `tsx/esm` 或路径形式指向 tsx 时要求 `node_modules\tsx` 已安装；命令引用了 `apps/cli/src/bin.ts` 时确认入口存在。不满足则不启动，日志与托盘弹泡给出可行动的提示（如"请在 DSH 目录执行 pnpm install"），替代难懂的底层报错。只检查 startCmd 自身引用到的项，自定义命令（如 `node my-tool.tsx`、`node my-server.js`）不受影响 |
| 现代化窗口 | Win11 圆角、无边框、系统窗口按钮（titleBarOverlay）、淡炭黑主题 |
| 启动状态页 | 动画 + DSH 实时输出日志（滚动保留 200 行），失败可一键重试 |
| 托盘驻留 | 关窗 = 最小化到托盘；托盘菜单：显示窗口 / 浏览器打开 / 打开 DSH 目录 / 打开配置目录 / 重启 DSH / 停止 DSH / 开机自启 / 退出 |
| 退出语义 | 「退出」保留 DSH 后台运行；「退出并停止 DSH」先杀服务 |
| 单实例 | 二次启动聚焦已有窗口；`--hidden` 参数 = 托盘驻留启动（开机自启用） |
| 断线横幅 | DSH 挂掉自动检测并提示，恢复后重连 |
| 重试语义 | 窗口内的「重试 / 启动 DSH」与托盘「重新启动 DSH」共用一条停止→等端口→拉起流程：先校验端口上进程确实是 DSH（`looksLikeDsh`），是则停止并由本启动器重新拉起；端口被无关服务占用时不动作，仅在日志提示；拉起被预检/守卫拒绝时弹泡说明原因（启动中状态翻转为失败态，其余状态保持原值不误翻转）。若启动时端口被正在冷启动的另一个 DSH 实例占用（EADDRINUSE），保持探测等待、就绪后自动转为运行中 |
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
- 改完重启启动器生效。窗口位置/大小自动记忆。

## 日志

DSH 输出同时写入 `%APPDATA%\dsh-launcher\dsh.log`（UTF-8 BOM，超 2MB 自动轮转保留末尾约 2000 行，时间戳带月日）。

注意：通过「退出（DSH 继续运行）」退出后，输出管道随启动器一起关闭，之后的 DSH 输出不再写入该文件（Node 子进程本身不受影响）。需要完整留存日志时，请保持启动器常驻托盘，或使用「退出并停止 DSH」。

## 图标

- 应用/任务栏图标：官方 favicon 黑鲸鱼（透明底，`assets/icon-*.png`）。
- 托盘图标：黑色鲸鱼（与任务栏图标一致）。

## 卸载

- 若启用过「开机自动启动」，先在托盘菜单取消勾选（否则注册表 Run 项残留指向失效路径）。
- 直接删除 `dsh-launcher` 目录即可，DSH 本体不受影响。
- 配置与日志在 `%APPDATA%\dsh-launcher\`，可一并删除。
