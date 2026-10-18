# 智能体批次交接文档（三层记忆 · 技能池 · 上下文预算）

- 日期：2026-10-18
- 状态：**已完成并合入 main**（`473945e`），全仓测试绿
- 分支/工作区：批次分支 `claude/xenodochial-aryabhata-24defe`（worktree `D:\Heming\.claude\worktrees\xenodochial-aryabhata-24defe`，与 main 同内容，保留未删）
- 关联文档：
  - 设计 `docs/superpowers/specs/2026-10-17-agent-memory-skills-design.md`、`docs/superpowers/specs/2026-10-17-agent-context-budget-design.md`
  - 计划 `docs/superpowers/plans/2026-10-17-agent-memory-skills.md`、`docs/superpowers/plans/2026-10-17-agent-context-budget.md`
  - 参考调研 `docs/superpowers/research/2026-10-17-multiagent-study.md`（D:\MultiAgent 40 条可借鉴点）
  - 架构红线 `docs/superpowers/specs/2026-10-16-m3-agents-design.md`（本地驱动、云端只做 IM 桥梁）

---

## 1. 一句话现状

智能体现在有**跨会话的三层记忆**（工作/情景/语义）、**可路由可导入导出的技能池**、以及**上下文 token 预算与早期对话压缩**；三者都只在本机执行、只落 `localStorage`，不改服务端、不改 WS 协议、不新增依赖。记忆区（Alt+4）与设置区「上下文预算」卡片是用户入口。

## 2. 用户可见能力

| 能力 | 入口 | 说明 |
|---|---|---|
| 三层记忆管理 | 记忆区（Alt+4）→ 记忆 | 工作/情景/语义三张层级卡与计数；记忆总开关 + 自动记忆开关；语义条目增/改/置顶/删，情景条目删，工作只读；检索；导出（复制 JSON）/导入；「立即整理」；**召回预览**（显示本次将注入的三层条目 + 预算占用字符数） |
| 技能池 | 记忆区 → 技能池 | 技能卡片（名称/描述/触发词/内置标识/版本/来源）；启停；新建/编辑/删除；**导入**（`SKILL.md` 或 JSON）/导出（单条 / 全部）；**路由预览**（命中技能 + 命中理由 + 预算占用）；选定具体智能体后可设「置顶必带 / 本例禁用」 |
| 记忆注入 | @ 触发自动生效 | 系统提示词 = 原提示词 → 记忆段（长期/情景/焦点）→ 技能段；全空则原文不动 |
| 上下文预算 | 设置区 → 上下文预算 | 开关 / 预算 4000·6000·8000·12000 / 保留轮数 2·4·8·12 / 「用模型生成早期摘要」开关；改动即时落盘 |
| 超限自动重试 | @ 触发自动生效 | 供应商报上下文超限时按 `aggressive=1→2` 收紧预算重试（最多 2 次），对用户不可见、不重复上行 chunk |

## 3. 代码地图

### 3.1 新增模块（全部在 `packages/web/src/lib/`）

| 模块 | 文件 | 职责与主要导出 |
|---|---|---|
| `memory/` | `types.ts` `storage.ts` `tokenize.ts` `store.ts` `extract.ts` `recall.ts` `format.ts` `index.ts` | 三层记忆。`MemoryStore`（读写/淘汰/导出导入）、`memoryStore` 单例、`recallMemory`、`formatMemorySection`（1200 字符预算）、`extractExplicitMemory`（「记住：X」等）、`tokenize` |
| `skills/` | `types.ts` `builtins.ts` `store.ts` `router.ts` `markdown.ts` `index.ts` | 技能池。`SkillPool`（CRUD/绑定/导入导出/usage）、`skillPool` 单例、`routeSkills` + `formatSkillSection`（1600 字符预算）、`parseSkillMarkdown`/`skillToMarkdown` |
| `agentContext/` | `types.ts` `tokens.ts` `budget.ts` `summary.ts` `settings.ts` `store.ts` `history.ts` `index.ts` | 上下文预算。`estimateTokens`/`estimateRowsTokens`、`planContext`（原子组保护不拆 user/assistant 对）、`deterministicSummary`/`buildSummaryPrompt`、`SummaryCache`（按会话指纹）、`prepareHistory`、`loadContextSettings`/`saveContextSettings`、`summaryCache` 单例 |
| `agentRuntime/` | `context.ts` `index.ts`(若有) | `buildAgentContext({agentId, conversationId, userText, basePrompt, memory?, skills?}) → { systemPrompt, recalled, skills }`；两段皆空时**严格返回原 basePrompt** |

### 3.2 增量修改的既有文件

| 文件 | 增量内容 |
|---|---|
| `lib/agentStream.ts` | `TriggerDeps` 尾部追加 3 个**可选**字段：`buildSystemPrompt?`、`onTurnComplete?`、`prepareHistory?`；流式主体 = 上下文超限重试循环 × E2E 信封上行（重试不上行 chunk，`sealTail` 落闸后 `sendFinish`，失败统一走 `sendError`） |
| `lib/llmClient.ts` | 未改（摘要复用其非 event-stream 分支的整段返回） |
| `components/ChatPage.tsx` | **仅在 deps 组装处**注入上述 3 个字段（`fetchHistory` 函数体未动） |
| `components/App.tsx` | `page === "memory"` 渲染 `MemoryPage`（占位页只剩接口区） |
| `components/SettingsPage.tsx` | 挂载 `<ContextSettingsCard />`（+2 行） |
| `components/icons.tsx` | 新增 `PlusIcon`/`TrashIcon`/`DownloadIcon`（1.5px 细线） |
| `README.md` | 能力清单新增「记忆与技能池」「上下文预算」两条 |

### 3.3 新增 UI 组件

- `components/MemoryPage.tsx`（约 1390 行，含记忆/技能池两页签、召回与路由预览）
- `components/ContextSettingsCard.tsx`

## 4. 运行时数据流（一次 @ 触发）

```
用户发送（E2E 信封）
  → ChatPage.startRun(mentions, text) 组装 TriggerDeps
     ├ fetchHistory()      : useChatStore.loadMessages(convId) 取近 30 条
     │                       （已过滤撤回 / 解不开的占位 / reaction·chaindist 控制消息）
     ├ prepareHistory()    : loadContextSettings → planContext 预算切分
     │                       → 早期对话压缩（LLM 摘要，失败回落确定性摘要；按指纹缓存）
     ├ buildSystemPrompt() : buildAgentContext = 原提示词 + 记忆段 + 技能段（命中技能计 usage）
     └ streamChat()        : 直连本机配置的供应商；chunk/finish 经 E2E 信封上行
  → 收尾 onTurnComplete(status) ：ok → recordTurn（Working + 显式指令入语义 + 每 6 轮沉淀情景）
                                 partial → 只 appendTurn(partial)
```

关键口径：**记忆只在「触发设备」沉淀**（本机明文：本机发出的 userText + 本机累积的 assistantText），**不读服务端正文**——E2E 之后服务端只见信封，这条口径保证记忆与加密不冲突。

## 5. 本机存储键（全部 `.v1` 版本化，均可安全清空）

| 键 | 内容 | 上限/淘汰 |
|---|---|---|
| `heming.memory.working.v1` | 工作记忆（按会话） | 每会话 40 轮；2 小时未活动过滤 |
| `heming.memory.episodic.v1` | 情景记忆（按智能体） | 每智能体 500 条；按 `importance × recency` 淘汰 |
| `heming.memory.semantic.v1` | 语义记忆（按智能体，键值去重） | 每智能体 300 条；`pinned` 不淘汰 |
| `heming.memory.settings.v1` | `{enabled, autoCapture, retentionDays}` | 默认 `true/true/90` |
| `heming.skills.v1` | 技能池（含 4 个内置种子） | 单键 JSON > 1.2MB 触发 LRU 淘汰 |
| `heming.skillBindings.v1` | 每智能体 `{pinned[], disabled[]}` | — |
| `heming.context.v1` | `{enabled, budgetTokens, keepRecentTurns, llmSummary}` | 默认 `true/6000/8/true` |
| `heming.contextSummaries.v1` | 早期对话摘要缓存 | 每会话 20 条 LRU；仅 LLM 摘要入缓存 |

损坏数据一律回退默认值；配额写不下时降级为内存态并静默（不阻塞聊天）。

## 6. 关键常量与默认值

- 记忆注入总预算 **1200 字符**（语义 40% / 情景 40% / 焦点 20%，未用额度顺延）
- 技能注入总预算 **1600 字符**（top3 + 置顶必带）
- 情景沉淀节奏：每 **6** 轮成功对话 1 条；召回 top3（14 天半衰期 + importance 加权）
- 语义召回：pinned 全带 + top5；工作记忆召回最近 **6** 轮
- 上下文预算默认 **6000 token**、保留 **8** 轮、注入侧预留 900 token
- 技能路由权重：name ×3 / triggers ×2.5 / tags ×1.5 / description ×1，叠加 IDF 与 usage 微增益
- 内置技能 id：`builtin-memory-curator`、`builtin-writing`、`builtin-code-review`、`builtin-meeting-notes`

## 7. 已知边界与取舍（接手必读）

1. **记忆只在触发设备沉淀**：别机触发的轮次不进本机记忆（要跨设备需接 `lib/e2eSession.ts` 的本机明文缓存，见 §9）。
2. **`onTurnComplete(..., "ok")` 只在 finish 真正发出后触发**：E2E 加密失败走 `bad_event` 收口时该轮不记为成功（未注入 seal 的明文路径照旧）。理由：用户没收到回复就不该沉淀为长期记忆。合并时与 E2E 会话确认采纳。
3. **不做**（设计里显式留白）：向量 Embedding 检索、云端记忆同步、记忆的工具化（`memory_write/read/list` 需 function calling）、LLM 周期自动归纳（现只有手动「立即整理」）。
4. **摘要缓存只缓存 LLM 摘要**，确定性摘要零成本、不入缓存（不占每会话 20 条额度）。
5. **溢出重试不上行 chunk**：重试期间本地气泡停在首次尝试的部分文本，`message_new` 到达后即刻被正式消息替换。
6. **记忆页「全部智能体」视图走 `exportAll()` 快照**：`MemoryStore` 没有跨智能体枚举读口，全部视图是快照过滤，**该视图下写入口禁用**（添加/整理/绑定需先选定具体智能体）。
7. **peer 提过但未实现的建议**：把未送达状态以 `"error" | "aborted"` 显式透传给记忆层，由记忆层决定是否保留 episodic。当前语义不变（直接不记），如需该粒度再实现，成本很小。
8. **`MemoryPage` 单文件约 1390 行**：与 `ChatPage.tsx` 同量级；若要继续加功能建议先拆分。

## 8. 测试与验证

```bash
pnpm test        # shared 63 / server 169 / web 617 / desktop 19 = 868 项全绿
pnpm typecheck   # 四包 tsc 通过
```

- 本批为 web 新增 **81** 项测试（475 → 556）。重点覆盖：三层写入/淘汰/去重、显式指令抽取、BM25+bigram 召回、注入预算与格式、技能路由与 `SKILL.md` 往返、上下文切分/摘要/缓存/设置、`prepareHistory` 与溢出重试接线、记忆区与设置卡片 UI。
- 真机冒烟（浏览器 + 真实服务器，种子账号 admin）：记忆页渲染、技能池 4 内置种子落盘、新增语义记忆落盘、召回预览命中与预算显示、总开关关闭后预览为 0 且写入口置灰、设置卡片落盘；另在浏览器运行时直接跑过 `prepareHistory`（30 条中文历史按 4000 token/4 轮 → 输出 1 条摘要 + 8 条近期）。

## 9. 与 E2E 批次的合并结论（避坑）

- **合并点**：`lib/agentStream.ts` 的 `TriggerDeps` 尾部（我方 3 字段 + 对方 `sealChunk/sealFinish/sealError` 共 6 个可选字段）与 `ChatPage.test.tsx` 的新增用例；流式主体做了语义合成（重试循环 × 信封上行）。
- **E2E 后 `payload.text` 只在 store 路径是明文**：必须走 `useChatStore.getState().loadMessages(convId)`（缓存优先 → 解密合并 → 占位过滤）；裸 `fetchMessages()` 拿到的是 `{text:""}` 占位。本批代码**零处**直连裸接口读正文。
- **新写测试注意**：E2E 下 chunk/finish 帧是信封（帧上 `text` 置空、正文进 `cipher`），断言要按「信封内明文」写（测试文件已有 `sealedOf()` 助手）；发送与上行是异步的，需 `await act(async () => {})` 冲刷；**jsdom 下 `document.body.innerText` 是 `undefined`，要用 `textContent`**。

## 10. 下一批候选任务（含冲突面）

参考 `docs/superpowers/research/2026-10-17-multiagent-study.md` 的 10 条草案，按与本批的衔接度排序：

| 候选 | 价值 | 冲突面 / 前置 |
|---|---|---|
| **1:1 智能体会话**（单用户 ↔ 单 agent 多轮流式） | 高（产品缺口） | 需评估是否动 `server/**`（会话类型/成员）与 `ChatPage`；建议先写设计文档定契约 |
| **上下文压缩进阶**：大结果 offload、极端压缩重试分级 | 中 | 纯 `lib/agentContext/**`，零冲突 |
| **记忆工具化**（`memory_write/read/list` 工具协议） | 中高 | 需 function calling / 工具循环，属 MCP 前哨 |
| **harness 桥接**（探测本机 Claude Code/OpenCode + `LocalAgentExecutor`） | 高 | 要动 `packages/desktop/main.js`（IPC）——上一批 E2E 也动过该文件，需协调 |
| **MCP 接口区** | 高 | 新依赖 + 设置区/接口区 UI；安全围栏与 HITL 必须一起做 |
| **记忆增强**：向量检索（可注入 EmbedFn）、LLM 周期归纳 | 中 | 纯本机，接口已预留（`summarize` 注入、BM25 可换） |

## 11. 工作流约定（用户偏好）

一个批次按：**设计文档 → 计划文档（把接口签名写死，子 agent 才能照做）→ 并行派发互不冲突的子任务 → 主控自跑全量测试 / typecheck / 真机冒烟 → 提交**。用户明确表示**不要逐步审批**（「先写方案，然后调用子agent完成任务，不需要我的审批」），只在不可逆或对外动作（合 main、部署）上确认。合 main 后由负责 E2E/部署的会话统一部署并重打桌面安装包。
