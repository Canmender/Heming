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
```

## HTTP 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 存活 + 当前配置版本 + 运行中数量 |
| GET | `/metrics` | Prometheus 指标（`pipeline_*`） |
| POST | `/v1/runs` | 提交一次 run（202；并发满返回 429 + `Retry-After`；同 `run_id` 幂等） |
| GET | `/v1/runs/{id}` | 查状态/结果 |
| POST | `/v1/runs/{id}/approve` | HITL 审批（非待审批 409；本版本未启用中断，返回 501） |
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

预算（`Budget`）：`max_steps=8`、`max_llm_calls=40`、`max_tokens=120_000`、`max_wall_clock_s=600`、`step_tool_budget=6`、`max_replans=2`、`max_adversarial_rounds=2`。超预算时流水线**不硬失败**，而是带 `status="budget"` 和 `stop_reason` 返回已完成的部分。

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
3. **HITL 中断未启用**：`/approve` 返回 501，流水线在工具风险上是「服务端默认信任已注册工具」；接真实写操作前需补审批队列。
4. **调优不自动上线**：`tune` 只产出候选并（可选）注册灰度，提升到 active 需要 `/v1/config/promote` 或人工看板。