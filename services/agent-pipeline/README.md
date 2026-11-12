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
.venv/Scripts/python.exe -m pip install -e ".[dev]"    # Windows
# source .venv/bin/activate && pip install -e ".[dev]"  # macOS / Linux

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
```

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
| POST | `/v1/runs/{id}/approve` | HITL 审批（需 `AGENT_APPROVAL_MODE=write`；body `{call_id?, approved}`，没有待审批返回 409） |
| GET | `/v1/config` | 当前 active/canary 配置与历史 |
| POST | `/v1/config/promote` | 把 canary 提升为 active |
| POST | `/v1/config/rollback` | 手动回滚（幂等） |
| POST | `/v1/tune` | 基于日志生成候选配置（可选 evaluator 决定是否上灰度） |
| GET | `/v1/tools` | 已注册工具与 schema |

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
| `AGENT_PIPELINE_DB` | `agent-pipeline.db` | 记忆 + 配置版本 SQLite |
| `AGENT_MAX_EPISODES` | `5000` | 情景记忆上限（超限删最旧；0 = 不限制） |
| `AGENT_MAX_DOCUMENTS` | `2000` | 知识库文档上限（超限删最旧并连带删块） |
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

- **只拦非只读**：`risk="read"` 的工具（`http_get` 之类）不审批——全拦只会让用户点烦了把闸关掉，反而没了防护；
- **等待在 run 自己的线程里**：一个 run 阻塞不会拖住别的 run，也不需要 LangGraph `interrupt` + checkpointer（重启后无法恢复的「半暂停」比同步等待更难解释）；
- **超时即拒绝**：`AGENT_APPROVAL_TIMEOUT_S` 到了还没裁决，按拒绝写进观测（`工具 X 等待用户批准超时…已按拒绝处理`），流水线照常往下走，不会假装执行过；
- **拒绝留痕**：被拒绝的调用以 `ok=False` 进观测，Reflect/Critic 能看到「这一步没做成」，而不是以为成功。

## 可观测与回滚

- 指标：`pipeline_runs_total{status}`、`pipeline_run_duration_seconds`、`pipeline_node_duration_seconds{node}`、`pipeline_tool_calls_total{tool,status}`、`pipeline_llm_tokens_total{kind}`、`pipeline_coverage_ratio`、`pipeline_rollback_total{reason}`、`pipeline_config_version`。
- 每次 run 结束写一行 JSON 到 `runs.jsonl`，字段含 `status/stop_reason/llm_calls/tokens/coverage/replans/steps_executed/adversarial_round/adversarial_passed/plan/observations`——`tune` 和回滚窗口都只读这份日志。
- 灰度：`/v1/tune` 产出候选配置 → 注册为 canary（按 `run_id` 哈希分流）→ 窗口内错误率或 P95 超阈值自动回滚到 active（`ConfigStore.maybe_rollback`）。

## 容器化

```bash
export AGENT_PIPELINE_API_KEY=sk-...
docker compose up --build      # 服务 :8000 + Prometheus :9090
```

- `Dockerfile`：python:3.12-slim，非 root 用户，`HEALTHCHECK` 打 `/health`。
- `docker-compose.yml`：`agent-pipeline` + `prometheus`，数据卷持久化 `runs.jsonl` 与 SQLite。
- `prometheus/prometheus.yml`、`prometheus/alerts.yml`：错误率 > 20%、P95 > 120s、单工具失败率 > 30%、发生自动回滚、服务掉线、覆盖率 < 0.9 六条告警。

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

## 已知边界

1. **记忆有容量上限、没有 TTL**：`MemoryStore` 每次写入后按 `max_episodes` / `max_documents` 删最旧的（删文档连带删块，同一事务），所以磁盘与检索延迟有界；但「三个月前的经验自动过期」还没做——需要按重要性/时间的淘汰策略，而不是只看新旧。
2. **对抗模式的覆盖率必须来自真实命令**：没配 `coverage_runner` 时 `coverage=None`，此时 `adversarial_passed` 永远为 False，不会假装达标。
3. **HITL 只在单进程内有效**：`AGENT_APPROVAL_MODE=write` 的等待是在执行线程里阻塞，服务重启/进程崩溃后待审批的调用会随线程一起消失（客户端会看到该 run 变 `error`）；跨重启续跑需要 LangGraph `interrupt` + checkpointer，还没做。
4. **调优不自动上线**：每日调度器（`AGENT_TUNE_ENABLED=1`）会自动跑 `tune`，但只产出候选 + 注册灰度；提升到 active 仍需要 `/v1/config/promote` 或人工看板。自动转正的条件（连续 N 轮灰度指标更好）还没做。回放评测器默认关闭（`AGENT_TUNE_EVAL=1` 才开），因为它会真跑流水线、花真钱。