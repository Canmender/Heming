# 和鸣 Web 全应用 UI/UX 审计与优化方案

- 日期：2026-11-13
- 对象：`D:\Heming`（pnpm monorepo）→ `packages/web`（React + TypeScript + Vite + Tailwind v4）
- 版本基线：`d.140.3.55.10`（HEAD `e7151e9b`）
- 审计方式：**纯静态源码审计**（逐文件读源码 + 跨仓 grep 普查），三路并行 + 主控合并
- 结论口径：`S1` = 发布前必须修（不可读 / 不可达 / 不可逆）｜`S2` = 明显缺陷（一致性、状态、可达性）｜`S3` = 打磨项

---

## 0. 摘要

本次共记录 **139 条**问题：**S1 × 9、S2 × 73、S3 × 57**。

| 轨道 | 范围 | 条数 | 分报告 |
| --- | --- | --- | --- |
| A | 应用外壳 / 导航 / 设计令牌 / UI 原子组件 | 47（S1 2 · S2 25 · S3 20） | [AUDIT-A-shell-tokens-primitives.md](./AUDIT-A-shell-tokens-primitives.md) |
| B | 对话 / 智能体 / 首页 / 命令面板 / 浮层 | 44（S1 3 · S2 20 · S3 21） | [AUDIT-B-chat-home-assistant.md](./AUDIT-B-chat-home-assistant.md) |
| C | 知识库 / 记忆 / 模型 / 技能 / 团队 / 设置 / 插件 | 48（S1 4 · S2 28 · S3 16） | [AUDIT-C-admin-pages.md](./AUDIT-C-admin-pages.md) |
| — | 主控复合并给出改造路线 | 139（去重后按主题归并） | 本文 |

**一句话结论**：和鸣的 UI **不是审美问题，是收口问题**。设计令牌、页面外壳（`PageShell`）、8 个 UI 基元、焦点环、`useModalA11y` 都已建成且质量不低（反 AI 味一项明确通过），但**基元没有强制力**——按钮手拼 265 处 / 51 个文件，`ErrorState` 零采用，`TextField` 只用了 1 个字段；暗色主题靠 `index.css` 里 116 条「按字面量类名覆盖」的补丁维持；可点尺寸、字号、圆角、阴影、图标、动效六个维度都没有硬刻度。于是每一页都在重新发明同一个按钮/卡片/空态/弹窗，这就是「缝合怪」观感的来源。

---

## 1. 方法与限制

### 1.1 用户指定的两个技能

| 技能 | 获取情况 | 处理 |
| --- | --- | --- |
| `mshumer/unslop` | **无法获取**：本机无外网（`web_fetch` → `fetch failed`；`web_search` → 上游 401），本地也未安装 | 改用本机 `anthropic-frontend-design` 技能（同一「反 AI slop」哲学：禁 emoji 图标、禁 Inter/Roboto 默认字体、禁紫粉渐变、禁居中堆叠空态模板、hover 不位移、对比度 ≥4.5:1、必须尊重 `prefers-reduced-motion`）作为审计标尺 |
| `alchaincyf/huashu-skills` | **无法获取**：同上 | 改用本机 `ui-design-pro` 技能（UI UX Pro Max 原则：8px 间距栅格、8–12px 圆角、反模式表），其中「字体用 Inter」的建议与本仓 anti-slop 口径冲突，**以 anti-slop 为准**，不引入新字体 |

> 说明：两个外部技能未能实际应用，是本次交付的已知缺口；替代标尺已逐条落到第 2 节的检查项，审计结论不依赖未能获取的资料。

### 1.2 无法执行的验证（重要）

本机 Bash 执行通道全程不可用（`EXECUTOR_UNAVAILABLE`：niubash 执行副本 `link` 失败，`effectState=none`），因此：

- ❌ 没有跑 `pnpm -r typecheck` / `test` / `build`
- ❌ 没有启动 dev server，没有截图、没有 axe / Lighthouse、没有真机断点验证
- ❌ 没有跑版本 bump 脚本（版本手工改，见 §7.1）
- ✅ 文件读写走 `ops_*` 工具，行号与代码片段均为仓库原文
- ⚠️ 对比度为按 WCAG 相对亮度公式**手算**，非像素取样

所有需要浏览器才能确认的结论，在三份分报告末尾单列「未验证项」，本文 §7.3 汇总为人工 smoke 清单。

### 1.3 anti-slop 自检结论（正向）

| 检查项 | 结论 | 证据 |
| --- | --- | --- |
| emoji 当 UI 图标 | **通过** | 全仓仅 `EmojiPicker.tsx:8-10`（选择器本身）与 `AgentStreamBubble.tsx:245` 的文本勾；UI 图标走 `icons.tsx` SVG |
| 紫粉渐变 / AI 渐变 | **通过** | `bg-gradient\|from-purple\|from-violet\|to-pink\|indigo-\|violet-` 全仓 0 匹配 |
| Inter / Roboto / Arial 默认字体 | **通过** | `index.css:11-26` 拉丁→CJK→系统栈，并写了理由 |
| 过度圆角 / 光晕球 | **通过（有残留）** | d.138 已删 radial 光晕；残留 16px 圆角与 5 套阴影（见 §4.2） |
| 居中大标题+副标题+按钮的空态模板 | **未通过** | `ChatEmptyState.tsx:18-37`、`KnowledgePage.tsx:592-615`、`App.tsx:409-435` 三处典型模板 |
| hover 位移 / 缩放 | **轻微** | 卡片 `translateY(-1px)`（可接受），无 scale |

---

## 2. 审计标尺

**布局**：4/8/12/16/24/32/48 间距栅格；断点 375 / 768 / 1024 / 1440 无页面级横向滚动；单一滚动容器（禁止消息列表嵌套滚动）；flex 子项 `min-w-0`；固定宽度必须带 `max-w` 兜底。

**层级**：一屏只有一个「最响」元素；标题/正文/辅助三级清晰；字号只从语义档取（禁新增 `text-[Npx]`）。

**组件**：按钮 3 档（28/32/36）且只有一种实现；卡片一种壳；对话框一种壳 + 尺寸档；空/载/错三态各一种；危险动作必须二次确认且不可逆操作有说明。

**可访问性**：键盘可达 + 可见焦点环；命中区 ≥32px（桌面最低 28 且成组一致）；对比度 ≥4.5:1（大字 3:1）；`aria-*` 与可见文案一致；`prefers-reduced-motion` 全覆盖。

**暗色**：只允许 token，禁止字面量色类；新增组件不得依赖兼容层白名单。

**反 AI 味**：见 §1.3。

---

## 3. 总体诊断（五条主线）

### D1 基元建了不用 —— 所有问题的放大器（最严重）

| 基元 | 定义处 | 生产代码采用 | 同类手写 |
| --- | --- | --- | --- |
| `Button` | `components/ui/Button.tsx` | **3 个文件** | **265 处** `"ui-btn …"` 字符串 / 51 个文件 |
| `EmptyState` | `components/ui/EmptyState.tsx` | 4 个文件 | 19 处 `.ui-empty*` + 6 处手写 div |
| `ErrorState` | `components/ui/ErrorState.tsx` | **0 个文件** | 5 种失败态写法（十几种文案） |
| `TextField` | `components/ui/Field.tsx` | **1 个字段**（`SettingsPage.tsx:502`） | 管理页 20+ 裸 `<input aria-label>` |
| `Skeleton` | `components/ui/Skeleton.tsx` | 3 个文件 | 手写 `animate-pulse` 块 |
| `Switch` | `components/ui/Switch.tsx` | 3 个文件 | **2 份新拷贝**（`plugins/shared.tsx:38-69`、`WidgetSettingsCard.tsx:345-356`） |
| `SectionCard` | `components/model/SectionCard.tsx` | 1 个文件 | 设置页 6 张卡各写壳 |
| `FOCUS_RING` | `lib/a11y/focus.ts:20` | 16 个文件手贴 | `.ui-btn/.ui-chip/.ui-segment` 均无 |

每处绕行都配了一段「为什么这样写」的注释——注释本身证明团队知道问题，但**没有一条机制让旧写法失败**。下一步收益不在「再定一套 token」，而在「让旧写法编不过 / 过不了 lint」。

### D2 暗色不是 token 驱动，而是 116 条类名补丁

`index.css:798-1101` 用 `[data-theme="dark"] .bg-\[\#fafafa\]` 这类「按字面量类名覆盖」支撑暗色。任何白名单外的新颜色都会穿帮，现成反例：

- `App.tsx:863` `hover:bg-[#1a1a1a]/10`（暗色下 hover 反馈消失）
- `ChatPage.tsx:3260` `accent-[#1a1a1a]`（暗色下勾选块与背景同色）
- `AgentFormPanel.tsx:32` `focus:border-[#bbb]`（暗色对比 1.85:1）
- `ShortcutsHelp.tsx:70` `divide-[#f4f4f4]`（暗色近白分隔线）
- `plugins/shared.tsx:72-76` `emerald/amber/red` 调色板类（完全无覆盖）
- 两条 S1 对比度问题（暗色 `--danger`/`--success` 配白字）都出自同一根因

### D3 六个视觉维度没有刻度

| 维度 | 现状 | 应有 |
| --- | --- | --- |
| 字号 | `text-[Npx]` **650 处 / 77 文件**（9/10/11/12/13/15/26 混用） | 6 档语义档，禁新增 |
| 字重 | `font-extrabold` 12 处与 600 并行 | 600 + 800 二选一（建议 600） |
| 圆角 | 6 档（4/6/8/12/16/999） | 3 档（4 控件 / 12 卡片 / 999 胶囊） |
| 阴影 | 6 套（`ui-card` / `shadow-card` / `shadow-float` / `shadow-xl` / `ui-overlay-shadow` / `plugin-card`） | 2 级（描边 / 一级浮层） |
| 图标 | 14/15/17/18/22/24 混用，另与字形 `› ‹ ⋯ × ↑ ↓ ▾ ▸ ✓` 双轨 | 14/16/20/24（16 为主）+ 只用 SVG |
| 动效 | 150/160/200/280/300ms 五值语义混用 | `--motion-fast/base/enter` |

### D4 页面外壳统一了，壳内没有版式语言

`PageShell` 当年修掉的四条病症（内边距 24/32、标题 15/16/17、宽度 520/900、滚动容器不一致）**在壳内原样复发**：

- 页面内自写容器宽：760 / 880 / 960 / 1000 / 1200 / 680 / 440 / 420 / 360 九种（C-S2-10）
- 同一张卡片 4 种壳（C-S2-04），卡片标题 3 套字号（C-S2-06）
- 对话框 4 种宽度、2 种圆角、有/无边框（C-S2-07）
- 工具条搜索框 5 种宽度（C-S2-14）
- 知识库页自绘页头：内边距 12/6、标题 15px，与 `PageShell` 的 24/16、28px 形成「切页时页头塌一下」（C-S2-11）

### D5 三态各自为战

- 加载态 4 种（骨架 / 手写脉冲 / 纯文字 / 静态 `aria-busy` 容器）
- 空态 3 套系统 + 5 种手写
- 失败态 5 种形态、十几种文案

管理页最需要的不是「炫」，而是「永远知道现在是什么状态、下一步点什么」。

---

## 4. 问题清单（按主题归并，附来源编号）

> 完整证据（文件:行号 + 代码片段 + 改法）见三份分报告；此处只做归并与去重，便于排期。

### 4.1 S1 阻断（9 条，发布前必修）

| # | 问题 | 位置 | 修法 |
| --- | --- | --- | --- |
| 1 | 暗色下危险按钮白字压浅珊瑚红，对比约 **1.7–2.3:1**，波及所有删除/清空入口 | `index.css:144`（`--danger: #ff8a80`）+ `index.css:538-541`（`.ui-btn-danger text-white`） | 新增 `--danger-on` 前景 token（暗色深字），按钮改用之 |
| 2 | 暗色下完成态徽标白字压浅绿，约 **1.9:1**，数字看不见 | `ux/OnboardingCard.tsx:61-64` + `index.css:148` | 新增 `--success-on`，或改 `--success-soft` 底 + `--success` 字 |
| 3 | **375px 聊天主区仅剩约 111px**：会话轨恒 264px，三份聊天文件合计仅 1 处响应式类 | `assistant/ConversationRail.tsx:366`、`ChatPage.tsx:3117` | 窄屏 rail 收 60px 窄轨或抽屉；补 `max-md:` 与 `min-w-0` |
| 4 | 智能体表单弹窗固定 380px，375 视口必然横向溢出 | `assistant/AgentFormPanel.tsx:261` | `w-[380px] max-w-[92vw]`（对齐 `ConfirmDialog.tsx:60`） |
| 5 | 通知面板 320px 自 60px 窄轨向右展开，375 下右侧按钮越界 | `NotificationCenter.tsx:193` | `max-w-[calc(100vw-76px)]` 或窄屏底部 sheet |
| 6 | 「删除候选链」零确认、不可撤销 | `RouteGroupsCard.tsx:245-255` | 接 `ConfirmDialog` + `.ui-btn-danger` |
| 7 | 模型页「删除分组」零确认、直接命中服务端 | `ModelPage.tsx:1237-1244` | 同上（该文件未 import `ConfirmDialog`） |
| 8 | 模型页「删除密钥」零确认 | `ModelPage.tsx:1483-1490` | 同上 |
| 9 | 管理表单无可见 label / 必填 / 错误关联（模型页运行页 20+ 字段）；另「运行」Tab 把 CLI 英文枚举（`webdav/s3/github`、`now/on/off/set`）当界面铺开、7 个 `<details>` 同权平铺 | `ModelPage.tsx:1178-1191`、`:1332-1345` | 字段换 `TextField`；CLI 原语收进「高级/维护」，枚举中文化 |

### 4.2 布局与响应式（S2 级，12 条要点）

1. 断点不在 375/768/1024/1440 标尺：唯一 JS 断点 1200（`lib/viewport.ts:16`）+ `max-[1199px]`（`PageShell.tsx:73/86`）+ `min-[720px]`（`App.tsx:94`）+ `min-[900px]`（`OnboardingCard.tsx:45`、`LoginPage.tsx:58`）。
2. `PageShell.tsx:86` 滚动容器同时 `overflow-y-auto overflow-x-auto` → 任意超宽内容都会让整页出现横滚，且页头不跟随（错位）。
3. 导航在 ≤768 无适配：54px 常驻轨无底部栏/汉堡（静态推断，未验证）。
4. 拖宽手柄 8px（`App.tsx:858-864`）、composer 拖拽把手 8px（`ChatPage.tsx:3478`），且都只有指针事件、无 `tabIndex`/方向键/`aria-valuenow`。
5. 页面内自写宽度容器九种（见 D4）。
6. `App.tsx:813` 根节点再画一圈 1px 边框，与标题栏 `border-b` 叠成双线。
7. `App.tsx:822` 用内联 `paddingLeft` 承载导航宽度常量，与 `w-[54px]`、`RAIL_WIDTH` 分散三处。
8. 消息列表内嵌套三层滚动（`AgentStreamBubble.tsx:124/183/190`，上限 180/120/140px）。
9. 会话轨道具被滚动容器裁切（`ConversationRail.tsx:430` 的 `overflow-y-auto` 内绝对定位菜单）。
10. 消息加载失败态 `h-full` 在 auto 高度父级里不解析，错误块贴顶（`ChatPage.tsx:3152`）。
11. 流式气泡 78% 宽 vs 落定全宽无气泡，生成结束时跳变（`AgentStreamBubble.tsx:53` vs `ChatPage.tsx:3283`）。
12. `ModelTraceView.tsx:36` 链路图固定 960px，1024 及以下需横拖近 600px 才能看到「谁在回答」。

### 4.3 设计令牌 / 暗色（S2 级，8 条要点）

1. 暗色 116 条类名覆盖 + 102 处写死色值（53 文件），调色板类无覆盖（见 D2）。
2. `--scrim` 建了 token 却被 **17 处**手写遮罩绕过（`bg-black/10` ×1、`/20` ×9、`/30` ×5、`/75` ×2）。
3. `.ui-alert` 同名类两份定义（`index.css:271-293` 与 `:560-572`），后定义覆盖前者，`warn/info/success` 拿到错误的 `gap`。
4. 阴影 token 定义了却不用：`.ui-card` 写死 `rgba(0,0,0,.07)`，暗色再写一遍。
5. 滚动条颜色写死（亮 `#d0d0d0`，暗 `#4a4d55`），未 token 化。
6. `.bg-ink` 一个类干两件事（背景 + 前景），依赖未分层样式的层叠顺序压过 `text-white`。
7. 紫色系残留：`--chart-2: #7c6bd6`、`--avatar-1`、`--avatar-5: #db2777`（暗色更亮）。
8. 图表轴标签 9px + `--chart-label #98a2b3` 白底约 **2.5:1**。

### 4.4 组件一致性（S2 级，10 条要点）

1. 手拼按钮 6 处（`App.tsx:218-244/422-432/836`）高度 22/28/32 三档；`.ui-btn-sm`=28、`.ui-link`=24。
2. 按钮基元不带焦点环（`Button.tsx:52`），焦点可见性依赖运行时注入的全局 `<style>`（`GlobalFocusRing.tsx:37-46`）；同时组件层又有 `FOCUS_RING` 手贴 —— 两套机制。
3. `.ui-btn` 无 `cursor-pointer`；全仓 `cursor-pointer` 仅 29 处 / 16 文件。
4. 卡片 4 种壳 + 3 套标题字号 + `mt-3` 与父级 gap 叠加（12+12）；卡中卡三层（`RouteGroupsCard.tsx:205→232→292`；`ModelPage.tsx:699` 内再 6 个 `ui-card`）。
5. 对话框无基元：11 个弹窗各自拼壳，宽度 4 种、圆角 2 种、有无边框不一致。
6. 表格 `.ui-table` 3 处 vs 手写 6 处；`ModelUsageView.tsx:292` 把横滚加在卡片本体上（标题跟着滚）。
7. 页签只统一外观未统一行为：5 个页面级 tablist 中 4 个无 `id`/`aria-controls`/`tabpanel`，全部无 ←→ 键；而同文件 radio group 却有方向键。
8. 开关基元只收口样式：2 份新拷贝（16px 复选框冒充开关、自绘 18×32），且 `accent` 写死 `#2f5bd7`。
9. 选中/高亮两种语言：写死 `ring-[#1a1a1a]/25`、`outline outline-2`、`ring-2 ring-[var(--ink)]`。
10. 输入控件三套：`.ui-input`（6px/32px/13px）、`SkillsPage.tsx:917` textarea（8px/11px）、`ui-input h-7 text-[12px]` 覆盖档。

### 4.5 三态（S2 级，3 条）

加载 4 种 / 空态 3 套 + 5 种手写 / 失败态 5 种。典型：`EmptyState` 与 `.ui-empty` 同一视觉两套 API；手写空态类串在 `PluginsPage.tsx:707`、`UnitListView.tsx:403`、`PluginBundlePage.tsx:202/234` 逐字重复；`AgentPicker.tsx:101` / `AgentRosterView.tsx:114` 无 loading，异步中先闪「还没有智能体」。

### 4.6 可访问性（S2/S3 级，9 条要点）

1. 焦点两套机制：全局 `:focus-visible`（JS 注入）+ 局部 `FOCUS_RING`（16 文件手贴）；`index.css` 全文只有 1 条焦点规则（`.ui-input:focus` 只改边框色）。
2. `window.alert` ×3（`App.tsx:507/516/526`）承担错误提示，与 `MemoryPage.tsx:70` 既定「一切失败内联中文提示」口径矛盾。
3. 触摸目标 16–28px 成片：`.ui-btn-sm` 28、`.ui-link` 24、NavRail 快捷键/固定 26、头像 28、手拼 22、自绘重试 20、色点 24、Widget 开关 16。
4. 键盘拿不到「复制消息」：`ChatPage.tsx:3305` `hidden + group-hover:block`，纯文本消息行内无可聚焦子元素。
5. `Switch` 注释「禁用仍可聚焦」与实现（原生 `disabled`）矛盾。
6. `ComposerHints.tsx:9-11` 把 `aria-label` 挂在 `<p>` 上（无 role，多数读屏不播报）。
7. `HitlPolicyCard.tsx:157/184` 同时用 `<label>` 与 `aria-label`，文案可能分叉；`clampedNotice` 无 `role="status"`。
8. `TokenHeatmap.tsx:14` 30 天数据只能 hover `title` 读，键盘/触屏/读屏不可得。
9. `FileEditCard.tsx:95` 卡片套卡片（内层再 `rounded-xl border shadow-card`）。

### 4.7 排版与信息层级（S2/S3 级，5 条要点）

1. 页面级档位已建立（28/15/14/13/12/10），组件级失控：650 处任意字号、12 处 `font-extrabold`、`Stat.tsx:37` 的 26px 数字贴 28px 标题。
2. 10px 成为元信息默认值，且用于需要读准的内容（工具名、审批风险、通知时间、首页指标、命令面板详情）。
3. 同一「页面主标题」两种实现：`App.tsx:411` `text-[15px] font-extrabold` vs `PageShell` `.ui-page-title`。
4. `ui-micro`（10px）承载共享文件用量 `12.3MB / 100MB`（`App.tsx:213`）。
5. Markdown 标题层级过平（h1/h2/h3 = 15/14/13px），内联代码借用 `--danger` 红。

### 4.8 图标与字形双轨

`icons.tsx` 提供 SVG 集，但 UI 里仍在用字形：`› ‹ ⋯ × ↑ ↓ ▾ ▸ ✓`（`ConversationRail.tsx:254/325/377`、`NotificationCenter.tsx:220/306`、`ChatPage.tsx:3041/3050/3058`、`AgentStreamBubble.tsx:116/150/245`、`AgentEditorView.tsx:39`）。字形宽度随字体变化，是行内对齐抖动的来源。图标尺寸也无栅格（14/15/17/18/22/24）。

### 4.9 危险操作与信任

3 处零确认删除（见 S1-6/7/8）+ 危险按钮 3 种视觉（`plugins/shared.tsx:14` 幽灵+红字、`.ui-btn-danger` 红底、`.ui-btn-ghost` + 确认）+ 删除与编辑同排同尺寸同色（`RouteGroupsCard.tsx:242-252`）。

### 4.10 动效

150/160/200/280/300ms 五值语义混用；`prefers-reduced-motion` 覆盖不全（NavRail tooltip 位移动画、导航按钮 transition、流式 `animate-pulse` 骨架无兜底）；两套「卡片浮起」数值（`.ui-card-interactive` vs `.plugin-card`）。

---

## 5. 优先级矩阵

**P0（本轮必修，9 条 S1）**：暗色 danger/success 前景 token → 三处零确认删除 → 375 聊天壳与两个越界弹层 → 表单可见标签 + 模型页 CLI 中文化。

**P1（投入产出最高，收口类）**：
1. `.ui-btn` 内置焦点环 + `cursor-pointer` + 全站点击区 ≥32px（一处 CSS 解决上千个控件）
2. `SectionCard` 提升到 `ui/`，卡片壳/标题唯一化
3. 三态接线（`EmptyState` / `ErrorState` / `Skeleton` 先换无断言的 8–10 处）
4. `--scrim` 全量替换（17 处）+ `ui/Dialog` 基元
5. `TabList` 行为统一（roving tabindex + `tabpanel`）
6. 字号/圆角/阴影/图标/动效五个刻度收敛 + lint 门禁

**P2（页面积累项）**：知识库页头并入 `PageShell`、表格规范、`TokenHeatmap` 可读化、登录页可见 label、`ChatEmptyState` 去模板、`ModelTraceView` 改 `viewBox`。

**不建议动**：字体栈、`--placeholder` 取值、`useModalA11y`、`MemoryPage.tsx:2499-2531` 的 tablist、`GlobalFocusRing` 的 forced-colors 分支、插件区已删光晕的方向。

---

## 6. 四轮改造方案（本文即施工单）

> 约束：单写者（Lead）串行改，先全局杠杆（`index.css` → 壳 → 基元）再页面定点；每轮结束记录改动与风险。因无构建/测试，每轮只做「可静态验证」的改动：类名替换、token 增补、结构等价重排。

### 第 1 轮｜界面布局重构：垂直节奏与容器统一

**目标**：一屏多出 15–25% 内容区；页头不再压人；页面容器宽度从 9 种收敛到 5 档。

1. `PageShell.tsx`：页头 `px-6 py-4` → `px-6 py-3`；`flex-wrap items-start` → `items-center`，标题与 actions 同一水平线；`width` 增加 `form`(760) / `prose`(680) 两档；内容区去掉 `overflow-x-auto`（横向溢出交给内容块）；`scroll=false` 也走 `padded` 包装层。
2. `index.css` 排版档位：`.ui-page-title` 28/36 → **22/30**；`.ui-page-sub` 14/22 → **13/20**、`mt-1.5` → `mt-0.5`；`.ui-section-title` 15 → 14；`.ui-micro` 10 → 11。
3. `App.tsx`：根节点去掉 `border`、`bg-white` → `bg-surface`；拖宽手柄命中区 8 → 12px 且 hover 用 token；抽屉遮罩 `bg-black/30` → `var(--scrim)`；重连面板尺寸/字重归位到语义档；共享文件表头三个 11px 手拼按钮 → `.ui-btn-sm/.ui-btn-ghost`；`paddingLeft` 内联 → CSS 变量。
4. `NavRail.tsx`：26px 控件（快捷键、固定）与 28px 头像统一抬到 32×32；导航项 34 保持；组间距与分隔线节奏统一（8px / 1px）。
5. `ConversationRail.tsx` / `AgentFormPanel.tsx` / `NotificationCenter.tsx`：三处 375 越界与固定宽度加 `max-w` 兜底（S1-3/4/5 的最小改动版）。

**验收**：1440/1024 下页头高度 ≤60px；无新增 `text-[Npx]`；页面容器宽度只用 `PageShell` 五档；375 下三个越界面板不再溢出（静态推演）。

### 第 2 轮｜界面样式重构：视觉语言收敛

**目标**：阴影从 6 套到 2 级、圆角 3 档、语义色补全；「描边优先、阴影克制」。

1. 阴影：`.ui-card` 去掉 `box-shadow`，只留 1px `--line-soft` 描边；浮层统一 `--shadow-overlay`（0 8px 24px .12，暗色 .5）；删除 `shadow-card` 在按钮/小控件上的使用；`shadow-float` 只保留给 `plugin-card` 的「贴纸」语义或直接删除。
2. 圆角 3 档：控件 6px、卡片 12px、胶囊 999；弹窗统一 12px（`rounded-2xl` → `rounded-xl`）。
3. 语义前景 token：`--danger-on` / `--success-on` / `--warn-on` / `--info-on`（亮色白、暗色深），`.ui-btn-danger`、完成徽标、未读角标改用之（修 S1-1/2）。
4. 色板去 AI 味：`--chart-2` 紫 → 蓝绿（`#0f9d8a`）；`--avatar-5` 粉降饱和；`--chart-label` 亮色 `#98a2b3` → `#5c6673`（≈4.6:1）。
5. `index.css` 结构清理：`.ui-alert` 合并为一份四变体（删除 271-293 的重复块）；`.bg-ink` 拆 `.bg-accent` + `.text-on-accent`；滚动条 token 化；动效 token `--motion-fast/base/enter`。
6. `.ui-btn` / `.ui-chip` / `.ui-segment` / `.ui-filter-chip` / `.ui-disclosure summary` 内置 `focus-visible` outline + `cursor-pointer`；`@layer base` 加 `button:not(:disabled)` 兜底。
7. 新增 `.ui-textarea` / `.ui-input-sm` / `.ui-hit`（最小 32px 命中区）。

**验收**：全站卡片只有一个阴影/描边来源；暗色下按钮文字对比 ≥4.5:1；同屏无两套圆角。

### 第 3 轮｜整体设计优化 I：交互态与组件收口

**目标**：把「基元建了不用」反转成「新代码没有别的写法」。

1. 新增（纯增量，不动旧调用）：`ui/IconButton`（强制 32×32 + `aria-label` + SVG only）、`ui/SectionCard`（从 `model/` 提升）、`ui/Dialog`（3 档宽度 + `var(--scrim)` + 内置 `useModalA11y`）、`ui/StatusDot`、`ui/EmptyState` 增 `align="start"`。
2. `Button.tsx` 内置 `FOCUS_RING`；`Tooltip` 从 `NavRail` 私有实现提升为 `ui/Tooltip`（主题化、`aria-describedby`、reduced-motion）。
3. 全局替换（`ops_replace` 批处理 + 逐文件核对）：`bg-black/10·20·30·75` → `bg-[var(--scrim)]`（17 处）；`accent-[#1a1a1a]` → `accent-[var(--ink)]`；`divide-[#f4f4f4]` → `divide-line-soft`；`focus:border-[#bbb]` → `.ui-input`；`plugins/shared.tsx` 的 `BTN_DANGER_SM`/`ERROR_TEXT` 假令牌改用 `.ui-btn-danger`/`var(--danger)`。
4. 危险按钮统一为 `.ui-btn-danger` 一种；`plugins/shared.tsx` 与 `ModelPage` 的危险语义对齐。
5. 动效：NavRail tooltip 与按钮 transition 补 `motion-reduce`；流式骨架改用 `.ui-skeleton`；`AgentStreamBubble` 三层嵌套滚动改为「一行摘要 + 展开」。

**验收**：`grep 'bg-black/'` = 0；`grep accent-\[#` = 0；`grep 'BTN_DANGER_SM'` 只剩定义或 0；新增 5 个基元各有 1+ 采用点。

### 第 4 轮｜整体设计优化 II：页面级 S1 与暗色/a11y 收口

**目标**：把 9 条 S1 清零，并让「键盘/触屏/读屏」三条路径都成立。

1. 三处零确认删除接 `ConfirmDialog`（`RouteGroupsCard.tsx:245`、`ModelPage.tsx:1237/1483`），按钮用 `.ui-btn-danger`，确认文案说明「不可恢复 / 影响 N 个智能体」。
2. `App.tsx` 三处 `window.alert` → 页内 `role="alert"` 内联提示（与 `MemoryPage` 口径一致）。
3. `GlobalFocusRing` 的 `FOCUS_CSS` 落进 `index.css` 基线（组件保留注入作为兜底），消除「JS 未执行则 56 处无焦点环」。
4. `Switch.tsx`：命中区 32×18 → `ui-hit` 外扩；注释与原生 `disabled` 对齐（明确「禁用不可聚焦」）；`WidgetSettingsCard` 16px 复选框换 `ui/Switch`。
5. 表单：`ModelPage` 运行页 20+ 裸 input 换 `TextField`（可见 label + `hint` + `error` + `aria-describedby`）；`LoginPage` 加可见 label。
6. 管理可读性：模型页「运行」Tab 的英文枚举中文化 + CLI 原语收进「高级/维护」；`InterfacesPage.tsx:692` 与 `WikiPanel` 的 10px 提升；`ChatEmptyState` 改 `EmptyState align="start"` 并把示例改左对齐列表。
7. `HitlPolicyCard` 去掉 `aria-label`/`<label>` 双轨、`clampedNotice` 加 `role="status"`；`ComposerHints` 去掉 `<p aria-label>`。

**验收**：S1 表 9 条逐条有对应改动；`grep 'window.alert'` = 0；`grep 'role="switch"'` 只剩 `ui/Switch` 一处；Tab 走查每个可交互元素有可见 outline。

---

## 7. 交付、版本与验证

### 7.1 版本

仓库约定「每次修改都 bump 版本」（`docs/VERSION-MANAGEMENT.md`，5 段 `d.特性.破坏性.修订.构建`）。本次为 UI/UX 重构，按「修订位 +1」处理：`d.140.3.55.10` → `d.140.3.56.0`，并写 `docs/CHANGELOG.md`。

> Bash 不可用，无法执行 `node scripts/bump-version.mjs`；版本号与 CHANGELOG 为**手工同步**，需在恢复执行环境后跑一次脚本核对（脚本会校验 5 段格式与联动文件）。

### 7.2 改动范围（写入本文档后逐轮追加）

见 `docs/CHANGELOG.md` 的 `d.140.3.56.0` 条目；每轮结束时在条目内追加「轮次 / 文件 / 改动 / 风险」。

### 7.3 人工 smoke 清单（恢复浏览器后必做）

1. 1440 / 1024 / 768 / 375 四档：无页面级横滚；页头高度一致；聊天页 composer 不挤压。
2. 暗色：所有危险按钮文字可读；浮层遮罩能压住背景；hover 反馈存在（拖宽手柄、导航项）。
3. 键盘：Tab 走查首页→设置→模型→插件，焦点环处处可见；Esc 只关最内层；拖宽手柄可用方向键（若已改）。
4. 375：会话轨、智能体表单、通知面板不越界。
5. 空/载/错三态：断网后各页错误态有重试且文案一致。
6. 三处删除：均弹确认、取消不执行、确认后回执带对象名。
7. `pnpm -r typecheck` / `pnpm --filter @heming/web test` / `pnpm -r build`（本次全部未执行）。

---

## 8. 附录：分报告索引

- `docs/AUDIT-A-shell-tokens-primitives.md` —— 令牌/排版/布局/基元/a11y/动效/AI-slop/图标，47 条 + 13 项通用件清单
- `docs/AUDIT-B-chat-home-assistant.md` —— 对话/助手/首页/命令面板/浮层，44 条 + 12 项通用件 + 10 条正向证据
- `docs/AUDIT-C-admin-pages.md` —— 管理七页，48 条 + 采用率普查 + P1–P6 共性 + 16 项通用件（带可替换数与验收）