# d.32 · Token 用量埋点与能力矩阵补维（P1-2 + P3-5）

- 日期：2026-10-23
- 相关版本：d.31.1.8.0（基线）、本 spec = d.32.1.8.0
- 上游依据：`docs/research/2026-10-22-deep-audit-followup-plan.md` §3 P1-2、§5 P3-5、§7 分轮表
- 涉及包：`packages/web`

## 0. 这一轮要解决什么

**一个「假确定性」，一个「知道得太少」。**

1. **Token 用量有账无埋点**：`store/tokenUsage.ts` 的 `record()` 在生产代码里**零调用点**
   （只有测试在写），而首页的 30 天热力图与本月配额已经把「空数据」当事实展示给用户看。
   这是最容易被信以为真的一类假象——不是没数据，是「有面板没数据源」。
2. **模型能力表只覆盖两维**（工具/视觉），而用户在选型时真正关心的另外几维
   （思考、长上下文、函数并行、结构化输出）完全看不到，只能靠猜。

## 1. 已核实的事实（本轮亲自读过源码）

| 编号 | 事实 | 位置 |
|---|---|---|
| P1-2 | `record(model, tokens, at)` 定义在此，全仓非测试调用点 **0** | `packages/web/src/store/tokenUsage.ts:118` |
| P1-2 | 首页读 `useTokenUsageStore()` 并直接算本月/今日/热力图 | `packages/web/src/components/HomePage.tsx:111,142-143,160-163` |
| P1-2 | 热力图读同一条 `records` | `packages/web/src/components/TokenHeatmap.tsx:9` |
| P1-2 | `streamChat` **完全不解析 `usage`**（grep `usage` 零命中） | `packages/web/src/lib/llmClient.ts` |
| P1-2 | OpenAI 分支的请求体**没有** `stream_options` ⇒ 流式响应默认不带 usage | `packages/web/src/lib/llmClient.ts:81-137` |
| P1-2 | 编排层在 `settle({status:"ok", finalText})` 处收口 | `packages/web/src/lib/agentStream.ts:703` |
| P3-5 | `ModelCapability` 只有 `contextWindow/maxOutput/supportsTools/supportsVision/supportsReasoning/pricing` | `packages/web/src/lib/modelCaps.ts:33-48` |
| P3-5 | 覆盖层已是通用的 `Partial<ModelCapability>` ⇒ 新字段自动可被用户覆写 | `packages/web/src/lib/modelCaps.ts:51` |
| P3-5 | `capabilityBadges` 用 emoji（🎯👁💭）——**违反本仓「无 emoji 图标」的视觉规范** | `packages/web/src/lib/modelCaps.ts:341-348` |
| P3-5 | 设置区的能力徽标直接渲染这个函数的结果 | `packages/web/src/components/LlmSettingsCard.tsx:209` |

## 2. 决策

### 2.1 P1-2：从供应商响应里回填 usage，**拿不到就标「未上报」而不是落 0**

**采集（`llmClient.ts`）**

- `StreamChatOpts` 新增 `onUsage?: (u: UsageTotals) => void`：
  ```ts
  export interface UsageTotals {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  }
  ```
- **OpenAI 兼容**：流式要带 `stream_options: { include_usage: true }` 才会在尾包给 usage。
  ★ **风险**：部分第三方 OpenAI 兼容网关不认这个参数，会 400。
  所以 `buildRequest` 新增 `includeUsage?: boolean`，`streamChat` **首次**带上；
  若首次请求返回 **HTTP 400**，**关闭 `stream_options` 重试一次**（只重试一次）。
  这样「不支持该参数的网关」退化成「没有 usage」，而不是「聊天直接坏掉」。
  第二次仍失败就把第二个错误抛出去（不掩盖真实问题）。
- **Anthropic**：`message_start` 事件里 `message.usage.input_tokens`，
  `message_delta` 事件里 `usage.output_tokens`（都已在 `data:` 行里）。
- **非流式兼容分支**（`content-type` 不含 `event-stream`）：`json.usage` 直接读。
- 同一轮里 usage 可能分多次下发（Anthropic 两个事件），**合并**后再回调一次。

**记录（`agentStream.ts`）**

- 一次「运行」可能有**多轮工具调用**（每轮一次 `streamChat`）⇒ usage **累加**。
- `TriggerDeps` 新增 `recordUsage?: (model: string, tokens: number | null) => void`。
  在 `settle({status:"ok"})` 之前调用一次：
  - 本轮拿到过 usage（至少一次）→ 传累加后的 `totalTokens`（没有就用 input+output）；
  - **一次都没拿到** → 传 `null`（= 未上报）。
  - 失败/中止的轮次**不记录**：没跑完的用量口径不清，记了反而误导。
- 保持 `agentStream` 的可测试性：**不直接 import store**，走注入。

**存储（`tokenUsage.ts`）**

- `UsageRecord.tokens` 改为 `number | null`：`null` = 该轮**未上报**。
  ★ 为什么不「不写记录」：那样界面只能显示 0，分不清「真的用了 0」与「没数据」；
  写一条 `tokens: null` 的记录，界面才有素材说出「未上报」。
- `record(model, tokens: number, at?)` 保持签名（旧调用/测试不受影响）。
- 新增 `recordUnreported(model, at?)`：写 `{ tokens: null }`。
- 聚合函数**跳过 null 参与求和**，但单独统计「未上报轮数」：
  - `summarizeMonth(...)` → `{ total, byModel, missing }`
  - `dailyTotals(...)` → 每项加 `missing`
  - `last30DaysTotals(...)` → 每项加 `missing`
  - `heatLevel` 不变（null 不产生热度）

**界面（`HomePage.tsx` / `TokenHeatmap.tsx`）**

- 今日徽标：有 reported → `今日已用 X`；今日只有 unreported → `今日用量未上报`。
- 本月配额卡：`missing > 0` 时补一句 `N 轮未上报`（灰字，不抢主数字）。
- 热力图：某天只有 unreported → 该格 `title` 写「未上报」而不是「0 tokens · 无」。

### 2.2 P3-5：能力矩阵补两维 + 长上下文派生 + 去掉 emoji 徽标

- `ModelCapability` 新增：
  - `supportsParallelTools: boolean`（函数并行）
  - `supportsStructuredOutput: boolean`（结构化输出 / JSON 模式）
- **长上下文不新增字段**，用派生函数：
  ```ts
  export const LONG_CONTEXT_TOKENS = 128_000;
  export function supportsLongContext(caps: ModelCapability): boolean {
    return caps.contextWindow >= LONG_CONTEXT_TOKENS;
  }
  ```
  ★ 为什么不存成字段：窗口已经是唯一事实源，再存一个布尔就是两个真源，
  用户改窗口而忘了改布尔时两边打架。派生最稳。
- 静态表按已知事实补齐这两个字段（不确定的一律 `false`——**宁保守不吹牛**）。
- `DEFAULT_CAPABILITY` 两者都 `false`。
- `capabilityBadges`：**去掉 emoji**（违反视觉规范），改为纯中文短标签：
  `函数调用 / 视觉 / 思考 / 长上下文 / 并行工具 / 结构化输出`。

### 2.3 关于「判定与丢弃同源」——这两维目前**不驱动任何行为**

如实说明：函数并行与结构化输出**当前没有被本仓的请求使用**
（`buildRequest` 从不发 `parallel_tool_calls` 或 `response_format`）。
所以这两个维度**只是选型参考**，不参与任何「判定 → 丢弃」。

**不做「假装它驱动行为」的事**：不会因为 `supportsStructuredOutput=false` 就去弹降级提示，
因为根本没有东西被丢弃。在设置区的能力徽标旁写清「模型能力（选型参考）」，
工具与视觉两维才是真正驱动行为的（它们仍走既有 `capabilityNotice`）。
这条区别必须写进代码注释——否则下一个人会以为这两个字段已经接线了。

## 3. 兼容与迁移

| 项 | 兼容性 |
|---|---|
| `UsageRecord.tokens` | 由 `number` 放宽为 `number \| null`；老记录都是数字，读回照旧 |
| `stream_options` | 首次带上、400 时自动重试一次（关掉该参数）；**不会让聊天变坏** |
| `ModelCapability` 新字段 | 必填布尔 ⇒ 静态表与 `DEFAULT_CAPABILITY` 同步补齐；用户覆盖层是 `Partial`，不受影响 |
| `capabilityBadges` | 返回值从 emoji 变成中文标签；调用方只做展示，无逻辑依赖 |

## 4. 测试计划

| 文件 | 覆盖 |
|---|---|
| `lib/llmClient.test.ts` | OpenAI 流式尾包 `usage` → `onUsage` 被回调且数值正确；Anthropic `message_start`+`message_delta` 合并；**带 `stream_options` 的请求 400 → 自动去掉重试一次且成功**；两次都 400 → 抛错；非流式 `json.usage` |
| `lib/agentStream.test.ts` | 多轮工具调用 usage 累加后只记一次；一次都没拿到 → 传 `null`；失败轮次不记录 |
| `store/tokenUsage.test.ts`（或 HomePage.test） | `recordUnreported` 写 `tokens:null`；`summarizeMonth` 的 `total` 不含 null 但 `missing` 计数正确；热力图/每日统计同样 |
| `components/HomePage.test.tsx` | 只有未上报 → 显示「未上报」而不是「0」；有数字时数字优先 |
| `lib/modelCaps.test.ts` | 新字段在静态表里可查；`supportsLongContext` 的 128K 边界；覆盖层能改新字段；未知模型仍返回 null（不猜） |
| `lib/modelCaps.test.ts` | `capabilityBadges` 返回值**不含 emoji**（断言无 `\p{Emoji}` / 具体 emoji 字符） |

## 5. 不做 / 边界

- **不做**云端汇总（Token 团队视图 / 按日期跨端）——那需要服务端聚合，属 P3 二线。
- **不做**用量上报云端——用量是本机数据，不出设备。
- **不做**按供应商真实计费换算（只有参考价，且免责声明已写明）。
- **不做**函数并行/结构化输出的行为接线（当前请求里根本没有这两项，见 §2.3）。
- **不改** `capabilityNotice` 的判定逻辑——它管的是「工具/视觉」两维的**真丢弃**，语义已正确。
- **不重构**设置区卡片结构，只在徽标文案与新增字段上动手。
