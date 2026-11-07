# d.97 装插件即自动采集 + 插件进云端仓库（含真机自检）

- 日期：2026-11-08
- 版本：`d.97.2.42.0`（特性 +1）
- 分支：`feat/d96-infohub-plugin`（worktree `.worktrees/infohub-plugin`，已 rebase 到 `feat/d77-heming-core` 的 d.95）
- 前置：d.96「信息采集中枢插件：采集桥随和鸣托管」（本分支上一轮）
- 用户指令：「和鸣安装插件后自动进行采集信息。把插件打包到云端，用户可以自行安装。先自检」

## 0. 一句话

把「装插件 → 还得手动连接、手动同步」改成**装上就自动采**：安装/启用「信息采集中枢」后，
桌面端自动拉起采集桥与归档边车、立即采集一次，此后每 30 分钟增量采集；用户可在信息中枢页
关闭自动采集或「立即采集一次」；插件 1.1.0 发布进云端插件仓库，用户从「插件区 → 仓库」自行安装。

## 1. 需求解析（用户三句话 → 可验收行为）

| 用户要求 | 落地 |
|---|---|
| 安装插件后自动进行采集信息 | 插件安装/启用事件 → 立刻采集一次；打开和鸣时若已装插件且距上次满 30 分钟也补一次；每 30 分钟增量采集；自动拉起采集桥（HTTP MCP）与归档边车 |
| 把插件打包到云端，用户可以自行安装 | 插件版本 1.0.0 → 1.1.0；`publish-plugin.mjs --push` 发进云端仓库（`PUT /api/plugins/:id/:version`）；用户在「插件区 → 仓库 / 下载安装」浏览、下载、校验 sha256 后安装（d.95 仓库链路，本轮验证） |
| 先自检 | 真实浏览器（headless Edge + CDP）+ 真实 Electron 真机全流程；本机真实 Python 端点；全量门禁（见 §6） |

## 2. 自动采集（`lib/infohub/autoCollect.ts`）

### 2.1 触发与节奏

- **插件开关即总开关**：`pluginActive` = 插件存在 + 插件启用 + `mcpServers` 贡献未单独停用；
- **安装/启用** → `runNow("install")` 立即一次（只在 `pluginActive` false→true 转变时触发，
  避免无关插件的增删打断采集节奏）；
- **每次打开和鸣** → hook 挂载补一次（`shouldCollectNow` 保证距上次不足 30 分钟不重复）；
- **每 30 分钟** → `runNow("schedule")`；`running` 防重入（`sync` 最长 30 分钟超时，上一轮没结束不开下一轮）；
- **停用/卸载插件** → 停定时器、清 `nextRunAt`；用户关闭自动采集 → 同样停调度；
- **手动**：「立即采集一次」调 `runNow("manual")`，即使自动采集关闭也照跑（用户显式动作）。

### 2.2 一轮采集做什么

1. `startInfohubBridge(readInfohubConfig())`：确保采集桥在跑（失败只记入摘要、不阻塞采集——
   归档 `sync` 走 stdio 边车，不依赖 8776 端点；外部已有端点由桌面端复用）；
2. `startInfohub(readInfohubConfig())`：需要时拉起归档边车（同目标已在跑则复用，不重复 spawn）；
3. `callInfohub("sync", {})`：增量采集，来源由 InfoHub `config.json` 的 qq/wechat 开关决定；
   `sync` 内部会更新日程（`agenda.update_agenda`）；
4. 摘要（会话/新增/更新/各来源状态）写进内存状态；随后 `useInfohubStore.refresh()` 刷新统计与日程，
   首页卡与工具不读旧数据；失败记中文原因 + 失败时刻，下一轮间隔到点再试（**不重试风暴**）。

### 2.3 状态与存储

- `useAutoCollectStore`：`pluginActive / enabled / running / lastRunAt / lastStatus / lastMessage / nextRunAt`
  + `refresh()` / `setEnabled(v)` / `runNow(reason)`（epoch ms；页面逐字段订阅）；
- 只把 `{enabled:boolean}` 写进 `heming.infohub.autoCollect.v1`；**归档正文、消息内容不进 localStorage**；
  `lastRunAt` 不持久化（重启后按「距上次 30 分钟」补采，不空等）；
- 插件变化经 `heming:plugins-changed` window 事件通知（`plugins/store.ts` 在 install/更新/启停/
  贡献级启停/卸载**写盘之后**统一派发）——自动采集只关心「变了」，不逐条跟四条写入路径。

### 2.4 接线与页面

- `App.tsx`：`useAutoCollect(Boolean(authUser) && infohubModuleOn && isInfohubAvailable())`
  （信息中枢模块停用 = 一并停；浏览器端 active 为 false，hook 不挂定时器/监听）；
- 信息中枢页「采集桥」区块内新增「自动采集」段：状态（已开启/已关闭/正在采集…/插件未启用）、
  开关、立即采集一次、上次采集时间、下次预计（开且有值才显示）、失败原因、插件未装→去插件区安装、
  常驻边界「仅桌面端 · 只采本机 · 每 30 分钟增量一次 · 可在这一步关闭」；浏览器端只显示
  「浏览器版不会自动采集，也不会拉起进程」。

## 3. 红线口径更新（有意为之，不是漂移）

d.45/d.47 的「不自动拉起 Python 进程」约束的是**信息中枢模块与自动化模块**（用户没表达采集意愿时）。
d.97 的自动采集是**用户显式安装并启用采集插件**之后的行为，和自动化模块「用户建的任务到点跑 sync」同口径：

- 只有安装并启用插件（或用户点「立即采集一次」）才会启动进程；插件停用/卸载、关掉自动采集即停；
- 浏览器端不拉进程；退出时仍由 `child-kill` 整树回收（自检确认退出后 8776 关闭、无残留 Python 子进程）；
- 采集仍只写本机归档、不上传；智能体经采集桥调用 `infohub_sync` / `infohub_agenda_rebuild` 仍走 HITL。

## 4. 插件进云端仓库

- `plugins/infohub-collector/plugin.json`：`version: 1.1.0`，description/技能说明改为
  「安装并启用后自动采集（每 30 分钟增量一次，可在信息中枢页关闭）」；权限/服务/命令/工具说明不变；
- 发布：`node scripts/publish-plugin.mjs plugins/ --push <apiBase>`（`x-publish-key`）或
  `--dest <服务端 HEMING_PLUGIN_DIR>`；发布后 `GET /api/plugins` 出现该包，客户端「插件区 → 仓库」
  浏览、下载、校验 sha256、走同一套安装预览（d.95 链路，本轮实测）；
- **线上状态如实说明**：`47.92.39.184`（生产）当前仍是旧版——`GET /api/plugins` 返回 404，
  说明线上还没有 d.95 的插件仓库接口。因此本轮把插件**发布进仓库数据目录并在本地服务端 + 真实浏览器/
  Electron 全流程验证通过**；要让公网用户真正看到「仓库」并安装，需要先把 d.95+d.96+d.97 部署上线
  （`docs/deploy.md` 的打包/上传/install 流程），本轮不在分支里擅自做生产部署。

## 5. 自检记录（2026-11-07/08 实跑）

### 5.1 真实浏览器（headless Edge + CDP，1600×1000，临时服务端 8799 + 独立 vite 5175）

1. 登录（临时库 `admin/admin`）→ 插件区 → **仓库** Tab：显示「共 1 个 · 云端同一份插件仓库」，
   「信息采集中枢 v1.1.0 · 未安装 · 技能 1 / MCP 1 / 命令 3 / 风险上限 读写 / 网络主机 1」；
2. 点安装 → 预览显示权限（127.0.0.1:8776）、内容指纹、贡献清单 → 确认安装 → 插件区统计
   「已装 1」、提示「已安装插件「信息采集中枢」：新增 1 个技能、1 台 MCP 服务」；
3. 信息中枢页：采集桥显示「未检测到本机采集桥」（浏览器只能探测）+ 浏览器版不能拉起进程的说明；
   自动采集显示「浏览器版不会自动采集，也不会拉起进程」；
4. 控制台 0 error（截图 `01-home/03-repo/04-install-preview/05-installed/06-infohub-browser`）。

### 5.2 真实 Electron（`electron . --remote-debugging-port`，临时 home + InfoHub venv 解释器）

1. 登录后写入 `heming.infohub.home.v1` / `python.v1`；插件区 → 仓库 → 安装（确认 1.1.0 清单）；
2. **装完立即自动开始**：采集桥变为「运行中 · 127.0.0.1:8776 · 由和鸣托管」，自动采集「正在采集…」；
3. 采集完成：信息中枢显示「已连接 · 只读归档 · 271 个归档会话 / 139,042 条消息 / 48.0 MB」，
   来源状态 `qqnt ok / QQ ok / 微信 ok / voice ok / agenda ok`；自动采集「已开启 · 上次采集 2026-11-08 00:03 ·
   下次预计 11-08 00:33」；`curl http://127.0.0.1:8776/health` → `{"infohub-mcp"}`；
4. 关闭自动采集 → 显示「已关闭」、下次预计消失；点「立即采集一次」→ 重新「正在采集…」并完成
   （关闭自动采集后用户显式动作仍有效）；
5. 退出应用 → 8776 端口关闭、无残留 Python/Electron 进程（整树回收有效）。

### 5.3 自检中修掉的真实缺陷

- **页面挂载时把解释器丢了**：`InfohubPage` 挂载发现边车已在跑时，用 `{home}` 重新 `status`，
  主进程把它当「另一个目标」重开边车，在没有内置运行时的机器上直接报「未找到可用的 Python 解释器」，
  页面停在 error。修法：带上 `bridgeInfo.python`；补回归用例「已运行边车时进入页面直接挂上且带解释器」。
- **自动采集先起、页面后开**：页面挂载时边车可能还在启动中，页面停在「未连接」而自动采集已在采。
  修法：订阅共享 store 的 `running`，idle 时自动接管连接；补用例「共享 store 变运行中 → 页面自动连接」。
- **采集桥早退拒绝丢响应**：403/404/400 拒绝时带着未读请求体关连接，Windows 上对端可能收到 RST、
  响应丢失（门禁里偶发 `ConnectionResetError`）。修法：先按 `Content-Length` 读掉请求体（≤256KB）再回
  响应，超限则立即 413 不阻塞；`test_mcp_server` 与全量 Python 单测连跑多遍稳定。

## 6. 门禁

- Web：新增 `autoCollect.test.ts` 32 例 + 插件 store 事件 3 例；`InfohubPage.test.tsx` 35 例
  （新增自动采集 10 + 页面接管 2）；`bundledPlugins.test.ts` 8 例（新口径守卫）；
- 桌面 / Python：d.96 已覆盖，本轮未改这两层（全量门禁含它们）；
- 全量（2026-11-08 分步实跑，exit 0）：**shared 29 / server 172 / web 256 文件 3686 例 / desktop 573 /
  Python 210**；`tsc --noEmit` 零错；
- 说明：并发 `pnpm -r test` 时 server 的 vitest worker 偶发原生崩溃（0xC0000409，单跑 `app.test.ts` 37 例
  与分步跑均通过，属并发资源抖动），门禁数字以分步为准；
- 顺带修掉两个跨零点/凌晨必红的既有用例（`HomeTeamUsage` 用 UTC 日期比本地自然日、`StaffPage` 首跑
  trigger 依赖 dailyAt），见 CHANGELOG。

## 7. 边界

- 自动采集是**应用级后台动作**，不经模型、不绕过 HITL（HITL 只约束模型工具调用）；
- 只在本机：不写会话、不上传、不存归档正文；
- 浏览器端不拉进程；停用插件/关闭自动采集立即停；退出整树回收；
- 插件仍只声明不执行代码、云端仓库只存原样清单（权限/签名/安装校验仍在客户端）。
