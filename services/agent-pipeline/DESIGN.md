# 多智能体流水线（agent-pipeline）设计

> 目标读者：维护和鸣「智能体对话」与后续服务端编排的人。
> 本文描述 `services/agent-pipeline` 的架构、协议与验收口径；代码是本文的实现。

## 1. 目标与非目标

目标：

1. 把「一次对话」做成**可检查、可重放、可回滚**的流水线：`Plan → Execute → Reflect → Summarize`，
   必要时插入 `Adversarial`（Coder ↔ Tester 对抗）与 `Critic`（覆盖率/质量门禁）。
2. 明确定义 **Memory ↔ Tool 交互协议**，让模型看到的上下文与工具返回的观测值都有稳定结构，
   而不是把一堆字符串拼进 prompt。
3. 用 **LangGraph** 把上述阶段编排成状态机（含 checkpoint、人工中断、条件边与循环上限）。
4. 对外只暴露一个 HTTP 接口；Prometheus 指标、结构化日志、自动回滚与每日 Prompt 微调闭环随镜像一起交付。
5. 在 10 万次调用的量级下保持稳定：有预算、有背压、有超时、有幂等、有断路器。

非目标：

- 不在本服务里实现 UI；和鸣桌面端只是调用方之一。
- 不引入外部向量数据库：RAG 用本机 SQLite + BM25/哈希向量，保证离线可跑。
- 不追求「最强 Agent」，优先保证**链路正确、可观测、可回滚**。

## 2. 与现有实现的关系

和鸣桌面端已有两条链路：

| 现有 | 位置 | 角色 |
| --- | --- | --- |
| 单智能体 ReAct | `packages/web/src/lib/agentStream.ts` | 聊天主链路：流式 + 工具轮 + HITL |
| 多智能体协作 | `packages/web/src/lib/collaboration/*` | sequential / supervisor / debate 三种编排 |

本服务不替换它们，而是把其中的**协议与状态机**抽出来做服务端版本：

- `agentStream.ts` 的循环语义（工具轮预算 `MAX_TOOL_ROUNDS = 12`、`MAX_TURN_TOOL_TOKENS = 12_000`、
  `tool_search` 按需发现、HITL 逐条确认、写工具串行）在 `PipelineState` 里一一对应；
- `collaboration/engine.ts` 的 debate 模式在 `Adversarial` 节点里加强为「写代码 ↔ 找 Bug 直到覆盖率达标」。

## 3. 架构总览

```
            ┌────────────────────────── FastAPI（/v1/runs, /health, /metrics）──────────────────────────┐
            │                                                                                          │
  client ──▶│  Gateway ──▶ Orchestrator(LangGraph) ──▶ Nodes ──▶ ToolRuntime ──▶ Function Calling      │
            │                    │                        │            │                              │
            │                    │                        │            └──▶ MCP / HTTP / 本地命令       │
            │                    ▼                        ▼                                           │
            │              Checkpoint(SQLite)        Memory(episodic + semantic)                      │
            │                                             │                                          │
            │              Prometheus ◀── 指标 ◀── 每次节点/工具调用 ──▶ 结构化日志(JSONL)              │
            └──────────────────────────────────────────────────────────────────────────────────────────┘
                                                          │
                                          每日调优任务 ──▶ 候选 Prompt/Few-shot ──▶ 离线评测 ──▶ 灰度/回滚
```

### 3.1 目录

```
services/agent-pipeline/
├── DESIGN.md
├── pyproject.toml
├── Dockerfile
├── docker-compose.yml
├── prometheus/prometheus.yml
├── prometheus/alerts.yml
├── src/agent_pipeline/
│   ├── __init__.py
│   ├── config.py         # 环境、预算、阈值、版本化 Prompt 注册表
│   ├── protocol.py       # Memory↔Tool 协议：消息/观测/引用/预算
│   ├── memory.py         # 情景记忆 + 语义记忆（SQLite，BM25 + 哈希向量）
│   ├── tools.py          # 工具注册表、JSON Schema、Function Calling、超时/幂等/断路器
│   ├── llm.py            # OpenAI 兼容客户端（可注入假实现用于测试）
│   ├── metrics.py        # Prometheus 指标
│   ├── rollback.py       # 版本化配置 + 灰度 + 自动回滚
│   ├── tune.py           # 日志驱动每日 Prompt/Few-shot 微调
│   ├── graph.py          # LangGraph 状态机（Plan/Execute/Reflect/Critic/Adversarial/Summarize）
│   ├── nodes.py          # 各节点实现（纯函数 + 依赖注入）
│   ├── service.py        # FastAPI 应用
│   └── runner.py         # CLI：跑一次 pipeline / 跑每日调优
└── tests/
```

## 4. Memory ↔ Tool 交互协议

### 4.1 消息类型（`protocol.py`）

```text
TaskSpec       任务输入：goal, cwd, constraints, budget, mode
PlanStep       计划单元：id, goal, tools_hint, done_when, status
Observation    工具观测：call_id, tool, ok, result, error, duration_ms, citations
ToolRequest    执行请求：name, arguments(已校验), risk(read|write|net), idempotency_key
Reflection     反思：verdict(continue|done|replan|abort), reasons, next_step, lessons
Critique       评审：score, blocking_issues[], coverage, suggestions
MemoryRecord   记忆：kind(episodic|semantic|lesson), text, citations, run_id, importance
RunResult      输出：answer, plan, observations, reflections, usage, citations, status
```

约束（节点之间只传这些结构，不传裸字符串）：

1. **每条 Observation 必须可追溯到 ToolRequest**（`call_id` 一一对应）；
2. **每条 MemoryRecord 必须带 `run_id` 与 `citations`**，禁止写入无来源的「记忆」；
3. 进入模型上下文的工具结果一律经 `Observation.render()`（截断 + 摘要），原始 JSON 只留在 run log；
4. 预算与上下文装配策略集中在 `protocol.build_context()`：system > plan > 最近 N 条 observation >
   检索到的 memory；超预算时按「低重要性记忆 → 旧 observation」顺序丢弃，并记录 `dropped`。

### 4.2 一次工具调用的生命周期

```
model 产出 ToolRequest
  → schema 校验（失败：Observation(ok=False, error="schema")）
  → 风险判定（write/net 需要 HITL 或策略放行）
  → 幂等键查表（命中：直接返回上次 Observation）
  → 断路器检查（打开：短路返回 error="circuit_open"）
  → 执行（超时 = 每工具 timeout_ms）
  → 写 run log + 指标（latency / error / tokens）
  → 写 episodic memory（仅成功的、摘要化的）
```

## 5. 把 ReAct 拆成 Plan / Execute / Reflect

| 阶段 | 输入 | 输出 | 关键规则 |
| --- | --- | --- | --- |
| Plan | TaskSpec + 检索到的 memory/skills | PlanStep[] | 3–7 步；每步必须写 `done_when`；工具只能从注册表选 |
| Execute | PlanStep | Observation[] | 按步执行；只读工具可并行，写工具串行；每步最多 `step_tool_budget` 次调用 |
| Reflect | Observation[] + 上一步 | Reflection | `done` 必须给出证据；`replan` 计入 `max_replans`（默认 2）；`abort` 立即收口并说明 |
| Critic | 当前产物 | Critique | score < 阈值或存在 blocking_issues → 回 Plan/Execute；覆盖率不达标 → Adversarial |
| Adversarial | 产物 + 测试 | critique/patched | Coder 修 → Tester 找 Bug，最多 `max_adversarial_rounds` 轮，覆盖率达标即退出 |
| Summarize | 全部 | RunResult | 只引用 observation/citation 里的内容，不得新增事实 |

退出条件（任一满足）：`reflection.verdict == "done"` 且 critic 通过；预算耗尽；轮数上限；人工 abort。

## 6. LangGraph 状态机

```python
graph = StateGraph(PipelineState)
graph.add_node("plan", plan_node)          # 计划
graph.add_node("execute", execute_node)    # 逐步执行
graph.add_node("reflect", reflect_node)    # 观察 → 判定
graph.add_node("critic", critic_node)      # 质量门禁
graph.add_node("adversarial", adversarial_node)  # Coder ↔ Tester
graph.add_node("summarize", summarize_node)
graph.add_edge(START, "plan")
graph.add_edge("plan", "execute")
graph.add_edge("execute", "reflect")
graph.add_conditional_edges("reflect", route_after_reflect, {
    "execute": "execute", "critic": "critic", "summarize": "summarize",
})
graph.add_conditional_edges("critic", route_after_critic, {
    "execute": "execute", "adversarial": "adversarial", "summarize": "summarize",
})
graph.add_conditional_edges("adversarial", route_after_adversarial, {
    "adversarial": "adversarial", "critic": "critic", "summarize": "summarize",
})
graph.add_edge("summarize", END)
```

- checkpoint：`SqliteSaver`（`checkpoints.db`），`thread_id = run_id`，支持断点续跑与重放；
- 人工中断：`interrupt_before=["execute"]` 可选开启，配合 `/v1/runs/{id}/approve`；
- 循环上限：`max_steps`、`max_replans`、`max_adversarial_rounds` 三个计数器都在 state 里累加，
  路由函数只读 state，不做副作用。

## 7. 角色分工

| 角色 | 职责 | 不做什么 |
| --- | --- | --- |
| Planner | 拆步骤、选工具、写验收条件 | 不执行、不评价 |
| Executor | 逐步调用工具、收集 Observation | 不改计划 |
| Reflector | 对照 `done_when` 判断是否完成、给出 replan 理由 | 不直接改产物 |
| Critic | 质量评分、阻断问题、覆盖率门禁 | 不写代码 |
| Coder | 写/修代码与测试 | 不给自己打分 |
| Tester | 找 Bug、跑覆盖率、给出复现 | 不改实现 |
| Summarizer | 汇总产出、引用来源 | 不新增事实 |

## 8. RAG

- 索引：`memory.semantic` 表（`doc_id, chunk, text, tokens, vec BLOB`）；
- 切块：按标题/段落，目标 300–600 tokens，重叠 1 句；
- 检索：BM25（SQLite FTS5）与哈希向量余弦的混合打分，`alpha=0.6`；
- 引用：检索结果必须带 `citation = {doc_id, chunk, offset}`，写入 Observation/MemoryRecord，
  最终 RunResult 的 `citations` 由此汇总，禁止模型编造来源。

## 9. Function Calling 接外部 API

- 工具注册：`@tool(name, schema, risk, timeout_ms)`，schema 直接生成 OpenAI `tools` 数组；
- 参数校验：jsonschema（或内置轻量校验器）严格模式，未知字段报错而非忽略；
- 执行：`http` 工具默认带超时、重试（仅幂等 GET）、响应体截断到 `max_observation_chars`；
- 幂等：`idempotency_key = hash(tool + canonical_json(args))`，TTL 10 分钟；
- 断路器：连续 `circuit_threshold=5` 次失败 → 打开 30 秒，半开探测一次。

## 10. 对抗式迭代到覆盖率达标

```
adversarial(state):
  round++
  patched = Coder(产物, 上一轮 blocking_issues)
  report  = Tester(patched, 跑测试/覆盖率)
  if report.coverage >= coverage_target and not report.bugs: verdict = pass
  elif round >= max_adversarial_rounds: verdict = give_up（记录未达标原因）
  else: blocking_issues = report.bugs
```

- 覆盖率目标默认 0.9，可由 TaskSpec 覆盖；
- **不许伪造覆盖率**：Tester 的覆盖率必须来自真实命令输出（`pytest --cov` / `vitest --coverage`），
  解析失败视为未达标；
- 每轮把 `Coder` 的 diff 与 `Tester` 的失败用例写进 run log，便于离线复盘。

## 11. 容器化 / 指标 / 自动回滚

指标（Prometheus）：

| 指标 | 类型 | 说明 |
| --- | --- | --- |
| `pipeline_runs_total{status}` | counter | 运行数（ok/error/aborted） |
| `pipeline_run_duration_seconds` | histogram | 端到端耗时 |
| `pipeline_node_duration_seconds{node}` | histogram | 节点耗时 |
| `pipeline_tool_calls_total{tool,status}` | counter | 工具调用成功/失败/短路 |
| `pipeline_llm_tokens_total{kind}` | counter | prompt/completion tokens |
| `pipeline_coverage_ratio` | gauge | 最近一次对抗迭代覆盖率 |
| `pipeline_rollback_total{reason}` | counter | 自动回滚次数 |
| `pipeline_config_version` | gauge(info) | 当前生效配置版本 |

自动回滚：

- 配置（模型、prompt 版本、阈值、few-shot）都是**版本化对象**，存在 `config_versions` 表；
- 新版本先走 canary（`canary_ratio`，默认 0.1）；统计窗口内
  `error_rate > error_threshold` 或 `p95_latency > latency_threshold` → 自动回滚到上一版本，
  `pipeline_rollback_total` +1，并写审计日志；
- 回滚是幂等的：同一版本重复回滚无副作用。

部署：`Dockerfile`（多阶段、非 root）+ `docker-compose.yml`（service + prometheus + 可选 grafana）。

## 12. 日志驱动的每日 Prompt / Few-shot 微调

- 日志：JSONL，一 run 一行（`run_id, task, plan, reflections, critiques, tool_stats, outcome, config_version`）；
- 每日任务：`python -m agent_pipeline.runner tune --since 24h`
  1. 按「失败/低分/回滚」筛选样本；
  2. 聚类失败模式（关键词 + 工具错误码），生成候选 Prompt 修改与 few-shot 示例；
  3. 用固定评测集离线评测候选（成本上限 `tune_eval_budget`）；
  4. 达标 → 注册新配置版本（canary）；不达标 → 只写建议报告，不改线上；
- 所有改动版本化且可回滚，绝不做「线上直接改写提示词」。

## 13. 10 万次调用的稳定性

- 预算：每 run 的 `max_llm_calls`、`max_tokens`、`max_wall_clock_s`；
- 背压：`max_concurrent_runs` 信号量，满则 429 并带 `Retry-After`；
- 超时：LLM 请求超时 + 工具超时 + 端到端超时，全部可配置；
- 幂等：`run_id` 幂等提交，重复请求返回同一 run；
- 断路器 + 重试退避（指数 + 抖动）；
- 成本：token 计入指标，超预算立即收口并返回已有产出；
- 可观测：每次 run 一条 JSONL，含各节点耗时与工具统计，便于定位长尾。

## 14. 运行

```bash
# 本地
uv venv --python 3.14 .venv
uv pip install -e ".[dev]" --python .venv/Scripts/python.exe
.venv/Scripts/python.exe -m pytest -q
.venv/Scripts/python.exe -m agent_pipeline.runner run --goal "把 XX 功能做完并测到覆盖率为 0.9"

# 容器
docker compose up --build
curl localhost:8000/health
curl localhost:8000/metrics
```

## 15. 验收标准

1. `pytest -q` 全绿，覆盖协议、状态机路由、工具幂等/断路器、记忆检索、回滚、指标；
2. 一次 run 能从 Plan 走到 Summarize，且每个 Observation 都能被 `call_id` 追溯；
3. 覆盖率不达标时进入 Adversarial 并真实调用测试命令（测试里用假 Tester 注入输出验证解析）；
4. 触发错误率阈值时 `pipeline_rollback_total` 增加且配置版本回退；
5. 日志文件可被 `runner tune` 读取并产出候选报告；
6. `/metrics` 暴露第 11 节所有指标。