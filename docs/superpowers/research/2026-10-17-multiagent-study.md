# 合鸣 Ensemble（D:\MultiAgent）可借鉴清单调研报告

- 调研日期：2026-10-17（只读调研，未改动 D:\MultiAgent）
- 用途：和鸣下一阶段「Agent 相关内容」的输入；总规格约定借鉴架构、不搬代码

## 一、项目概览

**定位**：本地优先的多 Agent 协作平台，通过可视化编排让 Claude Code / Hermes / OpenCode 等 AI Agent 协同工作。

**技术栈**（与和鸣高度同源）：React 18 / TS / Tailwind / @xyflow/react / Zustand；Express 5 + WS + SQLite WAL(node:sqlite) + Zod；Electron 43 + esbuild；Expo/RN 手机端；Vitest（145 单测）。

**目录**：`desktop/packages/{shared,server,web,desktop}` monorepo + `mobile/`、`relay-server/`、`ensemble-local|cloud/`、`TencentDB-Agent-Memory/`（外部参考仓库）、`IM/`（参考）。

**Server 分层**：`orchestration/`（编排引擎+5 模式）、`adapters/`（builtin/local）、`llm/`、`context/`（压缩）、`memory/`（双记忆池）、`tools/`（内置+MCP+RAG）、`hooks/`、`skills/`、`discovery/`（harness 探测）、`api/`、`plugins/`（事件总线/用户 KV）。

## 二、借鉴清单（按维度）

### 1. Agent 编排与多 Agent 协作
**① 统一编排引擎 + 事件溯源（高）**：OrchestrationEngine.executeJob 五模式共用；AsyncGenerator 产出归一化事件（status/output/tool_use/tool_result/done/error）逐条落库 run_events（原子 seq）+ WS 广播，断线 afterSeq 补拉；状态机纯函数表前后端共用。→ 和鸣「1:1 智能体会话」的多轮流式/可回放/断线续传可直接套此模型（Express+ws+SQLite 栈相同）。落点：Agent阶段/IM其他。

**② 并发与取消（高）**：同 agent promise 链串行锁防打爆单实例、不同 agent 并行；run 级 AbortController + 粘性取消（cancelledRuns Set，取消后新 job 拒绝启动）；steering 队列运行中注入下轮生效。→ 群内 @ 流式回复「追加指令/打断」与防连发打爆的现成范式。落点：Agent阶段/IM其他。

**③ 五种编排模式（选择性）**：chat（round-robin、@agent 委派、@done、resumeSessionId 续会话）最贴近和鸣群多 agent 协作；single 并行扇出+aggregator 汇总适合多 agent 答一题；workflow/plan/adversarial 偏研发场景，和鸣暂缓。

### 2. 记忆 / 知识库
**① 双记忆池 + 两级文件记忆（高）**：文件两级 `<agentId>/daily/YYYY-MM-DD.md` + `MEMORY.md` + meta.json；节流 flush（30s+1500 tokens 双阈值、per-agent 串行队列）；12h 周期 LLM consolidate 压缩近 7 天 daily 重写 MEMORY.md；preReasoning hook 首轮注入 MEMORY.md+近 3 天 daily+检索结果（截断 3000 字）。SQL 双池：显式（长期/用户可管）+ 隐式（TTL 24h、重要度淘汰），暴露 memory_pool_* 工具；agentId 白名单防路径穿越。→ 与和鸣本地红线完全兼容，记忆/知识库阶段可复用分层设计。落点：记忆知识库。

**② RAG 检索（高）**：递归字符分块+可选语义分块；embedTexts 走 OpenAI 兼容 /embeddings（可指本地 Ollama）；BM25 中文 bigram；向量+BM25 并行 RRF(k=60) 融合，单侧失败退化另一侧；embedding 失败不阻断入库（纯 BM25）。注入 EmbedFn 天然支持本地/已配 Key 两种模式。落点：记忆知识库。

**③ 外部记忆后端抽象（中）**：MemoryBackend 接口、SqliteMemoryBackend（FTS5 trigram，回退 LIKE）值得学；**Mem0 后端与红线冲突不引入**。

### 3. MCP 与工具调用
**① MCP 动态发现（高）**：McpManager 管 stdio/StreamableHTTP 生命周期，15s 超时+失败关 transport 防子进程残留；工具 mcp__<server>__<name> 前缀入 ToolRegistry，maxTools 25/描述 500 字限流；mcp_tool_catalog 元工具渐进发现；白名单外默认 HITL 确认（WS 弹窗）。落点：MCP。

**② 工具安全围栏（高）**：三层——shell 元字符正则拦截（&& || ; | ` $()）、危险命令黑名单（首词精确匹配防误杀）、白名单只匹配首 token（防 `npm;rm -rf /`）；文件/网络可整体禁用；MCP 命令同审计。→ harness/MCP 必抄。落点：MCP/harness。

**③ 循环检测（中高）**：滑动窗口 12 次统计 tool+args 签名，重复≥3 判死循环，注入提示让 LLM 自纠一次。落点：Agent阶段。

### 4. harness 桥接
**① LocalAgentExecutor（高）**：spawn(shell:false)+argv 数组（杜绝注入）、prompt arg 转义/stdin 双模式、.cmd 包 cmd.exe /c、windowsHide、超时 killTree（Windows taskkill /T /F）、readline 逐行 output 事件、取消不等 close 直接返回。→ 和鸣 Claude Code/OpenCode 桥接可完整复用此实现思路。落点：harness。

**② 本机探测+同步（高）**：discovery/detect.ts 9 种 harness 注册表（claude/codex/opencode/aider/goose/hermes/qwen/gemini/antigravity），where/--version 探测+30s 缓存；sync 导入对方 SKILL.md/记忆库/自动建 kind:"local" agent。落点：harness。

### 5. 对话上下文管理
**① ContextManager 压缩+溢出恢复（高）**：token 预算 80k×0.95 触发；原子组切分（assistant+tool_calls+results 不断）；保留近 N 组原文，更早 LLM 结构化摘要（INTENT/SUMMARY/ARTIFACTS/NEXT STEPS）；context_length_exceeded 极端压缩重试；大工具结果(>8000 字)落盘 offload，消息留首尾 1500+read_file 指针。落点：Agent阶段。

**② 流式中断与续传（高）**：WsHub 按 runId 订阅、16ms 批量降帧、共享序列化、bufferedAmount 背压、waitForRun 事件等待者；sessionId 存 job 支持跨轮 resume。落点：Agent阶段/IM其他。

### 6. 用量统计
① **Token 统计（高但需自研扩展）**：jobs.usage_json 聚合 total/byDay/byAgent；**合鸣无 userId 维度，和鸣团队视图需自研聚合**，仅借鉴存储思路。② **配额（中）**：仅 IP 滑窗限流，无 token 预算——合鸣未实现，需另起炉灶。

### 7. UI/交互
① **三视图 Run 监控（中高）**：日志/时间线/画布 + afterSeq 补拉；和鸣适合日志/时间线内嵌卡片，画布不必须。② **HITL 确认弹窗（高）**：requiresConfirmation 工具执行前 WS askConfirm → ToolConfirmDialog，abort 用 Promise.race 不阻塞。落点：MCP/harness。

## 三、与和鸣红线冲突清单

| 冲突项 | 冲突点 | 结论 |
|---|---|---|
| Mem0 外部记忆后端 | 记忆出设备 | 不适用，仅借接口抽象本地实现 |
| TencentDB-Agent-Memory 参考仓 | 云端托管记忆 | 不适用，仅借 L0-L3 分层理念 |
| relay-server / ensemble-cloud | 云端中继，定位相反 | 不适用（架构定位不同） |
| 组织权限五级+部门树 | 加重 IM 复杂度 | 暂缓，非 Agent 阶段必需 |
| Token 统计缺 userId 维度 | 不冲突但无法直抄团队视图 | 部分借鉴（存储思路），聚合自研 |

核心机制（编排/记忆/RAG/MCP/harness/上下文/HITL）均为纯本地实现，与和鸣「本地驱动、密钥不出设备、云端不代理推理、E2E 只见信封」红线**不冲突**，可放心借鉴。

## 四、建议的 Agent 阶段任务草案（≤10）

1. **智能体会话事件流层**：run_events 落库+afterSeq 补拉，为 IM 会话加 Agent 执行事件流。
2. **1:1 智能体会话**：round-robin+resumeSessionId 思路做单用户↔单 agent 多轮流式对话，复用现有 ws。
3. **本机 harness 自动探测**：9 种注册表+where/--version+缓存，设置页一键发现。
4. **LocalAgentExecutor 桥接**：spawn(shell:false)+argv+Windows killTree+stdin/arg 双模式。
5. **安全围栏+HITL 确认**：三层命令审计+requiresConfirmation WS 弹窗，harness/MCP 默认防护。
6. **双记忆池（本地版）**：文件两级+SQL 显式/隐式池、节流 flush、周期 consolidate、memory_pool_* 工具。
7. **本地 RAG 知识库**：递归分块+中文 bigram BM25+可注入 EmbedFn+RRF 混合检索，knowledge_* 工具。
8. **MCP 接口区**：@modelcontextprotocol/sdk、stdio/HTTP、命名空间注册、catalog 渐进发现、白名单外 HITL。
9. **上下文压缩与溢出兜底**：原子组切分+大结果 offload+极端压缩重试。
10. **Token 用量基础统计**：usage_json 落库聚合（需自扩 userId/群维度，为团队视图打底）。
