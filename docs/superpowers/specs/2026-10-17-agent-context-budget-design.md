# 和鸣智能体上下文与预算管理设计（Context Budget & Compression）

- 日期：2026-10-17
- 状态：按用户「继续」指令直接进入实施（无需审批）
- 关联：`2026-10-17-agent-memory-skills-design.md`（三层记忆/技能池，已落地）、`2026-10-16-m3-agents-design.md`（本地驱动红线）
- 参考：`D:\MultiAgent` 调研 §5 上下文管理（原子组切分 / 结构化摘要 / 溢出恢复）

## 1. 问题

当前 @ 触发只做 `fetchMessages(convId).slice(-30)`，无 token 预算：

1. 长会话 30 条可能远超模型窗口 → 供应商 400 `context_length_exceeded`，会话内只剩错误行；
2. 短会话浪费窗口，长会话浪费钱；
3. 与三层记忆/技能池的注入量无统一口径（记忆 ≤1200 字符、技能 ≤1600 字符，历史不受约束）。

## 2. 目标与非目标

**目标**：给触发链路加「token 预算 + 分层压缩 + 溢出兜底」，全部本机执行，不改协议、不依赖服务端读正文。

**非目标（本期不做）**：
- 工具调用结果的 offload（当前无 function calling，留接口）；
- 摘要落服务端/跨设备同步（本机 localStorage）；
- 智能体自主决定压缩策略（不做 agentic compaction）。

## 3. 设计

### 3.1 Token 估算（零依赖，CJK 感知）

```ts
estimateTokens(text: string): number
```

规则：CJK 字符 ≈ 1 token/字；ASCII 词 ≈ 4 字符 1 token；其余按 2 字符 1 token 折中。对「预算」目的够用（宁可高估）。单条消息另加 4 token 结构开销。

### 3.2 预算与切分

```ts
planContext(rows, { budgetTokens, keepRecentTurns, reservedTokens }): {
  recent: ChatMessage[];   // 最近 N 轮，原文
  older: ChatMessage[];    // 更早，待压缩
  usedTokens: number;      // recent 占用
  overflowTokens: number;  // older 占用（压缩前的量）
}
```

- 默认 `budgetTokens = 6000`、`keepRecentTurns = 8`；
- `reservedTokens` = 记忆段 + 技能段 + 系统提示词 的估算量（注入侧上界 ≈ 900 token）；
- 从最新往回累计，超过 `budgetTokens - reservedTokens` 的更早轮次进 `older`；
- 切分不拆「用户-助手」对：若切点落在助手回复后，本轮整体归入 recent（原子组保护，避免孤立 user 轮）。

### 3.3 结构化摘要（压缩 older）

对 `older` 生成一段摘要，采用固定骨架（学 MultiAgent 的 ContextManager）：

```text
【早期对话摘要】
意图：…
结论：…
待办：…
```

- **优先 LLM**：用该智能体绑定的 profile 发一次**非流式**请求（`streamChat` 复用，非 event-stream 分支已支持整段返回），`maxTokens` 上限 400；提示词要求「只输出上述三段、不寒暄」。
- **失败/未绑定必回落确定性摘要**：抽取早期用户提问前 80 字（最多 3 条）+ 助手回复首句（最多 3 条），拼成同样骨架。
- **缓存**：按 `conversationId + older 指纹（条数 + 首尾 id + 各条长度之和）` 存 `heming.contextSummaries.v1`，命中即复用，避免每轮重复花 token；上限每会话 20 条、全局 1.2MB 触发淘汰。
- 摘要以 `system` 角色置于历史之前，标注「以下是更早对话的摘要，仅作背景」。

### 3.4 溢出兜底（供应商 400）

`streamChat` 抛 `provider_error: HTTP 400 ...`：若 message 命中上下文超限特征（`context_length` / `maximum context` / `too long` / `token` 且 `400`），且该次触发注入了 `prepareHistory`，则**收紧预算重试一次**：

- 第一次收紧：`keepRecentTurns = max(2, floor(keep/2))`、`budgetTokens × 0.5`；
- 仍失败：`keepRecentTurns = 2`、`budgetTokens × 0.25`，且只保留摘要；
- 两次仍失败 → 走既有 `agent_error`（不无限重试）；重试对用户不可见，仅在触发端控制台留痕。

### 3.5 与记忆/技能的口径

- 记忆段 ≤1200 字符、技能段 ≤1600 字符（既有）；`reservedTokens` 按估算值扣除，保证「提示词 + 历史」总预算不超；
- 压缩产生的摘要**不回写**记忆层（避免自我强化），但会话结束时若已沉淀情景记忆，二者可并存（情景记忆是长期，摘要是本次请求的临时上下文）。

## 4. 运行时接线

`TriggerDeps` 增量（**第三个可选字段**，与前两个同模式）：

```ts
prepareHistory?: (
  rows: ChatMessage[],
  agentId: string,
  opts?: { aggressive?: 1 | 2 },
) => Promise<ChatMessage[]>;
```

- `agentStream` 在 `fetchHistory` 之后、组装 messages 之前调用；抛错/缺省 → 用原 rows（行为与今天一致）；
- 溢出重试复用同一函数并传 `aggressive` 级别。

`ChatPage` 在 deps 组装处新增该字段（**不改 `fetchHistory` 函数体**，避开与 E2E 的 loadMessages 改造重叠）。

## 5. 设置

`lib/agentContext/settings.ts`（localStorage `heming.context.v1`）：

```ts
interface ContextSettings {
  enabled: boolean;        // 关闭 = 原样发送（回到今天行为）
  budgetTokens: number;    // 默认 6000
  keepRecentTurns: number; // 默认 8
  llmSummary: boolean;     // 默认 true；关 = 只用确定性摘要（零额外 token）
}
```

设置区新增卡片「上下文预算」：开关、预算（下拉 4000/6000/8000/12000）、保留轮数（2/4/8/12）、LLM 摘要开关，附一行本机存储说明。

## 6. 测试

- 纯逻辑：token 估算（中英混排）、预算切分与原子组保护、确定性摘要骨架、缓存命中/失效、设置读写与损坏回退。
- 集成：`prepareHistory` 缺省/抛错 → 原样 rows；溢出识别与两次收紧重试；重试耗尽走 `agent_error`。
- UI：设置卡片渲染、切换落盘。

## 7. 协作边界（与 E2E 批次）

- 新增 `lib/agentContext/**`、`components/ContextSettingsCard.tsx`；
- 增量改 `lib/agentStream.ts`（尾部加一个可选字段 + 调用点）、`components/ChatPage.tsx`（deps 组装处加一行）、`components/SettingsPage.tsx`（挂卡片）；
- **不改** `packages/shared/**`、`packages/server/**`、`lib/api.ts`、`packages/desktop/**`、`fetchHistory` 函数体。
