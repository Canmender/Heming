# 和鸣 · 自动化中心子系统审计与扩展点清单（d.48 现状）

- 日期：2026-11-03
- 审计对象：`packages/web/src/lib/automation/*`、`components/AutomationPage.tsx` 及其集成面（InfoHub 桥、本机存储、通知中心、存储水位、UI 意图、导航）
- 代码基线：`d.48.1.11.0`（`packages/*/package.json` 的 `hemingVersion`；分支 `qoder/hermes`）
- 规格基线：`docs/superpowers/specs/2026-11-01-d47-automation-center.md`、`docs/superpowers/plans/2026-11-01-d47-automation-center.md`、`docs/HANDOFF.md` 第 45 条与「自动化的边界」段、`docs/VERSION-MANAGEMENT.md`
- 本文用途：给下一轮代码改造提供可直接落手的插入点、连带影响与红线口径。只读审计，本轮未改任何代码、未跑全量测试、未 commit。

## 0. 一句话结论

自动化中心是「13 个文件左右的小闭环」：模型 / 执行器 / 调度器 / store / 页面五件套已经稳定且有 48 例测试护住，但它的**扩展面全部是硬编码分支**——动作白名单写在 `AutomationKind` 联合类型里、执行分发是 if/else、失败结果只落在任务自身的 `lastStatus/lastDetail` 一个槽位、通知中心没有任何自动化入口。要做动作注册表、运行记录、失败通知，改动量不大（各 1–3 个文件），**真正的成本在口径**：`docs/HANDOFF.md:250` 已经把「没有失败自动重试、没有运行历史明细」写成明确不做的边界，本轮改造必须先显式改写这份文档与规格，否则等于静默变更承诺。

## 1. 现状能力表

| 能力 | 实现位置 | 限制 |
| --- | --- | --- |
| 任务模型（kind / schedule / sync / 运行摘要） | `packages/web/src/lib/automation/model.ts:21-35` | `AutomationKind` 只有 `"infohub.sync"` 与 `"infohub.agenda"` 两个字面量（`model.ts:8`），没有注册表、没有第三动作的落点 |
| 触发方式 | `model.ts:17-19`（`daily{time,weekdays}` / `interval{minutes}`） | 只有两种；`daily` 用本地时区（`model.ts:112-125`），`interval` 夹紧 5–1440 分钟（`model.ts:48-49,132-136`） |
| 下次时间计算 | `model.ts:128-137`；每日实现 `model.ts:112-125` | 严格晚于 `from`；一周内无匹配时兜底 `+24h`（`model.ts:123-124`，理论不可达） |
| 表单校验 | `model.ts:140-165` `validateDraft` | kind 白名单在 `model.ts:144`；只有 `infohub.sync` 校验来源非空（`model.ts:147-150`） |
| 草稿归一 | `model.ts:182-206` `normalizeDraft` | 名称截断 `MAX_NAME_CHARS=40`（`model.ts:46,81-85`）；间隔取整并夹紧 |
| 读盘归一 / 坏条目丢弃 | `model.ts:209-268` `normalizeTask` | 丢弃条件分散在 `213/214/218/226-228/235`；`lastDetail` 截到 160 字（`model.ts:47,263-265`） |
| 持久化 | `store.ts:24-25`（键 `heming.automations.v1` / 256KB）、`store.ts:28-45` 读取、`store.ts:58-60` 写盘 | 写盘失败**静默**（`writeJson` 返回 false 无人看），见 §7-1 |
| 新建 / 编辑 / 删除 / 启停 | `store.ts:103-123` / `125-145` / `147-152` / `154-168` | 新建、改频率、重新启用都「从此刻重新排期」（`store.ts:116,138,162`）；删除不级联任何从属数据（当前也没有从属数据） |
| 执行权锁（全局单槽） | `store.ts:170-175` `beginRun`；内存字段 `store.ts:81` `runningId` | 只有一把锁：`if (get().runningId) return false`（`store.ts:171`）。长 `sync`（桥超时 30 分钟）期间到点的其它任务全部等下一轮 |
| 收尾与顺延 | `store.ts:177-198` `finishRun` | **无条件** `nextRunAt = nextRunAt(schedule, now)`（`store.ts:188`）：成功/失败/跳过三种结果的下次时间语义完全相同 |
| 启动顺延（不补跑） | `store.ts:200-216` `rescheduleMissed`；调用点 `scheduler.ts:21-22` | 只改 `nextRunAt/updatedAt`，不改 `lastRunAt/lastStatus/lastDetail`；只处理 `enabled` 且 `nextRunAt < since` |
| 调度挂载 | `packages/web/src/App.tsx:239` `useAutomationScheduler(Boolean(authUser))` | 只有登录后才挂载（`App.tsx:239`）；组件内 `enabled && isInfohubAvailable()` 双闸（`scheduler.ts:20`） |
| 轮询与串行 | `scheduler.ts:8`（15s）、`scheduler.ts:50-52`（`setInterval`）、`scheduler.ts:30-34`（`runningId` 早退 + `beginRun` 抢占）、`scheduler.ts:46`（跑完立刻递归下一条） | 误差最多 15 秒；无「正在执行中」超时看门狗，进程被挂起时 `runningId` 会一直是脏的（但只在本进程内存里） |
| 桌面 / 浏览器分支 | `scheduler.ts:20`（浏览器直接 return，不消耗计划）、`AutomationPage.tsx:149-153`（提示条）、`infohub/client.ts:227-229` `isInfohubAvailable` | 浏览器端可创建、可查看、到点不执行 |
| 执行前门禁 | `runner.ts:32-38` `automationBlockedReason` | 两道：桌面桥存在（`isInfohubAvailable`）、`useInfohubStore.getState().running`；返回中文原因串 |
| 动作执行 | `runner.ts:83-93` `runAutomationTask`（分发 `runner.ts:87-89`）；`runSync` `40-70`；`runAgendaRebuild` `72-80` | 白名单 if/else；`sync` 后顺带 `refresh()`（`runner.ts:64-68`，失败被吞）；`agenda` 直接写回共享 store（`runner.ts:78`） |
| 错误归一 | `runner.ts:90-92` + `infohub/client.ts:240-246` `describeInfohubError` | 只剥 IPC 前缀，不分类；所有异常一律 `status:"error"`（`model.ts:9`） |
| 桥调用形态 | `infohub/client.ts:268-274` `callInfohub` → `248-254` `invoke` → `231-234` `bridge()` | 壳层超时在主进程 `packages/desktop/infohub-bridge.js:44-49,434-441`：`sync` 30 分钟、`agenda` 5 分钟、其余 60 秒 |
| 结果留痕 | `store.ts:69-72` `AutomationResult`；`model.ts:31-34`（`lastRunAt/lastStatus/lastDetail/runCount`） | **每任务只有一格**：一次新结果覆盖上次，没有历史记录 |
| 页面（列表 / 统计 / 空态） | `AutomationPage.tsx:130-361`；统计条 `187-195`；空态 `198-213`；任务卡 `216-309` | 任务卡只展示「上次 + 下次」，无展开明细 |
| 手动「立即运行」 | `AutomationPage.tsx:111-128` | 与调度共用 `beginRun`/`finishRun`；结果写在页内 `notice`（`81` `useState`），切页即丢 |
| 编辑弹窗 | `AutomationPage.tsx:372-687`（`AutomationEditor`），保存 `429-441` | 动作下拉硬编码两个 option（`482-495`）；同步选项面板只在 `kind==="infohub.sync"` 时出现（`497-538`） |
| 删除确认 | `AutomationPage.tsx:327-358` | 文案已写「已有的运行结果也会一并移除」（`354-356`）——做运行记录时要真的兑现这句 |
| 跨页意图（信息中枢 → 自动化） | `store/ui.ts:108-111`（`AutomationIntent`）、`141`（字段）、`241-253`（`openAutomations` / `consumeAutomationIntent`）；消费点 `AutomationPage.tsx:89-94` | 一次性，消费即清；`setPage` / `openConversation` / `focusTask` 都会顺手清空（`ui.ts:226,262,288`） |
| 信息中枢入口 | `InfohubPage.tsx:548-553`（页头「定时」）、`745`（保存为定时任务）、`1033-1037`（定时重扫） | 空来源拒绝投递（见 d.47 计划第 4 条与 `InfohubPage.test.tsx` +4 例） |
| 通知中心接线 | **无** | `packages/web/src/lib/automation/` 全目录无 `notifications` 引用（`grep -rn "notification" packages/web/src/lib/automation` 为空） |
| 运行历史 / 重试 / 取消 | **无** | 规格 `spec:25,64` 与 `HANDOFF:250` 明确列为不做 |

## 2. 架构红线清单（逐条原文 + 出处）

### 2.1 与本轮改造直接相关的五条

| # | 红线 | 原文 | 出处 |
| --- | --- | --- | --- |
| R1 | **不执行任意脚本** | 「不做任意脚本 / shell / 提示词任务：动作是白名单的。」 | `docs/superpowers/specs/2026-11-01-d47-automation-center.md:23` |
| R1' | 同上（红线章） | 「不允许任务携带任意命令、URL、可用凭据；动作与参数都是枚举/布尔。」 | 同文件 `:105` |
| R2 | **不自动重试** | 「执行前校验：桌面桥存在 + InfoHub 已连接（`running` + `booted`）。二者任一不满足 → 记 `skipped`，详情说明原因，并顺延下一周期；不 spawn、不重试。」 | 同文件 `:64` |
| R2' | 同上（实现注释） | 「因此未连接直接 skipped，让调用方顺延计划，不 spawn、不重试。」 | `packages/web/src/lib/automation/runner.ts:17-18` |
| R2'' | 同上（交接边界） | 「**没有取消/断点续跑、没有失败自动重试、没有运行历史明细**（只留最近一次状态与摘要）。」 | `docs/HANDOFF.md:250` |
| R3 | **不补跑** | 「**只在和鸣运行期间执行**。应用启动时，若任务的 `nextRunAt` 早于本次调度器启动时间，直接顺延到下一周期，不补跑、不记失败。」 | spec `:63` |
| R3' | 同上（非目标） | 「不做错过补跑：应用关闭期间错过的时刻不执行，页面明确说明。」 | spec `:25` |
| R4 | **不自动拉起边车** | 「不自动拉起 Python 边车：d.45/d.46 的红线不变，未连接时任务记「已跳过」。」 | spec `:22` |
| R4' | 同上（红线章） | 「未连接 InfoHub 时不自动启动子进程。」 | spec `:106` |
| R4'' | 同上（实现注释） | 「执行前必须确认边车已经在跑——桥的 `call()` 在目标不一致时会自动拉起进程，自动化绝不能借这条路径绕过「由用户点连接」的约定。」 | `runner.ts:16-17` |
| R5 | **不上云** | 「自动化数据不上云、不进消息库、不进服务器数据库。」 | spec `:103` |
| R5' | 同上（非目标） | 「不做服务端调度：自动化任务只存本机，和鸣没有运行就不会发生。」 | spec `:21` |
| R5'' | 同上（代码注释） | 「自动化任务（本机）：只存 localStorage，不上云、不进消息库。」 | `store.ts:18` |

### 2.2 周边不可违背项

| # | 红线 | 原文 | 出处 |
| --- | --- | --- | --- |
| R6 | 本地驱动 / 数据不出设备 | 「**架构红线（不可违背）**：智能体**本地驱动**（本机系统提示词 + 本机 LLM Key 直连供应商 + 本机执行），云端**只是 IM 桥梁**；个人数据（Key/记忆/知识库/本地文件）**不出设备**。」 | `docs/HANDOFF.md:16` |
| R7 | 执行日志不记录正文 | 「执行日志只落本机，且不记录聊天正文。」 | spec `:107` |
| R8 | 失败不阻塞主链路 | 「不因自动化失败而阻塞聊天 / 任务主流程。」 | spec `:104` |
| R9 | 串行且单条 | 「调度器挂在已登录的主界面，15 秒轮询一次；同一时刻只执行一条任务。」 | spec `:62` |
| R10 | 同步来源必须显式勾选 | 「`sync` 仍只由任务配置中的来源执行——自动化无法绕过「用户显式选择来源」这条既有约定。」 | `docs/HANDOFF.md:250` |
| R11 | 浏览器不消耗计划 | 「浏览器里可以创建与查看任务，但到点不会执行，也不会消耗计划。」 | `docs/HANDOFF.md:250`；实现 `scheduler.ts:20` |
| R12 | 无 emoji 视觉规范 | 「无 emoji 图标（细线 SVG 1.5px，emoji 仅作消息内容）」 | `docs/HANDOFF.md:160` |
| R13 | 版本必须 bump | 「**每一次修改、修复、重构，无论大小，都要改版本号。** 没有 bump 的改动视为未完成。」 | `docs/VERSION-MANAGEMENT.md:5`；命令 `node scripts/bump-version.mjs auto <fix\|feature\|breaking\|build>`（`:9`） |

### 2.3 口径冲突预警（本轮改造必读）

要做 (b) 每任务重试策略、(c) 运行记录，与 R2''/R2 与 `HANDOFF:250` 的「明确不做」**直接冲突**。改造必须先做三件事，否则是静默改承诺：

1. 在规格（新一篇 `docs/superpowers/specs/2026-11-XX-*.md`）里重写「非目标」与「红线」两节，写明**新的重试边界**（例如：仅 `error`、仅可判定为瞬时的错误、单次运行最多 N 次、指数退避、跨启动不累计）；
2. 同步改 `docs/HANDOFF.md:250` 的边界段与 `docs/HANDOFF.md` 里程碑新增一条；
3. 版本按 feature 位 +1（`VERSION-MANAGEMENT.md:31`），并跑 `node scripts/build-changelog.mjs`（`:95-96`，忘了会被 `changelog-sync.test.js` 抓出来）。

注意 `HANDOFF:250` 里「没有失败自动重试」这句话本身就是 d.47 的产品承诺，改动需要在 CHANGELOG 里点名，不能只在代码注释里留痕。

## 3. 数据结构与存储现状

### 3.1 键位表（与本子系统相关的全部键）

| 键 | 定义位置 | 条数上限 | 字节上限 | 读盘归一 / 丢弃策略 |
| --- | --- | --- | --- | --- |
| `heming.automations.v1` | `store.ts:24` | `MAX_AUTOMATIONS=20`（`model.ts:45`） | `AUTOMATIONS_BYTE_LIMIT=256*1024`（`store.ts:25`） | `readAutomations`（`store.ts:28-45`）：非数组回空、逐条 `normalizeTask`、按 id 去重（`36-42`）、满 20 条截断 |
| `heming.notifications.v1` | `store/notifications.ts:21` | `MAX_NOTIFICATIONS=50`（`:24`） | `NOTIFICATIONS_BYTE_LIMIT=64*1024`（`:29`） | `normalizeNotification` 逐条丢弃（`:78-103`）+ `pruneNotifications` 条数/字节双淘汰（`:106-119`） |
| `heming.infohub.home.v1` / `heming.infohub.python.v1` | `lib/infohub/client.ts:182-183` | — | — | `readKey` 空串兜底（`client.ts:194-201`） |
| `heming.navOrder.v1` | `store/ui.ts:44` | — | — | `normalizeNavOrder` 只留已知页并补全（`ui.ts:50-61`） |
| `heming.tasks.v1`（对照） | `lib/tasks/store.ts:23` | `MAX_TASKS=60`（`:26`） | `1.1MB`（`:40`） | `pruneTasks` 双淘汰，且先推通知再摘运行中任务（`store.ts:581-597`） |
| `heming.staff.runs.v1`（**运行记录的最佳模板**） | `lib/staff/model.ts:12` | `MAX_STAFF_RUNS=30`（`:16`） | `STAFF_RUNS_BYTE_LIMIT=192*1024`（`:18`） | `pruneRuns`（`model.ts:738-754`）+ `readStaffRuns`（`lib/staff/store.ts:63-70`） |

**当前事实：`heming.automations.v1` 没有登记到存储水位表**——`lib/storageUsage.ts:56-77` 的 21 条前缀规则里没有 `heming.automations.`，因此该键被归进 `OTHER_MODULE = "其它"`（`storageUsage.ts:34,94-99`）。用户清理存储时看不到自动化占了多少，见 §4-(c)。

### 3.2 `readJson` / `writeJson` 契约（所有本机键的共同地基）

- `lib/memory/storage.ts:75-89` `readJson(storage, key, fallback, pick?)`：缺键、`JSON.parse` 抛错、`pick` 抛错一律回退 `fallback`；**永不抛**。
- `lib/memory/storage.ts:95-114` `writeJson(storage, key, value, limit = KEY_SIZE_LIMIT)`：序列化失败 → `false`；`utf8Length(text) > limit` → `false`；`setItem` 抛（配额/隐私模式）→ `false`。**返回值是唯一的失败信号**。
- 默认上限 `KEY_SIZE_LIMIT = 1.2MB`（`storage.ts:29`）；按 UTF-8 字节算，中文一字三字节（`storage.ts:33-36`）。
- 兜底存储：`createDefaultStorage`（`storage.ts:60-72`）先用探针键 `heming.memory.probe` 试写，失败降级 `createMemoryStorage`（纯 Map，仅本次会话可见，`storage.ts:43-54`）。
- **调用方惯例**：`writeJson` 的 false 一律被忽略（`store.ts:58-60`、`notifications.ts:177-181`、`tasks/store.ts:597` 都是直接丢弃返回值）。这是本子系统「存不下就只留内存」的既定形态，也是风险 §7-1 的根。

### 3.3 内存态字段（不落盘，重启即失）

| 字段 | 位置 | 语义 | 为什么不落盘 |
| --- | --- | --- | --- |
| `runningId: string \| null` | `store.ts:81,100` | 执行权锁持有者任务 id | 「应用重启后不可能还有任务在跑；落盘会让页面永远停在「运行中」」（`store.ts:19-21`） |
| `runningSince: number` | `store.ts:82,101` | 抢占时刻 | 同上；目前**无任何 UI 或逻辑读取它**（只有 `finishRun` 归零 `store.ts:196`），是重试/超时设计可复用的现成槽位 |
| `automationIntent` | `store/ui.ts:141,212` | 信息中枢投递的一次性意图 | 页面内瞬态；`setPage`/`openConversation`/`focusTask` 都会清（`ui.ts:226,262,288`） |
| 页面 `notice` / `error` | `AutomationPage.tsx:81-82` | 立即运行的结果条 | 组件卸载即丢（见 §7-4） |
| 模块级 `seq` | `store.ts:62-67`、`notifications.ts:59-64` | id 去重序号 | 只影响 id 唯一性 |

### 3.4 任务对象形状与运行摘要槽位

`AutomationTask`（`model.ts:21-35`）里与「运行」有关的只有四个平铺字段：`lastRunAt?`、`lastStatus?`（`"ok"|"error"|"skipped"`，`model.ts:9`）、`lastDetail?`（≤160 字，`model.ts:47`）、`runCount`（`model.ts:34`，读盘时非正整数归 0，`model.ts:266`）。**没有任何数组字段**，也没有「本次运行 id」——这是 (c)(d) 必须先解决的形状问题：失败通知要去重就必须有一个能区分「这一次失败」与「上一次失败」的标识。

## 4. 扩展点地图

### (a) 动作注册表

**目标形态**：把「动作 = 联合类型 + if/else 分发 + 页面硬编码 option」改成「动作 = 注册项（元数据 + 校验 + 执行器）」。

| 改动位置 | 具体插入点 | 改法 |
| --- | --- | --- |
| 新增 `lib/automation/actions.ts` | — | 定义 `AutomationAction { kind, label, describe(task), validate(draft): string, run(task): Promise<AutomationResult> }` 与 `register/get/list`。注册表形态可对齐既有能力内核 `lib/capability/index.ts:11-18`（`.register(...)` 链式）与 `lib/capability/registry.ts` |
| `model.ts:8` | `AutomationKind` 联合类型 | 改成 `type AutomationKind = string` 会让读盘校验失去编译期白名单；更稳的是保留字面量联合但由注册表 `as const` 派生，且**注册表不能 import runner**（`runner.ts:1-11` 已 import model，反向依赖会成环）→ 建议 kinds 与注册项分文件：`kinds.ts`（纯数据，model 依赖）+ `actions.ts`（含 run，runner 依赖） |
| `model.ts:144` | `validateDraft` 的 kind 白名单 | 改为 `if (!isKnownKind(draft.kind)) return "请选择要执行的动作"` |
| `model.ts:147-150` | sync 来源校验 | 移到动作注册项的 `validate` 里（只有 `infohub.sync` 需要） |
| `model.ts:202` | `normalizeDraft` 的 kind 兜底 | 改为注册表校验，未知 kind 落默认动作 |
| `model.ts:214` | `normalizeTask` 的 kind 白名单 | 同上（老数据里的未知 kind 仍要丢弃，别放宽） |
| `model.ts:287-293` | `describeAction` / `actionLabel` | 改为查注册项的 `describe` / `label` |
| `model.ts:310-318` | `draftForKind` | 改为查注册项的默认草稿工厂 |
| `runner.ts:87-89` | 分发 | 改为 `const action = getAction(task.kind); if (!action) return result("error","未知的自动化动作")` |
| `AutomationPage.tsx:482-495` | 动作 `<select>` | 改为 `listActions().map(...)`；`493-494` 两个硬编码 option 删除 |
| `AutomationPage.tsx:247` | 任务卡动作描述 | 改查 `describeAction`（已经是调用，无需动） |
| `AutomationPage.tsx:497` | 同步选项面板条件 | 改为「动作声明了 sync 面板」而不是写死 `kind==="infohub.sync"` |
| `AutomationTask.sync`（`model.ts:27`） | 必填字段 | 新动作若无 sync 参数，`normalizeTask` 会走 `normalizeSync(undefined)` 兜双来源（`model.ts:167-178`）——**会凭空塞进一份 sync 配置**。要么把 `sync` 改可选（波及 `store.test.ts:22-27` 的 `draft` 与 `makeTask` fixture、`runner.test.ts:17-31`、`scheduler.test.tsx:15-29`、`AutomationPage.test.tsx:16`），要么新动作也接受一个空 sync 占位 |

**会被影响的现有测试**：
- `lib/automation/model.test.ts:73-105`（`validateDraft` 逐条文案断言，含「请选择要执行的动作」路径未覆盖但对文案敏感）、`:108-142`（`normalizeTask` 丢弃规则）、`:170-182`（`draftForKind` 名称/来源断言）
- `lib/automation/runner.test.ts:88-199`（分发与结果文案）
- `components/AutomationPage.test.tsx:64-81`（新建走默认动作）、`:94-118`（意图预填的 QQ/微信勾选状态、agenda 无 QQ 输入）
- `store/ui.test.ts:199-218`（意图生命周期，不含动作细节，通常不受影响）

**隐含耦合**：`AutomationPage.tsx:540-584` 的「每天定时 / 按间隔」`role="radiogroup"` 与 `586-654` 的时间/星期控件是**与动作正交**的，注册表改造不要顺手改排期 UI；`InfohubPage.tsx:1033-1037` 的「定时重扫」直接投 `{kind:"infohub.agenda"}`，新动作若要复用入口需另开意图。

### (b) 每任务重试策略

**先说结论：这是唯一一条会撞红线的扩展**（见 §2.3）。技术上可在本轮「留扩展点、不启用」，即先加字段与收敛点，默认 `retry.max=0` 保持现有行为，等规格拍板再打开。

| 改动位置 | 具体插入点 | 要点 |
| --- | --- | --- |
| `model.ts:21-35` | `AutomationTask` 加 `retry?: { max: number; delayMs: number }` | 必须是可选字段（老数据无此键）；`normalizeTask` 只需要 `raw.retry` 白名单化，不写默认值，避免把「没配」写成「配了 0」 |
| `model.ts:45-49` | 常量区 | 加 `MAX_RETRY_ATTEMPTS`（建议 ≤3）、`MIN_RETRY_DELAY_MS`（建议 ≥30s）并在 `validateDraft` 夹紧 |
| `model.ts:140-165` | `validateDraft` | 加 retry 区间校验（沿用现有「整数 + 区间 + 中文文案」风格，`model.ts:156-160`） |
| `store.ts:177-198` | `finishRun` —— **唯一收尾点** | 现状 `store.ts:188` 无条件写 `nextRunAt = nextRunAt(schedule, now)`。要重试必须新增 `retryAt` 字段并在这里分流：`status==="error" && attempts<max` → 写 `retryAt = now + delay`，不再改 `nextRunAt`；否则清 `retryAt` 并顺延 |
| `store.ts:200-216` | `rescheduleMissed` | **必须同时清 `retryAt`**：启动时的语义是「错过的时刻不补跑」，一个跨启动残留的 `retryAt` 会变成事实上的补跑，直接破 R3 |
| `store.ts:154-168` / `125-145` | `setEnabled` / `update` | 重新启用/改频率要清 `retryAt`（现有注释「停用一周后启用不应该立刻补跑」`store.ts:161`，同理适用于重试） |
| `scheduler.ts:32` | 取到期任务的判据 | `item.nextRunAt <= now` → 改 `(item.retryAt ?? item.nextRunAt) <= now`；否则 `retryAt` 永远不被消费 |
| `scheduler.ts:30` / `store.ts:170-175` | 执行权 | 重试仍走同一把全局单槽锁，**不要**为重试开新通道 |
| 内存态 | `store.runningSince` 旁 | 每条任务的「本次连续失败次数」应放内存（例如 `attemptsById: Record<string, number>`），落盘会让「昨天失败两次」跨启动累计，违背「只在和鸣运行期间」语义 |
| `runner.ts:90-92` | 错误分类 | 现在所有异常都是 `error`。若要做「只重试瞬时错误」，需要一个新的判定函数（可复用 `describeInfohubError` 的文本，按「请求超时 / 边车未就绪 / 数据库被占用」判定），**不建议**给 `AutomationRunStatus` 加值（会波及 `model.ts:295-299`、`AutomationPage.tsx:35-40` 配色与所有状态断言） |

**会被影响的现有测试**：
- `lib/automation/store.test.ts:138-157`（`finishRun` 断言 `nextRunAt === nextRunAt(schedule, finishedAt)`——加 `retryAt` 后这条必须保持「无 retry 配置时逐字相同」）
- `store.test.ts:159-164`（任务被删除后收尾只释放执行权）、`:166-180`（`rescheduleMissed` 只顺延启用且过期的任务）
- `scheduler.test.tsx:106-126`（到点执行一次并顺延）、`:145-161`（启动前已到点只顺延不补跑）、`:163-178`（串行不抢占）——后两条是 R3 的护栏用例，**任何重试实现都不能让它们变红**
- `runner.test.ts:105-115`（桌面端未连接：`bridge.start` / `bridge.call` 都未被调用）——重试若在未连接时重试，这条立刻红，属于正确的红线护栏

**隐含耦合（三条最容易被忽略）**：
1. `finishRun` 同时承担「记录结果」「顺延」「释放锁」三个职责（`store.ts:179-197`），重试逻辑塞进去会让它变成三个 if 分支，建议先抽 `applyRunOutcome()` 纯函数再扩展；
2. `runCount` 语义是「累计执行次数」（`model.ts:34,266`）。重试算不算一次 `runCount`？现有 UI 只在页面上显示（`AutomationPage.test.tsx:212` 断言 `runCount===1`），语义变了要同步改文案与测试；
3. 手动「立即运行」（`AutomationPage.tsx:111-128`）与调度共用 `finishRun`。手动失败要不要自动重试？产品上通常不要（用户就在旁边），技术上就成了 `finishRun` 需要知道「本次是手动还是调度」——现有签名 `finishRun(id, result, now?)`（`store.ts:90`）没有这个信息位。

### (c) 运行记录（新独立键 + 页面面板）

**最佳模板是 d.48 的幕僚运行记录**，几乎是同一形状，直接照抄可省一轮设计：

| 层 | 幕僚现状（模板） | 自动化要新增的位置 |
| --- | --- | --- |
| 键与上限 | `lib/staff/model.ts:12,16,18`（`heming.staff.runs.v1` / 30 条 / 192KB） | 新增 `lib/automation/runs.ts`：`AUTOMATION_RUNS_KEY = "heming.automations.runs.v1"`、`MAX_AUTOMATION_RUNS`（建议 30–50）、`AUTOMATION_RUNS_BYTE_LIMIT`（建议 128–192KB） |
| 归一 + 双淘汰 | `model.ts:738-754` `pruneRuns`（排序、截断、按字节回退、仍超限回空） | 同款纯函数；单条记录建议 `{ id, taskId, kind, startedAt, finishedAt, status, detail, runCountAt? }`，`detail` 沿用 `MAX_DETAIL_CHARS=160`（`model.ts:47`） |
| 读盘 | `lib/staff/store.ts:63-70` `readStaffRuns` | `readAutomationRuns(storage?)` 用 `readJson` + `normalizeRun` 逐条丢弃 |
| 写盘 | `lib/staff/store.ts:81-84` `persistRuns`（先 prune 再 write，返回 prune 后的数组） | 同款；注意 `writeJson` 的 false 要保留「仅内存」语义 |
| 追加 | `lib/staff/store.ts:107-115` `recordRun`（去同 id 后前插） | 在 `store.finishRun`（`store.ts:177-198`）里、`persist(tasks)` 之后调用；**顺序建议先写 runs 再写 tasks 之外**——参考 `tasks/store.ts:583-596` 的「先通知、再落盘」注释，本仓的既定取向是「宁可多留痕，不可静默丢」 |
| 级联删除 | 幕僚是单例，无此需求 | `store.remove`（`store.ts:147-152`）**必须**按 `taskId` 清掉该任务的记录，否则孤儿记录白占配额（d.29 已经踩过一次：删记忆条目不清用量账本，`HANDOFF.md:65` 第 25 条） |
| 页面面板 | `StaffPage.tsx:89` `RunItem`、`:428-441` 空态、`:447-449` 列表、`:415-422` 清空按钮 + `:461-481` 二次确认 | `AutomationPage.tsx:219-307` 任务卡内加「运行记录」展开区（或右侧抽屉）；空态文案沿用 `:198-213` 风格；清空要走 `ConfirmDialog`（`ConfirmDialog.tsx` + `AutomationPage.tsx:327-358` 现有用法） |
| 存储水位登记 | `heming.staff.` 已在规则表 | **必须**在 `lib/storageUsage.ts:56-77` 增加 `{ prefix: "heming.automations.", module: "自动化" }`（放 `heming.tasks.` 附近）；规则按前缀最长优先匹配（`storageUsage.ts:83-85`），`heming.automations.runs.v1` 与 `heming.automations.v1` 同前缀，一条规则覆盖两者。`StorageUsageCard.tsx:102` 直接调 `measureStorageUsage`，登记后设置区自动出现分组，**不需要改界面** |
| 文档 | — | `docs/HANDOFF.md:250` 的「没有运行历史明细」必须改写 |

**会被影响的现有测试**：
- `lib/automation/store.test.ts` 全部 `finishRun` 用例（`:138-164`）——若 `finishRun` 顺带写 runs，每个用例都要注入 runs 存储（否则写进 jsdom 真 localStorage，跨用例污染）；建议 `setAutomationStorage` 同款再开 `setAutomationRunStorage`
- `components/AutomationPage.test.tsx:64-81,146-157`（列表与删除断言，加了面板后 `screen.getByText` 可能出现多处命中）
- 新增 `lib/automation/runs.test.ts`（normalize/prune/read）
- `lib/storageUsage.test.ts:24-55`（`moduleOf` 逐条规则回环断言，新增规则自动被 `:53-55` 覆盖；可补一条 `moduleOf("heming.automations.v1")==="自动化"`）
- `docs/` 门禁：`changelog-sync.test.js`（改了 CHANGELOG 必须跑生成脚本）

**隐含耦合**：`store.remove` 的语义在 UI 文案里已经承诺「已有的运行结果也会一并移除」（`AutomationPage.tsx:354-356`）——不做级联就是文案说谎；`rescheduleMissed` 不写 runs（它不是一次「运行」），但 `lastStatus` 也不会变，读盘时别把「有记录但 lastStatus 为空」当异常。

### (d) 失败通知

**插入点只有一个是对的**：`store.finishRun`（`store.ts:177-198`）。理由：调度器（`scheduler.ts:37,39-43`）、页面立即运行（`AutomationPage.tsx:121,125`）两条路径都收口在这里；散到调用方一定会漏一处。

| 改动位置 | 具体插入点 | 要点 |
| --- | --- | --- |
| `store.ts:177-198` | `finishRun` 末尾 | `if (result.status === "error") { try { useNotificationStore.getState().push({...}) } catch { } }`——**必须 try/catch**，理由与 `tasks/store.ts:583-596` 同款（通知失败不能影响落盘） |
| 去重 key | 同上 | `automation:${taskId}:error:${lastRunAt}`（时间戳必须进 key）。用固定 key `automation:<id>:error` 会导致「第二次失败不提醒」，见 §5 去重机制 |
| `notifications.ts:40` | `NotificationKind` 联合 | 新增 `"automation"`；**不改就复用 `"task"`**，但 `normalizeNotification` 的 kind 白名单（`:82-89`）会丢弃未知 kind，所以新增 kind 必须同时改 `:82-89` |
| `NotificationCenter.tsx:31-38` | `KIND_LABEL` | 加 `automation: "自动化"`；漏了会渲染 `undefined` |
| `NotificationCenter.tsx:74-86` | `jump()` | 加分支：`if (item.kind === "automation") { focusAutomation(...) }`；现有 `task` 分支走 `focusTask`（`:81-84`）会跳到任务区，语义不对 |
| `store/ui.ts` | 新跳转意图 | 仿 `focusTask`（`ui.ts:280-299`）加 `automationFocusId` + `focusAutomation(taskId)`；并在 `setPage` / `openAutomations` / `openConversation` / `focusTask` / `openInfohub` 的清理列表里补 `automationFocusId: null`（`ui.ts:213-252,262,288`）——漏一处在跳转后就会残留高亮 |
| `AutomationPage.tsx` | 消费焦点 | 进入页面时读 `automationFocusId`，滚动到对应任务卡并展开运行记录，然后 `consumeAutomationFocus()`（参考 `taskFocusId` 的用法，`ui.ts:133-137`） |
| 系统通知（可选） | `lib/desktopNotify.ts:13-20` | `notifyDesktop` 自带「窗口聚焦时不弹」与「无桥静默」；幕僚的接法是依赖注入 + `safePush`（`lib/staff/runner.ts:126,199-215`）。失败通知建议**只做应用内**，系统通知留给「用户不在」的场景，否则同步失败会变成骚扰 |
| 文案 | — | 标题建议 `「<任务名>」执行失败`，正文 `detail`（已截 160 字，`model.ts:47`）；不使用 emoji（R12） |

**会被影响的现有测试**：
- `lib/automation/store.test.ts:138-164`：`finishRun` 现在会写通知键。测试必须 `setNotificationStorage(createMemoryStorage())`（`notifications.ts:173-175`）否则落到 jsdom localStorage、跨文件污染（`notifications.test.ts:18-24` 的既有写法）
- `lib/automation/scheduler.test.tsx:128-143`（未连接 → `skipped`）：**不要**给 `skipped` 推通知，否则「未连接」每次到点都刷一条，且该用例的语义会含混
- `store/notifications.test.ts:40-49`（未知 kind 被丢弃）、`:180-192`（新增 kind 落盘读回，照 `staff` 的用例补一条）
- `components/NotificationCenter.test.tsx:73-120`（跳转断言，补一条 automation 跳转）
- 新增断言「同一次失败只推一条」：同一 taskId + 同一 `lastRunAt` 调两次 `finishRun`，通知条数仍为 1

**隐含耦合**：`finishRun` 的签名只有 `(id, result, now?)`（`store.ts:90`），拿不到真实耗时与动作名——通知正文若要写「同步失败：InfoHub 请求超时（1800s）」只能靠 `detail`；要写任务名得在函数内查 `tasks`（现有实现已经在 map 里遍历过，顺手可取）。

## 5. 通知中心 API 的精确形状

文件：`packages/web/src/store/notifications.ts`（store）+ `packages/web/src/components/NotificationCenter.tsx`（UI）。

### 5.1 加一条通知

```ts
push(input: PushInput): string | null
```

- `PushInput`（`notifications.ts:135-143`）：`{ kind: NotificationKind; key: string; title: string; body?: string; conversationId?: string; taskId?: string; now?: number }`
- 返回新条目的 `id`；**`key` 已存在时返回 `null`**（`notifications.ts:189`）——调用方据此判断「是否真的新增了」（`lib/messageNotify.ts:33-40` 就是这么用的）
- 空 `key` 或 `title` 单行化后为空 → 返回 `null`，不入库（`notifications.ts:187-188`）
- 新条目 `read: false` 且前插（`notifications.ts:201`）
- `kind` 联合（`notifications.ts:40`）：`"message" | "task" | "approval" | "staff"`。**未知 kind 会在读盘时被丢弃**（`normalizeNotification` 白名单 `notifications.ts:82-89`），所以新增 kind 必须同时改三处：联合类型、读盘白名单、`KIND_LABEL`（`NotificationCenter.tsx:31-38`）

### 5.2 带跳转

字段只有两个：`conversationId`（跳会话）与 `taskId`（跳任务区并选中）。跳转分派在 `NotificationCenter.tsx:74-86` 的 `jump()`：

```
staff            → useUiStore.setPage("staff")
task + taskId    → useUiStore.focusTask(taskId, conversationId)
有 conversationId → useUiStore.openConversation(conversationId)
```

点击时先 `markRead(item.id)` 再收起面板（`NotificationCenter.tsx:75-76`）。**没有通用的 `page` 字段**——要跳到自动化页只能新增 UI store 意图（见 §4-(d)），不能靠塞一个假的 `taskId`。

### 5.3 去重

- 机制：`if (get().items.some((n) => n.key === key)) return null`（`notifications.ts:189`）——**只比对当前内存中的 items**。
- 三个已知缺口：① 超过 50 条被淘汰后，同 key 可再推；② `clearAll()`（`notifications.ts:232`）之后同 key 可再推；③ 面板内单条删除（`remove`，`:220-224`）后同 key 可再推。所以 key 必须**天然唯一到「这一次事件」**，例如 `message:<id>`（`messageNotify.ts:35`）、`task:<id>:<status>`（`ChatPage.tsx:1178`）、`approval:<requestId>`、`staff:<runId>`。自动化失败应照此写 `automation:<taskId>:error:<lastRunAt>`。
- 反例（会咬人）：用 `automation:<taskId>:error` 固定 key，则「第一次失败提醒过，第二次失败静默」。

### 5.4 上限与淘汰

- 条数 `MAX_NOTIFICATIONS = 50`，标题 60 字、正文 200 字（按码点截断，不劈 emoji，`notifications.ts:24-29,66-70`），单键 64KB（`:29`）。
- `pruneNotifications`（`:106-119`）：按 `createdAt` 降序取前 50，再按 UTF-8 字节回退 `pop()`；仍超限返回空数组。
- 写盘走 `persist`（`:177-181`）先 prune 再 `writeJson`；`readNotifications`（`:122-129`）读盘时也 prune。

### 5.5 测试怎么断言

- `lib/messageNotify` 等调用方：断言 `push` 返回值非 null、`unreadCount` 变化、`readNotifications(storage)` 落盘条数（`notifications.test.ts:89-104`）。
- 面板行为：`screen.getByRole("button", { name: "通知中心 1 条未读" })` 开面板 → `getByRole("button", { name: "打开通知：<标题>" })` 点击 → 断言 `useUiStore.getState().page` / `activeConversationId`（`NotificationCenter.test.tsx:59-86`）。
- 新 kind 的落盘读回：照 `notifications.test.ts:180-192`（staff 的那条）。
- 注入存储：`setNotificationStorage(createMemoryStorage())` + `beforeEach` 里 `useNotificationStore.setState({ items: [] })`（`notifications.test.ts:18-24`）。

## 6. 测试与门禁约定

### 6.1 命令

| 用途 | 命令 | 备注 |
| --- | --- | --- |
| 整轮门禁 | `pnpm -r build && pnpm -r --workspace-concurrency=1 test` | 全绿才提交（`docs/HANDOFF.md:158`） |
| 单包测试 | `pnpm --filter @heming/web test` | 等于 `vitest run`（`packages/web/package.json` scripts） |
| 单文件 | `cd packages/web && npx vitest run src/lib/automation/store.test.ts` | **必须 cd 进 `packages/web`**，见 §7-13 |
| 类型 | `pnpm --filter @heming/web typecheck` | `tsc -p tsconfig.json --noEmit` |
| 版本 | `node scripts/bump-version.mjs auto feature` | 五包同步（`docs/VERSION-MANAGEMENT.md:48-76`） |
| 更新日志 | `node scripts/build-changelog.mjs` | 忘了会被 `changelog-sync.test.js` 抓 |

**本机实测（2026-11-03，只跑单文件，未跑全量）**：
- `cd packages/web && npx vitest run src/lib/automation` → 4 文件 / 32 例全绿，4.09s（`environment 7.65s` 为并行批耗时，墙钟 6.0s）
- `npx vitest run src/components/AutomationPage.test.tsx src/store/notifications.test.ts src/components/NotificationCenter.test.tsx` → 3 文件 / 36 例全绿，1.40s（墙钟 3.0s）
- 全量 web 现有 **159 个测试文件**（`find packages/web/src -name "*.test.ts*"`）；`docs/HANDOFF.md:27` 记录 d.47 时 144 文件 / 2262 例。按单文件 1–6 秒外推，全量 web 并行约 **1.5–3 分钟**、`--no-file-parallelism` 串行约 **4–6 分钟**，`pnpm -r build`（tsc + vite）另计。**此数为外推，本轮按要求未实跑全量**。

### 6.2 配置与目录

- `packages/web/vite.config.ts` 的 `test` 段：`{ environment: "jsdom", globals: true, setupFiles: ["./src/test-setup.ts"] }`。**没有** `maxWorkers`。
- `packages/web/src/test-setup.ts` 只补 jsdom 缺件：`crypto.subtle`（webcrypto）、`Blob.prototype.arrayBuffer`、`URL.createObjectURL/revokeObjectURL`、`Element.prototype.scrollIntoView`。自动化测试不依赖这些，但同批跑不受影响。
- 测试文件与源码同目录：`*.test.ts` / `*.test.tsx`。自动化子系统 5 个测试文件：`model.test.ts`(11)、`store.test.ts`(9)、`runner.test.ts`(6)、`scheduler.test.tsx`(6)、`AutomationPage.test.tsx`(10)。

### 6.3 本仓怎么写测试（读 6 个文件后的归纳）

1. **中文用例名，describe 用「模块 · 主题」**：`describe("自动化 store · 增删改")`、`describe("useNotificationStore")`、`describe("通知中心面板")`；`it` 是一句中文行为断言，如「beginRun 串行保护；finishRun 记录结果并顺延下次」。
2. **不 mock 模块**：159 个 web 测试文件里只有 22 个用到 `vi.mock`，自动化 4 个文件**一个都没有**。依赖用「注入」而非替换：
   - 存储：`setAutomationStorage(createMemoryStorage())` / `setNotificationStorage(...)` / `setTaskStorage(...)`，`afterEach` 复原 `null`（`store.test.ts:50-60`、`notifications.test.ts:18-24`）；
   - 桌面桥：直接往 `window.__heming_infohub` 挂假对象，`afterEach` `delete`（`runner.test.ts:33-73,95-97`）；
   - zustand 状态：`useXStore.setState({...})` 直接灌初值（`scheduler.test.tsx:53-65`）。
3. **时间**：本地时间用 `function at(y,m,d,h,min)` 构造（`store.test.ts:18-20`、`model.test.ts:20-22`），不用 ISO 字符串以免时区漂移；调度器用 `vi.useFakeTimers()` + `vi.setSystemTime(new Date(2026,10,1,8,0,0))` + `await vi.advanceTimersByTimeAsync(...)`（`scheduler.test.tsx:68-79,86`），`afterEach` 恢复真实计时器。
4. **组件查询**：`@testing-library/react` 的 `render` / `fireEvent` / `waitFor` / `within`；优先 `getByRole` + `aria-label` 全等（`getByRole("button", { name: "立即运行 夜间归档" })`），文案断言用正则（`screen.findByText(/「夜间归档」已跳过/)`）。**改 aria-label 或页内提示文案会直接打红**。
5. **每个含存储的测试文件都 `beforeEach(() => localStorage.clear())`**（`runner.test.ts:89-93`、`AutomationPage.test.tsx:54-58`），因为 `createDefaultStorage()`（`storage.ts:60-72`）会真用 jsdom 的 localStorage。
6. **护栏用例带注释说明红线**：`runner.test.ts:7-10` 的文件头注释、`scheduler.test.tsx:8-11` 都直接写「绝不借桥的 call() 自动拉起 Python」——新增能力时应延续这个习惯，让红线在测试里可读。

## 7. 风险与坑清单

1. **配额是同一个桶，写失败静默**。localStorage 同源约 5MB（`lib/storageUsage.ts:22` 的保守默认），而 `writeJson` 超限/配额满只返回 `false`（`storage.ts:95-114`），调用方全部忽略（`store.ts:58-60`）。后果：任务创建在界面上成功、刷新后消失。运行记录若塞进 `heming.automations.v1`（256KB）会把这个风险放大一个数量级——**必须独立键**。
2. **字节上限是 UTF-8 字节，不是字数**。`utf8Length` 按字节算（`storage.ts:33-36`），中文一字三字节；`MAX_DETAIL_CHARS=160` 的中文详情约 480 字节，50 条运行记录就吃掉 24KB。设计上限时按「字节」而不是「条数」估。
3. **写盘顺序与「不静默丢」**。`tasks/store.ts:581-597` 的既有取舍是「先推通知、再落盘」；`store.finishRun` 现在是「先写 tasks、再 set」。运行记录与通知加进来后，顺序错了会出现「记录写了、任务没更新」或「通知推了、记录丢了」，建议在 `finishRun` 内固定顺序：计算 outcome → 写 runs → 推通知 → persist tasks → set。
4. **页面卸载丢状态**。`notice`/`error` 是组件 `useState`（`AutomationPage.tsx:81-82`），切页即丢；`runningId` 是全局的所以「运行中」还能看见，但「上一次立即运行的结果」会消失。做运行记录恰好能治这个，但别指望页面 state 承载任何需要跨页存活的信息。
5. **并发与执行权锁是全局单槽**。`beginRun` 只有一把锁（`store.ts:171`），`sync` 的桥超时是 30 分钟（`packages/desktop/infohub-bridge.js:44-49`）。长同步期间：调度到点的任务等下轮（`scheduler.ts:30` 早退），页面上所有「立即运行」按钮被禁用（`AutomationPage.tsx:274` 用 `disabled={Boolean(runningId)}`）。加「重试」后这条更紧——建议同步把 `runningSince` 用起来，在页面上显示「已运行 N 分钟」。
6. **桌面端 / 浏览器分支**。`isInfohubAvailable()` 只查 `window.__heming_infohub`（`client.ts:227-229`）；浏览器端调度器直接 return（`scheduler.ts:20`）**不消耗计划**，页面给提示条（`AutomationPage.tsx:149-153`）。新增功能（例如手动「测试连接」）必须保持这条分叉，且浏览器端不能出现「看起来能跑」的按钮。
7. **时间相关测试必须用 fake timers**。`scheduler.test.tsx:69-70` 同时设了 `useFakeTimers` 与 `setSystemTime`；若重试用 `setTimeout`，测试必须 `advanceTimersByTimeAsync` 而不是真实等待，否则会挂在 5s 默认超时。反过来，`nextRunAt` 的断言依赖本地时区（`model.test.ts:50-64` 用 `new Date(2026,10,2,...)` 并显式断言 `getDay()===1`）——在 CI 时区不同的机器上，只要用 `new Date(y,m,d,...)` 构造就一致，别改成 UTC 字面量。
8. **通知去重会「吃掉」第二次失败**。机制只在内存 items 里查 key（`notifications.ts:189`），且 50 条上限淘汰、清空、单条删除都会让同 key 再次可推。key 必须带本次运行的标识（建议 `lastRunAt`）。
9. **运行记录无限增长 / 孤儿记录**。必须条数 + 字节双淘汰（照 `pruneRuns`，`lib/staff/model.ts:738-754`）；且 `store.remove`（`store.ts:147-152`）要级联删记录。d.29 的教训就摆在那：删条目不清账本，孤儿白占容量、把有效数据挤掉（`HANDOFF.md:65`）。
10. **`nextRunAt` 顺延语义会被重试悄悄破坏**。`finishRun` 无条件 `nextRunAt = nextRunAt(schedule, now)`（`store.ts:188`）意味着「下次时间 = 本次结束时间 + 周期」，而 `rescheduleMissed` 又只认 `nextRunAt`（`store.ts:203`）。重试若也写 `nextRunAt`，就会出现「重试被顺延吃掉」或「启动时把重试当补跑执行」两种坏结果（后者直接破 R3）。必须用独立 `retryAt`，并在 `setEnabled`/`update`/`rescheduleMissed` 三处同步清理。
11. **i18n 与文案耦合**。全站中文、无 emoji（`HANDOFF.md:160`），状态胶囊用配色区分（`AutomationPage.tsx:35-40`）。同时**文案就是测试断言**：`AutomationPage.test.tsx:89` 断言 `"请填写任务名称"`、`:167` 断言 `/「夜间归档」已跳过/`、`:116` 断言名称默认 `"重扫日程"`。改文案必须同步改测试，这是本仓的既定代价。
12. **无障碍契约**。弹窗必须 `role="dialog"` + `aria-modal` + `useModalA11y`（`AutomationPage.tsx:444-455,389`），通知面板是**非模态**特例（`aria-modal="false"` + `blockBackground:false`，`NotificationCenter.tsx:53-55,127-131`）。列表按钮全部带 `aria-label="动作 + 任务名"`（`AutomationPage.tsx:273,282,290,298`），新增按钮沿用；`role="radiogroup"` / `role="radio"` + `aria-checked` 用于触发方式（`:541-583`），`aria-pressed` 用于星期（`:615`）。
13. **不要在仓库根跑 vitest**。实测：在 `D:\Heming` 直接 `npx vitest run src/lib/automation` 会拿到错误配置/错误根目录（8 文件 / 64 例里 24 例假红，且报错点落在 `afterEach` 而非真实断言）；`cd packages/web` 后同一条命令 4 文件 32 例全绿。另外仓库存在 `.claude/worktrees/team-system/` 这份**更高版本的并行检出**（d.64 口径，含自己的 `automation/` 同名目录与 HANDOFF），搜索/改文件时务必确认路径在 `D:\Heming\packages\web` 而不是 worktree。
14. **门禁的环境噪音**：`docs/HANDOFF.md:158` 记录 web 应串行跑（`--no-file-parallelism`）、server 与 web 并发时 Windows 偶发 `0xC0000409`；失败**先单跑该包确认**，别默认是代码回归。

## 8. 建议的一轮落地范围

排序依据：价值 / 风险。三个方案都假定先写一篇新规格（含 §2.3 的口径改写）。

### 方案 A · 最小（1 天级）

内容：
1. `lib/storageUsage.ts:56-77` 登记 `{ prefix: "heming.automations.", module: "自动化" }`（1 行 + 1 条测试）；
2. `store.finishRun` 里对 `status==="error"` 推一条 `kind:"task"` 的通知，key = `automation:<taskId>:error:<lastRunAt>`（不改通知联合类型、不改 UI）；
3. `AutomationPage.tsx` 页内提示补「存不下时只保留在本次会话」的诚实说明（对应 `writeJson` 返回 false）。

价值：把「失败没人知道」这条最低限度补上；风险几乎为零（不新增键、不动红线）。
缺点：点开通知会跳到任务区（语义不对）；仍然没有运行历史；失败通知的详情只有 160 字的一行。

### 方案 B · 推荐（3–4 天级）

内容 = 方案 A + 以下三块：
1. **运行记录**：新增 `lib/automation/runs.ts`（键 `heming.automations.runs.v1`，30–50 条 / 128–192KB，双淘汰，照 `lib/staff/model.ts:12,16,18,738-754` 与 `lib/staff/store.ts:63-70,81-84,107-115`）+ `store.finishRun` 写入 + `store.remove` 级联删 + `AutomationPage.tsx` 任务卡「运行记录」展开区（照 `StaffPage.tsx:89,428-449`）；
2. **失败通知升级为专属 kind**：`notifications.ts:40,82-89` 加 `"automation"`、`NotificationCenter.tsx:31-38` 加标签、`jump()` 加分支、`store/ui.ts` 加 `automationFocusId` 与清理、页面消费后滚动定位并把记录区展开；
3. **动作注册表**：新增 `lib/automation/kinds.ts` + `actions.ts`，改 `model.ts:144,147-150,202,214,287-293,310-318`、`runner.ts:87-89`、`AutomationPage.tsx:482-495,497`，**行为等价重构**（只有两个动作、UI 不变）；这是为后续动作扩展付的一次性成本，越晚做越贵。

不包含：每任务重试策略（撞 R2，需要产品拍板 + 改 HANDOFF:250）、取消/超时、运行记录导出、系统通知。

理由：
- 三件事正好覆盖「用户最缺的三块可见性」：失败看得见（通知）、历史查得到（记录）、以后加动作不用改 6 个地方（注册表）；
- 全部改动都在 `packages/web` 内、不碰桥/Python/服务端，符合 R6/R7/R8；
- 测试增量可控：预计 +20–28 例（runs normalize/prune/read 8–10、store 级联与写入 4–5、页面面板 4–5、通知 kind 与跳转 4–5、storageUsage 1、注册表等价性 2–3）；
- 现有 48 例自动化用例里，只有 `store.test.ts:138-164` 需要注入通知/运行记录存储，其余靠「默认行为逐字不变」保持绿。

### 方案 C · 激进（1 周+）

内容 = 方案 B + 每任务重试策略（§4-(b) 全量）+ 运行超时看门狗（用起 `runningSince`，超时把锁记为 error 并推通知）+ 运行记录导出 JSON（照任务区导出，纯本机 Blob）。

代价与前提：
- 必须先改三份口径文档（spec 新篇 / `HANDOFF:250` / CHANGELOG 点名「重试边界变更」），并且要回答四个产品问题：手动运行是否重试、`skipped` 是否算失败、`runCount` 是否含重试、跨启动是否累计；
- 需要在 `store.finishRun` 里引入 `retryAt` 新字段并同步 `setEnabled`/`update`/`rescheduleMissed`/`scheduler.ts:32` 四处，回归面覆盖 `scheduler.test.tsx:145-161`（不补跑护栏）与 `runner.test.ts:105-115`（未连接不 spawn 护栏）——**这两条用例是红线本身的化身，任何重试实现都不能让它们变红**；
- 超时看门狗会把「桥的 30 分钟超时」变成「本地可配置超时」，需要论证不会造成「同一任务双跑」（主进程 sidecar 是进程复用 + id 配对，第二条命令会被排队或拒绝，但不能假定）。

### 推荐结论

走 **方案 B**，(a)(c)(d) 三条一次做完，(b) 只留扩展点（字段与收尾分流点，默认关闭），把红线口径变更留给下一轮单独决策。这样本轮交付的是「可见性 + 可扩展性」，不是「自动化的自动化」——后者会同时动到 R2 与 R3 两条已经写进交接文档的承诺，风险与收益不成比例。

补充（下一轮开工前必做）：本文档尚未登记到 `docs/INDEX.md`（按本次任务约定只写一个文件）；落地轮应补一行索引，并按 `VERSION-MANAGEMENT.md` 走 feature 位 +1 与 `build-changelog`。
