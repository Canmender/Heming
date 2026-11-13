# 审计 A：应用外壳 / 导航 / 设计令牌 / UI 原子组件

> 对象：`D:\Heming\packages\web`（React + TypeScript + Vite + Tailwind v4）
> 方式：**纯静态源码审计**。本机 Bash 执行器不可用（EXECUTOR_UNAVAILABLE）、无外网，未启动 dev server、未跑测试、未做运行时/截图验证。凡无法由代码直接确认的结论均标注「未验证」。
> 时间：2026-11-13
> 范围：`src/App.tsx`、`src/index.css`（1155 行全量）、`tailwind.config.js`、`components/NavRail.tsx`、`TitleBar.tsx`、`Wordmark.tsx`、`layout/PageShell.tsx`、`components/ui/*`、`components/a11y/GlobalFocusRing.tsx`、`components/ux/*`、以及被它们引用的 `icons.tsx`、`lib/a11y/focus.ts`、`lib/viewport.ts`。
> 结论口径：S1 = 严重阻断（WCAG 失败 / 功能不可达）；S2 = 明显缺陷（一致性、可发现性、系统级偏差）；S3 = 打磨项。

合计 **47 条**：S1 × 2、S2 × 25、S3 × 20。

---

## 1. 设计令牌与主题

- [S1] `src/index.css:144` + `src/index.css:539` — 暗色主题下 danger 按钮是「白字压在浅珊瑚红上」，对比度约 **2.3:1**，未达 4.5:1，危险操作按钮在暗色下几乎读不清 — 证据：`--danger: #ff8a80;`（暗色）与 `.ui-btn-danger { @apply border-transparent text-white; background-color: var(--danger); }` — 建议：danger 按钮文字改用按底色计算的 `--danger-on`（暗色应为深色文字），或暗色下把 `--danger` 调深并保留白字；不要用 `text-white` 写死。
- [S1] `src/components/ux/OnboardingCard.tsx:61-64` + `src/index.css:148` — 引导卡步骤徽标 `bg-[var(--success)] text-white`，暗色 `--success: #6bd08a` 是浅绿，白字对比度约 **1.9:1**，完成态数字看不见 — 证据：`step.done ? "border-[var(--success)] bg-[var(--success)] text-white" : ...` — 建议：与 S1-1 同法，新增 `--success-on` 前景 token（浅底配深字），或暗色改用 `--success-soft` 底 + `--success` 字。
- [S2] `tailwind.config.js:37-40` + `src/index.css:462-466` — 阴影 token 被定义了却不被基元使用：`.ui-card` 直接写死 `rgba(0,0,0,0.07)`，暗色又写一遍（`index.css:958-961`）。改 `boxShadow.card` 不会改变任何卡片 — 证据：`boxShadow: { card: "0 4px 14px rgba(0, 0, 0, 0.07)" }` vs `.ui-card { ... box-shadow: 0 4px 14px rgba(0, 0, 0, 0.07); }` — 建议：`.ui-card` 改用 `var(--shadow-card)`，`@theme` 里同时定义 light/dark 两个值，消除三处字面量。
- [S2] `src/index.css:271-273` 与 `src/index.css:560-572` — 同一个 `.ui-alert` 被定义两次且语义不同：前者 `gap-2` + danger/warn/info/success 四变体，后者 `gap-3` + danger/muted 两变体。后定义覆盖前者，`.ui-alert-warn/info/success` 实际拿到的是 `gap-3` 的骨架 — 证据：两条规则同名 `.ui-alert { @apply flex items-start gap-2 … }` / `.ui-alert { @apply flex items-start gap-3 … }` — 建议：合并为一份（保留四语义词），删除重复块；同类「同名类二次定义」应在 CI 里加一条 grep 门禁。
- [S2] `src/index.css:70`、`src/index.css:139` + `src/App.tsx:886` — 遮罩 token `--scrim` 已定义（亮 0.20 / 暗 0.55），但窄窗文件抽屉用 `bg-black/30`，暗色下仍是 30% 黑（深底上几乎看不出「下面被挡住」），与其他弹窗的 `bg-[var(--scrim)]` 不一致 — 证据：`className="absolute inset-0 cursor-default bg-black/30"` — 建议：统一 `bg-[var(--scrim)]`。
- [S2] `src/index.css:798-1101` + `src/App.tsx:863` — 暗色靠「按字面量类名覆盖」的兼容层支撑（约 200 行），任何新写的十六进制类只要没登记就暗色穿帮；现成反例：拖宽手柄 `hover:bg-[#1a1a1a]/10` 未在覆盖表中，暗色下 hover 反馈消失 — 证据：`className="absolute -left-1 top-0 z-20 h-full w-2 cursor-col-resize hover:bg-[#1a1a1a]/10"` — 建议：把该 hover 改成 `hover:bg-[var(--line)]/40` 一类 token；兼容层作为迁移债列清单逐条燃尽，禁止新增字面量色。
- [S3] `src/index.css:364-388`、`src/index.css:930-938` — 滚动条颜色两套写死值（亮 `#d0d0d0/#a8a8a8`，暗 `#4a4d55/#5a5e66`），未纳入 token，用户换主题色时滚动条不跟随 — 证据：`*::-webkit-scrollbar-thumb { background-color: #d0d0d0; }` — 建议：`--scrollbar-thumb` / `--scrollbar-thumb-hover` 两个 token，暗色只覆盖变量。
- [S2] 全仓只读 grep：`text-\[Npx\]` 命中 **650 处 / 77 个文件**（`App.tsx` 9、`NavRail.tsx` 5）。`index.css:427-451` 已经定下 6 档语义字号（28/15/14/13/12/10），组件仍在自造 11/17/18/26px — 证据：`index.css:427` 注释「只允许用这四档，避免继续长出新字号」与 `NavRail.tsx:61` `text-[11px]`、`Stat.tsx:37` `text-[26px]` 并存 — 建议：先禁止新增，再按页面替换为 `ui-page-title / ui-section-title / ui-body / ui-body-sm / ui-caption / ui-micro`。
- [S3] `src/index.css:349-352` — `.bg-ink` 同时偷偷设置 `color: var(--heming-on-accent)`，靠「未分层样式优先级高于 utilities」压过组件的 `text-white`。这是隐式层叠依赖，把 `.bg-ink` 挪进 `@layer` 或换构建顺序就会翻车 — 证据：`.bg-ink { background-color: var(--heming-accent); color: var(--heming-on-accent); }` — 建议：拆成 `.bg-accent` 与 `.on-accent` 两个语义类，不要一个类两件事。

## 2. 排版与信息层级

- [S2] `src/App.tsx:411` vs `src/components/layout/PageShell.tsx:75` — 同一语义（页面主标题）两种实现：PageShell 用 `.ui-page-title`（28/36、600），重连面板用 `text-[15px] font-extrabold`（15px、800），相差近一倍 — 证据：`<h1 className="text-[15px] font-extrabold">登录状态已保留</h1>` — 建议：重连面板改用 `PageShell` 或至少 `.ui-page-title`，字号/字重只从语义档里取。
- [S2] 全仓只读 grep：`font-extrabold` **12 处 / 11 个文件**（`App.tsx:411`、`OnboardingCard.tsx:29`、`SkillsPage.tsx:461`、`plugins/PluginCard.tsx:79` …），与 `.ui-section-title` 的 `font-semibold`（600）并行。同一个「卡片/分区标题」在 A 处 800、B 处 600 — 证据：`<h2 className="text-[14px] font-extrabold">开始使用</h2>` — 建议：二选一（建议 600，中文粗体 800 在 12–14px 下发糊），全量替换 12 处。
- [S3] `src/components/ui/Stat.tsx:37` — 统计数字 26px，而页面标题 28px：层级只差 2px，首屏会出现「数字和标题一样响」，与其文件头注释「最大字号只能有一个」自相矛盾 — 证据：`<div className="ui-numeric mt-1.5 text-[26px] font-bold leading-none">{value}</div>` — 建议：数字降到 20–22px，或标题升到 30px 拉开 ≥1.3×。
- [S3] `src/App.tsx:213` — `ui-micro`（10px/14、500）本是「角标/徽标仅此用途」，这里承载了共享文件用量 `12.3MB / 100MB` 这种需要读准的信息 — 证据：`<span className="ui-micro min-w-0 flex-1 truncate">` — 建议：改用 `ui-caption`（12px），10px 只留数字角标。

## 3. 布局与响应式

- [S2] 断点体系不在 375/768/1024/1440 标尺上：唯一的 JS 断点是 1200（`lib/viewport.ts:16`），另有四处临时 arbitrary 变体 —— `max-[1199px]`（`PageShell.tsx:73/86`）、`min-[720px]`（`App.tsx:94`）、`min-[900px]`（`OnboardingCard.tsx:45`、`LoginPage.tsx:58`）。1200 与 720/900 之间没有任何档位 — 证据：`<div className="hidden w-[184px] shrink-0 flex-col gap-2 border-r border-line-soft p-3 min-[720px]:flex">` — 建议：把 720/900 收敛到 768/1024，1200 作为产品自定义档在 `tailwind.config.js` 里显式命名（如 `screens.narrow`），而非散落 arbitrary。
- [S2] `src/components/layout/PageShell.tsx:86` — 页面滚动容器同时开 `overflow-y-auto` 与 `overflow-x-auto`：任何一行超宽（长表格、长 URL）都会在整页底部多出一条横向滚动条，而页头不跟着滚，观感是「页头与内容错位」 — 证据：`className={\`min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-auto …\`}` — 建议：默认只 `overflow-y-auto`，横向溢出交给具体内容块（表格包一层 `overflow-x-auto`）。
- [S3] `src/components/layout/PageShell.tsx:84-99` — `scroll=true` 与 `scroll=false` 两个分支的内边距语义不同：前者由 Shell 统一给 `px-6 py-5`，后者完全交给页面自己，于是「双栏页」与「单栏页」的左右边距要各写一遍，正是内边距难以统一的根源 — 证据：`{scroll ? (<div … ${padded ? "px-6 py-5 max-[1199px]:px-4" : ""}>…) : (<div className="flex min-h-0 min-w-0 flex-1 flex-col …">` — 建议：`scroll=false` 也提供 `padded` 包装层，让两个分支的边距来源一致。
- [S3] `src/App.tsx:813` — 应用根节点给整个窗口再画一圈 1px 边框，与窗口/标题栏自身的 `border-b`（`TitleBar.tsx:14`）叠成双线，且暗色下 `bg-white` 依赖兼容层 — 证据：`<div className="flex h-screen flex-col overflow-hidden border border-line bg-white">` — 建议：去掉根节点 border（Electron 已有窗口边界），或明确作为「内衬描边」并在暗色给同等值。
- [S2] `src/App.tsx:822` — auto 导航模式用内联 `paddingLeft: NAV_HOTZONE_PX` 给 8px 热区让位，把「导航宽度」这一布局常量塞进了行内样式，与 `NavRail` 的 `w-[54px]`、`RAIL_WIDTH` 分散在三个位置 — 证据：`style={navMode === "auto" ? { paddingLeft: NAV_HOTZONE_PX } : undefined}` — 建议：壳层布局用 CSS 变量 `--nav-hotzone` + 一个 `pl-[var(--nav-hotzone)]` 类，避免行内样式。
- [S2] `src/App.tsx:828-841` + `src/components/NavRail.tsx:405` — 375/768 窄屏没有导航适配：导航轨仍常驻 54px 且无底部栏/汉堡菜单，唯一窄窗动作是文件栏抽屉；智能体页在 375px 下主内容只剩 375−54−0=321px，再减去页边距更少（静态推断，**未在真机验证**） — 证据：`className={\`flex ${RAIL_WIDTH} shrink-0 flex-col items-center border-r border-line-soft bg-[var(--subtle-2)] py-3\`}` — 建议：≤768 把主导航改为底部 5 项 + 「更多」，或 auto 浮层模式作为窄屏默认。
- [S3] `src/App.tsx:858-864` — 目录栏拖宽手柄是 8px 宽（`w-2`）的整条分隔器，远小于 32px 触摸目标；桌面鼠标可用，触控板/触摸屏很难抓住 — 证据：`className="absolute -left-1 top-0 z-20 h-full w-2 cursor-col-resize hover:bg-[#1a1a1a]/10"` — 建议：命中区扩到 12–16px，视觉线仍 1px（用 `::before` 画线）。

## 4. 组件基元一致性

- [S2] `src/components/ui/Button.tsx:52` — 按钮基元只拼 `.ui-btn-*`，**未**带 `FOCUS_RING`；而 `Stat`、`OnboardingCard`、`UnboundModelNotice`、`ChatEmptyState` 等自拼按钮都带 `FOCUS_RING_TIGHT`。于是「有没有焦点环」取决于 `GlobalFocusRing` 的运行时注入是否执行，而不是组件契约 — 证据：`className={\`ui-btn ui-btn-${size} ui-btn-${variant}${className ? \` ${className}\` : ""}\`}` — 建议：`Button` 内置 `FOCUS_RING`（与 `lib/a11y/focus.ts:20` 同源），并让 `Button` 成为唯一按钮出口。
- [S2] `src/App.tsx:218-244`、`src/App.tsx:422-432`、`src/App.tsx:836` — 手拼按钮仍在发生（本文件 6 处），高度/字号/边框各写一遍：`px-2 py-0.5 text-[11px]`（≈22px 高）、`rounded-lg px-3 py-1.5 text-[12px]`、`rounded-md border px-2.5 py-1 text-[12px]`，而 `.ui-btn-sm` 是 28px — 证据：`className="shrink-0 rounded-md border border-line px-2 py-0.5 text-[11px] shadow-card hover:bg-[var(--subtle-2)]"` — 建议：全部换成 `<Button size="sm" variant="ghost">`，删除 6 处手拼。
- [S2] 触摸目标系统偏小：`.ui-btn-sm` 28px（`index.css:513-515`）、`.ui-link` 24px（`index.css:549-551`）、NavRail 快捷键/固定按钮 26px 高（`NavRail.tsx:285/341`）、头像 28×28（`NavRail.tsx:356`）、手拼按钮 ≈22px（`App.tsx:223/231/240`、`UnboundModelNotice.tsx:97`）—— 全部低于 32px 标尺 — 证据：`className="flex h-[26px] w-[34px] items-center justify-center rounded-lg text-[13px] font-bold text-muted …"` — 建议：桌面最小 28、触控 32；把 26/22 两档抬到 32（或加透明外扩命中区）。
- [S2] `src/components/ui/Switch.tsx:21-22` 与 `:35` — 注释写「禁用：**仍然可聚焦**但不可切换，语义交给 aria-disabled」，实现却给了原生 `disabled`，禁用后不可聚焦，键盘/读屏用户根本到不了这个设置 — 证据：`aria-disabled={disabled || undefined} disabled={disabled}` — 建议：二选一并对齐注释——若要可聚焦，用 `aria-disabled` + 点击守卫，不要原生 `disabled`。
- [S2] 全仓只读 grep：`cursor-pointer` 仅 **29 处 / 16 个文件**。Tailwind v4 preflight 不再给 `button` 默认 `cursor: pointer`（默认 `default`），因此 NavRail 每个按钮、App 每个手拼按钮都没有手型反馈（按框架行为判断，**未运行时验证**） — 证据：`NavRail.tsx:267-271` 搜索按钮 `className="flex h-[34px] w-[34px] items-center justify-center rounded-lg text-muted transition-colors duration-150 …"` 无 `cursor-pointer` — 建议：在 `.ui-btn` / `.ui-link` / 导航按钮基类里统一 `cursor-pointer`，而不是逐处补。
- [S2] `src/components/ui/Stat.tsx:44-52` — 「可下钻」统计卡渲染成 `<button>`，hover 只换底色、没有 `cursor-pointer`，视觉上与其他静态卡无从区分（点得动这件事不可发现） — 证据：`className={\`ui-card p-4 text-left transition-colors hover:bg-[var(--subtle)] ${FOCUS_RING}…\`}` — 建议：加 `cursor-pointer`，并把 hover 从「换底色」升级为「边框 + 1px 抬升」（`ui-card-interactive` 已有此语义）。
- [S3] `src/components/ui/EmptyState.tsx:21` 与 `src/index.css:296-300` — 注释说「统一放在 **32px** 的图标槽」，实现 `.ui-icon-tile` 是 `h-10 w-10`（40px）；`ChatEmptyState` 又自建 40px 槽但用 `rounded-2xl`（16px）而基元是 `rounded-xl`（12px） — 证据：`<div className="ui-icon-tile" aria-hidden="true">` vs `@apply inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl;` — 建议：注释改 40px；`ChatEmptyState` 改用 `EmptyState` 的图标槽。
- [S3] `src/components/ui/Skeleton.tsx:23` + `src/App.tsx:111` — `SkeletonBlock` 默认值 `h-24 w-full rounded-lg` 被调用方原样重复传一遍；`SkeletonCard` 用 `ui-card`（`rounded-xl`）而 `SkeletonBlock` 默认 `rounded-lg`，同类占位两种圆角 — 证据：`<SkeletonBlock className="h-24 w-full rounded-lg" />` — 建议：删掉调用处重复参数，圆角统一到 `rounded-xl`。
- [S3] `src/components/ui/Field.tsx:26-59` — 表单基元只覆盖 `<input>`：`select` 仍手写 `.ui-input` 且只有 `aria-label` 没有可见 label（`UnboundModelNotice.tsx:82`），`textarea` 同理。基元覆盖率 1/3，等于「统一表单」只统一了最不容易出错的那种 — 证据：`<select aria-label="选择要绑定的模型连接" … className="ui-input w-auto">` — 建议：补 `SelectField`/`TextareaField`（同一 label/error/aria 契约）。
- [S3] `src/components/ui/ErrorState.tsx:59-64` — 失败态的「重试」用 `variant="ghost"`（次要按钮），而错误恢复恰恰是此刻唯一该做的事；空态的 `actions` 反而常放 primary，语义相反 — 证据：`<Button variant="ghost" size="sm" onClick={onRetry}>` — 建议：重试改 `primary`，或提供 `retryVariant` 由场景决定。
- [S2] `src/components/ui/ErrorState.tsx:45-58` + `src/index.css:606-617` — 失败态直接复用 `.ui-empty*` 骨架，与空态只差一个图标（`ErrorState` 是 `role="alert"` 的居中大图标 + 标题 + 说明）；用户扫一眼分不清「这里没有内容」和「这里加载失败」 — 证据：`className={\`ui-empty${compact ? " gap-1 py-5" : ""}…\`}` — 建议：失败态换左对齐的 `.ui-alert` 骨架（或至少给 danger 左边条），让「空」与「坏」在结构上可分。
- [S3] `src/components/ui/Stat.tsx:42` — 统计卡与普通卡片共用 `ui-card p-4`，没有「指标卡」的独立密度（首页 p-3 / 设置页 p-4 的历史差异被抹平了，但首页需要更密）；文件头注释也承认这是折中 — 证据：`return <div className={\`ui-card p-4…\`}>{body}</div>;` — 建议：加 `density="compact"` 档，或首页改用 `gap` 而非卡片内边距调密度。

## 5. 可访问性

- [S2] `src/components/a11y/GlobalFocusRing.tsx:37-46` 与 `src/lib/a11y/focus.ts:20-23` — 两套焦点机制并存：全局 `:focus-visible` 由 JS 注入 `<style>`，组件层又各带 `focus-visible:outline-*` 类。JS 未执行/早期渲染时，56 处 `outline-hidden` 控件没有任何可见焦点环（该组件自己的注释说明了这个风险） — 证据：`const style = document.createElement("style"); style.id = FOCUS_STYLE_ID; style.textContent = FOCUS_CSS; document.head.appendChild(style);` — 建议：把 `FOCUS_CSS` 落进 `index.css`（作为样式基线），组件类只作补充；全局规则与组件类保持同一颜色/偏移。
- [S2] `src/App.tsx:858-864` — `role="separator"` + `aria-label="调整目录栏宽度"` 的拖动条只有 `onPointerDown`，没有 `tabIndex`、没有方向键处理、没有 `aria-valuenow`：读屏会播报一个「可调整」的分隔器，键盘却调不了 — 证据：`<div role="separator" aria-orientation="vertical" aria-label="调整目录栏宽度" onPointerDown={onResizeStart} … />` — 建议：改为可聚焦 `role="separator"` + `aria-valuemin/max/now` + ←/→ 步进 8px，或改用 `<input type="range">` 语义。
- [S2] `src/App.tsx:507/516/526` — 三处 `window.alert` 承担错误与前置条件提示：不可主题化、阻塞渲染、与 `useModalA11y` 的焦点管理完全脱节；并且与同仓既定口径直接矛盾（`MemoryPage.tsx:70`「一切失败都内联中文提示，不用 window.alert（与设置区同风格）」） — 证据：`window.alert(\`上传失败：${e instanceof Error ? e.message : String(e)}\`);` — 建议：换成 `ErrorState`/`ui-alert` 内联提示或统一 toast；`alert` 在 Electron 里还会打断输入。
- [S2] `src/components/ux/ComposerHints.tsx:9-11` — `aria-label` 挂在 `<p>` 上：普通段落没有 role，多数读屏不播报 `aria-label`，这行提示对读屏用户等于不存在 — 证据：`<p aria-label="输入快捷键提示" className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] leading-4 text-muted">` — 建议：加 `role="note"` 或直接去掉 aria-label（文本本身可读），并保证 `<kbd>` 与说明文字在朗读顺序上成对。
- [S3] `src/index.css:501-503` — `.ui-input:focus { @apply border-ink; }` 用的是 `:focus` 而不是 `:focus-visible`：鼠标点进输入框也变边框，与全局「键盘才出焦点环」的策略不一致，且 `outline-hidden`（`index.css:491`）让输入框只剩这一条 1px 边框作焦点指示 — 证据：`.ui-input:focus { @apply border-ink; }` — 建议：`:focus-visible` + 2px outline，`:focus` 只保留边框色变化。
- [S3] `src/App.tsx:757-761` — 恢复登录的加载态是一行居中灰字，无 `role="status"`、无 `aria-busy`，与同文件 `PageFallback`（`role="status" aria-busy="true"` + 骨架）两套加载语言 — 证据：`<div className="flex h-full w-full items-center justify-center text-muted">正在恢复登录…</div>` — 建议：复用 `PageFallback` 或加 `role="status"` 的骨架。

## 6. 动效

- [S3] 动效时长无 token、语义混用：150ms（`NavRail.tsx:61/271`）、160ms（`NavRail.tsx:457`）、200ms（`index.css:194`）、280ms（`index.css:736`）、300ms（`index.css:1139`），hover / 浮层 / 入场三种语义共用同一批数字 — 证据：`transition-all duration-150` 与 `transition-[transform,opacity] duration-[160ms]` 并存 — 建议：定义 `--motion-fast: 150ms` / `--motion-base: 200ms` / `--motion-enter: 280ms`，CSS 与 Tailwind 都引用同一组值。
- [S2] `prefers-reduced-motion` 覆盖不全：`index.css` 只覆盖 skeleton（624-628）、plugin card（741-751）、rta 动效（1144-1154）与 `ui-card-interactive`；NavRail 的 tooltip 位移动画（`NavRail.tsx:61` `translate-x-1 … transition-all`）、导航按钮 `transition-colors`、auto 浮层（457 行有 `motion-reduce:transition-none` 但 tooltip 没有）仍在动 — 证据：`… opacity-0 shadow-card transition-all duration-150 group-hover:translate-x-0 group-hover:opacity-100 …` — 建议：把 `@media (prefers-reduced-motion: reduce) { *, ::before, ::after { animation-duration: .01ms !important; transition-duration: .01ms !important; } }` 作为全局兜底，再对必要处恢复。
- [S3] `src/index.css:193-207` 与 `:653-668` — 两套 hover 抬升各写一套数值（`.ui-card-interactive`：`translateY(-1px)` + `0 6px 18px rgba(0,0,0,.1)`；`.plugin-card`：`translateY(-1px)` + `0 10px 26px rgba(0,0,0,.085)`），同一种「卡片浮起」两种阴影 — 证据：两个块各自的 `box-shadow` 字面量 — 建议：合并为一个 `.ui-lift` 或统一引用 `--shadow-lift`。

## 7. AI-slop 与视觉风格

- [S2] `src/components/ux/ChatEmptyState.tsx:18-37` — 教科书式「居中堆叠空状态」：`items-center justify-center text-center` + 圆角图标 + 标题 + 一句说明 + 3 条示例按钮；且完全不复用 `EmptyState`，字号/字重自定（标题 13px `font-bold` vs `.ui-empty-title` 13px `font-semibold`；说明 11px vs `.ui-empty-desc` 12px） — 证据：`<div className="flex h-full flex-col items-center justify-center px-6 text-center">` — 建议：改用 `EmptyState`（保持一处实现），并把「示例」做成左对齐的列表区（空态不一定要居中）。
- [S3] `src/App.tsx:409-435` — 重连失败面板同样是居中堆叠模板：`max-w-[380px] text-center` + 15px 特粗标题 + 12px 说明 + 11px 补充 + 两个按钮，且按钮手拼（非 `.ui-btn`） — 证据：`<div className="w-full max-w-[380px] text-center">` — 建议：改为左对齐的 `ErrorState`/卡片，标题走 `.ui-page-title`。
- [S3] `src/index.css:96-103` — 紫色系 token 残留：`--chart-2: #7c6bd6`、`--avatar-1: #7c6bd6`、`--avatar-5: #db2777`（暗色 `#a997ff` / `#ee7ab0`）。没有渐变滥用（`gradient` 只出现在 `BootWave` 的遮罩，语义合理），但「紫 + 粉」仍是最容易被读成 AI 模板的一组配色 — 证据：`--chart-2: #7c6bd6;` / `--avatar-5: #db2777;` — 建议：图表第二色换蓝绿系（`#0f9d8a` 已在 avatar-3），粉紫只保留在头像色板且降低饱和度。
- [S3] 圆角刻度无系统：`rounded-sm / md / lg / xl / 2xl / full` 全在用（`index.css` 与 `App.tsx:894`、`ChatEmptyState.tsx:19`、`ux` 各处），同一层级的「卡片」出现 12px（`ui-card`）与 16px（`ChatEmptyState`、`plugins/*Dialog`）两种 — 证据：`rounded-2xl border border-line-soft bg-[var(--surface)] p-3` — 建议：定 3 档（4 控件 / 12 卡片 / 999 胶囊），弹窗沿用卡片 12px。

## 8. 图标

- [S2] 图标尺寸无栅格：`icons.tsx:3-13` 默认 18px，但调用处 17（NavRail 导航项）、15（Pin）、14（User）、22（EmptyState/ChatEmptyState/ErrorState）、24 混用；同一列导航图标里 17 与 15 并排，视觉重量不齐 — 证据：`width: 18, height: 18,`（`base`）与 `<PinIcon width={15} height={15} />`、`<UserIcon width={14} height={14} />` — 建议：定 14/16/20/24 四档（16 为主），把 17/15/22 归位；`base` 默认值也改 16。
- [S3] `src/components/icons.tsx:121` — `GearIcon` 的单行压缩写法与其余图标格式不一致（`export const GearIcon = (p: SVGProps<SVGSVGElement>) => (  <svg {...base(p)}>`），会干扰 diff 与格式化门禁；不影响渲染 — 证据：同文件其余图标均为多行 — 建议：跑一次格式化统一。
- 说明：emoji 没有被当 UI 图标使用（全仓 grep 仅 `EmojiPicker.tsx:8-10` 的表情数据与 `AgentStreamBubble.tsx:245` 的 `" ✓"` 文本勾，前者是选择器本身、后者是流式文本装饰），`icons.tsx:150` 还专门记录了用 SVG 替换「× / ✕」文本字形的决定。这一项**通过**，不作为问题计。

---

## 9. 跨组件共性问题

1. **「定义了基元，但调用方绕过去」是主线问题。** `Button`（手拼 6 处 + 全仓上百处）、`Field`（select/textarea 未覆盖）、`EmptyState`（`ChatEmptyState` 自建）、`Skeleton`（默认值重复传）、`ui-card`（`ChatEmptyState` 自建 16px 圆角卡）、`--scrim`（`bg-black/30` 绕过）——每一处都有一套「为什么」注释，但注释本身证明团队知道问题存在而没有收口。
2. **暗色主题是「类名映射」而非「token 驱动」。** 200 行 `[data-theme="dark"] .bg-\[\#fafafa\]` 式覆盖意味着：任何新组件只要写一次字面量颜色，暗色就穿帮（`App.tsx:863` 已经是现成反例）。这类兼容层无法靠 review 防住，只能靠 lint 禁止字面量色类。
3. **两套并行的「设计系统」：CSS 类（`.ui-*`）与 Tailwind 原子类。** 同一语义既有 `.ui-btn-sm`（28px）又有手拼 `py-0.5 text-[11px]`（22px）；既有 `.ui-page-title`（28px）又有 `text-[15px] font-extrabold`。文件头注释说「不引入第二套样式」，但第二套以「临时手拼」的形式长出来了。
4. **字号/字重/圆角/阴影/动效/图标六个维度都没有硬性刻度。** 字号 650 处任意值、字重 600 与 800 并行、圆角 6 档、阴影 5 套 rgba、时长 5 个值、图标 5 个尺寸。设计判断不是「不好看」，而是「不可预测」：同一个新人写卡片，无法从 token 推出该用哪个值。
5. **可用性投入在「键盘路径」上明显高于「鼠标/触控路径」。** 焦点环、inert、Esc 归属、焦点归还都做得很细（NavRail 的 465 行几乎一半是键盘逻辑），但 `cursor-pointer` 全仓仅 29 处、触摸目标 22–28px、`window.alert` 还在用——精细的键盘体验与粗糙的指针体验并存。
6. **注释质量高但经常与实现漂移。** `Switch` 的「仍可聚焦」vs 原生 `disabled`、`EmptyState` 的「32px 槽」vs 40px、`Stat` 的「最大字号只能有一个」vs 26px 数字——注释可以当作需求文档用，但需要一条「注释与代码一致性」的检查。

## 10. 建议抽成通用件的清单

| 建议新件 / 收口对象 | 现状（重复处） | 统一后的契约 |
| --- | --- | --- |
| `Button` 全量迁移 | `App.tsx:218-244/422-432/836`、`NavRail.tsx:374-390` 手拼；全仓上百处 `ui-btn ui-btn-md` | `variant/size/leadingIcon/busy` + 内置 `FOCUS_RING` + `cursor-pointer`；`size` 只留 28/32/36 |
| `IconButton` | NavRail 搜索/快捷键/固定/头像 4 种尺寸（34/26/28、17/15/14px） | 固定 32×32、图标 16、`aria-label` 必填、tooltip 内建 |
| `Tooltip`（`Tip`） | `NavRail.tsx:57-71` 私有实现，`bg-ink` + `text-white` 依赖层叠 | 主题化 tooltip，`aria-hidden` + 触发者 `aria-describedby`，支持 `prefers-reduced-motion` |
| `Card` / `MetricCard` | `ui-card`、`Stat`、`ChatEmptyState:19`、`OnboardingCard:25`、各处 `rounded-2xl border … shadow-xl` | 单一圆角 12 + `--shadow-card` + `density` 档 |
| `FormField` 家族 | `Field.tsx` 只有 input；`select`/`textarea` 手写 | `TextField / SelectField / TextareaField / SwitchField` 共用 label+error+`aria-describedby` |
| `EmptyState` + `ErrorState` 的两种骨架 | `EmptyState` 居中、`ErrorState` 复用居中骨架 | 空态居中、失败态左对齐告警条（结构上可分） |
| `Alert`（`ui-alert`） | `index.css` 同名类两份（271 / 560） | 一份四色 + `gap-3` + `role` 由调用方决定 |
| `ResizeHandle` | `App.tsx:858-864`，指针专用 | 键盘可调（`role="separator"` + ←/→）、命中区 ≥12px、token 化 hover 色 |
| `LoadingState` | `App.tsx:759` 纯文本、`PageFallback` 骨架、各页自写 | `role="status"` + 骨架/文本两档 |
| `Toast` / 内联 `ui-alert` | `window.alert` × 3 | 非阻塞、可主题化、与 `useModalA11y` 不冲突 |
| 动效 token | 5 个时长值散落 | `--motion-fast/base/enter` + 全局 reduced-motion 兜底 |
| 图标尺寸 token | 14/15/17/18/22/24 | 14/16/20/24，`icons.tsx` 默认 16 |
| `--accent` 前景类 | `.bg-ink` 自带 `color` | `.bg-accent` + `.text-on-accent` 拆开 |

## 11. Top 10 优先修复

1. **暗色 danger 按钮白字**（`index.css:144/539`，≈2.3:1）—— 危险操作在暗色下不可读，先修。
2. **暗色完成态徽标白字**（`OnboardingCard.tsx:63`，≈1.9:1）—— 同上，补 `--success-on` / `--danger-on` 两个前景 token。
3. **`window.alert` × 3 换内联提示**（`App.tsx:507/516/526`）—— 与全仓既定口径冲突，且阻塞渲染。
4. **`Button` 内置焦点环 + 全量替换 6 处手拼按钮**（`Button.tsx:52`、`App.tsx:218-244` 等）—— 解决「焦点环靠 JS 注入」与「按钮高度 22/28/32 三档」。
5. **触摸目标抬到 32px**（`index.css:513/549`、`NavRail.tsx:285/341/356`）—— 4 处基类 + 3 个导航控件。
6. **删除重复的 `.ui-alert` 定义**（`index.css:271` 与 `560`）—— 一份四色，避免后定义静默覆盖。
7. **断点收敛**：`min-[720px]` / `min-[900px]` → 768/1024，1200 在 config 里命名（`App.tsx:94`、`OnboardingCard.tsx:45`、`PageShell.tsx:73`）。
8. **`ChatEmptyState` 改用 `EmptyState`**，并把示例区改左对齐（`ChatEmptyState.tsx:18-51`）—— 去掉最典型的一处 empty-state 模板。
9. **`Switch` 禁用态与注释对齐**（`Switch.tsx:21-35`）—— 决定「可聚焦但不可切换」还是「直接不可达」。
10. **暗色 hover 硬编码**（`App.tsx:863`）+ **滚动条 token 化**（`index.css:364-388`）—— 暗色下两处可见缺陷。

## 12. 本区域整体设计判断（5 条）

1. **这是一个「被认真重构过、但重构只完成一半」的设计系统。** d.62/d.63/d.68/d.138 四轮把页面级排版、卡片、按钮、空态、骨架、焦点环都建了基元，且 token 语义命名（`line/muted/ink/panel/surface/subtle`）是专业水准；但**基元没有强制力**——`Button` 有了仍手拼、`EmptyState` 有了仍自建、`--scrim` 有了仍写 `bg-black/30`。下一步的收益不在「再定一套 token」，而在「让旧写法编不过/过不了 lint」。
2. **字体与配色方向正确，不是 AI 模板脸。** 无 Inter/Roboto/Arial，字体栈是「拉丁 → CJK → 系统」的合理顺序并写了理由（`index.css:11-26`），无紫粉渐变、无 radial 光晕（`index.css:633-638` 明确删掉了）、无 emoji 图标。**主要视觉风险集中在暗色主题的对比度**（两条 S1）与**紫/粉头像/图表色**（S3），不是整体气质问题。
3. **键盘可访问性是这个仓库的强项，指针/触控可访问性是短板。** NavRail 的焦点归还、inert 门闩、Esc 归属处理比多数商业产品细；但 `cursor-pointer` 29 处、22–28px 命中区、指针专用的拖宽手柄、`window.alert` 说明「可访问性」被理解成了「键盘可用」。
4. **信息层级在「页面级」已建立（28/14/15/13/12/10 六档），在「组件级」失控。** 650 处任意字号、12 处 `font-extrabold`、26px 数字贴近 28px 标题，导致同一屏里「谁最响」需要逐页判断而不是由系统决定。建议下一轮只做一件事：把 `text-[Npx]` 按语义档全量替换并加 lint 禁止新增。
5. **暗色主题的实现方式是当前最大的系统性技术债。** 200 行「按字面量类名覆盖」能保证旧页面不穿帮，但它把「暗色正确」变成了「记得登记」——而新增代码不会记得。这也是 S1 对比度问题能同时出现在两个不相干组件里的根本原因：颜色语义没有在组件层被约束。