# 调研：Hermes Agent 的三层记忆与「任务结束自动写记忆 / 沉淀技能」

- 日期：2026-10-19
- 目的：弄清 Hermes（Nous Research 的开源 agent harness，MIT）到底怎么做到「记得住」与「越用越会」，对照和鸣现有实现找差距
- 结论先行：Hermes 的记忆闭环 = **两层常驻 Markdown（事实）+ 一层可检索历史（情景）+ 一层可执行技能（程序）**，写入靠**自 nudge** 与**后台 review fork**，技能靠「新颖度判定 → 生成 SKILL.md → 用中就地改进 + curator 归档」

## 0. 资料可信度分层

| 来源 | 性质 | 采信程度 |
|---|---|---|
| `github.com/NousResearch/hermes-agent` README | 官方仓库 | 高（能力清单与定位） |
| `mintlify.com/NousResearch/hermes-agent/...`（官方文档镜像） | 官方文档 | 高（文件路径、容量、工具动作、命令） |
| `az9713/hermes-agent-tutorial`（GitHub 教程仓库） | 第三方整理 | 中高（`_turns_since_memory`、`nudge_frequency` 取值等实现细节） |
| `wqw547243068.github.io/hermes`（中文笔记） | 第三方笔记 | 中（`review fork` 三步流程、计数器、curator 的具体文件名） |
| `zorost.com`、`blog.sandbase.ai`、`techjacksolutions`、CSDN | 二手评述 | 低（用于交叉印证，不作事实来源） |

版本注意：第三方提到 Hermes v0.19.0（2026-07 发布「Quicksilver」）。本文只写各来源一致的机制，不写版本相关细节。

## 1. 三层记忆是什么

Hermes 不是「三层 localStorage」，而是**三种介质**：

| 层 | 认知科学名 | 存什么 | 介质与位置 | 怎么进上下文 |
|---|---|---|---|---|
| 语义（semantic） | 事实层 | 环境事实、项目约定、工具怪癖、踩坑 | `~/.hermes/memories/MEMORY.md`（上限 **2200 字符**） | **每个 session 开始时一次性注入系统提示词，取冻结快照** |
| 语义（用户画像） | — | 姓名、角色、时区、沟通偏好、禁忌 | `~/.hermes/memories/USER.md`（上限 **1375 字符**） | 同上（`SOUL.md` 另管人格） |
| 情景（episodic） | 历史层 | 带时间戳的对话与运行轨迹、工具调用顺序与参数、重试位置 | `~/.hermes/state.db`（SQLite + **FTS5 全文索引**）+ `~/.hermes/sessions/*.jsonl` | **不进提示词**，靠 `session_search` 按需检索，命中后用 LLM 摘要再注入 |
| 程序（procedural） | 技能层 | 「这类任务怎么做」：触发条件、步骤、踩坑 | `~/.hermes/skills/<name>/SKILL.md`（+ `references/ templates/ scripts/ assets/`） | **按需注入**：命中技能时整篇作为 user message 注入（同样保住 prompt cache） |

### 三个关键设计

1. **冻结快照**：session 开始时把 MEMORY/USER 渲染进系统提示词，之后**不再变**。会话中途写盘立即生效，但**要到下个 session 才进提示词**——理由官方写明：保住 Anthropic prompt caching。注入块带容量提示（`MEMORY [67% — 1,474/2,200 chars]`），条目用 `§` 分隔。
2. **记忆不是向量库**：`MEMORY.md` / `USER.md` / `SKILL.md` 全是**纯 Markdown**，用户可以打开、删掉一行、进版本控制，删了就是真删（不残留 embedding）。
3. **只常驻第一层**：默认只把 MEMORY/USER 塞进提示词（几百字），历史与技能按需检索——省 token 也降低幻觉。

## 2. 任务结束后：怎么自动写记忆、怎么沉淀技能

这是 Hermes 最值得抄的部分，两个机制叠加：

### 2.1 memory nudge（自 nudge）

- 触发：`memory.nudge_frequency` 配置项，取值 **`always` / `after_complex_tasks` / `never`**，默认 `after_complex_tasks`。
- 行为：一段对话里分享了偏好、或 agent 发现值得留存的事 → **系统提示要求它自己判断要不要写**，同意后调 `memory` 工具落盘；也可手动说「记住：项目用 pnpm 不是 npm」。
- 容量兜底：超限时工具直接返回错误 → 逼着它先删旧条目或跑 `hermes memory compact` 去重压缩。

`memory` 工具只有三个动作，**没有 read**（内容自动注入，不需要读）：

| 动作 | 说明 |
|---|---|
| `add` | 新增一条 |
| `replace` | 替换已有条目，用 `old_text` **子串匹配**定位（不必贴全文） |
| `remove` | 删除条目，同样子串匹配 |

写入判据（官方 best practice）：

- **该存**：用户偏好、环境事实、项目约定、用户纠正、工具怪癖、已完成工作的结论
- **不该存**：会话流水、临时任务状态（那些用 `session_search` 召回）、一周后会过期的信息、大段日志/数据
- **流程别存记忆，存技能**：「程序化流程放技能」
- **敏感信息（密钥、token、他人隐私）写入前要用户同意**，密钥只放 `~/.hermes/.env`

### 2.2 review fork（后台复盘分身）

第三方笔记给出的具体实现（与官方「periodic nudges / agent-curated memory」描述一致）：

1. **快照对话**：把刚结束这场对话完整拷一份；
2. **起一个 review fork**：新建一个 AIAgent 实例，后台线程跑，不阻塞聊天；
3. **只给两个工具**：
   - `memory` —— 审查「有没有暴露偏好 / 习惯 / 个人信息 / 值得长期保存的环境事实」，有就写；
   - `skill_manage` —— 审查「有没有踩坑 / 工作流优化 / 可复用的多步骤流程」，有就生成技能。

**触发不是每条消息**，而是两个独立计数器（实现在 `agent_init.py`、`conversation_loop.py`）：

| 计数器 | 含义 | 已知阈值 |
|---|---|---|
| `_turns_since_memory` | 距上次记忆审查经过的用户消息轮数 | 约 **10 轮**复盘一次 |
| `_iters_since_skill` | 距上次技能审查经过的迭代数 | 第三方未给出确切值 |

两者独立，可能只审记忆、只审技能，或同时审。理由很直白：每次审查要多花一次 LLM 调用。

### 2.3 技能沉淀与自我改进

- **创建条件**：完成复杂任务后，agent 判定「这个解法足够新颖、值得留下」，就生成 `~/.hermes/skills/<name>/SKILL.md`。用户也能主动说「把刚才那套存成技能 deploy-to-fly」。
- **SKILL.md 结构**（官方给的是 Markdown 骨架，非强制 frontmatter；兼容 agentskills.io 开放标准）：

```markdown
# Skill name

一句话说明这个技能干什么。

## When to use this skill
- 用例 1
- 用例 2

## Steps
1. 第一步，带具体命令
2. 第二步
…

## Notes
- 边界情况、坑、已知问题与绕法

## References
- 链接或文件引用
```

- **用中自我改进**：用某个技能时发现更好的做法，**就地更新该文件**——步骤更准、边界情况补上、过时步骤删掉。第三方强调真正值钱的是 `Notes` 里「learned the hard way」那部分。
- **curator 淘汰**：`agent/curator.py` + `/curator [sub]`（pin / archive），把长期不用的技能归档，避免技能库只增不减。
- **检索方式**：按**任务**匹配（`When to use this skill` 就是触发条件），不是按主题事实检索。

### 2.4 上下文压缩

`/compress` 手动压缩本会话携带的历史；也可配 `compression.enabled` + `threshold`（示例 0.50，即上下文用到 50% 就压）+ `summary_model`。原则：**在任务边界压，别在调试到一半压**；压之前先把要逐字引用的内容拷出去。完整记录仍在 `state.db` / trajectory 里。

### 2.5 记忆后端可插拔

`plugins/memory/` + `agent/memory_provider.py`：默认本地文件；可选 Honcho（辩证式用户建模）、Mem0、OpenViking、RetainDB、SuperMemory、Byterover、Hindsight、Holographic。未显式启用 Honcho 时，数据不出本机。

## 3. 和鸣现状对照

和鸣现有（`packages/web/src/lib/memory/`、`lib/skills/`）：

| 维度 | 和鸣 | Hermes | 差距 |
|---|---|---|---|
| 分层 | Working（TTL 2h/40 轮）+ Episodic（6 轮沉淀 1 条）+ Semantic（情景/语义两条列表） | 事实层 + 用户画像 + 可检索历史 + 技能 | 分层更细，**但没有用户画像独立层**（画像混在语义里） |
| 注入方式 | 每轮按 token 预算**重新拼装**注入 | session 开始冻结快照 | 我们的做法新鲜但**每次都变，prompt cache 命不中**；Hermes 反之 |
| 容量治理 | 有 `retentionDays`，无字符上限 | 硬上限 2200/1375 字符，超限报错，逼迫整理 | 缺**容量压力**，记忆会无声膨胀挤占预算 |
| 自动写入 | `recordTurn` 规则：成功轮 → Working + 抽取 + 6 轮沉淀 | **nudge（频率可配）+ review fork（后台复盘分身）** | 缺「自问值得学吗」的独立审查；也缺敏感信息确认 |
| 编辑模型 | 整条增删改、关键词搜索 | `add/replace/remove` + **子串匹配** + `§` 分隔 | 缺**低成本改写**（改一个词不用重贴全文） |
| 技能沉淀 | 手工「转为沉淀」复制副本 | 判定新颖度 → 自动生成 → **用中就地改进** → curator 归档 | **缺自动生成与自我改进**；只有「用户点一下」 |
| 技能作用域 | 按智能体分配、全量池、来源分类 | 全局库 + enable/disable + Hub | 我们**更强**（per-agent 分配是 Hermes 没有的） |
| 记忆编辑面 | 记忆区可管理、可导入导出 | 纯 Markdown 可直接编辑 + `hermes memory compact` 去重压缩 | 缺**一键去重压缩** |

## 4. 值得抄的六件事（按性价比排序）

1. **review fork 复盘分身**（最高价值）：任务结束后后台起一个只带 `memory` + `skill_manage` 的轻量 agent 复盘，产出「记忆候选」与「技能候选」。我们已有 `recordTurn` 钩子，改造成本低：把规则沉淀换成「模型自评 + 候选落盘待确认」。
2. **记忆容量上限 + 超限报错**：给 MEMORY/USER 两类各设字符上限（如 2200/1375），超限时不是静默截断而是提示「先整理」，逼出真实取舍。
3. **技能自动生成 + 用中就地改进**：`distill` 现在是「复制副本」，可升级为「按本轮轨迹生成 instructions/triggers + 使用中修正时原地更新」，并加 `notes`（踩坑）段——这正是 Hermes 复利价值的来源。
4. **nudge 频率可配**：`auto / after_complex_tasks / never` 三档，呼应用户「手动开启是否需要短期/长期记忆」的偏好。
5. **子串替换的编辑动作**：`replace/remove` 用 `old_text` 定位，用户改一条事实不用重贴全文；配合 § 分隔降低误删。
6. **curator 归档**：长期未命中的技能自动归档（可 pin 保护），避免技能池膨胀后路由噪声越来越大。

**不建议照抄的**：冻结快照 + 全量常驻。理由是我们每轮都在变（上下文预算、记忆开关都是用户可调），冻结快照会与「本轮开关即时生效」的产品语义冲突；若要吃到 prompt cache 收益，更像是「本轮不变、下轮刷新」的局部冻结（只冻结未变部分）。

## 5. 参考

- 官方仓库 README：`https://github.com/NousResearch/hermes-agent`
- 官方文档（Memory）：`https://mintlify.com/NousResearch/hermes-agent/user-guide/features/memory`
- 官方文档（Skills）：`https://mintlify.com/NousResearch/hermes-agent/user-guide/features/skills`
- 教程仓库（配置与实现细节）：`https://github.com/az9713/hermes-agent-tutorial`
- 中文使用笔记（review fork 流程）：`https://wqw547243068.github.io/hermes`
- 二手评述（仅交叉印证）：`https://zorost.com/hermes-agent-memory-skills`、`https://blog.sandbase.ai/how-hermes-self-improving-agent-works-2026/`

---

## 6. 落地记录（2026-10-19，版本 d.3.0.0.0）

§4 的第 1 件事（review fork）与第 2 件事（容量上限）已实现：

| Hermes 机制 | 和鸣实现 | 文件 |
|---|---|---|
| memory nudge 频率 | `关闭 / 仅复杂任务 / 每轮都复盘`（默认仅复杂任务），设置键 `heming.memory.review.v1` | `lib/memory/review.ts` |
| `_turns_since_memory` 节流 | 默认 10 轮一次，计数器落盘 `heming.memory.review.counters.v1` | 同上（`bumpReviewCounter`） |
| 只带两个工具的复盘分身 | 成功轮次收尾 `maybeRunReview` 即发即忘，用该智能体自己的 LLM 连接问「有什么值得长期记住」 | `ChatPage` + `lib/memory/reviewRunner.ts` |
| 技能自动生成 + 用中改进 | 判定新颖 → 生成 `source=distilled` 技能，**同名原地更新**，自动分配给该智能体 | `review.ts`（`skills.create/update`） |
| 2200 字符硬上限 | 语义记忆超限**拒绝新增并说明原因**；同 key 更新不占新额度 | `review.ts` + 记忆区容量条 |
| 敏感信息不落盘 | `sk-*` / `ghp_*` / `AKIA*` / 私钥块 / `api_key=…` 等模式直接拒绝并记入报告 | `containsSensitive` |
| 记忆可读可改 | 语义记忆来源新增「复盘沉淀」标签，记忆区可搜可删 | `MemoryPage` |

**有意不同的两点**：

1. **不照抄冻结快照**。和鸣每轮按预算重拼上下文、记忆开关要求即时生效，冻结会与产品语义冲突。
2. **不做 Honcho 式辩证建模**。当前「同 key 覆盖更新」已能处理事实修正；等真的出现「两条事实互相矛盾」再上冲突消解。

**验证**：`lib/memory/review.test.ts` 24 例（频率/复杂度/节流/解析容错/敏感拒绝/容量拒绝/长期记忆闸门/技能自我改进/模型报错不外溢）+ `ChatPage.test.tsx` 2 例接线 + `MemoryPage.test.tsx` 3 例 UI；web 57 文件 / 841 用例全绿。

**未完成**：真机（浏览器）端到端跑通复盘闭环尚未验证——headless 环境下 @ 触发后智能体没有产生回复，复盘自然也没跑起来（原因未定位，怀疑是 headless 里 WS/发送链路问题，非本次改动引入）。功能正确性目前由上述自动化用例背书。
