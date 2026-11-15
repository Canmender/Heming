# 上下文与 Token 经济学：给 Agent Harness 作者的可落地笔记

> 读者：写 agent harness（提示装配、工具调度、上下文压缩、缓存管理）的工程师。
> 抓取日期 2026-11-15。数字均来自一手页面并附链接；没抓到的部分集中在第九节，未编造。
> 定位：**上下文不是"装进去就行"的输入，而是有价格、有衰减、有缓存命中率的资源。harness 的核心竞争力就是这套资源调度器。**

## 结论先行

1. **缓存命中率是生产级 agent 第一指标**：*"the KV-cache hit rate is the single most important metric for a production-stage AI agent"* —— [Manus](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)。它同时决定延迟与成本。
2. **token 结构严重偏斜**：Manus 实测平均 input:output ≈ **100:1**（同上）。省输入的杠杆比省输出大约 100 倍。
3. **缓存价差 10 倍**：Claude Sonnet 缓存输入 **0.30 USD/MTok** vs 未缓存 **3 USD/MTok**（同上）。前缀抖一下不是优雅问题，是账单问题。
4. **一个 token 的差异击穿其后全部缓存**；原文点名最常见错误是**把秒级时间戳放在系统提示开头**（同上）。这是头号成本 bug 的原型。
5. **越长越差，所有模型如此**：Chroma 在 **18 个模型**上做 **194,480 次**调用，*"model performance consistently degrades with increasing input length"* —— [Chroma](https://www.trychroma.com/research/context-rot)。
6. **"聚焦"完胜"全量"**：LongMemEval 上完整输入平均 **~113k token**、聚焦输入 **~300 token**（306 条 prompt），聚焦版全体模型更好（同上）。
7. **清理旧工具结果收益极大**：context editing 单独 **+29%**、叠加 memory tool **+39%**；100 轮网页检索中让本会失败的流程跑通且 **token −84%** —— [Anthropic](https://claude.com/resources/articles/context-management)。
8. **少给工具描述能直接砍 token**：Cursor 的 MCP 懒加载 A/B 中，调用过 MCP 的运行**总 token −46.9%** —— [Cursor](https://cursor.com/blog/dynamic-context-discovery)。
9. **工具可用性要"遮"不要"删"**：删定义会破坏前缀缓存并留下悬空调用；Manus 用 **mask**（logits 屏蔽）。
10. **超过 10–20 轮的自由循环会烂掉**：*"anything more than 10-20 turns becomes a big mess that the LLM can't recover from"* —— [12-factor](https://www.humanlayer.dev/blog/12-factor-agents)。对策是 5–10 步的 micro agent 嵌进确定性 DAG。

### 硬数字速查

| 指标 | 数值 | 来源 |
| --- | --- | --- |
| agent 平均 input:output | ≈ 100:1 | [Manus](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus) |
| 缓存 vs 未缓存输入价 | 0.30 vs 3 USD/MTok，**10x** | 同上 |
| Manus 重写框架次数 | 4 次 | 同上 |
| 缓存断点最小前缀 | **512–4,096 token**（Sonnet 5/4.6 = 1,024；Opus 4.5–4.7、Haiku 4.5 = 4,096；5.x = 512） | [Bedrock](https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html) |
| 每请求断点上限 / TTL | 4 个 / 默认 5 分钟，可选 1 小时，命中即重置 | 同上 |
| 回看窗口 | 断点前约 20 个 content block | 同上 |
| Context Rot 规模 | 18 模型 / 194,480 次调用 / 69 次拒答（0.035%） | [Chroma](https://www.trychroma.com/research/context-rot) |
| LongMemEval 输入 | 完整 ~113k vs 聚焦 ~300 token | 同上 |
| context editing | +29% / +39% / token −84% | [Anthropic](https://claude.com/resources/articles/context-management) |
| MCP 懒加载 | token −46.9% | [Cursor](https://cursor.com/blog/dynamic-context-discovery) |
| 子代理回传 | often 1,000–2,000 token（探索侧 tens of thousands） | [Anthropic](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) |

## 一、先接受物理约束：有限资源，边际收益递减

Chroma 的实验设计值得抄进回归测试：**18 个模型**（含 GPT-4.1、Claude 4、Gemini 2.5、Qwen3）× **8 种输入长度 × 11 个 needle 位置**，共 **194,480 次**调用，仅 **69 次**（0.035%）因拒答无效。结论只有一句：*"Across all experiments, model performance consistently degrades with increasing input length."*（[Chroma](https://www.trychroma.com/research/context-rot)）

关键不是"长上下文不能用"，而是**性能是连续斜坡不是断崖**。所以不该问"卡在多少 token 以下安全"，而该给每类内容定价：这段内容值多少 token、提高多少成功率。10k token 日志只为确认一个状态，就该换成 3 行摘要 + 一个可回查路径。

**机制层**（[Anthropic](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)）：① 注意力预算——n 个 token 有 n² 个成对关系，上下文越长这些关系被 *"stretched thin"*；② 训练分布——短序列远比长序列常见，模型对长程依赖"经验"更少，位置编码插值扩窗会牺牲位置精度。因此 *"Context ... must be treated as a finite resource with diminishing marginal returns."* 目标函数是 *"finding the smallest possible set of high-signal tokens that maximize the likelihood of some desired outcome"*——不是最短，是**信噪比最高**；这一点在压缩时会反咬：原文警告过激的 compaction 会丢 *"subtle but critical context"*。

**失效四型**（LangChain 转引 Drew Breunig，[链接](https://www.langchain.com/blog/context-engineering-for-agents)），可直接做成告警：

| 失效 | 定义 | 可观测信号 |
| --- | --- | --- |
| poisoning | 幻觉进入上下文并被后续当真 | 反复基于不存在的路径/ID 调工具 |
| distraction | 上下文淹没训练分布 | 同一工具被反复调、参数雷同 |
| confusion | 多余内容干扰回答 | 答非所问、混入无关字段 |
| clash | 上下文自相矛盾 | 模型在两个方案间摇摆 |

同一篇把 LLM 类比 CPU、窗口类比 RAM，定义 context engineering 为 *"delicate art and science of filling the context window with just the right information for the next step"*——**"for the next step"** 最关键：上下文是下一步的工作内存，不是会话档案馆。

**结构本身影响分数**：Chroma 发现打乱 haystack 句序后，**全部 18 个模型**都优于"有逻辑连贯"的原文（*"structural coherence consistently hurts model performance"*）；干扰项影响不均匀，单个 distractor 就掉分、4 个叠加更差；needle 与问题相似度越低，长上下文退化越快。所以**分节、标签、排序是上下文工程的一部分**：把"结论/待办"与"证据/日志"在结构上隔离，比混成流水账划算。

> 对 DSH 类框架的启示：把"上下文预算表"做成一等配置（system/tools/简报/历史/附件/工具输出各占多少上界），超限时按优先级降级，而不是按时间顺序砍。

## 二、KV-cache 是一等架构约束

### 2.1 账本

Manus 的描述可直接当公式：每轮把 action 与 observation 追加进上下文再推理，**上下文随步数线性增长，输出通常只是一个函数调用**，于是 prefill:decode 极度偏斜——**平均 input:output ≈ 100:1**（[Manus](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)）。一个 40 轮、每轮 2k token 工具输出的会话，输入侧轻松到 80k 量级。这就是"截断/落盘"这类粗糙手段收益巨大的原因。

### 2.2 10 倍价差与"一个 token 法则"

> "with Claude Sonnet, for instance, cached input tokens cost 0.30 USD/MTok, while uncached ones cost 3 USD/MTok—a 10x difference."

> "Due to the autoregressive nature of LLMs, even a single token difference invalidates the cache from that token onward."

原文点名的反模式：**秒级时间戳放在系统提示开头**。同类反模式的共同点是"每轮都变的东西放在每轮都不变的东西前面"。

### 2.3 provider 硬契约（以 [AWS Bedrock](https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html) 为一手来源）

1. **最小前缀**：*"Minimums currently range from 512 to 4,096 tokens per cache checkpoint"*。分档例子：Claude Sonnet 5/4.6 = **1,024**；Opus 4.7/4.6/4.5 = **4,096**；Haiku 4.5 = **4,096**；Claude 5.x = **512**。按**断点之前整个前缀累计**（含 tools+system+messages）计算。含义：系统提示只有 800 token 而门槛 4,096 时，前几轮根本不可能缓存——应把稳定工具 schema + 静态 few-shot 合并成够长的前缀，把可变简报推到断点之后。
2. **每请求最多 4 个断点**（Claude）。稀缺资源，按层级分配：①tools+静态 system ②会话简报 ③大段只读资料 ④压缩快照。
3. **TTL 默认 5 分钟、可选 1 小时，命中即重置**：*"The cache has a Time To Live (TTL), which resets with each successful cache hit"*；使用频率高于每 5 分钟会持续刷新且**不额外收费**；1 小时 TTL 适合"比 5 分钟稀疏、比 1 小时频繁"的场景（如跑数分钟的 side agent）。命中部分 *"not deducted against your rate limit"*。
4. **失效顺序 tools → system → messages**：*"changing content in an earlier section invalidates the cache for later sections (for example, modifying `tools` invalidates the `system` and `messages` caches)"*。**工具排序抖动 = 全废**。
5. 回看窗口仅断点前约 **20 个 content block**；长 TTL 条目须排短 TTL 之前；跨机器/跨区不保证命中。
6. **对账**：写入按 cache-write 费率（可能高于普通输入），读取按 cache-read 费率；`total input = inputTokens + cacheReadInputTokens + cacheWriteInputTokens`。成本看板要拆三项。
7. 别假设各家契约一样（同页对照 OpenAI on Bedrock：最小 1,024 token、TTL 30 分钟、写入 1.25×）：把"最小前缀/断点数/TTL/写读倍率"做成 provider 适配层的四个字段。

### 2.4 前缀抖动黑名单

- ❌ system 开头写 `当前时间 14:03:22`；❌ system 注入文件树/技能列表（顺序随遍历变化）；❌ 工具按"最近使用频率"重排；❌ 每轮重序列化 schema 且键序不稳；❌ few-shot 每轮随机抽；❌ system 里塞 request-id/AB 分组；❌ 把 `已完成 7/23 步` 写进最前面的 block。

**统一修法**：按易变程度三层排列，物理前后固定。

```text
[tools: 冻结顺序的 schema]              ← 断点 #1（几乎不变）
[system: 静态规则 + 静态 few-shot]       ← 与 #1 合并，凑够最小前缀
[system: 会话简报（任务/约束/偏好）]      ← 断点 #2（每会话一次）
[messages: 历史 + 压缩快照 + 工具输出]    ← 断点 #3/#4（每轮追加）
[user: 本轮动态信息（时间/进度/环境）]     ← 永远最后，不进缓存
```

三条硬规则：① 动态字段只出现在最后一个 block 之后；② 工具顺序按注册顺序固定，可用性用 mask 表达；③ 会话开头做一次"前缀冻结"（定稿并算 hash，之后复用同一份字节）。

### 2.5 可观测性

| 指标 | 算法 | 用途 |
| --- | --- | --- |
| prefix hash | tools+system+简报 的 sha256 | 相邻轮不一致 → 揪出抖动源 |
| cache hit rate | `cacheReadInputTokens / totalInputTokens` | 当 SLO（Manus 的"第一指标"） |
| 失效归因 | hash 变化时记录变化的 block 名 | 定位是工具集还是简报在抖 |
| 单会话成本 | 三类 token 分别计价 | 区分"干活"与"重付 prefill" |

只要 `cacheReadInputTokens` 从第一个会话起就接近 0，基本可断定前缀含动态内容——往往一行代码可修，收益是数量级。

> 对 DSH 类框架的启示：把提示装配从字符串拼接改成**有序 block 列表 + 断点声明**，每块带 `cacheable` 与 `volatile_reason`；否则任何"临时加一行调试信息"都会静默毁掉全局缓存。

## 三、Manus 六条经验：上下文整形比"总结"更细

原文六节标题与顺序：[Design Around the KV-Cache / Mask, Don't Remove / Use the File System as Context / Manipulate Attention Through Recitation / Keep the Wrong Stuff In / Don't Get Few-Shotted](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)。

**须说明**：本次抓取在第 1 节列表第 2 条处被截断（英文页、中文页、`.md`、`?plain=1` 四种形态同位置截断），**第 2–6 节正文未逐字取到**。下面标题已核实，展开为**要点转述**（非逐字引用）；数字只引用第 1 节核实过的三个（100:1、10x、4 次）。

### 3.1 经验 1：围绕 KV-cache 设计

① 前缀稳定（见第二节）。② **只追加（append-only）**：不原地改写/重排/删中间项；追加最便宜，删除与重排会让改动点之后全部失效——这直接否决"每轮用最新状态重写整个历史"的实现。③ 易变信息后置。原文自述 *"we've rebuilt our agent framework four times"*，并把手工作坊式搜索叫 *"Stochastic Graduate Descent"*：工程含义是**装配层必须可替换**，否则做不了第 5 次重写。

### 3.2 经验 2：Mask, Don't Remove

动作空间会随状态变化（用户接管浏览器、工具临时不可用、需前置步骤）：

- ❌ **删工具定义**：工具在上下文最前面，删除会让 system/messages 缓存全失效；历史里已有该工具调用，会出现"调用了 schema 中不存在的工具"。
- ✅ **mask 表达不可用**：定义集合与顺序不变，解码时屏蔽不可用工具的 logits（约束解码/状态机）。
- ✅ **命名前缀一致**（如 `browser_*`），整组屏蔽按前缀做，免维护易错明细表。

最反直觉的一条：**"上下文里有什么"与"模型此刻能选什么"应当解耦**——前者服务缓存与可复现，后者服务控制。

### 3.3 经验 3：用文件系统当上下文

上下文只放**引用**，正文落盘：写文件、留 `path + 摘要 + 行数`，需要细节时 `tail/head/grep` 回查。这是"压缩"正解：**可逆压缩**（截断不可逆，指针可回查），且契合 100:1 的账（2k token 输出换 30 token 指针 = 每轮省约 96% 对应成本），把硬窗口变成软上限（窗口=工作集，文件系统=后备存储）。

Anthropic 叫 just-in-time 检索：持有轻量标识（路径、存好的查询、URL），运行时再加载；"文件大小暗示复杂度、命名提示用途、时间戳代理相关性"本身就是信号；Claude Code 用 `head`/`tail` 分析大文件而非整体读入（[Anthropic](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)）。代价：比预计算检索慢，依赖好工具与启发式。

### 3.4 经验 4：用复述操纵注意力

维护 `todo.md`，每完成一步更新，并让清单反复出现在**尾部**。解决三件事：① lost in the middle（中段最易被忽略，尾部重述持续刷新注意力）；② 目标漂移（40 轮后忘了要干什么）；③ 状态可恢复（清单即 checkpoint）。

Anthropic 的 structured note-taking 同族，且给了好抄的例子——Claude Plays Pokémon：*"for the last 1,234 steps I've been training my Pokémon in Route 1, Pikachu has gained 8 levels toward the target of 10"*，上下文重置后读笔记续跑。这句话的信息结构是四字段：**目标（10 级）+ 当前（8 级）+ 已投入（1,234 步）+ 位置（Route 1）**，正好是续跑所需最小状态。todo/plan 应强制包含这四项，而不是只写"继续做 X"。

### 3.5 经验 5：把错误痕迹留下

失败动作、报错、走不通的路径不要"洗干净"：错误信息是模型避免重犯的**唯一**证据；压成"工具调用失败"会让它下一轮重试同样参数；只留成功路径会制造虚假世界模型。12-factor 的 Factor 9 专讲此事——"Compact Errors into Context Window"：把错误**压紧**（去堆栈噪音、留可行动信息），不要**抹掉**（[12-factor](https://www.humanlayer.dev/blog/12-factor-agents)）。

### 3.6 经验 6：别被 few-shot 带进沟里

历史就是隐式 few-shot。连续的"调用 A → 观察"同构序列会让模型复制节奏，即使任务该换策略。对策：**主动引入变化**（序列化模板、字段顺序、措辞不要逐轮逐字相同；重复动作间插入小结/计划消息）；few-shot 用 *"diverse, canonical examples"* 而非一长串边角案例（[Anthropic](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)）；避免把每步写成 if-else 的僵硬清单。

### 3.7 折叠成表

| 经验 | 一句话 | harness 落点 |
| --- | --- | --- |
| KV-cache | 前缀稳定、只追加、动态后置 | block 列表 + 断点 + hash 监控 |
| Mask, not remove | 可用性用屏蔽表达 | 工具注册表 + 解码约束/前缀分组 |
| File system | 正文落盘、上下文留指针 | 输出落盘 + read/grep/tail |
| Recitation | 目标与待办反复重述 | todo/plan 文件 + 尾部重述 |
| Keep wrong stuff | 失败轨迹要留 | 压缩器保留错误类型/参数/关键行 |
| Don't get few-shotted | 打断同构序列 | 序列化多样化 + 插入小结 |

## 四、压缩三件套

Anthropic 把长任务上下文管理拆成三种手段，栈式组合最稳（[context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)、[context management](https://claude.com/resources/articles/context-management)）。

| 手段 | 做了什么 | 强度 | 代价/风险 |
| --- | --- | --- | --- |
| compaction | 把历史交模型摘要并替换旧历史 | 强 | 有损；过激丢 *"subtle but critical context"* |
| tool-result clearing | 只清**陈旧**的工具调用与结果 | 弱（原文称"最安全、最轻"） | 丢细节，主线完整 |
| structured notes | agent 自写 NOTES.md / todo | 中 | 依赖自觉，需模板约束 |

**compaction 细节**：Claude Code 把消息历史交模型摘要，明确要求保留**架构决策、未解决 bug、实现细节**，丢弃**冗余工具输出与重复消息**，然后 *"continue with this compressed context plus the five most recently accessed files"*——摘要给"为什么"，最近 5 个文件给"是什么"，缺一不可。

**tool-result clearing** 已成 Claude Developer Platform 能力；harness 里对应规则：**工具结果超过 N 轮未被引用，替换为一行占位（工具名、参数摘要、输出大小、文件指针）**。几乎不损失推理链，只损失"翻旧账"。

**实测收益**：

> "combining the memory tool with context editing improved performance by 39% over baseline. Context editing alone delivered a 29% improvement."

> "In a 100-turn web search evaluation, context editing enabled agents to complete workflows that would otherwise fail due to context exhaustion—while reducing token consumption by 84%."

两个数字放一起读：**最不起眼的"清理旧工具结果"带来 29% 效果提升与 84% token 节省**，原因是双重的——省钱 + 上下文更短使召回更好（第一节）。Sonnet 4.5 起还内置 **context awareness**（模型自己知道还剩多少 token），即"让模型参与预算管理"。

### 4.1 水线

别等 95% 再压：压缩本身要一次完整 prefill，而快满的上下文最贵最慢。

| 水位 | 动作 |
| --- | --- |
| 50% | 提醒 agent 写笔记 / 落盘大输出 |
| 65% | tool-result clearing（清最旧、未被引用的结果） |
| 80% | compaction（摘要旧历史，留最近 N 轮 + 最近访问文件） |
| 90% | 硬保护：拒收超大输出，强制落盘只回摘要 |

阈值按**模型实际窗口**配，别写死常量。LangChain 的多代理例子说得直白：LeadResearcher *"begins by thinking through the approach and saving its plan to Memory ... since if the context window exceeds 200,000 tokens it will be truncated"*（[LangChain](https://www.langchain.com/blog/context-engineering-for-agents)）——**超窗是被截断而不是被摘要**，很多 provider 丢中间，比主动压缩糟得多。

### 4.2 保什么、丢什么

必保：原始目标 + 硬约束（"只改这两处""必须中文"）；**决策及理由**（选 X 不选 Y 因为 Z）；未解 bug / 待验证假设；改动文件清单 + 关键行号；失败路径与错误类型；外部标识符（URL、commit、任务 ID、endpoint）。

可丢：重复工具输出（同一文件读三遍）；长的成功日志（留首尾 + 计数）；已被推翻的中间推理；寒暄与格式确认。

### 4.3 三个反模式

① **等更大窗口解决**——Anthropic 明确反对，Chroma 18 模型实验也没有拐点；原文建议 *"do the simplest thing that works"*。② **一次性全量摘要**——200 轮压成 500 字必丢细节；应分层：先清工具结果（不伤推理）→ 再压中段（留决策）→ 最后整体摘要。③ **压完不校验**——压缩后做"金丝雀三问"：目标是什么？还有哪些未解？改了哪些文件？三问全对才算合格，可做成自动 smoke test。

### 4.4 分层栈

```text
L0 静态规则 + 工具 schema        断点 #1，永不变
L1 会话简报：目标/约束/偏好       每会话一次，断点 #2
L2 计划：todo.md / plan.md        每步重述，靠尾部
L3 最近 N 轮原文                  逐字保留
L4 压缩快照：决策/未解/文件        断点 #3
L5 指针层：路径/URL/落盘位置       极小，可长期留
L6 跨会话 memory 目录             L5 的后端
```

> 对 DSH 类框架的启示：压缩不是"一个函数"，是**带优先级的淘汰策略**。写死 `summary = llm(history)` 的框架终会在长任务翻车；把 L3/L4/L5 边界做成可配置，并让压缩器输出结构化字段而非一段自由文本。

## 五、工具集与按需发现

**工具臃肿是头号失败模式**。Anthropic 的判据可直接进团队规范：*"If a human engineer can't definitively say which tool should be used in a given situation, an AI agent can't be expected to do better."* 工具要 token 高效、错误健壮、参数自解释（[Anthropic](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)）。LangChain 的观察是：工具过多、描述重叠会导致选错工具；"总是注入"的记忆也会选错——Simon Willison 的位置记忆被注入图片请求，用户觉得窗口 *"no longer belongs to them"*（[LangChain](https://www.langchain.com/blog/context-engineering-for-agents)）。

工程含义：**工具 schema 是每轮重付的固定成本**——工具越多，常驻前缀税越重。

### 5.1 Cursor 的五个动态发现用法

[Cursor](https://cursor.com/blog/dynamic-context-discovery)（2026-01-06）总结：*"As models have become better as agents, we've found success by providing fewer details up front"*。

① **长工具响应落盘而非截断**，agent 先 `tail` 再看更多，收益是 *"fewer unnecessary summarizations when reaching context limits"*；② **聊天历史做成文件**，摘要丢细节时可回查——把 compaction 从有损改成可逆；③ **Skills 作为文件**按需 grep/语义检索；④ **MCP 工具描述同步到文件夹**，静态上下文只留工具名；⑤ **终端会话当文件**，用 `grep` 查日志。

**硬数字**：MCP 懒加载 A/B 中 *"in runs that called an MCP tool, this strategy reduced total agent tokens by 46.9%"*（统计显著，方差随 MCP 数量变化大）。注意条件——是"调用过 MCP 的运行"，不是全量，别夸大。

实现细节也值得抄：**一个 MCP server 一个文件夹**而非扁平索引，既能"整组理解"，又能 `rg`/`jq` 精确过滤；还能顺带传达"该 MCP 需重新认证"。

### 5.2 两层工具暴露

| 层 | 内容 | 预算 | 变化 |
| --- | --- | --- | --- |
| Tier 1 | 5–12 个核心工具，一行描述 + 完整 schema | 小 | 几乎不变（缓存友好） |
| Tier 2 | 其余工具名 + 一行用途 + 文档路径 | 极小 | 可随任务变 |
| Tier 3 | 完整 schema / 文档 | 0 常驻 | 调用时读文件 |

Tier 2→3 用一个元工具完成（`describe_tool(name)` 或读 `tools/<name>.md`），正好对应 Anthropic 的 **progressive disclosure**：先用廉价信号（名字、大小、时间戳）决定是否深入，再付完整读取成本。

**注意**：Tier 2 清单也会变，**不能放在缓存断点之前**——放断点后的会话简报里，或尾部提醒。

> 对 DSH 类框架的启示：工具注册表要有 `tier` 与 `description_budget` 字段，装配时断言"Tier 1 总量 ≤ X"。工具数量应当像内存一样被当稀缺资源管理。

## 六、隔离：子代理、micro agent

**长循环本身是失败源**（[12-factor](https://www.humanlayer.dev/blog/12-factor-agents)）：*"Agents get lost when the context window gets too long - they spin out trying the same broken approach over and over again"*；*"anything more than 10-20 turns becomes a big mess that the LLM can't recover from"*；即使 90% 正确也 *"miles away from good enough"*——*"Can you imagine a web app that crashed on 10% of page loads?"* 对策不是更强模型，而是**结构**：micro agent 嵌进更大的确定性 DAG，*"keep the LLM focused on a small, 5-10 step workflow"*。其四组件模型适合当 harness 心智模型：**prompt、switch statement、accumulated context、for loop**。

**子代理**：主代理统筹高层计划，子代理在**各自干净上下文**里探索，可消耗 *"tens of thousands of tokens"*，只回传 *"condensed, distilled summary (often 1,000-2,000 tokens)"*（[Anthropic](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)）。比例值得记住：**探索 2 万、回传 1–2 千，压缩比约 10:1–20:1**。子代理输出预算必须硬约束，否则等于没隔离。LangChain 四桶法里这叫 **isolate**；代价是边界信息损耗 + 并行重复劳动，所以必须有"合并与裁决"一步。

**协议实操**：

- 返回 schema 固定：`{ findings, evidence[urls/files], open_questions, next_actions }`，强制 token 上限（如 2k）。
- 禁止回传原始日志，只允许"引用 + 行号/URL"，父代理需要时自读。
- 声明写作用域（并行安全前提），明确"不要做什么"。
- 给干净前缀：只需"任务 + 必要事实 + 输出格式"，同时省缓存、防污染。
- **合并步骤不能省**：显式记录哪个结论被采纳/否/为什么，否则隔离会产生 context clash。

> 对 DSH 类框架的启示：把"子代理调用"建模成一次**有损 RPC** 而非上下文共享；返回结构、大小、可引用性在协议层约束，同时保留"原始产物落盘 + 父代理可回查"的后路。

## 七、反模式清单

| # | 反模式 | 代价 | 证据/改法 |
| --- | --- | --- | --- |
| 1 | system 开头放时间戳/随机 ID | 每秒抖动 → 其后缓存全失效，输入价差 10x | [Manus](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)；动态后置 |
| 2 | 工具按频率动态排序 | 工具在 messages 前，一抖动连带全失效 | [Bedrock](https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html)；注册顺序固定 |
| 3 | 中途删工具定义以限制动作 | 缓存击穿 + 悬空调用 | Manus 经验 2；改 mask |
| 4 | 就地改写/重排历史 | 改动点后缓存全废，破坏 append-only | Manus 经验 1；压缩用新消息表达 |
| 5 | 长输出截断到 2k 字符 | 不可逆丢数据，反复重读 | [Cursor](https://cursor.com/blog/dynamic-context-discovery)；落盘 + 指针 |
| 6 | 只留成功轨迹 | 无证据避免重犯，错误循环 | Manus 经验 5 + Factor 9；压紧而非抹掉 |
| 7 | 塞满再压缩 | 压缩贵且易截断 | 水线设计；50/65/80/90 分级 |
| 8 | 压成一段自由文本摘要 | 丢决策与未解，续跑漂移 | [Anthropic](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)；结构化字段 |
| 9 | 全部 MCP/技能常驻 | 常驻 token 税 + 选择准确率下降 | [Cursor](https://cursor.com/blog/dynamic-context-discovery) −46.9%；两层暴露 |
| 10 | 一个 loop 跑到底 | 10–20 轮后重复同一坏方案 | [12-factor](https://www.humanlayer.dev/blog/12-factor-agents)；micro agent + 终止条件 |
| 11 | 子代理回传原始日志 | 隔离失效、父上下文污染 | 子代理回传 1–2k token；schema + 上限 |
| 12 | 堆"以防万一"的资料 | 1 个 distractor 就掉分，4 个叠加更差 | [Chroma](https://www.trychroma.com/research/context-rot)；按需检索 |
| 13 | 靠"每轮重写完整状态"保一致 | 与缓存、append-only 双冲突 | 状态落文件，上下文只放增量与指针 |

两条实测细节值得当设计输入：**"聚焦"远胜"全量"**（~113k vs ~300 token，306 条 prompt）；**拒答率随长度上升**——Repeated Words 上 Claude Opus 4 拒答 **2.89%**、GPT-4.1 **2.55%**、Qwen3-8B 未尝试 **4.21%**（GPT-3.5 turbo 因 content_filter **60.29%** 被剔除，[Chroma](https://www.trychroma.com/research/context-rot)）。"不答"要按失败计，别记成空结果。

## 八、Token 指标与落地清单

### 8.1 先定四个指标（不度量就没法优化）

| 指标 | 定义 | 用法 |
| --- | --- | --- |
| 每成功任务 token | 会话总 token（输入+缓存读+缓存写）/ 成功完成任务数 | 唯一够格当"北极星"的成本指标；比单次请求成本诚实得多 |
| 缓存命中率 | `cacheReadInputTokens / totalInputTokens` | Manus 的"第一指标"，做成 SLO；≈0 说明前缀有动态内容 |
| input:output 比 | 输入 token / 输出 token | 基线可参照 Manus 的 ≈ **100:1**；远高于它说明上下文在灌水 |
| 上下文"读完率" | 被后续步骤实际引用的工具结果数 / 注入的工具结果数 | 低说明"落盘 + 按需读"没做到位，或检索给了无关资料 |

再加两个辅助指标：**水位分布**（每轮上下文占窗口比例的 P50/P95，决定水线定在哪）与**压缩后成功率**（压缩前后同任务成功率差，防止"省钱掉点"）。缓存那 10 倍价差（[Manus](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)）意味着：命中率从 30% 提到 80%，成本结构会变一个量级，值得单独看板。

### 8.2 今天就能做（1–3 天）

1. **前缀冻结审计**：每请求对 `tools+system` 算 sha256 打点，相邻轮不一致即告警。验收：正常会话只在开头变一次。
2. **动态字段后移**：时间戳、进度、随机 ID 移到最后一个 block 或尾部 user 消息。验收：缓存读 token 占比上升。
3. **工具集定序**：按注册顺序导出，禁"按频率排序"。验收：两次序列化字节级相同。
4. **断点打在最稳处**：`tools+静态 system` 后、会话简报后各一个（上限 4；注意 512–4,096 最小前缀）。
5. **工具输出落盘**：超阈值（如 8k 字符）写文件，上下文留"路径 + 首尾各 3 行 + 总行数"。提供 read/grep/tail 回查。
6. **陈旧结果清理**：N 轮未引用即换一行占位（工具名、参数摘要、大小、指针）——"最安全、最轻"的压缩。
7. **todo/plan 复述**：每步更新并在尾部重述四字段（目标/当前/已投入/位置）。
8. **压缩器输出结构化字段**：`{goal, constraints, decisions[], unresolved[], files_changed[], failed_attempts[], pointers[]}`，禁止只出自由文本。
9. **压缩后金丝雀三问**：目标/未解/改动文件，三问全对才通过。
10. **步数与重复检测**：同一工具 + 相同参数连续 2 次即注入"换策略"提醒；超 10–20 轮考虑重启子任务。
11. **子代理限流**：schema 固定 + 1–2k token 上限，原始产物只落盘。

### 8.3 要基建（1–4 周）

1. **装配层重构**：字符串拼接 → 有序 block 列表 + `cacheable`/`volatile_reason`/预算上界。
2. **分层压缩引擎**：水线触发 + 三层策略（清工具结果 → 压中段 → 整体摘要），每层可开关、可回放。
3. **可逆压缩**：被压掉原文写归档文件，上下文留指针可回查。
4. **两层工具暴露 + 元工具**：Tier1 常驻 / Tier2 名单 / Tier3 按需加载 schema。
5. **mask 能力**：provider 支持约束解码时做 logits 屏蔽；不支持则在尾部声明禁用工具（别删定义）。
6. **文件系统式记忆**：跨会话 memory 目录，带 create/read/update/delete 与写入者/时间元数据。
7. **缓存感知的提示编译器**：静态/半静态/每轮三桶生成，编译期断言"动态内容没进静态前缀"。
8. **context rot 回归集**：长文档 needle、加 distractor、打乱结构、超长输出，验证压缩未引入退化（对照 Chroma 设计）。
9. **压缩质量回归**：同任务跑"压缩前 vs 后"成功率，防"省钱掉点"。

**只做三件事的话**：① 冻结前缀并监控 hash；② 工具输出落盘 + 陈旧结果清理；③ 结构化 todo/plan 复述。分别对应成本、长度、长任务漂移三个最痛点，且都不需要新基建。

## 九、未取到与未验证

1. **Anthropic 官方 prompt caching 文档**（`platform.claude.com/docs/.../prompt-caching`）多次重定向后被拦，未取到。缓存硬数字改用 [AWS Bedrock 文档](https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html)——同一能力的不同托管形态，**费率与最小前缀可能不同**，落地前以自己平台文档为准。
2. **Manus 第 2–6 节正文**：四种页面形态均在第 1 节列表第 2 条处截断。标题与顺序已核实，展开为要点转述，无编造数字。
3. **LangChain 的 compress / isolate 两节正文**：在 compress 前截断；四桶法名称与 TL;DR 已核实。
4. **GitHub 上的 12-factor README**：`github.com` / `raw.githubusercontent.com` / `cdn.jsdelivr.net` 均 fetch failed；改用同作者同内容博客页 humanlayer.dev。（另：Chroma 只有文字结论，图表逐点数值未取，故未引用。）

两点判断（非引用）：① Manus 文中**没有**"缓存 TTL"数字（只有命中率、100:1、10x），TTL 数字全部来自 Bedrock 文档；若你记得某处讲过"Manus 的 TTL"，大概率是二手转述。② context editing 的 +29%/+84% 是 Anthropic **内部评测**（agentic search、100 轮网页检索），任务分布不同，别当普适常数——但方向（清陈旧工具结果收益极大）值得独立验证。

## 十、来源

1. Manus / Yichao 'Peak' Ji, *Context Engineering for AI Agents: Lessons from Building Manus*, 2025-07-18 — https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus
2. Anthropic, *Effective context engineering for AI agents*（`/engineering/` 路径重定向到 `/research/`）— https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
3. Chroma Research, *Context Rot*, 2025-07-14 — https://www.trychroma.com/research/context-rot （`research.trychroma.com/context-rot` 跳转）
4. LangChain, *Context Engineering for Agents*, 2025-07-02 — https://www.langchain.com/blog/context-engineering-for-agents
5. Cursor, *Dynamic context discovery*, 2026-01-06 — https://cursor.com/blog/dynamic-context-discovery
6. Anthropic, *Context management*, 2025-09-29 — https://claude.com/resources/articles/context-management （原 `anthropic.com/news/context-management` 跨域跳转）
7. AWS, *Prompt caching for Amazon Bedrock* — https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html
8. HumanLayer / Dex, *12 Factor Agents*, 2025-04-03 — https://www.humanlayer.dev/blog/12-factor-agents （GitHub 原址 https://github.com/humanlayer/12-factor-agents，本次不可达）

> 缓存类参数（最小前缀、断点数、TTL、写读倍率）变更频繁，**落地前按实际模型重查文档**；本文抓取于 2026-11-15。
