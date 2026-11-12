# agent-pipeline

和鸣的多智能体流水线服务：**Plan → Execute → Reflect（可 replan）→ Critic → Summarize**，对抗模式再加 **Coder ↔ Tester** 双智能体迭代（跑真实测试命令拿覆盖率，直到达标或轮数用尽）。

它和 web 端的 `agentStream.ts` 是两套东西，但共享同一套语义：

- `agentStream.ts` 在 Electron 渲染进程里跑「一次对话轮」的 ReAct 循环（真实用户会话，含 HITL 确认）；
- 本服务是**可编排、可观测、可回滚**的后端流水线，用来跑长任务/批量任务，带 Prometheus 指标、灰度配置与自动回滚、日志驱动调优。

设计文档见 [DESIGN.md](DESIGN.md)（15 节：Memory↔Tool 协议、ReAct 拆分、LangGraph 状态机、角色分工、RAG、Function Calling、对抗迭代、监控回滚、每日调优、10 万次稳定性）。

## 快速开始

```bash
cd services/agent-pipeline
uv venv --python 3.14 .venv
# 注意：uv 建的 venv 里没有 pip，`python -m pip ...` 会失败，用 uv pip 装
uv pip install --python .venv/Scripts/python.exe -e ".[dev]"    # Windows
# uv pip install --python .venv/bin/python -e ".[dev]"            # macOS / Linux

.venv/Scripts/python.exe -m pytest -q                 # 56 例，全离线
```

CLI（不需要起服务）：

```bash
# 自检：不调模型，检查配置/目录/依赖
.venv/Scripts/python.exe -m agent_pipeline.runner doctor

# 真跑一次（需要模型 key）
set AGENT_PIPELINE_API_KEY=sk-...
.venv/Scripts/python.exe -m agent_pipeline.runner run --goal "给 utils.py 补测试并跑到 90% 覆盖率" --mode adversarial --coverage-command "pytest --cov=src --cov-report=term-missing"

# 起服务
.venv/Scripts/python.exe -m agent_pipeline.runner serve --port 8000

# 日志驱动的每日调优（只分析，不自动上线）
.venv/Scripts/python.exe -m agent_pipeline.runner tune --log runs.jsonl --since-hours 24

# 让服务自己每天跑一次（默认关闭，需显式打开；见下方「每日调优调度」）
AGENT_TUNE_ENABLED=1 .venv/Scripts/python.exe -m agent_pipeline.runner serve --port 8000

# 把自己的文档灌进知识库（RAG）：目录递归、按扩展名过滤、doc_id = 前缀 + 相对路径
.venv/Scripts/python.exe -m agent_pipeline.runner ingest docs/ README.md --prefix "repo/"
```

## 知识库（RAG）的灌入方式

两条路，写的是同一张 SQLite 表：

- **CLI**：`agent-pipeline ingest <文件或目录>... [--prefix 前缀] [--ext .md,.txt]`。目录递归、按扩展名过滤（默认 `.md/.txt/.rst/.py/.ts/.json/.yaml/.yml`），`doc_id` = 前缀 + 相对路径，所以同一份输入重跑得到同一批 id（幂等覆盖）。空文件与非 UTF-8 文件跳过并报告；超过 20 万字符的截断（与 `POST /v1/knowledge` 的上限一致）。
- **HTTP**：`POST /v1/knowledge`（`{doc_id, text, title}`，同 id 整体替换）、`GET /v1/knowledge`（规模）、`DELETE /v1/knowledge/{doc_id}`。

灌进去之后，`knowledge_search`（只读工具，模型自己会调）才会命中并带 `citations`；摘要阶段只保留「观测里真的出现过」的 `doc_id`，编造的引用会被过滤掉。

## 每日调优调度

`AGENT_TUNE_ENABLED=1` 时，服务启动会拉起一个后台 daemon 线程（`scheduler.DailyTuner`）：

- **起来就先跑一次**，之后每 `AGENT_TUNE_INTERVAL_S`（默认 86400 秒）跑一次；容器重启不会白等一天；
- 每轮读 `AGENT_LOG_PATH` 里最近 `AGENT_TUNE_WINDOW_HOURS`（默认 24）小时的 run 日志，走 `tune()` 同一套逻辑：聚类失败模式 → 出候选 → 评测 → **只有评测有提升才注册 canary 版本**；
- 任何异常都被收成 `ScheduleResult.error` 并计入 `pipeline_tune_runs_total{status="error"}`，线程不会因为一轮失败而死掉；
- `/health` 的 `tuner` 段给出 `enabled / running / last_error / last_ran_at / next_run_at`，以及 `last_report` 摘要（这轮读了多少 run、多少失败、失败模式、候选数、是否落地了版本）——只看指标看不出「调优到底读到了什么」，出问题时要能一眼看出是「日志没数据」还是「没有可改进的候选」；`GET /metrics` 另有 `pipeline_tune_candidates`、`pipeline_tune_applied_version`；
- `POST /v1/tune` 手动触发一次（走同一个 `DailyTuner`，指标口径一致）。

**评测器**：`tune` 只有在评测器给出「候选 ≥ 基线 + 0.02」时才会注册灰度。`AGENT_TUNE_EVAL=1` 会接上内置的「回放 A/B」评测器（`scheduler.build_replay_evaluator`）：取日志里最近 `tune_eval_budget`（默认 20）个失败任务，同一批任务分别用「现状提示词」和「现状 + 失败模式建议 + few-shot」各跑一遍完整流水线，比较成功率。

- 评测在**影子 runtime** 里跑：内存版配置库与记忆、`log_sink` 丢弃、独立指标——不会污染线上日志、灰度版本和指标，也不会把评测轨迹写进记忆；
- 开销是 2 × `tune_eval_budget` 次完整流水线，所以默认关闭；不接评测器时只出报告、不注册任何版本。

红线不变：调度器**只注册灰度版本**，转正走 `/v1/config/promote`，出错由错误率窗口自动回滚。

## HTTP 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 存活 + 当前配置版本 + 运行中数量 |
| GET | `/metrics` | Prometheus 指标（`pipeline_*`） |
| POST | `/v1/runs` | 提交一次 run（202；并发满返回 429 + `Retry-After`；同 `run_id` 幂等） |
| GET | `/v1/runs/{id}` | 查状态/结果 |
| POST | `/v1/runs/{id}/cancel` | 请求停止一个正在跑的 run（节点边界收口为 `aborted`，`stop_reason="cancelled"`；未结束前重复调用 202/409 都算正常） |
| POST | `/v1/runs/{id}/approve` | HITL 审批（需 `AGENT_APPROVAL_MODE=write`；body `{call_id?, approved}`，没有待审批返回 409） |
| GET | `/v1/config` | 当前 active/canary 配置与历史 |
| POST | `/v1/config/promote` | 把 canary 提升为 active |
| POST | `/v1/config/rollback` | 手动回滚；body 里给 `version_id` 就切到那个历史版本，不给就只归档当前灰度 |
| POST | `/v1/tune` | 基于日志生成候选配置（可选 evaluator 决定是否上灰度） |
| GET | `/v1/tools` | 已注册工具与 schema |
| POST | `/v1/knowledge` | 往知识库写一份文档 `{doc_id, text, title?}`（同 id 整体替换，返回切块数与统计） |
| GET | `/v1/knowledge` | 知识库规模 `{documents, chunks, episodes}` |
| DELETE | `/v1/knowledge/{doc_id}` | 删掉一份文档及其全部片段（不存在 404） |

```bash
curl -s http://localhost:8000/v1/runs \
  -H 'content-type: application/json' \
  -d '{"goal":"总结 README 的三个要点","mode":"react"}'
```

## 配置（环境变量）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `AGENT_PIPELINE_API_KEY` | — | 模型 key（必填，除非只跑 doctor/测试） |
| `AGENT_PIPELINE_MODEL` | `deepseek-chat` | 模型名 |
| `AGENT_PIPELINE_BASE_URL` | `https://api.deepseek.com` | OpenAI 兼容端点 |
| `AGENT_LOG_PATH` | `runs.jsonl` | 每次 run 一行 JSON（调优输入） |
| `AGENT_LOG_MAX_BYTES` | `67108864` | 日志超过该字节数就整份轮转为 `.1`（留一代） |
| `AGENT_RUN_HISTORY_LIMIT` | `500` | 服务内存里保留多少个已结束 run（超出丢最旧，避免长跑漏内存） |
| `AGENT_SHUTDOWN_GRACE_S` | `5` | 关停时给在跑的 run 留多少秒自己收口（置取消标记后等它走到节点边界） |
| `AGENT_PIPELINE_DB` | `agent-pipeline.db` | 记忆 + 配置版本 SQLite |
| `AGENT_MAX_EPISODES` | `5000` | 情景记忆上限（超限删最旧；0 = 不限制） |
| `AGENT_MAX_DOCUMENTS` | `2000` | 知识库文档上限（超限删最旧并连带删块） |
| `AGENT_MAX_EPISODE_AGE_DAYS` | `0` | 情景记忆按天数过期（0＝不按时间淘汰，只受条数上限约束） |
| `AGENT_OUTCOME_LIMIT` | `5000` | 回滚判定用的 outcome 行数上限（窗口只看最近 50 条；0＝不裁） |
| `AGENT_IDEMPOTENCY_MAX_ENTRIES` | `1000` | 幂等缓存条数上限（0＝不限；真实流量下参数几乎不重复，只靠 TTL 会随调用量涨内存） |
| `AGENT_CANARY_RATIO` | `0.1` | 灰度比例（按 run_id 稳定分桶） |
| `AGENT_MAX_CONCURRENCY` | `4` | 并发上限 |
| `AGENT_ERROR_THRESHOLD` | `0.2` | 自动回滚错误率阈值 |
| `AGENT_LATENCY_THRESHOLD_S` | `120` | 自动回滚 P95 延迟阈值 |
| `AGENT_TUNE_ENABLED` | `0` | 是否在服务里跑每日调优线程 |
| `AGENT_TUNE_INTERVAL_S` | `86400` | 调优周期（秒）；测试里可调小 |
| `AGENT_TUNE_WINDOW_HOURS` | `24` | 每轮看最近多少小时的日志 |
| `AGENT_TUNE_OUT` | 空 | 每轮调优报告的落盘路径（空 = 不落盘） |
| `AGENT_TUNE_EVAL` | `0` | 开「回放 A/B」评测器（否则调优只出报告，不注册灰度） |
| `AGENT_APPROVAL_MODE` | `off` | `write` = 非只读工具执行前挂起等审批；`off` = 不拦 |
| `AGENT_APPROVAL_TIMEOUT_S` | `300` | 等审批的时限；超时按**拒绝**处理（绝不悄悄放行） |
| `AGENT_ALLOW_PRIVATE_HOSTS` | `0` | 放开 `http_get` 访问内网/本机地址（默认拒；见「网络出口」） |
| `AGENT_SERVICE_TOKEN` | 空 | 服务自己的入站令牌：设了则 `/v1/**` 要 `Authorization: Bearer <token>`（空 = 本机调试，`/health` 报 `auth: off`） |

预算（`Budget`）：`max_steps=8`、`max_llm_calls=40`、`max_tokens=120_000`、`max_wall_clock_s=600`、`step_tool_budget=6`、`max_replans=2`、`max_adversarial_rounds=2`。超预算时流水线**不硬失败**，而是带 `status="budget"` 和 `stop_reason` 返回已完成的部分。

## 取消一个 run

长任务不能只能靠杀进程停。`POST /v1/runs/{id}/cancel` 只置一个标记：正在执行的那次模型调用不会被打断（HTTP 请求没法安全打断），但**下一个节点边界**会看到标记，直接以 `status="aborted"` / `stop_reason="cancelled"` 收口，`summarize` 仍会跑完并回「取消前已完成的内容」——不用等 10 分钟墙钟超时。

- 已完成/失败的 run 再取消返回 409；不存在的 run 返回 404；
- **卡在等审批会被立刻放出来**：取消同时把该 run 的待审批全部按拒绝收口，执行线程不再干等 `AGENT_APPROVAL_TIMEOUT_S`（默认 300s）。否则用户点了取消，界面两三分钟没反应，看起来就是「取消坏了」；run 正常结束时也会清掉残留审批，`/health` 的 `pending_approvals` 不会只增不减。`tests/test_cancel_approval.py` 2 例钉住；
- 取消是协作式的：卡在**工具调用**里的 run 要等这次工具超时（`AGENT_TOOL_TIMEOUT_S`）才走到下一个边界（工具线程没法安全打断）；
- `tests/test_cancel.py` 4 例覆盖（跑到一半取消、未知 run、已结束 run、重复取消）。

**四路叠加压测**（工具 + 审批 + 中途取消 + 8 线程并发）：
`soak.py --runs 3000 --concurrency 8 --tools --approval --cancel-rate 0.15` →
2,571 次真实工具执行、2,690 次审批自动裁决、429 次中途取消、15,494 次模型调用、**0 失败**、
14.9 run/s、P50 600ms / P95 749ms、内存峰值 4.76MB（结束 1.78MB）、`episodes` 稳定在 5000。
这条比单跑一条路径更接近真实流量：审批闸、取消标记、工具线程池、SQLite、指标都在同一时刻被用。

### 在真实仓库文档上试过

```
agent-pipeline ingest <repo>/docs --prefix repo/ --ext .md
→ 知识库写入：202/202 个文件、4659 个切片
   查询「安装器通用外壳」→ 命中 setup-installer 规格与 deploy.md（分数 33 / 24 / 22）
   查询「容器化部署 Prometheus 监控」→ 命中 HANDOFF 里的交付物自检与压测记录
```
`doc_id = prefix + 相对路径`，所以引用里能直接看到来源文件；空文件/非 UTF-8 会被跳过并在输出里报数。
注意库文件默认落在**当前工作目录**（`AGENT_PIPELINE_DB` 可改），不要在多处混用一个相对路径。

## 幂等在并发下也成立

同一个 `run_id` 8 个线程同时提交：全部 202、只会真跑一次（`pipeline_runs_total{status="ok"}` 只加 1）。
串行幂等靠「先查字典再写」就够；并发若没把「查 + 占位」放进同一把锁，会出现两个执行线程、
两次计费、结果互相覆盖。`tests/test_concurrency.py` 的
`test_same_run_id_submitted_concurrently_runs_once` 钉住这条。

## 预算截断要看得见

- **单步工具预算**：一步最多 `AGENT_STEP_TOOL_BUDGET`（默认 6）次调用。超出时以前 `calls[:remaining]`
  直接切掉——模型以为自己调过了，下一轮基于「其实没发生」的前提推理。现在每个被丢掉的调用都留一条
  失败观测「这次调用没有执行：本步骤的工具调用预算已用尽（每步最多 N 次）」，模型能看到并决定下一步。
- **计划步数**：规划提示里写明「本次最多 N 个步骤（超出会被丢弃）」，N 取 `AGENT_MAX_STEPS`。
  提示词默认写「3-7 步」，但预算被调小时旧实现会静默截断后几步计划。

`tests/test_step_budget_observable.py`、`tests/test_plan_step_limit.py` 各 1 例。

## 任务的 `cwd` 真的决定命令在哪跑

`TaskSpec.cwd` 以前只写进提示词（「工作目录：D:/proj」），但 `run_command` 总在**服务进程自己的目录**里执行——
模型以为在项目目录里改文件，实际写到了别处，日志里还看不出异常。现在：

- `run_command` 的 schema 多了可选 `cwd`；
- 执行节点在模型没给 `cwd` 时用任务的 `cwd` 兜底，模型显式给了就尊重模型的；
- 工具调用参数是 JSON 字符串（OpenAI 线上格式）时会先解析；解析失败返回「工具没有执行：工具参数不是合法 JSON：…」，
  而不是含糊的「$ 是必填字段」。这条以前会静默把字符串当空对象，工具报错像模型没写参数。

`tests/test_task_cwd.py` 4 例：任务 cwd 兜底、模型 cwd 优先、字符串参数解析、坏参数给出明确错误。

## 计划里的「建议工具」与反思里的「经验」

- `PlanStep.tools_hint`：规划者写「这一步用 `http_get` 查」，执行节点会把这句放进本步提示
  「计划建议使用：http_get（可以不用，但优先考虑）」。以前只解析进字段、没人读，等于规划者白写。
  建议工具同样先过 `tools_allowed`：越权的名字不会出现在提示里，免得把模型往被拒的方向引。
- `Reflection.lessons`：反思者现在会输出 1–3 条「这次学到、下次能复用」的经验，落进情景记忆
  （importance 0.7，高于普通反思理由的 0.5），下一轮同类任务优先检索到——这是「越用越顺」的来源。
  以前 `Reflection` 有这个字段但从不赋值，经验在 run 结束就丢了。
  `tests/test_hint_and_lessons.py` 2 例钉住两条。

## 评审不过 → 重排时带上「为什么不过」

`critic` 判不过时，`plan` 节点会重排计划；重排的提示词里现在会附上上一轮评审的 `blocking_issues`
与 `suggestions`（各取前 5 条）。以前只清空计划重排，规划者拿到的上下文和第一次一模一样，
重排出来的计划也基本一样——白烧一轮模型与工具。`tests/test_replan_brief.py` 钉住「第一次计划看不到评审意见、
重排那次必须看到具体问题与建议」。

## Plan / Execute / Reflect 的「下一步」

`reflect` 节点的返回里除了 `verdict`，还有 `next_step`（步骤下标）。它现在**真的会影响编排**：
`verdict=continue` 且 `next_step` 指向一个存在、未完成的步骤时，下一轮 `execute` 直接切到那一步；
指向已完成/越界的下标则忽略，按当前进度继续（否则模型一句「再确认下第一步」就能让流程原地打转）。
计划里常写「先查证再决定」，靠的就是这条；以前 `next_step` 只是存进反思记录，执行者永远按顺序走。
`tests/test_reflect_next_step.py` 2 例钉住「能跳」与「不乱跳」。

## 知识库（RAG）

记忆层同时是知识库：`POST /v1/knowledge` 写入文档后，run 里会多出一个只读工具

- `knowledge_search`：`{query, limit?}` → 命中的片段（`text` 截断 600 字）+ 每条命中的 `citations`；
- 检索是 BM25 与哈希向量混合（`alpha=0.6`），中文按单字/双字切词，不依赖外部分词器；
- 工具结果里的 `citations` 会被搬进 `Observation.citations`，摘要阶段只保留「观测里真的出现过」的来源——模型编造的出处会被丢掉（`test_knowledge.py::test_react_run_cites_only_observed_knowledge` 盯着这条）；
- 没有 `memory` 时注册表里不会出现这个工具（`build_default_registry()` 的默认形态只有 `http_get` / `run_command`）。

```bash
curl -s http://localhost:8000/v1/knowledge \
  -H 'content-type: application/json' \
  -d '{"doc_id":"installer","title":"安装器手册","text":"通用外壳只适用于在线版……"}'
```

## 工具允许清单（`tools_allowed`）

`POST /v1/runs` 的 `tools_allowed` 是**硬约束**，不是提示：允许清单非空时，
`execute` 节点只把清单内的工具 schema 下发给模型，执行侧再挡一次——模型凭上下文发出的清单外工具
（常见于上一轮对话里见过的写工具）会得到一条 `ok=False` 的观测「工具不在本次允许的范围内：X（允许：…）」，
工具本身不会执行。此前只校验「工具注册过没有」，于是限制成只读工具的一次 run 依然能真跑 `run_command`。
`tests/test_tools_allowed.py` 2 例钉住「越权不发 schema 也不执行」和「允许的工具照常跑」两条。

## 工具审批（HITL）

`AGENT_APPROVAL_MODE=write` 时，`execute` 节点在跑**非只读**工具前会挂起，等外部裁决：

```bash
# 1) 提交后轮询，直到 pending_approvals 里出现待审批
curl -s http://localhost:8000/v1/runs/$ID | jq '.pending_approvals'
# 2) 裁决（call_id 省略 = 只有唯一一条待审批时自动选中）
curl -s -X POST http://localhost:8000/v1/runs/$ID/approve \
  -H 'content-type: application/json' \
  -d '{"call_id":"call_abc","approved":true}'
```

几条刻意的设计：

- **只拦非只读**：`risk="read"` 的工具（`knowledge_search` 这类，只读本地知识库）不审批——全拦只会让用户点烦了把闸关掉，反而没了防护。注意 `http_get` 是 `net` 风险（会把内部地址、查询词发出去），默认也要审批；
- **等待在 run 自己的线程里**：一个 run 阻塞不会拖住别的 run，也不需要 LangGraph `interrupt` + checkpointer（重启后无法恢复的「半暂停」比同步等待更难解释）；
- **超时即拒绝**：`AGENT_APPROVAL_TIMEOUT_S` 到了还没裁决，按拒绝写进观测（`工具 X 等待用户批准超时…已按拒绝处理`），流水线照常往下走，不会假装执行过；
- **拒绝留痕**：被拒绝的调用以 `ok=False` 进观测，Reflect/Critic 能看到「这一步没做成」，而不是以为成功。

## Function Calling 调外部 API（`http_get`）

模型可以通过 `http_get` 直接调外部 HTTP 接口（OpenAI 兼容的 `tools` 字段就是这条链路）：

```json
{"type":"function","function":{"name":"http_get","parameters":{"type":"object",
 "properties":{"url":{"type":"string"},"timeout_s":{"type":"number"}},
 "required":["url"],"additionalProperties":false}}}
```

运行时的口径（对应 `tests/test_http_tool.py` 七条用例）：

- **`risk="net"`**：会把地址和查询词发到外部，`AGENT_APPROVAL_MODE=write` 时默认要审批，不是「只读免审」；
- **4xx/5xx 不抛异常**：`{"status":404,"body":"..."}` 作为数据进观测，让模型自己判断「要鉴权 / 路径错了」，而不是把 run 弄崩；
- **正文截断到 8000 字符**：整页 HTML 会直接撑爆上下文预算，截断是刻意的；
- **只允许 http/https**：`file://`、相对路径一律 `ToolError("只支持 http/https")`；
- **连不上变成 `ok=False` 观测**：带错误文案往下走，Reflect 能看到「这个接口挂了」并换方案。

### 网络出口：默认不给模型一条通内网的隧道（SSRF 防护）

`http_get` 的 URL 是**模型**写的，而模型的输入来自不可信内容（网页正文、工具返回、知识库切片）。
一条提示注入就能让它请求内网接口，再把响应原样带回对话里——这是 SSRF，不是理论问题：

- 默认**拒绝**本机、内网、链路本地、保留地址（`127.0.0.1`、`localhost`、`10/8`、`192.168/16`、`172.16/12`、
  `169.254.169.254` 云元数据、`::1` 等），报错写明「拒绝访问内网地址：X（…确实需要时由服务端设置
  `AGENT_ALLOW_PRIVATE_HOSTS=1`）」，模型能看懂并换方案；
- 主机名会先解析再判断，解析失败的域名不当作「内网」（否则「域名写错」会被说成「内网被拒」，排查方向就歪了）；
- 真需要访问内网（内网 API、本机模型服务）时由服务端显式打开 `AGENT_ALLOW_PRIVATE_HOSTS=1`——这是运维决定，不是模型决定；
- `tests/test_http_tool.py` 用五个地址（含云元数据）钉住默认拒绝，另有一条用例钉住「显式打开后放行」。

仍未覆盖：DNS rebinding（解析与应用之间地址被换掉）。要彻底堵住需要连到解析后的 IP 再校验，
本项目选择「不做花活、把默认面收紧」，并把这条写进「已知边界」。

## 入站鉴权（服务自己的门）

`AGENT_PIPELINE_API_KEY` 是**上游模型**（DeepSeek 等）的 Key，不是这个服务的口令；
服务自己的门是 `AGENT_SERVICE_TOKEN`：

```bash
export AGENT_SERVICE_TOKEN=$(python -c "import secrets;print(secrets.token_urlsafe(24))")
curl -s http://localhost:8000/v1/tools -H "Authorization: Bearer $AGENT_SERVICE_TOKEN"
```

- 设了令牌后，`/v1/**`（提交 run、查 run、审批、知识库、配置、调优）都要求
  `Authorization: Bearer <token>`，缺/错一律 401（`WWW-Authenticate: Bearer`），错误文案直接说明
  「与上游模型的 `AGENT_PIPELINE_API_KEY` 不是同一个东西」；
- `/health`（存活探针）与 `/metrics`（Prometheus 抓取，只有计数、没有对话内容）放行——否则
  compose 的 `HEALTHCHECK` 与抓取会同时坏掉；
- 令牌为空视为本机调试形态：服务不拦，但 `/health` 会报 `auth: "off"`，避免「以为已经保护了」；
- `tests/test_auth.py` 4 例钉住：没带/带错 401、`/v1/knowledge` 与 `/v1/tools` 同样要令牌、
  `/health` 与 `/metrics` 放行、令牌为空时 `auth == "off"` 且不拦。

## 可观测与回滚

- 指标：`pipeline_runs_total{status}`、`pipeline_run_duration_seconds`、`pipeline_node_duration_seconds{node}`、`pipeline_tool_calls_total{tool,status}`（**`tool` 标签有界**：已注册工具名最多 32 个，其余归 `other`；模型幻觉出来的不存在工具归 `unknown`——否则模型每次编个新名字就是一个新时序，Prometheus 会被撑爆。`status` 里 `cached` 表示幂等缓存命中、没真的执行，`ok`/`error` 才是真实执行；工具失败率告警的分母只取 `ok|error`，否则缓存命中会把失败率稀释成不告警）、`pipeline_llm_tokens_total{kind}`、`pipeline_coverage_ratio`、`pipeline_rollback_total{reason}`、`pipeline_config_version`。
- 每次 run 结束写一行 JSON 到 `runs.jsonl`，字段含 `status/stop_reason/llm_calls/tokens/coverage/replans/steps_executed/adversarial_round/adversarial_passed/plan/observations`——`tune` 和回滚窗口都只读这份日志。
- 灰度：`/v1/tune` 产出候选配置 → 注册为 canary（按 `run_id` 哈希分流）→ 窗口内错误率或 P95 超阈值自动回滚到 active（`ConfigStore.maybe_rollback`）。
- **这条链路有 HTTP 闭环测试**（`tests/test_auto_rollback_service.py`）：真服务里灰度版本连续失败 → 自动回滚 → `GET /v1/config` 的 active 换回稳定版、canary 变 `archived`、`/metrics` 出现 `pipeline_rollback_total{reason="error_rate"}`；样本数不够时不动（不因为一次上游抖动就判死刑）。
- **人工回滚要指得到版本**：`POST /v1/config/rollback` 不带参数时只归档当前灰度（幂等，自动回滚走的就是这条）；`{"version_id": 7}` 则把 7 号版本切回 active，同时归档当前 active 与灰度。只给「归档灰度」的话，`promote` 之后发现新版本有问题就没有撤销入口——只能改库。`GET /v1/config` 的 `history` 就是可选版本清单（含 id/stage）。
- 两个「不可变性」约束：任意时刻**最多一个** active、最多一个 canary；`activate` 会同时收掉灰度，避免「我明明切回去了怎么还是新提示词」。

## 容器化

```bash
export AGENT_PIPELINE_API_KEY=sk-...
docker compose up --build      # 服务 :8000 + Prometheus :9090
```

- `Dockerfile`：python:3.12-slim，非 root 用户，`HEALTHCHECK` 打 `/health`。
- **滚动更新**：`docker compose up --build` 时旧容器收到 SIGTERM，uvicorn 走 lifespan 关停——`AGENT_SHUTDOWN_GRACE_S` 内把在跑的 run 收口成 `aborted`/`error` 再退出，不会留下「日志里有半截、客户端只看到断连」的 run。
- `docker-compose.yml`：`agent-pipeline` + `prometheus`，数据卷持久化 `runs.jsonl` 与 SQLite。
- `prometheus/prometheus.yml`、`prometheus/alerts.yml`：错误率 > 20%、P95 > 120s、单工具失败率 > 30%、发生自动回滚、服务掉线、覆盖率 < 0.9、在线但 30 分钟没有 run 结束（共七条）。
- **零样本兜底**：带标签的 counter 在第一次自增之前不会出现在 `/metrics` 里（Prometheus 抓到的就是 no data）。所以「工具失败率」「自动回滚」两条告警的表达式外层都套了 `or vector(0)`——没有流量时是 0 而不是空，避免开了 nodata 处理的告警误报或哑掉。`tests/test_metrics_scrape.py` 3 例用 `prometheus_client.parser` 真解析 `/metrics` 文本（格式坏了 Prometheus 就抓不动，字符串包含检查看不出来），并断言零工具流量时确实没有 tool 样本、告警文件里有兜底。

> 本机（Windows 开发机）没有 docker，这份容器配置只写不可本地构建验证；语义已按 compose v2 写。

## 浸泡/压测

```bash
.venv/Scripts/python.exe scripts/soak.py --runs 2000            # 秒级，验证编排层不退化
.venv/Scripts/python.exe scripts/soak.py --runs 100000 --json   # 10 万次模型调用（约数分钟）

# 验证「上游抖动 → 错误率超阈值 → 自动回滚」也真的会触发：
.venv/Scripts/python.exe scripts/soak.py --runs 200 --fail-rate 0.5 --canary --json
```

`soak.py` 用脚本化假模型跑完整状态机，输出失败数、P50/P95、吞吐、内存峰值、记忆条目数，以及（`--canary` 时）自动回滚次数与灰度版本最终阶段。它证明的是**编排层**在大量调用下稳定；真实模型调用成本需另算。

`--fail-rate` 是确定性的：`fail_every = round(1 / fail_rate)`，每第 N 次模型调用抛 `LLMError`，所以同一组参数结果可复现。配合 `--canary` 时，灰度版本承接全部流量，错误率超过 `error_threshold` 后 `maybe_rollback` 会把它挪回 `archived`，而 active 版本继续可用——实测 `--runs 200 --fail-rate 0.5` 得到 `rollbacks: 1`、`canary_stage: "archived"`、退出码 0。

`--tools` 会让假模型在 `execute` 轮真的发起一次工具调用（默认调只读的 `knowledge_search`），从而把 `ToolRuntime`（schema 校验 → 幂等缓存 → 断路器 → 超时 → Observation）也压进浸泡里。**参数里必须带调用序号**（脚本已带）：同参调用会命中幂等缓存，工具根本没执行，测出来的「工具调用次数」是假的——第一版没带序号时 60 个 run 只记到 2 次工具调用，带上后 60/60。

`--approval` 再往前一步：把工具换成写工具 `run_command`、开启审批闸（`ApprovalGate`），并起一个线程每 5ms 自动批准，模拟「用户一直点允许」。实测 `--runs 30 --concurrency 2 --tools --approval` → 30 次工具调用、30 次自动批准、0 失败、P50 75.7ms（不卡在等待裁决上）。

> 最新一轮合并压测（功能全接齐、幂等缓存封顶、关停收口之后）：`--runs 20000 --concurrency 8 --tools --cancel-rate 0.1` → **108,276 次模型调用、17,986 次真实工具执行、2,014 次取消、0 失败**、12.4 run/s、P50 688.9ms / P95 804.3ms、内存峰值 6.46MB（结束 4.18MB）、`episodes` 稳定 5000。

`--cancel-rate FLOAT` 按比例模拟「用户中途点停止」：run 提交后 5–15ms 置取消标志，节点入口看到就收口、`summarize` 仍跑出一句「取消前已完成的内容」。它验证的是取消路径在并发下不漏线程、不漏日志、不把状态卡在 `running`——实测 `--runs 200 --concurrency 4 --tools --cancel-rate 0.25` → 48 个 run 被取消、0 失败。取消是协作式的：如果那一刻正卡在工具调用或审批裁决里，要等工具超时/裁决返回才会收口（这是有意为之，硬中断线程会留下半截写入）。

`--concurrency N` 会让 N 个工作线程同时跑 run（默认 1 = 顺序）。它验证的是状态机、SQLite 记忆、指标与配置存储**在并发下不互相踩**：实测 `--runs 8000 --concurrency 8` → 0 失败、40,000 次模型调用、17.5 run/s、P50 462ms / P95 496ms、内存峰值 4.1MB、`episodes` 稳定在 5000（容量回收在并发下同样生效）。并发 + 注入失败也一起验过：`--runs 400 --concurrency 4 --fail-rate 0.25 --canary` → 自动回滚 1 次、canary 归档 `archived`。

> 服务侧并发口径：`POST /v1/runs` 超过 `AGENT_MAX_CONCURRENCY` 时**直接 429 + `Retry-After`**，不排队（排队会让客户端超时掩盖背压）；同一个 `run_id` 重复提交是幂等的，只跑一次。`tests/test_concurrency.py` 覆盖了 429/放行/幂等三条。

`--log PATH` 把每个 run 的 JSONL 写到你指定的文件（默认丢弃）。**写不进去会明确失败**：退出码 1 + stderr 报「只写进 N/M 行」，而 run 本身仍成功（`runtime.log_failures` 计数、`/health` 里也看得到 `log_failures`/`log_last_error`）——以前 `_write_log` 是 `except OSError: pass`，日志全丢也一切「正常」。它把「压测」和「调优」接起来了：`soak --log runs.jsonl` 跑出来的就是 `tune` / `DailyTuner` 读的那份日志，字段口径一致（`run_id`/`status`/`stop_reason`/`finished_at`/`llm_calls`/`tokens`）。所以可以这样复现「根据日志自动微调」：

```bash
# 1) 压一批会失败的 run（每 2 次模型调用失败 1 次）
.venv/Scripts/python.exe scripts/soak.py --runs 200 --fail-rate 0.5 --max-failures 999 --log soak.jsonl
# 2) 拿同一份日志出调优报告（不接评测器时只报告，不注册版本）
.venv/Scripts/python.exe -m agent_pipeline.runner tune --log soak.jsonl --since-hours 1
```

以前 `soak.py` 的 `log_sink` 是写死丢弃的，跑完一点日志都不留，导致「日志驱动调优」只能拿手写 fixture 测。`tests/test_soak_tune.py` 4 例现在真跑一轮会失败的浸泡、再让 `tune` 与 `DailyTuner` 读它，并校验每行都是完整 JSON、20 个 run = 20 行。

## 对抗环（Coder ↔ Tester）的收口口径

- **实现者看得到上一轮证据**：第二轮起，Coder 的上下文里带「上一轮测试输出尾部（1200 字）+ 上一轮覆盖率 + 上一轮缺陷清单」。只给评审意见会让它反复改同一处、或改一个早已通过的用例。
- **覆盖率命令坏掉不硬撑**：`coverage_runner` 抛异常或拿不到数字时，`coverage=None`；连续两轮都拿不到就写 `stop_reason="coverage_command_failed"` 并转 summarize，不再空转到 `max_adversarial_rounds`（配置调大也不会白烧钱）。
- **轮数用尽如实收口**：最后一轮仍未达标时 `stop_reason="coverage_gap"`，`adversarial_passed=False`，不会把 0.4 的覆盖率说成通过。
- **「评审不过 → 重规划」在节点里生效**：`critic_node` 重置计划并累加 `replans`（用尽后写 `stop_reason="critic_blocked"`）。以前这些改动写在 LangGraph 的条件边里，边对 state 的修改不保证进图状态，等于每次都拿同一份计划重跑。

## 记忆淘汰口径

- **容量硬上限**：情景记忆 `AGENT_MAX_EPISODES`（默认 5000）、文档 `AGENT_MAX_DOCUMENTS`（默认 2000），每次写入后 `prune()` 收口，10 万次调用不会让库单调上涨。
- **先删低重要性、再比新旧**：超容量时按 `importance DESC, created_at DESC` 保留，老的「反复验证过的教训」（importance 高）不会被今天的流水账挤掉。
- **可选时间过期**：`AGENT_MAX_EPISODE_AGE_DAYS > 0` 时先按 `created_at` 删超龄记录；默认关闭——「三个月前的经验自动消失」要调用方明确开启。
- 文档删旧时连带删 chunks（同一事务），不会留孤儿块。

## 长跑不飘（进程内状态有上限）

- **run 历史有上限**：`AGENT_RUN_HISTORY_LIMIT`（默认 500）控制服务内存里保留多少个已结束 run；超出按完成顺序丢最旧，正在跑的 run 不动。`/health` 的 `runs_retained` 可以看当前占用。没有这一步时，每个请求都会把完整结果（含整份日志行）留在进程里，跑久了就是稳定泄漏。
- **关停不硬砍在跑的 run**：`AGENT_SHUTDOWN_GRACE_S`（默认 5 秒）——lifespan 退出时先给所有在跑的 run 置取消标记（与用户点「取消」同一条协作式路径），最多等这么久让它们收口；宽限期用完还没结束的落成 `error` 并写明「服务关停：宽限期内没跑完，已中止」，客户端不会永远等到超时。同时释放工具线程池与 SQLite 连接，容器滚动更新时进程能干脆退出。`tests/test_shutdown.py` 3 例覆盖（在跑时关停 / 没有在跑时秒退 / 线程表随 run 结束清理）。
- **JSONL 日志会轮转**：`AGENT_LOG_MAX_BYTES`（默认 64MB）是单文件上限，超了整份改名为 `runs.jsonl.1`（只留一代）。10 万次调用 ≈ 10 万行，不轮转的话调优读日志、运维 `tail` 都会变慢。
- **并发浸泡实测**：`scripts/soak.py --runs 20000 --concurrency 8` → **100,000 次模型调用、0 失败**、17.0 run/s、P50 471.65ms / P95 511.1ms、内存峰值 4.55MB / 结束 3.11MB、`episodes` 稳定在 5000（容量回收在并发下同样生效）。

- **幂等缓存有上限**：`AGENT_IDEMPOTENCY_MAX_ENTRIES`（默认 1000）封顶 ToolRuntime 的幂等缓存——真实流量里参数几乎不重复，只靠 600 秒 TTL 的话，10 万次调用能在窗口内堆几万条 Observation。实测封顶前 20,000 run（20,000 次工具执行）结束内存 15.7MB，封顶后 12,000 run 只有 4.33MB（峰值 6.11MB），不再随调用量线性涨。
- **取消也是并发路径**：`scripts/soak.py --cancel-rate 0.1` 在 20,000 run 里取消掉 1,999 个，0 失败、18,001 次工具调用照常落地；`tests/test_soak.py` 钉住「工具参数必须每次不同」（否则幂等缓存吃掉执行，浸泡变成只测缓存）。
- **回滚库也有上限**：每个 run 落一条 outcome，`AGENT_OUTCOME_LIMIT`（默认 5000）按 id 裁旧的——窗口只看最近 50 条，留 5000 条足够判定，磁盘不会随调用量单调涨。

## 交付物自检

`tests/test_packaging.py` 会把交付物和代码对一遍：Dockerfile/compose 里出现的每个 `AGENT_*` 变量都必须真的被代码读取（只认「读环境变量」的行，注释不算）、`HEALTHCHECK` 的 `/health` 路由必须存在、compose 引用的 `prometheus/*.yml` 必须存在、告警表达式里的每个 `pipeline_*` 指标都必须真的会被导出、`pyproject` 的 `agent-pipeline` 入口必须就是 Dockerfile 的 `CMD`。它挡的是「文件写了但代码不读」——这条真踩过：`config.py` 读 `AGENT_PIPELINE_LOG`、容器里设的却是 `AGENT_LOG_PATH`，日志于是写到 `/app/runs.jsonl`，重建容器就丢调优输入。

## 部署冒烟（本机没有 docker 时的替代证据）

`tests/test_e2e_serve.py` 真的用子进程起服务（`python -m agent_pipeline.runner serve`，与 Dockerfile 的 `CMD` 同一条路），上游模型换成本地桩 HTTP 服务，然后从外面走一遍：`/health` 起来 → `POST /v1/runs` 202 → 轮询到 `ok` → `/metrics` 里有 `pipeline_runs_total{status="ok"}` → `AGENT_LOG_PATH` 指的文件里确实落了 1 行 JSONL。再加上 `uv build --wheel` 产出的 wheel 里带 `entry_points.txt`（`agent-pipeline = agent_pipeline.runner:main`）与 16 个模块，容器里那套「装包 → 起进程 → 接请求」的路径就算被覆盖了；真正没覆盖的只有镜像层（基础镜像、卷挂载、非 root 用户）。

联调有测试：`packages/web/src/lib/pipeline/live.test.ts` 会真起一个 `agent_pipeline.runner serve` 子进程
（上游换成本地假 OpenAI 服务），用桌面端客户端跑完一次任务，断言 `status/answer/stopReason/llmCalls/tokens`
与 `/health` 字段都对得上。两边各有单测也可能字段名对不上，这条补的是「真进程 + 真 HTTP」那一层。

## 桌面端接入（可选，默认不启用）

和鸣的渲染进程里有一个薄客户端：`packages/web/src/lib/pipeline/client.ts`。它遵守同一套协议，把「提交 → 轮询 → 终态」收敛成一次 `await`，并把服务端的 snake_case 转成前端习惯的 camelCase。

```ts
import { createPipelineClient } from "../lib/pipeline/client.js";

const client = createPipelineClient({
  baseUrl: "http://127.0.0.1:8000",
  // 服务自己的入站令牌（= 服务端 AGENT_SERVICE_TOKEN），不是上游模型的 Key
  apiKey: process.env.AGENT_SERVICE_TOKEN,
  onPendingApproval: async (approval) => {
    // 这里接桌面端自己的确认弹窗（与 agentStream 的 HITL 是两套：这套问的是流水线里的工具）
    return window.confirm(`允许流水线执行 ${approval.tool}？`);
  },
});

const run = await client.run({ goal: "把安装器补成通用外壳", mode: "react" }, { signal });
run.answer; run.citations; run.coverage; run.stopReason;
```

- **默认不接**：界面不会自动连它。流水线要单独部署（地址、密钥、回退策略都得定），未部署时不该让聊天链路出现超时；接不接、接到哪个地址，是产品决策，不是代码默认值能替用户拍的板。
- 客户端自己的口径：并发满（429）按退避**重提一次**再报错；run 超过 `runTimeoutMs`（默认 30 分钟）会先 `POST /cancel` 再抛 `timeout`，不让服务端继续白烧模型；`signal` 中止立刻停轮询。
- 服务端还有一道跨语言契约测试（`tests/test_client_contract.py`）钉住客户端读的字段名——它已经抓到过 `stop_reason` 没被带出去的缺陷。

12 个用例在 `packages/web/src/lib/pipeline/client.test.ts`，覆盖 429 重提、非 2xx 带 `detail`、连不上、用户中止、run 超时（含请求取消）、待审批回填、`normalizeRun` 的字段容错。

## 测试与覆盖率门槛

```bash
./.venv/Scripts/python.exe -m pytest --cov            # Windows
.venv/bin/python -m pytest --cov                      # Linux / 容器
```

- 当前 **245 passed / 覆盖率 95.3%**，`pyproject.toml` 里 `[tool.coverage.report] fail_under = 90`：低于 90% 直接失败，防止后续重构悄悄丢掉错误分支。
- 覆盖到的「容易写成纸面规则」的路径：预算三条线（墙钟 0 秒 / 1 token / 调用次数用尽都必须真停）、覆盖率解析（`TOTAL 140%`、`TOTAL -5%`、无数字都返回 `None` 而不是猜）、真实跑测试命令（退出码非 0 或超时判 `ok=False`）、`http_get` 打真 HTTP 服务、`/metrics` 用 `prometheus_client` 解析器验证格式、CLI 的中文汇报输出。
- 覆盖率解析这条修过一个真 bug：`TOTAL -5%` 被读成 5%（正则把负号后的数字当覆盖率），已加 `(?<!-)` 并补用例。

## 已知边界

1. **记忆有容量上限、没有「价值淘汰」**：`MemoryStore` 每次写入后按 `max_episodes` / `max_documents` 删（先删超龄的 `AGENT_MAX_EPISODE_AGE_DAYS`，再按 `importance`/时间裁容量，删文档连带删块，同一事务），所以磁盘与检索延迟有界；但没有「按任务相关性在线学习该留哪些经验」的机制——目前靠 `importance` 人工/启发式打标。
2. **对抗模式的覆盖率必须来自真实命令**：没配 `coverage_runner` 时 `coverage=None`，此时 `adversarial_passed` 永远为 False，不会假装达标。
3. **HITL 只在单进程内有效**：`AGENT_APPROVAL_MODE=write` 的等待是在执行线程里阻塞，服务重启/进程崩溃后待审批的调用会随线程一起消失（客户端会看到该 run 变 `error`）；跨重启续跑需要 LangGraph `interrupt` + checkpointer，还没做。
4. **知识库检索是词面为主**：BM25 + 哈希向量的混合检索，对同义改写不如真正的 embedding 模型；中文靠单字/双字切词，短查询容易放大无关片段。要更好的语义召回，需要接一个 embedding 服务（当前没有外部依赖）。
5. **`http_get` 仍有 DNS rebinding 未覆盖**：默认拒绝本机/内网/链路本地/保留地址（含云元数据），主机名先解析再判断，但「解析发生在校验之后、请求时又解析一次」这个缝隙没堵；彻底做法是连解析结果里的 IP 再校验（或自建连接池），本项目选择先把默认面收紧。
6. **调优不自动上线**：每日调度器（`AGENT_TUNE_ENABLED=1`）会自动跑 `tune`，但只产出候选 + 注册灰度；提升到 active 仍需要 `/v1/config/promote` 或人工看板。自动转正的条件（连续 N 轮灰度指标更好）还没做。回放评测器默认关闭（`AGENT_TUNE_EVAL=1` 才开），因为它会真跑流水线、花真钱。