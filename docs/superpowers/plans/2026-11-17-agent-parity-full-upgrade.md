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

- MCP server 模式（把和鸣工具暴露给其它编辑器/CLI）；
- 命令白名单 + 网络域名策略 + OS 级沙箱（Windows Job Object / 受限令牌）；
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
| W1 无头 CLI | 进行中 | — |
| W2 服务端加固 | 进行中 | — |
| W3 hooks | 进行中 | — |
| W4 扩展与回滚 | 进行中（自定义命令 d.240、子代理定义 d.287 已落地；`/rewind N` 未做） | `packages/web/src/lib/agentRuntime/{customCommands,subagentDefs}.ts`、`subagent.ts` 的 `agent` 参数、`ChatPage.test.tsx` I4i/I3z |
| W5 界面手感 | 待第二波 | — |
