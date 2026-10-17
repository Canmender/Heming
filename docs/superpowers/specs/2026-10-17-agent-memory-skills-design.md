# 和鸣智能体记忆与技能池设计（Hermes 同款三层记忆 + 技能池）

- 日期：2026-10-17
- 状态：已按用户指令直接进入实施（无需审批）
- 关联：`2026-10-16-m3-agents-design.md`（本地驱动红线）、`2026-10-13-heming-platform-design.md`
- 参考：`D:\MultiAgent\desktop\docs\ARCHITECTURE.md`（Working/Episodic/Semantic 三层）、`D:\MultiAgent\TencentDB-Agent-Memory`（L0–L3 与 Skill Memory 路由）

## 1. 背景与裁决

M3 已落地「本地驱动、云端只做 IM 桥梁」：系统提示词、LLM Key、上下文组装都在触发端本机。二期补两块智能体能力：

1. **三层记忆**：让智能体跨会话记住「当前在聊什么」「上次聊过什么」「长期偏好与事实」。
2. **技能池**：把可复用的能力（写作、代码审阅、会议纪要等）做成可管理、可路由、可导入导出的技能包，按需注入系统提示词。

**架构裁决：记忆与技能全部本地化（localStorage 抽象层），不上传云端、不进 SQLite、不改 IM 协议。**

理由：与 M3 红线一致；与正在并行开发的 IM/E2E 批次零协议冲突；用户可随时导出/清空。

## 2. 三层记忆模型

采用 Hermes 同款 **Working / Episodic / Semantic** 三层，并与腾讯 MemoryCore 的 L0–L3 对齐：

| 和鸣层 | 语义 | 生命周期 | 对应 TencentDB |
|---|---|---|---|
| **Working（工作记忆）** | 当前会话近若干轮与当前焦点 | 会话级，TTL 2h / 40 轮环形缓冲 | L0 对话 |
| **Episodic（情景记忆）** | 「某次对话发生了什么」的摘要条目 | 长期，按智能体+会话持久化，可衰减淘汰 | L1 原子 + L2 场景 |
| **Semantic（语义记忆）** | 「用户/智能体长期成立的事实与偏好」 | 长期，按智能体持久化，键值去重 | L3 核心画像 |

三层各自独立存储、独立召回，最终按预算拼装注入。

### 2.1 Working 工作记忆

- 数据结构：`WorkingTurn { id, conversationId, agentId, userText, assistantText, at }`
- 每会话最多 `40` 轮，超出丢最旧；2 小时未活动视为过期（读取时过滤）。
- 召回：取最近 `6` 轮 + 由最近轮次生成的「当前焦点」单行摘要（取最近 2 条用户文本截断）。
- 不做 LLM 加工，成本为零。

### 2.2 Episodic 情景记忆

- 数据结构：

```ts
interface EpisodicEntry {
  id: string;
  agentId: string;
  conversationId: string;
  summary: string;        // 压缩后的情景摘要（≤ 400 字）
  keywords: string[];     // 中文 bigram + ASCII 词（≤ 12）
  at: string;             // ISO
  importance: number;     // 0..1，默认 0.5
  sourceTurns: number;    // 由多少轮沉淀而来
}
```

- 写入：每累计 `6` 轮成功对话沉淀 1 条；也支持用户在记忆页「立即整理」。
- 摘要生成：**确定性抽取**（无额外 LLM 成本）——用户首问 + 助手回答前 160 字 + 关键实体；保留可编辑。
- 淘汰：每智能体上限 `500` 条；超限按 `score = importance × recency` 淘汰最低分。
- 召回：中文 bigram BM25 + 时间衰减（14 天半衰期）+ importance 加权，取 top 3。

### 2.3 Semantic 语义记忆

- 数据结构：

```ts
interface SemanticEntry {
  id: string;
  agentId: string;
  key: string;            // 归一化主题键（如「称呼」「偏好-语言」）
  value: string;          // 事实内容（≤ 500 字）
  scope: "user" | "agent";
  confidence: number;     // 0..1
  pinned: boolean;        // 置顶：每次召回必带
  source: "manual" | "explicit" | "consolidate";
  createdAt: string;
  updatedAt: string;
}
```

- 写入来源：
  1. **手动**：记忆页新增/编辑；
  2. **显式指令**：用户文本命中 `记住[:：]?…`、`以后都…`、`我的…是…` 等规则 → 抽取为候选，`confidence=0.9`，直接入库；
  3. **整理**：用户点「立即整理」把选中情景条目提炼为语义事实（确定性规则 + 手动确认）。
- 去重：同 `agentId + key` 更新而非追加；`pinned` 永不淘汰。
- 每智能体上限 `300` 条，超限淘汰最低 `confidence × recency` 的非 pinned 条目。
- 召回：pinned 全带；其余按 key/value 与查询的 bigram 重合度 + recency，取 top 5。

## 3. 记忆写入管道

触发时机：**仅本机成功 finish 后**（与 M3 的流式收尾一致），不拦截、不影响消息发送。

```
agent_finish(success)
  → Working.append(turn)
  → 显式指令抽取 → Semantic upsert（命中即入）
  → 每 6 轮 → Episodic.append(确定性摘要)
  → 配额守卫（超限淘汰）
```

- 中断/失败：只记 Working（标记 `partial`），不沉淀 Episodic，避免污染长期记忆。
- 撤回消息：不进入任何记忆层（与提示词过滤口径一致）。
- 全部写入 try/catch 静默降级：记忆失败绝不影响聊天主链路。

## 4. 记忆召回与注入

每次 @ 触发、调用供应商之前执行：

```
query = 当前用户文本 + 最近 2 轮用户文本
semantic = pinned + top5（bigram 重合 + recency）
episodic = top3（BM25 + 衰减 + importance）
working  = 最近 6 轮
预算     = 总注入 ≤ 1200 字符（按 semantic 40% / episodic 40% / working 20% 分配，未用额度顺延）
```

注入格式（追加在原系统提示词之后，保持原提示词原文不动）：

```text
## 长期记忆（语义）
- 称呼：用户希望被称为「阿和」
- 偏好-语言：默认使用简体中文

## 相关情景记忆
- 2026-10-16：讨论了发布计划，结论是周五前完成回归。

## 当前会话焦点
- 用户正在确认部署端口与备份策略。

> 以上记忆仅作参考；与用户当前表述冲突时，以当前表述为准。不要向用户复述本段结构。
```

- 记忆为空 → 不注入任何标题（保持原有提示词行为，测试可断言零变化）。
- 与技能注入的顺序：`原系统提示词 → 长期/情景/焦点记忆 → 技能`。

## 5. 技能池模型

技能 = 本地可复用的能力包，格式兼容 Claude/Hermes 的 `SKILL.md`（YAML frontmatter + Markdown 正文）。

```ts
interface SkillDefinition {
  id: string;
  name: string;             // ≤ 32
  description: string;      // 路由依据，≤ 200
  instructions: string;     // 注入正文，≤ 8000
  triggers: string[];       // 显式触发词
  tags: string[];
  enabled: boolean;
  builtin: boolean;
  version: string;          // 默认 1.0.0
  source: "builtin" | "user" | "imported";
  createdAt: string;
  updatedAt: string;
}

interface SkillBinding {
  agentId: string;
  pinned: string[];         // 该智能体必带
  disabled: string[];       // 该智能体禁用
}
```

### 5.1 路由算法

无新依赖，复用中文 bigram：

1. 查询分词：ASCII 小写词 + 中文相邻二字 bigram；
2. 字段权重：`name ×3`、`triggers ×2.5`、`tags ×1.5`、`description ×1`；
3. 命中加权 IDF（池内文档频率），加 `usage` 微增益；
4. 过滤：全局禁用、该智能体 disabled、分数为 0；
5. 排序后取 top 3，总注入 ≤ 1600 字符；
6. `pinned` 先入队且不受 top-K 限制（仍受总预算约束）。

注入格式：

```text
## 已启用技能
### 代码审查（命中：审查 / 代码）
<instructions 原文>

### 写作润色（用户置顶）
<instructions 原文>
```

### 5.2 内置技能（首启种子）

不追求数量，覆盖四类高频场景，全部可编辑/禁用/删除：

1. `builtin-memory-curator` 记忆整理；
2. `builtin-writing` 写作润色；
3. `builtin-code-review` 代码审查；
4. `builtin-meeting-notes` 会议纪要。

### 5.3 导入/导出

- 单技能导出为 `SKILL.md`：

```markdown
---
name: 代码审查
description: 对代码变更做缺陷、安全与可维护性审查
version: 1.0.0
triggers: [审查, review, 代码]
tags: [代码, 工程]
---

审查步骤……
```

- 导入支持：`SKILL.md` 文本/文件、单技能 JSON、整池 JSON（`{ version: 1, skills: [...] }`）。
- frontmatter 解析用内置极简解析（仅 `key: value` 与 `[a, b]` 数组），不引入 YAML 依赖；解析失败给出具体错误，不静默吞。

## 6. 运行时接线

新增 `packages/web/src/lib/agentRuntime/context.ts`：

```ts
buildAgentContext({
  agentId, conversationId, userText, basePrompt,
}): {
  systemPrompt: string;
  recalled: { semantic: SemanticEntry[]; episodic: EpisodicEntry[]; working: WorkingTurn[] };
  skills: SkillMatch[];
}
```

`agentStream.ts` 的 `TriggerDeps` 增量扩展（保持旧字段兼容）：

- `buildSystemPrompt?: (agentId, userText) => Promise<string>`：存在时优先，缺省回落 `getPrompt`；
- `onTurnComplete?: (agentId, userText, assistantText, status) => void`：finish 分支回调（成功/部分）。

`ChatPage.startRun` 组装上述依赖：上下文构建失败自动回落到原提示词；记忆/技能异常不影响发送。

## 7. UI（记忆区）

`Page = "memory"` 从占位页升级为 `MemoryPage`：

- 顶部分段：**记忆** / **技能池**；智能体选择器（默认「全部/当前名册」）。
- 记忆页：
  - 三张层级卡（工作/情景/语义）+ 计数 + 自动记忆开关 + 导出/导入；
  - 检索框、条目列表（语义可编辑/置顶/删除；情景可删除；工作只读）；
  - 「添加记忆」与「立即整理」；
  - **召回预览**：输入一句话，展示将被注入的三层条目与字符预算占用。
- 技能池页：
  - 技能卡片（名称/描述/触发词/内置标识/启用开关/编辑/删除/导出）；
  - 「新建」「导入」「导出全部」；
  - **路由预览**：输入一句话，显示命中的技能与理由、预算占用；
  - 选中智能体后可设 pinned / disabled。
- 视觉遵循既有规范：无 emoji、1.5px 细线 SVG、`#e6e6e6` 浅灰分割线、中文文案。

## 8. 存储、配额与隐私

- 存储适配器 `StorageLike`（默认 `localStorage`），键名带版本：
  - `heming.memory.working.v1`
  - `heming.memory.episodic.v1`
  - `heming.memory.semantic.v1`
  - `heming.memory.settings.v1`
  - `heming.skills.v1`
  - `heming.skillBindings.v1`
- 单键 JSON 超过 `1.2MB` 触发淘汰；总配额守卫失败时降级为仅内存并给出可恢复提示。
- 损坏数据回退空集（与既有 localStorage 策略一致），不阻塞聊天。
- 隐私：记忆/技能只在本机；导出为用户主动动作；云端 API 永不含记忆内容。
- 记忆不进入 `MessagePayload`、不写 SQLite、不走 WS。

## 9. 测试策略

- 纯逻辑单测：三层写入/淘汰/去重、显式指令抽取、BM25 召回、预算裁剪、注入格式、导入导出往返。
- 集成单测：`buildAgentContext` 在各开关组合下的输出；`agentStream` 异步系统提示词与 finish 回调。
- UI 单测：记忆区渲染、添加/删除/置顶、技能启停、路由预览、导入错误提示。
- 全量验证：`pnpm -r build && pnpm -r test`（或至少 `pnpm --filter @heming/web test` 与 `pnpm typecheck`）。

## 10. 与 IM/E2E 并行批次的协作边界

- 不改 `packages/shared/src/schemas.ts`、`packages/server/**`、WS 事件与消息 payload。
- 仅对 `packages/web/src/components/ChatPage.tsx`、`lib/agentStream.ts`、`App.tsx` 做**增量**修改；新增代码集中在：
  - `packages/web/src/lib/memory/**`
  - `packages/web/src/lib/skills/**`
  - `packages/web/src/lib/agentRuntime/**`
  - `packages/web/src/components/MemoryPage.tsx` 及测试
- 若并行分支也修改 ChatPage，合并时以「保留双方新增段落」为原则（本设计只新增 deps 字段与回调，不重排既有逻辑）。

## 11. 本期不做

- 向量 Embedding（先 BM25 + bigram，接口预留）；
- 云端同步与多端记忆合并；
- 自动技能生成/技能执行沙箱（MCP 属接口区三期）；
- 记忆的 LLM 自动归纳（预留「立即整理」的手动入口与函数签名）。
