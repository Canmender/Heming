# 和鸣 · 团队系统（去 IM）· 设计文档

- 日期：2026-11-02
- 状态：设计中（本轮实施）
- 关联：`2026-10-13-heming-platform-design.md`（平台总设计）、`2026-10-17-e2e-encryption-design.md`（E2E）、`2026-10-18-voice-call-design.md`（本轮删除）、`2026-10-22-bare-metal-deploy.md`（部署）

---

## 1. 动机与决策

和鸣现在的主干是 IM：会话、消息、已读、E2E、语音、未读角标、消息通知、桌宠未读都挂在同一个 `conversationId` 上。用户要求**删除 IM 即时通讯与所有人类聊天系统，保留通讯录，改成团队系统，可以查看团队动向**。

四条已拍板的边界：

| 决定 | 结论 |
|---|---|
| 智能体 | **保留**与「和小鸣」及自建智能体的对话；只删人类 IM |
| 团队动向 | 在线/活跃状态 + **真实成员自己的任务与日程摘要**；智能体工作留在「智能体」页，不做手动发动态（d.54.2.16 修订） |
| 团队模型 | **全站一个团队**：本实例所有注册用户即团队成员，通讯录即名册 |
| 语音/视频 | **一并删除**（依赖会话成员，删 IM 后失去来源） |

## 2. 范围

### 保留

- 账号、登录、注册开关、个人资料、密码与 token。
- **通讯录**：`users` 与既有好友关系数据；不再有好友申请入口，名册直接展示全站用户。
- **智能体**：系统 agent「和小鸣」、自建 agent、与 agent 的一对一会话（导航显示名「智能体」）。
- AI 对话的既有能力：E2E、流式、附件、图表、HITL 审批、记忆、技能、工具、任务区、导出。
- 幕僚、信息中枢、自动化、工作区文件、记忆区、技能区、插件区、接口区。
- 通知中心的 `task` / `staff` / `approval` 三类。

### 删除

- 人类私聊、群聊、建群、好友申请/接受、会话归档、已读/未读、typing、撤回、转发、表情回应、群内 @ 成员。
- 语音/视频通话：WS 六种信令、ICE 配置接口、通话窗、桌面通话桥。
- 预设群「和鸣交流群」与 `seedPreset`。
- 会话中心、联系人雷达、联系人详情、会话标签、会话缩略列、群信息卡。
- 消息通知、后台消息、未读角标、桌宠未读感知。
- 会话搜索、会话标签页、草稿按会话切换（AI 对话草稿保留为单会话草稿）。

### 明确不做

- 多团队/部门/职位/组织树；不做跨团队可见性。
- 手动发动态/状态墙/评论/点赞。
- 把对话正文、提示词、工具参数、任务结果或日程证据上传到服务端。
- 云端团队调度、跨设备任务同步、团队级搜索。
- 通话的替代方案（以后需要时按团队重建）。

## 3. 概念模型

- **团队（Team）**：本实例唯一。成员 = `users` 表的全部用户；没有独立 team 表。
- **智能体（Assistant，内部沿用旧名）**：`agents` 名册项。系统智能体 `system-assistant`（和小鸣）+ 用户自建。
- **会话（Conversation）**：只保留 `kind = "agent"`，即「某用户 ↔ 某智能体」的私有对话。人类 `direct` / `group` 不再创建，也不再出现在列表。
- **动态（Activity）**：服务端保存的**摘要事件**，用于团队动向。它不是消息，不含聊天正文。

## 4. 数据模型

### 4.1 `users` 增列

```sql
ALTER TABLE users ADD COLUMN last_seen_at TEXT; -- ISO；登录/WS 连接时刷新
```

### 4.2 新表 `team_activities`

```sql
CREATE TABLE IF NOT EXISTS team_activities (
  id          TEXT PRIMARY KEY,
  actor_id    TEXT NOT NULL,
  kind        TEXT NOT NULL,          -- task | agent | staff | agenda | join
  title       TEXT NOT NULL,
  detail      TEXT,
  status      TEXT,
  source_id   TEXT NOT NULL,          -- 客户端确定性幂等键
  occurred_at TEXT NOT NULL,          -- ISO，事件发生时间
  created_at  TEXT NOT NULL,          -- ISO，服务端入库时间
  UNIQUE (actor_id, source_id)
);
CREATE INDEX IF NOT EXISTS idx_team_activities_at
  ON team_activities(occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_team_activities_actor
  ON team_activities(actor_id, occurred_at DESC);
```

`source_id` 由客户端生成，保证重复同步不重复入库：

- 任务：`task:<taskId>:<updatedAt>`
- 日程：`agenda:<agendaId>:<dueTs>:<bucket>`
- 成员加入：`join:<userId>`（服务端可选自动写一条，首版不做）

### 4.3 保留但停用的旧表

`friend_requests`、`conversation_members`、`messages`、`message_reads`、`conversation_agents`、`e2e_keys`、`shared_files` 表**不删**：AI 对话仍用 `messages` / `e2e_keys` / `shared_files`；好友关系是通讯录历史，未经用户确认不自动清空。人类会话数据通过独立迁移脚本按需清理（§10）。

## 5. API

全部要求 `Authorization: Bearer <token>`。

### 5.1 团队名册

`GET /api/team`

```json
{
  "members": [
    { "user": { "id": "...", "username": "...", "displayName": "...", "avatar": "..." },
      "lastSeenAt": "2026-11-02T09:00:00.000Z", "online": true }
  ],
  "onlineCount": 1
}
```

- 成员 = 全部用户，按「在线 → 最近活跃 → 显示名」排序。
- `online` 来自进程内在线登记（§6），不落库。

### 5.2 动向流

`GET /api/team/activities?limit=50&before=<ISO>&actorId=<id>`

```json
{ "activities": [
  { "id": "...", "actorId": "...", "kind": "task", "title": "整理班级名单",
    "detail": "任务 · 已完成", "status": "done",
    "occurredAt": "2026-11-02T08:30:00.000Z", "createdAt": "..." }
] }
```

- 默认 50 条，上限 100；`before` 按 `occurred_at` 倒序翻页。
- 单团队，登录即可读全部；不按好友过滤。

`POST /api/team/activities`

```json
{ "items": [
  { "kind": "task", "title": "整理班级名单", "status": "done",
    "sourceId": "task:t1:1760000000000", "occurredAt": "2026-11-02T08:30:00.000Z" }
] }
```

- 单次最多 50 条；`(actor_id, source_id)` 冲突时幂等跳过。
- 服务端只接受摘要字段，不提供正文/附件/提示词字段；超长截断或 400。
- 返回 `{ "inserted": n, "skipped": n }`。

`DELETE /api/team/activities/mine`

- 清空**本人**已上传的动向；用于关闭共享后的撤回。返回 204。

### 5.3 会话接口收敛

- `POST /api/conversations` 只接受 `{ agentId }`；`peerId` / `memberIds` 分支删除。
- `GET /api/conversations` 只返回 `type: "agent"`。
- 删除：归档、成员、已读、好友、语音、ICE、preset 相关接口。
- 保留：消息历史、E2E 公钥、重加密、文件、agents CRUD。

## 6. 在线状态

新增服务端模块 `presence.ts`（进程内 Map<userId, socket 数>）：

- WS 鉴权成功后 `presence.online(userId)`，连接关闭且该用户最后一个 socket 断开时 `presence.offline(userId)`。
- 连接/关闭时 `store.touchUser(userId)` 写 `last_seen_at`。
- `GET /api/team` 读取 `presence.isOnline(id)`。
- 前端每 20 秒轮询一次，窗口获得焦点时立即刷新。在线状态允许 ~20 秒延迟，不引入新的 WS 广播契约。
- 进程重启后在线集合清空，`last_seen_at` 仍可展示「最近活跃」。

## 7. 共享与隐私

本机设置键 `heming.team.share.v1`：

```ts
{ tasks: boolean; agenda: boolean; lastSyncAt: number | null }
```

- **默认全部关闭**。团队页顶部横幅说明「开启后团队成员可见你的任务与日程摘要（不含对话内容与智能体轨迹）」。
- 每类来源独立开关；关闭后停止上传，已上传条目可通过「清除我的共享记录」删除。
- 上传内容白名单：
  - 任务：标题、状态、更新时间；不含 prompt、结果、工具参数。
  - 日程：标题、到期时间、临期档位（逾期/今天/24 小时内）；不含归档会话名、发送人。
- 同步时机：团队页挂载、60 秒定时、窗口聚焦、任务/日程变化后的下一轮。按 `sourceId` 幂等。
- 上传失败静默重试，不阻塞页面；失败原因只在共享设置里展示一次。

## 8. UI 与导航

导航（默认顺序）：

`主页 → 团队 → 智能体 → 幕僚 → 信息中枢 → 自动化 → 工作区 → 任务区 → 技能区 → 插件区 → 接口区 → 记忆区 → 归档 → 设置区`

- 删除「会话」页；`chat` 从导航页改为「智能体」页（仍不占数字键，沿用旧逻辑）。
- Alt+数字键保持旧页绑定：原「会话」的 Alt+9 取消，其余不变。

### 团队页

- 顶部：在线人数、今日动向数、共享开关状态。
- 左栏：成员名册（搜索、在线筛选、头像/显示名/最近活跃）。
- 右栏：动向流（全部 / 任务 / 日程 筛选；按时间倒序；分页「加载更早」）；只渲染真实成员的 `task` / `agenda`，智能体侧旧数据不露出。
- 成员详情：头像、用户名、显示名、在线/最近活跃、该成员最近动向。
- 空态：名册为空时说明「还没有其他成员」；动向为空时说明如何开启共享。

### 智能体页

- 左栏：智能体列表（系统智能体在前，自建在后；新建/编辑/删除入口），标题带「本机」标记。
- 右栏：与选中智能体的对话（复用裁剪后的 ChatPage）。
- 没有会话时不渲染 ChatPage，给「选择一个智能体开始」空态；文案明确本机运行与团队边界。

### 其他页面

- 主页：删除「最近会话」，新增「团队动向」卡（在线人数 + 最近 3 条）。
- 命令面板：删除会话搜索，新增成员搜索（跳团队并选中成员）。
- 任务区：仍嵌入 ChatPage，但会话只能是 agent 会话。
- 通知中心：删除 `message` 类型；`approval` 跳转到对应智能体会话；`task` / `staff` 不变。
- 工作区：删除联系人雷达/详情；保留文件目录与「绑定到智能体对话」。

## 9. ChatPage 裁剪

保留：消息列表、流式气泡、E2E 封发/解密、附件上传下载、文档解析、图表、HITL 审批、记忆/技能/工具、任务草稿、导出、会话内搜索、草稿。

删除：群成员快照与 @ 选择器、群信息卡、语音/通话、typing、已读、撤回、转发、表情回应、未读上报、联系人浮层、会话标签/缩略列。

服务端 WS 只保留 `auth` / `send_message` / `agent_chunk` / `agent_finish` / `agent_error`；`agent_finish` 的 agent 归属判断改为「agent 会话的 agentPeerId」或群挂载（群已删除，只看前者）。

## 10. 迁移与回滚

**代码不自动删数据。** 新增 `scripts/purge-im-data.mjs`：

```bash
node scripts/purge-im-data.mjs --db <path>          # dry-run：打印将删除的行数
node scripts/purge-im-data.mjs --db <path> --yes    # 执行（需先备份 heming.db）
```

删除范围：

- `conversations` 中 `kind != 'agent'` 的行；
- 上述会话对应的 `messages`、`conversation_members`、`message_reads`、`conversation_agents`；
- 预设群相关行；
- 不删 `users`、`friend_requests`、`agents`、`e2e_keys`、`shared_files`。

回滚：代码回退到上一版本即可恢复人类 IM；被脚本清掉的消息需从备份恢复。部署前必须先备份 `/var/lib/heming/heming.db`。

## 11. 实施顺序与验收

1. **R1 服务端**：team 表/接口、presence、会话收敛、WS 收敛、双实现与测试。
2. **R2 Web 团队**：团队页、共享同步、主页/导航/命令面板、通知。
3. **R3 智能体**：智能体页、ChatPage 裁剪、删除人类 IM 组件与 lib。
4. **R4 桌面与收尾**：通话窗/消息通知/桌宠未读删除、迁移脚本、文档、构建与浏览器实测。

验收：

- 登录后无任何人类私聊/群聊入口；直接请求旧接口返回 404/400。
- 与系统智能体对话可正常流式、E2E、附件、HITL、任务、记忆。
- 团队页能看到全部用户、在线状态、最近活跃、动向流；开关关闭时不上传。
- 开启任务/日程共享后，另一账号能在 60 秒内看到摘要；动态中无对话正文。
- 桌面端不再有通话窗与消息通知；通知点击落到智能体/团队。
- `pnpm -r build`、`pnpm -r test`、`pnpm -r typecheck` 通过。
