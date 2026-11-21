# 和鸣「团队协作」功能调研与完善方案

- 日期：2026-11-20
- 状态：调研 + 方案（供评审）；**部分增量已实施并通过测试**，见下方「实施进度」——社交化加入（1.4）、状态机收紧（1.3）、真任务看板（1.2，含按方案/逾期筛选）、催办/进展入口（1.5 部分）、动态搜索/加载更早（痛点 8）、方案进度汇总（痛点 7）、周报可选时间窗（痛点 10 部分）、删团队/任务清孤儿（痛点 16）、名册「管理成员」入口（痛点 9 部分 / 1.1）、工作台事件时间线改名「任务流水」与团队页「动向」消歧（痛点 3 部分 / 1.1）、命令面板搜技能定位到具体技能（痛点 11）、看板点卡片只读详情 + 「到工作台处理」跳转（1.2 收尾）、首页团队卡「任务看板」直达入口（1.2 入口建议）、卡片所属方案标签与切队筛选/详情重置（1.2 验收）已落地，共 20 项低风险增量，全程全量测试全绿。剩余 1.5 的 @通知 / 任务↔会话深链、周报历史留档、模型页简化大 IA 重构需用户拍板/评审或涉及服务端改动（与并行会话重叠），未实施。
- **2026-11-21 更新（团队页重做，d.413）**：按用户要求，团队页只保留**团队列表 / 看板 / 动向**三个页签；「团队日程」「用量」页签及其状态/同步/清除逻辑全部删除，团队页不再与信息中枢插件产生任何关联。原「工作台」内容沿用，标签改为「团队列表」（内部 key `workspace` 保留）；命令面板团队入口同步精简。下方「实施进度」保留当时的历史记录，其中「到工作台处理 / 到工作台管理成员」等用户可见文案现已改为「到团队列表处理 / 到团队列表管理成员」；本文描述当前 UI 的章节按三页签口径更新。
- 范围：云端团队系统（真人团队：名册 / 任务 / 方案 / 讨论 / 验收 / 动向 / 日程 / 周报 / 用量，以及智能体 `team_*` 工具）
- 方法：以当前 main HEAD 代码（`package.json` = `d.412.4.147.14`）与设计/审计文档为事实来源，并行做前端现状、后端与工具、业界对标三路调研；所有结论均标注路径或外部来源。

---

## 实施进度（2026-11-20 晚）
- **1.4 团队创建与加入（社交化加入）已实施并通过测试**（全栈，纯增量）：
  - 数据层：`team_join_requests` 表（无 UNIQUE，被拒可重申请，重复 pending 由 Store 查重）+ `shared/schemas.ts` 7 个 schema/类型 + `TeamEventKind` 新增 `join_requested/join_approved/join_rejected`（`server/db.ts`、`shared/src/schemas.ts`）。
  - 服务层：`Store` 接口 + 内存/`sqliteStore` 双实现 6 方法（目录发现 / 申请 / 我的申请 / 队长待审列表 / 审批；审批幂等写成员行）；`app.ts` 新增 6 条 REST（`/api/teams/discover`、`/api/teams/join-requests/mine`、`/api/teams/:id/join-requests*`）。**注意**：`discover` / `mine` 必须注册在 `/api/teams/:id` 之前，否则被通配吞掉。
  - 前端：`lib/api.ts` 6 个封装；`TeamWorkspace.tsx` 左栏「找团队」入口 + 发现弹窗（搜索/附言申请/我的申请进度）+ 队长成员区的「待审加入申请」通过/拒绝；`TeamActivityPanel.tsx` 与 `teamTools.ts` 的事件标签映射补齐 3 个 kind。
  - 验证：`shared build` + `server typecheck` + `web tsc --noEmit` 全 EXIT=0；server 全量 486/486，`TeamWorkspace.test.tsx` 52/52（含 3 个新用例），activity/capability 82/82。
  - 与原方案的差异：申请表**不建 UNIQUE(team_id,user_id)**（原方案写"UNIQUE 防重复"），改为 Store 显式查重以支持被拒后重新申请；其余按方案落地。
- **1.3 状态机收紧（防绕过验收）已实施并通过测试**：服务端 Store 双实现（内存/`sqliteStore`）在 `updateTeamTask` 增加 `done_locked` 拦截——已完成任务裸改 `status:"todo"`（胶囊循环的 done→todo，会抹掉完成/验收痕迹且不写原因）被拒；**`done→doing`（本人重开继续做、保留结论，d.252 既有行为）仍允许**，`review:"changes"`（组长打回、带原因）也不受限；`app.ts` 返回 409 中文解释；前端 `TeamTaskPanel.tsx` 的 `cycle()` 对 done 直接拒绝并提示走「打回重做」，胶囊 title 同步说明。重开正道=组长 `review:"changes"`（必须写原因，回到 doing）。验证：`shared build` + `server/web typecheck` EXIT=0；server 全量 489/489（含 3 新用例：双实现各 1 + REST 1；首轮 Windows worker 0xC0000409 抖动，复跑消失），web team 组件 94/94。
  - 与原方案的差异：未新增 `reviewerId` 字段（验收仍限组长，保持既有 d.272 口径，避免扩大服务端 schema 改动面）；未做显式「重新打开」按钮，统一收敛到打回重做这条有原因留痕的路径。
- **1.2 真任务看板已实施并通过测试**（前端增量）：新增 `packages/web/src/components/team/TeamTaskBoard.tsx`，`TeamPage.tsx` 的「看板」Tab 从 `TeamBoardView`（读 `team_activities` 摘要、只能看不能动）换成真任务板——读 `fetchWorkspaceTeam(teamId).tasks`（与工作台同源），按状态分五列（待开始 / 进行中 / 有卡点 / 待验收 / 已完成），卡片显示负责人头像、优先级、逾期、前置卡点数；支持 HTML5 拖拽流转，统一走 `updateTeamTask` 与工作台同一接口。关键护栏：拖到「待验收」写 `status:done`（不直接完成，验收仍由组长做）、「已完成」列不可拖入、已交/已完成任务不可拖回待认领（复用 1.3 状态机 + 解释文案）、非组长不能拖别人的任务；筛选=按负责人 / 优先级 / 标题搜索 / 按方案（含「独立任务」）/ 只看逾期；团队切换沿用页头 `useSelectedTeamId`（m00211），切队后 `activeTeamId` 变化自动重载该队任务，并清空筛选条件、关闭打开的详情（§5.3 1.2 验收，筛选不串队）。旧 `TeamBoardView` 文件保留但不再挂载。验证：`TeamTaskBoard.test.tsx` 13/13（含拖拽流转、待验收、两条护栏、权限、按方案筛选、只看逾期、卡片显示所属方案、点卡片只读详情、到工作台处理落点〔2026-11-21 起为「到团队列表处理」〕、未传回调不显示该按钮、切队重置），`TeamPage.test.tsx` 看板用例改为读真任务；`web tsc --noEmit` EXIT=0（此前并行会话的 `httpClient.test.ts` TS2739 已被对方自行修复，本会话未触碰）；web 全量 473 文件 / 6846 测试全过（含并行会话新增用例）。
  - 与原方案的差异：点卡片进详情已用「只读详情 Dialog（与看板同源、不发新请求）」补齐；与**会话**的深链编辑（跳到会话继续做）仍未做，转入 1.5 阶段（需服务端字段、碰隐私边界）；按方案 / 逾期筛选已在后续增量补上（见下）。
- **首页团队卡「任务看板」直达入口已实施并通过测试**（纯前端增量，1.2 入口建议）：`home/TeamActivityCard.tsx` 头部在「进入团队」前加 `ui-link`「任务看板」（新 prop `onOpenBoard`），`HomePage.tsx` 传 `onOpenBoard={() => setPage("team","board")}`——用户从首页一步直达真任务看板，不必先进 feed 再找 Tab。验证：`HomePage.test.tsx` 36/36（+1：点「任务看板」→ team 页、pageView=board）；web 全量 471 文件 / 6830 测试全过（期间并行会话也新增了几条用例）。
- **1.5 催办/写进展入口已实施并通过测试**（前端增量）：后端 `nudge` / `progress` 早已存在于 `store.ts`（d.262/d.265，催办只记次数不动状态、写进展覆盖式一条），但此前界面只能看痕迹、无入口。本次在 `TeamTaskPanel.tsx` 任务行加两个按钮：①「催一下」仅组长可见、且仅对别人名下未完成的任务出现，走 `updateTeamTask(teamId,id,{nudge:true})`；②「写进展」对本人/组长、未完成任务出现，展开 textarea（maxLength 500）→ 走 `{progress:note}`，空串拒绝并提示。新增 4 用例（催一下发 nudge、非组长无按钮、写进展发 progress、空内容不发请求）。验证：`web tsc --noEmit` EXIT=0；`TeamWorkspace.test.tsx` 56/56（原 52+4）；web 全量 471 文件 / 6809 测试全过。
  - 与原方案的差异：1.5 原方案的 @提及通知与「在会话中打开」深链**未做**——@通知需改服务端通知通道与 mentionedIds（与并行会话的 app.ts/store.ts 高度重叠），深链需解决服务端不存正文的隐私边界；本次只落地了不需服务端改动的催办/进展按钮（原本方案里"催一下/更新进展按钮可用且写入事件流水"的验收项）。
- **痛点 8（团队动态无加载更早/无搜索）已实施并通过测试**（纯前端增量）：`TeamActivityPanel.tsx` 加关键词搜索框（按摘要 / 任务标题 / 类型标签 / 操作人过滤）、「加载更早」按钮逐档把 `fetchTeamEvents` 的 limit 从 20 加到 40/60/…/100（API 本就支持 limit≤100，无需服务端改动）、无匹配提示；切团队/展开逻辑不变。验证：`web tsc --noEmit` EXIT=0；`TeamWorkspace.test.tsx` 58/58（+2：搜索过滤、加载更早把 limit 从 20 提到 40）；web 全量 471 文件 / 6813 测试全过。
  - 与原方案的差异：用「逐档提高 limit 重拉」代替游标分页（服务端事件接口无 cursor），对中等规模团队足够；超大团队以后可加 cursor。
- **痛点 7（方案→任务无进度汇总）已实施并通过测试**（纯前端增量）：`TeamPlanPanel.tsx` 新接 `tasks` prop（按 `planId` 关联），每张方案卡显示「X/Y 任务完成」+ 迷你进度条 + 逾期数；`TeamWorkspace.tsx` 传 `snapshot.tasks`。验证：`web tsc --noEmit` EXIT=0；`TeamWorkspace.test.tsx` 59/59（+1：完成数/逾期数/进度条）；web 全量 471 文件 / 6814 测试全过。未做里程碑/甘特/依赖图可视化（保持轻量，读快照即可）。
- **痛点 16（P2：删除团队/任务遗留孤儿数据）已修复并通过测试**（服务端增量）：`store.ts`（内存）与 `sqliteStore.ts` 的 `deleteWorkspaceTeam` 级联增加 `team_task_comments`（按团队）与 `team_events` 清理；`deleteTeamTask` 同步清掉该任务的讨论留言（内存按 taskId 删 Map 项、sqlite 按 task_id DELETE）。验证：server typecheck EXIT=0；`storeContract.test.ts` 110/110（+1 用例×双实现：删任务清讨论但不误伤别的任务、删团队清剩余讨论与动态）；server 全量 20 文件 / 492 测试全过。
- **痛点 3（两套"动态"混名）部分修复：工作台事件时间线改名「任务流水」**（纯文案增量）：`TeamActivityPanel.tsx` 的可见标题/aria-label 从「团队动态」改为「任务流水」，副标题点明"本工作组"；团队页 feed 仍叫「动向」（共享摘要），命令面板 `团队 › 动向` 描述改为「同队成员共享的任务与日程摘要流」。智能体工具/prompt 里的「团队动态」是给模型看的口径，受众不同、未改（避免提示词回归）。验证：`web tsc --noEmit` EXIT=0；TeamWorkspace/TeamPage/CommandPalette 定向 133/133。注：这是名词消歧的一部分，数据源/口径差异仍未合并（需服务端）。
- **痛点 9（两名册割裂）部分修复：名册「管理成员」入口**（纯前端增量）：`TeamPage.tsx` 名册搜索/筛选行加 `ui-link`「管理成员」按钮（title 原为「到工作台管理成员、派任务」，2026-11-21 起为「到团队列表管理成员、派任务」），点击 `setTab("workspace")` 一步切到团队列表（原工作台）——用户不再对着只读名册找不到"怎么加人/派活"。验证：`web tsc --noEmit` EXIT=0；`TeamPage.test.tsx` 34/34（+1：入口存在且点击切到工作台、切走后入口消失）。
- **痛点 10（周报静态且入口深）部分修复：周报可选时间窗**（纯前端增量）：`TeamWorkspace.tsx` 周报弹窗加「回看天数」选择（最近 7 / 14 / 30 天），切换即重算成稿，复制/导出都跟着用同一份新文本；纯函数 `weeklyReportMarkdown` 本就支持 `options.days`（1–30，默认 7），只补 UI，不改服务端。验证：`web tsc --noEmit` EXIT=0；`TeamWorkspace.test.tsx` 60/60（+1：切到 30 天显示「（30 天）」且复制走新文本），`weeklyReport.test.ts` 14/14；web 全量 471 文件 / 6822 测试全过。未做历史留档 / 周期性自动生成 / 与日程动态合并的汇报视图（这些需服务端存储，与并行会话重叠）。
- **痛点 11（P2：命令面板搜技能不定位具体技能）已修复**（纯前端增量）：`CommandPalette.tsx` 的 `case "skill"` 从只 `setPage("skills")` 改为解析本地技能结果 id（`skill:<id>`）投 `focus-skill` 意图，技能区（`SkillsPage.tsx:571-577` 已有消费逻辑）挂载后定位并打开该技能详情；与插件命令 target=skill 走同一落点（`runPluginCommandTarget`），无新机制、不改意图槽。验证：`web tsc --noEmit` EXIT=0；`CommandPalette.pluginCommands.test.tsx` 14/14（+1：本地技能结果投 focus-skill + 落到插件区技能视图）、SkillsPage/CommandPalette 定向 65/65。
- 其余阶段（1.5 的 @通知/会话深链 / 周报历史留档 / Phase 2-3）尚未实施，仍为方案状态。

## 摘要（TL;DR）

和鸣的团队系统**不是空白**，而是已经有一个相当完整的核心：SQLite 服务端有 9 张团队相关表与约 40 条 REST 路由，前端有团队列表（原「工作台」）+ 三页签团队页（团队列表 / 看板 / 动向，2026-11-21 重做），智能体有 19 个 `team_*` 工具，任务状态机含优先级 / 前置依赖 / 催办 / 验收 / 讨论 / 交付物，周报可一键成稿导出。**真正的问题是"割裂"与"看不见"**：

1. **两层语义割裂**：同队成员摘要（"团队页"）与用户自建工作组（"工作台"）是两套 UI、两名册、两套"动态"，共用同一个切换器却互不相认。产品决策已明确为**无上限多团队、彼此独立、一人可加入多团队、看板按团队切换**（m00211）——**部分兑现（见「实施进度」）**：社交化加入已落地（多团队隔离、一人多队、看板切队），但两层 UI/两名册的语义融合仍未完成。
2. **协作闭环断裂**：任务与会话不互通（讨论只是文字留言，"对方的智能体下一轮能看到"），无 @ / 通知 / 深链；状态机可被点胶囊绕过验收。—— **部分修复（见「实施进度」）**：团队搜索/申请加入/队长审批已落地（社交化加入体验已具备）；状态机绕过已堵；任务↔会话深链与 @通知仍未做。
3. **AI 原生优势未兑现**：业界已把 Agent 做成"有身份、有权限、可被 @ 的团队成员"，并做会话→知识沉淀、自动周报/分诊、后台异步；和鸣的智能体仍藏在会话页，团队里看不见、委派不到。**但按用户约束（m00272），智能体归用户本地私有、用用户自己的 API，明确不做 Agent 成员化**——只借鉴委派/审计机制，走"本机执行 + 人审核回填团队"路线。
4. **隐私口径粗粒度且易误解**：加入团队即默认全共享（无逐类开关），清除不可逆；设计文档写的是"默认全关可关"，代码走的是"d.153 默认全共享"，文档与实现不一致。

建议按三阶段推进：**Phase 1 补基础闭环**（统一两层语义、看板正名、状态机收紧、团队创建/搜索/审批、通知与任务↔会话深链）→ **Phase 2 做 AI 原生增强**（本机智能体协作〔非成员化〕、个人/团队知识库、会话沉淀团队知识、自动周报/分诊）→ **Phase 3 建差异化壁垒**（后台异步调度、多智能体编排、人在回路审计）。每阶段都给出可测验收标准与工作量估算。

---

## 一、调研背景、目标与范围

### 1.1 起因
用户（m00001）："我们来调研一下关于团队协作功能。这个是和鸣的重点部分，但是当前做的并不突出，所以我们需要一个详细方案去完善这个部分。"

二次澄清（m00099）："是关于团队的部分，调研市面上关于团队合作是怎么做的，当前功能差距，当前需要改进部分。成文档，先不要做。"

因此本轮交付物是**调研与方案文档**，不含代码实现；范围锁定**真人团队云协作**，不含已删除的多智能体"协作页"。

### 1.2 一个需要先澄清的历史事实
用户最初提到的"协作页 Alt+5（顺序/主管/辩论）"在**当前 main HEAD 已被删除**：

- 删除提交 `f2eaa37a`"删接入式协作页，派活就在对话里"（CHANGELOG 称 d.409，见 `CHANGELOG.md:199-229`），一次删 2487 行。
- 该页实为 magpie 检测本机 Claude Code / Codex 的**接入式辩论页**，模式文案是"流水线 / 协调者-工作者 / 评审团"，并非真人团队协作。
- `packages/web/src/App.tsx:116-131` 的 `SHORTCUT_PAGES` 只剩 `1 home / 2 team / 6 settings / 8 chat / 0 plugins`，"5"刻意留空，注释："空着比让人重新记'5 现在是什么'更省心"。
- `packages/web/src/store/ui.ts:32-37` 的 `Page` 类型仍保留 `"collab"` 字符串，仅为解析存量会话视图；`heming.collab.last.v1` 只存在于已删除的历史文件。

**结论**：本文讨论的"团队协作"= 真人团队系统；子智能体派发在会话页（`agent_task` / `agent_team` / `workflow_run`），与服务端团队系统目前**零关联**——这既是现状，也是 Phase 2 的机会点。

---

## 二、现状盘点

### 2.1 总体架构：两层语义

`packages/web/src/components/team/TeamWorkspace.tsx:30-36` 的注释明说系统有两层：

| 层 | 名称 | 数据 | 入口 | 可见性 |
|---|---|---|---|---|
| A | **同队成员摘要**（"团队页"） | `users` + `team_activities` + `team_usage` + `team_members`（全站同队） | TeamPage 的「动向」页签、首页团队卡（`team_usage` 仅作服务端数据/首页用例，团队页不再有「用量」「团队日程」页签，也不再接信息中枢） | 自己 + 至少同属一个团队的成员（不带 teamId 的旧口径会跨团队看到同名册） |
| B | **用户自建工作组**（原"工作台"，现「团队列表」） | `teams` / `team_members` / `team_plans` / `team_tasks` / `team_task_comments` / `team_events` | TeamPage 的「团队列表」（内部 key 仍为 `workspace`）与「看板」页签 | 仅团队成员；非成员一律 404，owner-only 动作非 owner 403 |

两者**共用团队切换器**（`lib/team/selection.ts`），但在 UI 上是割裂的两处，名词都叫"团队动态"却数据不同、口径不同。

### 2.2 服务端：数据模型与 API

**数据模型**（`packages/server/src/db.ts` initSchema，SQLite + node:sqlite + WAL，建表无外键、级联在 Store 事务显式做）：

- 全站层：`users`（`last_seen_at`）、`sessions`（token 只存 SHA-256）、`team_activities`（`UNIQUE(actor_id, source_id)` 幂等，绝不存正文/提示词/工具参数）、`team_usage`（tokens 可为 NULL=未上报）、`team_activity_clears` / `team_usage_clears`（清除水位，防旧数据重传）、`shared_files`。
- 工作组层：`teams`、`team_members`（role owner/member）、`team_plans`、`team_tasks`（核心，含 status/priority/assignee/due/result/blocker/nudge/review/progress 等 20+ 字段）、`team_task_comments`、`team_events`（事件流水，只存"谁做了什么"一句摘要）。
- 状态机：`todo → doing → done/blocked`；优先级 low/normal/high；逾期 = 未完成且 dueAt 已过；`blockedBy` 只作协作信号、不硬阻断（`validateBlockers` 只校验同团队/非自身/无环，见 `sqliteStore.ts:411`）。
- 口径实现：`packages/server/src/teamCounts.ts summarizeTeamTasks()` 与 `packages/web/src/lib/team/teamSummary.ts`（后者多算 pendingReview）。

**API**（`packages/server/src/app.ts`，全部 authOnly，约 40 条）：

- 全站：`GET /api/team`（名册）、`GET/POST /api/team/activities`、`DELETE /api/team/activities/mine`（白名单校验，60s≤120 次、存量≤500，超限 429）、`GET/POST /api/team/usage`、`DELETE /api/team/usage/mine`、`GET /api/team/my-tasks`、`GET /api/team/my-teams`。
- 工作组：`/api/teams` CRUD、`/members`（按 username 加人/移除/离开/转让 owner）、`/plans` CRUD、`/tasks` CRUD + `comments` + `events`、`PATCH /tasks/:taskId` 含 nudge/review 子动作。
- **无周报 API**：周报是纯前端 `weeklyReport.ts` 生成。

### 2.3 前端：团队页与团队列表

**入口**：侧栏 `SidebarNav.tsx` NAV_ITEMS 四项（插件1/团队2/模型3/知识库4），团队=Alt+2；Ctrl/⌘+K 命令面板含团队二级页签 focus-tab 意图。

**TeamPage 三页签（2026-11-21 重做后）**（`TeamPage.tsx`，896 行；页签记忆键 `heming.tab.team.v1`，默认 feed；内部 key 仍为 `workspace/feed/board`）：

| 页签 | 内容 | 关键事实 |
|---|---|---|
| 团队列表 workspace（原「工作台」） | 见下 | `<TeamWorkspace>`，45s 静默轮询；建队、名册、方案与任务 |
| 动向 feed（默认） | 成员名册（搜索/仅在线）+ 摘要流（全部/任务/日程筛选 + 按人筛选） | 左栏 20s 轮询（`ROSTER_POLL_MS`）、右栏 60s（`FEED_POLL_MS`）、limit=50 游标分页 |
| 看板 board | 真任务板，按状态分列、可拖拽流转 | `<TeamTaskBoard>` 读 `team_tasks`；详见「实施进度」1.2；详情按钮落点为「到团队列表处理」 |

已删除：`团队日程 agenda`（含信息中枢空态引导与跳转）、`用量 usage`（我的用量/团队排行/清除）两个页签及其全部状态与同步逻辑；团队页与信息中枢插件不再有关联。命令面板团队入口同步只保留团队列表 / 看板 / 动向。

**TeamWorkspace（1255 行）**：左栏"我的团队"列表 + 新建；右栏团队概况（成员/方案/任务数、生成周报、删除团队）、目标编辑、成员 chips（转让/移除/退出）、按用户名加人，下方依次 TeamPlanPanel → TeamSchedulePanel → TeamTaskPanel → TeamActivityPanel。

**TeamTaskPanel（1232 行，最复杂）**：状态胶囊循环 `todo→doing→done→todo`、`blocked→doing`（**注意 `done→todo` 会绕过验收**）；验收态 pending/approved/changes（打回必须填原因、回到 doing）；讨论 = 文字留言（2000 字、Enter 发送）；历史 = `fetchTeamEvents(taskId)`；交付物走共享文件库。

**其余**：TeamPlanPanel（方案=标题+说明+状态+挂靠任务进度条，**不是文档编辑器**）、TeamSchedulePanel（只读、默认折叠、按到期日分档）、TeamActivityPanel（事件时间线、默认 20 条、折叠；**已补**：关键词搜索 +「加载更早」逐档提到上限 100，见「实施进度」痛点 8）。

**周报**（`lib/team/weeklyReport.ts`，294 行）：`weeklyReportMarkdown()` 纯函数成稿（概况→完成→进行中→需要关注（待验收排第一）→成员负荷→下周建议），复制/导出同一份文本；明确不做定时自动生成与模型润色。

### 2.4 智能体 `team_*` 工具

全部定义在 `packages/web/src/lib/capability/teamTools.ts`（**不在** agent-pipeline / desktop / plugin-kit），`TEAM_TOOLS` 共 19 个（测试 `teamTools.test.ts:144` 断言）：

- 读 7：`team_list`、`team_get`、`team_task_find`、`team_task_comments`、`team_task_history`、`team_events`、`team_digest`（**不存在 `team_report`**）。
- 写 10：`team_create`、`team_update`、`team_member_add`、`team_task_nudge`、`team_task_review`、`team_task_comment`、`team_plan_add/update`、`team_task_add`（一次派 2–8 件）、`team_task_update`。
- danger 2：`team_member_remove`、`team_owner_transfer`。删除团队/方案/任务不提供给智能体。
- Prompt 注入：`packages/web/src/lib/agentRuntime/runtimePrompt.ts:410-432`、`lib/team/teamBrief.ts:80-108`（问周报先调 `team_digest`）、`myTaskPrompt.ts`、`digest.ts`、`assignedTasks.ts`。

限制：快照 `SNAPSHOT_TASK_MAX=20` / `SNAPSHOT_DETAIL_MAX=200`，超过截断（这是 `team_task_find` / `team_digest` 存在的原因）；bridge `truncateToolResult` 8000 字符上限。

### 2.5 共享与隐私边界（重要纠偏）

**代码现状 ≠ 设计文档**：

- 设计文档 `docs/superpowers/specs/2026-11-02-team-system-design.md` §7 写的是"默认全部关闭 + 三类开关（tasks/agenda/usage）"；d.152（2026-11-15）改为"默认全开可关、同队可见"。
- **当前实现（d.153，团队页文案 2026-11-21 更新）**：`packages/web/src/lib/team/share.ts:48-56` 明确"共享没有逐类开关，加入团队即共享三类白名单摘要，没有逐类开关"。理由：开关制造假安全感（关掉只停未来上传，已上传的仍在），真正的撤回是"清除共享记录 / 清除我的用量"。团队页文案（重做后见 `TeamPage.tsx:497-521`）现只提两类："与同队成员共享任务 / 日程摘要……加入团队即共享这两类白名单摘要，没有逐类开关；已上传的内容不会随任何开关消失，需要手动清除。"——用量页签已删，团队页不再有「清除我的用量」入口（服务端 API 与首页口径仍保留）。
- 隐私边界靠**字段白名单**而非结构隔离：`task` 摘要 title 恒为占位"任务"（因本机标题源自提示词首行）、detail 为"任务·状态"；agenda 可上报真实标题与到期档位（存在间接泄露面）；用量只报模型名/tokens/未上报轮数/连接名。
- 本机 `localStorage` 只存水位与同步时间（`TEAM_SHARE_KEY='heming.team.share.v1'`，换账号用 `TEAM_SHARE_OWNER_KEY` 重置）。

### 2.6 已知技术债（后端调研）

1. 无共享开关（见 2.5）；2. 快照 20 条截断；3. 任务标题不上报导致动向可读性差（永远是"任务·状态"）；4. 在线状态纯内存、重启清零、无心跳超时踢除；5. 不带 teamId 的旧口径会跨团队看同名册；6. 删除团队时 `team_events` / `team_task_comments` 未级联删除，遗留孤儿数据（`sqliteStore.ts:1401-1409`）；7. 无实时推送，靠 45/60s 轮询 + focus 触发；8. 跨时区 UTC 日键 vs 本地日键口径不一。

---

## 三、业界调研

> 以下为外部公开资料（web_fetch 抓取官方页），仅作参考，附来源链接；抓取受限的（Genspark/Cursor/飞书/钉钉细节）不做具体论断。

### 3.1 主流协作工具的"人 + AI 队友"形态（2025–2026）

- **Linear — Artificial colleagues**：可构建/部署 AI agent 作为队友，端到端委派 issue；agent 出现在会话流中，issue 可"加入上下文"，能做风险分析、分类、从对话追到代码（[linear.app/agents](https://linear.app/agents)）。
- **Notion — 24/7 AI team**：Custom Agents 分 Q&A / Task routing（自动分诊路由）/ Status update（定时汇总周报）三类；每个 agent 像队友有独立 page-level ACL，可跨 Slack/Mail/Calendar/MCP，运行有审计日志、变更可撤销，支持 schedule 或事件触发（[notion.com/product/agents](https://www.notion.com/product/agents)）。
- **Slack — Multiplayer AI**：Slackbot 为全员 AI teammate，Today 晨报、频道/线程摘要、Enterprise Search；核心论述是"work is the conversation / conversation becomes knowledge"，agent 加入频道即继承上下文与权限（[slack.com/features/ai](https://slack.com/features/ai)）。
- **Asana — AI Teammates**：把 agent 定位为"for work"的团队成员（[asana.com/product/ai](https://asana.com/product/ai)）。

### 3.2 AI 原生协作产品

- **Devin**：Bots / Review / Stacked PRs，Playbooks（可复用流程）、Knowledge Notes（团队知识）、Automations + Schedules（定时自治），API 管理 sessions/knowledge/automations（[docs.devin.ai](https://docs.devin.ai/api-reference/overview)）。
- **Manus 2.0**：明确定位"team and agents collaborate together"，共享 project/task 供队友 review/接续，Shared skills 复用工作流，sub-agents 并行分治（[manus.im/team](https://manus.im/team)）。
- **Claude Cowork**：给目标而非步骤，跨文件工具工作，**后台定时运行**（"Claude works when you don't"），大项目自动拆块并行，内置浏览器，多端同步（[claude.com/product/cowork](https://claude.com/product/cowork)）。
- **ChatGPT Team**：自定义 GPT + 共享工作区（[openai.com](https://openai.com/index/introducing-chatgpt-team/)）。

### 3.3 多智能体编排模式（Anthropic 权威总结，[链接](https://www.anthropic.com/research/building-effective-agents)）

| 模式 | 机制 | 适用场景 |
|---|---|---|
| Prompt chaining | 固定子任务顺序流水线 | 以延迟换准确（大纲→校验→成文） |
| Routing | 分类输入分发专门处理 | 客服分流、难易分配 |
| Parallelization | Sectioning 并行 + Voting 投票 | 多视角高置信 |
| Orchestrator-workers | 中心 LLM 动态拆解/委派/综合 | 无法预知子任务的复杂任务 |
| Evaluator-optimizer | 生成 + 评估反馈迭代 | 有清晰标准的迭代改进 |
| Autonomous agent | 模型自决步骤与工具 | 开放式问题 |

原则：够用即可，仅在可测量提升时加复杂度；保持规划透明；精心设计与测试工具接口。

### 3.4 可借鉴能力清单（按价值排序）

| # | 能力 | 解决痛点 | 复杂度 | 和鸣现状关系 |
|---|---|---|---|---|
| 1 | 本机智能体协作（非成员化：协助标注 + HITL 回填） | AI 停留在私聊，团队不可见 | 中 | 已有 19 个 team_* 工具，缺"任务协助标注 + 会话↔任务深链"；**不做 Agent 成员身份（智能体归用户私有）** |
| 2 | 会话→团队知识沉淀（上下文+审计） | 上下文断裂、重复提问 | 中 | 会话式工作有基础，缺沉淀为可搜索共享知识 |
| 3 | 定时/触发式自动周报与动向汇总 | 人工汇总耗时 | 低 | 已有周报/动向，自动化是自然增强，性价比最高 |
| 4 | 任务自动分诊与路由 | 分配靠人 | 中 | 任务板有基础，叠加自动分派 |
| 5 | 后台异步 + 定时调度 | 需人盯着、关电脑就停 | 中高 | 桌面端差异化亮点 |
| 6 | 多智能体编排（orchestrator/并行/评审） | 复杂任务单 agent 不够 | 高 | 会话页有 agent_team，可与团队工作台打通 |
| 7 | 人在回路 checkpoint + 可撤销/审计 | 信任与可控 | 中 | HITL 已有，团队侧缺可撤销/审计视图 |
| 8 | Shared skills/Playbooks 复用工作流 | 重复配置 | 低中 | 可在智能体上加"保存为团队技能/剧本" |

---

## 四、差距分析

### 4.1 对标矩阵（✓有 / ◐部分 / ✗无）

| 能力 | 业界共识 | 和鸣现状 | 判定 |
|---|---|---|---|
| 任务一等公民 + 多视图（列表/看板/时间线） | Linear/Jira/Asana | 任务在工作台，"看板"只是动向另一种排布 | ◐ 看板名不副实 |
| 状态工作流可配置、审核不可绕过 | 通用 | 状态机固定，`done→todo` 可绕过验收 | ◐ |
| 团队发现（搜索）+ 申请加入 + 队长审批 | 社交/协作产品通用 | 只能按用户名加（对方需已注册），无发现/申请/审批 | ✗ |
| @提及 + 站内通知 + 全局收件箱 | Slack/Notion | 无 @、无通知、留言只显示字段痕迹 | ✗ |
| 任务↔会话深链（在会话中打开/继续任务） | Linear/Slack | 完全不互通 | ✗ |
| 方案→任务进度自动汇总/甘特/依赖可视化 | Monday/飞书项目 | 弱关联、无滚动进度 | ◐ |
| 周报/复盘自动生成 + 留痕 | Notion/Devin | 一键成稿导出，但静态、入口深、无留档 | ◐ |
| 搜索即导航 | 通用 | 命令面板可搜成员，团队动态无搜索/加载更早 | ◐ |
| 本机智能体协作产出回填（非成员化） | Notion/Linear/Manus（多走成员化） | 智能体本机私有、藏在会话页；团队仅缺"协助标注+审核回填"（不做成员身份） | ◐ 刻意不采用成员化 |
| 会话→团队知识沉淀 | Slack/Notion | 无 | ✗ |
| 后台异步 + 定时调度 | Cowork/Devin | 无（45/60s 轮询） | ✗ |
| 共享粒度控制（成员级/类别级） | 通用 | 加入即全共享、无逐类开关、清除不可逆 | ◐ 粗粒度 |

### 4.2 P0 痛点（未闭环 / 别扭，优先修）

1. **任务与会话完全不互通**：讨论只是文字留言（"对方的智能体下一轮能看到"），无 @、无通知、无"在会话中打开/继续此任务"深链。任务上下文与真实协作割裂。
2. **看板名不副实**：TeamPage"看板"只是动向摘要换排布，不能拖卡、不能改状态；真任务状态在工作台 TeamTaskPanel，两处割裂，用户找不到"任务板在哪"。—— **已修复（见「实施进度」）**：换成真任务板 `TeamTaskBoard`，读 `team_tasks`、可拖拽流转、复用状态机护栏，并按方案/逾期筛选、点卡片看只读详情。
3. **两套"团队动态"并存易混**：TeamPage feed（uploadTeamActivities 共享摘要流）vs 工作台 TeamActivityPanel（fetchTeamEvents 事件时间线），名字近、数据/口径不同。—— **部分修复（见「实施进度」）**：工作台那套已改名「任务流水」与团队页「动向」消歧；两套数据源仍未合并。
4. **状态机可被绕过**：`NEXT_STATUS` 的 `done→todo` 让点胶囊即可打回已完成任务，绕过验收；验收只有 owner 能做、无指派验收人。—— **已修复（见「实施进度」）**：服务端 `done_locked` + 前端胶囊拒绝 + 409 文案堵住裸改 done→todo，重开统一走 `review:"changes"` 留原因；未做 `reviewerId` 指派验收人。
5. **团队发现与加入缺失（社交化诉求）**：只能"按用户名加成员（对方需已注册）"，用户无法搜索团队、无法申请加入、队长无法审批；没有"建队即队长 + 团队名 + 搜队 + 审核"的社交式体验。—— **已修复（见「实施进度」）**：社交化加入全栈落地——创建即队长、目录搜索、申请+队长审批、无上限多团队隔离、一人多队。

### 4.3 P1 缺口

6. **无通知/提醒体系**：催办、留言、待验收只在字段痕迹展示，无未读/红点/全局收件箱。—— **部分修复（见「实施进度」）**：任务行已加主动「催一下 / 写进展」按钮（痛点 6 的按钮缺口已补）；@提及通知、未读红点、全局收件箱仍未做（需改服务端通知通道 + 用户拍板）。
7. **方案→任务无进度汇总**：plan 与 task 弱关联，无父项进度滚动、无里程碑/甘特/依赖可视化。—— **部分修复（见「实施进度」）**：方案卡已加「X/Y 完成 + 逾期数 + 进度条」；里程碑/甘特/依赖图仍未做。
8. **团队动态无加载更早、无搜索**：TeamActivityPanel 固定 20 条、折叠，无法追溯旧变更。—— **已修复（见「实施进度」）**：加了关键词搜索 +「加载更早」逐档提到 100。另注：痛点 6 的"无主动催办/进展按钮"也已修复（见 1.5 实施条目）；剩余的通知中心/红点仍未做。
9. **两名册割裂**：TeamPage 名册（同队摘要；用量展示已随 2026-11-21 重做删除）与 TeamWorkspace 成员（真实工作组，现为「团队列表」页签）是两份 UI，加人只在团队列表，团队页看不到管理入口。—— **部分修复（见「实施进度」）**：团队页名册已加「管理成员」一步入口跳工作台；两份名册的数据源统一仍需服务端改（带 teamId 收口）。
10. **周报静态且入口深**：只在工作台概况生成，固定近 7 天、纯 Markdown，无历史留档、无周期性、无与日程/动态合并的汇报视图。—— **部分修复（见「实施进度」）**：弹窗已可切换回看天数（最近 7 / 14 / 30 天）；历史留档 / 周期性 / 合并视图仍未做（需服务端存储）。

### 4.4 P2 细节

11. 命令面板搜技能只跳到技能列表页，不定位具体技能（无详情路由）。—— **已修复（见「实施进度」）**：复用既有 `focus-skill` 意图，本地技能结果与插件命令 target=skill 走同一落点，点了直接定位并打开该技能详情。
12. "接任务"实为把 assigneeId 改成自己，无明确"领取/认领"确认（服务端有 claimable 字段但 UI 未用）。—— **调研结论需修正（2026-11-21 复核）**：`MyTasksDialog.tsx:125-151` 已单列「队里待认领（N）」区，每项「认领并接着做」按钮走确认式认领（`buildClaimTaskPrompt`），并非"UI 未用 claimable"；此项实际已具备轻量认领入口，剩余只是"接任务时二次确认文案"的体验优化，优先级降为可选。
13. 权限判定"前端挡+服务端兜底"，普通成员界面禁用按钮无解释文案，易困惑"为什么不能改"。—— **复核结论（2026-11-21）**：`TeamTaskPanel.tsx` 的禁用按钮已带 `title={touchHint(task)}`（"这是别人名下的任务：只有本人或组长能改"等），覆盖充分；无需再改。
14. 共享摘要"加入即全共享、无逐类开关、清除不可逆"是粗粒度设计，缺成员级/类别级控制。
15. 任务摘要 title 恒为"任务"，动向可读性差（只有状态）。
16. 删除团队遗留 `team_events` / `team_task_comments` 孤儿数据。—— **已修复（见「实施进度」）**：两个 Store 实现都在删团队/删任务时显式级联清掉讨论与动态，不留孤儿。

---

## 五、完善方案

### 5.1 设计原则

1. **先收口、再增量**：优先消除"两层语义"和"两套动态"的认知负担，再谈新能力；否则新功能会叠在割裂之上。
2. **不破坏隐私红线**：对话正文 / 提示词 / 工具参数 / 任务结果细节 / 附件**永不出本机**这条底线不变（团队系统设计的四条拍板边界之一）。所有增强只共享摘要或在本机侧展示。
3. **AI 增强走"委派 + 可核对"**：智能体写入团队数据走既有 HITL；统计数字由纯函数算（如 `team_digest`），模型只组织语言，不手算。
4. **够用即可**：不盲目引入 IM 化（设计文档明确"去 IM"）、不做多人实时协同编辑；团队彼此独立、数据按 team_id 隔离（不做组织树/层级继承），支持无限团队与一人多队。

### 5.2 路线图总览

| 阶段 | 主题 | 核心交付 | 预估工作量 |
|---|---|---|---|
| Phase 1（P0，2–3 周） | 基础闭环 | 统一两层语义、看板正名、状态机收紧、团队创建/搜索/申请/审批（社交化加入）、通知与任务↔会话深链 | ~13–17 人日 |
| Phase 2（P1，3–4 周） | AI 原生增强 | 本机智能体协作（非成员化）、个人/团队知识库、会话→团队知识、自动周报/分诊 | ~15–20 人日 |
| Phase 3（P2，4–6 周） | 差异化壁垒 | 后台异步 + 定时、多智能体编排接入团队、人在回路审计与撤销 | ~18–24 人日 |

### 5.3 Phase 1：基础闭环（P0）

**1.1 统一两层语义（CRUD 集中 + 名词消歧）**
- 问题：团队页名册与工作组成员是两份 UI；两套"动态"同名。
- 方案：
  - 在工作台成员区复用团队页成员数据源，给团队页名册增加"管理成员"入口跳到工作台；团队切换器统一展示"当前工作组"。
  - 名词改：TeamPage feed 改称"共享动向"（同队成员的白名单摘要），TeamActivityPanel 改称"任务流水"（单工作组事件），首页团队卡沿用"团队动向"但明确"仅摘要"。
  - API 层强制带 `teamId`（消除不带 teamId 跨团队看同名册的旧口径），服务端校验成员身份。
- 验收：全仓无"两套动态"混称；不带 teamId 的请求不再返回跨团队成员；从团队页可一步进入成员管理。
- 工作量：~2 人日。

**1.2 看板正名（真任务板）**

先明确一个前提：团队页**已经有 `board` 这个 Tab，但它是假的**。当前 `TeamBoardView` 读的是 feed 的同一份共享摘要（`team_activities`），把「任务 / 日程」铺成两列卡片，代码注释自称「动向的另一种读法」——不能拖卡、不能改状态、看不到负责人和截止。真正的任务在 workspace 的 `TeamTaskPanel` 里。用户点进「看板」必然期待落空。所以这一项是**改造现有看板**，不是从零新增。

方案（三条设计前提）：

1. **必须能操作，否则只是又一次换排布。** 看板的价值是「一眼看清谁在做什么、卡在哪，并直接流转」。只能看不能动，与当前 feed 两列没有本质区别。要做成拖拽改状态 + 点卡片进详情。
2. **与工作台任务列表分工，不能变成第三处割裂。** 两者共享同一套 `team_tasks` 数据源与 REST API（一处改、两处同步），数据源必须从 `team_activities` 换成 `team_tasks`——这是假看板的根因。分工：
   - **看板 = 横向流转视图**：按状态分列（待开始 / 进行中 / 有卡点 / 待验收 / 完成）；卡片显示负责人、优先级、截止 / 逾期、所属方案、被卡前置数；支持拖拽改状态，按人 / 方案 / 逾期筛选。
   - **工作台 = 纵向详情视图**：讨论、历史、交付物、验收仍是 `TeamTaskPanel` 的职责；点看板卡片 → 打开详情（侧滑或跳工作台）。
3. **别让拖拽绕过验收。** 看板最容易暴露现有状态机漏洞（`done→todo` 一点即打回）。看板必须复用 1.3 收紧后的状态机：重 open 走「打回」并留原因；拖到完成进入**待验收**而不是直接完成。

产品入口建议：看板既然是团队任务的主视图，可把首页团队卡「进入团队」直接导向看板，或把看板提到更靠前的 Tab 位置。当前默认 Tab 是「动向」，用户想看任务得先找到 workspace 再找 `TeamTaskPanel`——这个发现成本本身就是「做得不突出」的原因之一。
  - **已实施（2026-11-21，入口）**：首页「团队动向」卡头部新增「任务看板」链接（`onOpenBoard` → `setPage("team","board")`），与「进入团队」并列，用户从首页一步直达真看板，不必先进 feed 再找 Tab。验证：`HomePage.test.tsx` 36/36（+1：点任务看板落到 team 页 pageView=board）；web 全量见「实施进度」。

**看板按团队切换（m00211 多团队决策）**：改造后的看板顶部复用既有团队切换器（`lib/team/selection.ts`，会话级 `sessionStorage` 语义），切换团队后看板只显示该团队 `team_tasks`；一人可加入多团队，在不同团队间切换时列表、筛选条件与当前选中任务需随团队重置。看板、工作台、团队页三者共用同一份选择状态，切换一次全局生效。

- 验收：看板读 `team_tasks` 且与工作台双向同步；拖卡后状态在服务端持久化；拖到完成进入待验收而非直接完成；重开有原因留痕；非授权用户拖卡被拒并给出解释文案（现状是按钮禁用但无说明，易困惑「为什么不能改」）。
- 工作量：~3 人日（含拖拽权限校验与非授权解释文案）。
- **已实施（2026-11-20 晚 / 2026-11-21 补筛选 + 点卡片详情）**：见上方「实施进度」1.2 条——真任务板 `TeamTaskBoard.tsx` 已落地，读 `team_tasks`、拖拽流转、复用 1.3 状态机与非授权解释；按方案（含「独立任务」）/ 只看逾期筛选、卡片显示所属方案、点卡片打开只读详情（与看板同源、不发新请求；详情里「到工作台处理」（2026-11-21 起为「到团队列表处理」）一键跳团队列表处理验收/讨论）也已补齐；切换团队时筛选条件与打开的详情随团队重置（§5.3 1.2 验收），不把 A 队的筛选串到 B 队。与会话的深链编辑仍转入 1.5 阶段（需服务端，暂缓）。

**1.3 状态机收紧**
- 问题：`done→todo` 绕过验收。
- 方案：移除胶囊的 `done→todo`；已完成要重开必须走"打回"（review changes），且记录原因到事件流水；验收人可由 owner 指派（新增 `reviewerId` 字段，非 owner 也可被指派）。
- **实施状态（已落地，见「实施进度」）**：服务端 `done_locked` 拦截裸改 status + 前端胶囊拒绝 + 409 文案；重开统一收敛到 `review:"changes"`（有原因留痕）。未做 `reviewerId` 指派与独立「重新打开」按钮。
- 验收：不存在绕过验收的 done→todo 路径；每次重开都有事件与原因。
- 工作量：~2 人日（含服务端 schema/Store 改动）。

**1.4 团队创建与加入（社交化体验，保持去 IM）**

用户明确诉求（m00180 的补充回答）：**"用户创造即为队长，确定团队名字，用户可以搜索团队并加入，然后队长审核"**，并保持"去 IM"边界。即借鉴社交软件「建群 → 搜群 → 申请 → 审批」的体验，但**不引入聊天、动态墙、陌生人 IM**。

- 问题：现状只能"按用户名加成员（对方需已注册）"，无团队发现、无申请、无审批；队长在 UI 里叫 owner，与"队长"心智不一致。
- **已确认的产品决策：无上限多团队 + 完全隔离（m00211）**：用户明确——"可以有多个团队，本质上可以有无限个团队，每个团队彼此独立，然后每个人可以加入多个团队，看板可以切换不同团队去看"。这正式推翻原设计 `docs/superpowers/specs/2026-11-02-team-system-design.md` 拍板的"单团队、不做多团队/不跨团队可见性、成员 = 全部用户"边界。具体口径：
  - **团队数无上限、彼此独立**：每个团队有独立的方案、任务、成员、讨论、动向、日程；不设数量上限。现有 `teams` / `team_tasks` 等表已以 `team_id` 外键隔离，天生支持多团队（无需重构为主，只需修正若干按"全站同队"写的查询口径）。
  - **一人可加入多团队**：`team_members` 已支持 `(team_id, user_id)` 多条记录；同一用户在不同团队可担任不同角色（A 队队长、B 队队员）。
  - **目录级发现**：团队目录只暴露有限元数据（名称、目标简介、成员数、创建时间），不暴露成员名单、任务、动向、用量；这些敏感数据继续按"同队成员"收口。
  - **看板按团队切换**：看板（1.2 改造后的真任务板）顶部沿用团队切换器，切换后只显示当前团队的任务；切换器与工作台、团队页共用 `lib/team/selection.ts` 同一份选择状态（会话级 `sessionStorage` 语义）。
  - 实施前需正式修订原设计文档的"单团队"边界为上述口径。
- 方案：
  1. **创建即队长**：新建团队流程改为"填团队名（必填）+ 目标简介（选填）"两步；创建者自动成为 owner，UI 文案统一改称"队长"（数据库仍用 `owner_id`，只改展示层）。沿用现有 `teams` 表（name / goal / owner_id），无需 schema 改动。
  2. **团队目录/搜索**：新增 `GET /api/teams/discover?q=&limit=`（登录后可查），只返回 {id, name, goal, memberCount, createdAt}，按名称/目标模糊匹配；前端在团队页与命令面板加"发现团队"入口（搜索框 + 团队卡片：名称/简介/成员数/「申请加入」按钮）。不带 q 时返回推荐/最近创建的若干条。
  3. **申请 + 审批流**：新表 `team_join_requests`（id, team_id, user_id, message 选填, status pending/approved/rejected, created_at, reviewed_at/by），**不建 UNIQUE**——被拒后可重新申请（新 id），重复 pending 由 Store 查重（已实施口径）；`POST /api/teams/:id/join-requests` 申请、`GET /api/teams/:id/join-requests` 队长看列表、`POST .../review` 同意/拒绝。同意后写 `team_members`（role member），并 push `join_approved` 事件；申请/拒绝分别 push `join_requested`/`join_rejected`（已实施口径）。
  4. **辅助入口（可选，非必须）**：队长生成邀请链接（含 teamId + token，服务端存 invitation 表，设过期与人数上限），对方点链接直接定位到该团队卡片再走申请——保留 1.4 原方案作为补充，但不再是主路径。
- 验收：新建团队后创建者即为队长且团队出现在目录；非成员能按名称/目标搜到团队并看到有限元数据（看不到成员/任务/动向）；能带理由申请；队长收到申请列表并能同意/拒绝，同意后申请人成为成员且出现在名册；重复申请被拒；被拒后可再次申请；全程无聊天/动态墙入口。
- 工作量：~4 人日（含目录 API、申请表、审批 UI、文案统一；比原 1.4 多 1 人日）。
- 明确不做：邮件邀请、陌生人 IM、团队动态对非成员可见、任意用户直接加入（必须队长审核）。

**1.5 通知与任务↔会话深链**
- 问题：无 @ / 通知 / 深链。
- 方案：
  - 任务留言支持 `@用户名`（复用成员列表，前端解析 + 服务端存 mentionedIds），被 @ 用户在通知中心生成 `task` 类型通知（复用既有 `task/staff/approval` 三类通知通道）。
  - 任务卡加"在会话中打开"按钮：为任务绑定一个会话（复用 `conversations.title/workspace`），点击跳到会话页并把任务摘要作为上下文注入（不上传正文到服务端，仅本机注入）。
  - 任务卡直接提供"催一下 / 更新进展"按钮（写 nudge/progress，替代只能靠智能体工具写入）。
- 验收：@ 后对方通知中心可见；从任务能跳到会话且上下文正确；催办/更新进展按钮可用且写入事件流水。
- 工作量：~4 人日。

### 5.4 Phase 2：AI 原生增强（P1）

**2.1 本机智能体协作（非成员化，最高价值）**
- **产品约束（用户明确，m00272）**：和鸣智能体存储在用户本地、使用用户自己的 API → **不让智能体成为团队成员**，服务端不建 Agent 成员记录/席位/账号；这是隐私卖点，必须保留。因此不采用 Notion/Linear/Manus 的"Agent 成员化"路线，只借鉴其"委派+审计+权限"机制。
- 目标：让团队能看见"某任务由某成员的本机智能体协助完成、该成员已确认"，产出可追溯，但不引入被服务端指派的 Agent 成员身份。
- 方案：
  - **任务协助标注（替代成员卡片）**：团队任务增加 `assistedByAgent`/`agentOwnerId`（指向人类用户）等标注字段；任务详情/卡片展示"由 XX 的智能体协助、XX 已确认"摘要，写进 `team_events`。不建 Agent 成员记录、不可被 @ 当作成员、不混入 `team_members`。
  - **委派仍在本机**：`agent_task/agent_team/workflow_run` 保持本机派发、用户自己的 API；流程是"人在会话里委派 → 审核产出 → HITL 确认回填任务 result"，不是"团队把任务指派给 Agent 成员"。
  - **审计只留摘要**：流水只记"由某人的智能体协助 + 确认状态"，不上传工具轨迹/提示词/正文；完整轨迹留本机。
  - **权限复用人的身份**：智能体读取团队数据 = 用户以本人成员身份经服务端 `visibleTeam()/teamMemberRole()` 校验，不引入独立 Agent 授权主体。
- 验收：任务能标注"由 XX 的智能体协助"且归属人类；result 由 HITL 确认回填；无任何 Agent 成员记录，@ 列表无智能体；流水不含正文/轨迹。
- 工作量：~4 人日（比成员化少 1 人日——省去成员身份与成员卡片）。

**2.2 会话→团队知识沉淀**
- 目标：把与智能体的会话中"可共享的结论"沉淀为团队可搜索知识，不上传正文。
- 方案：
  - 会话内提供"沉淀为团队笔记"动作：用户显式选择要公开的结论片段（本机人工确认），写入服务端新表 `team_notes`（team_id/author_id/title/body/来源会话本机 ID/tags），仅同队可见。
  - 搜索：命令面板与团队页增加"团队笔记"检索（复用 FTS5 trigram 方案）。
  - 红线：默认不沉淀、不自动上传对话正文；每次沉淀都是显式动作。
- 验收：用户能手动把一段会话结论变成团队笔记并搜索到；没有任何正文被自动上传。
- 工作量：~4 人日。
- **与团队知识库方案的关系**：本项是团队知识库的一个入口（会话结论沉淀）。完整的「个人库 + 团队库 + 知识库页开接口」设计见 `2026-11-20-team-knowledge-base-design.md`；实施时 `team_notes` 可直接并入该文档的 `team_knowledge_docs` 表，避免两套表。

**2.3 自动周报 / 任务自动分诊**
- 目标：对齐 Notion status/routing agent，降低人工汇总成本。
- 方案：
  - 周报定时：owner 设置每周固定时间，到点由本机（或在线时）调用 `weeklyReportMarkdown` 生成草稿，**存为团队周报留档**（新表 `team_reports`），不自动发送（沿用"什么时候汇报是人的决定"的既有取舍）。
  - 自动分诊：新任务进入"待认领"时，基于成员负载/技能标签给出建议负责人（纯函数算建议，HITL 确认后指派），不自动指派。
- 验收：周报按周期留档可回溯；分诊建议可解释、可一键采纳/忽略。
- 工作量：~4 人日。
- **部分实施（2026-11-21，痛点 10）**：周报弹窗已支持选回看天数（7/14/30 天；`weeklyReportMarkdown` 的 `options.days` 本就支持 1–30）——属"降门槛"第一步；定时留档（`team_reports` 表）与自动分诊仍需服务端改动，未做。

**2.4 团队技能/剧本复用**
- 目标：对齐 Manus Shared skills / Devin Playbooks。
- 方案：智能体对话中"保存为团队技能"（提示词模板 + 工具序列 + 参数约束），团队内共享、版本化，成员可一键装载到自己的智能体；沿用现有技能/插件体系的权限模型。
- 验收：团队技能可被成员装载并复现相同工作流。
- 工作量：~2 人日。

### 5.5 Phase 3：差异化壁垒（P2）

**3.1 后台异步 + 定时调度**
- 目标：对齐 Cowork "works when you don't"，发挥桌面端优势。
- 方案：把委派任务纳入本机自动化调度（`packages/web/src/lib/automation` 已有执行内核），支持"每天/每周"定时跑某团队任务的智能体部分；离线时排队、上线后补跑；结果经 HITL 回填。
- 验收：关闭窗口后定时任务仍在本机执行并回填；离线任务上线后补跑不丢。
- 工作量：~6 人日。

**3.2 多智能体编排接入团队**
- 目标：把会话页已有的 `agent_team` / `workflow_run` 编排能力接到团队任务上，形成"组长把复杂任务派给一组智能体"的闭环。
- 方案：任务可标记"编排任务"，configured 用 orchestrator-workers / 并行 / 评审循环模式（Anthropic 六模式中选择）；每个子任务作为 team_task 子项跟踪状态；中间结论引用式回传（≤600 字摘要 + read 指针，对齐 d.410 留白），避免全文回灌。
- 验收：一个编排任务能在团队看板上看到各子项进度与最终结论；回传为摘要+指针而非全文。
- 工作量：~7 人日。

**3.3 人在回路审计与撤销**
- 目标：企业级信任与可控。
- 方案：团队事件流水升级为完整审计视图（谁/何时/改了什么/前后值），支持"撤销此次改动"（服务端记录 before/after 快照，权限校验 + 二次确认）；所有智能体写入走 HITL 并留审计。
- 验收：任一改动可追溯、可撤销；撤销有权限与二次确认。
- 工作量：~5 人日。

---

## 六、风险、约束与明确不做

### 6.1 风险与对策
- **隐私泄露**：任何增强不得上传对话正文/提示词/参数/结果细节；“沉淀团队笔记”“引用式回传”都必须是用户显式动作 + 摘要/指针，并在服务端 schema 白名单校验。
- **性能与轮询压力**：当前 45/60s 轮询，新增实时性需求时再评估 WS 广播，不一开始引入。
- **文档与实现漂移**：设计文档写"默认全关可关"、代码是"默认全共享无开关"，建议在实施 Phase 1 时同步修订设计文档与 README（README.md:31 仍有已删除的协作页描述，docs/HANDOFF.md 头部 d.345 过时）。

### 6.2 明确不做（沿用已拍板边界）
- 不做人类 IM / 私聊 / 群聊 / 状态墙 / 评论点赞（去 IM 设计；团队搜索/申请/审批是社交化「加入体验」，不含沟通）。
- 不做部门/组织树（团队之间彼此独立、无层级继承）——**已确认「无上限多团队 + 完全隔离 + 一人可加入多团队 + 目录级发现」**（m00211）：团队元数据（名称/目标/成员数）可被搜索，成员名单/任务/动向/用量仍只对同队成员可见；看板/工作台共用切换器按团队切换（见 1.4，实施前须正式修订原设计文档"单团队"边界）。
- 不做多人实时协同编辑（文档/看板共享以摘要与任务为界）。
- 不做邮件发送基础设施。
- 不自动发周报/自动派活（统计由纯函数算，动作由人确认）。
- **不让智能体成为团队成员**（m00272）：智能体存储在用户本地、使用用户自己的 API，服务端不建 Agent 成员记录/席位/账号、不可被 @ 委派；只做"本机执行 + 人审核回填团队"。这是隐私卖点，不为了模仿业界成员化而放弃。
- **团队知识库只存用户显式共享的摘要/文档，不自动同步个人知识库全文**（详见知识库方案文档）。

### 6.3 前置清理（建议随 Phase 1 做）
- 修 `sqliteStore.ts:1401-1409` 删除团队未清 `team_events` / `team_task_comments` 的孤儿数据。
- 在线状态加心跳/超时踢除，避免异常断连残留。
- 统一任务摘要 title 的可读性（在隐私允许范围内，例如"任务 · 状态"已够，不要把首行提示词放上去）。

---

## 七、关键文件索引

### 服务端
- `packages/server/src/db.ts`（建表）、`app.ts`（REST 路由）、`sqliteStore.ts`（SQL / Store）、`store.ts`、`teamCounts.ts`、`teamUsage.ts`、`presence.ts`、`ws.ts`、`events.ts`
- `packages/shared/src/schemas.ts`（Team*Schema、TeamActivityInputSchema 白名单）

### 前端
- 入口/路由：`packages/web/src/App.tsx`、`components/SidebarNav.tsx`、`store/ui.ts`
- 团队页：`components/TeamPage.tsx`、`components/TeamBoardPage.tsx`
- 工作台：`components/team/TeamWorkspace.tsx`、`TeamTaskPanel.tsx`、`TeamPlanPanel.tsx`、`TeamSchedulePanel.tsx`、`TeamActivityPanel.tsx`
- 首页/命令面板：`components/HomePage.tsx`、`components/home/TeamActivityCard.tsx`、`components/CommandPalette.tsx`
- API：`packages/web/src/lib/api.ts`
- 领域逻辑：`packages/web/src/lib/team/{share,selection,teamSummary,digest,weeklyReport,schedule,findTasks}.ts`
- 智能体工具：`packages/web/src/lib/capability/teamTools.ts`
- Prompt 注入：`packages/web/src/lib/agentRuntime/runtimePrompt.ts`

### 文档
- `docs/superpowers/specs/2026-11-02-team-system-design.md`（设计 + d.152 口径修订）
- `CHANGELOG.md`（d.152 / d.153 / d.266–d.277 团队能力演进）
- `docs/DESIGN-AUDIT-2026-11-14.md`、`docs/AUDIT-C-admin-pages.md`（团队页 IA / 无障碍审计）

---

## 八、参考来源（外部）

- Linear：[Agents](https://linear.app/agents) · [AI](https://linear.app/ai)
- Notion：[Agents](https://www.notion.com/product/agents) · [AI](https://www.notion.com/product/ai)
- Slack：[AI](https://slack.com/features/ai) · [Multiplayer AI](https://slack.com/resources/why-use-slack/multiplayer-ai)
- Asana：[AI Teammates](https://asana.com/product/ai)
- Devin：[API Docs](https://docs.devin.ai/api-reference/overview)
- Manus：[for Teams](https://manus.im/team)
- Claude：[Cowork](https://claude.com/product/cowork)
- OpenAI：[ChatGPT Team](https://openai.com/index/introducing-chatgpt-team/)
- Anthropic：[Building effective agents（六编排模式）](https://www.anthropic.com/research/building-effective-agents)

---

## 附：本轮调研的三点事实纠偏（供评审注意）

1. **无"默认全关/逐类共享开关"**：当前是加入团队即默认共享三类白名单摘要（d.153），开关已移除；设计文档停留在 d.152 的"默认全开可关"。
2. **无 `team_report` 工具**：对应能力是只读 `team_digest`（给模型的事实清单）+ 纯前端 `weeklyReportMarkdown`（给人看的成稿）。
3. **`team_*` 工具位置**：全部在 `packages/web/src/lib/capability/teamTools.ts`，不在 agent-pipeline / desktop / plugin-kit。
