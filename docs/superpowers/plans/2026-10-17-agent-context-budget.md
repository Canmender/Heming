# 和鸣智能体上下文与预算管理实现计划

> 设计见 `docs/superpowers/specs/2026-10-17-agent-context-budget-design.md`。逐任务执行，先写测试再实现。

**Goal:** 给 @ 触发链路加 token 预算、分层压缩（LLM 摘要 + 确定性回落）、上下文超限自动重试兜底，并接入运行时可选项与设置区。

**Architecture:** 全部逻辑在 `packages/web/src/lib/agentContext/**`（本机 localStorage，零新依赖）；`agentStream` 通过第三个可选 deps 字段接入，缺省行为与今天完全一致。

**Tech Stack:** TypeScript、React 18、Vitest；复用既有 `lib/llmClient.ts` 的非流式分支做摘要。

## Global Constraints

- **不改** `packages/shared/**`、`packages/server/**`、`lib/api.ts`、`packages/desktop/**`。
- `ChatPage.tsx` 只允许在 **deps 组装处**加字段：**不改 `fetchHistory` 函数体**（E2E 批次正在改它）。
- `agentStream.ts` 只允许**追加**可选字段与调用点，既有 130+ 行行为与全部既有测试不得回归。
- 零新增 npm 依赖；所有新增 UI 无 emoji、浅灰 `#e6e6e6` 分割线、中文文案。
- 预算宁可高估不可低估；任何压缩失败必须回落到「原样发送」或「确定性摘要」，绝不阻断生成。
- 新增 localStorage 键带版本（`heming.context.v1`、`heming.contextSummaries.v1`），损坏回退默认值。

---

### Task A: 上下文核心库

**Files（只允许这些）:**
- Create: `packages/web/src/lib/agentContext/types.ts`
- Create: `packages/web/src/lib/agentContext/tokens.ts`
- Create: `packages/web/src/lib/agentContext/budget.ts`
- Create: `packages/web/src/lib/agentContext/summary.ts`
- Create: `packages/web/src/lib/agentContext/settings.ts`
- Create: `packages/web/src/lib/agentContext/store.ts`
- Create: `packages/web/src/lib/agentContext/history.ts`
- Create: `packages/web/src/lib/agentContext/index.ts`
- Test: `packages/web/src/lib/agentContext/context.test.ts`（可再拆多个）

**Interfaces（必须一致，Task B/C 依赖）:**

```ts
// tokens.ts
export function estimateTokens(text: string): number;
export function estimateRowsTokens(rows: ChatMessage[]): number;

// budget.ts
export interface PlanInput { budgetTokens: number; keepRecentTurns: number; reservedTokens?: number }
export interface PlanResult { recent: ChatMessage[]; older: ChatMessage[]; usedTokens: number; overflowTokens: number }
export function planContext(rows: ChatMessage[], input: PlanInput): PlanResult;

// summary.ts
export const SUMMARY_HEADER: "【早期对话摘要】";
export function deterministicSummary(older: ChatMessage[]): string;   // 无内容 → ""
export function buildSummaryPrompt(older: ChatMessage[], maxChars?: number): ChatMessage[];

// settings.ts
export interface ContextSettings { enabled: boolean; budgetTokens: number; keepRecentTurns: number; llmSummary: boolean }
export const DEFAULT_CONTEXT_SETTINGS: ContextSettings;               // enabled:true, 6000, 8, llmSummary:true
export function loadContextSettings(storage?: StorageLike): ContextSettings;
export function saveContextSettings(patch: Partial<ContextSettings>, storage?: StorageLike): ContextSettings;

// store.ts —— 摘要缓存（本机）
export class SummaryCache {
  constructor(storage?: StorageLike, now?: () => number)
  fingerprint(conversationId: string, older: ChatMessage[]): string;
  get(conversationId: string, fingerprint: string): string | undefined;
  set(conversationId: string, fingerprint: string, summary: string): void;
  clear(conversationId?: string): void;
}

// history.ts
export interface PrepareHistoryDeps {
  settings?: ContextSettings;
  cache?: SummaryCache;
  reservedTokens?: number;
  summarize?: (messages: ChatMessage[]) => Promise<string | null>; // LLM 摘要；返回 null/抛错 → 确定性回落
  aggressive?: 1 | 2;
}
export function prepareHistory(
  rows: ChatMessage[],
  deps?: PrepareHistoryDeps,
): Promise<ChatMessage[]>;
```

**Behavior:**
- `estimateTokens`：CJK（`㐀-鿿` 及扩展）1 token/字；ASCII 连续词每 4 字符 1 token（向上取整）；其余 2 字符 1 token；空串 0；每条消息 +4 结构开销（`estimateRowsTokens` 计）。
- `planContext`：`aggressive` 由调用方换算成预算后传入；从末尾累计 recent，超 `budgetTokens - reservedTokens` 的更早消息进 `older`；**不拆「user→assistant」对**——若切点使 recent 以 assistant 开头，则把其前面的 user 一并移入 recent；`keepRecentTurns` 为轮数上限：先按预算取，再按轮数上限截断（超出部分移入 older）。
- `deterministicSummary`：取 older 中用户消息前 80 字（最多 3 条）与助手回复首句（最多 3 条），输出 `【早期对话摘要】\n意图：…\n结论：…\n待办：…` 骨架；无有效内容返回空串。
- `SummaryCache`：键 `heming.contextSummaries.v1`，结构 `{ [conversationId]: { [fingerprint]: { summary, at } } }`；每会话上限 20 条（按 at LRU 淘汰）；总 JSON > 1.2MB 时全局淘汰最旧；指纹 = `条数 + 首条 id + 末条 id + 各条 content 长度之和`。
- `prepareHistory`：
  1. `settings.enabled === false` 或 rows 为空 → 原样返回 rows；
  2. `planContext` 后 `older` 为空 → 原样返回 rows；
  3. 摘要取缓存 → 命中即用；未命中：`settings.llmSummary && deps.summarize` 则 await（失败/返回 null/空白 → 确定性摘要），否则确定性摘要；空串摘要 → 丢弃摘要只用 recent；
  4. 返回 `[{ role:"system", content: SUMMARY_HEADER + 摘要 + 背景声明 }, ...recent]`；
  5. 任何异常 → 原样返回 rows。

---

### Task B: 运行时接线（agentStream + ChatPage）

**Files:**
- Modify: `packages/web/src/lib/agentStream.ts`（追加字段与调用点）
- Test: `packages/web/src/lib/agentStream.test.ts`（追加）
- Modify: `packages/web/src/components/ChatPage.tsx`（仅 deps 组装处）
- Test: `packages/web/src/components/ChatPage.test.tsx`（追加最小用例）

**Changes:**
- `TriggerDeps` 追加（**放在现有可选字段之后**，保持追加式）：

```ts
prepareHistory?: (rows: ChatMessage[], agentId: string, opts?: { aggressive?: 1 | 2 }) => Promise<ChatMessage[]>;
```

- `runAgentMentions`：`const history = await deps.fetchHistory();` 之后调用 `deps.prepareHistory?.(history, m.agentId)`（抛错回落原 history）；溢出重试也走它（传 `aggressive`）。
- **溢出重试**：`streamChat` 抛错且 message 命中超限特征（正则：`/context length|context_length|maximum context|too long|reduce the length/i` 且含 `400`）× 且 `deps.prepareHistory` 存在时，最多重试 2 次（`aggressive: 1` → `2`），重试前把 `acc` 清空、已上行 chunk 不撤回（服务端只认 finish 文本）；重试仍失败走既有 `agent_error` 分支。**注**：重试期间不再重复上行 chunk 以避免重复文本——实现时若难以保证，可只上行最后一次尝试的 chunk（在 `onDelta` 中按 `attempt === current` 过滤）。
- `ChatPage`：deps 组装处新增 `prepareHistory`，内部：读 `loadContextSettings()`；`summarize` 用该 agent 绑定的 profile 走 `streamChat`（非流式分支返回整段）并**不落库**；失败返回 null。**不改 `fetchHistory` 函数体、不改消息/WS 逻辑**。

---

### Task C: 设置区卡片

**Files:**
- Create: `packages/web/src/components/ContextSettingsCard.tsx`
- Test: `packages/web/src/components/ContextSettingsCard.test.tsx`
- Modify: `packages/web/src/components/SettingsPage.tsx`（挂卡片）
- Test: `packages/web/src/components/SettingsPage.test.tsx`（若断言受影响的现有用例，保持通过）

**UI:** 卡片「上下文预算」：开关（启用预算与压缩）；预算下拉 4000/6000/8000/12000；保留轮数 2/4/8/12；「用模型生成早期摘要」开关（关 = 只用零成本确定性摘要）；一行浅灰说明（只在本机、关闭后按原样发送）。全部改动即时落盘 `heming.context.v1`。

---

### Task D: 验证与收尾

1. `pnpm --filter @heming/web test` 全绿（基线 477 + 新增）。
2. `pnpm typecheck` 全绿。
3. `git status` 确认未改 shared/server/api/desktop、未改 `fetchHistory` 函数体。
4. 更新设计文档状态与 README（如涉及）；提交。
