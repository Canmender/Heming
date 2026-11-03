# d.66 · 自动化执行内核：动作注册表 / 运行记录 / 失败感知

- 日期：2026-11-03
- 相关版本：d.65.2.25.0（main 基线）→ 本轮 d.66.2.25.0（原在 d.48 基线上编号 d.51，合入 main 时重编号）
- 涉及包：`packages/web`（自动化数据层、执行器、调度器、自动化页、通知中心、UI 意图、存储水位）
- 前置：d.47 自动化中心（`docs/superpowers/specs/2026-11-01-d47-automation-center.md`）、d.48 常驻幕僚的运行记录模板、d.45/d.46 信息中枢边车
- 调研输入：`docs/research/2026-11-03-n8n-engine-notes.md`（n8n 引擎一手源码调研）、`docs/research/2026-11-03-n8n-license-and-reuse.md`（许可边界）、`docs/research/2026-11-03-heming-automation-audit.md`（本仓扩展点审计，全文 `file:line`）
- 本文用途：给实施轮提供唯一口径。**本文第 12 节「已明确不做」是可引用的承诺，改动前先改本文。**

## 0. 问题

d.47 的自动化中心是一个**稳定的两动作定时器**：模型、执行器、调度器、store、页面五件套有 48 例测试护住，但三块能力缺口让它停在「能用」而不是「可信」：

1. **失败没人知道**。执行失败只把 `lastStatus/lastDetail` 写在任务卡上，用户不回到自动化页就永远看不见；通知中心全目录零引用（审计 §1）。同步是本机归档唯一的写入路径，失败静默意味着「以为同步了，其实一周没动」。
2. **历史查不到**。任务对象上只有一个结果槽位，新结果覆盖旧结果（`model.ts:31-34`）。「昨天那次失败为什么失败」「这次比上次慢多少」都无从回答；连续失败与偶发失败看起来一样。
3. **加动作要改六处**。动作是字面量联合 + 两处 if/else + 页面硬编码 option（`model.ts:8,144,202,214,287-293,310-318`、`runner.ts:87-89`、`AutomationPage.tsx:482-495`）。再多一个动作，这六处都要改，且没有一处能保证「新增动作忘了校验参数」不被漏掉。

顺带一个**已经存在的诚实性缺口**：`heming.automations.v1` 没有登记进存储水位表（`storageUsage.ts:56-77` 无该前缀），设置区的「本机存储」把自动化占用算进「其它」——用户排查看不到它。

## 1. 目标

把自动化从「定时器」升级成**执行内核**，交付三件可见物 + 一件工程物：

1. **动作注册表**：动作 = 注册项（元数据 + 校验 + 执行器），新增动作只加一个文件、不改分发与页面。
2. **运行记录**：独立键的环形历史（条数 + 字节双淘汰），每条含触发来源、耗时、状态与详情；任务卡内可展开查看、可清空、随任务删除级联。
3. **失败感知**：仅 `error` 推一条应用内通知（`kind:"automation"`），点通知跳到自动化页并定位到该任务、展开其运行记录。
4. **工程物**：自动化存储登记进水位表 + 页面把「存不下只保留在本次会话」的既有事实如实说明。

## 2. 非目标

- **不做失败自动重试**。d.47 的书面承诺（`docs/HANDOFF.md:250`「没有失败自动重试」、spec:64「不 spawn、不重试」）本轮**保持不变**；运行记录只负责让失败可见，不负责替用户重跑。
- **不做补跑**（R3 不变）：应用关闭期间错过的时刻仍然不执行。
- **不做取消 / 断点续跑 / 超时看门狗**：桥没有取消通道，超时看门狗需要先回答「同一任务会不会双跑」。
- **不做任意脚本 / 命令 / URL / 提示词任务**（R1 不变）：动作仍是白名单，参数仍是枚举/布尔。
- **不做工作流画布 / 连线 / 表达式引擎 / 条件分支**：那是产品形态变更，不是本轮优化。
- **不做运行记录导出、系统级通知、跨设备同步**：记录只在本机。
- **不引入 n8n 代码或依赖**（见 §13）。

## 3. 设计依据：向 n8n 学什么、不学什么

> 🧠 本节结论来自 `docs/research/2026-11-03-n8n-engine-notes.md` 的一手源码调研与
> `docs/research/2026-11-03-n8n-license-and-reuse.md` 的许可核对。**只借概念与语义，不复制代码**。

| n8n 的做法 | 它解决什么 | 本轮的移植形态 | 为什么不照搬 |
|---|---|---|---|
| 节点类型注册表（`INodeTypeDescription.properties` + `NodeTypes` 注册）：节点 = 一份描述 + 一个受控执行函数（`packages/workflow/src/interfaces.ts:3215`、`packages/cli/src/node-types.ts:101`） | 加一个节点不改引擎，UI/默认值/校验全部由描述驱动 | `AutomationAction` 注册表：`kind` → 元数据 + `run()`；`model` 只依赖纯数据 `kinds.ts`，`runner` 只依赖 `actions.ts` | 不引入 `displayOptions` 参数 DSL 与逐参数渲染；本仓参数形态是固定字段（`sync`），多一层 DSL 只是空转 |
| Execution 实体 + 执行数据两级清理：`EXECUTIONS_DATA_PRUNE`、maxAge 默认 336h、maxCount 默认 10000、软删后 1h buffer 再硬删、失败执行默认保留（`packages/@n8n/config/src/configs/executions.config.ts:114-180`、`packages/@n8n/db/src/repositories/execution.repository.ts:757-803`） | 执行历史不能无限长，又不能「一超限就全丢」 | 运行记录独立键 `heming.automations.runs.v1`，40 条 / 192KB 双淘汰；先按条数截断再按字节回退 | 单机 localStorage 只有 ~5MB 同源配额，按 n8n 的「1 万条 + 14 天」会直接顶爆；也没有软删/硬删/保护标记的存储层 |
| Error Workflow（失败触发专门流程 + `execution/workflow/trigger` 三段式错误上下文） | 失败要能被「另一条链路」感知 | 失败 → 应用内通知中心（`kind:"automation"`），带任务 id 与跳回意图 | 本机没有可编排的第二段执行体（不执行任意脚本），通知就是终点 |
| 手动 Retry（`retryOf` / `retrySuccessId`，对某次执行点「重试」） | 人判断值得再跑一次 | 沿用任务卡既有的「立即运行」，触发来源记为 `manual`，运行记录里能看出这次是手动还是定时 | 不做「从失败节点续跑」，本仓动作是原子整段 |
| 节点级重试：`retryOnFail` 默认关，开启后 `maxTries` 默认 3（硬夹 2–5）、`waitBetweenTries` 默认 1000ms（硬夹 0–5000），**不按错误类型分类**，`catch` 到什么都重试（`packages/core/src/execution-engine/workflow-execute.ts:1861-1872`、`:2397-2499`） | 偶发失败重试一次往往就好了 | **本轮不做**（见 §2 非目标）。若做，应采用它的「节点级 opt-in、默认关」形状 | 本仓的书面承诺是不自动重试；且「所有异常都重试」对写归档的 `sync` 不安全（写了一半的重试可能重复采集） |
| 调度：`nextRunAt` 一等字段 + misfire 策略（coalesce / skip）+ 触发时刻去重键（`packages/@n8n/scheduler/src/core/types/schedule.ts:86`、`materializer/misfire.ts:29`） | 关停/休眠后重新启动，错过的一批触发点怎么办 | 保持 d.47 语义：**skip（不补跑）**，启动时把过期的 `nextRunAt` 顺延 | `coalesce`（把多次错过合并成一次立即执行）等于事实上的补跑，与 R3 冲突 |
| 表达式引擎（Tournament 仍用 `new Function` 动态生成；真正无代码生成的是 `expressions/native-evaluation/` 闭集解释器） | 任意数据变换 | — **不移植** | R1 明确不执行任意脚本：任何「能写 JS」的表达式面都不属于本仓边界 |
| 队列模式 / worker / 凭据系统 / items 二维数据流 / 子工作流 | 多租户、分布式、批处理 | — **不移植** | 单机桌面 App：无队列、无 worker、无凭据进任务、单动作原子执行 |

移植时**刻意脱离** n8n 的类结构与命名（`INodeType`/`WorkflowExecute`/`execution_entity` 一律不出现），按本仓领域模型（任务 / 动作 / 运行记录）重写；理由见 §13。

## 4. 动作注册表

### 4.1 文件与依赖方向（防环）

```
kinds.ts   ← 纯数据（无 import）。kind 常量、元数据、类型守卫。
   ↑
model.ts   ← 任务模型/校验/归一/文案。只依赖 kinds.ts。
   ↑                    ↑
actions.ts            store.ts / scheduler.ts / 页面
（动作实现：run(task)）    ↑
   ↑                    │
runner.ts ──────────────（gating + 查表 + 错误归一）
```

- `kinds.ts` 不得 import 任何其他模块；`actions.ts` 可 import `model` 与 `infohub/client`；`runner.ts` 只做门禁、查表、异常归一，不再认识具体动作。
- `AutomationResult` 类型保持在 `store.ts`（`actions.ts` 用 `import type` 取，type-only 不形成运行时环）。

### 4.2 契约

```ts
// kinds.ts
export const AUTOMATION_KINDS = ["infohub.sync", "infohub.agenda"] as const;
export type AutomationKind = (typeof AUTOMATION_KINDS)[number];

export interface AutomationKindMeta {
  kind: AutomationKind;
  label: string;          // 任务卡/下拉框显示的动作名
  defaultName: string;    // 新建草稿的默认任务名
  hasSyncParams: boolean; // 是否显示同步参数面板并校验来源非空
  summary: string;        // 编辑弹窗里的一句话说明
}

// actions.ts
export interface AutomationAction {
  kind: AutomationKind;
  run: (task: AutomationTask) => Promise<AutomationResult>;
}
```

### 4.3 不变量

1. **行为等价**：本轮只有两个动作，用户可见文案逐字不变；`normalizeTask` 对旧数据的丢弃规则不变（未知 kind 仍丢弃，不放宽）。
2. **校验随动作走**：`infohub.sync` 的「至少一个来源」校验由 `hasSyncParams` 分支承载，不再散落在 `validateDraft` 与 `normalizeTask` 两处各写一遍。
3. **未知动作**：`getAction()` 返回 `null` → `result("error", "未知的自动化动作")`（文案不变）。
4. **页面从注册表渲染**：动作下拉与「是否显示同步面板」都查 `listKindMeta()`，不再有硬编码 option。

## 5. 运行记录

### 5.1 形状与键

```ts
export const AUTOMATION_RUNS_KEY = "heming.automations.runs.v1";
export const MAX_AUTOMATION_RUNS = 40;
export const AUTOMATION_RUNS_BYTE_LIMIT = 192 * 1024;

export interface AutomationRun {
  id: string;
  taskId: string;
  taskName: string;   // 快照：任务改名或删除后仍能读懂历史
  kind: AutomationKind;
  trigger: "schedule" | "manual";
  status: "ok" | "error" | "skipped";
  detail: string;     // 单行，≤ MAX_DETAIL_CHARS(160)
  startedAt: number;
  finishedAt: number;
  durationMs: number; // max(0, finishedAt - startedAt)
}
```

**为什么独立键**：`heming.automations.v1` 是 256KB 且被任务对象语义占用（每次改动都要整体重写）；把历史塞进去会让任务写入的序列化体积涨一个数量级，而 `writeJson` 失败是静默的（审计 §7-1）——宁可多一个键，也不要把「任务本身存不下」的风险放大。

**为什么任务名做快照**：历史是过去的事实，任务改名不该改写过去；删除任务后记录又被级联清掉，所以只在「改名未删」的窗口里起作用。

### 5.2 淘汰与读盘

- 双淘汰照 `lib/staff/model.ts` 的 `pruneRuns`：先按 `finishedAt` 降序截断到 40 条，再按 UTF-8 字节回退 `pop()`，仍超限返回空数组。
- 读盘逐条 `normalizeRun`，结构不符丢弃（缺 id/taskId、status/trigger 非法、时间非法）；`detail` 单行化截 160 字。
- `writeJson` 返回 `false` 时**保留内存态**、不抛错——与本仓既有惯例一致，但页面要如实说明「只在本次会话」。

### 5.3 写入时机与顺序

唯一写入点是 `store.finishRun`（调度与手动两条路径都收口在这里），顺序固定：

```
算 outcome → 写 runs（try/catch）→ 失败通知（try/catch）→ persist tasks → set
```

理由：本仓既定取向是「宁可多留痕，不可静默丢」（`tasks/store.ts` 先推通知再落盘的同一取舍）；通知与记录都不能反噬任务落盘。

- `startedAt` 取 `runningSince`（`beginRun` 抢占时刻），不另存计时器。
- `trigger` 由 `beginRun(id, now?, trigger)` 记入内存态；调度器传 `"schedule"`，页面「立即运行」传 `"manual"`。
- `runCount` 语义**不变**：仍表示「累计收尾次数」，不论 ok/error/skipped、不论手动/定时。

### 5.4 生命周期

- 删除任务 → 级联删除该任务的全部记录（页面删除确认文案已经承诺「运行结果也会一并移除」）。
- 清空历史 → 页面「清空运行记录」走 `ConfirmDialog` 二次确认，清空全部任务的记录。
- 记录**不参与**任何导出、不上云、不进消息库。

## 6. 失败感知

### 6.1 通知

- 仅 `status === "error"` 推一条；`ok` 与 `skipped` **不推**（未连接时每个周期都会 skipped，推了就是刷屏）。
- `kind: "automation"`，`key: automation:<taskId>:error:<finishedAt>`——**时间戳必须进 key**：通知去重只比当前内存 items，50 条淘汰/清空/单条删除后同 key 可再推；固定 key 会让「第二次失败」静默。
- 标题 `「<任务名>」执行失败`，正文 `detail`（已截 160 字），`automationId: taskId`。
- **只做应用内通知**，不做系统通知：同步失败不是「用户不在电脑前」的消息，系统吐司会变成骚扰（与 d.39 的取舍不同，那条是别人发来的消息）。

### 6.2 跳转与定位

- 通知中心点开 `kind:"automation"` → `useUiStore.focusAutomation(taskId)` → 切到自动化页 + 设 `automationFocusId`。
- 自动化页消费焦点：滚动到该任务卡、展开运行记录、短暂高亮，然后 `consumeAutomationFocus()`。
- 清理口径与 `taskFocusId` 一致：`setPage` / `openConversation` / `focusTask` / `openInfohub` 都要清，漏一处就会在别的页面残留高亮。

## 7. 调度与红线（不变项）

以下语义**逐字保持**，任何实现都不得让对应护栏用例变红：

| # | 语义 | 现有护栏 |
|---|---|---|
| R1 | 动作白名单，不执行任意脚本/命令，任务不含密钥 | `runner.test.ts` 桥调用断言 |
| R2 | **不自动重试**、失败不重排 | `scheduler.test.tsx` 到点执行一次后顺延 |
| R3 | **不补跑**：启动时已到点只顺延 | `scheduler.test.tsx` 启动前已到点用例 |
| R4 | 未连接信息中枢只记 `skipped`，**绝不自动拉起边车** | `runner.test.ts` 未连接不 spawn |
| R5 | 15s 轮询、全局单槽串行、只在桌面端且登录后挂载 | `scheduler.test.tsx` 串行/浏览器分支 |
| R6 | 数据只在本机，不上云、不导出 | 无网络调用；新键不进任何导出路径 |

新增能力对调度语义的唯一影响：`beginRun` 多一个可选 `trigger` 参数（默认 `"schedule"`，等价于旧行为），`finishRun` 的调用点不变。

## 8. 页面与交互

1. **任务卡**（不改变既有布局与 aria-label）：上次结果一行保留；新增「运行记录（N）」展开按钮，展开后按时间倒序列出最近记录（每条：状态胶囊、时间、耗时、触发来源「定时/手动」、详情一行）。
2. **空态**：无记录时写「还没有运行记录」，不给假数据。
3. **记录操作**：任务级「清空记录」+ 全局确认；删除任务时确认文案已含级联语义，不再额外提示。
4. **焦点定位**：由通知跳入时高亮任务卡并展开记录；`aria-label` 保持「动作 + 任务名」形态。
5. **浏览器分支**：仍可创建/查看/看历史，到点不执行、不消耗计划；新增的控件在浏览器端不得出现「看起来能跑」的误导。
6. **诚实说明**：页面写明「记录只存本机，最多 40 条；存不下时只在本次会话可见」。

## 9. 数据与迁移

| 键 | 变化 | 旧数据 |
|---|---|---|
| `heming.automations.v1` | 形状不变（`lastRunAt/lastStatus/lastDetail/runCount` 全保留） | 直接可读，无需迁移 |
| `heming.automations.runs.v1` | 新增 | 缺键 → 空数组 |
| `heming.notifications.v1` | 新增可选 `automationId` + 新 kind | 旧条目照读；旧版本读到新 kind 会丢弃该条（可接受的降级） |
| `heming.ui`（无持久化） | 新增 `automationFocusId` | 内存态，不落盘 |

**降级语义**：不降级版本（旧客户端）读新 `heming.automations.v1` 不受影响（没有新字段）；通知里的 `automation` 条目在旧版本会被读盘白名单丢弃——不报错，只少一条历史通知。

## 10. 测试计划

| 层 | 用例（中文名） | 数量目标 |
|---|---|---|
| `kinds.test.ts` | 元数据完备；未知 kind 被拒；每个 kind 的 `hasSyncParams` | 3–4 |
| `model.test.ts` | 既有 11 例保持；注册表等价性（动作名/默认名/校验文案） | +2 |
| `runner.test.ts` | 既有 6 例保持；未知动作返回 error（不触桥） | +1 |
| `runs.test.ts` | normalize 丢弃；条数淘汰；字节淘汰；读盘回退；前插去重；按任务删；清空 | 8–10 |
| `store.test.ts` | 既有 9 例保持；finishRun 写记录（trigger/耗时/任务名）；error 才推通知且同次失败只一条；skipped 不推；删除级联 | +5 |
| `AutomationPage.test.tsx` | 既有 10 例保持；展开记录；空态；清空确认；焦点定位 | +4 |
| `NotificationCenter.test.tsx` | automation 通知跳转并设 `automationFocusId` | +1 |
| `store/notifications.test.ts` | automation kind 落盘读回；未知 kind 仍丢弃 | +2 |
| `storageUsage.test.ts` | `heming.automations.*` 归「自动化」 | +1 |

**红线护栏不动**：R2/R3/R4 三条用例必须原样通过，且新增测试不得依赖真实计时器（调度用 fake timers）。

## 11. 验收形态

1. 新建/编辑任务的动作下拉来自注册表；新增一个动作只需加 `kinds.ts` 一条元数据 + `actions.ts` 一个注册项（本轮不新增，以此作为可扩展性的验证标准）。
2. 定时与手动各跑一次 → 运行记录出现两条，`trigger` 正确、耗时 > 0、任务卡上次结果不变。
3. 制造失败（断开信息中枢后改配置触发 error，或桩掉 `callInfohub`）→ 通知中心出现一条「自动化」通知；再失败一次 → 第二条（key 带时间戳）；`skipped` 不产生通知。
4. 点通知 → 跳到自动化页、目标任务高亮、记录已展开。
5. 删除任务 → 该任务记录消失；清空记录 → 二次确认后全清。
6. 设置区「本机存储」出现「自动化」分组。
7. 全量门禁绿：`pnpm -r build && pnpm -r --workspace-concurrency=1 test`。

## 12. 已明确不做（可引用承诺）

- **失败自动重试**：不做。要做得先回答四个产品问题（手动是否重试、skipped 算不算失败、runCount 是否含重试、跨启动是否累计），并改写本文 §7 与 `docs/HANDOFF.md` 边界段——**单独立轮**，不与本轮混做。
- **取消 / 断点续跑 / 超时看门狗**：不做。桥没有取消通道；看门狗要先证明不会双跑。
- **运行记录导出 / 系统通知 / 跨设备**：不做。
- **工作流画布、表达式、条件分支、子流程**：不做（产品形态变更）。
- **把 DAG/队列/worker 引进来**：不做（单机桌面 App，无分布式需求）。

## 13. 来源与许可

本能力的**设计思路**参考了 n8n 项目的公开文档与源码语义，**未使用其源代码**。

- 参考项目：n8n（https://github.com/n8n-io/n8n），调研版本 monorepo 2.46.0，commit `bb832f106c9c`（2026-11-03）
- 参考主题与页面：
  - 节点类型注册：https://docs.n8n.io/workflows/components/nodes/
  - 执行记录与数据保留：https://docs.n8n.io/hosting/scaling/execution-data/
  - 错误处理与错误工作流：https://docs.n8n.io/flow-logic/error-handling/
  - 重试（节点级 `retryOnFail`）：https://docs.n8n.io/workflows/components/nodes/#node-settings
  - 手动重跑与执行历史：https://docs.n8n.io/workflows/executions/
- 对方许可证：Sustainable Use License 1.0（https://github.com/n8n-io/n8n/blob/master/LICENSE.md）。该许可**不授予**我们复制其代码、或在商业产品中分发其代码的权利；本项目也**不引入**任何 n8n 包或源码。
- 我们的实现方式：独立实现。仅借鉴不受版权保护的概念与行为语义（「动作=注册项」「执行记录按条数/字节双阈值修剪」「失败触发独立处理流程并携带结构化上下文」「人可以对失败执行手动重跑」），未复制、未逐行改写其源码。
- 许可证影响：本实现为和鸣自有代码，按本仓库许可证发布，不受 SUL 约束。
- 记录人 / 日期：Lead / 2026-11-03

## 14. 风险与回滚

| 风险 | 处置 |
|---|---|
| 运行记录写不下（配额） | 独立键 + 192KB 上限 + 双淘汰；写失败保留内存态；页面如实说明 |
| 孤儿记录（任务删了记录还在） | `remove()` 级联；另有全局「清空记录」 |
| 通知刷屏 | 只 error 推、key 含时间戳（同一次失败只一条）、skipped 不推 |
| 失败通知拖垮执行链条 | 通知与记录都包 try/catch，且在任务落盘之前 |
| 页面卸载丢状态 | 需要跨页存活的信息一律进 store/键，不依赖组件 `useState` |
| 焦点意图残留 | 四处清理口与 `taskFocusId` 同口径 |
| 加动作时忘了校验 | 校验由注册表元数据驱动，未知 kind 在读盘与分发两处都被拒 |

**回滚**：本轮不改旧键形状，回退版本即回到 d.48 行为；新键 `heming.automations.runs.v1` 会被旧版本忽略（不读、不删），通知里 `automation` kind 会被旧版本读盘丢弃。
