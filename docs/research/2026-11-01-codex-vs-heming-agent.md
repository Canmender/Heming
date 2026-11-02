# Codex 全量对比：和鸣能拿走什么

> 研究日期：2026-11-01（**2026-11-02 校正到 `6e79fc6` / d.50**）
> 对比对象：[openai/codex](https://github.com/openai/codex)（Apache-2.0，Rust 工作区 `codex-rs`，上百 crate）
> 对比基座：和鸣 `d.45.1.11.0` → 已校正到 `d.50`（`packages/web/src/lib/**`）
> 目的：找出**可复用的资产**与**可落地的 agent 能力优化**，不写"人家很好我们加油"。

> **校正说明（d.46–d.50 落地后）**：G4「Anthropic 绑定没有工具」已由 `505511f` 关闭——
> `lib/llmAnthropic.ts` 在请求边缘把 OpenAI 形状转成 `tool_use` / `tool_result` block，
> `capabilityNotice.supportsKind` 不再对 anthropic 一票否决，同时落地了 `promptCache.ts`（前缀缓存）
> 与 `llmRoute.ts`（候选链 failover）。因此矩阵第 12 行由「落后」改为「持平」，§四 G4 改为**复核项**。
> **G1 / G2 / G3 / G5 / G6 在 d.50 上仍然成立**（行号已更新）。

---

## 一、结论

**一句话**：Codex 强在「单机编码 agent 的完整闭环」——工具原语、执行隔离、回合持久化；和鸣强在「多 agent 场景的安全边界与上下文治理」——HITL 分级、MCP 不采信自述、用量口径。两边几乎不重叠，所以互补性很高。

**能立刻拿走的四件事**（P0，都在工具执行层，不改架构）：

1. 工具结果**封顶 + 中断透传**：结果多长都塞进请求，中断后工具还在跑。
2. 工具结果**截断 + 预算**：现在 MCP 返回多大就原样塞进下一轮请求。
3. 写操作**串行化**：现在同一轮所有 tool_call 无差别 `Promise.all`。
4. 工具轮次**从"3 轮硬上限"改成"预算驱动"**：复杂任务必然在第 3 轮被砍。

> 原第 5 条「Anthropic 原生 tools 接线」已由 `505511f` 完成，见 `lib/llmAnthropic.ts`。

**不该抄的三件事**：

- 直接拉起 `codex` 二进制当后端（认证、分发、定位全冲突，见 §五 C）。
- 平台级沙箱（macOS seatbelt / Linux landlock）：Electron 里没有等价物，投入产出比极差。
- code-mode（内嵌 V8 让模型写 JS 编排工具）：我们的工具边界是 MCP，收益远小于攻击面。

---

## 二、定位差异

| 维度 | 和鸣 | Codex |
|---|---|---|
| 形态 | 云端中心化 IM + 多 Agent，Electron 桌面壳 | 终端 CLI / IDE 扩展 / SDK，本地单机 |
| 用户 | 多人协作，一个群里多个智能体 | 单个开发者在自己的仓库里 |
| 智能体边界 | 每用户自配 LLM，Key 只在本机 | ChatGPT 账号或 API Key |
| 核心难题 | 群聊里"谁能动什么"、上下文与记忆治理 | 让模型可靠地改代码、跑命令、不搞坏机器 |
| 信任模型 | 服务端只见信封（E2E） | 本机沙箱 + 审批 |
| 成功标准 | 协作顺滑、不出安全事故 | 任务真的改对了代码 |

**这个差异决定了抄什么**：Codex 的"工具执行层"是纯工程资产，可以整体借鉴；它的"产品形态"和"信任模型"跟我们不是一回事，照搬会拧巴。

---

## 三、能力矩阵

判定口径：**领先** = 我们做得更细；**持平** = 思路一致；**落后** = 存在真实能力缺口。

| # | 维度 | 和鸣现状 | Codex 做法 | 判定 |
|---|---|---|---|---|
| 1 | 回合循环 | `MAX_TOOL_ROUNDS = 3`，到顶即停（`agentStream.ts:10,700`） | 循环到模型不再请求工具，靠 token 预算而非轮次收口（`session/turn.rs`） | 落后 |
| 2 | 并行工具 | 同一轮全部 `Promise.all`（`agentStream.ts:654`） | `parallel_tool_calls: true`，但写操作由工具自身语义与审批串行化 | 落后（且不安全） |
| 3 | 中断与超时 | 有超时（HTTP 20s / stdio 30s），但中断信号传不到执行层 | 工具调用有生命周期与取消（`tools/lifecycle.rs`） | 落后（已补中断透传） |
| 4 | 工具结果治理 | 原样回灌，无截断 | 截断 + 「保留最近 N 条完整输出」白名单（`compact_retained_tool_outputs.rs`） | 落后 |
| 5 | 工具发现 | 全量注入所有启用工具（`mcp/runtime.ts:161`） | `tool_search` + 增量工具（`build_prompt(..., incremental_tools)`） | 落后 |
| 6 | 编辑原语 | 无（`wiki_*` 只读，`self_*` 只改记忆/技能/MCP） | `apply_patch` 上下文锚点补丁协议 | 落后（但对我们不是刚需） |
| 7 | 执行隔离 | 无沙箱，stdio MCP 走桌面桥 + `shell:false` | seatbelt / landlock / Windows 沙箱 + `exec-server` 独立进程 | 落后（暂不跟） |
| 8 | 审批与安全 | 三档 × 三级风险 × 按智能体规则 × 三种拒绝原因，兜底倒向拒绝 | 四档 `AskForApproval` + `SafetyCheck` 三态 + 路径白名单判定 | **领先** |
| 9 | 上下文治理 | 6k 预算 + 8 轮 + 摘要，**仅在供应商 400 时**触发收紧重试 | 预算内主动压缩，分 PreTurn/MidTurn/PostTurn，含后台压缩 | 落后（机制有，调度弱） |
| 10 | 回合持久化 | 任务记录在 `localStorage`（`tasks/store.ts`） | rollout 逐条追加事件日志，可恢复/分叉/回滚 | 落后 |
| 11 | 前后端解耦 | `TriggerDeps` 十余个回调注入（`agentStream.ts:85-226`） | `Op`/`EventMsg` 联合类型 + 单一 `Event{id,msg}` 流 | 落后（但够用） |
| 12 | 模型兼容 | 双协议 SSE；Anthropic 原生 tool_use/tool_result + 前缀缓存（`llmAnthropic.ts` / `promptCache.ts`，d.49） | 单一 Responses API，多供应商适配在 `model-provider` | 持平（d.49 已追上） |
| 13 | 扩展机制 | MCP（HTTP/stdio）+ 技能池 + 插件包 + 自修改工具 | MCP + 插件 + 技能 + hooks + code-mode | 持平（各有侧重） |
| 14 | 可观测 | token 记账（`usageSeen` 区分"未上报"与 0）、召回档案、工具轨迹 | rollout + OTel + turn timing + 调用追踪 | 持平（口径更严） |
| 15 | 多智能体 | 群聊多 agent + @ 触发，各自独立跑 | `spawn/send/wait` 父子 agent 树、消息板 | 各有侧重 |

---

## 四、六个关键差距（逐条可执行）

### G1 工具轮次被硬砍在第 3 轮

**证据**：`agentStream.ts:10` `MAX_TOOL_ROUNDS = 3`；`:700` 到上限就把已有文本发给用户并 `return`。

**为什么是问题**：真实任务常见链路是「搜文件 → 读文件 → 改 → 验证」，刚好 4 步。第 3 轮被砍的表现是"模型话说到一半停了"，而且**用户完全看不出是被截断的**——我们只 `console.warn`。

**Codex 怎么做**：不设轮次上限，靠 `needs_follow_up` + token 预算 + 压缩收口；到预算边界时压缩历史再继续，而不是丢弃任务。

**改法**：把常量换成两个闸：`maxRounds = 12`（防死循环的兜底）与 `turnTokenBudget`（真正的收敛条件）。到 `maxRounds` 时不要静默 `return`，而是追加一条系统提示「已达到本次调用上限，请总结当前进展」，让模型自己收尾。**验收**：构造一个需要 5 轮工具的任务，能完整跑完且最终回复里有结论。

---

### G2 工具结果不封顶，中断传不到执行层

> **更正（实施时发现）**：初版写「没有超时」并不准确——`mcp/httpClient.ts` 本来就有 20s
> 单请求超时，桌面端 `mcp-stdio.js` 也有 30s。真正的缺口是另外两条。

**证据**：`mcp/bridge.ts` 的 `executeToolCall` 把 `result.text` 原样返回，
进而在 `agentStream.ts` 里原样进 `extra`——结果长度无上限；同时 `execute` 没有 `signal`，
用户点中断只 abort 了模型请求，在途的 MCP 调用继续跑。

**为什么是问题**：
- 一个返回 200KB JSON 的工具，会把下一轮请求的输入 token 直接顶上去；6k 预算的上下文瞬间
  被一条工具结果占满，然后触发压缩、压缩完又超、再重试——用户看到的是"回答变慢变傻"。
- 中断后工具还在跑：结果没人收，副作用却已经发生（写文件、发请求）。这比"慢"严重。

**Codex 怎么做**：工具调用有生命周期与取消；输出截断，并把"最近 N 条完整输出"列入保留名单
（`compact_retained_tool_outputs.rs`），压缩时优先丢旧工具输出而不是丢用户消息。

**已实施（d.50.1.12.0）**：
- `truncateToolResult`：8000 字符封顶，头 2/3 + 尾 1/3，中间标记带省略字数（模型看得见被截断）。
- `ToolBridge.execute(call, { signal })` 全链路透传；HTTP 侧把外部信号与内置超时合并
  （文案按谁先触发区分"已中断"与"超时"）；stdio 没有取消语义，只"不再等"并写明
  "子进程可能仍在运行"；调用前已中断则不发请求。

---

### G3 写操作和其他调用一起并行

**证据**：`agentStream.ts:723` `Promise.all(calls.map(...))`（执行在 `:740`），唯一的分支是 HITL 的拒绝。

**为什么是问题**：模型一轮里发两个 `self_memory_write`（同一 key）或两个改同一文件的操作时，后写的会被覆盖，结果**取决于谁先返回**。更麻烦的是 `self_mcp_remove_server` 与 `self_mcp_enable` 并行时，状态机随机。这和 HITL 里那条"拒绝优先"的严谨程度不匹配：**审批很小心，执行却很随意**。

**Codex 怎么做**：工具执行由 `ToolCallRuntime` 统一调度，写类工具按资源串行，遵循"同一资源的变更顺序必须确定"。

**改法**：按 `risk` 分组——`read` 并行，`write`/`danger` 串行（保持原顺序）。`bridge.meta` 已经能给出 `risk`（`agentStream.ts:76`），闸门也已经在用，**调度层只要复用同一份元数据**即可，不需要新概念。**验收**：构造一轮里两个写同一 key 的调用，最终值等于后一个；测试断言执行顺序。

---

### G4 Anthropic 工具接线 —— **已关闭（`505511f`，d.49）**

**原状**：`capabilityNotice.ts:16` 对 `provider === "anthropic"` 直接返回 `false`，`toAnthropicTools`（`mcp/bridge.ts:73`）无调用方，Claude 用户永远没有工具，且界面把实现缺口说成"模型不支持"。

**现状**：形状转换下沉到 `lib/llmAnthropic.ts`，在请求边缘把 OpenAI 形状转成 `tool_use` / `tool_result` block；`supportsKind` 交回能力表判定，用户手改仍然优先；顺带把缓存读/写 token 补回用量口径（`agentStream.ts` 的 `onUsage`），Anthropic 的 `input_tokens` 不含缓存段这个坑也填了。

**保留为复核项**（三条边界，回归时别踩回去）：
1. 拒绝路径必须映射成 `is_error: true` 的 `tool_result`，不能只发一段普通文本——否则模型会以为工具执行成功了。
2. 一个 assistant 轮里的多个 `tool_use` 必须对应**同一条** user 消息里的多个 `tool_result`（Anthropic 要求成组），顺序与 id 都要对齐。
3. 能力提示文案仍要区分「模型不支持」与「尚未适配」——d.49 之后前者才是真实原因，但文案别写成绝对。

---

### G5 上下文只在"供应商报错"时才治理

**证据**：`agentContext/budget.ts:11` 默认 6000 token；`agentStream.ts:232,715` 只有在 `isContextOverflow()` 命中 400 时才 `aggressive` 重试；工具轮追加的 `extra` 完全不参与预算计算。

**为什么是问题**：这是**被动治理**——先失败，再重试，重试还可能再失败（上限 2 次）。而工具轮是最容易超限的地方：每轮都重发「历史 + 已累积的全部工具结果」，输入 token 随轮次线性涨。Codex 的做法是**采样前就判断要不要压缩**，而不是等供应商打回来。

**Codex 怎么做**：`PreTurn / MidTurn / PostTurn` 三阶段压缩 + 后台压缩（`async_compaction.rs`），并在压缩时保留最近工具输出、丢弃旧的。

**改法**：
- 在 `once()` 的每轮开始前，用现有 `estimateRowsTokens` 估算「准备发送的 messages」，超过 `budget × 0.8` 就先压缩**工具结果**（按"最旧优先、被引用过的不删"），而不是等 400。
- 压缩对象要区分类型：用户消息 > 助手结论 > 工具输出；工具输出最容易被安全丢弃。
- **验收**：一个 8 轮工具调用的任务，全程不出现 400，输入 token 曲线不随轮次单调上涨。

---

### G6 回合没有持久化，崩溃即失忆

**证据**：任务记录 `localStorage`（`tasks/store.ts`），只存"目标/结果/步骤"的汇总，不存可重放的回合序列；工具轨迹只在本机内存里走 `onToolTrace`。

**为什么是问题**：桌面端崩溃、刷新页面、切换设备，长任务全丢；事后要复盘"它当时为什么这么干"，只剩一段摘要。Codex 的 rollout 是**唯一事实来源**，state DB 只是索引——这让"恢复/回放/分叉"变成自然能力。

**Codex 怎么做**：每条消息、每次工具调用、每次 token 计数都追加一行 JSONL；`thread/fork`、`thread/revert` 都基于这份日志。

**改法**：定义 `RolloutItem` 联合类型（`user_message | assistant_message | tool_call | tool_result | token_count | turn_end`），会话进行中逐条追加到本机文件（桌面端）或 IndexedDB（浏览器）。**先只做"写 + 读来恢复界面"，不做 fork**。**验收**：对话进行到第 5 轮时强制退出应用，重启后能恢复全部 5 轮与工具轨迹。

---

## 五、可复用清单

### A. 可以直接移植（算法 / 协议 / 数据结构，跨语言重写）

> 依据：Apache-2.0，允许衍生与商用，需保留版权声明与 NOTICE。移植时在文件头标注来源与 commit。

| 资产 | 源路径 | 移植量 | 用途 | 优先级 |
|---|---|---|---|---|
| `apply_patch` 补丁协议 + 上下文锚点匹配 | `codex-rs/apply-patch/src/{parser,seek_sequence,file_update}.rs` | 约 400 行 TS | 给智能体一个可靠的文件编辑原语：不数行号、按上下文定位、模糊标点归一、保留行尾 | P2 |
| 补丁安全判定 | `codex-rs/core/src/safety.rs`（`assess_patch_safety` / `is_write_patch_constrained_to_writable_paths`） | 约 80 行 TS | 「写的路径都在可写根内 → 免问」；接进现有 `hitl/policy.ruleFor`，把"按工具记忆"升级为"按路径记忆" | P2 |
| 命令前缀规则 | `codex-rs/execpolicy/`（Starlark 规则） | 约 150 行 TS（简化成 JSON 规则） | 若做 shell 工具，用它表达「允许 `git status`，拒绝 `rm -rf`」 | P2 |
| 工具输出截断 + 保留名单 | `compact_retained_tool_outputs.rs` | 约 120 行 TS | 直接解决 G2 的后半段 | **P0** |
| 回合事件日志 | `codex-rs/rollout/src/lib.rs`（`RolloutItem` / `RolloutRecorder`） | 约 200 行 TS | 直接解决 G6 | P1 |
| 分阶段压缩调度 | `session/turn.rs` 的 `run_auto_compact` 调用点 | 约 100 行 TS | 把现有 `planContext` + `summary` 从"溢出后补救"改成"采样前判断" | P1 |
| 按需工具发现 | `core/src/tools/handlers/tool_search.rs` | 约 150 行 TS | 工具数 > 20 时只暴露名字与一句话，模型按需拉 schema | P1 |
| AGENTS.md 层级合并 | `core/src/agents_md.rs`（root → cwd，就近覆盖） | 约 60 行 TS | 技能/记忆注入的合并顺序参考，减少提示词重复堆叠 | P2 |

### B. 只能借设计，不能搬代码

- **SQ/EQ 协议形状**：`Op`（意图）/ `EventMsg`（事实）/ `Event{id,msg}` 关联。我们不需要照搬枚举，但可以把 `TriggerDeps` 的十几个回调收敛成一个 `AgentEvent` 联合类型 + 一个 sink，为将来"网页 / 桌面 / 任务区 / 手机共用一条事件流"铺路。
- **app-server 的能力协商**：`initialize.capabilities.*` —— 客户端声明自己支持什么，服务端按能力裁剪通知。我们的桌面端/网页端能力差异（stdio、文件桥、通知）现在散在 `hasStdioBridge()` 这类探测里，可以借鉴"显式声明"。
- **exec-server 的进程边界**：把"执行"做成独立进程 + JSON-RPC，沙箱在 helper 里施加。我们的 stdio MCP 已经在桌面主进程里跑子进程，方向一致；但**不要**现在抽独立服务，收益不足以抵消复杂度。
- **多 agent 的 spawn/send/wait 语义**：比我们"群里 @ 各跑各的"更结构化。我们的群聊更像广播，缺少"父 agent 派活给子 agent 并等结果"。这是产品级差异，不是本轮任务。

### C. 不建议

- **把 `codex` 二进制当后端**：需要用户另装 codex 并登录 ChatGPT/配 Key，和"每用户本机配 LLM、Key 只在本机"的定位直接冲突；且它的产出是终端 patch，不是聊天回复。唯一合理形态是"编码任务插件"，属于另一个产品决策。
- **平台沙箱**：Electron 没有 seatbelt/landlock 的等价能力，Windows 侧更复杂。我们真实的执行面是 MCP（远程为主），沙箱应该由 MCP 服务自己负责，客户端做的是审批与结果治理。
- **code-mode（内嵌 V8）**：模型写 JS 在本地执行，攻击面与我们的 E2E/本机数据模型冲突。若真需要"一次调用编排多个工具"，用受限的 `run_plan` DSL 更合适。

---

## 六、路线图

### P0（工具执行层，1-2 天，不改架构）

> d.50 复核：以下四项**均未实施**（`agentStream.ts:10/700/723`、`mcp/bridge.ts:98` 行号已更新）。

| 项 | 改动点 | 验收 |
|---|---|---|
| 工具超时 | `mcp/bridge.ts` `executeToolCall` + `httpClient/stdioClient` 透传 signal | 挂死服务 60s 后对话继续 |
| 结果截断 | `mcp/bridge.ts` 返回前截断，头 2/3 尾 1/3 | 300KB 结果不顶爆预算 |
| 写操作串行 | `agentStream.ts:723` 按 `risk` 分组调度 | 同 key 两次写，后者生效 |
| 轮次改预算驱动 | `agentStream.ts:10/700` → 12 + 预算 + 到顶提示收尾 | 5 轮任务跑完且有结论 |

> ~~Anthropic 工具接线~~ 已由 `505511f` 完成；~~能力文案修正~~ 同上。

### P1（能力提升，1-2 周）

| 项 | 改动点 | 验收 |
|---|---|---|
| Anthropic 消息形状转换 | `llmClient.ts` 的 `tool_use` / `tool_result` block 转换 | Claude 能完成工具闭环 |
| 采样前压缩 | `agentStream.ts` 每轮前估算 + 压缩工具结果 | 8 轮任务不出现 400 |
| 回合事件日志 | 新增 `lib/rollout/`，`RolloutItem` + 本机追加 | 崩溃后恢复 5 轮 |
| 按需工具发现 | 新增 `tool_search` 内置工具 + 工具数阈值 | 工具 > 20 时首轮 prompt 不涨 |
| 工具输出保留名单 | 压缩时保护最近 N 条 | 关键工具结果不被压掉 |

### P2（架构级，1 个月+）

- `apply_patch` 编辑原语 + 路径白名单 HITL（桌面端文件桥）
- `TriggerDeps` → `AgentEvent` 事件化
- 技能/记忆注入的层级合并（AGENTS.md 模式）
- shell 工具 + `execpolicy` 规则（若产品需要）

---

## 七、风险与反例

- **别为了"对齐 Codex"引入它的问题**：它的 crate 数量（上百个）带来的是编译时间与上手成本；我们单包前端 + 4 个 workspace 包的分层是对的，不该为"清晰"而拆成 30 个包。
- **超时值不能一刀切**：Scrapling 抓网页可能合法地跑 3 分钟。默认 60s 必须**可按服务覆盖**，否则会把慢工具变成不可用。
- **截断会改变模型行为**：截断文案必须明确告诉模型"内容被截断了"，否则它会基于残文下结论。Codex 在工具结果里带截断标记，我们照做。
- **串行化会变慢**：读并行、写串行是正确的口径，但若把 `read` 也串行，多工具任务会明显变慢。判定必须用 HITL 已有的 `risk`，不要另起一套。
- **事件日志会碰 E2E**：rollout 落盘的是明文回合，和"服务端只见信封"不冲突（本机明文缓存已有先例），但**不能**跟会话导出混在一起，否则导出会带上工具原文。

---

## 八、附：值得读的文件（按顺序）

**Codex 侧**

1. `codex-rs/protocol/src/protocol.rs` — `Op` / `EventMsg`，系统词汇表
2. `codex-rs/core/src/session/turn.rs` — `run_turn` 主循环、重试、抢占、压缩调用点
3. `codex-rs/core/src/tools/registry.rs` / `orchestrator.rs` — 工具注册与调度
4. `codex-rs/core/src/tools/handlers/apply_patch.rs` + `spec_plan.rs` — 工具如何描述给模型
5. `codex-rs/core/src/safety.rs` — 三态安全判定（最短、最值得抄）
6. `codex-rs/apply-patch/src/lib.rs` — 补丁协议与返回契约
7. `codex-rs/exec-server/README.md` — 执行与沙箱的进程边界
8. `codex-rs/core/src/session/async_compaction.rs` + `compact_retained_tool_outputs.rs` — 压缩
9. `codex-rs/rollout/src/lib.rs` — 回合日志

**和鸣侧（本次对比涉及）**

- `packages/web/src/lib/agentStream.ts` — 编排主循环、轮次、并行、溢出重试
- `packages/web/src/lib/mcp/{runtime,bridge}.ts` — 工具桥、执行、命名空间
- `packages/web/src/lib/hitl/{types,gate,policy}.ts` — 审批（我们的强项）
- `packages/web/src/lib/agentContext/{budget,summary,tokens}.ts` — 预算与摘要
- `packages/web/src/lib/capabilityNotice.ts` — 能力降级判定

---

## 九、落实情况（2026-11-02，d.50.1.12.0）

同步到 `6e79fc6`（d.50）后逐条复核，并按本清单完成实施。

| 编号 | 状态 | 落地位置 |
|---|---|---|
| G1 轮次硬上限 3 | **已关闭** | `agentStream.ts`：12 轮兜底 + 12k token 回合预算，到顶明确告知「回复继续」 |
| G2 无超时 / 不截断 | **已关闭** | 超时原本就有（HTTP 20s / stdio 30s），本轮补的是**中断透传**与「调用前已中断不发请求」；结果封顶为 8000 字符（头 2/3 + 尾 1/3，带省略标记） |
| G3 写操作并行 | **已关闭** | `agentStream.ts`：按 `bridge.meta.risk` 分组，`read` 并行、`write`/`danger` 保序串行 |
| G4 Anthropic 工具 | **已关闭（`505511f`）** | `llmAnthropic.ts` 请求边缘转换；保留三条回归边界（见 §四 G4） |
| G5 上下文只在 400 后治理 | **已关闭** | 新增 `agentContext/toolResults.ts`：采样前折叠较早工具结果（3000 token 预算，最近 3 条不折，条数不变） |
| G6 回合无持久化 | **部分关闭** | 新增 `lib/rollout`：逐条记录开始/调用/结果/答案/终态，本机存储、有界、失败静默；只读面板已做（`components/RolloutTimeline.tsx`，接入任务区右列）；恢复与分叉未做 |

**新增观察**

1. **常驻幕僚（d.48）不使用工具**：`staff/llm.ts`、`staff/runner.ts` 里没有 tool bridge，因此本轮的调度与超时改动不波及它，但反过来说它只能产出纯文本简报。若将来给幕僚开工具，必须复用同一套闸门、超时与结果封顶，不能另起执行路径。
2. **版本账已补齐**：`505511f`（路由组 / d.49）与 `6e79fc6`（d.50）此前未 bump、未进 CHANGELOG，本轮合并为 `d.50.1.12.0` 一次性补记（特性 +2、修订 +1），不另造虚拟版本号。
3. **仍然缺的**（不在本轮范围）：沙箱与执行隔离、`apply_patch` 编辑原语、按需工具发现（`tool_search` 式）、回合日志的恢复/分叉（只读面板已做）。

**复核口径**：以 `git diff 23a0c41..6e79fc6` 为界核对旧清单，再以本轮改动为准销账；行号会漂移，按符号名（`MAX_TOOL_ROUNDS`、`MAX_TURN_TOOL_TOKENS`、`executeToolCall`、`foldToolResults`、`createRolloutLog`）检索。
