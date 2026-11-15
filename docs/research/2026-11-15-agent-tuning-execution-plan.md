# 和鸣 · 智能体能力调优执行计划

- 日期：2026-11-15
- 版本锚点：`d.147.4.94.11`（分支 `refactor/minimal-app`）
- 文档性质：**执行计划**（顺序 + 口径 + 任务表 + 门禁），可直接照做
- 配套调研：`study/08-agent-tuning-playbook.md`（总纲）、`09-verification-first`、`10-context-token`、`11-harness-eval`、`12-multiagent`、`13-model-prompt-memory`
- 结论一句话：**先补度量与门禁，再改工具与上下文契约，再要求"完成即证据"，最后才动编排**——顺序错了，后面每一步都无法判断是变好还是变坏。
- 三个曾待拍板的口径（CI、题集存储、HITL 边界）已在 §7 按行业通行做法**定稿**，本文档无待决项。

---

## 0. 一页看懂

### 0.1 顺序

```
P0 度量地基（1 周）        P1 门禁（0.5–1 周）       P2 效率（2–3 周）          P3 质量（2 周）        P4 编排（按需）
埋点 → 题集 → 评测脚本 → 基线 ──→ 钩子+CI+eval 门禁 ──→ 工具契约/结果折叠/预算 ──→ 完成即证据/失败归因 ──→ 续跑/并行
                                      │                        │                        │
                                      └── 每批结束跑同一题集：分数不降、token 不涨、原有门禁全绿 ┘
```

### 0.2 三条硬规则

1. **一次一批、一批一个版本号**，每批独立可回滚（沿用 `docs/VERSION-MANAGEMENT.md` 语义）。
2. **一次只改一个变量**；题集前后对比，n=3 取中位。
3. **"变好"必须能被一条命令复现**（`pnpm eval:agent`），且**安全口径只降噪、不放松**。

### 0.3 三个已定口径（详见 §7）

| 口径 | 定稿 | 一句话理由 |
|---|---|---|
| ADR-1 CI | 分层：pre-commit 快检 → pre-push 中检 → PR CI 确定性用例 → nightly 真实模型 eval | 通行做法都是"便宜的在 PR 卡、贵的在夜里跑"，避免把抖动的模型评测塞进 PR |
| ADR-2 题集存储 | 用例/夹具/基线**入库**，报告不入库（artifact 或 `.tmp`），凭据走环境变量 | 题集即代码可评审；报告是易变产物，入库只会膨胀 |
| ADR-3 HITL | 读自动 → **根内写自动（首写确认一次）** → 危险/根外/shell 必问；可审计持久规则 | 通行口径是"信任边界=用户显式授权的根"，根外与破坏性操作永不自动放行 |

---

## 1. 目标与非目标

### 1.1 三个目标

| # | 目标 | 可量化定义 |
|---|------|-----------|
| G1 | 增强任务完成效率与能力 | 固定题集 pass@1 上升；人工返工率下降 |
| G2 | 提升 token 使用率 | 每成功任务 token 下降、缓存命中率上升、输入输出比更健康 |
| G3 | 智能体可长期调优 | 每次改动有分数、有归因、有回滚 |

### 1.2 非目标

- 不做 agent 框架重写：运行时在 [agentStream.ts](packages/web/src/lib/agentStream.ts:519)（`runAgentMentions`），改契约不改骨架。
- 不做端到端微调/RL；不训练模型。
- 不新建服务端 agent 路由：服务端只见信封（[app.ts](packages/server/src/app.ts:132) 起 49 条路由，无 agent run），评测留在本机/CI。
- 不动 E2E 加密、红线条目、可写根安全模型（只在 §7 ADR-3 内做"降噪不减拦"）。
- 不做多智能体大改：`collaboration` 现为 sequential/supervisor/debate 纯逻辑（`lib/collaboration/types.ts:17`，rounds clamp 1–3 于 `engine.ts:93-96`），本期只在单 agent 可测量之后做小步实验。

---

## 2. 现状基线（代码级事实，已核对）

### 2.1 运行时链路

| 事实 | 位置 |
|---|---|
| 编排在客户端，不在 server：一次 mention 一条并发流 | [agentStream.ts:519](packages/web/src/lib/agentStream.ts:519)、`:532` |
| 工具轮上限 12（防死循环兜底），收敛靠 token 预算 | [agentStream.ts:28](packages/web/src/lib/agentStream.ts:28)（`MAX_TOOL_ROUNDS = 12`） |
| 单轮工具 token 上限 12000 | [agentStream.ts:36](packages/web/src/lib/agentStream.ts:36)（`MAX_TURN_TOOL_TOKENS = 12_000`） |
| 每轮重发前折叠旧工具结果 | [agentStream.ts:775](packages/web/src/lib/agentStream.ts:775) → `agentContext/toolResults.ts` |
| 多条 system 合并成一条 | `agentStream.ts:785-797` |
| 上下文溢出重试 2 次，预算 ×0.5 / ×0.25 | [agentStream.ts:400](packages/web/src/lib/agentStream.ts:400)、`agentContext/history.ts:30-45` |
| 工具执行：只读并行、写/危险串行 | `agentStream.ts:1303-1310`（`writeChain`） |

### 2.2 上下文与 token

| 项 | 值 | 位置 |
|---|---|---|
| 历史预算 | 6000 tokens / 保留 8 轮 / 预留 900 | [budget.ts:11-15](packages/web/src/lib/agentContext/budget.ts:11) |
| 压缩对象 | 只压最近 N 轮之前；摘要是第二条 system | `agentContext/history.ts:100-101`、`:122-125` |
| 工具结果回灌预算 | 3000 tokens / 最近 3 条不折叠 / **替换占位不删除** | [toolResults.ts:22-25](packages/web/src/lib/agentContext/toolResults.ts:22)、`:12-18` |
| 单条工具输出截断 | 8000 字符，头 2/3 + 尾 1/3 | [bridge.ts:167-185](packages/web/src/lib/mcp/bridge.ts:167) |
| 记忆注入 | ≤1200 字符，语义/情景/焦点 40/40/20 | `lib/memory/format.ts:11-13` |
| 技能注入 | top3 / ≤1600 字符 | `lib/skills/router.ts:103` |
| 记忆召回 | 半衰期 90 天、MMR 阻尼 0.6、个性化 boost ≤+25% | `lib/memory/recall.ts:37,109-134`、`usage.ts:28,57-61` |
| 基础提示词稳定 | 两段皆空时严格返回同一字符串（缓存前缀） | `lib/agentRuntime/context.ts:13-20`、`:238` |

### 2.3 工具与安全

| 事实 | 位置 |
|---|---|
| 工具注册：`CapabilityRegistry.build` → `ToolBridge`，重名前者胜 | `lib/capability/registry.ts:36-58` |
| 工具 schema 为 OpenAI function 格式 | `lib/fileEdit/tools.ts:133-140` |
| `file_patch`/`file_read`；无 write 根不注入写工具 | `fileEdit/tools.ts:41-76`、`:100-105` |
| 执行永不抛，失败返回 `{text, ok:false}` | `fileEdit/tools.ts:161-164` |
| 文件上限：单文件 2MB / 单补丁 4MB / 20 文件；可写根 ≤20、无 full-disk | `fileEdit/limits.ts:15-21`、`roots.ts:4-11,21` |
| HITL：deny→allow→policy pass→问人，兜底 deny | [hitl/gate.ts:54,62,77-127](packages/web/src/lib/hitl/gate.ts:54) |
| 三档 strict/guarded/trusted，无全放行；默认 guarded，floor=read | `hitl/policy.ts:39-43,64,84` |
| 前缀授权：任一目标命中 deny 即整份 deny；`*` 不算覆盖 | `hitl/policy.ts:474-510` |
| 风险分类：meta.risk→前缀表→危险词正则→读意图→兜底 write | `hitl/classify.ts:8-14,15-27` |
| 会话内 allow 只在内存 Map（重开即忘） | `hitl/policy.ts:194-204` |

### 2.4 度量现状（三个断点 = 本计划存在的理由）

| 断点 | 事实 | 位置 |
|---|---|---|
| ① trace 无 token/耗时 | `rollout` 5 类事件（turn_start/tool_call/tool_result/assistant_final/turn_end），只有 `at`；localStorage 200 条/回合、20 回合、单条 2000 字 | `lib/rollout/types.ts:17,34-87`、`log.ts:26-34` |
| ② token 账不可关联 | `heming.tokenUsage` ≤5000 条，有 input/output/profileId，**不带 streamId** | `lib/store/tokenUsage.ts:3-31`、`ChatPage.tsx:1535`、`agentStream.ts:1457` |
| ③ 没有效果评测 | JS 侧无 eval/benchmark；**无 CI**（`docs/AUDIT-2026-11-13.md:152`：仓库无 `.github`，门禁靠手动）；verifier 8 步只测"能跑" | [HANDOFF.md:52-66](docs/HANDOFF.md:52) |

可直接复用的地基：

- `rollout` 已能做每回合事实源（`view.ts` 支持单回合导出；`pair.ts:42` 已做调用↔结果配对与 `denied` 分离）。
- 召回可观测性：`lib/memory/recallLog.ts:18-28` 环形日志 + `usage.ts:26-39` 权重账本。
- 真实 token/成本：`lib/magpieUsage.ts:1-19` 按时间桶给 calls/errors/input/output/cost/cache_read/cache_write。
- 现成"评分→门槛→回滚"语义：`services/agent-pipeline/src/agent_pipeline/tune.py:148-186`（baseline/candidate + `min_improvement`）、`metrics.py:15-45`；**但未接线到主聊天 agent**（[HANDOFF.md:348](docs/HANDOFF.md:348)）。
- "可机判验收"范式：`scripts/design-audit.mjs`（9 条硬阈值 `:51-61`、`--json` 报告 `:648`、exit 0/1 `:762-787`）。

---

## 3. 指标定义

| 指标 | 定义 | 数据源 | 采法 | 90 天目标（相对本期基线） |
|---|---|---|---|---|
| pass@1 | 题集首次即通过的比例 | `evals/reports/*.json` | 确定性断言 | +10pp |
| 每成功任务 token | (input+output)/通过数 | rollout `turn_end.usage` | T1 埋点 | −30% |
| 缓存命中率 | cache_read / input | magpie usage | T2 关联 | +15pp |
| 输入输出比 | input / output | 同上 | 同上 | 观察项，不设硬目标 |
| tool_calls / 任务 | 成功任务平均工具调用数 | rollout `tool_call` | 已有 | −15% |
| tool_errors / 任务 | 工具返回 `ok:false` 次数 | rollout `tool_result` | 已有 | −50% |
| HITL 弹窗 / 任务 | 需要人确认的次数 | rollout + hitl store | T13 前后 | −40%（危险用例仍 100% 拦） |
| p50 / p95 时延 | 首字到收口 | rollout 补 ms | T1 埋点 | p95 −15% |
| 返工率 | 同会话用户纠正/重来消息占比 | rollout + 会话日志 | 半自动 | −20% |
| 压缩后答对率 | 长会话专项题通过率 | 题集 `context` 标签 | 专项用例 | 不降 |

> 绝对值等 T5 基线测完回填；**本文档不预先编数字**。

---

## 4. 执行顺序与理由

### 4.1 依赖

```
P0.1 埋点(T1,T2) ─┐
P0.2 题集(T3)    ─┼─→ P0.3 评测脚本(T4) ─→ P0.4 基线(T5) ─→ P1 门禁(T6,T7,T8)
                                                                     │
             ┌───────────────────────────────────────────────────────┴────┐
             ▼                                                            ▼
   P2.1 工具契约(T9) → P2.2 结果折叠(T10) → P2.3 预算口径(T11)      P2.4 前缀/缓存(T12)
             │                                                            │
             └──────────────→ P2.5 HITL 降噪(T13) / P2.6 工具瘦身(T14) ────┘
                                     │
                                     ▼
                        P3 质量：证据(T15) / 归因(T16) / 注入可解释(T17)
                                     │
                                     ▼
                        P4 编排：续跑(T18) / 只读并行(T19)
```

### 4.2 顺序理由（全文最重要的一节）

1. **先埋点，再优化**。`rollout` 只有时间戳、`tokenUsage` 不带 streamId——"token 使用率提升了多少"今天无法证实。没有 T1/T2，P2 的任何改动都只能靠感觉，这正是过去多轮"改了但说不清有没有用"的根因。
2. **先题集，再动手**。12 题是从"我们相信 agent 应该会做"反推的验收面；没有它，折叠工具结果省了 token 却让模型丢证据这类回归会静默发生。
3. **先门禁，再改造**。`pnpm eval:agent` 进 CI/verifier 后，P2 每一项才有机械的"红了就退"依据；否则评审只能靠记忆。
4. **P2 先工具层、后提示词层**。工具结果占的是**每一轮**输入（`agentStream.ts:775` 每轮折叠），影响面比系统提示词大一个量级，且判定客观。
5. **P3 晚于 P2**。"完成即证据"要先有稳定工具（能可靠跑命令、拿输出）；失败归因要先有 usage/ms 字段（P0）。
6. **P4 最后**。单 agent 的 token 与工具没理顺就上并行，等于把未测量系统乘 4 倍 token（调研实测：orchestrator-worker 4x/15x；20 个子 agent 会退化到 1–3 个真干活）。编排必须建立在"单 agent 可测量、可回归"之上。

---

## 5. 任务表

> 估时按 1 人全职；"改动点"是最小侵入位置。所有任务默认：改完补单测、跑 §9 门禁。

### P0 度量地基（约 1 周）

| ID | 任务 | 改动点 | 依赖 | 验收 | 估时 |
|---|---|---|---|---|---|
| T1 | rollout 补 usage 与耗时 | [rollout/types.ts:82-87](packages/web/src/lib/rollout/types.ts:82)（turn_end）+ `agentStream.ts:1446-1447`（record 处）：`turn_end.usage{input,output,cacheRead,cacheWrite,rounds}`、`tool_result.ms`；字段全可选，旧回合按缺省读 | — | 单测；回放视图显示本回合 token 与工具耗时；旧数据不报错 | 0.5d |
| T2 | token 账可关联 | [tokenUsage.ts:3-31](packages/web/src/lib/store/tokenUsage.ts:3) 加 `streamId/conversationId`；`agentStream.ts:1457` 写入；`ChatPage.tsx:1535` 透传 | T1 | 用量面板可按会话/流查；单测 | 0.5d |
| T3 | 题集 v0（12 题） | 新建 `evals/cases/*.yaml` + `evals/fixtures/**`（见 §8）：只读问答 / 单工具 / MCP / 文件补丁 / 长会话压缩 / 记忆命中 / 技能命中 / HITL 拒绝 / 工具报错自恢复 / 多轮工具 / 空结果 / 中文混排 | — | 人审 12 例可读；断言全确定性（不看"感觉"） | 2d |
| T4 | 评测跑器 | 新建 `scripts/eval-agent.mjs`，形状照 [design-audit.mjs:648,762-787](scripts/design-audit.mjs:648)：读 YAML → 起本机假网关（复用 d.69 路子）→ 跑题集 → `--json` → exit 0/1；支持 `--compare evals/baselines/*.json` | T3 | 一条命令出分数；失败给到 `case id + grader + 期望/实际` | 3d |
| T5 | 冻结基线 | `evals/baselines/<model>-<date>.json`（见 §8.4）：分数、token、耗时、node/pnpm/模型 id/温度 | T1,T4 | 同命令连跑 3 次分数差 ≤3%（否则先修抖动测法） | 0.5d |

### P1 门禁（约 0.5–1 周，按 §7 ADR-1 分层）

| ID | 任务 | 改动点 | 依赖 | 验收 | 估时 |
|---|---|---|---|---|---|
| T6 | 本机钩子 | `scripts/install-hooks.mjs` + `git config core.hooksPath .githooks`（入库）；pre-commit：受影响包 lint+typecheck（<30s）；pre-push：`typecheck` + `@heming/web` 单测 | T4 | `git commit/push` 触发；可用 `-n` 绕过并留痕 | 1d |
| T7 | eval 入门禁 | 根 `package.json` 加 `eval:agent`；`HANDOFF.md` verifier 清单在 design:audit 后加第 9 步 | T4,T5 | 新会话照 HANDOFF 能跑完 | 0.5d |
| T8 | CI（PR + nightly） | `.github/workflows/verify.yml`（PR：typecheck+build+全量单测+**确定性** eval）；`.github/workflows/eval-nightly.yml`（cron+dispatch：真实模型 eval，配 secret 才跑，未配则 `skipped` 明确标记而非绿） | T6,T7 | PR 上能看到红绿；nightly 产出报告 artifact；未配 secret 不会假绿 | 2–3d |

### P2 效率（约 2–3 周，可并行拆批）

| ID | 任务 | 改动点 | 依赖 | 验收 | 估时 |
|---|---|---|---|---|---|
| T9 | 工具错误契约 | `lib/mcp/bridge.ts:161-164` 失败返回统一 `{error_code, retry_with, hint}`；`fileEdit/tools.ts:161-164` 对齐 | T5 | 题集"工具报错自恢复"通过率上升 | 1d |
| T10 | 同工具结果合并折叠 | [toolResults.ts:52-58](packages/web/src/lib/agentContext/toolResults.ts:52)：同工具多次调用合并成"最近一次全文 + 前几次单行摘要"，仍受 3000/3 约束 | T5 | 单测；题集 token −15% 且分数不降 | 1.5d |
| T11 | 统一"每请求预算"口径 | [budget.ts:11-15](packages/web/src/lib/agentContext/budget.ts:11) + `agentStream.ts:775`：定义 请求 token = system + 历史 + 本轮工具结果；三处闸门（6000/3000/12000）改为同一账本三个上限 | T10 | 新单测 `planTurnBudget`；长会话不 400；分数不降 | 2d |
| T12 | 稳定前缀与缓存 | `agentRuntime/context.ts:13-20` 已保证空段同串；把时间/会话 id/动态工具清单移出 system 或压到末尾；用 magpie 的 cache_read 验证 | T2 | cache_read 占比上升；题目不降 | 1.5d |
| T13 | HITL 降噪（按 ADR-3） | `hitl/policy.ts:305-323`（allowed）+ `:194-204`（会话记忆）：根内写自动（首写确认一次）、会话记住持久化、可选"始终允许"落规则表；危险词/根外/`*` 永不自动放行；`roots.ts` 拒绝盘根目录 | T5 | 弹窗/任务 −40%；§7 五类恶意用例 100% 仍拦；规则可查可撤 | 3d |
| T14 | 工具说明瘦身 | `capability/registry.ts:36-58` 注册时裁剪：只注入启用工具、MCP 描述截断到上限、同名参数去重 | T5 | 每轮 schema token −20%；工具选择正确率不降 | 1.5d |

### P3 完成质量（约 2 周）

| ID | 任务 | 改动点 | 依赖 | 验收 | 估时 |
|---|---|---|---|---|---|
| T15 | 完成即证据 | 收口要求 assistant_final 带 `evidence{files, commands[], outputDigest}`，落 `tasks/store.ts` + rollout；面板展示 | T1,T2 | 题集"只自称完成无证据"判负；人审 10 例认可 | 2d |
| T16 | 失败归因分类 | `agentStream.ts` 收口按 上下文溢出/工具错误/模型拒答/HITL 拒绝/超轮次 分类写 `turn_end.failure` | T1 | 面板出"五抽屉"报表；新失败必落一类 | 2d |
| T17 | 注入可解释 | 复用 `memory/recallLog.ts:18-28` + `usage.ts`，面板展示"注入了哪几条、命中/被裁原因" | — | 题集"该召回未召回"能定位到条 | 1.5d |

### P4 编排与长任务（按需，P0–P3 完成后评估）

| ID | 任务 | 改动点 | 依赖 | 验收 | 估时 |
|---|---|---|---|---|---|
| T18 | 任务续跑最小版 | `lib/tasks/store.ts:25-51`（现 60 任务/40 步/10 分钟、内存态）→ 落盘 + 重启恢复，**不重复副作用**（幂等键） | T15,T16 | 杀进程重启后任务状态与证据仍在 | 3d |
| T19 | 只读并行 / 团队实验 | `agentStream.ts:1303-1310` 旁开"只读并行 ≤3 路"；团队沿用现状只验证 rounds ≤3 | T18 | 并行题 p50 −30% 且正确率不降；token 增幅 <2x | 3d |

---

## 6. （预留：批次记录表）

每批完成后在此追加一行，作为长期台账：

| 批次 | 版本号 | 主变量 | 分数 Δ | token Δ | 结论/证据 |
|---|---|---|---|---|---|
| P0 | 待填 | 度量 | — | — | — |

---

## 7. 三个口径的定稿（ADR）

> 原则：采用行业通行做法；只在"通行做法与本仓库现状冲突"处做最小调整，并在下方写明理由与失效条件。

### ADR-1 CI：分层，便宜的在 PR 卡，贵的在夜里跑

**通行做法**：业内（大厂与开源项目）普遍是"三层门禁"——提交前本地快检（lint/format/typecheck）、推送前中检（单包单测）、PR 上跑确定性检查（构建+全量测试+快照/契约），模型相关评测因贵且抖，不进 PR，放 nightly 或发布前。CI 失败必须产出可下载 artifact（日志、报告、截图）。

**本仓库采用**：

| 层 | 触发 | 跑什么 | 时长目标 |
|---|---|---|---|
| L0 pre-commit | `git commit` | 受影响包 lint + typecheck | < 30s |
| L1 pre-push | `git push` | `pnpm typecheck` + `@heming/web` 单测 | 3–8 分钟 |
| L2 PR CI | push/PR | L1 + 全量单测（server/shared/desktop）+ `pnpm build` + `plugin:check` + **确定性** eval（假网关） | 15–25 分钟 |
| L3 nightly | cron 02:00 + 手动 dispatch | 真实模型 eval（n=3）+ design:audit 浅色/暗色 + 长会话/压缩专项 | 30–60 分钟 |

**关键约定**：

- 并发固定：`maxWorkers:8` 是踩坑调出来的（[vite.config.ts:51](packages/web/vite.config.ts:51) 注释：满并发会饿死动态 import、门禁不可复现），CI 不得按核数动态调。
- 模型评测的 secret 未配置时，nightly **必须 `skipped`/灰色**，不许当绿。
- 如果仓库最终不接 GitHub：同构搬到 GitLab CI 或自托管 runner；最差退化为 L0+L1 + 发布前手动跑 HANDOFF 清单（已有实践）。
- `design:audit` 依赖 headless Chrome（自己起 server+CDP，`design-audit.mjs:189-244`），CI 里用固定版本 Chrome + 固定视口，避免跨机抖动。

**失效条件**：若未来引入需要 GPU 或分钟成本过高的评测（多模型矩阵），L3 改为"每周"并只跑抽样题集。

### ADR-2 题集与分数：用例/夹具/基线入库，报告不入库

**通行做法**：主流评测框架（OpenAI evals、promptfoo、LangSmith 一类）都把「用例定义 + 期望」当代码版本化、可 review、带标签与负责人；**评测报告是易变产物，放 artifact 或本地目录**；基线（baseline）作为小 JSON 入库，但更新基线必须人工 review（防止"改基线让分变绿"）；密钥走环境变量，禁止写进用例。

**本仓库采用**：

```
evals/
├─ cases/            # 入库：*.yaml，按 tag 分文件，带 owner 与 tags
├─ fixtures/         # 入库：假文件树、假 MCP 响应、假网关脚本（不落真实数据）
├─ baselines/        # 入库：<model>-<date>.json，人工 review 后更新
└─ reports/          # 不入库（.gitignore）：每次运行产物，CI 当 artifact
```

| 规则 | 说明 |
|---|---|
| 用例脱敏 | 必须用仓库内 fixture 与假网关；需要真实目录的用环境变量占位，文件头注明 |
| 基线只许人工改 | 基线变更必须独立 commit + 人工 review；**禁止 agent 自更新基线**（呼应调研：AI 改基线是"假绿"主要来源） |
| 报告不入库 | 只在 HANDOFF 记一行摘要（分数、token、日期、模型 id） |
| 用例变更即代码变更 | 改题目/改期望要单独 commit，并在 PR 里说明"为什么这题变了" |
| 历史对照 | 报告不入库但 artifact 保留 90 天，足够看趋势 |

**失效条件**：若题集必须包含真实业务数据才能测准，则该题单独放"本机专测集"（不入库、不入 CI），只在发布前人工跑。

### ADR-3 HITL 边界：信任边界 = 用户显式授权的根

**通行做法**：主流编码 agent（Claude Code 的 allow/deny 权限规则、Codex CLI 的 approval 模式、Cursor 的自动运行允许清单、VS Code 的 workspace trust）都是同一套心智：**用户显式授予的工作区内可以少问，工作区外和破坏性操作必须问**；且都支持"允许一次 / 本次会话允许 / 始终允许（写入项目规则）"三档，deny 优先于 allow。

**本仓库采用（三层）**：

| 层 | 行为 | 实现位置 |
|---|---|---|
| L1 读 | 自动通过（现状 floor=read） | `hitl/policy.ts:84` |
| L2 根内写 | 同 stream、同工具、同可写根前缀：首次确认一次，后续自动；会话内记住，可选"始终允许"落本机规则表 | `hitl/policy.ts:305-323`（allowed）、`:194-204`（会话 Map → 持久化） |
| L3 危险/根外/shell | 必问；`danger` 不吃 `allow`；`*` 不算覆盖（保持现状） | `hitl/policy.ts:474-510`、`gate.ts:77-127` |

**硬排除（永不自动放行）**：写可写根之外、写到盘符根目录（`D:\` 这类，需在 `roots.ts` 直接拒绝）、`.exe/.bat/.ps1/.cmd/.vbs` 等可执行扩展、改 `package.json` 的 scripts、删除操作、任何 `danger` 分类。

**为什么不是全自动**：`roots.ts` 默认空、上限 20、无 full-disk（`fileEdit/roots.ts:4-11,21`），说明"根=用户授权"的语义已经成立；但与 Claude Code 不同，和鸣的可写根可以由用户加到很宽，所以**必须补一条"拒绝盘根目录"的规则**，否则 L2 等价于半放行全盘。

**验收**：弹窗/任务 −40%；五类恶意用例（根外写、盘根写、写可执行文件、改 scripts、删文件）100% 拦；规则表可在设置页查看/撤销；换根重问。

**失效条件**：若产品决定开放"整盘可写"，L2 立即降级为"仅会话记住"（方案 A）。

---

## 8. 评测工程规范

### 8.1 用例 schema（YAML，一行一例亦可 JSONL）

```yaml
id: tool-001
name: 单工具调用
owner: agent
tags: [tool, read]
setup:
  fixture: fixtures/readme-tree        # 可选：临时目录/假 MCP
steps:
  - prompt: 读出 README 前 20 行并总结
graders:
  - type: tool_called
    tool: file_read
  - type: contains
    value: ["和鸣"]
  - type: max_rounds
    value: 3
```

### 8.2 grader 类型（先确定性、后主观）

| 类型 | 判定 | 用途 |
|---|---|---|
| `contains` / `regex` / `exact` | 文本 | 事实性回答 |
| `file_assert` | 文件存在/内容匹配/行数 | 文件补丁类 |
| `exit_code` | 命令退出码 | 跑测试/脚本类 |
| `tool_called` / `tool_sequence` | 调用名与顺序 | 工具选择 |
| `hitl` | 是否弹窗/是否拒绝 | 安全用例 |
| `no_side_effect` | 目标不存在/未被改 | 恶意用例 |
| `llm_judge(rubric)` | 规则化评分 | **仅 ≤1/3 的开放题**，必须附理由与 rubric |

### 8.3 抖动控制（否则分数不可信）

- 温度 0（provider 支持时）；n=3 取中位，或报 pass@3；
- 固定模型 id 并写入报告；记录 provider 与日期；
- 超时与重试上限固定；重试不计入分数但计入报告；
- 本机缓存隔离（每例独立临时目录），避免上一例污染下一例。

### 8.4 基线与报告样例

```json
{
  "model": "xxx", "date": "2026-11-20", "env": {"node": "24.x", "pnpm": "10.x"},
  "totals": {"cases": 12, "passed": 9, "pass@1": 0.75,
             "tokens_per_pass": 41200, "cache_read_ratio": 0.31, "p95_ms": 18200},
  "cases": [{"id": "tool-001", "passed": true, "rounds": 2, "tokens": {"input": 3200, "output": 410}}]
}
```

---

## 9. 门禁与命令

```bash
# 批次结束必跑（现有 8 步 + 本计划第 9 步）
node --check scripts/eval-agent.mjs
pnpm typecheck
pnpm --filter @heming/web test          # 300+ files / 4300+ tests
pnpm --filter @heming/server test
pnpm --filter @heming/shared test
pnpm --filter @heming/desktop test
pnpm build
pnpm plugin:check
pnpm design:audit -- --json .tmp/audit.json --shots .tmp/shots
pnpm design:audit -- --theme dark
pnpm eval:agent -- --compare evals/baselines/latest.json
```

| 情况 | 结论 |
|---|---|
| 分数降 >2% / token 涨 >10% / p95 涨 >15% | 红，回退本批最后一个变量 |
| 安全用例（HITL 拒绝、根外写、盘根写、可执行文件、删文件）任一失败 | 一票否决，不允许"下次修" |
| 现有 8 步任一红 | 红，不发布（与现行口径一致） |
| 全绿但分数持平 | 允许发布，但 HANDOFF 必须写"本批未产生可测量收益" |

---

## 10. 执行思路（10 条决策与理由）

1. **先度量后优化**：无 T1/T2，"提升 token 使用率"无法证实。
2. **一批一版本、一批一提交**：回滚成本 = 回退一个提交。
3. **一次只改一个变量**：P2 六项分六批，不是一起上。
4. **题集小而硬**：12 题起步；确定性断言优先，LLM judge ≤1/3 且给理由。
5. **阈值写死**：−2% / +10% / +15% / 安全一票否决，进脚本与 HANDOFF。
6. **不新建服务端路由**：题集与分数留本机/CI；跨设备需求出现再仿 `/api/team/usage`（`app.ts:461`）。
7. **复用而非新建**：判定语义借 `tune.py:148-186`，报告形状借 `design-audit.mjs`，token 事实借 `magpieUsage.ts`，注入解释借 `recallLog.ts`。
8. **工具层优先于提示词层**：影响每轮输入，判定更客观。
9. **安全只降噪、不放松**：HITL 三层 + 硬排除；根外与破坏性操作永不自动放行。
10. **每批留证据**：命令、输出摘要、分数 diff、artifact 路径写进 HANDOFF——评审只看证据。

---

## 11. 风险与回滚

| 风险 | 触发 | 缓解 | 回滚 |
|---|---|---|---|
| 埋点破坏 rollout 兼容 | T1 | 新字段全可选、读取容错；沿用 d.56「不回填、不批量迁移」 | revert 单提交 |
| 折叠省 token 但丢证据 | T10,T11 | 题集含"压缩后仍答对"专项；折叠只替换占位不删除 | 关闭折叠回退到 3000/3 现状 |
| HITL 降噪放行危险操作 | T13 | 三层 + 硬排除清单；五类恶意用例一票否决 | 回退 `allowed` 分支，降级为"仅会话记住" |
| 评测抖动导致假红/假绿 | T4,T5 | 温 0 / n=3 中位 / 固定模型 id / 缓存隔离 / 基线人工 review | 先修测法再下结论 |
| 模型/供应商漂移 | 全程 | baseline 记录模型 id 与日期；换模型必重跑并重冻 | 重冻基线并在 HANDOFF 注明 |
| CI 环境与本地不一致 | T8 | 固定 Node/pnpm/Chrome 版本；并发固定；失败留 artifact | 该 job 先降为 `continue-on-error` 观察一周 |
| 时间超支 | P2/P3 | 时间盒 1–2 周/批；超时砍范围不砍验收 | 本批降级为"只做 T9+T10" |
| 文档/代码被外部清理 | 本会话已发生两次 | 计划写入 `docs/research/`（随提交留存）；改完即 `git add` | 从 git 恢复 |

---

## 12. 90 天时间表

| 周 | 内容 | 里程碑 |
|---|---|---|
| W1 | T1,T2,T3 | trace 带 usage/ms；12 题可读 |
| W2 | T4,T5,T6 | `pnpm eval:agent` 出分；钩子上线 |
| W3 | T7,T8 | PR CI 红绿可见；nightly 跑通（无 secret 显式 skipped） |
| W4–W5 | T9,T10,T11 | 每任务 token −15~20%；错误自恢复上升 |
| W6–W7 | T12,T13,T14 | 缓存命中上升；弹窗 −40%；schema token −20% |
| W8–W9 | T15,T16,T17 | 完成可自证；失败可归因 |
| W10 | 复盘：回填绝对值、重冻基线、定下一轮 | 第二轮选题（T18/T19 或模型/提示词层） |
| W11–W12 | 缓冲（调优/回归/文档） | 三个目标各一条结论 + 证据链 |

---

## 13. 验收清单（全绿才算完）

- [ ] `rollout` 的 `turn_end` 带 `usage`，回放页显示本回合 token 与工具耗时
- [ ] `tokenUsage` 可按会话/流关联，用量面板可按会话查看
- [ ] `evals/cases/` ≥12 例，覆盖 §5 T3 的 12 类；夹具与假网关齐备
- [ ] `pnpm eval:agent -- --compare` 出分数，失败给到用例+grader+期望/实际
- [ ] `evals/baselines/*.json` 冻结并入库；报告在 `.gitignore`
- [ ] pre-commit/pre-push 钩子上线；PR CI 与 nightly 各有红绿
- [ ] HANDOFF verifier 含第 9 步；每批记录进 §6 台账
- [ ] HITL 五类恶意用例 100% 拦；弹窗/任务 −40%；规则可查可撤
- [ ] 三个目标各一条"命令 + 输出 + 对比"证据链
- [ ] 本文档与本批改动已提交

---

## 14. 附录

### 14.1 题集首批 12 例清单

| id | 名称 | tag | 关键 grader |
|---|---|---|---|
| read-001 | 只读问答（README 摘要） | read | contains |
| read-002 | 中文混排长文档要点 | read | contains + llm_judge(rubric) |
| tool-001 | 单工具调用 | tool | tool_called + max_rounds |
| tool-002 | 多轮工具（读→改→读回） | tool | tool_sequence + file_assert |
| mcp-001 | MCP 服务调用成功 | mcp | tool_called + contains |
| edit-001 | 文件补丁正确落盘 | edit | file_assert |
| edit-002 | 补丁失败可自恢复 | edit | exit_code/file_assert |
| ctx-001 | 长会话压缩后继续 | context | contains |
| ctx-002 | 工具结果超预算仍答对 | context | contains + max_rounds |
| mem-001 | 记忆命中注入 | memory | contains |
| skill-001 | 技能命中 | skill | tool_called/contains |
| hitl-001 | 根外写必须拒绝 | security | hitl + no_side_effect |

（安全恶意用例另设 5 例：根外写、盘根写、写 `.bat`、改 `package.json` scripts、删文件。）

### 14.2 数据字典（新增字段）

| 字段 | 类型 | 含义 | 来源 |
|---|---|---|---|
| `turn_end.usage.input` | number | 本回合输入 token | magpie |
| `turn_end.usage.output` | number | 本回合输出 token | magpie |
| `turn_end.usage.cacheRead` | number | 缓存命中 token | magpie |
| `turn_end.usage.rounds` | number | 工具轮数 | agentStream |
| `turn_end.failure` | enum | context_overflow / tool_error / model_refusal / hitl_denied / max_rounds | T16 |
| `tool_result.ms` | number | 工具执行耗时 | T1 |
| `tokenUsage.streamId` | string | 关联同一次流 | T2 |

### 14.3 与调研分册的对应

| 本计划 | 来源 |
|---|---|
| P0 度量 | 08 §7、11 §5 评测、11 §6 五抽屉归因 |
| P2 token | 10 全篇（100:1 输入输出比、缓存契约、context rot）、13 §4 记忆分层 |
| P2 工具 | 11 §4 工具契约（越多越贵、25k 响应上限、错误结构） |
| P3 证据 | 09 §2 验证定义与按类型证据表、11 §2 Feature Map |
| P4 编排 | 12 §3–§5（判据、五种拓扑、粒度、handoff、并发深度） |
| §7 三个 ADR | 行业通行实践 + 本仓库现状（`.github` 缺失、`roots.ts` 语义、`design-audit` 范式） |

### 14.4 一句话给未来的自己

> 调优不是"改得更好"，而是"让变好这件事可被证明"。先把证明链修好，再动 agent。
