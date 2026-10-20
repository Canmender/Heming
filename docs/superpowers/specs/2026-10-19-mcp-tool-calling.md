# MCP 与工具调用 · 实施记录

- 日期：2026-10-19
- 状态：**HTTP 与 stdio 两种传输都全链路可用**（登记 → 连接 → 拉工具 → 授权 → 模型调用 → 结果回灌）；stdio 仅桌面端
- 关联：`2026-10-18-im-skills-memory-ui.md`（同一批界面改造）

---

## 1. 目标

让智能体在会话里调用外部工具：

1. 用户在「接口区」登记 MCP 服务；
2. 连接后拉取工具清单，逐个决定「是否交给模型」；
3. 模型在回答中发起工具调用 → 本机执行 → 结果回灌模型 → 产出最终答案。

红线不变：**工具在本机执行，调用参数与结果不经过云端**（云端仍只是 IM 桥梁）。

## 2. 架构

```
┌───────────── web（渲染进程） ─────────────┐
│ InterfacesPage  ← UI：登记/连接/授权/测试 │
│ mcpRegistry     ← localStorage 配置与缓存 │
│ httpClient      ← JSON-RPC over HTTP      │
│ bridge          ← 工具名映射 + 执行        │
│ runtime         ← 拼 ToolBridge            │
│ agentStream     ← 工具轮循环（最多 3 轮）  │
└───────────────┬───────────────────────────┘
                │ POST（JSON-RPC 2.0）
        ┌───────▼────────┐
        │  MCP 服务（任意）│
        └────────────────┘
```

| 文件 | 职责 |
|---|---|
| `lib/mcp/types.ts` | 服务/工具/结果的类型 |
| `lib/mcp/jsonrpc.ts` | 请求构造、SSE 帧解析、错误格式化（纯函数） |
| `lib/mcp/httpClient.ts` | `initialize` → `notifications/initialized` → `tools/list` / `tools/call`；JSON 与 SSE 两种响应；20s 超时；`Mcp-Session-Id` 维持会话 |
| `lib/mcp/store.ts` | 服务注册表、工具缓存、**工具启用开关**（默认全关） |
| `lib/mcp/bridge.ts` | 工具名命名空间化（`服务__工具`，纯中文名走稳定短哈希）、OpenAI/Anthropic schema、执行与错误兜底 |
| `lib/mcp/runtime.ts` | 客户端缓存（按 serverId）、`refreshServerTools`、`buildToolBridge` |
| `lib/llmClient.ts` | 请求体注入 `tools`/`tool_choice`；流式解析 `delta.tool_calls` 并在结束时回调 |
| `lib/agentStream.ts` | 工具轮循环：执行 → 回灌 → 重答；**工具轮文本缓冲不上行**，只上行最终答案 |
| `lib/mcp/stdioClient.ts` | stdio 传输的渲染层客户端（经 preload 通道转主进程），接口与 HTTP 客户端一致 |
| `packages/desktop/mcp-stdio.js` | 主进程 stdio 桥：拉起子进程、换行分隔 JSON-RPC、按 id 配对、超时/退出兜底（纯函数 + 注入 spawn，可单测） |
| `packages/desktop/main.js` / `preload.js` | IPC `mcp:stdio:request` / `mcp:stdio:stop`；preload 暴露 `window.__mcp_stdio`（只暴露按 serverId 发一条 JSON-RPC，不暴露任意命令执行） |
| `components/InterfacesPage.tsx` | 接口区 UI（HTTP / stdio 两种传输） |

## 3. 关键设计决策

1. **工具默认关闭**。连接只拉清单；每个工具要单独勾选「交给模型」才会进提示词——工具可能有副作用，默认授权不可接受。
2. **工具名必须合法且唯一**。OpenAI 要求 `^[a-zA-Z0-9_-]{1,64}$`；中文服务名用稳定短哈希（同一名字每次都得到同一片段），重名自动 `-2/-3` 去重。
3. **工具轮不刷屏**。有工具时每轮文本先缓冲；只有「不发起调用」的那轮才上行。代价：开启工具后首字延迟变成「整轮结束才出现」，换来的是用户看不到「我这就去查…」这类中间话术。
4. **失败不炸整轮**。工具不存在、参数不是 JSON、服务超时、`isError`——全部转成文字结果回给模型，让模型自己决定换策略；对话不会因为一个工具挂掉而中断。
5. **轮次上限 3**。防止模型「调工具 → 再调 → 再调」死循环。
6. **anthropic 暂不支持工具**。其消息结构（content blocks）与 OpenAI 不同，本期只在 OpenAI 兼容供应商启用工具；未适配时自动跳过（不报错）。

## 4. 验证

| 项 | 结果 |
|---|---|
| 单测（MCP） | 14 例：JSON-RPC/SSE、客户端握手与 session、SSE 响应解析、HTTP 500 与 RPC error、注册表增删改查/重水合/默认关闭、命名空间去重、执行兜底 |
| 单测（编排） | 2 例：工具轮执行 + 回灌 + 只上行最终答案；无工具时不注入 `tools` |
| 单测（UI） | 6 例：空态、登记、非法地址、连接拉工具并授权、测试调用、删除 |
| 门禁 | web **54 文件 / 763 用例全绿**，typecheck 通过 |
| 端到端（HTTP） | 本地起了一个真实 MCP 服务（mock，`/mcp`），在页面里登记 → 连接 → 发现 `echo`/`now` → 授权 → 测试调用返回「回声：你好 MCP」 |
| 端到端（stdio） | 真机 Electron 里登记 `node.exe .tmp/mock-mcp-stdio.mjs` → 连接 → 发现 `fs_echo` → 授权 → 测试调用返回「stdio 回声：stdio 通了」；主进程侧单测 10 例（半包/通知/错误/超时/退出/stop/非法命令） |

## 5. 已知限制

- **stdio 仅桌面端**：浏览器没有子进程能力，页面会明确提示「配置可先保存，需桌面端连接」。
- **stdio 命令由用户填写**：不做白名单/签名校验，只在执行前提示「请确认命令可信」。高风险场景建议后续加命令确认弹层。
- **工具调用不做逐次确认**：授权粒度是「工具级开关」；如需「每次调用前询问」要再加审批弹层。
- **工具结果不落库**：只在本轮对话的回灌消息里；刷新后历史里只留最终答案。
- **未做工具调用可视化**：聊天里看不到「调用了 echo」的过程（可后续作为折叠的调用卡片展示）。
- **MCP 服务端可能要求鉴权**：支持自定义请求头（JSON），但没有 OAuth 流程。

## 5.5 智能体可视化：思考过程 / 工具调用 / 流式输出（2026-10-19 追加）

用户要求：与智能体交流时能看到**思考过程、工具调用、流式输出**。原实现里工具轮的文本被缓冲
（避免「我这就去查…」刷屏），代价是这些中间过程对用户完全不可见。

| 层 | 改动 |
|---|---|
| `lib/llmClient.ts` | 新增 `onReasoning` 回调，兼容 `delta.reasoning_content`（DeepSeek）、`delta.reasoning`（部分网关）、`delta.type==="thinking_delta"`（Anthropic）；非流式的 `message.reasoning_content` 同样回传 |
| `lib/agentStream.ts` | 累积思考过程并以**全文**回调（UI 直接替换）；工具调用在执行前后各发一次 `onToolTrace`（start / end 带 ok + 结果文本）；`ToolBridge.execute` 返回值改为 `{ text, ok }` 以便区分成败 |
| `store/chat.ts` | 流式状态新增 `reasoning?: string` 与 `tools?: ToolTrace[]`（本机展示用，不落库、不上行） |
| `components/AgentStreamBubble.tsx` | 思考过程可折叠（带字数，流式中默认展开、结束后自动收起）；工具轨迹逐条展示名称 / 状态（调用中·完成·失败）/ 耗时，展开看参数与结果 |
| `components/ChatPage.tsx` | 按 streamId 维护轨迹表（`onStart` 时清空），把 `onReasoning` / `onToolTrace` 写进流状态并传给气泡 |

**边界**：思考过程与工具轨迹都只在本机 UI 展示，**不进消息正文、不参与 E2E 加密信封、不上行云端**——
它们是「过程」，不是「结果」。支持该能力的模型（DeepSeek 系、部分网关）才有思考过程，缺失时这块不渲染。

**验证**：`ChatPage.test.tsx` 新增 2 条集成用例（真跑一轮「思考 → 调工具 → 回灌 → 答案」，断言
思考过程与工具轨迹进 DOM、工具轮中间话术不上行、finish 只含最终答案；未授权工具时不注入
`tools` 且气泡无轨迹）；`agentStream.test.ts` 2 条（思考累积为全文、工具 start/end 各一次）；
`AgentStreamBubble.test.tsx` 4 条（折叠/展开/结束自动收起、成功·调用中·失败三态、无内容时不渲染）。

## 6. 后续建议（按优先级）

1. 工具调用可视化（消息里插入「调用中/已返回」卡片）。
2. ~~stdio 传输（桌面端）~~ ✅ 已完成
3. 逐次确认模式（高风险工具）。
4. anthropic 工具适配（content blocks + tool_result）。
