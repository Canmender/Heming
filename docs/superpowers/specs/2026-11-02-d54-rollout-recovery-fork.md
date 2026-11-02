# d.54 · 回合日志的回放、恢复与分叉（规格，未开工）

- 日期：2026-11-02
- 状态：**规格，未动代码**
- 编号说明：按 d.54 编号；撞号顺延，内容不受影响。
- 依赖面：`lib/rollout/{types,log}.ts`（数据模型与版本）、`components/RolloutTimeline.tsx`（入口）、`lib/tasks/store.ts`（`streamId` 绑定）、`lib/agentStream.ts`（分叉时的续跑入口）。**不改**服务端、不改消息协议、不改 E2E。

---

## 0. 这一轮要解决什么

d.50 把回合过程记进了本机日志，d.51 给了只读面板。现在能做的是"看"，**不能"用"**：

- 一次任务跑到一半崩了 → 日志还在，但只能看，不能接着做；
- 某一步结果不对想换个说法重来 → 只能整段重发，前面几步白跑；
- 想复盘"如果第 3 步换个工具会怎样" → 没有入口。

这一轮把日志从**证据**变成**可操作的对象**，但要把三件事分清楚——它们风险完全不同，混在一起做必然出事。

---

## 1. 三个动作，先定义清楚

| 动作 | 含义 | 是否调模型 | 是否可能有副作用 | 本轮态度 |
|---|---|---|---|---|
| **回放**（replay） | 把已记录的 item 按时间重新展示一遍，可逐步展开 | 否 | 无 | 做（增强现有面板） |
| **重跑**（rerun） | 用同一个 `userText` 从头再执行一次，新 `streamId` | 是 | 有（可能重复写操作） | 做，但必须显式确认 |
| **分叉**（fork） | 从第 k 个 item 之后接着执行，复用前序工具结果 | 是 | **有，且容易重复** | 做，限定条件（见 §5） |

**不做「断点续跑」（resume mid-turn）**。理由在 §4，这是本规格最重要的一个否定结论。

---

## 2. 已核实的事实

### 2.1 日志里到底有什么

`lib/rollout/types.ts` 定义五种 item：`turn_start`（含 `conversationId/streamId/agentId/userText`）、`tool_call`（`id/name/args`）、`tool_result`（`id/name/ok/denied/text`）、`assistant_final`（`text`）、`turn_end`（`status: ok|aborted|error`）。

写入点在 `agentStream.ts`：`turn_start` 在每个 mention 开始时、`tool_call` 在调用前、`tool_result` 在结果回来后、`assistant_final` 与 `turn_end` 在收口处（成功、部分成功、失败、无绑定、读历史失败五条路径都覆盖）。

**注意**：日志里**没有** `tool_call` 与 `tool_result` 的配对校验，也没有序号——只有一个 `at` 时间戳。崩溃发生在两者之间时，日志会留下一个"有调用、没结果"的悬空记录。§6 的数据模型要补这个洞。

### 2.2 存储与上限

`lib/rollout/log.ts`：单回合 200 条、单条文本 2000 字符、最多 20 个回合、写入失败静默（返回 `false`）。键是 `heming.rollout.v1.<streamId>`，索引键 `heming.rollout.v1.index`。

**这意味着**：日志是**有损**的（文本截断、条数封顶、旧回合淘汰）。任何"用日志完整重建一次执行"的想法都要先接受这个前提——重建出来的是**摘要级过程**，不是完整 transcript。

### 2.3 消息在哪、日志在哪

- 消息：服务端存储 + 端到端加密（服务端只见信封），本机有明文缓存；
- 日志：纯本机 `localStorage`，**不上行、不进消息、不进导出**。

所以日志**不是**消息的副本，它记录的是"编排层视角的过程"。分叉时不能拿日志去重写服务端消息，只能**新产生**消息。

### 2.4 任务与回合的关联

`lib/tasks/store.ts:83` 的 `TaskRecord.streamId` 把任务与回合绑起来；`bindStream` 在触发时写入。只有从任务区发起的执行才有这个绑定——普通聊天流不建日志、不在任务区出现。这一条是入口的边界，不改。

---

## 3. 回放（replay）：把现有面板做成"可读的录像"

现状（`components/RolloutTimeline.tsx`）：时间线、类型标签、成功/失败/被拒三色、明细折叠、运行中 2 秒刷新、最多 60 条。

**增强项**（都很小）：

1. **相对时间**：每条显示「距开始 +3.2s」，排查时序问题时比绝对时钟直观；
2. **按类型筛选**：只看工具调用 / 只看失败；
3. **成对高亮**：鼠标停在一条 `tool_result` 上时，高亮对应的 `tool_call`（靠 `id` 配对）；
4. **异常标注**：悬空的 `tool_call`（无结果）与缺失 `turn_end` 的回合，用琥珀色标出「未完成」——这是崩溃的唯一证据，不能被当成正常结束；
5. **导出本回合 JSON**：单条按钮，便于附到 issue 里。**不改**会话导出的口径（会话导出仍只含消息）。

验收：一个崩溃回合能被明确标成「未完成」，并指出停在哪一步。

---

## 4. 为什么不做「断点续跑」

断点续跑 = 从"某个工具刚执行完"的状态接着采样。听起来很自然，实际有三个硬问题：

1. **状态不在日志里**。续跑需要的是完整 `extra`（assistant 的 `tool_calls` + 对应的 `tool` 消息）+ 当时的系统提示词 + 历史切分结果。日志只记了 `args` 与 `text`（还都被截断到 2000 字符），**不足以重建一次合法请求**。
2. **重复副作用不可避免**。用户以为"接着跑"是接上，实际是**再跑一遍**后面的步骤——如果后面是写文件、发消息，就会重复执行。日志里没有任何"这一步是否已生效"的标记。
3. **模型侧的因果链会断**。续跑要伪造一段 assistant 消息来"承接"之前的工具调用；一旦 `tool_call_id` 对不上或文本被截断，供应商直接 400，或者模型基于残缺上下文做出离谱决定。

**结论**：把"接着做"实现为**重跑**（rerun），并把话说清楚——"这会重新执行一遍，之前的写操作可能重复"。这比一个看起来能续、实际会重复执行的按钮诚实得多。

---

## 5. 分叉（fork）：唯一有价值的那半

分叉的价值在"换条路走"：前几步的工具结果还有用，但某一歩的结论不对，想换个方向继续。

### 5.1 语义

从**某个 `tool_result` 之后**分叉：复用该 result 及其之前的 `extra` 前缀，丢弃其后的内容，用新的 `streamId` 继续采样。

### 5.2 前置条件（缺一不可）

1. 该 item 之后**没有** `assistant_final`（已经给出答案的回合不必分叉，重跑更直接）；
2. 该 item 所在回合**有** `turn_end` 且 `status !== "error"`，或者用户明确知道这是崩溃回合；
3. 前缀里的每个 `tool_call` 都有配对的 `tool_result`（悬空即拒绝，§6）；
4. 前缀里**没有** `denied` 的调用（被拒的语义是"没执行"，拿去续跑会让模型以为执行过）。

### 5.3 副作用提示

分叉会**重新采样**，而**不会重放**前缀里的工具调用。这带来一个反直觉的组合：

- 前缀里的写操作已经真实发生过（不回滚）；
- 分叉后的新步骤可能再次写同一批文件。

所以入口按钮的确认文案必须写清这两句，并且**任务区要把分叉回合标记出来**（`streamId` 新增 `forkedFrom` 字段，见 §6）。

### 5.4 入口与禁用

- 入口放过程日志面板每条 `tool_result` 行的次要按钮「从此处分叉」；
- 运行时禁用条件：任务仍在 `running`；或该条之后已有写操作且用户未确认提示；
- 分叉后新建任务（继承原任务的目标与智能体，`forkedFrom` 指向原 `streamId`），避免污染原任务的汇总。

---

## 6. 数据模型改动（`ROLLOUT_VERSION = 2`）

```ts
interface RolloutItemV2 {
  seq: number;              // 新增：单调递增，用于配对与定位
  at: string;
  // ...既有字段
}

interface RolloutTurnStartV2 {
  // ...
  forkedFrom?: { streamId: string; seq: number };  // 新增：分叉来源
}
```

- **`seq` 是必须的**：没有序号就只能靠时间戳，而同一毫秒内的两条 item 顺序不确定，配对会错；
- 读取端兼容 v1：缺 `seq` 时用数组下标补齐（只读场景够用，分叉场景要求 v2，v1 回合的「从此处分叉」按钮置灰并说明原因）；
- 迁移不做批量重写：v1 日志到期自然淘汰（最多 20 个回合），不写迁移脚本；
- 提升 `MAX_ITEMS_PER_STREAM`？**不提升**。分叉只需要前缀，200 条够；提升反而加速 20 回合的淘汰。

另需一个**配对校验**纯函数 `pairToolCalls(items)`：输入 item 列表，输出 `{ pairs, danglingCalls, orphanResults }`。它同时服务回放标注（§3.4）与分叉前置条件（§5.2）——两处判定必须同源，否则会出现"面板说能分叉、点了却报错"。

---

## 7. 与消息存储的关系

- 回放**不写**任何消息；
- 重跑/分叉产生的是**新消息**（走既有 `agent_chunk` / `agent_finish` 链路、既有 E2E 封装），服务端不知道"这是分叉"，也不需要知道；
- 会话里是否需要一条系统提示「本回复从某步分叉」？**建议不加**：分叉是任务区的能力，用户在那里看到即可；往消息流里塞系统提示会污染对话，而且无法在 E2E 下安全表达（系统提示没有发送者身份）。

---

## 8. 失败与降级

| 情况 | 行为 |
|---|---|
| 日志缺失（旧版本 / 被清空） | 面板空态说明「只在本机记录、只从有日志能力的版本开始」；分叉入口不出现 |
| 版本不认识（未来版本写的日志） | 只显示条数与时间，提示「版本不兼容，无法回放」，不猜结构 |
| 悬空 `tool_call` | 标注「未完成」；分叉前置条件不满足 |
| 存储写满 / 配额异常 | 记录器已经静默返回 `false`；面板显示「本次未能记录」而不是假装有日志 |
| 分叉中途失败 | 与原回合失败同口径（finish-partial + agent_error），新任务标 `failed`，原回合不受影响 |

---

## 9. 测试矩阵

| 类别 | 用例 |
|---|---|
| 配对 | 正常成对、悬空调用、孤立结果、同一 `id` 重复出现 |
| 回放 | 相对时间、类型筛选、悬空标注、缺 `turn_end` 标未完成、导出 JSON 与面板一致 |
| 版本 | v1 日志可读不可分叉；未知版本只显示摘要 |
| 分叉前置 | 有 final 拒绝、悬空拒绝、含 denied 拒绝、正常通过 |
| 分叉执行 | 新 `streamId`、`forkedFrom` 正确、前缀 `extra` 被复用、新任务继承目标与智能体 |
| 副作用提示 | 前缀含写操作时确认文案必须出现那两句 |
| 隔离 | 分叉回合不修改原回合日志、不影响原任务汇总 |

---

## 10. 分阶段

| 阶段 | 内容 | 验收 |
|---|---|---|
| P0 | `seq` + `pairToolCalls` + 回放增强（相对时间/筛选/悬空标注/导出） | 崩溃回合被正确标注；导出可用 |
| P1 | 重跑（rerun）：一键用原 `userText` 新建任务，带副作用确认 | 确认文案到位，新任务可追踪 |
| P2 | 分叉（fork）：前置条件 + 前缀复用 + `forkedFrom` 标记 | 分叉后新回合日志首条带来源；原回合不变 |
| P3（待定） | 分叉前预览「将复用哪几条工具结果、将丢弃哪些」 | 用户能在点之前看清代价 |

---

## 11. 明确不做

- 跨设备回放 / 云端日志：本机明文过程不能上云，与 E2E 口径冲突；
- 自动重试（失败后自动重跑）：与"副作用可能重复"直接冲突，必须由人决定；
- 用日志重建完整 transcript：日志是有损的（§2.2），宣称能重建只会误导；
- 分叉后自动回滚前缀的写操作：没有撤销能力，也不该假装有。

---

## 12. 需要你先定的两件事（已在「全面升级」轮拍板）

1. **分叉落在哪** → **新建任务**。继承原任务的目标与智能体，`forkedFrom` 指向原 `streamId`；原任务的汇总、日志、状态一律不动。理由：分支结果与原任务的目标可能已经不同，混在一个汇总里会让「任务成功/失败」失去意义。
2. **重跑要不要保留原任务** → **保留**（留痕）。重跑生成新任务、新 `streamId`，原任务保持原状态；任务列表按时间自然分开，不覆盖、不合并。
3. **P3（分叉前预览「复用哪几条、丢弃哪些」）** → **做**。判据复用 `pairToolCalls` 的同一份结果，避免「面板说能分叉、点了却报错」。

---

## 13. 实施记录（d.56，负责人 rollout）

### P0 纯逻辑层（已完成，UI 待 React 19 落地后接）

- `lib/rollout/types.ts`：`ROLLOUT_VERSION = 2`；五种 item 统一带 `seq`（记录器分配）；
  `turn_start` 加 `forkedFrom: { streamId, seq }`；新增 `RolloutStreamView`（版本/条目/最后时间）。
- `lib/rollout/log.ts`：追加时分配单调递增 `seq`；读取端 v1 缺 `seq` 用数组下标补齐并强制递增；
  新增 `readStream()` 暴露版本与条数；未来版本**只报数不解析**，且拒绝向其追加（不覆盖看不懂的数据）。
  `MAX_ITEMS_PER_STREAM` 保持 200，不做批量迁移。
- `lib/rollout/pair.ts`（新）：`pairToolCalls` 输出 `{ pairs, danglingCalls, orphanResults }`
  （按数组序 + 同 id FIFO，重复 id 各配各的）；`turnCompletion` 给「缺 turn_end / 悬空调用」的未完成判定。
  回放标注与分叉前置条件共用这一份判定。
- `lib/rollout/fork.ts`（新）：`checkFork` 四条前置（有 assistant_final / 悬空 / denied / 未正常收尾，
  崩溃回合需显式 `allowCrashed`；v1 与未来版本直接拒绝）；`previewFork` 出 P3 的复用/丢弃/截断计数；
  `buildForkPrefix` 把前缀重建成合法请求形状（连续调用合成一条 assistant，跟等长同序 tool 消息，
  非法 JSON 或悬空的调用整条跳过）；`forkNoticeLines` 给诚实的确认文案。
- `lib/rollout/view.ts`（新）：相对时间（`+3.2s`）、四档类型筛选、悬停配对下标、单回合 JSON 导出
  （与会话导出**不合并**）。
- `lib/agentStream.ts`：`TriggerDeps` 新增 `forkedFrom`（写进 `turn_start`）与 `forkPrefix`
  （接在真实历史之后、参与 `prepareHistory`，置后以免被早期压缩吃掉）。
- `lib/tasks/store.ts`：`TaskRecord.forkedFrom`（含 `truncatedResults` 计数）持久化/导出；
  `taskForkNotice` 给任务卡与报告同一份诚实提示。
- 测试：rollout 62 例（配对 12 / 分叉 21 / 回放 14 / 日志 15）+ agentStream 分叉 2 例；新增 57 例。
  覆盖悬空调用、孤立结果、同一 id 重复、v1 无 seq、未知版本、有 final 拒绝、denied 拒绝、崩溃回合、
  「重建前缀喂给既有请求构造函数不抛且 tool_calls 与 tool 消息等长同序」。
- 遗留：UI（RolloutTimeline / TaskAreaPage / ChatPage 的分叉执行接线）与 P1 重跑、P2 分叉入口、P3 预览
  待 React 19 落地后实施；重跑按 §12.2 改为「新建任务 + 新 streamId，原任务不动」。

### P0 UI 增强（已完成）

`components/RolloutTimeline.tsx`：相对时间（`+3.2s`，绝对时钟留 `title`）、四档类型筛选、
悬停配对高亮、未完成横幅（缺 `turn_end` / 悬空调用，并指出停在哪个调用）、导出本回合 JSON、
每条 `tool_result` 的「从此处分叉」（禁用与否全由 `checkFork` 决定并显示原因）。
新增可选 props `version / onFork / running`；未传 `onFork` 时面板保持纯只读。
版本兜底：不传 `version` 且用本机日志时，组件自己用 `readStream()` 识别 v1 并置灰分叉。
用例：组件 18 例（原 8 → 新增 10）。

### P1 / P2 纯逻辑（已完成，UI 落点等 Tailwind 4 迁移后接）

- `lib/tasks/rerun.ts`（新）：`rerunNoticeLines()` 固定「会重新执行一遍」「之前的写操作可能重复」
  两句话 + 「原任务不变」；`canRerun`（运行中不可重跑）；`buildRerunPlan`（原样继承目标/智能体/会话）。
- `lib/tasks/store.ts`：新增 `rerun(taskId)` / `forkFrom(taskId, forkedFrom)`——**新建任务**、
  保留原任务；`reopen` API 保留但不再作为重跑入口。
- `lib/tasks/forkTask.ts`（新）：`buildForkTaskPlan` 组合 `checkFork` + `previewFork` + `buildForkPrefix`，
  产出新任务参数、`forkedFrom`（含 `truncatedResults`）、重建前缀、确认文案；前缀重建不出来
  （参数被截断/没有可复用结果）时拒绝，而不是拼一个必然 400 的请求。
- 用例：rerun 7 + forkTask 11 + store 新增 5（含「重跑/分叉后原任务 JSON 快照一字不差」、
  `forkedFrom` 落盘水合、导出带 `forkedFrom`）。

### P1 / P2 / P3 UI 收尾（已完成，Tailwind 4 落地后接线）

- `components/TaskAreaPage.tsx`：「重新执行」→**「重跑」**（确认框用 `rerunNoticeLines` 的两句话，
  确认后 `store.rerun` 新建任务、原任务不动）；`RolloutTimeline` 接 `onFork` → `buildForkTaskPlan`
  → **P3 预览确认框**（将复用 N 条工具结果 / 将丢弃 M 条记录 / 诚实提示）→ `store.forkFrom`；
  分叉被拒时弹「无法从这一步分叉」并列出原因；右列任务卡加「分叉」徽标、来源行与
  `taskForkNotice`（前缀重建 + 截断代价），左侧列表行加「分叉」标记。
- `components/ChatPage.tsx`：`startRun` 按 `taskId → task.forkedFrom` 读本机日志，经 `resolveForkRun`
  把 `forkedFrom` / `forkPrefix` 传给 `TriggerDeps`；**三种情况显式降级为普通重跑**（来源日志读不到 /
  v1 或未来版本 / 前缀重建失败）：不传 `forkPrefix`（不伪造复用）、仍保留 `forkedFrom`，
  并在输入区上方用**独立一行**琥珀提示说明原因——不并进 `sendNotice`，因为那条提示在发送成功后
  会被清空，会让用户误以为前缀被复用了。
- `components/RolloutTimeline.tsx`：导出按钮改三态（idle/copied/**failed**）；剪贴板不可用时
  显示「复制失败：浏览器未授权剪贴板。已展开 JSON 文本并选中，可直接复制。」并把 JSON 摊在
  只读 textarea 里自动选中，不再静默失败。
- 用例：组件层新增 10 例（RolloutTimeline 导出失败 1、TaskAreaPage 重跑/分叉/P3/任务卡 3 换 1、
  ChatPage 分叉请求与前缀形状 1 + 降级 1、`resolveForkRun` 5）。累计本轮新增用例 100 例。
- 验证：三个组件测试文件 140 例全绿；`tsc --noEmit` 全仓库 0 报错。
- 仍未做（与规格 §11 一致）：断点续跑、跨设备回放、自动重试、用日志重建完整 transcript、
  分叉回滚前缀写操作。



