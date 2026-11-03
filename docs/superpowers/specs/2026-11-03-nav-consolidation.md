# 导航合并：13 项收成 9 项（d.67）

- 日期：2026-11-03
- 分支：`feat/d67-pet-nav`
- 版本：`d.67.2.25.0`
- 关联：`docs/HANDOFF.md` §2 当前状态、`docs/superpowers/specs/2026-11-03-d66-automation-execution-kernel.md`（规格写法）

---

## 1. 问题

用户报告：**「导航栏有的功能出现了重复，合并他们。」**

审计 13 个导航项后确认，重复不是「同一页渲了两次」，而是**同一份数据/能力被切成了两个入口**：

| 导航项 | 实际内容 | 与谁重复 | 证据 |
|---|---|---|---|
| 团队 | 成员名册 + 动向流（task/agenda）+ 日程 + 用量（已有 3 个 Tab） | 团队看板 | 两页都调 `fetchTeam` + `fetchTeamActivities`，都按 `task`/`agenda` 两类渲染 |
| 团队看板 | 同一批 activities 的两列布局 + 搜索/范围筛选 | 团队的「动向/日程」Tab | `TeamBoardPage.tsx` 顶部注释自称「工作区的替代页」 |
| 智能体 | 智能体名册 + 对话（`ChatPage`） | 通用智能体 | 两页都能选智能体发消息 |
| 通用智能体 | 任务列表/记录 + 内嵌 `ChatPage` | 智能体 | `TaskAreaPage.tsx` 直接嵌 `ChatPage` |
| 技能区 | 技能池 + 按智能体分配 + 编辑 | 插件区的「技能」Tab | `PluginsPage.tsx` 的 Tab 注释写明「把此前散在插件区、技能区、接口区的四份口径合并成四个 Tab」 |
| 接口区 | MCP 服务 + 工具授权 | 插件区的「工具/MCP」Tab | 同上；插件区那两个 Tab 目前只是只读摘要 |
| 插件区 | 插件包 / 技能 / 工具 / MCP 四 Tab | —（宿主页） | d.62 统一插件模型的产物 |

结论：**重复的本质是「只读摘要 Tab」与「独立管理页」并存**。
最省事也最诚实的合并方向不是把两套代码缝在一起，而是让插件区的 Tab 直接长成完整的原页面，
让团队/智能体页多出一个视图 Tab。

## 2. 合并结果

| 旧入口 | 去向 |
|---|---|
| 团队看板 `workspace` | 团队页第 3 个 Tab「看板」 |
| 通用智能体 `tasks` | 智能体页第 2 个 Tab「任务」 |
| 技能区 `skills` | 插件区「技能」Tab（完整技能池 + 分配 + 编辑，替换原只读摘要） |
| 接口区 `interfaces` | 插件区「MCP」Tab（完整服务管理 + 工具授权，替换原只读摘要） |

合并后导航轨 9 项：
`主页 · 团队 · 智能体 · 幕僚 · 信息中枢 · 自动化 · 插件区 · 记忆区 · 设置区`。

**不合并**（明确判断，不是漏掉）：幕僚、信息中枢、自动化。三者数据来源不同
（幕僚 = 主动巡检简报，信息中枢 = 本机归档，自动化 = 本机定时任务），
`automation` 目前确实只调度 `infohub.*` 动作，但它有独立的调度器、运行记录与失败通知，
把它塞进信息中枢的 Tab 会让「归档浏览」和「定时执行」两种心智模型混在一页。

## 3. 路由模型：旧 id 折叠成「宿主页 + 视图」

### 3.1 类型

```ts
type Page = "home" | "team" | "chat" | "staff" | "infohub" | "automations" | "plugins" | "memory" | "settings";
type LegacyPage = "workspace" | "tasks" | "skills" | "interfaces";   // 只存在于解析层
type PageId = Page | LegacyPage;
type PageView = "board" | "tasks" | "skills" | "interfaces";          // 宿主页内的一次性视图意图
```

**为什么保留 `LegacyPage` 而不从类型里删掉**：旧链接、旧 `heming.navOrder.v1`、
命令面板动作、通知中心跳转、桌宠气泡 route 都还在产出这些字符串。
删掉只会把它们逼成 `as never` 强转，而强转在运行时不会折叠页面，
表现为「点进去停在一个空白页」。保留并在 `resolvePage` 里统一折叠，兼容是结构性的。

### 3.2 `resolvePage`

| 输入 | page | view |
|---|---|---|
| `workspace` | `team` | `board` |
| `tasks` | `chat` | `tasks` |
| `skills` | `plugins` | `skills` |
| `interfaces` | `plugins` | `interfaces` |
| 宿主页 + 显式 view | 原样 | 显式 view 优先 |
| 宿主页 | 原样 | `null` |

### 3.3 视图意图的传递：一次性、消费即清

与既有 `automationIntent` / `paletteIntent` / `infohubIntent` 同口径：

- `setPage(page, view?)` 写 `pageView`；`consumePageView()` 读出并清空；
- 宿主页 `useEffect` 依赖 `pageView`，拿到非空值就切对应 Tab 并消费；
- **不把 Tab 长期放 store**：切走再回来应该回到默认 Tab，而不是被上次的意图钉住；
- 普通 `setPage(page)`（含 `openConversation` / `focusTeamMember` / `openInfohub` 等）
  一律把 `pageView` 清成 `null`，避免上一个宿主的 Tab 被带过来。

### 3.4 导航顺序迁移

`normalizeNavOrder` 对每一项先 `resolvePage` 折叠成宿主页再去重、再补默认项。
老用户的 13 项顺序（可能还包含合并前的自定义排序）读回后自然变成 9 项：
旧项按「第一次出现的位置」占位，折叠后与已出现的宿主页重复就丢弃。

## 4. 快捷键

| 键 | 旧 | 新 | 理由 |
|---|---|---|---|
| Alt+1 | 主页 | 主页 | 不变 |
| Alt+2 | 团队看板 | **团队** | 同一批数据换宿主页，保住肌肉记忆 |
| Alt+3 | 技能区 | — | 并入插件区，无承接页；不把 3 换给别的页 |
| Alt+4 | 接口区 | — | 并入插件区同上 |
| Alt+5 | 记忆区 | 记忆区 | 不变 |
| Alt+6 | 设置区 | 设置区 | 不变 |
| Alt+8 | 通用智能体 | **智能体** | 同 Alt+2：概念承接 |
| Alt+0 | 插件区 | 插件区（能力中心） | 不变 |

空出来的 3/4 就是空键位：不重新分配，比让人重学「3 现在是什么」成本低。
`NavRail.digit`、`App.SHORTCUT_PAGES`、`PALETTE_PAGES.digit` 三处必须一致（有测试钉住）。

## 5. 页面改造

### 5.1 团队页（宿主）

保留现有「动向 / 日程 / 用量」，插入「看板」Tab。看板视图 = 原 `TeamBoardPage` 去掉
`PageShell` 与页头（保留搜索、今天/全部范围、成员筛选、两列卡片、加载/错误/空态）。
看板自己取数，不与团队页的动向流硬合并数据源——两个视图的刷新节奏与筛选解耦更简单。

### 5.2 智能体页（宿主）

「对话 / 任务」两个 Tab。任务 Tab = 原 `TaskAreaPage` 去掉 `PageShell` 与页头，
保留任务列表、新建任务/模板、任务详情、报告、运行记录与内嵌 `ChatPage`。
同一时刻只挂一个 `ChatPage` 实例，切 Tab 即卸载另一个（避免双连接、双订阅）。

### 5.3 插件区（宿主，能力中心）

四个 Tab 与旧页面一一对应：

| Tab | 内容 | 来源 |
|---|---|---|
| 插件 | 插件包安装/更新/启停/卸载/详情 | 现有 `PluginsPage` |
| 技能 | 完整技能池 + 按智能体分配 + 编辑/删除/回滚 | `SkillsPage` → `SkillsView` |
| 工具 | 工具目录（只读） | 现有 |
| MCP | MCP 服务增删改 + 请求头 + 连接 + 逐工具授权 | `InterfacesPage` → `InterfacesView` |

页内「去技能区 / 去接口区」按钮改为切 Tab，不再跨页 `setPage`。

## 6. 兼容面清单（改核心时必须一起过的点）

- `store/ui.ts`：`Page` / `LegacyPage` / `PageView` / `resolvePage` / `normalizeNavOrder` /
  `setPage` / `consumePageView` / `focusTask`（→ `chat`+`tasks`）
- `NavRail.tsx`：ITEMS 9 项 + 数字键
- `App.tsx`：`SHORTCUT_PAGES`、页面路由（不允许再出现 4 个旧分支）、懒加载清单
- `lib/palette/pages.ts`：9 项目录（命令面板 + 快捷键帮助共用）
- `SettingsPage.tsx`：`NAV_LABELS` 9 项（导航顺序卡）
- `CommandPalette.tsx` / `NotificationCenter.tsx` / `InterfacesPage` / `PluginsPage` /
  `HomePage` 的跳转：**可以继续用旧 id**（由 `resolvePage` 折叠），但凡是「去另一页」的
  按钮在合并后应改为切 Tab
- 迁移：`heming.navOrder.v1` 读回折叠；不新增存储键

## 7. 验收

| 项 | 判据 |
|---|---|
| 导航轨 | 恰好 9 项；无「团队看板/通用智能体/技能区/接口区」 |
| 快捷键 | 1/2/5/6/8/0 生效；3/4/7/9 为 no-op 且不报错 |
| 旧链接 | `setPage("skills")` → `plugins` + `pageView="skills"`；四个旧 id 全部折叠 |
| 老顺序迁移 | 13 项旧数组读回 → 9 项，无重复、无丢失 |
| 页面 | 团队 4 Tab、智能体 2 Tab、插件区 4 Tab；Embedded 视图不出现重复页头/第二个 `PageShell` |
| 测试 | `store/ui.test`、`lib/palette/palette.test`、`NavRail.test`、`App.test`、`CommandPalette*.test`、`NotificationCenter.test` 与三个宿主页测试全绿 |
