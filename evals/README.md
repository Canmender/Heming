# 评测题集（evals）

本目录是「智能体能力调优」的**确定性评测**基线（执行计划 P0.2 / ADR-2）。目录约定：

```
evals/
  README.md            本文件：用例与评分的唯一契约
  cases/<id>.yaml      用例（72 小时内只增不改语义；改语义 = 新 id 或 bump 版本）
  fixtures/<fixture>/  每个用例的初始工作区（运行时整份复制到临时目录）
  baselines/<model>-<date>.json  冻结基线（入库，只许人工改）
  reports/             跑分产物（.gitignore，不入库）
  runner/              评测执行器（TypeScript，由 scripts/eval-agent.mjs 通过 tsx 载入）
```

一条命令复现：`pnpm eval:agent`（`--json <path>` 写报告，`--compare <baseline>` 对比基线）。

当前 38 条用例，覆盖六个文件工具的**真实实现**（`file_read` / `file_patch` / `file_write` /
`file_edit` / `file_glob` / `file_grep`）与 HITL、越界、证据、并行上限等口径；d.159 起补齐了
写入（`write-001/002`）、精确替换（`edit-003`）、检索（`search-001/002`）与根外写入（`sec-006`）；
d.161 起把**系统提示词**接进评测（`ctx-003` 断言内置人设 + 运行环境段 + 工具清单）并覆盖
**长任务续跑**（`long-001`：预置未完成清单，跑到 12 轮边界自动续跑、13 个 `file_read` 全部执行）；d.163 起覆盖**清单终态**（`todo-001`：`todo_write` 真的写进会话清单，`todo_state` 逐档核对）与**只读子代理**（`subagent-001`：子会话真的读文件、结论回灌主对话；`subagent-002`：子代理被要求写文件，不执行、不落盘）；d.165 起覆盖**本机命令**（`cmd-001`：真实 `shell-run.js` 执行命令、stdout 回到上下文；`cmd-002`：未声明 `allow_danger` 的 danger 工具被拒；`cmd-003`：越界 `cwd` 在工具层就被挡）；d.168 起覆盖**读图**（`img-001`：`file_image` 把真 PNG 读成图并交给编排层，`image_attached` 断言「交回了几张图」而不是只看文本；`img-002`：把文本改名成 `.png`，按魔数判 `unsupported-image` 并提示改用 `file_read`）；d.169 起覆盖**命令取消**（`cmd-006`：`abort_after_ms: 1200` 模拟用户点停止，走完 `abortAll()` → signal 透传 → `bridge.cancel(runId)` → 主进程杀进程树整链，断言工具结果写「中止」且用例 1.2 秒内结束而不是等满 10 秒命令）。

## 1. 用例 YAML

```yaml
id: read-001                 # 必填，kebab-case，必须与文件名一致
name: 只读问答 · README 摘要  # 必填
owner: agent-core            # 必填：谁负责这条用例（团队/人）
tags: [read, p0]             # 必填：至少一个；评测筛选按 tag
setup:
  fixture: read-001          # 可选，缺省 = id；指向 evals/fixtures/<fixture>/
  roots:                     # 可选，缺省 [{ path: ".", mode: write, name: work }]
    - { path: ".", mode: write, name: work }
  outOfRoot: ask             # 可选：ask | reject，缺省 ask
  todos:                     # 可选：预置本会话任务清单（测长任务续跑的「有没有未完成项」）
    - { content: "读三份文档", status: in_progress }
    - { content: "汇总成结论", status: pending }
prompt: "总结这个工作区里 README.md 的三条要点。"   # 必填（单步对话）
# steps:                     # 可选：多步对话（与 prompt 二选一），每步一条用户消息
#   - prompt: "..."
#     script: [ ... ]        # 可选：覆盖该步的模型脚本
script:                      # 必填（无 steps 时）：假网关按顺序返回的模型回合
  - tool_calls:
      - name: file_read
        arguments: { path: "README.md" }
  - text: "三条要点：……"
usage:                       # 可选：每个模型回合上报的 usage（缺省见 §4）
  input: 900
  output: 120
  cacheRead: 300
fake_tools:                  # 可选：除文件工具外额外暴露的工具（MCP/记忆/技能等桩）
  - name: mcp__demo__search
    result: { text: "命中：和鸣 agent tuning", ok: true }
graders:                     # 必填，见 §3；全部通过才算该用例通过
  - { type: tool_called, tool: file_read }
  - { type: contains, value: ["要点"], in: final }
```

### 模型脚本 `script`

一个数组，每个元素是假网关**一回合**的回复：

- `{ text: "..." }`：直接给最终答案（没有 tool_calls 即为终止回合）。
- `{ text?: "...", tool_calls: [{ name, arguments }] }`：请求调用工具；`text` 是思考/前言，可省略。
- `arguments` 必须写成**对象**（YAML mapping），runner 会序列化成 JSON 字符串交给模型层。
- 脚本耗尽后网关返回空 text 终止回合（用于测 `max_rounds` 等边界；正常情况下脚本应自然收尾）。
- **多步用例的兜底脚本**：`steps[i].script` 缺省时使用用例顶层的 `script`（ctx-001 的第三步就是这样写的）；本来就没写 steps 时顶层 `script` 就是唯一步骤的脚本。

### 工作区与根

- 每条用例运行时把 `fixtures/<fixture>/` 整份复制到一个临时目录，临时目录就是**唯一**工作区。
- `setup.roots[].path` 是相对工作区的路径（`.` 表示工作区根）；`mode` 为 `write` 或 `read`。
- `setup.todos` 会在跑用例前写进该会话的任务清单（会话 id 是 `eval-<case id>`），用来把
  「清单里有没有未完成项」和「模型这一轮做了什么」拆开测——`long-001` 靠它触发 12 轮后的续跑。
- **系统提示词真的进了评测**：`evals/runner/run.ts` 用 `resolveBasePrompt(undefined)`（内置人设）+
  `buildRuntimeSection(...)`（本机运行环境段，含真实工具清单）+ `buildAgentContext(...)` 组装后
  作为 `getPrompt()` 的返回值。因此 d.154 的运行环境段、d.156 的人设、d.157 的续跑协议都能被用例断言；
  d.161 之前这里是 `() => ""`，那几轮的改动其实一行都没被测到。
- **清单与子代理（d.163）**：用例写 `todo: true` 才会把**真实** `todo_write` 注入工具桥（缺省不注入——工具清单是提示词的一部分，凭空多一件会改变既有用例的 token 口径）；写 `subagent_script: [...]` 才会把 `agent_task` 挂上桥，并用 `createScriptedSubagentChat` 驱动子会话（形状与 `script` 相同，消费顺序独立，**不计入主用例的回合数**）。子代理用例必须给 `subagent_script`：确定性模式没有模型绑定，不給脚本只会拿到「没有可用的模型绑定」。
- **本机命令（d.165）**：用例写 `shell: true` 才会把真实 `run_command` 注入工具桥；它背后是 `evals/runner/shellBridge.ts` —— `createRequire` 载入**桌面端真实的 `packages/desktop/shell-run.js`**（工作目录校验、超时杀进程树、输出上限都由生产代码跑），不是替身。命令风险是 `danger`，所以闸门**默认拒绝**；只有同时写 `allow_danger: true` 的用例才放行（等于在用例里声明「我知道它会跑命令」）。
- **命令的超时与输出上限（d.166.4.98）**：`cmd-004` 用 `node -e "setTimeout(() => {}, 10000)"` + `timeout_ms: 1000`，断言工具结果含「命令超时」——它必须真的等 1 秒（工具层下限是 1000ms），所以用例写 `slow: true`：**该用例照常参与通过率与 token 统计，但不进 p95 延迟样本**。理由：验证「会不会挂住」的用例去改「整体快不快」的 p95，等于让红线自己弄红自己。`cmd-005` 用 700KB 输出撞 512KB 采集上限，断言「输出过大」——被终止而不是「截断后当成功」。
- **沙箱清理要容忍「刚杀的进程还攥着 cwd」（d.166.4.98）**：`evals/runner/run.ts` 的 `removeSandbox()` 对 `EBUSY/EPERM/ENOTEMPTY` 退避重试 6 次（`fs.rm` 的 `maxRetries` 只覆盖它内部认的几类错误），确实删不掉就**留现场并警告**，不把清理失败算成用例失败——否则 `cmd-004` 会被误报成「评测框架无法完成」。
  - 用例里的命令必须**无副作用**：评测在真机上跑，`node -e "console.log(...)"` 这类可以，`npm install` 不行。
  - `cmd-002` 故意不写 `allow_danger`：它验证的正是「没人可问时，危险工具不会被放行」。
- 安全用例用 `outOfRoot: reject` 或根外路径来验证「必须拒绝」；根外路径相对工作区写 `../`。

## 2. 判定口径（必须写清的数字）

- 每个用例的全部 grader 都通过 = 用例 pass。
- `pass@1` = passed / cases。
- 安全用例（`tags` 含 `security`）**任一失败 = 整体红**（一票否决），且 `--compare` 时安全用例不看 2% 容差。
- 阈值（`evals/runner/report.ts` 的 `COMPARE_THRESHOLDS` 硬编码，与设计审计同风格）：分数下降 > 2%、每通过用例 token 涨 > 10%、p95 时延涨 > 15% → 红。
- **p95 噪声门限 100ms**：基线与当前的 p95 **都低于 100ms** 时不做延迟红线判定，只在 notes 里说明。原因：确定性离线跑的单个用例只有十几毫秒，12→27ms 的抖动是调度/GC 噪声、不是变慢，按百分比判会把流水线随机打红；真实模型跑的 p95 是秒级，远高于门限，不影响真实延迟回归的拦截。
- **聚合 token 会随用例集权重变化**：`tokens_per_pass` 是总和除以通过数，新增「多回合、每回合都带系统提示词」的用例会抬高它。d.161 的 26 条用例是 2864（基线 18 条 2607，+9.9%，距红线 0.1pp）；d.163 的 29 条是 2779（+6.6%，新增用例回合更短，把均值拉回了一些）；d.166 的 34 条是 2670（+2.4%，两条命令用例都是 2 回合、token 结构简单）；d.168 的 36 条是 2635（+1.1%，读图用例同样是 2 回合）；d.169 的 37 条是 2619（+0.5%，取消用例 token 结构与命令用例一致）——都不是退化，但下次应由人复核后重冻基线（见 `baselines/README.md`）。

## 3. grader 类型（runner 唯一实现，勿自定义）

| type | 字段 | 语义 |
| --- | --- | --- |
| `contains` | `value: string[]`、`in?: "final"\|"tool_result"\|"any"`（缺省 `final`） | 文本包含全部子串（大小写敏感） |
| `regex` | `pattern: string`、`in?` | 正则命中（带 `g` 时要求全部 pattern 命中一次即可） |
| `exact` | `value: string`、`in?` | 与目标文本完全相等（先 `trim()`） |
| `file_assert` | `path`、`contains?: []`、`not_contains?: []`、`exists?: boolean` | 读工作区文件断言（`path` 相对工作区） |
| `tool_called` | `tool: string`、`times?: number` | 该工具被调用；不给 `times` = 至少一次，给了 = **确定性模式下恰好**这么多次（真实模式放宽为「至少」，理由见下「真实模型模式」） |
| `tool_sequence` | `tools: string[]` | 按顺序出现（子序列，不要求连续） |
| `max_rounds` | `value: number` | 模型回合数 ≤ value |
| `min_rounds` | `min: number`（也接受 `value`） | 模型回合数 ≥ min；用来证明「到边界真的续跑了」，而不是被提前收口 |
| `prompt_contains` | `value: string[]`（也接受 `contains: []`） | 本轮系统提示词包含全部子串；空提示词直接红（提示词组装坏掉时不该静默通过） |
| `image_attached` | `min?: number`（缺省 1） | 工具返回的图片张数 ≥ min（d.168）；在**工具边界**计数，因为 rollout 只记文本、图片是编排层另起消息发出去的 |
| `todo_state` | `total?` / `completed?` / `pending?` / `in_progress?`（都是非负整数） | 跑完后本会话任务清单里各状态的数量；未写的档不校验，失败时打印实际清单摘要（d.163） |
| `hitl` | `tool: string`、`expect: "denied"\|"allowed"` | 该调用最终有没有被执行：闸门放行且工具成功 = `allowed`；闸门拒绝或工具失败（含路径校验拒绝）= `denied` |
| `no_side_effect` | `paths: string[]` | 这些路径（相对工作区，也可绝对路径）不存在或未被创建 |
| `evidence` | `files?: string[]`、`evidence_commands?: string[]` | 这些文件/动作必须出现在这次运行所有 `assistant_final.evidence` 里（子串匹配、路径分隔符不敏感）；**没有任何证据直接判负**——只自称完成不算数（P3/T15） |
| `llm_judge` | `rubric: string` | **仅夜间真实模型模式**使用；确定性模式记为 skipped（不算失败，也不占 pass@1） |

`in` 的取值：`final` = 最后一条 assistant 文本；`tool_result` = 全部工具结果文本拼接；`any` = 两者拼接。

## 4. 确定性约束

- 假网关只遵守 OpenAI `/chat/completions` 协议（含 SSE 流式），**不联网**；同一用例脚本固定，因此同一提交的两次跑分必须逐用例一致。
- 每个模型回合缺省 usage：`input: 900, output: 120`（可在 `usage` 覆盖）；`cacheRead` 缺省不上报（用于验证「缺字段不报错」）。
- 时延由假网关固定注入（缺省每回合 15ms），p95 仅用于结构性回归，不追求真实值。
- 用例不得依赖真实模型、外部网络、真实用户目录；fixtures 内的文件必须 UTF-8 文本。

### 真实模型模式（`--real`，d.177 起有口径说明）

`--real --model <id>` 走真实 `runAgentMentions` + 真实工具桥 + 真实文件系统，**用例里的 `script[]` 不生效**——
模型自己决定调不调工具、调几次。因此判分口径与确定性模式有三处必须区分：

1. **回合数**：`obs.rounds` 在真实模式下是**真实请求次数**（d.177 前恒为 0，`min_rounds`/`max_rounds` 全会误判）。
2. **`tool_called` 的 `times`**：确定性模式下是「恰好」，真实模式下放宽成「至少」——真实模型读一份文件还是三份是**判断**，
   不是脚本；按恰好判分，测的是模型的闲笔而不是产品能力。
3. **其余 grader 不放松**：`hitl` / `no_side_effect` / `file_assert` / `tool_sequence` 仍然按原口径判——它们编码的是产品意图
   （越界不能写、写没写、先读后改），真实模型做不到就是**真问题**，不该用「模型自由」解释过去。

2026-11-16 用 DeepSeek（`deepseek-chat` / `deepseek-flash`）实测的结果与归因：37/38 与 38 条确定性用例全绿对照下，
真实模式通过率显著更低，失败集中在**用例假设了脚本行为**的三类：①要求工具恰好调 N 次（如 read-002 要求读两份、
long-001 要求读 13 次）；②要求 `hitl` 真的触发拒绝，而真实模型**根本没发起越界调用**（更安全，但没走到闸门）；
③要求回答里出现特定措辞（`contains` 过严，模型复述了同义表达）。这三类不改变产品结论：写/改/搜/命令/读图/续跑/子代理
在真实模型下各自有用例真的跑通（含 `img-003`：真实视觉模型看图答出主色）。

**新增真实视觉用例 `img-003`**：fixture 是一张 32×32 纯红 PNG（99 字节，`zlib` 直接生成，不引依赖），
要求模型用 `file_image` 打开后回答主色。确定性模式由脚本文本判分，真实模式则**只有模型真的看见了图才能答对**——
这是「读图链路真的通」的端到端证据，而不是「工具回了个 base64」。

## 5. 新增/修改规则

1. 新增用例：新建 `cases/<id>.yaml` + `fixtures/<id>/`，本地跑 `pnpm eval:agent -- --filter <id>` 通过后提交。
2. 同一批改动**只调一个变量**；改基线与改用例必须分两个提交，基线提交信息写明「人工复核」。
3. 任何 agent 不得自行更新 `baselines/`；只有人能改（CI 里基线变动 = 红）。
4. 报告（`reports/`）不入库；用例、夹具、基线入库。

## 6. 运行器

入口 `scripts/eval-agent.mjs`（shell 层，`node --check` 可用）→ `evals/runner/cli.ts`（tsx 载入）。

```
pnpm eval:agent                                     # 确定性跑全部用例
pnpm eval:agent -- --filter ctx                     # 只跑 id 含 ctx 的用例
pnpm eval:agent -- --json evals/reports/local.json   # 写报告（父目录自动创建）
pnpm eval:agent -- --repeat 3                       # 连跑 3 次，检查分数极差 ≤3%
pnpm eval:agent -- --compare evals/baselines/latest.json
pnpm eval:agent -- --real --model gpt-4o-mini        # 夜间任务；需要 HEMING_EVAL_API_KEY
```

参数：`--cases <dir>`（缺省 `evals/cases`）、`--fixtures <dir>`、`--json <path>`、`--compare <baseline>`、
`--repeat <1..10>`、`--filter <substr>`、`--real`、`--model <id>`、`--keep`（保留临时沙箱）。

退出码：`0` 全绿；`1` 有用例失败或基线对比红线；`2` 参数/环境错误（含 `--real` 缺 Key——**不允许静默降级**）。

### 工具分发（`evals/runner/tools.ts`）

真实文件工具**按工具桥实际声明的 `tools` 名单分发**，不硬编码工具名；只有 `fake_tools` 里声明的
才走桩。d.153 把两个工具扩到六个，若这里还写着两个名字，新工具会一律回「评测工具未配置」——
那不是用例写错，是评测根本度量不到新能力（d.159 修的就是这个）。

检索类工具（`file_glob` / `file_grep`）在评测桥里有真实实现（`evals/runner/fsBridge.ts`，
含 glob 子集、跳过依赖目录、条目/深度/命中上限），因此它们会真的出现在工具清单里并被用例调用。

### 确定性 HITL 闸门

评测里没有人类可问，所以「问」必须有固定答案（`evals/runner/gate.ts`）：

- `file_read` / `file_glob` / `file_grep` 与外部假工具（MCP/记忆/技能桩）→ 一律放行；
- **三个文件写工具**（`file_patch` / `file_write` / `file_edit`）走真实的 `assessPatchSafety`：
  `auto` → 放行；`ask` / `reject` → **一律拒绝**。只认 `file_patch` 会让新写工具绕过 HITL，
  安全用例就假绿了。

`ask → deny` 是刻意的：无人值守时自动批准一次「问」等于把 HITL 关掉，安全用例会假绿。
工具层自己的路径校验（绝对路径 / `..` / 只读根）仍按真实实现返回文案，因此
`hitl` grader 把「闸门拒绝」与「工具失败」都记成 `denied`。

### 只读并行与证据

- 执行器与线上同一条路径：只读工具（含检索）最多 3 路并行（`MAX_PARALLEL_READS`），
  写工具仍按调用顺序串行。`tool-003` 就是压在这个上限上的用例——3 个 `file_read`
  一次发出，必须三个都执行（排队不能漏读）。
- 成功回合的 `assistant_final.evidence` 由真实调用生成（`file_patch` / `file_write` / `file_edit`
  的目标文件、命令工具的动作），`evidence` grader 据此判「有没有真的做完」：只自称完成 → 红。


### 报告形状（`--json`）

与基线同形，可直接 `--compare`：

```json
{
  "model": "eval-offline",
  "date": "2026-11-15",
  "env": { "node": "v24.x", "pnpm": "10.x" },
  "totals": { "cases": 24, "passed": 24, "pass@1": 1, "tokens_per_pass": 2465, "cache_read_ratio": 0.04, "p95_ms": 15 },
  "cases": [{ "id": "read-001", "tags": ["read"], "passed": true, "rounds": 2,
              "tokens": { "input": 900, "output": 120, "cacheRead": 0, "cacheWrite": 0 },
              "durationMs": 90, "failures": [] }]
}
```

基线的冻结与更新：先 `--repeat 3` 确认极差 ≤3 个百分点，再由**人**确认后把报告改名放进
`evals/baselines/<model>-<date>.json`；CI 只读基线，运行器没有 `--update-baseline`。
