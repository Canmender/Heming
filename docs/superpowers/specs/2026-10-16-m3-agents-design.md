# 和鸣 M3 设计文档：智能体对话（本地驱动 · 云端 IM 桥梁）

- 日期：2026-10-16
- 状态：用户已批准核心两节（配置/数据、流式管道），其余章节为规格补齐；用户指令「开始做吧」授权直接进入计划
- 关联：`2026-10-13-heming-platform-design.md`（总规格）、M2 计划遗留清单

## 1. 架构红线（用户裁定）

**本地驱动，云端只是 IM 即时通讯的桥梁。**

- **本地（驱动层，发起 @ 的设备）**：智能体系统提示词执行、LLM 连接与 Key（`localStorage`，Key 不出设备）、上下文组装、真正的生成动作、记忆/知识库（二期）。
- **云端（IM 桥梁）**：智能体**名册**（name/avatar/owner/简介——供成员列表与雷达显示）、会话与消息、将本机生成结果以 `sender_type=agent` 广播。云端不配模型、不调 LLM、不存 Key、不驱动人设。

**Key 归属**：每位用户自行配置，调用自己的 KEY（用户裁定）。

## 2. 配置与数据层

### 2.1 LLM 连接（本机）

- 模型：`{ id, label, provider: "openai" | "anthropic", baseUrl?, apiKey, model, temperature? }`
- Web/桌面壳存 `localStorage["heming.llmConfigs"]`（数组）；Electron `safeStorage` 升级列入遗留。
- 连通性测试：设置页对某连接发一次最小请求（openai: `GET {baseUrl}/models` 或 1-token chat；anthropic: 1-token messages），展示成功/失败与错误摘要。

### 2.2 智能体

- **云端 `agents`（名册级）**：`id, owner_id(null=系统), name, avatar, description`。预设「和小鸣」(system-assistant, owner NULL) 名册不可编辑。
- **本地绑定**：`localStorage["heming.agentLlm"] = { [agentId]: profileId }`。
- API（仅 owner，非 owner/系统 403）：`GET /api/agents`（全量名册）、`POST /api/agents {name, avatar?, description}`、`PUT /api/agents/:id`、`DELETE /api/agents/:id`。
- 创建入口：雷达顶栏「＋ 新建智能体」启用 → 弹窗：名称/头像(dataURL≤449KB)/简介/绑定 LLM 连接（无连接引导去设置页）；**系统提示词输入框存在但存本地**（随绑定存 `heming.agentPrompts[agentId]`——名册不上云）。
- 编辑入口：悬浮卡对「自己名册内」智能体显示编辑（名册字段云同步；提示词/模型仅本机）。

### 2.3 提及（mentions）

- `MessagePayloadSchema` 扩展：`mentions?: { agentId: string; name: string }[]`（结构化；客户端渲染高亮，不做文本反解析）。
- 输入框 `@` 触发群内 agent 选择器（数据=该群 members 的 kind=agent 行）。

## 3. 流式回复管道（WS 协议新增三事件）

触发链：发送含 mentions 的群消息 → **发送方设备**检测命中群内 agent → 本机以「本地系统提示词 + 会话近 30 条历史 + 该消息」组装上下文直连所绑供应商 SSE → 片段/完成/错误经 WS → 云端仅转发（chunk/error 不入库）或入库（finish）。

| 事件 | 路径 | 要点 |
|---|---|---|
| `agent_chunk {conversationId, agentId, streamId, text}` | 触发端→服务端→广播（不入库） | ~50ms 聚合；接收端按 streamId 打字机气泡 |
| `agent_finish {conversationId, agentId, streamId, text, replyTo?}` | 触发端→服务端 | 服务端**校验触发端是该群成员且 agent 在群内** → 入库 `sender_type=agent,senderId=agentId` → 广播 `message_new`（附 `streamId` 供各端替换打字机气泡） |
| `agent_error {conversationId, agentId, streamId, code, message}` | 双向广播（不入库） | Key 无效/超限/网络断；会话内错误行可重试 |

细则：

- 一消息多 agent → 每 agent 独立 `streamId` 并行。
- 生成中断（切换会话/撤回）→ 把已生成部分以 `agent_finish` 落库（所见即所得）。
- chunk 不落库，离线以 finish 后消息为历史；触发端断线 → 本地以 `agent_error(aborted)` 收场，不悬挂。
- 智能体 1:1 对话**不在 M3**（仅群内 @）。

## 4. UI（视觉遵循既有规范：无 emoji、浅灰 #e6e6e6 分割线、1.5px SVG、卡片灰影）

1. **设置区**：M2 占位页 →「LLM 连接」管理：连接列表（卡片：label/provider/model/末 4 位 Key）、新增/编辑表单、删除、连通性测试按钮、失败原因展示；另有既有「个人资料」保持。
2. **智能体弹窗**（新建/编辑）：名册字段 + 系统提示词 + 绑定连接下拉；无连接时内联「去设置页添加」。
3. **@ 选择器**：输入 `@`（或点输入栏「@」按钮）弹出群内 agent 列表（头像+名），选中插入 chip；chip 浅蓝底圆角、可点删除。
4. **流式气泡**：`agent_chunk` 到达在会话底部渲染 agent 打字机气泡（名册头像/名 + 浅蓝底 + 光标 `▌`）；`agent_finish` 替换为正式消息；`agent_error` 渲染错误行（原因 + 重试按钮，重试=重新发起该次生成）。
5. **触发端进度**：自己发起的流在输入栏上方显示「和小鸣 正在生成…」+ 中断按钮。

## 5. 错误处理

| 场景 | 行为 |
|---|---|
| 无绑定/无 Key | 发送前本地拦截，提示先去设置页（不发 mentions 消息） |
| Key 无效/余额/超限 | `agent_error` 会话内错误行，可重试；不入库 |
| 触发端流中断网 | 本地 `agent_error(aborted)` 收场；已生成部分 finish 落库 |
| 服务端收到 chunk/finish 但触发端非成员/agent 不在群 | 服务端回 `agent_error(forbidden)`，不广播不入库 |
| provider 非流式响应 | 客户端兼容非流式 body（一次性 finish） |

## 6. 测试（Vitest）

- shared：mentions schema、三新 WS 事件 schema 边界。
- server：agents CRUD 权限（owner/系统/他人 403）；WS `agent_finish` 入库+广播、chunk 只转发、非成员/agent 不在群拒绝、`message_new` 含 streamId。
- web：localStorage 连接/绑定读写；@ 选择器插入与高亮；打字机气泡（chunk→finish 替换、error 重试）；触发端多 agent 并行与中断 finish；触发前无 Key 拦截。
- openai/anthropic 客户端适配器：SSE 解析用录制的固定响应体测试（不打真网络）。

## 7. 遗留（非 M3）

Electron safeStorage、agent 扇区独立数据源（M2 终审）、1:1 智能体会话、记忆/知识库、MCP、WS 重连补 mark_read（M2 遗留）、群消息头像增强。
