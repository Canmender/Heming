# d.112 团队功能优化：静默错误修复 · 协作闭环 · 口径收口

- 日期：2026-11-08
- 分支：`feat/team-optimize`（从 `origin/main @ d702ea1` 拉出，收尾时变基到最新 `origin/main @ e0dfff8` / `d.111.2.42.0`，独立工作树 `.worktrees/team-optimize`）
- 版本：`d.112.2.42.0`（特性 +1）
  - 立项时按当时 main（d.106）写作 d.109；变基到 d.111 后发现 d.109 已被技能社区线占用，故按「数字只增不减」顺延为 d.112（特性位 +1，其余位保持）。
- 触发：用户指令「拉取新分支，优化团队功能，先调研，再继续」
- 调研材料（本轮全部只读，未改产品代码；证据目录 `.tmp/team-research/`）：
  - 前端静态审计 279 行：`.tmp/team-research/ux-code-report.md`（P0 0 / P1 3 / P2 15 / P3 16）
  - 服务端·契约·智能体审计 410 行：`.tmp/team-research/api-report.md`（P0 1 / P1 5 / P2 9）
  - 历史待办与口径核对 231 行：`.tmp/team-research/backlog-report.md`（55 条台账 / 10 条口径冲突 / 12 项候选）
  - 真机浏览器走查：`.tmp/team-research/browser-report.md` + `browser-shots/`（基线 1600/1100、暗色、伪造 4 成员/9 动向/3 人用量、工作台全流程）

---

## 0. 结论摘要

团队功能**主干是好的**：权限只在服务端判（非成员 404 / owner 403）、内存与 SQLite 双 Store 同契约、隐私分层（全站只收摘要、工作台仅成员可见）、HITL 写必问读不打断，均经代码与实测核对。

问题集中在三类：

| 类 | 代表问题 | 数量 |
|---|---|---|
| **静默错误** | 派任务时交付物被 zod 静默剥离（实测 201 返回 `attachmentFileId: null`）；任务截止时间按 UTC 显示（东八区差 8 小时）；动向游标同 `occurredAt` 丢条目；双 Store 同刻排序相反 | P0×1 · P1×4 |
| **协作闭环缺口** | 工作台只在挂载拉一次、无刷新/无轮询；成员详情仍只是筛选器；看板与动向各拉一份数据、两套成员筛选不互通；条目不可点 | P1×2 · P2×3 |
| **口径不实** | 「清除共享记录」被说成能撤用量（实际只清动向）；团队日程文案承诺「不含正文」，却渲染客户端可自填的 `detail`；隐私说明 5 处；「证据/白名单/写操作/真实成员」内部术语 | P0×1 · P2×3 |

本轮**只做**上表可直接判定、可在客户端/服务端单侧闭合的 16 项修复；**不做**新功能（评论/变更历史/拖拽/邀请/多团队/交付物内嵌预览），也**不做**需要产品先定数值的写侧配额与全量名册轻量化（见 §4）。

---

## 1. 本轮范围

> 每项格式：现状（证据）→ 改法 → 验收。测试清单见 §5.2。

### A. 正确性与静默错误

#### A1（P0）创建任务支持交付物

- **现状**：`TeamTaskPanel.tsx:119-126` 派任务时把 `attachmentFileId` 交给 `createTeamTask`；但 `CreateTeamTaskBodySchema`（`packages/shared/src/schemas.ts:709-716`）没有该字段，服务端 zod strip 静默丢弃，任务落库 `attachmentFileId = null`（api 报告实测 201 返回 null；PATCH 正常）。
- **改法**：
  1. shared `CreateTeamTaskBodySchema` 增加 `attachmentFileId: z.string().trim().min(1).nullable().optional()`；
  2. `store.ts` 内存 `createTeamTask` 写入 `body.attachmentFileId ?? null`；`sqliteStore.ts` INSERT 的 `attachment_file_id` 参数从 `null` 改为同一表达式（两 Store 同语义）；
  3. `team_task_add` 工具补可选参数 `attachmentFileId`（见 D2，与 `team_task_update` 同名，保持工具参数 camelCase 一致），映射到 `attachmentFileId`；
  4. UI 无需改动（已传），但必须补「真上传→断言带上 id」的用例。
- **验收**：`POST /api/teams/:id/tasks` 带 `attachmentFileId` → 201 响应与团队快照都能看到该 id；不带时仍为 `null`。

#### A2（P1）动向分页补唯一游标，双 Store 排序统一

- **现状**：客户端把最后一条 `occurredAt` 当 `before`；服务端按**严格小于**过滤（`store.ts:596`、`sqliteStore.ts:626-629`），同时间戳的剩余条目永远翻不到（实测 3 条同刻只取到 2 条）。同一时间戳内存按插入序、SQLite 按 `created_at DESC`，**顺序相反**（`store.ts:594-598` vs `sqliteStore.ts:634-638`）。
- **改法**：
  1. 排序统一为 `occurredAt DESC, id DESC`（两 Store）；
  2. `listTeamActivities` 增加可选 `beforeId`：过滤条件为 `occurredAt < before`（无 `beforeId` 时保持旧语义）或 `occurredAt = before && id < beforeId`；
  3. `GET /api/team/activities` 接受可选 `beforeId`（非空字符串，否则 400 中文）；`api.ts` 的 `fetchTeamActivities` 增加 `beforeId` 并拼进 query；
  4. `TeamPage.loadFeed` 翻页时同时传 `before` 与 `beforeId`（最后一条的 id）。
- **验收**：3 条同 `occurredAt`、`limit=2` 分两页能取全且不重复；memory 与 sqlite 返回顺序一致；旧客户端（只传 `before`）行为不变。

#### A3（P1）任务截止时间按本地时区显示 + 逾期标记

- **现状**：`TeamTaskPanel.tsx:359` 用 `task.dueAt.slice(0,16).replace("T"," ")` 直接切 ISO 字符串；东八区填 18:00 显示 10:00。
- **改法**：新增 `packages/web/src/lib/format/datetime.ts` 的 `fmtLocalDateTime(iso)`（本地时区 `YYYY-MM-DD HH:mm`，非法值返回空串）与 `isOverdue(iso, now?)`；任务行改为本地渲染，未完成且已过期时显示「已逾期」小标记（不只靠颜色）。
- **验收**：`dueAt=2026-11-10T10:00:00.000Z` 在东八区显示 `2026-11-10 18:00`；到期且未完成显示「已逾期」，已完成不显示。

#### A4（P1）工作台可刷新 + 低频轮询 + 提示生命周期

- **现状**：`TeamWorkspace.tsx:80-84` 只在挂载拉一次（显式 `eslint-disable`），切团队才重载；队友改动看不到。`notice` 只在 `run()` 里 3s 消失，「团队已创建」没有 timeout（`:139`）。
- **改法**：
  1. 团队概况区加「刷新」按钮（`aria-label="刷新团队数据"`，busy 时禁用）；
  2. 工作台 Tab 挂载期间每 45s `fetchWorkspaceTeam(selectedId)` 静默刷新（`busy` 时跳过；只在有快照时轮询）；
  3. 手动刷新成功后给一次 `role="status"`「团队数据已刷新」，3s 消失；45s 轮询**静默**更新快照（不弹提示，避免每 45 秒打扰一次）；所有 notice 统一走 `flash(text)`，卸载清 timer。
- **验收**：点刷新后 `fetchWorkspaceTeam` 再次被调用且 UI 更新；空团队不轮询；轮询不弹提示；「团队已创建」3s 后消失。

#### A5（P1）深链意图消费与高亮褪去

- **现状**：`TeamPage.tsx:370-381` 只有滚动成功才 `consumeTeamActivityFocus()`，`if (!el) return` 在消费之前；`setPage`（`store/ui.ts:524-540`）不清理 `teamFocusUserId/teamFocusActivityId`。后果：条目不在当前列表时意图永久残留，之后每次进团队页被强制切到「动向」。另外 `setHighlightActivityId` 与 consume 在同一 effect，consume 触发依赖变化 → cleanup `clearTimeout` → 高亮**永不褪去**（d.91 规格要求 2.4s）。
- **改法**：
  1. `setPage` 清理 `teamFocusUserId`、`teamFocusActivityId`（与 `taskFocusId` 同口径）；
  2. 高亮计时器拆到独立 effect（依赖 `highlightActivityId`），2.4s 后清空；滚动与 consume 留在原 effect；
  3. 未命中兜底：意图存在但 5s 内未在可见列表出现时，消费意图并给一次 `role="status"` 说明「该动向已不在最近列表中」。
- **验收**：预置 intent 且条目不存在的场景：5s 后 intent 清空、不再强制切 Tab；命中场景 2.4s 后 `ring-1` 消失（新用例显式断言）。

#### A6（P2）团队日程加载失败的错误态

- **现状**：日程视图只判 `feedReady`，`feedError` 时渲染「还没有共享的日程」（`TeamPage.tsx:828-857`），网络/鉴权失败被说成没数据。
- **改法**：补 `feedError` 分支：`role="alert"` + 原因 + 重试（调 `loadFeed(true)`），空态三分支不变。
- **验收**：`fetchTeamActivities` reject 时日程 Tab 出现错误文案与重试，不出现空态引导。

#### A7（P0）「清除共享记录」撤回口径修正

- **现状**：关闭用量共享时的一次性提示写「可用『清除共享记录』撤回」（`TeamPage.tsx:444-451`），但该按钮只调 `clearMyTeamActivities()`（`:422-435`），**不清用量**；按钮 title 也写「动向/用量排行」（`:527-528`）。
- **改法**：
  1. `turnOffShare("usage")` 单独文案：明确改用「用量」页的「清除我的用量」；
  2. 「清除共享记录」按钮 title 与确认弹窗只声称清除**团队动向**，并提示用量到「用量」页单独清除；
  3. 共享 0/3 时在共享行显示持久说明「当前未共享任何内容：团队看不到你的任务、日程或用量。」（不再只藏在 chip title 里）。
- **验收**：关闭用量后的提示不再指向「清除共享记录」；点「清除共享记录」后动向无本人条目、用量排行仍有本人；0/3 时说明可见。

### B. 协作闭环

#### B1（P1）成员详情升级 + 排行可点

- **现状**：选中成员只有头像/@username/在线/「近 N 天动向 M 条 · 用量」（`TeamPage.tsx:653-685`）；排行行是纯 `<li>`（`:1022-1042`），点不进成员。
- **改法**：
  1. 成员详情条下增加「最近动向」最多 3 条（标题 + 时间），每条可点 → 高亮该条（复用 A5 的高亮机制，必要时把筛选切回「全部」）；
  2. 排行行姓名改为按钮，点击 = 选中该成员并切到「动向」；与自己同行为无操作时保持纯文本；
  3. 无明细时给一句「该成员还没有可显示的动向」。
- **验收**：选中成员可见 3 条明细（不足 3 条显示实际条数）；点排行里的成员 → 名册与成员详情同步选中；键盘可点。

#### B2（P1）看板复用动向数据 + 两套成员筛选互通 + 卡片可点

- **现状**：`TeamBoardPage.tsx:88-126` 自己 `fetchTeam/fetchTeamActivities`（limit=100、30s 轮询），与团队页各拉一份；`TeamBoardViewProps` 只有 `className`（`:79-82`），左栏选中成员切到看板即丢失；卡片是纯 `<article>`（`:60-77`）。看板顶部与底部各有一句隐私说明（`:242-245` vs `:313-319`）。
- **改法（看板定位采用 backlog 报告方案 A）**：动向 = 按时间的主入口；看板 = 同一份摘要的「按类型两列」只读盘。
  1. `TeamBoardView` 改为受控视图：props `{ members, onlineCount, activities, selectedId, onSelectMember, ready, error, onRetry }`；删除内部取数、轮询、`fetchTeam` 与 footer；
  2. 宿主 `TeamPage` 传当前已加载的 `humanActivities`、名册与 `selectedId`；看板筛选 chips 读写同一个 `selectedId`（两处筛选天然互通）；
  3. 卡片点击 = `onSelectMember(actorId)`（与首页/动向一致），卡片用 `button` 语义保证键盘可达；chips 补 `aria-pressed`，错误态补 `role="alert"`；
  4. 看板只保留筛选条下的一句边界说明，删除底部重复句；成员 chips 容器 `overflow-x-auto` 单行（1100 不折行）。
- **验收**：切到看板不再产生新的 `/api/team*` 请求（只看宿主已加载数据）；左栏选「林晓」→ 看板 chip 高亮为林晓且只显示其条目；点卡片选中该成员；看板内隐私说明只剩 1 处。

#### B3（P2）动向条目可点

- **现状**：动向行是纯 `<li>`（`TeamPage.tsx:770-802`），首页同类条目可点、团队页反而不能。
- **改法**：行内容改为 `button`（整行可点，保留高亮 ring 样式），点击 = 选中该成员（与首页/看板一致）。
- **验收**：点任一动向条目后该成员被选中、`aria-current`/高亮可见；Tab 可达。

#### B4（P2）工作台确认框统一，移除成员二次确认

- **现状**：删团队/删方案/删任务用原生 `window.confirm`（`TeamWorkspace.tsx:276`、`TeamPlanPanel.tsx:89`、`TeamTaskPanel.tsx:168`），团队页其余破坏性操作用自绘 `ConfirmDialog`；移除成员点 ✕ 立即生效且会解绑其任务（`TeamWorkspace.tsx:361-375`）。
- **改法**：
  1. 三处删除改用 `ConfirmDialog`（含不可恢复说明；初始焦点在「取消」）；
  2. 移除成员加二次确认，文案写清「他的任务会解绑为待认领」；
  3. 保持服务端权限判定不变（前端只做提示）。
- **验收**：删除/移除都必须先出应用内弹窗；取消不调用 API；确认后才调用；无 `window.confirm` 残留（源码守卫或测试断言）。

#### B5（P1，真机审计补录）非 owner 不渲染「编辑目标」入口

- **现状**：真机实测（browser-report P1-2）非 owner（alice）能看到「编辑」目标，改完保存才被服务端 403「只有团队创建者可以修改团队信息」；同文件的删除团队/成员增删都已按 `isOwner` 包裹，只有目标编辑漏了。
- **改法**：目标编辑入口按 `isOwner` 条件渲染（非 owner 不显示）；服务端权限判定不变。
- **验收**：非 owner 视角工作台无「编辑」按钮、无 403 往返；owner 正常。

### C. 口径与隐私

#### C1（P0）日程/任务摘要渲染不再直出客户端自由文本

- **现状**：团队日程文案承诺「标题 + 到期档位；不含正文」，但渲染 `a.detail`（`TeamPage.tsx:879-881`，看板 `:70-74` 同样）；契约 `detail` 是客户端可自填 ≤500 字自由文本（`schemas.ts:433`），服务端原样回传。客户端现状确实只写「任务 · 状态」「日程 · 到期档位」（`share.ts:153,169`），但服务端无法证明。
- **改法**：
  1. **UI 派生**：抽 `activitySummaryLabel(activity)`（`lib/team/labels.ts`）：task 由 `status` 映射「进行中/已完成/失败/已中断」，agenda 由 `status` 映射「已逾期/今天到期/24 小时内到期」；有用标签才显示；**任何视图都不再直出 `detail`**；
  2. **契约收紧（写侧）**：`TeamActivityInputSchema` 对 `kind === "task"` 要求 `detail` 匹配 `^任务 · (进行中|已完成|失败|已中断)$`、`status ∈ {running,done,failed,cancelled}`；对 `kind === "agenda"` 要求 `detail` 匹配 `^日程 · (已逾期|今天到期|24 小时内到期)$`、`status ∈ {overdue,today,next24h}`；不匹配 → 400 中文「只接受标题与状态摘要」；
  3. **读侧兼容**：旧数据不校验；UI 对无法映射的旧条目只显示标题与类型，不显示自由文本。
- **验收**：`POST /api/team/activities` 提交 `kind=agenda, detail="这是正文……"` → 400；提交合法摘要 → 200/201；团队日程/动向/看板显示「日程 · 今天到期」这类派生标签，不出现任意 detail 原文。

#### C2（P2）隐私说明收敛 + 内部术语去 AI 腔

- **现状**：隐私说明 5 处（共享行 `TeamPage.tsx:481`、日程 `:826`、用量 `:894`、看板顶 `TeamBoardPage.tsx:244`、看板底 `:314`）；「证据 / 白名单 / 写操作 / 真实成员」等内部术语直接给用户看（`:459,826,933-936`、`TeamWorkspace.tsx:224-226`）。
- **改法**：
  - 共享行承担完整口径：「向团队共享（只上报标题与状态摘要，不含对话、提示词与工具参数；关闭只停止上报，不撤回已上传的内容）」；
  - 各视图只保留自己的边界差异：日程「标题 + 到期档位」、用量「日期/模型/连接名/token 数」；
  - 删除看板底部重复说明；
  - 用户文案替换：证据→来源信息、白名单摘要→只同步哪些字段、「写操作」→「智能体也能帮你改（会先请你确认）」、「真实成员」→「成员」；
  - 页头在线数加 `title` 说明「在线 = 当前打开着和鸣（有实时连接）」。
- **验收**：团队页 + 看板内隐私说明 ≤3 处、同一措辞不重复；页面不再出现「证据/白名单/写操作/真实成员」。

#### C3（P2）共享 0/3 说明与可访问名

- **现状**：0/3 只能靠 chip title 知道；共享第三项 `aria-label="共享用量"` 覆盖可见文字「用量排行」（`TeamPage.tsx:502-511`）。
- **改法**：0/3 持久说明（A7 已含）；去掉第三个复选框的 `aria-label`，由包裹 label 的「用量排行」命名。
- **验收**：0/3 时页面有显式说明；读屏读到的名字与可见文字一致。

### D. 智能体侧

#### D1（P2）HITL 确认弹窗登记团队工具

- **现状**：`team_*` 不在 `DISPLAY_NAMES/PREFIX_DISPLAY`（`hitl/classify.ts:151-183`）→ 确认弹窗显示「外部工具 team_task_add」；`sourceOf` 落到 `unknown`（`:197-203`）；参数摘要字段不含 `title/team_id`（`:107`）。
- **改法**：登记 9 个工具中文动作名 + `team_` 前缀兜底「团队操作」；`sourceOf` 增加 `team` 来源（若 `HitlSource` 类型/展示层需要，一并扩展）；`SUMMARY_FIELDS` 增加 `title`、`team_id`（顺序放在敏感字段之后，仍走敏感词过滤）；「记住允许」的规则资源单独用 `RULE_RESOURCE_FIELDS` 把 `team_id` 放最前，避免按标题碎片化。
- **验收**：HITL 弹窗显示「团队操作 · 派任务」类文案，不再出现「外部工具」；风险仍以 bridge 的 read/write 为准（不改变闸门语义）。

#### D2（P2）`team_task_add` 支持交付物 + 可见性提示

- **现状**：`team_task_add` 参数无交付物（`teamTools.ts:168-187`），与 A1 修好后的契约不一致；工具总数 >20 时 `team_*` 可能被 `tool_search` 隐藏，但描述没提示。
- **改法**：参数增加 `attachmentFileId`（string，可选，说明「来自共享文件库」），映射到 `attachmentFileId`（与 `team_task_update` 同名，工具参数统一 camelCase）；`SHARED_HEAD` 末尾加一句「若本轮工具列表里看不到 team_*，先 tool_search(团队)」。
- **验收**：`team_task_add` 传入 `attachmentFileId` 后任务带该 id；描述包含检索提示。

---

## 2. 契约变更清单（跨端）

| 契约 | 变化 | 兼容性 |
|---|---|---|
| `CreateTeamTaskBodySchema` | + `attachmentFileId?` | 向后兼容（新增可选） |
| `GET /api/team/activities` | + 可选 `beforeId` | 旧客户端不传 = 旧行为 |
| `TeamActivityInputSchema` | task/agenda 的 `detail`/`status` 白名单化 | 只影响新写入；旧数据读取不校验 |
| `team_task_add` 参数 | + `attachmentFileId` | 新增可选参数 |
| HITL `classify.ts` | + `team_` 展示名/来源 | 纯展示 |

> 不改：权限模型、E2E、隐私分层（全站摘要 / 工作台成员可见）、共享开关默认全关、`heming.team.share.v1` 结构、13 条工作台 REST 的路径与方法。

---

## 3. 实施分工与写入边界（并行会话）

| 角色 | 文件 | 条目 |
|---|---|---|
| Lead | `packages/web/src/components/TeamPage.tsx`、`TeamBoardPage.tsx`、`lib/team/labels.ts`（新）、`store/ui.ts`、对应测试、文档/版本/CHANGELOG | A5/A6/A7、B1/B2/B3、C2/C3、C1 的 UI 派生 |
| impl-server | `packages/shared/src/schemas.ts` + 测试、`packages/server/src/{app,store,sqliteStore}.ts` + 测试、`packages/web/src/lib/api.ts` + `api.test.ts`、`lib/capability/teamTools.ts` + 测试、`lib/hitl/classify.ts` + 测试 | A1/A2（后端+客户端封装）、C1 契约、D1/D2 |
| impl-workspace | `packages/web/src/components/team/*`（Workspace/Plan/Task）+ 测试、`lib/format/datetime.ts`（新）+ 测试 | A3/A4、B4 |

写入边界是建议性的：同一文件只归一个所有者；Lead 负责最终合并后的全量门禁与真机复验。

---

## 4. 本轮明确不做（沿用历史决策 + 本轮判断）

| 不做 | 理由 |
|---|---|
| 邀请链接/公开注册、成员管理（全站层） | d.89/d.93 产品决策：注册由管理员在服务端控制；本轮只做「说清楚」 |
| 多团队/部门/组织树、跨团队可见性 | d.54 决策；d.93 用工作台承载项目组 |
| 任务评论 / @ 提醒 / 变更历史 / 看板拖拽 / 方案层级 | d.93 §7；真做起来是另一套 IM，超出优化轮 |
| 交付物在线预览 / 任务行内嵌预览 | d.93 §7；本轮只修「创建时丢失」，文件预览另立 |
| 给智能体的删除类工具、智能体只读全站名册/动向工具 | d.93 §5；全站层涉及隐私口径，需单独评审 |
| 共享写侧配额/频控、`occurredAt` 未来护栏、每 actor 行数上限 | 需产品先定数值与淘汰语义；本轮只记录在 api 报告 P1-4 |
| SQLite 多语句事务、`orderIndex` 边界、错误文案全量中文化、名册 avatar 轻量化、时间归一化 | 非用户可见或跨端收益低；记入后续候选（api 报告 P2） |
| 「记住允许 team_task_add」资源粒度 | 跨 HITL 模块决策，不在本轮 |
| 看板成员 chips 下拉/横向滚动之外的重构 | 本轮只做单行不折行 |
| 「有卡点」状态可达路径（browser P2-7：状态循环进不去 blocked） | 需要产品定交互（下拉 / 长按 / 右键菜单），本轮只记录 |
| 删除任务/团队后交付物文件清理（browser P2-8） | 文件在共享库、跨团队可能复用；本轮只在确认框如实说明「文件仍保留」，不做级联删除 |
| web 入口 favicon 404（browser P3-1） | 与团队功能无关，避免扩大发版面；单独小改 |

---

## 5. 验证

### 5.1 门禁

```bash
cd /d/Heming/.worktrees/team-optimize
pnpm -r build
pnpm --filter @heming/shared test
pnpm --filter @heming/server test
pnpm --filter @heming/web test
pnpm --filter @heming/desktop test      # 源码守卫（版本/CHANGELOG/打包），耗时约 1–2 分钟
pnpm -r typecheck
```

### 5.2 新增/修改用例（最低要求）

| 文件 | 用例 |
|---|---|
| `packages/server/src/teamWorkspace.test.ts` | 创建任务带 `attachmentFileId` → 201 返回该 id + 快照可见；不带 → null |
| `packages/server/src/storeContract.test.ts` | 同 `occurredAt` 三条：排序稳定（`id DESC`）、`beforeId` 分页不丢不重；memory 与 sqlite 双跑 |
| `packages/server/src/team.test.ts` | `beforeId` 参数、非法 `beforeId` 400；agenda/task 的非法 detail/status 400（中文文案） |
| `packages/web/src/components/TeamPage.test.tsx` | 深链未命中 5s 消费且不强制切 Tab；高亮 2.4s 消失；日程错误态；成员详情 3 条 + 排行点选；0/3 说明；条目可点选中成员；看板不再发请求（宿主数据） |
| `packages/web/src/components/TeamBoardPage.test.tsx` | 受控 props 渲染、筛选互通、卡片点击、错误 `role=alert`、chips `aria-pressed`、无 footer 重复句 |
| `packages/web/src/components/team/TeamWorkspace.test.tsx` | 截止时间本地化展示 + 已逾期；刷新按钮/轮询调用；删除/移除走 ConfirmDialog；notice 3s 消失 |
| `packages/web/src/lib/capability/teamTools.test.ts` | `team_task_add` 带 attachment；描述含 tool_search 提示 |
| `packages/web/src/lib/hitl/classify.test.ts` | `team_*` 显示名/source/参数摘要 |
| `packages/web/src/store/ui.test.ts` | `setPage` 清理两个 team 焦点槽 |
| `packages/web/src/lib/team/labels.test.ts`（新） | task/agenda 状态 → 标签映射；未知状态不显示自由文本 |

### 5.3 真机复验（浏览器）

- 覆核 A3（截止时间本地化）、A4（刷新）、A5（深链高亮褪去）、A6（日程错误态）、A7（0/3 说明）、B1（成员详情）、B2（看板共享数据/筛选互通）、B4（确认弹窗）、C1（日程不显示正文）、C2/C3（文案）。
- 1600×1000 与 1100×800、暗色、控制台 0 error；数据用 CDP 拦截伪造，不写库；测试用自建团队删除、共享开关还原。

### 5.4 发布口径

- 本轮**不部署、不发安装包**（未收到发布指令）；只提交分支与门禁证据。
- 若后续要发：`docs/VERSION-MANAGEMENT.md` 的顺序（bump → CHANGELOG → build-changelog → 打包 → 部署 → 标签）不变。

---

## 6. 风险与回滚

| 风险 | 处置 |
|---|---|
| 契约收紧（detail/status 白名单）拒绝旧客户端/旧脚本 | 只对**新写入**生效，读侧不校验；`share.ts` 现有输出已符合；测试覆盖合法/非法两路 |
| 看板改为宿主数据后只看到已加载的前 50 条（原 100） | 与动向同源是本次目标；如需更多，后续把 `PAGE_SIZE` 调大或给看板单独「加载更早」 |
| 工作台 45s 轮询增加请求 | 只在工作台 Tab 挂载时跑、busy 跳过；比看板原 30s 轮询更轻 |
| 深链兜底 5s 可能误清「稍后才到」的意图 | 只清一次并给可见说明；命中路径不受影响 |
| 一次改 16 项、跨 3 个并行写者 | 按 §3 文件边界分工；Lead 合并后跑全量门禁 + 真机复验；任何一项失败可单独回退该文件 |

---

## 7. 与历史文档的关系

- 本规格取代/补充：d.87 团队审计的 P2 剩余项、d.89 §7 与 d.91 §5「未做」清单、d.93 §7 边界（不变）。
- 看板定位（历史三次挂账）本轮**定为方案 A**：动向 = 时间流主入口；看板 = 同一份摘要的两列只读盘，共用宿主数据与成员筛选。
- `docs/INDEX.md` 增补本条；`CHANGELOG.md` 与 `docs/RELEASE-NOTES.md` 在收尾时补 d.112 条目。
