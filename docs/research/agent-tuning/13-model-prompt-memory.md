# 智能体调优：提示词·模型预算·记忆

> 一句话结论：让智能体「不飘」的杠杆不在措辞，而在三件事——**提示词分层到位（结构分区 + right altitude + 可判定的约束）**、**推理预算与任务档位匹配**、**记忆与经验被写成机器可执行的形式**。凡是「重复两遍还在犯」的问题，都不该继续写在提示词里，而应下沉为 lint / 脚本 / CI / hook。

本文面向自建 agent / 编码助手 / 长任务自动化场景，来源以 Anthropic 工程博客、Claude Code 官方文档、AWS Bedrock 文档与三篇论文为主。**数字均标注原文出处**；无法取到的来源在最后一节列出。

---

## 0. 阅读地图与适用边界

路线：1 结构分区 → 2 right altitude → 3 约束与升级阶梯 → 4 推理预算 → 5 工具契约 → 6 记忆三层 → 7 经验固化（ACE）→ 8–9 清单与反模式。

适用边界：这些结论来自对 Claude 系列模型与 Claude Code 的公开实践，跨模型迁移时以「机制」为主、以「参数」为辅（第 4 节 token 数字只对 Anthropic 模型成立）。

---

## 1. 提示词为什么不「飘」：先分区，再谈措辞

### 1.1 结论

输出漂移大多不是「措辞不够好」，而是**上下文结构出了三个问题**：该硬的信息（输出格式、工具边界、验收条件）散落在散文里；不该硬的信息（具体步骤、临时环境细节）被写死；示例要么没有，要么堆成边界案例清单。Anthropic 的表述是：好的上下文工程 = 找到「the smallest possible set of high-signal tokens」（https://www.anthropic.com/research/effective-context-engineering-for-ai-agents ）。

### 1.2 结构分区：用 XML tag 或 Markdown header 把职责切开

同文明确建议把 prompt 组织成**互不混淆的区段**，例如 `<background_information>`、`<instructions>`、`## Tool guidance`、`## Output description`，并用 XML tagging 或 Markdown header 划定边界；并强调「the exact formatting of prompts is likely becoming less important as models become more capable」（同上）。

可直接抄的骨架（编码/自动化 agent 版）：

```text
<role>
你是 <仓库/系统> 的维护者。只在本仓库范围内改动；不引入新依赖，除非任务明确要求。
</role>

<background_information>
仓库：<路径>；构建：<命令>；测试：<命令>；单测：<命令>。
已知约束：Node 22；禁止修改 src/gen/**；集成测试需要 DATABASE_URL。
</background_information>

<instructions>
1. 先阅读 <文件/目录>，再给出改动计划（≤5 行），然后执行。
2. 必须为新行为补测试；测试失败时先修实现，不要改断言。
3. 完成任务前运行 <typecheck> 与 <test>，把命令与输出贴回。
4. 不要留下 TODO、占位实现、被注释掉的代码。
</instructions>

## Tool guidance
- 修改文件用 edit/write；不要用 shell 重定向写文件。
- 搜索用 grep/glob；不要遍历整棵树。
- 需要外部信息时先读本地文档，再考虑 web。

## Output description
结束时输出：改动文件清单 / 关键决策 3 条 / 运行的命令与结果 / 仍未解决的风险。
```

要点：

1. **每个区段只回答一类问题**：角色 = 边界与身份；背景 = 事实与约束；指令 = 行为规则；工具 = 能力边界；输出 = 验收形态。
2. **格式与验收单独成节**，不要混在散文里——这是「不飘」的最大单点收益。
3. **先最小 prompt + 最强模型跑，再按失败模式补**（同文原话：start by testing a minimal prompt with the best model available，再按 failure modes 加指令与示例）。先结构后内容，否则不知哪句起作用。

### 1.3 示例：典型而非堆边界

同文对 few-shot 的建议是：强烈推荐，但**不要**把「一长串边界案例」塞进 prompt，而要「a set of diverse, canonical examples that effectively portray the expected behavior」——原文比喻是 examples are the “pictures” worth a thousand words（同上）。

可执行判据：

- 3 个示例足够：1 个标准路径、1 个「必须停下问人」的路径、1 个「看起来像要改但不应改」的陷阱路径。
- 每个示例只演示**决策边界**，不复述工具语法（语法由 schema 负责）。

### 1.4 自检 5 问（贴在新 prompt 的 PR 描述里）

1. 每个区段是否只承担一种职责？
2. 输出格式是否单独成节，且可被程序校验？
3. 是否存在只有我知道、模型无法从代码/文档推断的事实？——有就写进 background。
4. 是否存在模型自己读代码就能知道的内容？——有就删（见第 2 节）。
5. 每条规则能否在失败后被判定「违反了」？——不能判定的规则是安慰剂。

---

## 2. right altitude：提示词该写多细

### 2.1 定义（原文）

Anthropic：system prompt 应「extremely clear and use simple, direct language that presents ideas at the *right altitude*」；right altitude 是两种常见失败模式之间的 Goldilocks zone——一端是把「complex, brittle logic」硬编码进 prompt，另一端是「vague, high-level guidance」或「falsely assumes shared context」（https://www.anthropic.com/research/effective-context-engineering-for-ai-agents ）。

### 2.2 三档高度对照

| 高度 | 表现 | 后果 | 典型句子 |
| --- | --- | --- | --- |
| 太低（硬编码） | 把 if-else 流程、每个 API 调用顺序写进 prompt | 脆弱、维护成本上升；环境一变就失效 | 「先调用 A，再调用 B，若 B 返回 3 则调用 C……」 |
| 合适 | 策略 + 判据 + 边界 + 验收 | 可迁移到同类任务；失败可归因 | 「改 model 前必须解析 role model；解析失败则报 modelUnavailable，不得回退到默认值」 |
| 太高（空泛） | 「be helpful」「follow best practices」「注意质量」 | 模型只能猜；不同轮次行为不一致 | 「请高质量地完成任务」 |

判断口诀：**写完一句问自己「换一个仓库、换一个任务，这句还成立吗？」** 成立 → 属于策略（可留）；不成立但确实是本仓库事实 → 收进 background 事实区；不成立且只是这次任务的步骤 → 删除或改写为验收条件。

### 2.3 「模型能自己看到的，不要写」

Claude Code 官方最佳实践给了一条非常锋利的判据：**只写模型无法通过读仓库得到的东西**，并建议 `CLAUDE.md` 保持在 200 行以内（原文：the memory guide recommends staying under 200；https://code.claude.com/docs/en/best-practices ）。它还给了两问测试：

1. Could it find this by reading the code?
2. Would it actually go and look?

两问都是 yes → 不要写。这条同样适用于 system prompt 与 skill：模型对「文件布局、测试框架、现有组件写法」的了解，通常比人手写摘要更准。

### 2.4 高度校准流程（团队可执行）

1. 用最小 prompt + 当前最强模型跑 20 条真实任务，记录失败模式（不是记录「感觉不好」）。
2. 每条失败归因到四类之一：缺事实 / 缺约束 / 缺示例 / 缺验收。
3. 只补对应类：缺事实进 background，缺约束进 instructions，缺示例加 1 条 canonical，缺验收进 output。
4. 若某条规则连续 2 次被违反 → 移出文本，进入第 3 节的机器检查。

另一面：过度强调适得其反。Claude Code 文档原话：给一条 CLAUDE.md 反复加 IMPORTANT 仍被忽略，说明它要么被长文淹没，要么「是个不能有例外的规则」，后者应改成 hook（同上）。

---

## 3. 约束优于指令：把「记得」变成「做不到」

### 3.1 核心区分：非确定性指令 vs 确定性执行

Claude Code 文档把每条指令分成两类（https://code.claude.com/docs/en/best-practices ）：

- **Non-deterministic**：你写下来、模型读——prompt、`CLAUDE.md`、skill。模型「通常」遵守，但没有保证。
- **Deterministic**：你配置、harness 强制执行——hook、deny rule、managed setting。每次都执行，与模型当轮决定无关。

这张对照表值得直接搬进团队规范：

| 目的 | 非确定性（模型决定） | 确定性（harness 保证） |
| --- | --- | --- |
| 做什么 | prompt / CLAUDE.md / skill | hooks、skill 调用权限 |
| 能碰什么 | auto mode 分类器 | deny 规则、sandbox |
| 何时算完 | 要求「给出证据」、/goal、/code-review | 测试、typecheck、Stop hook、CI |
| 花多少 | effort 档位 | `--max-turns` / `--max-budget-usd` |
| 谁拍板 | 模型自述总结 | 分支保护、人工批准合并 |

结论：**「不飘」的关键不是把指令写得更强硬，而是把「必须发生/绝不允许」的规则移出模型裁量权**。文档的判断标准也很实用：不断加粗强调仍被违反的规则，就该进 hook；hook 管偏好类问题时，反而该删掉放回文本。

### 3.2 为什么「No TODOs, no partial implementations」优于「remember to finish」

因为它**可判定**。前者可以被 grep、被 diff 检查、被 CI 拒绝；后者只能靠模型自述。可判定性带来三个好处：可验收、可回归、可跨模型迁移。

把模糊指令改写为可判定约束的对照（左列常见写法，右列可执行版本）：

| 模糊指令 | 可判定约束 |
| --- | --- |
| 记得完成任务 | 结束前 `grep -rn "TODO\|FIXME" src/` 必须为空；测试必须全绿 |
| 写测试 | 新行为必须新增至少 1 个测试；修改的每个函数至少被 1 个测试覆盖 |
| 不要改太多 | 改动文件数 ≤ N；不得修改 `src/gen/**`、`migrations/**` |
| many tasks / a lot of work | 拆成 **20–100 个** 可独立验收的任务（数量按你团队的真实分布给区间，不要拍脑袋） |
| 注意性能 | p95 延迟 < 200ms；查询不得全表扫描（EXPLAIN 校验） |
| 保持风格一致 | 用 `src/lib/errors.ts` 的错误辅助函数，禁止 `throw "字符串"` |
| 不要作弊 | 测试文件不可被修改（deny 规则 + CI diff 检查） |
| 仔细读代码 | 引用必须给 `文件:行号`；不能引用的结论标注「未验证」 |

几个可抄的原则：

1. **数量给区间，不给形容词**。「20–100 tasks」比「many tasks」可执行，因为前者能让模型先规划粒度再动手；区间要来自历史数据（例如过去 20 次任务的实际拆分分布）。
2. **禁止项要能落到路径/命令**。「不要碰生成代码」→ deny 规则覆盖 `src/gen/**`。
3. **验收条件写成命令**。能跑出 exit code 的验收，比任何措辞都稳。
4. **允许例外时写清例外**，否则模型会把「不许改测试」理解成「测试失败也不要动」。

### 3.3 给意图不给步骤

给步骤的 prompt 在环境变化时会整体失效；给意图 + 约束 + 验收则可复用：

```text
意图：让 parseConfig 对旧格式文件返回明确的迁移错误，而不是 TypeError。
约束：不引入依赖；不改公开 API 签名；错误信息包含文件路径与 schema 版本。
验收：新增 3 个 fixture 测试（旧格式 / 缺字段 / 合法），`pnpm vitest run config` 全绿。
```

对比「第一步打开 X，第二步改 Y……」——后者在文件重命名后就会误导模型。例外是高危操作（生产部署、数据迁移、删除）：这类必须给**固定步骤 + 人工确认点**，因为正确性优先于适应性。

### 3.4 升级阶梯与触发条件

**触发条件（任务要求里那条最实用）**：同一条建议被纠正 **2 次** → 固化，不再靠复述。

**阶梯（成本从低到高）**：

1. prompt 一行（可判定、少例外）→
2. lint 规则（命名、禁用 API）→
3. 脚本/命令（格式化、license header、生成物校验）→
4. CI gate（测试、typecheck、diff 白名单）→
5. hook / deny 规则（零例外、必须每次拦截）。

Claude Code 的 Stop hook 示例把「必须 typecheck」变成硬约束：hook 以 exit code 2 结束即阻止模型收工，stderr 回传为「为什么还不能结束」；文档还提到连续阻塞八次（eight stops in a row）后 harness 会强制结束该轮（https://code.claude.com/docs/en/best-practices ）。这正是「约束优于指令」的机制化版本。

---

## 4. 推理预算：先定任务档，再定 token

### 4.1 配置事实（以 AWS Bedrock 的 Claude 文档为准）

来源：https://docs.aws.amazon.com/bedrock/latest/userguide/claude-messages-extended-thinking.html

- 启用 thinking 必须设 `budget_tokens`，它决定「internal reasoning process」的最大 token 数。
- **最小预算是 1,024 tokens**；官方建议「starting at the minimum and increasing the thinking budget incrementally to find the optimal range」。
- 预算是**目标而非硬上限**：actual token usage may vary based on the task；大预算（尤其 >32K）常被用不满。
- **budget_tokens 必须小于 max_tokens**；但 interleaved thinking（beta header `interleaved-thinking-2025-05-14`）时预算可超 max_tokens，因为它代表「整个 assistant turn 所有 thinking block 的总预算」。
- **max_tokens > 21,333 时必须 streaming**；**预算 >32K 建议改用 batch processing**，避免长连接超时与并发连接耗尽。
- thinking **不与 temperature / top_p / top_k 兼容**，也不支持 forced tool use（`tool_choice: any` 或指定工具），且不能 pre-fill 回复。
- 启用时 API 会自动加入一段「specialized 28 or 29 token system prompt」；Claude 4 返回的是 summarized thinking，但**按完整 thinking tokens 计费**（可见摘要 ≠ 计费 token）。
- 上一轮的 thinking block 会被自动剔除、不计入 context；但 thinking 参数（开关/预算）变化会使含消息的 cached prefix 失效，system prompt 与 tools 的缓存仍有效。
- 新模型（文档列出的 Fable 5.x / Mythos 5.x）不支持 `enabled` / `disabled`，改用 `{"type":"adaptive"}` + `output_config.effort` 控制深度；传 enabled/disabled 会 400。

### 4.2 任务档位表（配置建议，非论文数字）

| 任务档 | 典型任务 | 是否开 thinking | 起步预算 | 备注 |
| --- | --- | --- | --- | --- |
| L0 直取 | 抽取、分类、格式转换 | 不开 | — | 开了反而慢，且无法用 temperature 调稳定 |
| L1 轻推理 | 单文件改动、小 bug | 可选 | 1,024 | 从最小值试，失败再加 |
| L2 多步 | 跨文件重构、写测试 | 开 | 4,096 | 配合验收命令，避免「想得多做得少」 |
| L3 难题 | 陌生代码库根因、安全审计 | 开 | 16,384+ | 关键任务做预算 A/B；>32K 走 batch |
| L4 长任务 | 迁移、深度研究 | 开 + 压缩 | 每轮小预算 | thinking 不计 context，但计费；重点是 compaction |

做法：固定 20 条任务集，跑 1k / 4k / 16k 三档，比较「正确率 / 端到端时延 / 花费」，取边际收益转负的点，而不是取「感觉最深」的配置。

### 4.3 何时不该开

1. **答案唯一且短**（抽取、分类、路由）：预算收益接近零，延迟线性增加。
2. **需要可控随机性**：thinking 与 temperature 不兼容；需要多样本采样时，应改用无 thinking 的多次采样。
3. **缓存敏感的高频调用**：改 thinking 参数会使消息缓存失效（system/tools 仍有效），频繁调参会持续付缓存重建成本。
4. **上下文已接近上限**：预算来自 output 侧，长上下文场景下压缩（第 6 节）比加预算更划算。
5. **需要强制工具调用**（`tool_choice` 指定工具）：thinking 下不支持。

### 4.4 并行采样 / 自一致性：适用条件与做法

原则（工程经验，非引文）：自一致性在**有可比对答案 + 有判别器**时收益最大，在**长轨迹 agent 任务**上成本线性上升而收益递减。

适用：

- 答案可归约（数值、分类、短文本、补丁通过同一测试集）。
- 有 verifier（测试、类型检查、规则校验）或多数投票有意义。
- 单次错误率中等（既不是 99% 也不是 10%）。

做法：

- N = 3–5；先并行采样，再用 verifier 择一，verifier 不可靠时用多数投票。
- 记录**分歧率**：分歧率高说明任务定义不清，应先改 prompt/约束，而不是加大 N。
- 轨迹型任务（多轮工具）优先「同一轨迹内重试 + 错误压缩」，而非整条重跑（见 5.4 与 12-factor factor 9「compact errors into context window」）。

不适用：延迟敏感（N 倍延迟）、成本敏感、无判别器且答案开放（投票无意义）。

### 4.5 成本核算要点

- thinking 输出按 output token 计费，且 summarized 模式下按完整 thinking token 计费（AWS 文档）。
- 成本大头是「每轮重发整段历史」；缓存寿命「about an hour on a subscription and five minutes on an API key」（同上），超时续跑按全价重读。
- 因此预算优化的顺序是：**先压缩上下文 → 再谈 thinking 预算 → 最后才加并行采样**。

---

## 5. 结构化输出与工具契约

### 5.1 第一性原理：tools are just structured outputs

12-factor-agents 的 Factor 4 原话：「Tools don't need to be complex. At their core, they're just structured output from your LLM that triggers deterministic code.」（https://github.com/humanlayer/12-factor-agents/blob/main/content/factor-04-tools-are-structured-outputs.md ）。它给的例子是让模型输出带 `intent` 的 JSON（`create_issue` / `search_issues`），由确定性代码 switch 分发——**不必 1:1 映射到某个函数**。

这带来两个设计自由：

1. 模型只负责「决定做什么 + 参数」，代码负责「怎么做、重试、审计、限流」。
2. 「工具调用」可以只是一个 JSON 结构，进而可以被 schema 校验、被日志记录、被重放。

### 5.2 契约设计清单（可直接当 review checklist）

Anthropic 的工具写作指南（https://www.anthropic.com/research/writing-tools-for-agents ）给出的可落地项：

- **工具是确定性系统与非确定性 agent 之间的契约**；先原型、再用 held-out 测试集评估，而不是凭感觉。
- **不要给每个 API 都包一层**：做少数「工作流级」工具。示例：`search_contacts` + `message_contact` 优于 `list_contacts`；`schedule_event` 优于 `list_users` + `list_events` + `create_event`；`get_customer_context` 合并 `get_customer_by_id` + `list_transactions` + `list_notes`。
- **命名空间**：`asana_search` / `jira_search`；前缀与后缀的差异「有非平凡影响」（non-trivial impact）。
- **返回高信号**：去掉 `uuid`、`256px_image_url`、`mime_type` 这类低信息密度字段，保留 `name`、`image_url`、`file_type` 等决策相关字段。
- **token 效率**：分页、范围、过滤、截断、合理默认值。示例数字：同一工具 `ResponseFormat` 取 concise 时响应 72 tokens，detailed 时 206 tokens（约 1/3，原文见该文）；Claude Code 默认把工具响应限制在 25,000 tokens。
- **错误信息可操作**：不要只回 opaque 错误码/栈；说明失败原因、可尝试的下一步。
- **描述像向新同事解释**；参数名要明确（`user_id` 而非 `user`）。

### 5.3 schema 与返回结构模板

工具定义骨架：

```json
{
  "name": "search_contacts",
  "description": "按姓名/邮箱/公司检索联系人。用于回答『谁负责 X』『找到 Y 的邮箱』。不要用于列出全部联系人。",
  "input_schema": {
    "type": "object",
    "properties": {
      "query":    { "type": "string", "description": "姓名、邮箱或公司名；支持部分匹配" },
      "limit":    { "type": "integer", "minimum": 1, "maximum": 20, "default": 5 },
      "fields":   { "type": "array", "items": { "enum": ["name", "email", "company", "last_seen"] }, "default": ["name", "email"] }
    },
    "required": ["query"],
    "additionalProperties": false
  }
}
```

错误返回骨架（给模型看，不是给人看）：

```json
{
  "ok": false,
  "error": {
    "code": "RATE_LIMITED",
    "message": "search_contacts 每分钟限 30 次，当前已用尽。",
    "retryable": true,
    "retry_after_ms": 12000,
    "next_action": "等待后重试；若任务紧急，改用 get_customer_context 按 id 直查。"
  }
}
```

字段理由：`ok` 便于分支；`code` 稳定可编程；`message` 给人看；`retryable` + `retry_after_ms` 让模型能自己决定退避；`next_action` 是「错误信息即修复提示」。

### 5.4 校验层与控制流

- **schema 校验 + 一次修复重试**：解析失败时把校验错误原样回传（而不是吞掉），让模型自修；连续两次失败则降级为「人类可读的问题描述 + 请求澄清」。
- **错误压缩**：12-factor Factor 9 主张把错误压进上下文窗口（compact errors），而不是无限堆栈；实践中保留「首个失败点 + 关键 stderr 行 + 复现命令」。
- **控制流归你**：Factor 8「Own your control flow」建议自建控制结构，把「需要人确认/澄清」当作可以中断循环的事件；文档特别点名：**中断与恢复能力最需要发生在「工具选择」与「工具调用」之间**（https://github.com/humanlayer/12-factor-agents/blob/main/content/factor-08-own-your-control-flow.md ）。对应的实现就是审批点（approval gate），而不是让模型自己说「我确认过了」。
- **结构化输出 vs JSON mode**：优先 schema 约束（structured outputs / tool schema）；纯 JSON mode 无法约束字段，只适合内部中间产物。

---

## 6. 记忆分层：工作记忆 / 会话摘要 / 跨会话语义记忆

### 6.1 三层模型

| 层 | 载体 | 生命周期 | 主要风险 | 典型机制 |
| --- | --- | --- | --- | --- |
| 工作记忆 | context window 内的消息与工具结果 | 单轮/单会话 | 膨胀、context rot | 裁剪、tool result clearing |
| 会话摘要 | compaction 后的摘要 + 最近文件 | 单会话跨轮 | 过度压缩丢细节 | 保留决策/bug/实现细节 |
| 跨会话语义记忆 | 文件（MEMORY/NOTES）、KV、向量库 | 跨会话长期 | 陈旧、冲突、无来源 | 写入规则 + 检索 + 过期 |

Anthropic 的框架性提醒：context 是有限资源，随 token 增加会出现召回下降（context rot），因此要维护「注意力预算」，取「smallest possible set of high-signal tokens」（https://www.anthropic.com/research/effective-context-engineering-for-ai-agents ）。

### 6.2 MemGPT：把上下文当操作系统管理

MemGPT（arXiv:2310.08560，https://arxiv.org/abs/2310.08560 ）的核心是 **virtual context management**：借鉴传统 OS 的分层内存（快/慢内存之间搬数据，制造「内存很大」的假象），在 LLM 有限窗口内提供扩展上下文，并用 **interrupts** 管理模型与用户之间的控制流；验证场景是超长文档分析与多会话聊天。

三点可迁移：**分层而非扩大**（主上下文只放当前决策需要的信息，其余按需调入）；**中断即接口**（模型可主动要求「读更多」或「问用户」）；**写入经过管理逻辑**（决定什么进主上下文、什么留在外部），而不是把历史全塞进去。

### 6.3 长任务的三个官方手法

同文（context engineering）给的三招，按适用场景选：

- **compaction**：接近窗口上限时总结并重开窗口；保留 architectural decisions、unresolved bugs、implementation details，丢弃冗余工具输出；Claude Code 的做法是压缩后附上「最近访问的 5 个文件」。调参顺序：先最大化 recall（不漏关键信息），再迭代提高 precision。
- **structured note-taking**：把进度写进外部文件（`NOTES.md`、todo）。文中例子是 Claude 玩 Pokémon 时的计数记录：「for the last 1,234 steps I've been training my Pokémon in Route 1, Pikachu has gained 8 levels toward the target of 10」——关键在于**可核查的进度数字**，而非流水账。
- **sub-agent**：子 agent 用大量 token 探索，只回传「often 1,000-2,000 tokens」的蒸馏摘要，把噪声隔离在主上下文之外。
- 另有 **memory tool**（Sonnet 4.5 发布时进入 public beta）：文件式的外部记忆，便于跨会话积累知识库。

最轻的压缩是 **tool result clearing**（深层历史里的工具原始结果通常不再需要）。

### 6.4 Generative Agents：memory stream + reflection + retrieval

生成式智能体（arXiv:2304.03442，https://arxiv.org/abs/2304.03442 ）的做法是：把完整经验以自然语言记入 **memory stream**，随时间综合成更高层的 **reflection**，再通过 **retrieval** 动态取用并驱动 planning；25 个 agent 的沙盒实验里，消融显示 observation / planning / reflection 各自都关键，并观察到信息（如聚会邀请）在群体中传播的涌现行为。

迁移要点：**记忆不是存档，而是「检索源 + 反思产物」**：只存不反思退化成日志，只反思不存原始记录则无法追溯依据。

### 6.5 可抄的文件式记忆结构

```text
memory/
  MEMORY.md            # 索引：每条一行，含 id / 主题 / 日期 / 置信度
  decisions/           # 架构与取舍：一条决策一个文件
    2026-03-01-use-sqlite.md
  lessons/             # 踩坑与修复：可被 lint/CI 复用
    flaky-integration-tests.md
  sessions/            # 会话摘要（compaction 产物）
    2026-03-05-refactor-auth.md
```

单条记忆的字段模板：

```markdown
---
id: MEM-0042
kind: decision | lesson | fact | preference
created: 2026-03-05
source: PR#812 / session 2026-03-05
confidence: high | medium | low
scope: repo | module:src/auth | team
expires: 2026-09-01   # 可选；无过期则需复核
---
结论：<一句话>
依据：<可核查的证据：文件:行号、命令输出、链接>
适用条件：<什么情况下成立；什么情况下不适用>
```

写入规则（比结构更重要）：

1. **验证后才写**：只写「跑过/看过/确认过」的结论；推测标注 `confidence: low`。
2. **写前查重**：同主题已有条目则更新（带 revision），不要追加平行条目。
3. **带来源与范围**：没有 source 的记忆不可信；没有 scope 的记忆会被错误泛化。
4. **定期剪枝**：过期条目降级为归档，避免「记忆越多越糟」。
5. **索引与内容分离**：`MEMORY.md` 只放一行摘要供检索，正文按需读取——这正是「just-in-time」检索的思路（同文：维护轻量标识符，运行时再加载）。

### 6.6 检索策略与预算

混合检索：稳定约定预置（如 `CLAUDE.md`），易变事实按需检索（glob/grep）；经验值给记忆 ~10% 上下文预算，超出截断并提示不完整。检索不到必须明说「没有相关记忆」，不要用模型先验补全——这是记忆系统最常见的幻觉来源。

---

## 7. 经验固化：从「再说一遍」到「机器执行」

### 7.1 固化触发器

- 同一条建议被纠正 **2 次** → 固化（写进约束/检查，而非继续复述）。
- 同类 bug 出现 **3 次** → 加回归测试或 lint 规则。
- 某个流程每次都要人肉提醒 → 写成 skill/脚本，并在 CI 里跑。

### 7.2 ACE：把上下文当「演化中的 playbook」

论文：Agentic Context Engineering（arXiv:2510.04618，ICLR 2026；https://arxiv.org/abs/2510.04618 ）。它指出既有 context adaptation 方法有两个病：

- **brevity bias**：优化目标偏好简短通用的指令，丢掉领域洞见。
- **context collapse**：让 LLM 每次整体重写上下文，上下文会塌缩成更短、更少信息的摘要。

论文给的塌缩实例（原文数字）：在 AppWorld 上，第 60 步上下文 **18,282 tokens**、准确率 **66.7**；紧接着一步塌缩到 **122 tokens**、准确率降到 **57.1**，低于未做 adaptation 的 baseline **63.7**。

ACE 的解法是结构化增量：

- 上下文是 **evolving playbook**，由 **Generator**（产生轨迹）/ **Reflector**（提炼经验）/ **Curator**（整合成结构化更新）三角色协作维护。
- 上下文表示成 **itemized bullets**：每条含 metadata（唯一 id、被标记 helpful/harmful 的计数器）与 content（一个可复用策略、领域概念或常见失败模式）。
- **incremental delta updates**：只产生并合并「增量条目」，由非 LLM 的轻量逻辑确定性合入；因此可并行、可定位、可批量。
- **grow-and-refine**：新条目追加、旧条目原地更新（计数），用语义 embedding 去重；可在每次 delta 后主动剪枝，也可惰性到超出窗口时再剪。
- 效果（原文）：agents 上 **+10.6%**、finance 上 **+8.6%**；AppWorld 上最高 **+17.1%**；adaptation latency 平均降低 **86.9%**；无需标注监督，靠执行反馈；在 AppWorld leaderboard 上总体平均追平当时第一的生产级 agent（IBM-CUGA + GPT-4.1），在更难的 test-challenge split 上超过它，而自身用开源模型 DeepSeek-V3.1。

迁移到日常工程的三条：

1. **playbook 入库**（`playbooks/<domain>.md`），每条 bullet 可增删改，而不是每次重写整段 prompt。
2. **每条经验带计数器**：被采纳/导致失败各记一次，用于排序和剪枝。
3. **增量合并、拒绝整体重写**：这是防 collapse 的核心机制；人类维护 playbook 时同理——只做局部编辑。

### 7.3 playbook 条目模板

```markdown
### PB-012 集成测试必须显式设置 DATABASE_URL
- when: 跑 `pnpm test:integration` 或 CI 的 integration job
- do: 在命令前加 `DATABASE_URL=...`，并在失败信息里打印实际连接串（脱敏）
- why: 测试框架不会从 .env 读取；缺失时报「连接被拒绝」，与端口错误混淆
- evidence: PR#431（两次误判为端口问题）
- helpful: 5  harmful: 0
- last_reviewed: 2026-03-01
```

### 7.4 维护节奏

- 每周：把本周的纠正/事故写成 3–5 条 bullet，合并进 playbook（增量，不重写）。
- 每月：按 helpful/harmful 排序剪枝；把高频 bullet 提升为 lint/CI/hook（进入第 3 节的阶梯）。
- 每季度：用 held-out 任务集回归，确认 playbook 改动没有让老任务变差（ACE 的 ablation 思路）。

---

## 8. 八条可落地清单（含验收）

| # | 动作 | 期望效果 | 验收方式 |
| --- | --- | --- | --- |
| 1 | 给 prompt 加固定分区：角色 / 背景 / 指令 / 工具 / 输出 | 输出形态稳定，便于定位问题 | 同一任务跑 5 次，输出字段齐全率 100% |
| 2 | 把「必须完成」改写为可判定约束（grep/测试/文件数） | 减少「说做了但没做」 | 结束前检查命令全部通过；模型自述不参与判定 |
| 3 | 每条规则问「换仓库是否成立」，不成立的收进 background 或删除 | 降低硬编码脆弱性 | prompt 行数下降，任务成功率不降 |
| 4 | 用 3 个 canonical 示例替代边界案例清单 | 提升格式与决策一致性 | 示例扩充后，边界任务错误率不升 |
| 5 | 按任务档位配置 thinking 预算，从 1,024 起做 A/B | 找到边际收益转负点 | 记录正确率 / 时延 / 成本三元组 |
| 6 | 工具改为「工作流级」少数工具 + 高信号返回 + 可操作错误 | 降低工具误选与 token 浪费 | 单次任务工具调用次数与时延下降 |
| 7 | 建文件式记忆：MEMORY.md 索引 + decisions/lessons/sessions | 跨会话不重复踩坑 | 新会话能通过检索复述上周决策与依据 |
| 8 | 同一条纠正出现 2 次即固化（prompt → lint → CI → hook） | 知识不依赖模型记忆 | 同类问题 30 天内不再出现（按缺陷单统计） |

---

## 9. 反模式与未验证项

### 9.1 反模式

1. **堆形容词**（carefully / thoroughly / high quality）：不可判定，占用注意力。
2. **把所有规则加粗成 IMPORTANT**：Claude Code 文档明确指出这通常无效，规则要么被长文淹没，要么该改成 hook。
3. **一次重写整段 prompt**：容易 context collapse（第 7 节数字）；应做增量编辑。
4. **示例堆边界**：模型学会的是「奇怪输入的反射」，而不是标准行为。
5. **工具一 API 一包装**：工具集臃肿时「该用哪个」无解；人工说不清，模型更说不清。
6. **错误只回错误码**：模型无法自修，只能重试或放弃。
7. **无来源的记忆**：无法追溯，也无法判断是否过期。
8. **把「中断/审批」交给模型自述**：必须由 harness 在工具选择与调用之间拦截（12-factor Factor 8）。
9. **用更大 thinking 预算替代验收、或让记忆只追加不剪枝**：前者不保证正确，后者检索噪声持续上升。

### 9.2 未取到 / 未能验证

未能取到（本机网络限制；web_search 亦不可用）：

- Anthropic Prompt Engineering 文档（`docs.anthropic.com` / `platform.claude.com` 均重定向到 `www.anthropic.com` 并 404）——结构分区与 altitude 部分以 context engineering 工程博客替代。
- OpenAI Prompting Guide（`platform.openai.com` / `developers.openai.com` 返回 403 Cloudflare）——结构化输出部分以 12-factor Factor 4 与 Anthropic 工具指南替代。

未验证：

- 并行采样/自一致性在真实 agent 任务上的收益区间（第 4.4 节为工程经验，无原文数字）。
- ACE 的方法在非 AppWorld/金融任务上的迁移幅度；其 `+10.6%/+8.6%` 为论文报告值，未在本机复现。
- `output_config.effort` 档位与任务难度的映射，官方只给档位名、无量化阈值。

---

## 附：来源清单

| 来源 | URL | 取用情况 |
| --- | --- | --- |
| Anthropic 上下文工程 | https://www.anthropic.com/research/effective-context-engineering-for-ai-agents | 全文 |
| Anthropic 工具写作指南 | https://www.anthropic.com/research/writing-tools-for-agents | 全文 |
| Claude Code 最佳实践 | https://code.claude.com/docs/en/best-practices | 部分 |
| AWS Bedrock Extended thinking | https://docs.aws.amazon.com/bedrock/latest/userguide/claude-messages-extended-thinking.html | 全文 |
| ACE（arXiv:2510.04618） | https://arxiv.org/abs/2510.04618 | 摘要+正文 |
| MemGPT（arXiv:2310.08560） | https://arxiv.org/abs/2310.08560 | 摘要 |
| Generative Agents（arXiv:2304.03442） | https://arxiv.org/abs/2304.03442 | 摘要 |
| 12-factor-agents | https://github.com/humanlayer/12-factor-agents | README+4/8 |
| Anthropic Prompt Engineering | https://docs.anthropic.com/en/docs/build-with-claude/prompt-engineering/overview | 未取（重定向/404） |
| OpenAI Prompting Guide | https://platform.openai.com/docs/guides/prompt-engineering | 未取（403） |
