# 和鸣智能体记忆 + 技能池实现计划

> **For agentic workers:** 按任务串行/并行约定执行；每个任务先写测试再实现，完成后运行对应包测试。设计见 `docs/superpowers/specs/2026-10-17-agent-memory-skills-design.md`。

**Goal:** 在本地驱动架构下落地 Hermes 同款三层记忆（Working/Episodic/Semantic）与可路由、可导入导出的技能池，并接入 @ 触发链路与记忆区 UI。

**Architecture:** 全部逻辑落在 `packages/web`，localStorage 经 `StorageLike` 适配；不改 shared/server/WS。`buildAgentContext` 在触发端拼装「原提示词 + 记忆 + 技能」，`agentStream` 以可选字段兼容旧行为。

**Tech Stack:** TypeScript、React 18、Zustand、Vitest + Testing Library；零新增 npm 依赖。

## Global Constraints

- **不改** `packages/shared/**`、`packages/server/**`、WS 协议、`MessagePayload`。
- 记忆/技能只写本机 `localStorage`（键名带 `.v1`），不上传、不进消息、不进 SQLite。
- 所有新代码必须有 Vitest 测试；UI 无 emoji 图标，分割线 `#e6e6e6`，细线 SVG。
- 存储损坏必须回退空集；所有记忆/技能读写对聊天主链路 try/catch 静默降级。
- 中文分词不引依赖：ASCII 词 + 中文 bigram。
- 与并行 IM 分支的协作：只对 `ChatPage.tsx` / `agentStream.ts` / `App.tsx` 做增量修改，不重排既有逻辑。
- 提交前缀 `feat:` / `test:` / `docs:`；每个任务至少一次提交（由主控统一提交）。

---

### Task 1: 记忆核心（lib/memory）

**Files:**
- Create: `packages/web/src/lib/memory/types.ts`
- Create: `packages/web/src/lib/memory/storage.ts`
- Create: `packages/web/src/lib/memory/tokenize.ts`
- Create: `packages/web/src/lib/memory/store.ts`
- Create: `packages/web/src/lib/memory/extract.ts`
- Create: `packages/web/src/lib/memory/recall.ts`
- Create: `packages/web/src/lib/memory/index.ts`
- Test: `packages/web/src/lib/memory/memory.test.ts`

**Interfaces (must match exactly):**

```ts
export interface WorkingTurn { id: string; conversationId: string; agentId: string;
  userText: string; assistantText: string; at: string; partial?: boolean }
export interface EpisodicEntry { id: string; agentId: string; conversationId: string;
  summary: string; keywords: string[]; at: string; importance: number; sourceTurns: number }
export interface SemanticEntry { id: string; agentId: string; key: string; value: string;
  scope: "user" | "agent"; confidence: number; pinned: boolean;
  source: "manual" | "explicit" | "consolidate"; createdAt: string; updatedAt: string }
export interface MemorySettings { enabled: boolean; autoCapture: boolean; retentionDays: number }
export interface StorageLike { getItem(k: string): string | null; setItem(k: string, v: string): void;
  removeItem(k: string): void }
export interface MemoryData { working: Record<string, WorkingTurn[]>;
  episodic: Record<string, EpisodicEntry[]>; semantic: Record<string, SemanticEntry[]>;
  settings: MemorySettings }

export class MemoryStore {
  constructor(storage?: StorageLike, now?: () => number)
  getSettings(): MemorySettings
  updateSettings(patch: Partial<MemorySettings>): void
  appendTurn(t: Omit<WorkingTurn, "id" | "at"> & { at?: string; partial?: boolean }): void
  working(conversationId: string, agentId?: string): WorkingTurn[]
  recordTurn(agentId: string, conversationId: string, userText: string, assistantText: string): void
  episodic(agentId: string): EpisodicEntry[]
  semantic(agentId: string): SemanticEntry[]
  addEpisodic(input: { agentId: string; conversationId: string; summary: string; sourceTurns?: number }): EpisodicEntry
  upsertSemantic(input: { agentId: string; key: string; value: string; source: SemanticEntry["source"]; confidence?: number; scope?: SemanticEntry["scope"] }): SemanticEntry
  updateSemantic(agentId: string, id: string, patch: Partial<Pick<SemanticEntry,"key"|"value"|"pinned"|"confidence">>): void
  removeSemantic(agentId: string, id: string): void
  removeEpisodic(agentId: string, id: string): void
  clearAgent(agentId: string): void
  exportAll(): string
  importAll(json: string): { ok: true } | { ok: false; error: string }
}
```

**Behavior:**
- Working：每会话上限 40，2h 过滤；`recordTurn` 追加轮次，成功轮次每 6 轮触发 `addEpisodic`（确定性摘要）。
- Episodic：每 agent 上限 500，淘汰 `importance × recency` 最低；`keywords = tokenize(summary).slice(0, 12)`。
- Semantic：同 `agentId+key` upsert（保留 id/createdAt，刷新 value/updatedAt）；上限 300，非 pinned 淘汰；`pinned` 不淘汰。
- 损坏 JSON → 返回默认空数据；写失败静默。
- `exportAll` 输出 `{ version: 1, exportedAt, data }`；`importAll` 校验 version 与结构，失败返回 `{ok:false,error}`。

**Tests:** 三层隔离、40/500/300 上限、同键 upsert、pinned 不淘汰、2h 过滤、6 轮沉淀、损坏回退、导出导入往返、配额守卫。

---

### Task 2: 记忆抽取、召回与注入上下文（lib/memory 续）

**Files:**
- Create: `packages/web/src/lib/memory/format.ts`
- Create: `packages/web/src/lib/memory/recall.ts`（若 Task 1 已建则补全）
- Test: `packages/web/src/lib/memory/recall.test.ts`
- Test: `packages/web/src/lib/memory/extract.test.ts`

**Interfaces:**

```ts
export function tokenize(text: string): string[]
export function bm25Score(queryTokens: string[], docs: string[][]): number[]  // 需要时可用简化实现
export function extractExplicitMemory(text: string):
  { key: string; value: string } | null   // 记住：X / 以后都 X / 我的X是Y
export function deterministicSummary(userText: string, assistantText: string): string
export function recallMemory(store: MemoryStore, input: {
  agentId: string; conversationId: string; query: string;
}): { semantic: SemanticEntry[]; episodic: EpisodicEntry[]; working: WorkingTurn[] }
export function formatMemorySection(recalled: ReturnType<typeof recallMemory>): string
```

**Behavior:**
- `recallMemory`：pinned 全带；semantic top5（bigram 重合 + recency）；episodic top3（重合 + 14 天半衰 + importance）；working 最近 6 轮。
- `formatMemorySection`：按设计 §4 的三段格式输出；空输入返回空串；总字符 ≤ 1200（semantic 40% / episodic 40% / working 20%，未用额度顺延），逐条截断而非整段丢弃。
- `extractExplicitMemory`：仅识别明确指令，返回归一化 key（≤ 24 字）。

---

### Task 3: 技能池核心（lib/skills）

**Files:**
- Create: `packages/web/src/lib/skills/types.ts`
- Create: `packages/web/src/lib/skills/builtins.ts`
- Create: `packages/web/src/lib/skills/store.ts`
- Create: `packages/web/src/lib/skills/router.ts`
- Create: `packages/web/src/lib/skills/markdown.ts`
- Create: `packages/web/src/lib/skills/index.ts`
- Test: `packages/web/src/lib/skills/skills.test.ts`

**Interfaces (must match exactly):**

```ts
export interface SkillDefinition { id: string; name: string; description: string;
  instructions: string; triggers: string[]; tags: string[]; enabled: boolean;
  builtin: boolean; version: string; source: "builtin" | "user" | "imported";
  createdAt: string; updatedAt: string }
export interface SkillBinding { agentId: string; pinned: string[]; disabled: string[] }
export interface SkillMatch { skill: SkillDefinition; score: number; reason: string }

export class SkillPool {
  constructor(storage?: StorageLike, now?: () => number)
  list(): SkillDefinition[]
  get(id: string): SkillDefinition | undefined
  create(input: Omit<SkillDefinition, "id"|"createdAt"|"updatedAt"|"builtin"|"source"> & { source?: SkillDefinition["source"] }): SkillDefinition
  update(id: string, patch: Partial<SkillDefinition>): SkillDefinition
  remove(id: string): void
  setEnabled(id: string, enabled: boolean): void
  bindings(agentId: string): SkillBinding
  setBinding(agentId: string, patch: Partial<Omit<SkillBinding,"agentId">>): void
  route(input: { query: string; agentId?: string; topK?: number; charBudget?: number }): SkillMatch[]
  recordUsage(id: string): void
  exportOne(id: string): string       // SKILL.md
  exportAll(): string                 // JSON bundle
  importText(text: string): { added: number; updated: number } // 自动识别 SKILL.md / JSON
}

export function formatSkillSection(matches: SkillMatch[]): string
```

**Behavior:**
- 首启（storage 无键）写入 4 个内置技能；删除后不自动复活（记录 `seeded: true`）。
- route：ASCII 词 + bigram；字段权重 name 3 / triggers 2.5 / tags 1.5 / description 1；IDF；usage 微增益；top3；pinned 先入；总注入 ≤ 1600 字符；disabled/全局禁用过滤。
- `formatSkillSection` 输出 `## 已启用技能`，每个技能标题附命中理由或「用户置顶」。
- markdown：解析 frontmatter `name/description/version/triggers/tags`（数组支持 `[a, b]` 与逗号串）；导出时数组用 `[a, b]`；正文 = instructions。
- 单键 JSON > 1.2MB 时淘汰最久未使用技能（builtin 可淘汰）。

**Tests:** 种子幂等、CRUD、启停、绑定、中文路由排序、pinned、预算裁剪、SKILL.md 往返、JSON bundle 导入、错误输入提示、损坏回退。

---

### Task 4: 运行时上下文组装（lib/agentRuntime）

**Files:**
- Create: `packages/web/src/lib/agentRuntime/context.ts`
- Test: `packages/web/src/lib/agentRuntime/context.test.ts`
- Modify: `packages/web/src/lib/agentStream.ts`
- Test: `packages/web/src/lib/agentStream.test.ts`（追加）

**Interfaces:**

```ts
export interface BuildContextInput { agentId: string; conversationId: string;
  userText: string; basePrompt: string; memory?: MemoryStore; skills?: SkillPool }
export interface BuiltContext { systemPrompt: string;
  recalled: { semantic: SemanticEntry[]; episodic: EpisodicEntry[]; working: WorkingTurn[] };
  skills: SkillMatch[] }
export function buildAgentContext(input: BuildContextInput): BuiltContext
```

- 顺序：basePrompt → memory section → skill section。
- 记忆/技能关闭、为空或异常 → 原样返回 basePrompt（测试断言严格相等）。
- `agentStream.ts` 增量：
  - `TriggerDeps.buildSystemPrompt?: (agentId: string, userText: string) => Promise<string>`；
  - `TriggerDeps.onTurnComplete?: (agentId: string, userText: string, assistantText: string, status: "ok" | "partial") => void`；
  - 每 mention 在 `streamChat` 前 `await buildSystemPrompt`（失败回落 getPrompt），finish/partial 后调用 `onTurnComplete`。
- 现有测试不得回归。

---

### Task 5: ChatPage 接线

**Files:**
- Modify: `packages/web/src/components/ChatPage.tsx`
- Test: `packages/web/src/components/ChatPage.test.tsx`（追加最小用例）

**Changes:**
- 引入模块级单例 `memoryStore` / `skillPool`（lib/memory、lib/skills 导出）。
- `startRun` 的 deps 增加：
  - `buildSystemPrompt: async (agentId, text) => buildAgentContext({...}).systemPrompt`
  - `onTurnComplete: (agentId, userText, assistantText, status) => memoryStore.recordTurn(...)；status==="partial" 仅记 working（design §3）`
- 技能使用计数：在 `buildAgentContext` 返回后对选中的技能 `recordUsage`（在 context.ts 或 ChatPage 中一次完成，避免重复）。
- 不改现有消息/WS 逻辑。

---

### Task 6: 记忆区 UI

**Files:**
- Create: `packages/web/src/components/MemoryPage.tsx`
- Test: `packages/web/src/components/MemoryPage.test.tsx`
- Modify: `packages/web/src/App.tsx`（`page === "memory"` 渲染 `MemoryPage`）
- Modify: `packages/web/src/App.test.tsx`（若有必要）
- Modify: `packages/web/src/components/icons.tsx`（如需 `PlusIcon`/`TrashIcon`，保持 1.5px 细线）

**UI requirements:**
- 顶栏：标题「记忆」、分段「记忆 / 技能池」、智能体选择器（来自 `listAgents()`，失败时显示「全部智能体」不阻塞）。
- 记忆页：三张层级卡 + 计数；自动记忆开关；导出/导入（文件 input 或 textarea）；检索；列表操作（语义编辑/置顶/删除、情景删除、工作只读）；「添加记忆」弹窗；「召回预览」。
- 技能池：卡片列表、启停开关、pinned/disabled（选中具体智能体时）、新建/编辑弹窗、导入（粘贴 SKILL.md 或 JSON）、导出单条/全部、路由预览。
- 所有异步失败给内联中文提示；无 alert（除既有风格不便处，优先内联）。
- 测试：渲染三层、添加语义记忆后出现、置顶、删除、技能启停、导入非法文本提示、召回预览展示条目。

---

### Task 7: 验证与收尾

**Files:**
- Create/Modify: 必要时修复以上任务测试。
- Update: `README.md` 能力清单（一行：三层记忆 + 技能池，本机存储）。

**Steps:**
1. `pnpm --filter @heming/web test` 全绿。
2. `pnpm typecheck`（根命令会先 build shared）全绿。
3. 检查未修改 shared/server：`git diff --stat`。
4. 提交（主控）：`feat: 智能体三层记忆与技能池`。
