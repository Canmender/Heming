# d.63 · 组件级排版与控件规范（规格）

- 日期：2026-11-03
- 状态：**本轮实施**
- 上游：`2026-11-03-d62-layout-typography.md`（页面级排版已统一，d.61.2.22.0 上线）
- 触发：用户「继续全部优化改进」
- 本轮目标：把 d.62 留下的 5 项一起做掉——**组件级字号收口 / 密集控件尺寸 / 表格与列表行规范 / 空态与骨架统一 / 登录页排版**。

## 1. 现状（d.62 之后仍在的）

| # | 问题 | 证据 |
|---|---|---|
| W1 | **卡片内部各写一套字号**：13 张设置卡的标题 12/13px、字段标签 11/12px、说明 10/11/12px 混用；弹窗内同样 | `LlmSettingsCard` / `KeyStorageCard` / `HitlPolicyCard` 等 |
| W2 | **控件尺寸不统一**：按钮 `h-7/h-8/h-9` 混用、输入框有的 `h-8` 有的自适应；胶囊/徽标 10/11px 混用且点击区偏小 | 接口区/插件区/团队页/设置卡 |
| W3 | **表格与列表行没有规范**：接口区表格 th 11/12px 混、行高不定、数字列不右对齐；技能区/插件区/团队名册/记忆列表的行高与左右内边距不一致 | `InterfacesPage` 表格、`SkillsPage`、`TeamPage` 名册 |
| W4 | **空态与骨架各写一套**：各页空态图标尺寸 24/28/32、标题 12/13/14px、说明宽度不一；`PageFallback` 与各页 loading 骨架形状不一致 | Automation/Staff/Plugins/Team/TeamBoard 等 |
| W5 | **登录页不在新排版体系里**：标题/表单/按钮字号与全站不一致 | `LoginPage.tsx` |

## 2. 本轮新增的基元（Lead 已落地在 `index.css`）

| 类 | 用途 |
|---|---|
| `.ui-input` | 表单控件：高 32、13px、`line-strong` 边框、focus 时边框转 ink |
| `.ui-btn` + `.ui-btn-sm/md` + `.ui-btn-primary/ghost/danger` | 按钮统一高度（28/32）、12px、图标间距、禁用态 |
| `.ui-chip` | 胶囊/徽标：高 20、11px、浅底描边（替代各处手写徽标） |
| `.ui-table` / `.ui-table th` / `.ui-table td` | 表格：th 11px muted、td 12px、行分隔 `line-soft`、单元格左右内边距 12 |
| `.ui-list` / `.ui-list-row` | 列表：行高 44、左右 12、hover 浅灰、分隔线 |
| `.ui-empty` / `.ui-empty-title` / `.ui-empty-desc` | 空态：图标槽 32、标题 13/600、说明 12/muted、最大宽 420 |
| `.ui-skeleton` | 骨架块：`bg-line-soft` + `animate-pulse` + 圆角（尊重 `prefers-reduced-motion` 见 index.css 已有规则） |

## 3. 三轨（文件级不重叠）

### T1 设置卡片与弹窗（W1 + W2 的一半）
- 范围：`LlmSettingsCard` / `RouteGroupsCard` / `KeyStorageCard` / `ContextSettingsCard` / `HitlPolicyCard` / `FileEditCard` / `StorageUsageCard` / `PetSettingsCard` / `WikiPanel` / `SelfEditCard` / `ToneCard` / `UpdateCard`（设置里引用的卡片）+ `SettingsPage` + 弹窗 `ConfirmDialog` / `AgentFormModal` / `ToolApprovalModal`。
- 做法：卡片标题统一 `ui-section-title`、说明/字段标签统一 `ui-caption`、正文 `ui-body-sm`；卡片内边距统一 `p-4`、字段行间距 8/12；按钮改用 `.ui-btn` 与尺寸档；输入框改 `.ui-input`；危险按钮用 `.ui-btn-danger`。**不改任何设置项行为与文案语义**。

### T2 表格、列表与密集控件（W2 的一半 + W3）
- 范围：`InterfacesPage`（表格）、`RegistryPage`、`SkillsPage`、`PluginsPage`、`TeamPage`（名册）、`MemoryPage`（列表）、`InfohubPage`（会话/消息列表）。
- 做法：表格改用 `.ui-table`（th `ui-caption`、td `ui-body-sm`、行高 40、数字列右对齐 `ui-numeric`、操作列右对齐）；列表改用 `.ui-list-row`（行高 44、左右 12、hover）；徽标/胶囊统一 `.ui-chip`；按钮统一 `.ui-btn` 档；搜索框/下拉改 `.ui-input`。分页/筛选行间距 12。**不改交互、文案、aria-label**。

### T3 空态、骨架与登录页（W4 + W5）
- 新增 `components/ui/EmptyState.tsx`（icon/title/desc/actions/compact 变体，内部用 `.ui-empty*`）与 `components/ui/Skeleton.tsx`（`SkeletonLine`/`SkeletonBlock`/`SkeletonCard`，内部用 `.ui-skeleton`）。
- 应用到 `HomePage` / `AutomationPage` / `StaffPage` / `TeamBoardPage` / `PageFallback`（保留 `data-testid="page-fallback"`）以及这些页面里的 loading 态；**不要动 ChatPage/Plugins/Skills/Interfaces/Registry/Team/Memory/Infohub**（T2 范围内）。
- 登录页排版：标题 18/600、副标题 `ui-page-sub`、表单框 `.ui-input`、按钮 `.ui-btn .ui-btn-md .ui-btn-primary`、错误行 `role=alert` + `ui-caption`；品牌字样、布局分栏与圆环不动。

## 4. 不改
交互行为与文案语义、aria-label/角色名、设计 token 取值、主题色、登录页品牌视觉、PageFallback 的测试锚点、聊天消息列 880（有断言）。

## 5. 验收
- 三轨定向用例全绿 + `tsc --noEmit` + `pnpm -r build`；发布前全量门禁（逐包、允许单包重试一次）。
- 视觉：`node .tmp/ux-capture.mjs` 重截 13 页，与 `.tmp/layout/after2`（d.62 后）对照；重点看设置卡、接口区表格、团队名册、插件/技能列表、空态与登录页。
- 版本：`d.61.2.23.0`（组件级排版与控件规范，计入修订位）。
