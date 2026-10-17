# DSH 桌面启动器

为源码版 DeepSeek Harness 打造的 Windows 桌面启动器：Win11 风格炭黑窗口 + 托盘驻留 + 自动探测/启动/停止 DSH。

## 设计原则

- **只做启动器**：不修改 DSH 源码、不注入运行时、不改变 DSH 行为，只负责拉起 `dsh web` 并内嵌显示其 Web GUI。
- **轻量、独立**：不依赖 DSH 内部 API；只通过 HTTP 探测服务状态，通过标准命令启动/停止。
- **可退役**：退役仅由用户显式决定触发，任何外部变化（包括官方桌面端的出现、上游演进）都不构成退役条件；退役时不留侵入式改动。
- **长期维护**：本启动器照常独立维护、持续演进；过程中会汲取官方桌面端中有益的理念与做法，但定位与轻量哲学不变。
- **默认不弹浏览器**：DSH 由启动器内嵌展示，因此启动命令自动带 `--no-open`。

## 特性

- **自动探测/启动**：启动即检查 `http://127.0.0.1:3080`；已在运行则直接内嵌显示 GUI，未运行则按源码命令拉起（自动补 `--no-open`，不弹系统浏览器）。
- **启动令牌认证**：从 `dsh web:` 输出行捕获 `?token=` 启动令牌并持久化，重启启动器后若 DSH 仍在运行可复用令牌直接认证。
- **就绪判定与断线恢复**：以 DSH 打印的 URL 行为就绪信号（捕获令牌即翻转为运行中，不必等探测周期）；探测循环负责存活检测与断线重连。
- **启动预检与失败翻译**：拉起前检查 node 版本（读 DSH 根 `engines.node`）、`node_modules\tsx` 与 CLI 入口，不满足则不启动并给出可行动提示（前端 `dist` 缺失只告警不拦截）；启动期退出按上游稳定输出分类翻译原因。
- **停止与重试语义**：停止立即置「已停止」并最多等 3 秒确认；窗口重试与托盘重启共用「停止 → 等端口 → 拉起」流程；端口被无关服务占用时不动作。
- **现代化窗口与托盘驻留**：Win11 圆角无边框炭黑窗口；关窗最小化到托盘，菜单含显示窗口 / 浏览器打开 / 重启 / 停止 / 开机自启 / 退出（退出保留 DSH 后台运行）。
- **自愈与兜底**：界面自愈（`render-process-gone` / `preload-error` / `did-fail-load`，限速 3 次/分钟）与内嵌访客崩溃自愈（横幅 + reload + 重发 src 兜底）。
- **单实例后台启动**：二次启动聚焦已有窗口；`--hidden` 启动到托盘（供开机自启）。
- **端口漂移告警**：DSH 自报监听端口与配置不一致时弹泡提醒修改 settings.json。

## 快速开始

- 前置：本机有可用的 DSH 源码 checkout（默认取启动器同级的 `deepseek-harness`，可在配置中修改）。
- 双击 `Start-Launcher.vbs` 启动（首次自动安装依赖，之后秒开）；或目录内执行 `npx electron .`。
- 回归测试：`npm test`（纯桩竞态用例 + webview 加载竞态用例，会拉起隐藏窗口的 Electron 约 10 秒，不启动真实 DSH）。

## 配置

`%APPDATA%\dsh-launcher\settings.json`（首次运行后生成）：

```json
{
  "port": 3080,
  "dshDir": "<你的 deepseek-harness checkout，例如 D:\\code\\deepseek-harness>",
  "startCmd": ["node", "--import", "tsx/esm", "apps/cli/src/bin.ts", "web", "--no-open"],
  "noOpen": true
}
```

- `dshDir`：DSH 源码目录（默认优先启动器同级的 `deepseek-harness`）；`startCmd`：启动命令（旧配置缺 `--no-open` 会自动补上并写回）；`port`：探测端口；`noOpen`：是否自动追加 `--no-open`（上游不再支持时自动去掉并写回 `false`）。
- 启动子进程时剥离 `NODE_OPTIONS`、`NODE_PATH`、`DSH_DESKTOP_*` 与 `npm_*`/`pnpm_*`/`corepack_*` 环境变量（对齐官方桌面端）；需要给 DSH 传 Node 选项时请直接写进 `startCmd`。
- 改完重启启动器生效；窗口位置/大小自动记忆。原子写与完整剥离名单见 [docs/maintenance.md](docs/maintenance.md)。

## 日志

DSH 输出同时写入 `%APPDATA%\dsh-launcher\dsh.log`（UTF-8 BOM，超 2MB 自动轮转保留末尾约 2000 行，时间戳带月日）。

注意：通过「退出（DSH 继续运行）」退出后，输出管道随启动器一起关闭，之后的 DSH 输出不再写入该文件（Node 子进程本身不受影响）。需要完整留存日志时，请保持启动器常驻托盘，或使用「退出并停止 DSH」。

## 详细文档

与官方桌面端的关系、各基线的吸收记录、依赖的上游契约核对表，以及功能 / 配置 / 图标的完整细节：见 [docs/maintenance.md](docs/maintenance.md)。

## 卸载

- 若启用过「开机自动启动」，先在托盘菜单取消勾选（否则注册表 Run 项残留指向失效路径）。
- 直接删除 `dsh-launcher` 目录即可，DSH 本体不受影响。
- 配置与日志在 `%APPDATA%\dsh-launcher\`，可一并删除。
