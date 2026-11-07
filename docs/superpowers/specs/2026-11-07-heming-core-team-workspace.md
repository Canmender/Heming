# 团队工作台：用户自建团队 + 目标/方案/任务 + 智能体接口（d.92 后一轮，版本待定）

- 日期：2026-11-07
- 分支：`feat/d77-heming-core`
- 用户指令：「先做团队功能，可以用户自己创设团队，设定团队名字，确立团队目标，规划方案，派发任务，上传任务，并且都预留接口，便于智能体操作」
- 说明：本批与并行会话（magpie 桌面组件 / 模型层）同工作区，提交时只暂存本批文件；版本号等并行提交落地后再定（避免抢号）

## 1. 两层「团队」的边界

| 层 | 名称 | 内容 | 可见性 |
|---|---|---|---|
| 既有 | 全站名册 / 动向 | 所有注册用户、任务与日程摘要、在线与用量 | 全员可见 |
| 本批 | **团队工作台** | 用户自建的工作组：名字 / 目标 / 方案 / 任务 / 成员 | 仅成员可见 |

两者不合并：全站层是「公司通讯录」，工作台是「项目小组」。侧栏「我的团队」只列我加入的团队；
进入团队后是独立工作区（目标、方案、任务），不混入全站动向。

## 2. 数据模型（shared 契约 + 服务端）

- `WorkspaceTeam`：id / name / goal / ownerId / createdAt / updatedAt
- `TeamWorkspaceMember`：user + role(owner|member) + joinedAt
- `TeamPlanItem`：id / teamId / title / detail / status(todo|doing|done|blocked) / orderIndex
- `TeamTask`：id / teamId / planId? / title / detail / assigneeId? / status / dueAt? / **attachmentFileId?**
- `TeamWorkspaceSnapshot`：team + members + plans + tasks
- 4 张表：`teams / team_members / team_plans / team_tasks`（幂等建表；无外键，级联在 Store 里显式做，
  保证内存与 SQLite 两实现同语义）

关键语义：
- **非成员一律 404「团队不存在」**（与真不存在同响应体，不泄露存在性）；成员非 owner 做 owner-only 动作 → 403；
- 任务指派必须是团队成员；`planId` 必须属于该团队；移除成员自动把任务解绑为「待认领」；
- 删方案不删任务（任务解绑为独立任务）；删团队级联清成员/方案/任务；
- 团队任何动静刷新 `updated_at`，列表按它倒序。

## 3. REST（13 条，智能体与 UI 共用唯一写入口）

```
GET    /api/teams                         我的团队
POST   /api/teams                         建团队（201）
GET    /api/teams/:id                     快照（成员）
PATCH  /api/teams/:id                     改名/改目标（owner）
DELETE /api/teams/:id                     删团队（owner，级联）
POST   /api/teams/:id/members             按用户名加成员（owner）
DELETE /api/teams/:id/members/:userId     移成员（owner，不能移 owner）
POST   /api/teams/:id/plans               加方案（成员）
PATCH  /api/teams/:id/plans/:planId       改方案（成员）
DELETE /api/teams/:id/plans/:planId       删方案（成员）
POST   /api/teams/:id/tasks               派任务（成员；assignee/plan 校验）
PATCH  /api/teams/:id/tasks/:taskId       改任务（状态/负责人/交付物…）
DELETE /api/teams/:id/tasks/:taskId       删任务
```

错误体统一 `{error: "<中文原因>"}`；权限判定只在服务端一处。

## 4. UI（团队页新增第一个 Tab「工作台」）

- 左栏「我的团队」：列表 + 新建（名称 + 目标）；选中团队落 sessionStorage，刷新/切页不丢。
- 右栏：团队概况（名字、目标编辑、成员 chips、加成员/移成员、删除团队）→ 方案（添加/点状态流转/删除）
  → 任务（未完成/全部/已完成筛选、派任务：标题/说明/负责人/归属方案/截止/上传交付物、点状态流转、
  改负责人、删除）。
- **上传任务**复用共享文件库：`uploadFile()` 上传后把 fileId 记在任务 `attachmentFileId` 上，
  不新增第二套文件存储/配额。
- 非 owner 不渲染删除团队/加成员/移成员入口（服务端仍兜底 403）。

## 5. 智能体接口（「预留接口，便于智能体操作」落地）

新增能力提供者 `teamProvider`（始终注入，不依赖桌面桥/模块开关），9 个工具：

| 工具 | 风险 | 作用 |
|---|---|---|
| `team_list` | read | 我的团队（id/名字/目标/成员数/任务数） |
| `team_get` | read | 按 id 或名字取快照（目标/方案/任务/成员） |
| `team_create` | write | 建团队 |
| `team_update` | write | 改名/改目标 |
| `team_member_add` | write | 按用户名加成员 |
| `team_plan_add` | write | 加方案 |
| `team_plan_update` | write | 改方案（状态/标题/说明/排序） |
| `team_task_add` | write | 派任务（含 assignee/plan/dueAt） |
| `team_task_update` | write | 改任务（状态/负责人/交付物等） |

- 写工具走 HITL（沿用既有闸门），读工具不打断；
- 描述写明「用户自建团队工作台、不是全站动向、未知 id 先 `team_list`、assignee 必须是成员」；
- 服务端中文错误原样回给模型；尊重 abort signal（中断即不发请求）。
- **删除类不开放给智能体**（模型误删团队代价太大）；需要时单独评审。

## 6. 验证

- 服务端：`shared build` + server test **12 文件 / 165 例**（storeContract 双 Store + teamWorkspace 9 例），
  typecheck 绿；真实 8787 冒烟建团队→方案→任务→权限→删除。
- Web：`teamTools.test` 20 例 + `api.test` 新增 6 组；`TeamWorkspace.test` 5 例
  （建团队/目标/方案状态/任务创建与负责人/成员权限可见性）。
- 真机（1600×1000，0 error）：团队页出现「工作台」Tab → 新建「验证小组」并写目标 → 加 alice →
  加方案「先把任务派出去」→ 派任务「产出第一版周报」并指派 → 任务行显示负责人；
  插件区「工具」Tab 可检索到 `team_list / team_task_add / team_plan_update`；用 API 删团队 204 清理。
  截图 `.tmp/d82/team-workspace-state.png`、`team-tools-catalog.png`。

## 7. 本轮明确不做

- 邀请链接/公开注册（账号仍由管理员在服务端创建，沿用既有边界）；
- 任务评论、@ 提醒、变更历史；
- 方案层级（父子方案）与任务看板拖拽；
- 交付物在线预览（共享文件预览已有，但任务行不做内嵌）；
- 给智能体的删除类工具。
