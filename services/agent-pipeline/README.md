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
- `/health` 的 `tuner` 段给出 `enabled / running / last_error / last_ran_at`，`GET /metrics` 另有 `pipeline_tune_candidates`、`pipeline_tune_applied_version`；
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

预算（`Budget`）：`max_steps=8`、`max_llm_calls=40`、`max_tokens=120_000`、`max_wall_clock_s=600`、`step_tool_budget=6`、`max_replans=2`、`max_adversarial_rounds=2`。超预算时流水线**不硬失败**，而是带 `status="budget"` 和 `stop_reason` 返回已完成的部分。

## 取消一个 run

长任务不能只能靠杀进程停。`POST /v1/runs/{id}/cancel` 只置一个标记：正在执行的那次模型调用不会被打断（HTTP 请求没法安全打断），但**下一个节点边界**会看到标记，直接以 `status="aborted"` / `stop_reason="cancelled"` 收口，`summarize` 仍会跑完并回「取消前已完成的内容」——不用等 10 分钟墙钟超时。

- 已完成/失败的 run 再取消返回 409；不存在的 run 返回 404；
- **卡在等审批会被立刻放出来**：取消同时把该 run 的待审批全部按拒绝收口，执行线程不再干等 `AGENT_APPROVAL_TIMEOUT_S`（默认 300s）。否则用户点了取消，界面两三分钟没反应，看起来就是「取消坏了」；run 正常结束时也会清掉残留审批，`/health` 的 `pending_approvals` 不会只增不减。`tests/test_cancel_approval.py` 2 例钉住；
- 取消是协作式的：卡在**工具调用**里的 run 要等这次工具超时（`AGENT_TOOL_TIMEOUT_S`）才走到下一个边界（工具线程没法安全打断）；
- `tests/test_cancel.py` 4 例覆盖（跑到一半取消、未知 run、已结束 run、重复取消）。

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

## 可观测与回滚

- 指标：`pipeline_runs_total{status}`、`pipeline_run_duration_seconds`、`pipeline_node_duration_seconds{node}`、`pipeline_tool_calls_total{tool,status}`（**`tool` 标签有界**：已注册工具名最多 32 个，其余归 `other`；模型幻觉出来的不存在工具归 `unknown`——否则模型每次编个新名字就是一个新时序，Prometheus 会被撑爆。`status` 里 `cached` 表示幂等缓存命中、没真的执行，`ok`/`error` 才是真实执行；工具失败率告警的分母只取 `ok|error`，否则缓存命中会把失败率稀释成不告警）、`pipeline_llm_tokens_total{kind}`、`pipeline_coverage_ratio`、`pipeline_rollback_total{reason}`、`pipeline_config_version`。
- 每次 run 结束写一行 JSON 到 `runs.jsonl`，字段含 `status/stop_reason/llm_calls/tokens/coverage/replans/steps_executed/adversarial_round/adversarial_passed/plan/observations`——`tune` 和回滚窗口都只读这份日志。
- 灰度：`/v1/tune` 产出候选配置 → 注册为 canary（按 `run_id` 哈希分流）→ 窗口内错误率或 P95 超阈值自动回滚到 active（`ConfigStore.maybe_rollback`）。
- **人工回滚要指得到版本**：`POST /v1/config/rollback` 不带参数时只归档当前灰度（幂等，自动回滚走的就是这条）；`{"version_id": 7}` 则把 7 号版本切回 active，同时归档当前 active 与灰度。只给「归档灰度」的话，`promote` 之后发现新版本有问题就没有撤销入口——只能改库。`GET /v1/config` 的 `history` 就是可选版本清单（含 id/stage）。
- 两个「不可变性」约束：任意时刻**最多一个** active、最多一个 canary；`activate` 会同时收掉灰度，避免「我明明切回去了怎么还是新提示词」。

## 容器化

```bash
export AGENT_PIPELINE_API_KEY=sk-...
docker compose up --build      # 服务 :8000 + Prometheus :9090
```

- `Dockerfile`：python:3.12-slim，非 root 用户，`HEALTHCHECK` 打 `/health`。
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
- **JSONL 日志会轮转**：`AGENT_LOG_MAX_BYTES`（默认 64MB）是单文件上限，超了整份改名为 `runs.jsonl.1`（只留一代）。10 万次调用 ≈ 10 万行，不轮转的话调优读日志、运维 `tail` 都会变慢。
- **并发浸泡实测**：`scripts/soak.py --runs 20000 --concurrency 8` → **100,000 次模型调用、0 失败**、17.0 run/s、P50 471.65ms / P95 511.1ms、内存峰值 4.55MB / 结束 3.11MB、`episodes` 稳定在 5000（容量回收在并发下同样生效）。

- **幂等缓存有上限**：`AGENT_IDEMPOTENCY_MAX_ENTRIES`（默认 1000）封顶 ToolRuntime 的幂等缓存——真实流量里参数几乎不重复，只靠 600 秒 TTL 的话，10 万次调用能在窗口内堆几万条 Observation。实测封顶前 20,000 run（20,000 次工具执行）结束内存 15.7MB，封顶后 12,000 run 只有 4.33MB（峰值 6.11MB），不再随调用量线性涨。
- **取消也是并发路径**：`scripts/soak.py --cancel-rate 0.1` 在 20,000 run 里取消掉 1,999 个，0 失败、18,001 次工具调用照常落地；`tests/test_soak.py` 钉住「工具参数必须每次不同」（否则幂等缓存吃掉执行，浸泡变成只测缓存）。
- **回滚库也有上限**：每个 run 落一条 outcome，`AGENT_OUTCOME_LIMIT`（默认 5000）按 id 裁旧的——窗口只看最近 50 条，留 5000 条足够判定，磁盘不会随调用量单调涨。

## 交付物自检

`tests/test_packaging.py` 会把交付物和代码对一遍：Dockerfile/compose 里出现的每个 `AGENT_*` 变量都必须真的被代码读取（只认「读环境变量」的行，注释不算）、`HEALTHCHECK` 的 `/health` 路由必须存在、compose 引用的 `prometheus/*.yml` 必须存在、告警表达式里的每个 `pipeline_*` 指标都必须真的会被导出、`pyproject` 的 `agent-pipeline` 入口必须就是 Dockerfile 的 `CMD`。它挡的是「文件写了但代码不读」——这条真踩过：`config.py` 读 `AGENT_PIPELINE_LOG`、容器里设的却是 `AGENT_LOG_PATH`，日志于是写到 `/app/runs.jsonl`，重建容器就丢调优输入。

## 部署冒烟（本机没有 docker 时的替代证据）

`tests/test_e2e_serve.py` 真的用子进程起服务（`python -m agent_pipeline.runner serve`，与 Dockerfile 的 `CMD` 同一条路），上游模型换成本地桩 HTTP 服务，然后从外面走一遍：`/health` 起来 → `POST /v1/runs` 202 → 轮询到 `ok` → `/metrics` 里有 `pipeline_runs_total{status="ok"}` → `AGENT_LOG_PATH` 指的文件里确实落了 1 行 JSONL。再加上 `uv build --wheel` 产出的 wheel 里带 `entry_points.txt`（`agent-pipeline = agent_pipeline.runner:main`）与 16 个模块，容器里那套「装包 → 起进程 → 接请求」的路径就算被覆盖了；真正没覆盖的只有镜像层（基础镜像、卷挂载、非 root 用户）。

## 测试与覆盖率门槛

```bash
./.venv/Scripts/python.exe -m pytest --cov            # Windows
.venv/bin/python -m pytest --cov                      # Linux / 容器
```

- 当前 **184 passed / 覆盖率 94.3%**，`pyproject.toml` 里 `[tool.coverage.report] fail_under = 90`：低于 90% 直接失败，防止后续重构悄悄丢掉错误分支。
- 覆盖到的「容易写成纸面规则」的路径：预算三条线（墙钟 0 秒 / 1 token / 调用次数用尽都必须真停）、覆盖率解析（`TOTAL 140%`、`TOTAL -5%`、无数字都返回 `None` 而不是猜）、真实跑测试命令（退出码非 0 或超时判 `ok=False`）、`http_get` 打真 HTTP 服务、`/metrics` 用 `prometheus_client` 解析器验证格式、CLI 的中文汇报输出。
- 覆盖率解析这条修过一个真 bug：`TOTAL -5%` 被读成 5%（正则把负号后的数字当覆盖率），已加 `(?<!-)` 并补用例。

## 已知边界

1. **记忆有容量上限、没有「价值淘汰」**：`MemoryStore` 每次写入后按 `max_episodes` / `max_documents` 删（先删超龄的 `AGENT_MAX_EPISODE_AGE_DAYS`，再按 `importance`/时间裁容量，删文档连带删块，同一事务），所以磁盘与检索延迟有界；但没有「按任务相关性在线学习该留哪些经验」的机制——目前靠 `importance` 人工/启发式打标。
2. **对抗模式的覆盖率必须来自真实命令**：没配 `coverage_runner` 时 `coverage=None`，此时 `adversarial_passed` 永远为 False，不会假装达标。
3. **HITL 只在单进程内有效**：`AGENT_APPROVAL_MODE=write` 的等待是在执行线程里阻塞，服务重启/进程崩溃后待审批的调用会随线程一起消失（客户端会看到该 run 变 `error`）；跨重启续跑需要 LangGraph `interrupt` + checkpointer，还没做。
4. **知识库检索是词面为主**：BM25 + 哈希向量的混合检索，对同义改写不如真正的 embedding 模型；中文靠单字/双字切词，短查询容易放大无关片段。要更好的语义召回，需要接一个 embedding 服务（当前没有外部依赖）。
5. **调优不自动上线**：每日调度器（`AGENT_TUNE_ENABLED=1`）会自动跑 `tune`，但只产出候选 + 注册灰度；提升到 active 仍需要 `/v1/config/promote` 或人工看板。自动转正的条件（连续 N 轮灰度指标更好）还没做。回放评测器默认关闭（`AGENT_TUNE_EVAL=1` 才开），因为它会真跑流水线、花真钱。