# 12 多智能体编排与任务拆解

> 研究笔记 · 证据全部来自公开一手材料；带引号的数字/句子为原文照抄，URL 附在每处结论后。

---

## 0 结论先行

**一句话：多智能体买的不是"更聪明"，而是"并行度 + 上下文隔离"；当任务强耦合、需要共享同一份上下文、或错误代价不可回收时，单线程 agent + 好工具几乎总是更优。**

四条例证，按证据强度排：

1. **默认规则**：Cognition 把两条原则抬到"默认排除不满足它们的架构"的高度——"Share context, and share full agent traces, not just individual messages" 与 "Actions carry implicit decisions, and conflicting decisions carry bad results"，并写道 "I would argue that Principles 1 & 2 are so critical, and so rarely worth violating, that you should by default rule out any agent architectures that don't abide by them."（[Don't Build Multi-Agents](https://cognition.com/blog/dont-build-multi-agents)，2025.06.12）
2. **唯一被量化的正面案例也很贵**：Anthropic 的多智能体研究系统在内部研究评测上比单 agent Claude Opus 4 高 **90.2%**，代价是"agents typically use about 4× more tokens than chat interactions, and multi-agent systems use about **15×** more tokens than chats"，而且同一篇文章明确说强耦合场景不适合（[How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system)）。
3. **规模能换来吞吐，但换不来"自协调"**：Cursor 的系统峰值 **"~1,000 commits per hour across 10M tool calls over a period of one week"**；而它最早那版平等 agent 共享状态文件的自协调方案，"**20 agents would slow to the throughput of 1-3** with most time spent waiting on locks"（[Towards self-driving codebases](https://cursor.com/blog/self-driving-codebases)，2026.02.05）。
4. **工程界的共识是"先别加复杂度"**：Anthropic 建议 "finding the simplest solution possible, and only increasing complexity when needed"，并指出 "For many applications, however, optimizing single LLM calls with retrieval and in-context examples is usually enough"（[Building effective agents](https://www.anthropic.com/engineering/building-effective-agents)）。

### 来源取用状态（6 个指定 URL）

| # | URL | 状态 | 用途 |
|---|---|---|---|
| 1 | https://cognition.com/blog/dont-build-multi-agents | 已取全文 | 反对多智能体的两条原则、Flappy Bird 反例、Claude Code 子代理观察 |
| 2 | https://www.anthropic.com/engineering/multi-agent-research-system | 已取（重定向到 /research/） | 90.2%、15×、80%/95% 方差、失败模式、judge |
| 3 | https://www.anthropic.com/engineering/building-effective-agents | 已取全文 | workflow vs agent、5 种 workflow 模式、"最简优先" |
| 4 | https://cursor.com/blog/self-driving-codebases | 已取全文 | 自协调失败、最终递归架构、handoff、去 integrator、吞吐与错误率 |
| 5 | https://openai.com/business/guides-and-resources/a-practical-guide-to-building-ai-agents/ | **未取到正文**（PDF 为 `application/pdf` 不支持；HTML 只返回页头）；PDF 同样未取到 | 以 OpenAI Agents SDK 文档 [Agent orchestration](https://openai.github.io/openai-agents-python/multi_agent/) 替代 |
| 6 | https://langchain-ai.github.io/langgraph/concepts/multi_agent/ | **未取到正文**（跳转后 docs.langchain.com 页面仅返回导航、原路径 404） | 仅作拓扑命名参照，未采用其正文结论 |

补充来源：Anthropic [Effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)（"1,000-2,000 tokens" 出处）、OpenAI [Agent orchestration](https://openai.github.io/openai-agents-python/multi_agent/)。

---

## 1 判据：什么时候值得，什么时候不要

### 1.1 六个维度做判断

| 维度 | 加分（倾向多智能体） | 减分（倾向单 agent） | 证据 |
|---|---|---|---|
| 并行性 | 子任务彼此独立、可同时推进（广度优先检索、多文件独立改动） | 强依赖、必须串行确认（大多数编码任务） | Anthropic：多智能体"excel especially for breadth-first queries"，而 "most coding tasks involve fewer truly parallelizable tasks than research" |
| 上下文隔离 | 探索量巨大（读几十上百个来源），主 agent 只需结论 | 需要所有 agent 共享同一份上下文/依赖关系密 | Anthropic："some domains that require all agents to share the same context or involve many dependencies between agents are not a good fit"；Cognition 原则 1 |
| 审查独立性 | 需要独立视角（不同 prompt/不同模型审代码、投票） | 审查者必须看到完整决策链才有意义 | Anthropic 的 parallelization/voting；Cognition 原则 2（动作隐含决策，独立审查者看不到决策就只会挑表面） |
| 协调成本 | 有现成的任务边界与验收标准 | 边界模糊、需要频繁协商 | Cognition Flappy Bird：两个子代理各自基于"冲突的假设"做出风格不一致的产物 |
| 调试难度 | 可观测（全量 trace、按 agent 重放） | 无 trace、错误在 agent 间传递 | Anthropic："Agents make dynamic decisions and are non-deterministic between runs"；Cursor 建了完整日志回放才调得动 |
| token 倍数 | 任务价值高到能覆盖 15× 成本 | 成本敏感 | Anthropic：多智能体 "about 15× more tokens than chats" |

### 1.2 "不要用"的硬信号（出现任意两条就停手）

1. **子任务之间需要共享隐性决策**。Cognition 的判据是"动作即决策"：两个 worker 各自选了配色/命名/错误处理风格，最后拼起来必然割裂。它的结论不是"多沟通"，而是"今天不要让它们沟通"——"agents today are not quite able to engage in this style of long-context proactive discourse with much more reliability than you would get with a single agent"。
2. **主 agent 无法把上下文完整交出去**。Cognition 观察到 Claude Code 的子代理 "never does work in parallel with the subtask agent, and the subtask agent is usually only tasked with answering a question, not writing any code"——因为子代理缺少主 agent 的上下文，"if they were to run multiple parallel subagents, they might give conflicting responses"。
3. **任务本质是"边做边定"**。Anthropic 的 workflow 分类里，orchestrator-workers 只适合 "complex tasks where you can't predict the subtasks needed"，而如果路径完全可预先定义，用 prompt chaining/routing 这类确定性 workflow 更稳。
4. **错误不可回收**。Cursor 的吞吐是建立在"允许小错误率 + 定期 reconciliation"之上的（见第 4.3 节）；如果每次提交都必须 100% 正确，多智能体的并行收益会被串行化吃干净。
5. **没有可观测性与回放入口**。Anthropic 明确 "Adding full production tracing let us diagnose why agents failed"，没有 trace 的多智能体基本等于不可调试。

### 1.3 token 经济学：为什么"多开几个 agent"不是免费的

Anthropic 的量化最值得记：在 BrowseComp 上，"three factors explained **95%** of the performance variance"，其中 "token usage by itself explains **80%** of the variance"，另两个因素是工具调用次数与模型选择。这解释了多智能体为什么有效——它本质上是在**用更多 token 换并行推理容量**；也解释了它为什么贵——"agents typically use about 4× more tokens than chat interactions, and multi-agent systems use about 15× more tokens than chats"。

推论（综合）：多智能体本质是**用 token 换并行推理容量**，先确认单 agent 的瓶颈是"上下文/预算不够"再拆；若只是"没想清楚"，拆成 5 个只会放大 5 份糊涂。

---

## 2 三个被实证打脸的直觉

### 2.1 "子代理能并行干活" —— 但产出会互相冲突

Cognition 的 Flappy Bird 例子值得整段抄下来当反面教材：任务被拆成"做背景和碰撞盒"与"做可上下移动的小鸟"，结果 "subagent 1 actually mistook your subtask and started building a background that looks like Super Mario Bros. Subagent 2 built you a bird, but it doesn't look like a game asset and it moves nothing like the one in Flappy Bird"，最后主 agent 的活变成了"收拾两份误解"。补上完整上下文后会好一点，但仍会出现"视觉风格不一致"——因为两个子代理看不到对方的动作，各自做了未被规定的假设。

对策不是"多开会"，而是 Cognition 给的两条原则：共享完整 trace（不是只共享任务描述），以及承认"动作即决策"，把决策权收敛到单一线程。

### 2.2 "多智能体适合写代码" —— 恰恰相反

Anthropic 的原文很直接：多智能体适合"valuable tasks that involve heavy parallelization, information that exceeds single context windows, and interfacing with numerous complex tools"；反过来，"most coding tasks involve fewer truly parallelizable tasks than research, and LLM agents are not yet great at coordinating and delegating to other agents in real time."。

这也解释了为什么 Claude Code 长期只用"子代理做调研、主代理写代码"的保守结构（Cognition 的观察）。代码任务的耦合点在文件/接口/类型上，而这些恰恰是最难通过自然语言 handoff 保真的部分。

### 2.3 "让 agent 自己协调" —— 锁竞争 + 搭便车，吞吐反降

Cursor 的第一版：所有 agent 平等，读写一个共享 coordination 文件，自己决定做什么。失败得很快——"Agents held locks for too long, forgot to release them, tried to lock or unlock when it was illegal to"，"**20 agents would slow to the throughput of 1-3** with most time spent waiting on locks"。换成乐观并发控制后开销下降但混乱没消失。更隐蔽的失败是**搭便车/避险**："The lack of structure between agents meant no single agent took on big, complex tasks. They avoided contention and conflict, opting for smaller and safer changes versus taking responsibility for the project as a whole."

结论：**自由协商不是免费的协调，而是把协调成本转嫁给了每个 agent 的推理**。正确的做法是"显式角色 + 单一 owner"（见 3.3/3.4）。

---

## 3 五种拓扑与各自的失败模式

Anthropic 把 agentic system 分成 workflow（代码预定路径）与 agent（模型自主决策）两类，并列出五种 workflow 模式：prompt chaining、routing、parallelization（sectioning/voting）、orchestrator-workers、evaluator-optimizer（[Building effective agents](https://www.anthropic.com/engineering/building-effective-agents)）。把它们与真实系统对照，可归成下表五种拓扑。

| 拓扑 | 典型实现 | 适合 | 主要失败模式 | 对策 |
|---|---|---|---|---|
| ① 单 agent + 工具 | 一个循环：LLM → 工具 → 观察 → 再决策 | 绝大多数任务；尤其编码 | 长任务上下文溢出、目标漂移 | compaction / 笔记 / 子代理只做检索（Anthropic context engineering） |
| ② Orchestrator–worker | 主 agent 动态拆解、并行子代理、自己汇总 | 广度优先研究、多来源检索 | 拆得太碎（"spawning 50 subagents for simple queries"）、重复劳动、结果质量参差 | 显式 effort 规则（3-10 次工具调用 = 1 个 agent） |
| ③ Pipeline / 角色流水线 | planner → executor → workers → judge，顺序推进 | 流程稳定、阶段可验收 | 被最慢环节卡住；上游计划过时 | 去掉固定 planner、让 owner 动态重规划（Cursor 的连续 executor） |
| ④ 递归规划 | 根 planner → 子 planner（递归）→ worker，worker 之间不通信 | 超大工程、需要持续吞吐 | 规划层级过深、goal 在传递中失真 | handoff 双向（结果回传给发起者）、显式 scope 边界 |
| ⑤ 群聊 / 自协调 | 平等 agent 共享状态文件/互相发消息 | 理论上灵活 | 锁竞争、搭便车、决策分散、无法共享上下文 | 不要用于生产；若要试，加 owner 与串行化关键区 |

### 3.1 单 agent + 工具：被低估的基线

Anthropic 的原则是"先找最简解"，理由是复杂度会带来延迟与成本，而且"optimizing single LLM calls with retrieval and in-context examples is usually enough"；只有在需要"flexibility and model-driven decision-making"时才上 agent。Cognition 更进一步：单线程线性 agent 的上下文是连续的，是"the simplest way to follow the principles"。

失败模式与对策都清晰：上下文溢出用 compaction（把对话摘要后重开窗口，Claude Code 会保留"the five most recently accessed files"）、跨会话用结构化笔记、检索量大用"子代理只回摘要"（1,000–2,000 token，见 8.2 节）。

### 3.2 Orchestrator–worker：Anthropic 研究系统的形状

结构：lead agent 规划 → 并行 spawn 子代理 → 子代理各自检索 → 回传压缩后的发现 → lead 汇总，必要时再来一轮（[multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system)）。

- 好的地方：子代理"act as intelligent filters"，用自己的上下文窗口并行探索，主 agent 只吃压缩结果；官方称并行工具调用（lead 并行 3-5 个子代理、子代理并行 3+ 工具）"cut research time by up to 90% for complex queries"。
- 失败模式一：过度拆分。早期版本 "spawning 50 subagents for simple queries"。
- 失败模式二：任务描述太短导致重复劳动。原文例子：一个子代理研究 2021 汽车芯片危机，另外两个重复调研 2025 供应链——"without an effective division of labor"。
- 对策：每个子任务必须给 "an objective, an output format, guidance on the tools and sources to use, and clear task boundaries"；并把 effort 与复杂度绑定（见 4.1）。

### 3.3 Pipeline / 角色流水线：Cursor 的中间形态

Cursor 在放弃自协调后做的第一版是：planner 出计划 → executor 成为唯一 owner 负责交付 → executor spawn worker 线性扩吞吐 → 独立 judge 判断是否完成、要不要再来一轮。它解决了协调问题（"Having a single role dedicated to owning and overseeing execution allowed workers to focus narrowly on their task"），但暴露出流水线的经典缺陷：

- "we found this system to be bottlenecked by the slowest worker. It was too rigid."
- 计划一次性做完，无法随发现动态调整："Some agents would end up going in counterproductive directions, unable to self-correct until the next iteration of the loop."

于是下一步是去掉独立 planner，让 executor 自己规划（连续 executor），这一步又引入新问题：一个人兼了 "plan, explore, research, spawn tasks, check on workers, review code, perform edits, merge outputs, and judge if the loop is done" 八个角色，"it was being given too many roles and objectives simultaneously"。

**教训**：流水线的收益来自"阶段可验收"，代价是"刚性 + 慢环节放大"；解法不是加更多阶段，而是减少角色数、把判断权交给有全局视野的单点。

### 3.4 递归规划：Cursor 最终形态

最终架构三条（[Cursor](https://cursor.com/blog/self-driving-codebases)）：

1. 根 planner 拥有用户指令的完整 scope，只产出"specific, targeted tasks"，自己不写代码，也不知道任务被谁接走。
2. 当 planner 觉得 scope 可以再分，就 spawn 子 planner，子 planner "fully own the delegated narrow slice"，递归下去。
3. worker 只对单个任务负责到底，"They're unaware of the larger system. They don't communicate with any other planners or workers."，各自在**自己的 repo 副本**上工作，完成后写一份 handoff 交给发起它的 planner。

这套结构的关键不是递归，而是**信息只沿所有权链上下流动**：worker 不横向通信，避免决策冲突；planner 持续收到 handoff，"propagating information up the chain to owners with increasingly global views, without the overhead of global synchronization or cross-talk"。官方说这"does represent how some software teams operate today"。

### 3.5 群聊 / 自协调：为什么它是最先该被排除的

证据有三层：

- 机制层：共享状态文件 + 锁 → 锁持有过久/忘记释放/非法加锁，"Locking is easy to get wrong and narrowly correct, and more prompting didn't help"。
- 吞吐层：20 agents → 1-3 的等效吞吐。
- 行为层：避险与搭便车，没人对整体负责。

理论层还有 Cognition 的判断："the decision-making ends up being too dispersed and context isn't able to be shared thoroughly enough between the agents"，并预言这要等单线程 agent 的沟通能力足够强才会"come for free"。

---

## 4 任务拆解：粒度、递归与验收

### 4.1 用"预算"而不是"清单"来控制粒度

Anthropic 把 effort 写进 prompt，而不是靠模型自觉："Simple fact-finding requires just 1 agent with 3-10 tool calls, direct comparisons might need 2-4 subagents with 10-15 calls each, and complex research might use more than 10 subagents with clearly divided responsibilities." 另一处更具体：lead agent 并行 3-5 个子代理、子代理并行 3+ 工具。

Cursor 的经验是从反面补的：指令写"generate many tasks"只会得到很保守的少量任务；写 **"Generate 20-100 tasks"** 才会真的铺开——"conveys the intent is larger scope, it should be ambitious"。

### 4.2 拆解的四个可操作判据

综合两份一手材料（并标注哪些是原文、哪些是本人归纳）：

1. **一个任务 = 一次可独立验证的交付**（归纳）。Cursor 的 worker 只对"一个 task 驱动到完成"负责，planner 交付物是 "specific, targeted tasks"。
2. **任务边界要写进任务本身**（原文）：Anthropic 要求每个子任务带 "clear task boundaries"，否则 "agents duplicate work, leave gaps, or fail to find necessary information"。
3. **并行度由依赖决定，不由数量决定**（归纳）。Cursor 允许几百个 agent 并行，是因为每个 worker 有自己的 repo 副本；一旦共享文件/锁，并行就退化成排队（20→1-3）。
4. **拆分必须伴随共同的验收口径**（原文/归纳混合）。Anthropic 的每个子代理要"output format"；Cursor 的 handoff 要写清 "concerns, deviations"。

### 4.3 吞吐与正确性的显式交换

Cursor 最重要的工程结论：当要求"每次提交 100% 正确"时，"it caused major serialization and slowdowns of effective throughput. Even a single small error, like an API change or typo, would cause the whole system to grind to a halt"，并且出现"越权修无关问题、多个 agent 互相踩踏"。

他们的选择是接受小错误率："The error rate remains small and constant, perhaps rarely completely clean but steady and manageable, not exploding or deteriorating."，并保留一条"绿色分支"：需要 "a final 'green' branch ... where an agent regularly takes snapshots and does a quick fixup pass before release"。

这给任务拆解的启示是：**拆解粒度应与"错误可回收性"匹配**。可回滚、可重跑的仓库（分支/副本/快照）才能支撑细粒度并行；否则并行度必须降下来换确定性。

---

## 5 Handoff / 报告契约

### 5.1 两个一手来源给出的字段

Cursor 的 handoff（原文）："The handoff contains not just what was done, but important notes, concerns, deviations, findings, thoughts, and feedback. The planner receives this as a follow-up message."——即 **what was done / notes / concerns / deviations / findings / thoughts / feedback** 七类，并且是**异步回传**（发起者继续收到更新、继续决策），不是一次性返回值。

Anthropic 对"委派描述"的要求（原文）：每个子代理需要 "an objective, an output format, guidance on the tools and sources to use, and clear task boundaries"——即 **objective / output format / tools & sources guidance / boundaries** 四项。

Anthropic 还给了两条进阶做法：把子代理产出**落到文件系统**再回传轻量引用（"Subagents call tools to store their work in external systems, then pass lightweight references back to the coordinator"），以减少"传话游戏"的信息损失；以及上下文接近上限时"spawn fresh subagents with clean contexts while maintaining continuity through careful handoffs"。

### 5.2 建议的最小 handoff schema（综合，非原文）

| 字段 | 必填 | 说明 | 反面 |
|---|---|---|---|
| `task_id` / `parent_id` | 是 | 可追溯、可去重 | 只有自由文本，无法对账 |
| `objective` | 是 | 一句话目标 + 验收标准 | "优化一下性能" |
| `scope` | 是 | 允许改什么、明确不许改什么 | 无边界 → worker 越权 |
| `artifacts` | 是 | 分支/提交/文件路径/PR 号 | 把大段代码贴进 handoff |
| `status` | 是 | done / partial / blocked | 谎报完成（Cursor 提到 "claim premature completion"） |
| `decisions` | 是 | 做的关键取舍及理由 | 只写"做完了" |
| `deviations` | 是 | 偏离计划的点 | 偏离被隐藏，最终集成时才炸 |
| `concerns` / `risks` | 是 | 已知隐患、未覆盖场景 | 沉默地把坑留给下游 |
| `findings` | 否 | 对后续有用的发现 | — |
| `evidence` | 是 | 测试命令与结果摘要（不是全量日志） | 让 owner 重新验证一遍 |
| `next_actions` | 否 | 建议后续任务 | — |
| `confidence` / `blocked_by` | 否 | 置信度、外部阻塞 | 下游误判可并行 |

### 5.3 反模式

- **把完整 trace 当 handoff**：Cognition 要求共享完整上下文是给"同一决策线程"的，不是让每个 worker 读一遍所有人的日志；Anthropic 的做法相反——压缩到 1,000–2,000 token 摘要或文件引用。
- **handoff 只写结果不写偏离**：Cursor 明确把 "deviations" 列进 handoff，因为 planner 需要据此重新规划。
- **单向 handoff**：Cursor 的 handoff 是"follow-up message"，planner 收到后仍可继续派活；一次性 RPC 式返回会让系统在 worker 完成后停滞。

---

## 6 并发、深度与协调成本

### 6.1 并发数：不是越多越好，而是"有多少独立上下文"

- Anthropic：lead 并行 **3-5** 个子代理、子代理并行 **3+** 个工具；再往上不是不能，而是同步执行会形成瓶颈——"our lead agents execute subagents synchronously, waiting for each set of subagents to complete before proceeding. This simplifies coordination, but creates bottlenecks in the information flow between agents"，甚至"the entire system can be blocked while waiting for a single subagent to finish searching"。
- Cursor：几百个 agent 同机运行（"most runs would peak at several hundred agents"），但这是建立在"每个 worker 有自己的 repo 副本 + 单机大机器 + 完整日志"之上的；一旦共享资源（Git/Cargo 的共享锁、编译产物的磁盘 IO，最高 "many GB/s"）就会成为热点。
- 推论（归纳）：并发上限 ≈ min(独立任务数, 可隔离的工作副本数, 可观测/可回滚能力)。超过这个上限，多出来的 agent 只是在制造锁竞争。

### 6.2 深度：两层够用，三层是上限

- Anthropic 是两层（lead + subagent），并明确说异步化会带来 "challenges in result coordination, state consistency, and error propagation"。
- Cursor 允许 planner 递归 spawn 子 planner，但每一层都要求"完整拥有被委托的那一小片"，且 worker 不再向下委派。它的动机是"large projects and tasks where a single planner would otherwise get overwhelmed and develop tunnel vision"。
- 归纳建议：**深度 ≤ 3**；每增加一层，handoff 必须携带上一层的约束与验收口径，否则目标会在传递中漂移。

### 6.3 保新鲜（freshness）：长任务的隐性成本

Cursor 列了四条机制，可直接抄：① `scratchpad.md` 要频繁**重写**而不是追加；② agent 到上下文上限时自动总结；③ system prompt 里加自我反思与对齐提醒；④ 鼓励 agent 随时质疑假设、掉头。原因是长任务里"漂移"比"犯错"更致命——planner 若拿着过时状态继续规划，下游全错。

---

## 7 质量闸门：judge 与多模型 review 的真实效果

### 7.1 LLM-as-judge 怎么做才有效

Anthropic 的做法：一个 LLM judge 按 rubric 打分，维度包括 **factual accuracy / citation accuracy / completeness / source quality / tool efficiency**，并有一个关键发现——"We experimented with multiple judges to evaluate each component, but found that **a single LLM call with a single prompt outputting scores from 0.0-1.0 and a pass-fail grade was the most consistent and aligned with human judgements**"。

也就是说：**多 judge 未必更准，反而更不一致**；judge 的价值在于可规模化（"allowed us to scalably evaluate hundreds of outputs"）与可对齐（rubric 明确），而不是替代人。

### 7.2 人工评审仍然不可省

Anthropic 专门有一节叫 "Human evaluation catches what automation misses"，例子很具体：早期 agent 会优先选 SEO 内容农场而放弃学术 PDF/个人博客这类权威但排名低的来源；加来源质量启发式后才修正。另一个观察是：多智能体有"emergent behaviors"，"small changes to the lead agent can unpredictably change how subagents behave"，因此评测必须看交互模式，而不只是单 agent 行为。

### 7.3 什么时候该撤掉闸门

Cursor 的连续 executor 一度带独立 judge 判断"是否完成、要不要再来一轮"，后来直接移除："We found agents were reasonably good at following instructions to completion, so the judge was removed to keep the system simple."

这不是说 judge 无用，而是说 **judge 也是并发路径上的一个串行点**：当系统已经靠"所有权 + handoff + 绿色分支"保证收敛时，judge 带来的延迟可能大于收益。Anthropic 的替代方案是把评审前移——evaluator-optimizer 只用于"有清晰评估标准、且迭代能带来可测收益"的任务。

### 7.4 关于"LLM review 遗漏 87% 架构问题"

任务描述中提到"LLM review 87% 架构问题被遗漏"这一数字。**本次可获取的 6 个来源中未找到该原文**（见第 8.2 节），因此不引用、不作为结论。可确证的相邻事实只有：多 judge 不如单 judge 一致、人工评审能发现自动化漏掉的来源偏好、Cursor 用"绿色分支 + 定期 fixup"兜底。

---

## 8 清单与未验证

### 8.1 八条可落地清单

1. **先量再拆**：先确认单 agent 的失败是"token/上下文不够"还是"想不清楚"；只有前者值得多智能体（对应 Anthropic 的 80% 方差归因）。
2. **默认单线程**：除非能说清"哪些子任务彼此独立且可验证"，否则回到单 agent + 工具（Cognition 的 default rule out）。
3. **子任务描述四件套**：objective、output format、tools/sources guidance、task boundaries；缺一样就会出现重复劳动或空洞产出（Anthropic）。
4. **effort 写进 prompt**：1 agent / 3-10 次工具调用；2-4 子代理 / 10-15 次；>10 子代理需明确分工；需要铺开时给数量区间（"Generate 20-100 tasks"）。
5. **handoff 必带偏离与担忧**：decisions / deviations / concerns / artifacts / evidence 五样缺一不可，且要能异步回传给发起者（Cursor 七类字段的收敛版）。
6. **worker 之间不通信**：纵向汇报、横向隔离；共享文件区加 owner 或干脆每 worker 一份副本（Cursor 最终架构）。
7. **别加 integrator**：需要"一个全局闸门"时，先考虑把它变成 owner 的职责或发布前的定时 fixup，而不是所有工作流经的串行点（Cursor 的 integrator 教训）。
8. **闸门要能被撤**：judge 用单 prompt + rubric + 0.0-1.0 打分；当系统已有绿色分支与可回滚机制时，优先减延迟，把评审放到发布前而非每步（Anthropic 单 judge 结论 + Cursor 去 judge）。

### 8.2 未验证项与来源缺口

| 项 | 状态 |
|---|---|
| "LLM review 遗漏 87% 架构问题" | **未找到原文**；6 个来源均未出现该数字，本文不采用 |
| OpenAI《A practical guide to building agents》正文 | PDF 返回 `application/pdf` 不受支持；HTML 页只返回页头。本文改用 OpenAI Agents SDK 文档作替代，指南中的具体建议（如"先最大化单 agent"）**未逐字核实** |
| LangGraph multi-agent 概念页 | 指定 URL 跳转后 404；docs.langchain.com 对应页仅返回导航。五种拓扑的命名与分类**未采用该页正文**，改由 Anthropic/Cursor/OpenAI 材料支撑 |
| Anthropic "1,000-2,000 tokens" 子代理摘要 | 原文不在 multi-agent 研究文章，而在同机构 [Effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)，已按原出处引用 |
| Cursor 递归深度、handoff 具体格式（JSON/schema） | 博文只给自然语言描述，无字段级规范；第 5.2 节 schema 为本人归纳 |
| Anthropic 90.2% 与 Cursor 1,000 commits/h | 均为厂商自述的内部评测/单次运行，无第三方复现；应视为"方向性证据"而非基准 |
| "20 agents 退化到 1-3 吞吐" | Cursor 单方观察，未给测量方法；其价值在于机制解释（锁竞争）而非精确数字 |
| 异步多智能体（async subagents） | Anthropic 明确说尚未实现，只给了预期收益与三类风险；本文未给出工程方案 |

---

*笔记完。所有引用 URL 见文内链接；未取到的来源已在 0 节与 8.2 节标注，未做推测性补全。*
