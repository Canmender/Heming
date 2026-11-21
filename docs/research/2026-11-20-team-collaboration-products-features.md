# 团队协作类项目功能调研：功能、核心能力与机制

> 日期：2026-11-20　｜　范围：市面团队协作类产品的功能盘点与核心机制提炼。
> 与 `2026-11-20-team-collaboration-research.md`（和鸣自身差距与改进方案）配套：那份讲"和鸣差在哪、怎么改"，这份讲"业界怎么做、核心是什么"。
> 方法：四路并行调研，覆盖 35+ 产品。因本环境 `web_search` API 401 失效，各路改用 `web_fetch` 直抓官方页 / `llms.txt` 索引 / GitHub raw README / 文档站作为一手来源，关键结论附官方 URL。个别产品（Discord、Google Workspace、飞书项目、Asana/GitHub/Cursor 部分机制）一手正文抓取受限，文中标"低置信/待核实"，勿当定论。

---

## 摘要（TL;DR）

调研 35+ 款团队协作产品后，可以把它拆成**四个品类**：项目管理/任务协作（Linear、Jira、ClickUp…）、沟通协作套件（Slack、Teams、飞书…）、AI 原生协作（Devin、Linear Agents、Notion 3.0…）、开源自托管（Plane、Vikunja、Zulip…）。四类产品的核心能力高度趋同，可以归纳为**一套共识模型**：

1. **三层容器 + 成员关系解耦**：`工作区/组织 → 团队/空间 → 项目/看板 → 工作项`。团队是权限、视图、工作流的核心隔离边界；"人-团队"用多对多关联，支持一人多队。
2. **工作项一等公民 + 多视图**：issue/task 带状态/负责人/截止/标签/依赖，看板/列表/时间线多视图 + 拖拽 + 批量操作。
3. **协作三件套**：评论/@提及/通知、subtask、指派，普遍还有自动化规则（trigger-condition-action）。
4. **双层权限**：工作区级粗粒度角色 + 对象级细粒度授权，guest 白名单做硬隔离。
5. **AI 已成标配**：辅助型（摘要/NL 查询/MCP）全覆盖，执行型（可被指派的 AI teammate / agent）是 2026 年的分水岭。

对和鸣最关键的三条结论：
- **多团队隔离**：Zulip 的"一实例多 realm、一人多 realm、完全隔离"和 Linear 的"成员关系与指派解耦 + 只加载已加入团队"是要照抄的架构范本。
- **加入机制**：Teams/Slack 的"创建即所有者 + 公开/私有可见性 + 发现目录 + 申请-审批闭环"与消息流解耦，可安全借鉴（符合去 IM）。
- **Agent Delegation（而非成员化）**：业界"成员化但责任不转移"（人类主 assignee、Agent 作 contributor）+ 最小权限/可撤销/全审计的思路可借鉴其**委派与审计机制**；但**和鸣明确不让智能体成为团队成员**（智能体存储在用户本地、使用用户自己的 API，无法作为服务端可管理的成员），故只取"委派/审计/权限"思想，不取"成员身份"。详见第三节末尾与配套方案文档。

---

## 一、品类一：项目管理 / 任务协作

覆盖 Linear、Jira、Asana、ClickUp、Monday、Notion、飞书项目、Trello、Basecamp。

### 1.1 功能矩阵（✓完整 ◐部分 ✗无）

| 产品 | 对象模型 | 任务工作流 | 协作机制 | 项目规划 | 权限成员 | 报告度量 | AI |
|---|---|---|---|---|---|---|---|
| Linear | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Jira | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Asana | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| ClickUp | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Monday | ✓ | ✓ | ✓ | ◐ | ✓ | ✓ | ✓ |
| Notion | ◐ | ◐ | ✓ | ◐ | ◐ | ◐ | ✓ |
| 飞书项目 | ✓ | ✓ | ✓ | ✓ | ✓ | ◐ | ✓（受限）* |
| Trello | ◐ | ✓ | ◐ | ◐ | ◐ | ◐ | ◐ |
| Basecamp | ◐ | ◐ | ✓ | ◐ | ◐ | ◐ | ✗ |

\* 飞书项目公开权威文档抓取受限，细节待核实。

### 1.2 核心机制要点

- **Linear**（研发导向，对象模型最干净）：Issue 为核心单元，**必属且仅属一个 team**、连续递增 ID；字段 status/priority/assignee/estimate(斐波那契)/cycle/labels/project/milestone。Board/List/Timeline 视图、批量改属性、跨 team 移动 issue（生成新 ID，cycle/label 可能清除、relation/priority 保留）。角色 owner/admin/**team owner**/member/**guest**；private team、sub-team（权限不继承）。Cycles=team 级 time-box（不可跨 team 同时查看）；Milestones 按 issue 状态自动算进度。来源：https://linear.app/docs/teams.md 、https://linear.app/docs/members-roles.md
- **Jira**（可配置性最强）：Project>Issue(epic/story/subtask)，字段/状态机高度可定制；Scrum/Kanban、Automation for Jira（无代码 trigger+condition+action）；细粒度 scheme 权限；Atlassian Intelligence（NL→JQL、AI 摘要）+ Rovo（企业搜索/自定义 agent）。来源：https://www.atlassian.com/llms.txt
- **Asana**（"人+AI agent 协作操作系统"）：Work Graph 统一映射人/agent/task/request/project/goal/dependency；**AI Teammates**（30+ 预置，像人一样指派，各有身份/权限/预算/审计）、AI Studio（无代码 AI 工作流）、MCP。来源：https://asana.com/llms.txt
- **ClickUp**（层级最完整）：**Workspace>Space>Folder>List>Task>Subtask**（官方推荐"一团队一 Space、一项目一 Folder/List"），状态各级自定义并向下继承；状态组 Active/Done/Closed（Done 清除依赖、不算逾期）；**依赖 blocking/waiting-on，blocking 日期变动自动顺延依赖任务**；全视图 + 自动化 + 字段级 private。来源：https://help.clickup.com/hc/en-us/articles/20480724378135
- **Monday**（表格即看板）：Workspace>board>group>item>subitem；**group 按 status 动态分组** + 自动化"status 改变即移动到 group"；board 三型 Main/Private/Shareable；列级查看/编辑限制；权限集 "only edit assigned items"，guest 看不到 workspace 名。来源：https://support.monday.com/hc/en-us/articles/360019222479-Permissions-on-monday.com
- **Notion**（数据库即项目，灵活但开箱即用最弱）：Database=自定义 page/属性，多视图 board/calendar/timeline/list/table；**页面级访问规则（按 assignee/owner 自动授权）**；Notion AI。来源：https://www.notion.com/product/projects
- **Trello**（最轻量）：Board>List>Card，深度依赖 Power-Ups；Butler 自动化（rules/buttons/scheduled）。来源：https://trello.com/llms.txt
- **Basecamp**（反复杂度）：每项目独立 page 按需加工具；**Hill Charts**（真实进度/卡点）、**Automatic Check-ins**（定时重复提问如每周一"在做什么"，答案归档）、The Lineup（所有项目按起止日期排时间线）、Client mode 逐项目控制客户可见内容；无内建 AI，提供 API/CLI 欢迎外部 agent。来源：https://basecamp.com/features

### 1.3 这类产品的核心功能共识

**标配（9 款几乎全有）**：①工作项为核心 + 状态/负责人/截止/标签字段；②看板/列表视图 + 拖拽 + 批量操作；③评论/@提及/通知/subtask/指派；④自动化规则；⑤权限分层（owner/admin/member/guest）+ 空间/项目隔离；⑥dashboard/report；⑦截至 2026 年 AI 已标配（摘要、NL 查询、agent、MCP 几乎全覆盖，Basecamp 是唯一只走"开放接口"的例外）。

**差异化**：对象模型粒度（Linear/Jira 强 schema vs Notion/Trello 弱 schema）；规划深度（Jira Align/Linear Cycles/Asana Portfolios 强，Basecamp 走 Hill Chart 极简）；依赖自动排程（ClickUp 自动顺延、Linear 项目依赖领先）；AI 形态（Asana/Jira 走"执行型 agent"，其余多为"辅助型"）。

### 1.4 多团队/多项目切换与隔离（对和鸣的直接参考）

1. **容器层级**：`Workspace/Account → Team/Space → Project/Board → Issue/Task`。**"团队"是权限、视图、工作流配置的核心边界**。
2. **一人多队与解耦**：Linear 明确"任何人都可在未加入的 team 建/被指派 issue"——成员关系与指派解耦；侧边栏**只展示已加入的 team**（团队无上限时避免 UI 爆炸）；Monday 文档确认 members 可加入多个 workspace/project。
3. **隔离机制**：硬隔离（private team/space/board + guest 白名单，guest 看不到 workspace 名）；软隔离（容器共享 + 数据行级过滤，Linear 多 team 项目里 guest 见项目外壳但只看自己 team 的 issue）——非常适合"一人多团队、看板按团队切换"。
4. **切换成本**：Linear Cycles 不可跨 team 同时查看；跨 team 移动工作项必须定义 ID 策略、字段映射、依赖/周期清理规则。

**给和鸣的建议**：①工作项强绑定归属团队（单一归属）+ 允许跨团队引用；②看板以"当前团队"为作用域，切换即过滤数据源；③权限用"角色(workspace) + 成员关系(team) + 行级过滤(item)"三层叠加；④团队无上限时导航只加载"已加入"团队，并用全局搜索/聚合页兜底（参考 Basecamp Everything pages、Linear Insights）。

---

## 二、品类二：沟通协作套件

覆盖 Slack、Microsoft Teams、Discord、飞书、钉钉、Notion、Google Workspace。

### 2.1 功能矩阵

| 产品 | 工作区/团队结构 | 沟通机制 | 任务结合 | 文档/知识 | 成员/权限 | 机器人/生态 | AI |
|---|---|---|---|---|---|---|---|
| Slack | ✓ workspace→频道、多工作区切换 | ✓ 频道/DM/线程/@/未读/表情 | ✓ Lists/提醒/待办/审批 | ✓ Canvas/全局搜索 | ✓ 角色/访客/用户组/SAML·SCIM | ✓ 2600+应用/Webhook/Workflow Builder | ✓ Slack AI |
| Microsoft Teams | ✓ team→频道(≤1万) | ✓ 频道/聊天/线程/@/翻译 | ✓ Planner/Copilot 自动建任务 | ✓ SharePoint/Loop/版本控制 | ✓ owner/member/moderator/访客/B2B | ✓ bot/Power Platform | ✓ Copilot |
| Discord ⚠ | ✓ 服务器→分类→频道 | ✓ 频道/DM/线程/@/表情 | ◐ 无原生任务靠机器人 | ◐ 线程+搜索 | ◐ 角色细/邀请链接 | ✓ bot/Webhook/丰富API | ◐ 低置信 |
| 飞书 | ✓ 企业→团队/群组 | ✓ 消息/话题/@/已读 | ✓ 任务/审批流(强项) | ✓ 飞书文档/知识库 | ✓ 角色/外部成员/邀请审批 | ✓ 开放平台API | ✓ AI |
| 钉钉 | ✓ 组织→部门/群 | ✓ 消息/DING/已读 | ✓ 审批流(强项)/待办 | ✓ 钉文档/知识库 | ✓ 角色/外部联系人/入群审批 | ✓ 开放平台 | ✓ 千问办公 |
| Notion | ◐ workspace→teamspace→page | ◐ 评论/@非实时IM | ✓ 数据库/项目/任务 | ✓ 文档/Wiki/知识库 | ✓ 角色/权限组/访客 | ✓ Connections/Marketplace | ✓ Notion AI/Agents |
| Google Workspace ⚠ | ◐ 组织→Chat space | ◐ Space/线程/@ | ◐ Tasks/Apps Script | ✓ Docs/Sheets共编+Drive | ✓ 管理角色/外部分享 | ✓ Apps Script | ✓ Gemini 低置信 |

⚠ Discord/Google Workspace 官方页抓取失败，相关格为低置信。

### 2.2 核心功能共识

1. **分层容器**：顶层工作区/组织 → 子团队/频道；子空间分**公开（可发现/可加入）与私有（受邀/审核）**，这是权限与搜索的基本边界。
2. **上下文绑定**：讨论、文件、任务、决策都挂在"频道/空间"而非散落私聊，形成**可检索的组织记忆**（Slack、Teams 均强调 history 自动保存可搜）。
3. **消息即任务**：Slack Lists 可指派负责人/截止日；Teams Copilot 从会议纪要检测决策与后续并自动建任务、设期限。
4. **异步降噪**：线程、@提及、关键词通知、免打扰、未读管理、表情回应成标配。
5. **人机协同**：无代码工作流 + bot/webhook + AI 摘要/搜索/自动分派是共同方向。

### 2.3 团队创建/加入/发现机制（对和鸣社交化加入的纯成员管理提炼）

这些机制**与消息流解耦的部分**才值得借鉴：

- **创建即所有者/队长**：Teams 创建者成为 team owner 可加 co-owner；Slack 创建者为工作区所有者并可转移所有权 → 和鸣"创建即队长"有直接对应。
- **公开/私有两种可见性**：Teams 公开 team 组织内任何人可自行加入、私有须邀请；Slack 公开频道可被发现加入、私有须成员添加 → 抽象为"团队可见性=公开搜索可见/私有隐藏"。
- **发现能力**：Slack 有 workspace discovery、Discovery APIs、频道建议、workspace creation requests；Discord 靠第三方 DISBOARD → 和鸣"搜团队"应做**第一方目录 + 搜索/推荐**。
- **申请-审批闭环**：Slack "请求加入/审批应用"、Teams invite + guest 审批 → 提炼为通用"申请→队长审批→变更成员"状态机，与是否 IM 无关。
- **外部成员**：Slack guests、Teams guests/B2B、Notion 访客、钉钉外部联系人——统一"外部成员"角色，权限受限。
- **角色粒度**：owner/member/moderator（Teams 频道版主）+ 权限组（Notion）——队长/队员之外可扩展版主/访客。

来源：https://slack.com/help/articles/360017938993-What-is-a-channel 、https://learn.microsoft.com/en-us/microsoftteams/teams-channels-overview 、https://www.notion.com/ 、https://open.feishu.cn/document/home/index 、https://open.dingtalk.com/document/orgapp/introduction

### 2.4 去 IM 后不要照搬的部分（和鸣已拍板）

本质是 IM 范式、去 IM 后无承载对象，应明确不做：频道内实时聊天流、DM、线程回复、未读计数、表情回应（依赖"消息"原子对象）；语音视频、消息翻译、屏幕共享、AI 会议听记（依赖实时音视频）；"消息转任务"应改造为"对象转任务"（任务/文档/项目卡片直接指派，而非从聊天记录提取）；bot/slash 命令触发器改为"对象状态变更 + 工作流"自动化；跨组织协作重建为"共享对象/空间"而非"共享聊天频道"。

---

## 三、品类三：AI 原生协作（Agent 委派与协作）

覆盖 Linear、Devin、Claude Cowork、Notion 3.0、ChatGPT/OpenAI、Slack、Manus、Asana、GitHub Copilot、Cursor。

### 3.1 各产品关键机制

- **Linear**（成员化最完整）：Agent 是 workspace **正式成员**，可 @、指派 issue、加入项目；核心原则**"委派任务但不委派责任"**——人类仍是主 assignee，Agent 作 contributor；不计席位、不能登录/管管理员；第三方 Agent 安装按 team 授权；Loops 支持定时(含时区)/issue/PR 事件/webhook/Slack 触发，可配 code access(禁用/只读/读写)、per-tool"始终批准"、run history 审计与追问、版本回滚。来源：https://linear.app/docs/agents-in-linear.md 、https://linear.app/docs/loops.md
- **Devin**：Slack/Teams @ 或 CLI `/handoff` 派单；会话内嵌 IDE+shell+browser 可实时跟随/接管；知识入职"像给新员工做 onboarding"，迁移到 Skills/Plugins（skills+rules+hooks+MCP+subagents，个人/组织/企业三级治理、按 SHA 固定）；产出 draft PR 回收审查；有 schedules/automations/API。来源：https://docs.devin.ai/product-guides/plugins.md
- **Claude Cowork**：**非团队共享**（会话不可分享，仅产出物可分享）；chat↔Cowork 双向记忆、Projects 持久 workspace；子 agent 并行分解；三种权限模式(Manual/Auto/Skip) + 连接器逐项授权、删除需显式许可；OTel 把工具调用/文件访问/人工审批推 SIEM；手机 Dispatch 远程派单。来源：https://support.claude.com/en/articles/13345190-get-started-with-claude-cowork
- **Notion 3.0**：Agent 可命名+装扮头像；指定一页作 **memory bank**；单次自主约 20 分钟、跨数百页；"团队 Custom Agents"预告可共享、各专精、定时/触发自动跑；同期上线 database 行级权限。来源：https://www.notion.com/blog/introducing-notion-3-0
- **ChatGPT/OpenAI**：Workspace agents 有团队目录（图标+创建者+简介）；**dots** 常驻 agent 跨会话持续推进；并行多 agent + 进度可视 + 复盘；scheduled tasks 支持 Gmail/Slack/GitHub webhook、敏感动作暂停待审；Codex Cloud 每任务隔离 workspace。来源：https://openai.com/business/workspace-agents/
- **Slack**：Slackbot = "AI teammate"，@ 进频道协作；MCP client 把请求**路由给专精 agent**并把结果送回对话。来源：https://slack.com/features/slackbot 、https://slack.com/features/agentic-platform
- **Manus 2.0**：Cascade harness 按需加载能力（实测省 23% token、快 28%）；Cloud Computer 常驻环境；Automations 定时+事件；Studio="人和 AI 共享工作区"；可编辑时间线"hand it back"续作。来源：https://manus.im/blog/introducing-manus-2-0
- **Asana / GitHub Copilot / Cursor（资料有限，仅方向参考）**：Asana "human-agent teams"；Copilot issue→PR 全流程、可把 issue 派给 agent、隔离沙箱分支；Cursor 主打云/后台 agent。

### 3.2 功能矩阵（✓完整 ◐部分 ✗无/未证实）

| 产品 | 成员身份 | 委派派单 | 多Agent编排 | 状态可见 | 知识上下文 | 权限沙箱 | 人机同流 |
|---|---|---|---|---|---|---|---|
| Linear | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Devin | ◐ | ✓ | ◐ | ✓ | ✓ | ✓ | ✓ |
| Cowork | ✗ | ◐ | ✓ | ✓ | ✓ | ✓ | ◐ |
| Notion | ◐ | ✓ | ◐ | ◐ | ✓ | ◐ | ◐ |
| ChatGPT | ✓ | ◐ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Slack | ✓ | ◐ | ✓ | ◐ | ✓ | ◐ | ✓ |
| Manus | ◐ | ◐ | ◐ | ◐ | ◐ | ◐ | ✓ |
| Asana* | ◐ | ◐ | ◐ | ◐ | ◐ | ◐ | ◐ |
| GitHub* | ◐ | ✓ | ✗ | ◐ | ◐ | ✓ | ✓ |
| Cursor* | ◐ | ◐ | ◐ | ◐ | ◐ | ◐ | ◐ |

\* 低置信，未经一手正文核实。

### 3.3 AI 原生协作的核心功能共识

1. **委派成为一等原语**：从"聊天"升级为"可指派的工作单元"——issue/task 指派、@提及、定时/事件/webhook 三条入口并存。
2. **成员化但责任不转移**：Agent 有名字/头像/身份、可被 @，但人类保留主责（Linear assignee+contributor 是范本）。
3. **进程外持久 + 状态外露**：云端脱离本机运行，进度/推理/日志实时可见，支持中途纠偏与事后复盘。
4. **共享上下文是护城河**：workspace 级记忆、项目指令、跨工具检索（MCP/连接器）比模型能力更决定协作质量。
5. **权限分层 + 人在回路**：只读/读写、工具逐项审批、敏感动作暂停、沙箱、审计流(SIEM/OTel)、可撤销——规模化落地前提。
6. **人机交接闭环**：draft PR / 可编辑产物 → 人修改 → "hand it back"继续，形成往返而非一次性生成。

### 3.4 对和鸣的参考价值（重要约束：Agent 不作为团队成员）

**产品约束（用户明确）**：和鸣的智能体**存储在用户自己的机器上、使用用户自己的 API**，因此**不让智能体成为团队成员**——服务端没有、也不应有 Agent 的成员记录/席位/账号。智能体是用户个人的"能力延伸"，不是团队里可被服务端指派的"人"。上一版"Agent 成员化"的建议据此作废，改为以下**委派式协作**范式（只借鉴业界机制，不引入成员身份）：

- **身份层（不做成员，做任务标注）**：不建 Agent 成员记录、不进 `team_members`、不可被 @ 当作成员。任务上只用字段标注"由某人的本地智能体协助完成"（如 `assistedByAgent`、`agentOwnerId=用户 id`），责任始终归属于人类用户——与业界"责任不转移"原则一致，但落点从"成员身份"改为"任务上的协助标注"。
- **委派层（本机执行 + 人回填）**：`agent_task/agent_team/workflow_run` 仍是本机派发，用户自己的 API；结果由用户**审核后手动/半自动回填**到团队任务 `result`（HITL）。统一入口是"人在会话里委派 → 审核产出 → 回填团队"，而非"团队把任务指派给 Agent 成员"。
- **编排层**：`agent_team` 的 planner/worker/critic 分工属于用户本机的编排能力，团队侧只消费最终产出；团队 workflow 如需自动化，触发的仍是"某个用户在其本机执行"，服务端只记录任务状态，不托管智能体进程。
- **可见/审计层**：团队侧展示"该任务由 XX 的智能体协助、XX 已确认"的摘要（写进 `team_events`），不暴露 Agent 的工具轨迹/提示词；完整轨迹留在用户本机，遵循隐私红线。
- **权限/知识层**：智能体访问团队数据 = 用户以本人成员身份访问（复用 `visibleTeam()/teamMemberRole()` 做服务端校验），不引入独立 Agent 授权主体；团队知识库由成员（人）读取后按需提供给本机智能体，智能体不直接连服务端知识库（见知识库方案文档）。

**关键取舍**：和鸣的差异化恰恰是"智能体归用户所有、用用户自己的 API"——这是隐私卖点，不该为了"看起来像团队成员"而把智能体搬到服务端。正确方向是**强化本机委派体验 + 人审核回填团队**，而非 Agent 成员化。

---

## 四、品类四：开源 / 自托管

覆盖 AppFlowy、Docmost、AFFiNE、Outline、Plane、Vikunja、Focalboard、Mattermost、Zulip、Rocket.Chat、Nextcloud、Taiga。

### 4.1 逐产品核心能力

- **AppFlowy**（AGPL-3.0，Flutter+Rust）：文档块/数据库行；Kanban、Databases、Docs、Team Wiki "Ask AI"、AI 摘要；Docker/源码。来源：https://raw.githubusercontent.com/AppFlowy-IO/AppFlowy/main/README.md
- **Docmost**（AGPL-3.0 核心+EE）：三级模型 **Workspace → Space → Page**；角色 Owner/Admin/Member；Space 级 Full Access/Can Edit/Can View；**Groups 批量授权（默认 Everyone 组，多路径取最高权限）**；实时协作、Draw.io/Excalidraw/Mermaid、评论、页面历史、Algolia 搜索、AI、MCP。来源：https://raw.githubusercontent.com/docmost/docmost/main/README.md 、https://docmost.com/docs/user-guide/spaces
- **AFFiNE**（CE MIT）：Docs/白板/表格"超融合"，多视图 database；**local-first（y-octo：Rust 版 Yjs CRDT）**；实时协作；Electron 桌面 + Docker。来源：https://raw.githubusercontent.com/toeverything/AFFiNE/master/README.md
- **Outline**（BSL 1.1 非纯 OSI）：Collection/Document；**cancan policy 集中授权**（`policies/`）；Sequelize(Postgres)+Redis；知识库定位，无任务看板。来源：https://raw.githubusercontent.com/outline/outline/main/docs/ARCHITECTURE.md
- **Plane**（AGPL-3.0，开源 Linear 替代）：Work Item；Cycles（燃尽图）、Modules、Views（可保存/共享筛选视图）、Pages（带 AI）、Analytics；Django+React；Docker/K8s/All-in-one。来源：https://raw.githubusercontent.com/makeplane/plane/preview/README.md
- **Vikunja**（AGPL-3.0）：task/project；List/Gantt/Kanban/Table 四视图；指派、截止、重复、子任务、标签、**跨项目 Relations**、saved filters、CalDAV、免注册分享链接；权限极简**整数 0 只读/1 读写/2 Admin + team admin 布尔位**；Go 单二进制 + 桌面端。来源：https://vikunja.io/docs/permissions/
- **Focalboard**（仓库已标注**停止维护**）：Trello 替代；**桌面端把 server 打包本地跑 SQLite** —— 单机桌面集成的现成先例。来源：https://raw.githubusercontent.com/mattermost/focalboard/main/README.md
- **Mattermost**（核心 MIT）：team→channel→post；Chat + 工作流自动化 + AI；Go 单二进制 + **PostgreSQL**；多 team 切换。来源：https://raw.githubusercontent.com/mattermost/mattermost/master/README.md
- **Zulip**（Apache 2.0）：**realm(org)→stream→topic→message**；独特 topic-based threading；**一个 server 托管多个 realm（各自子域），一人可属多个 realm，完全隔离**；Python/Django + Tornado 推送。来源：https://raw.githubusercontent.com/zulip/zulip/main/docs/overview/architecture-overview.md
- **Rocket.Chat**（MIT）：team/channel；RBAC + ABAC、E2E 加密、federation、air-gapped、Apps-Engine。来源：https://raw.githubusercontent.com/RocketChat/Rocket.Chat/develop/README.md
- **Nextcloud**（AGPL）：文件为中心，靠 App 扩展协作（Talk 通话/Deck 看板/Documents）。来源：https://raw.githubusercontent.com/nextcloud/server/master/README.md
- **Taiga**（MPL-2/AGPL）：敏捷项目管理 backlog/sprint/看板/issue tracker；REST/Webhook/GitHub/GitLab/Slack 集成。来源：https://docs.taiga.io/

### 4.2 功能矩阵（✓完整 ◐部分 ✗无）

| 产品 | 文档KB | 任务/看板 | 沟通IM | 多团队/工作区 | 角色权限 | @/通知/评论 | 自托管 | AI |
|---|---|---|---|---|---|---|---|---|
| AppFlowy | ✓ | ◐看板/数据库 | ✗ | ◐ | ◐ | ◐评论 | ✓ | ✓ |
| Docmost | ✓ | ✗ | ✗ | ✓Space | ✓组+空间 | ◐评论 | ✓ | ✓ |
| AFFiNE | ✓ | ◐多视图表 | ✗ | ◐ | ◐ | ◐ | ✓ | ✓ |
| Outline | ✓ | ✗ | ✗ | ◐Collection | ✓cancan | ◐评论 | ✓ | ◐ |
| Plane | ◐Pages | ✓ | ✗ | ✓Workspace | ✓ | ◐评论 | ✓ | ✓ |
| Vikunja | ✗ | ✓ | ✗ | ✓项目/团队 | ✓整数0/1/2 | ◐指派通知 | ✓ | ✗ |
| Focalboard | ✗ | ✓看板 | ✗ | ◐Board | ◐ | ◐评论 | ✓SQLite桌面 | ✗ |
| Mattermost | ✗ | ◐插件 | ✓ | ✓Team | ✓ | ✓ | ✓ | ✓ |
| Zulip | ✗ | ✗ | ✓ | ✓多realm | ✓话题订阅 | ✓ | ✓ | ◐ |
| Rocket.Chat | ✗ | ✗ | ✓ | ✓Team | ✓RBAC/ABAC | ✓ | ✓ | ◐ |
| Nextcloud | ◐ | ◐Deck App | ◐Talk | ◐ | ✓ | ◐ | ✓ | ◐ |
| Taiga | ◐Wiki | ✓ | ✗ | ◐项目 | ✓ | ◐通知 | ✓ | ✗ |

### 4.3 核心功能共识

1. **容器分层是通用范式**：工作区/组织 → 空间/项目/团队 → 内容对象（Docmost、Zulip、Mattermost、Vikunja 皆然）。
2. **权限普遍双层**：工作区级粗粒度角色 + 对象级细粒度授权；组批量授权 + 多路径取最高权限（Docmost）是成熟做法。
3. **看板≠沟通**：任务类（Plane/Vikunja/Taiga/Focalboard）与 IM（Mattermost/Zulip/Rocket.Chat）边界清晰，鲜有原生融合。
4. **local-first + CRDT 成新趋势**（AFFiNE/AppFlowy）。
5. **AI 从"附加"变"内嵌"**：文档类普遍内建 Ask AI/摘要/生成；任务类（Plane Pages）也嵌入。

### 4.4 对和鸣的参考价值（SQLite 本地桌面智能体，无上限多团队、去 IM）

- **数据模型**：Docmost `Workspace→Space→Page` + Space 独立权限最贴合"一人多队、团队隔离"——把团队映射为 Space，成员表用 `(team_id, user_id, role)` 关联；Zulip 的 realm 隔离是"完全隔离"的架构范本。
- **权限模型**：**Vikunja 整数权限 0/1/2 + team admin 布尔位**极轻量，最适合 SQLite 本地应用；进阶叠加 Docmost Group 批量授权；Outline cancan 集中策略可用于权限逻辑收口（本地简化为单一 `permissions.ts`）。
- **多团队切换**：Mattermost `team→channel` + 团队切换器是成熟 UX；Plane "按工作区隔离视图/筛选"可参考——看板按团队切换时只查当前 `team_id`。
- **适合本地的轻量组合**：①Focalboard 式"桌面内嵌 server + SQLite"（印证可行）；②Vikunja 三档整数权限；③一张关联表 + `team_id` 外键行级隔离（替代 Zulip 多库/子域的重型隔离）；④谨慎引入 AFFiNE 的 y-octo CRDT——若暂不做实时多人协同编辑，保留 SQLite 单写模型更简单。

**结论**：和鸣最优组合 = Focalboard 的本地 SQLite 部署形态 + Vikunja 的极简权限整数 + Docmost/Zulip 的分层隔离思想，避免引入 IM 与重型 CRDT。

---

## 五、横向总结：四类产品的核心功能全景

| 能力维度 | 项目管理类 | 沟通套件类 | AI 原生类 | 开源自托管类 | 和鸣现状对照 |
|---|---|---|---|---|---|
| 核心对象 | issue/task/project | 频道/消息/空间 | agent/委派/workflow | 视定位而异 | team_tasks + team_plans 已具备 |
| 容器分层 | Workspace→Team→Project | 工作区→团队→频道 | workspace（多为单） | Workspace→Space→realm | 已有 teams 表，多团队决策已确认待实现 |
| 多视图 + 拖拽 | ✓核心 | ✗ | ◐ | ✓（Plane/Vikunja） | 假看板待改造（见配套文档 1.2） |
| @/通知/评论 | ✓ | ✓核心 | ✓（@agent） | ◐ | 讨论仅文字留言、无@/通知 |
| 自动化规则 | ✓ trigger-condition-action | ✓ Workflow Builder | ✓ 定时/事件/webhook | ◐ | 依赖智能体工具，无用户侧自动化 |
| 权限分层 | 角色+guest+空间 | 公开/私有频道+角色 | 按 team 授权+逐项审批 | 整数/组/cancan | owner/member 两级、粗粒度共享 |
| AI 形态 | 辅助+执行型 | 摘要/搜索/分派 | 委派型 agent（业界多走成员化，和鸣不采用） | 内嵌 Ask AI | 19 个 team_* 工具，agent 本机私有、藏在会话页 |
| 隔离与切换 | 已加入团队过滤+行级过滤 | 多工作区/团队切换 | 多按单 workspace | realm/Space 完全隔离 | 切换器已有，口径待统一 |

**一句话结论**：团队协作产品的核心 = **"工作项一等公民 + 三层容器隔离 + 协作三件套 + 双层权限"**；2026 年的新变量是 AI agent 参与协作，但**和鸣走差异化路线——智能体归用户私有、不作为团队成员**，只借鉴业界的委派/审计/权限机制。和鸣已有工作项模型与工具底座，差距集中在**多团队隔离的口径统一、看板正名、通知/@、以及本机智能体产出向团队任务的审核回填**——这些在配套文档 `2026-11-20-team-collaboration-research.md` 与知识库方案文档中已有对应落点。

---

## 六、来源索引

- 项目管理类：https://linear.app/llms.txt 、https://www.atlassian.com/llms.txt 、https://asana.com/llms.txt 、https://www.notion.com/llms.txt 、https://trello.com/llms.txt 、https://help.clickup.com/hc/en-us/articles/20480724378135 、https://support.monday.com/hc/en-us/articles/360019222479-Permissions-on-monday.com 、https://basecamp.com/features 、https://project.feishu.cn/
- 沟通套件类：https://slack.com/help/articles/360017938993-What-is-a-channel 、https://slack.com/features/workflow-automation 、https://learn.microsoft.com/en-us/microsoftteams/teams-channels-overview 、https://www.microsoft.com/en-us/microsoft-teams/collaboration 、https://www.notion.com/ 、https://open.feishu.cn/document/home/index 、https://open.dingtalk.com/document/orgapp/introduction 、https://disboard.org/servers
- AI 原生类：https://linear.app/docs/agents-in-linear.md 、https://linear.app/docs/loops.md 、https://docs.devin.ai/get-started/devin-intro.md 、https://docs.devin.ai/product-guides/plugins.md 、https://support.claude.com/en/articles/13345190-get-started-with-claude-cowork 、https://www.notion.com/blog/introducing-notion-3-0 、https://openai.com/business/workspace-agents/ 、https://manus.im/blog/introducing-manus-2-0 、https://slack.com/features/agentic-platform
- 开源自托管类：https://raw.githubusercontent.com/docmost/docmost/main/README.md 、https://docmost.com/docs/user-guide/spaces 、https://raw.githubusercontent.com/makeplane/plane/preview/README.md 、https://vikunja.io/docs/permissions/ 、https://raw.githubusercontent.com/mattermost/focalboard/main/README.md 、https://raw.githubusercontent.com/zulip/zulip/main/docs/overview/architecture-overview.md 、https://raw.githubusercontent.com/outline/outline/main/docs/ARCHITECTURE.md 、https://raw.githubusercontent.com/AppFlowy-IO/AppFlowy/main/README.md 、https://raw.githubusercontent.com/toeverything/AFFiNE/master/README.md 、https://docs.taiga.io/

> 置信度说明：Discord、Google Workspace、飞书项目、Asana/GitHub/Cursor 部分机制因一手正文抓取受限，已在正文标 ⚠/* 或"待核实"，建议在正式决策前对这几款做二次核实。
