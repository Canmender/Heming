# 和鸣 · 对标 Codex / Claude Code 的全量升级计划（2026-11-17）

- 日期：2026-11-17
- 状态：执行中
- 基线版本：`d.235.4.116.12`（工作树已提交，branch `main`，起点 clean）
- 目标（用户原话）：「全量升级，全量优化，我们的目标是像 Codex 和 Claude Code 那样的高阶智能体应用」
- 依据：`docs/COMPARISON-vs-codex-claude-code.md`（2026-11-17，Top 20 差距清单与三阶段路线）

---

## 0. 总原则

1. **差距的本质是三条线**：可编程性（无头/SDK/MCP server）、安全边界（hooks/审批/沙箱）、扩展生态（自定义命令/子代理定义）。本轮优先补这三条，而不是继续堆功能。
2. **每项都要有「可被程序调用」的验收**：不是「界面上多了个按钮」，而是 shell 里一条命令、测试里一条断言能证明它成立。
3. **诚实口径照旧**：拒绝路径要明说原因；老桌面端缺通道要如实降级；不把「没做」说成「不支持」。
4. **一批一版本、一批一全量门禁**：typecheck / 各包测试 / `pnpm eval:agent` / 桌面冒烟，证据回填 `docs/HANDOFF.md`。
5. **并行轨道文件不重叠**：`ChatPage.tsx`、`slashCommands.ts` 同一时刻只有一个写入者；服务器包、CLI 包、桌面包各自独立。

## 1. 本轮波次

### 第一波（本会话，3 轨并行）

| 轨 | 内容 | 对应差距 | 文件边界 | 验收 |
|---|---|---|---|---|
| W1 | **无头 CLI**：新增 `packages/cli`，`heming run` / `heming exec --json` / `--cwd` / `--max-rounds` / `--allow-danger`；复用 `evals/runner` 的 Node 文件/命令桥与 `agentStream` 真实循环、`llmClient` 真实模型 | Top 1 | `packages/cli/**`、根 `package.json` 一条 script | 在临时目录里跑真实 `file_read` 并输出结构化 JSON；危险工具默认拒绝、`--allow-danger` 才放行；退出码区分成功/任务失败/用法错误 |
| W2 | **服务端加固**：SQLite FTS5 会话搜索（短词回退 LIKE）、`x-request-id` + 结构化访问日志 + `/api/metrics`、登录会话过期/刷新/吊销 + 登录失败限流；客户端自动续期 | Top 11/16/17 | `packages/server/**`、`packages/web/src/lib/api.ts`、`packages/web/src/store/auth.ts` 及其测试 | 新 token 带过期；`/api/auth/refresh` 换新并吊销旧的；连续失败登录 429；FTS 命中与旧扫描结果一致 |
| W3 | **确定性 hooks（`pre_tool_use`）**：工作区 `.heming/hooks.json` 声明匹配规则与命令，工具执行前跑脚本，退出码 2 / JSON `deny` 即拦；`/hooks` 查看加载状态 | Top 3 | `packages/web/src/lib/hitl/**`、`lib/agentStream.ts`、`lib/agentRuntime/slashCommands.ts`、`ChatPage.tsx` 最小接线 | 单测覆盖匹配/退出码/超时/失败关闭；agentStream 注入式用例证明被 hook 拒绝的调用**不执行**且模型收到原因 |

### 第二波（第一波收口后）

| 轨 | 内容 | 对应差距 |
|---|---|---|
| W4 | 自定义命令（`.heming/commands/*.md`）+ 子代理定义文件（`.heming/agents/*.md`）+ `/rewind N` 轮次回滚 | Top 4/6 |
| W5 | 界面手感三件：Ctrl+F 唤起搜索、单条消息重生成、内联 diff | Top 18 |
| W6 | MCP server 模式：`heming mcp serve` 用 stdio JSON-RPC 暴露文件/命令工具，别的编辑器能调它 | Top 5 |
| W7 | 工作区权限规则：`.heming/permissions.json` 的 allow / deny / ask，接进 HITL 闸门（deny 优先、danger 默认仍询问） | Top 2（第一步） |

### 第三波（路线图，不在本轮承诺）


- 命令白名单（`packages/cli/src/workspaceRules.ts`，d.307：`.heming/permissions.json` 的 deny/ask/allow 已接进 `run` 与 `mcp serve`；`ask` 在无人的 CLI 里落成拒绝）+ 网络域名策略 + OS 级沙箱（Windows Job Object / 受限令牌）——网络域名策略与 OS 级沙箱仍未做；**只读模式已落地（d.315 `--read-only`：按工具自报 `risk` 裁剪能力、写/命令一律不执行，`mcp serve` 连工具清单都不列非只读项）**，但它只是能力裁剪，不等于沙箱；
- 更新链 https + 安装包签名校验；
- Web 端去桌面桥依赖（移动端前置）。

## 2. 明确不做（本轮）

- 不做 PTY（需要原生依赖，先评估）。
- 不做多平台产物（仅 Windows，形态决策未变）。
- 不动 E2E 加密协议与账号体系语义。
- 不在未拿到真机证据前宣称「安装包级」验证通过。

## 3. 写入边界

- 每轨只动「文件边界」列出的文件；跨轨共用文件先由主控指派。
- 子代理**不提交、不改版本号、不动 CHANGELOG/HANDOFF**；版本与提交由主控统一做。
- 子代理只跑受影响包的定向测试与 typecheck；全量门禁由主控在收口点跑，避免构建产物互相覆盖。

## 4. 进度台账

| 轨 | 状态 | 证据 |
|---|---|---|
| W1 无头 CLI | 已落地（d.243 `run`/`exec --json`/`--output-format stream-json`/`--cwd`/`--max-rounds`/`--allow-danger`；d.289 `mcp serve` 服务端；d.303 会话存档与 `--continue`/`--resume`，`sessions` 列出存档） | `packages/cli/src/{index,args,run,sessions,mcp,mcpServe,tooling}.ts` |
| W2 服务端加固 | 已落地（d.236 `/api/metrics` + 请求 id + 结构化日志 `obs.ts`、登录/注册限流、d.297 前的 token 刷新与吊销 `/api/auth/refresh`；会话 FTS5 搜索 d.197 `GET /api/conversations/search` + `searchMessages` 线性兜底） | `packages/server/src/{obs.ts,app.ts,store.ts,sqliteStore.ts}` + 各 `.test.ts` |
| W3 hooks | 已落地（`.heming/hooks.json` 的工具前钩子，默认不信任仓库脚本，带审计）；**CLI 侧同口径已接（d.313：`heming run` / `heming mcp serve` 也跑同一份配置，脚本默认不执行、要 `--trust-hooks`）** | `packages/web/src/lib/hitl/{hooks,hookRunner,gate,audit}.ts`、`packages/cli/src/toolHooks.ts` |
| W4 扩展与回滚 | 已落地（自定义命令 d.240、子代理定义 d.287、`/rewind N` 的**文件回滚** d.291、**对话截断** d.293、删除跨窗口同步 d.298、断线重连对齐 d.300） | `packages/web/src/lib/agentRuntime/{customCommands,subagentDefs}.ts`、`subagent.ts` 的 `agent` 参数、`packages/web/src/lib/fileEdit/rewindCheckpoints.ts`、`packages/web/src/lib/api.ts` 的 `deleteMessages`、`packages/web/src/store/chat.ts` 的 `resyncMessages`（d.300）、`packages/server/src/{app,store,sqliteStore}.ts` 的 `DELETE /api/conversations/:id/messages/delete`、`ChatPage.test.tsx` I4i/I3z/I3-rewind |
| W5 界面手感 | 已落地（Ctrl+F 唤起本会话搜索 d.236；工具参数内联 diff d.239 `argDiff.ts` 挂在工具气泡上；单条消息重答 d.295） | `packages/web/src/lib/agentRuntime/regenerate.ts`、`packages/web/src/lib/fileEdit/argDiff.ts`、`ChatPage.tsx` 消息行按钮 |
| W6 MCP 双向 | 已落地：服务端 d.289（`heming mcp serve`：initialize/ping/tools/list/tools/call，与 `run` 共用 `src/tooling.ts` 的闸门）；客户端 d.309（`run --mcp` 读 `.heming/mcp.json`、`mcp__<服务>__<工具>`、工具按 danger 处理且要 `--allow-danger`、参数原样转发） | `packages/cli/src/{mcp,mcpServe,tooling,mcpClient}.ts` + 同名 `.test.ts` |；**d.325 起还补上 MCP 的 `prompts` / `resources`**（`packages/cli/src/mcpCatalog.ts` 的 `collectCliMcpCatalog`，`.heming/commands/*.md` → 提示词 + 资源、AGENTS.md 一族与 `.heming` 三份配置 → 资源，`resources/read` 只在 list 名单里查） |
| W8 CLI 只读模式 | 已落地（d.315 `run --read-only` / `mcp serve --read-only`：只有自报 `risk:"read"` 的工具放行，未声明风险按写处理；只读判定在权限规则之前；与 `--allow-danger` 同时给时只读赢；MCP `tools/list` 不列非只读工具） | `packages/cli/src/tooling.ts` 的 `createCliGate({readOnly})`、`mcp.ts` 的 `describeMcpTools` 过滤、`run.ts` 的只读提示词、`args.ts` 的 `--read-only` |
| W9 CLI 上下文预算 | 已落地（d.317：`--context-budget <n>` 默认 12000、`--no-compact`；历史超预算时把早期对话折成确定性三段式摘要，最近轮原文保留；与系统提示词共用 `planTurnBudget` 一本账；溢出重试照转 `aggressive` 两级收紧；`onContext` 回报「折叠了 N 条」） | `packages/cli/src/contextBudget.ts`（`createCliHistoryPrep` / `parseCliContextBudget` / `describeCliContext`）、`packages/cli/src/run.ts`（`prepareHistory` 注入 + `systemTokens`）、`packages/cli/src/args.ts`、`packages/cli/src/index.ts` |
| W10 CLI 交互式审批 | 已落地（d.323：`--ask` 在终端里逐次放行危险调用，四种回答、一次性许可执行时扣减、非 TTY 拒绝启动、拒绝按 `cause: "user"` 回灌） | packages/cli/src/approvals.ts（`parseApprovalAnswer` / `describeApprovalRequest` / `createTerminalApprover` / `createScriptedApprover`）、packages/cli/src/tooling.ts（`createCliGate({ ask, dangerAllowed })`、`sessionAllowed` / `permits` / `stopped`）、packages/cli/src/args.ts、packages/cli/src/index.ts、packages/cli/src/callText.ts |
| W11 MCP 资源订阅 | 已落地（d.327：`resources/subscribe` / `resources/unsubscribe`，订阅的资源一变推 `notifications/resources/updated`，命令文件增减推 `resources/list_changed` + `prompts/list_changed`；只监听工作区 / `.heming` / `.heming/commands` 三个目录、不递归、按需建、退订即关） | packages/cli/src/mcpWatch.ts（`createMcpCatalogWatcher` / `relOfResourceUri`）、packages/cli/src/mcp.ts（`McpContext.subscriptions` / `notify`、两个新方法分支）、packages/cli/src/mcpServe.ts（装配 watcher 与签名比对） |
| W12 CLI 工作区记忆 | 已落地（d.329：`remember` 工具写 `.heming/memory.json`，运行时按提问召回最多 5 条注入系统提示词；`heming memory` 可列/加/删，`--no-memory` 两头都关；坏文件拒绝覆盖） | packages/cli/src/memory.ts（`loadCliMemory` / `addCliMemory` / `removeCliMemory` / `recallCliMemory` / `memorySection` / `rememberSpec`）、packages/cli/src/tooling.ts（`remember` 分支与只读兜底）、packages/cli/src/run.ts（`memory` / `memorySection`）、packages/cli/src/args.ts、packages/cli/src/index.ts |
| W7 CLI 项目约定 | 已落地（d.310 `run` 读工作区 `AGENTS.md` 一族并注入系统提示词，口径与桌面端 d.174 同源；`--cwd` 一层、最多 2 份、单份 4000 字 / 总量 6000 字、BOM/CRLF 归一、读不到不阻断） | `packages/cli/src/projectRules.ts` + `.test.ts`、`run.ts` 的 `projectRules` 选项、`index.ts` 的加载与摘要行 |
