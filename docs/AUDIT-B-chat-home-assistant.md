# 和鸣 Web · UI/UX 审计报告（轨道 B：对话 / 首页 / 智能体 / 浮层）

- 审计者：auditor-chat（Agent Teams 子代理）
- 日期：2026-11-13
- 前端栈：React 18 + TypeScript + Vite + Tailwind v4，`packages/web`
- 审计方式：**纯静态源码审计**。本机 Bash 执行器不可用（EXECUTOR_UNAVAILABLE）、无外网、无法启动 dev server，因此**没有运行时截图、没有 axe/Lighthouse、没有真机断点验证**。所有对比度为按 WCAG 相对亮度公式的手算值；所有布局结论来自 CSS/DOM 结构推断，凡需浏览器才能确认的均标注「未验证」。
- 严重度：**S1 阻断**（核心场景不可用/内容不可读）/ **S2 缺陷**（明显违反审计标尺、影响可用性）/ **S3 打磨**（一致性、可读性、可维护性）。
- 覆盖文件（15 个）：
  - 对话轨：`components/ChatPage.tsx`(3610 行)、`components/MarkdownMessage.tsx`、`components/AgentStreamBubble.tsx`
  - 智能体/会话轨：`components/AssistantPage.tsx`、`components/assistant/ConversationRail.tsx`、`AgentPicker.tsx`、`AgentRosterView.tsx`、`AgentEditorView.tsx`、`AgentFormPanel.tsx`
  - 首页：`components/HomePage.tsx`、`home/NeedsAttention.tsx`、`home/RecentConversations.tsx`、`home/HomeTeamUsage.tsx`
  - 浮层/通用：`ConfirmDialog.tsx`、`FilePreviewModal.tsx`、`FileEditCard.tsx`、`ToolApprovalModal.tsx`、`ShortcutsHelp.tsx`、`ChatChart.tsx`、`CommandPalette.tsx`、`NotificationCenter.tsx`、`LoginPage.tsx`、`a11y/GlobalFocusRing.tsx`、`useModalA11y.ts`、`store/*` 相关引用
  - 样式基线：`src/index.css`（令牌、`.ui-*` 基元、暗色兼容层）
- 计数：**S1 × 3，S2 × 20，S3 × 21，合计 44 条**。

**结论先行（Top 5）**
1. **聊天壳在 375px 完全不可用**：会话轨恒定 264px，而 `ChatPage/AssistantPage/ConversationRail` 三个文件里只有 1 处响应式类（`AssistantPage.tsx:297` 的 `hidden sm:inline`）。
2. **暗色模式下危险操作按钮白字压浅红**（`--danger` 暗色 `#ff8a80`，约 1.7:1）：影响删除智能体、清空通知、工具确认等全部破坏性入口。
3. **键盘用户拿不到「复制消息」**：`ChatPage.tsx:3305` 用 `hidden + group-hover:block`，纯文本消息行内没有其它可聚焦元素，按钮永远进不了 Tab 序列。
4. **对话流式渲染会跳**：流式气泡（78% 宽、带底色）与落定后的全宽无底色转录（`px-0.5`）是两套容器；且「▌」光标被拼进 markdown 文本整体重渲染，表格/列表每 tick 重排。
5. **浮层体系四分五裂**：遮罩有 `var(--scrim)`、`bg-black/20`、`bg-black/75` 三种、关闭手势有 `onClick`/`onMouseDown` 两种、颜色有 token 与 `red-50`/`#f4f4f4` 手写两种，暗色下逐处失效。

---

## S1 阻断（3 条）

### B-S1-01 375px 下聊天主区仅剩约 111px，整个会话页没有响应式布局
- 位置：`packages/web/src/components/assistant/ConversationRail.tsx:366`；`packages/web/src/components/ChatPage.tsx:3117`
- 证据：
  ```tsx
  <aside className="flex w-[264px] shrink-0 flex-col border-r border-line-soft">
  ```
  ```tsx
  <div ref={scrollRef} data-testid="message-list" onScroll={onMessageScroll}
       onDragOver={onMessagesDragOver} onDrop={onMessagesDrop}
       className="flex-1 overflow-y-auto px-6 pb-5 pt-6">
  ```
  在 `ChatPage.tsx` + `AssistantPage.tsx` + `ConversationRail.tsx` 三份文件里对 `sm:|md:|lg:|xl:` 的全量检索只命中 **1 处**：
  `AssistantPage.tsx:297 <span className="hidden sm:inline">本机运行 · 不进团队动向</span>`。
  → 375px 视口：375 − 264（rail）= **111px** 留给消息列（再扣 `px-6` 左右各 24px，内容宽 63px），composer 的 5 个按钮 + textarea 也无法排布。
- 建议：< 768px 时 rail 收成 60px 窄轨（`collapsed` 分支已存在，可直接复用）或改为抽屉；ChatPage 头部/消息区/工具栏补 `max-md:` 断点与 `min-w-0`，并把「复制/多选/搜索」在窄屏收进 `⋯` 菜单。
- 备注：375 下的最终裁切表现未真机验证，但「固定 264px + 零断点」可静态判定。

### B-S1-02 新建/编辑智能体弹窗固定 380px，在 375 视口必然横向溢出
- 位置：`packages/web/src/components/assistant/AgentFormPanel.tsx:261`（外层 :523-528）
- 证据：
  ```tsx
  className={
    modal
      ? "max-h-[90vh] w-[380px] overflow-y-auto rounded-xl border border-line bg-white p-5 shadow-card"
      : "ui-card w-full p-5"
  }
  ```
  ```tsx
  <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/20" ...>
  ```
  380px > 375px，且没有任何 `max-w-[92vw]` 兜底 → 右边缘被裁（名称输入框、「创建/保存」按钮在右侧）。
- 建议：与 `ConfirmDialog.tsx:60` 的 `w-[min(560px,92vw)]` 同一口径，改为 `w-[380px] max-w-[92vw]`；窄屏下也可改为全屏 sheet。

### B-S1-03 通知中心面板 320px 从 60px 窄轨向右展开，375 下关闭/清空按钮越界
- 位置：`packages/web/src/components/NotificationCenter.tsx:193`
- 证据：
  ```tsx
  className="absolute bottom-0 left-full z-40 ml-2 flex max-h-[70vh] w-[320px] flex-col overflow-hidden rounded-xl border border-line-soft bg-[var(--surface)] shadow-card"
  ```
  左边界 = 窄轨 60px + `ml-2` 8px = 68px，右边界 = 388px > 375px；面板头部的「全部已读 / 清空 / ×」在右上角，正好落在视口外。
- 建议：`w-[320px] max-w-[calc(100vw-76px)]`，或窄屏改为 `left-0 right-0 bottom-0` 的底部 sheet。

---

## S2 缺陷（20 条）

### B-S2-01 「复制消息」悬停专属，键盘不可达
- 位置：`packages/web/src/components/ChatPage.tsx:3302-3309`
- 证据：
  ```tsx
  <button type="button" aria-label="复制消息"
    className="absolute -top-2 right-0 hidden rounded-sm border border-line bg-[var(--surface)] px-1.5 py-0.5 text-[10px] text-muted shadow-card hover:text-ink group-hover:block group-focus-within:block"
    onClick={() => void copyMessage(m)}>
  ```
  `hidden`（display:none）先移出 tab 序列；`group-focus-within:block` 只有在行内已有可聚焦子元素时才可能触发，而纯文本消息行（`:3243` 的 group）里没有链接/按钮 → 键盘用户永远无法显示并聚焦它。
- 建议：常驻渲染、用 `opacity-0 group-hover:opacity-100 group-focus-within:opacity-100` 做视觉隐藏（保留可聚焦）；或放进消息操作菜单，并补 `aria-live` 复制成功提示（当前靠按钮文案变「已复制」）。

### B-S2-02 composer 拖拽把手只有指针事件，键盘/读屏无法调整高度
- 位置：`packages/web/src/components/ChatPage.tsx:3478-3489`（逻辑 `:2258-2279`）
- 证据：
  ```tsx
  <div role="separator" aria-label="调整输入栏高度" aria-orientation="horizontal"
       className="group -mt-1 flex h-2 cursor-row-resize items-center justify-center"
       onPointerDown={onComposerDragStart} onPointerMove={onComposerDragMove}
       onPointerUp={onComposerDragEnd} onPointerCancel={onComposerDragEnd}>
  ```
  无 `tabIndex`、无 `aria-valuenow/valuemin/valuemax`、无 ArrowUp/Down/Home/End 处理；`h-2` = 8px 命中区。
- 建议：`tabIndex={0}` + 方向键步进（8px，Shift 32px）+ `aria-valuenow={composerHeight}`，命中区扩到 ≥12px；或提供「单行/多行」切换按钮作为等价入口。

### B-S2-03 首屏骨架固定 h-9 且绕过统一骨架件，无 reduced-motion
- 位置：`packages/web/src/components/ChatPage.tsx:3144-3148`
- 证据：
  ```tsx
  {[0, 1, 2].map((i) => (
    <div key={i} className={`flex ${i % 2 === 1 ? "justify-end" : ""}`}>
      <div className="h-9 w-[46%] animate-pulse rounded-xl bg-[var(--subtle-3)]" />
    </div>
  ))}
  ```
  三条等高 36px 的块与真实消息（10px 署名行 + 多行正文 + 思考/工具块）高度分布不一致 → 骨架消失时内容整体跳动；且 `animate-pulse` 未尊重 `prefers-reduced-motion`，而全站 `.ui-skeleton`（`index.css:620-628`）已经做了该适配。
- 建议：改用 `.ui-skeleton`，按「署名 10px + 2~3 行正文」结构出 2 条骨架。

### B-S2-04 消息加载失败态用 `h-full` 在 auto 高度父级里居中，大概率失效
- 位置：`packages/web/src/components/ChatPage.tsx:3152`（父级 `:3120`）
- 证据：
  ```tsx
  <div className="mx-auto w-full max-w-[880px]">        // :3120，高度 auto
  ...
  <div className="flex h-full flex-col items-center justify-center text-center">  // :3152
  ```
  百分比高度在高度为 auto 的父级上不解析，`h-full` 退化为内容高度 → 错误块贴在列表顶部而不是垂直居中（在有滚动的列表里视觉上「消失」）。
- 建议：外层滚动容器上做居中（`flex flex-col` + `m-auto`），或给错误态 `min-h-[60vh]` 绝对高度。**未真机验证**（浏览器对 `height:100%` 在 auto 父级上的处理一致，判定为高置信推断）。

### B-S2-05 流式气泡与落定消息是两套容器，生成结束瞬间宽度/底色/边框跳变
- 位置：`packages/web/src/components/AgentStreamBubble.tsx:53` vs `packages/web/src/components/ChatPage.tsx:3283`
- 证据：
  ```tsx
  // AgentStreamBubble.tsx:53
  <div className="max-w-[78%] rounded-lg border border-line-soft bg-[var(--subtle-2)] px-3 py-2 text-[13px]">
  ```
  ```tsx
  // ChatPage.tsx:3283 落定后的助手消息
  <div className="px-0.5">
  ```
  同一条回答在 `finish` 时从「78% 宽气泡」变成「全宽无气泡」，用户正在读的行会横移、背景消失。
- 建议：流式与落定共用同一个 `AssistantTranscript` 容器（d.126-C 的转录样式），只让内部状态（光标/状态点）变化。

### B-S2-06 流式光标「▌」被拼进 markdown 文本，整体重渲染造成抖动
- 位置：`packages/web/src/components/AgentStreamBubble.tsx:67`
- 证据：每次片段到达把光标字符追加到文本后再交给 MarkdownMessage 整体重新解析（渲染路径 `:67` 附近），表格列宽、列表缩进、代码块宽度随每个 chunk 变化 → 「边到边重排」，正是对话应用标尺要禁止的「流式输出抖动跳行」。
- 建议：光标改为独立元素（气泡内 `<span className="inline-block w-[2px] animate-pulse">` 用绝对/尾部定位），不进入 Markdown 源串；表格/代码块加 `contain: content` 或延迟布局（`content-visibility`）。
- 备注：是否存在「稳定高度占位」未在源码中找到（无 min-height/等宽占位逻辑）→ 判定缺失。

### B-S2-07 会话内搜索用字形当图标，热区约 22×20
- 位置：`packages/web/src/components/ChatPage.tsx:3041`、`:3050`、`:3058`
- 证据：上一个/下一个/关闭三个按钮的内容分别是文本 `↑`、`↓`、`×`，类名为 `rounded-sm px-1.5 py-0.5`；同仓已有 `icons.tsx`（13KB SVG 图标集）。
- 建议：换 `ArrowUpIcon/ArrowDownIcon/CloseIcon`（13-14px，`aria-hidden`），容器 `p-2` 保证 ≥32px；搜索框本身可加 `aria-describedby` 播报「第 n / m 条」。

### B-S2-08 多选框 `accent-[#1a1a1a]` 硬编码，暗色下选中态不可辨
- 位置：`packages/web/src/components/ChatPage.tsx:3260`
- 证据：
  ```tsx
  className="h-3.5 w-3.5 cursor-pointer accent-[#1a1a1a]"
  ```
  暗色 `--surface` 为 `#16171a`，`#1a1a1a` 的勾选块与背景几乎同色；`index.css:782-1101` 的暗色兼容层按类名映射，**没有** `accent-[…]` 规则。对照：`TeamPage.tsx:553` 已改用 `accent-[var(--ink)]`。
- 建议：统一 `accent-[var(--ink)]`（暗色自动反白）；顺带把 `h-3.5 w-3.5` 提到 20px 命中（label 内已有 `mt-1.5`）。

### B-S2-09 会话轨可点目标普遍低于 32px
- 位置：`packages/web/src/components/assistant/ConversationRail.tsx:323`、`:375`、`:450`、`:265`、`:250`
- 证据：
  ```tsx
  className="flex h-7 w-7 items-center justify-center rounded-md text-[#666] ...">›   // :323 28×28
  className="ml-auto flex h-[24px] w-[20px] items-center justify-center ...">‹      // :375 20×24
  className="flex h-5 w-5 items-center justify-center rounded-sm ..."                // :450 20×20
  className="block w-full rounded-sm px-2 py-1 text-left hover:..."                  // :265 菜单项 ≈24
  className={`mr-1 rounded-sm p-1 text-muted ... opacity-0 group-hover:opacity-100`}  // :250 ≈24
  ```
  且 `› / ‹ / ⋯` 都是字形而非 SVG。
- 建议：图标按钮统一 32×32（桌面密集场景最低 28 且保持一致的视觉盒），字形换 `icons.tsx` 的 `ChevronLeft/Right`、`MoreIcon`。

### B-S2-10 通知 / 首页 / 智能体表单的同类可点目标同样偏小
- 位置：`packages/web/src/components/NotificationCenter.tsx:151`、`:218`、`:239`、`:295`、`:304`；`HomePage.tsx:376`；`AgentFormPanel.tsx:296`
- 证据：
  ```tsx
  className={`flex h-[30px] w-[30px] items-center justify-center rounded-lg ...`}       // 铃铛 30
  className="rounded-sm px-1.5 py-0.5 text-[13px] leading-none text-muted ...">×</button> // ≈24
  className={`rounded-sm px-1.5 py-0.5 text-[11px] ...`}                                 // 筛选 chip ≈22
  className="rounded-sm px-1 py-0.5 text-[10px] text-muted ...">已读</button>             // ≈18
  className={`border-l border-line-soft px-2.5 py-1 text-[11px] font-semibold ...`}       // HomePage seg tab ≈26
  className="ui-btn ui-btn-sm ui-btn-ghost justify-start"                                // ui-btn-sm = h-7 = 28
  ```
- 建议：把 `.ui-btn-sm`（`index.css:514`）提升到 32px，或明确「sm 仅用于 28px 的密集工具栏但必须 ≥28 且成组出现」；筛选 chip 用 `py-1.5` 后约 30px 仍偏小，建议 32。

### B-S2-11 会话操作菜单被滚动容器裁切，且 `role="menu"` 无键盘语义
- 位置：`packages/web/src/components/assistant/ConversationRail.tsx:430`、`:256-282`
- 证据：
  ```tsx
  <div className="min-h-0 flex-1 overflow-y-auto p-1.5">      // :430 滚动容器
  ...
  <div role="menu" data-conv-menu
       className="absolute right-1 top-full z-30 mt-1 w-32 rounded-lg border border-line bg-[var(--surface)] p-1 text-[12px] shadow-card">
  ```
  菜单绝对定位在行内、父级是 `overflow-y-auto` → 靠近容器底部的会话打开菜单时，菜单被容器下边缘裁掉（`overflow-y` 同时裁 y 轴溢出），需要先滚动才能看到「重命名/删除」。另外：无 `↑↓`/`Home`/`End`/`Esc` 处理、打开时不把焦点移入菜单、无 `aria-activedescendant`，仅 `:136-144` 的 `pointerdown` 外部关闭。
- 建议：菜单 portal 到 `body`（`createPortal` + 计算定位，或用 `popover` API）；补 roving tabindex 与 Esc 关闭；若短期不 portal，至少在最后两条会话时向上翻转（`bottom-full`）。

### B-S2-12 `.ui-btn-danger` 暗色对比度约 1.7:1，全部破坏性按钮受牵连
- 位置：`packages/web/src/index.css:538-541`（令牌 `:144`）
- 证据：
  ```css
  .ui-btn-danger {
    @apply border-transparent text-white;
    background-color: var(--danger);
  }
  ```
  dark：`--danger: #ff8a80`（`:144`）→ 白字在浅红上约 **1.7:1**（亮色 `#b42318` 上约 6.6:1 合格，问题只在暗色）；暗色兼容层不覆盖 `.text-white` 工具类。受影响：`AgentFormPanel.tsx:508`、`NotificationCenter.tsx:335`、`ShortcutsHelp` 同级行为、`ToolApprovalModal.tsx:204`（`bg-[var(--danger)] text-white` 风险徽章）、`RecentConversations.tsx:92`（未读角标）。
- 建议：暗色下把 danger 按钮文字改为 `#101010`（与 `--heming-on-accent` 同思路），或改用 `color-mix(in srgb, #101010 80%, var(--danger))`；同时评估 `--danger` 是否该在暗色降到 `#ff9d95` 之类的中间值。

### B-S2-13 智能体表单仍是 `focus:border-[#bbb]`，暗色焦点对比 1.85:1
- 位置：`packages/web/src/components/assistant/AgentFormPanel.tsx:31-32`
- 证据：
  ```tsx
  const inputCls =
    "mt-1 block w-full rounded-lg border border-line px-3 py-2 text-sm outline-hidden focus:border-[#bbb]";
  ```
  `#bbb` 与暗色表面 `#16171a` 对比 ≈1.85:1，几乎不可见；兼容层无 `focus:border-[#bbb]` 映射。同类旧写法还有 `ContextSettingsCard.tsx:32`、`RouteGroupsCard.tsx:75`（非本轨，另记）。`index.css:2963` 的 changelog 声称已统一为 `focus:border-ink`，实际组件未改完。
- 建议：直接换 `.ui-input`（`index.css:490-497`，h-8 32px + `focus:border-ink`），删掉 `inputCls` 这份「第二实现」。

### B-S2-14 快捷键帮助仍在用硬编码 `#444` / `#f4f4f4`，暗色残留亮线
- 位置：`packages/web/src/components/ShortcutsHelp.tsx:57`、`:70`
- 证据：
  ```tsx
  <kbd className="... text-[#444] ...">      // :57
  <div className="divide-y divide-[#f4f4f4]"> // :70
  ```
  兼容层只按类名映射 `text-[#555/#666/#444]`→`--body`，但 `divide-[#f4f4f4]` 不在映射表（`index.css:782-1101`）→ 暗色下面板里出现 `#f4f4f4` 近白分隔线。
- 建议：`text-body` + `divide-line-soft`；同时把该文件的字面量清理纳入 d.138 的收尾清单。

### B-S2-15 图表卡错误态硬编码 Tailwind 红，暗色下是浅红白块
- 位置：`packages/web/src/components/ChatChart.tsx:63`
- 证据：
  ```tsx
  className="... border-red-200 bg-red-50 text-red-700"   // 错误态容器
  ```
  这是全仓唯一没有走 `--danger*` 令牌的红态；暗色 `--surface #16171a` 中出现 `#fef2f2` 底 + `#b91c1c` 字，既刺眼又与其它错误态不一致。
- 建议：`border-[var(--danger-line)] bg-[var(--danger-soft)] text-[var(--danger)]`（HomePage:552 已是正确做法）。

### B-S2-16 登录页没有可见 `<label>`，占位符当标签用
- 位置：`packages/web/src/components/LoginPage.tsx:74-102`
- 证据：
  ```tsx
  <input aria-label="用户名" ... placeholder="用户名" className={`ui-input ${FOCUS_RING}`} />
  <input aria-label="密码" type="password" ... placeholder="密码" className={`ui-input ${FOCUS_RING}`} />
  ```
  只有 `aria-label` + `placeholder`（:81 / :94），没有 `<label>`；输入后标签消失，用户无法回看字段名，密码管理器/自动填充的字段识别也更弱（版式取舍注释在 :69-73）。
- 建议：加可见 label（小号 `ui-caption` 在输入框上方），`placeholder` 只留示例值；或做浮动 label（在 focus/filled 时上移）。

### B-S2-17 文件预览的文本模式 `break-all` 破坏代码/缩进排版
- 位置：`packages/web/src/components/FilePreviewModal.tsx:173`
- 证据：
  ```tsx
  <pre className="... whitespace-pre-wrap break-all ...">
  ```
  `break-all` 会把长行从任意字符处折断，缩进和代码结构被破坏；这与 MarkdownMessage 的 `overflow-x-auto` 横滚策略（`:114`/`:118`）相反。
- 建议：`overflow-x-auto` + `whitespace-pre`（长行横向滚动，符合「代码块横滚不撑破布局」），并给 `max-w-full` 兜底。

### B-S2-18 遮罩有四套实现，暗色下 0.20 黑压不住背景
- 位置：`ConfirmDialog.tsx:48`、`CommandPalette.tsx:404`、`FilePreviewModal.tsx:194`、`AgentFormPanel.tsx:524`、`ChatPage.tsx:397`
- 证据：
  ```tsx
  className="... bg-[var(--scrim)]"                  // ConfirmDialog:48  light .20 / dark .55
  className="fixed inset-0 z-50 flex items-start justify-center bg-black/20 pt-[12vh]"  // CommandPalette:404
  className="fixed inset-0 ... bg-black/20"          // FilePreviewModal:194 / AgentFormPanel:524
  className="fixed inset-0 z-[60] ... bg-black/75"   // ChatPage:397 图片灯箱
  ```
  设计意图（`--scrim` 在暗色是 0.55）只在 ConfirmDialog 生效，其余三处固定 0.20 → 暗色下浮层背后的界面仍然很亮，层级关系弱；关闭手势也不一致（`onMouseDown` vs `onClick`）。`z-index` 同时散落 `z-30/z-40/z-50/z-[60]`。
- 建议：抽 `.ui-overlay`（`background: var(--scrim)`）+ `<Overlay onClick>` 统一关闭语义，z-index 建三层（drawer 30 / modal 50 / lightbox 60）。

### B-S2-19 智能体名册/选择器没有 loading 分支，加载中显示「还没有智能体」
- 位置：`packages/web/src/components/assistant/AgentPicker.tsx:101`、`AgentRosterView.tsx:114`
- 证据：
  ```tsx
  {agents.length === 0 ? (
    <EmptyState ... title="还没有智能体" ... />
  ```
  `AssistantPage` 异步 `loadAgentsRoster()`，请求未回时 `agents` 为 `[]` → 首屏先闪「还没有智能体」，与「加载中」语义混淆（HomeTeamUsage.tsx:85 的 `SkeletonLine` 已是可复用范式）。
- 建议：加 `loading` prop（store 里补 `agentsLoading`），空态只在「加载完成且确实为 0」时渲染——与 ChatPage `:3136`「历史没回来不能画成空会话」同一原则。

### B-S2-20 消息列表内嵌套三层滚动（思考区 / 工具参数 / 工具结果）
- 位置：`packages/web/src/components/AgentStreamBubble.tsx:124`、`:183`、`:190`
- 证据：
  ```tsx
  className="max-h-[180px] overflow-y-auto ..."   // :124 思考区
  className="max-h-[120px] overflow-auto ..."     // :183 工具参数
  className="max-h-[140px] overflow-auto ..."     // :190 工具结果
  ```
  三者都在 ChatPage 的消息列表滚动容器（`:3117`）内部 → 触控板/滚轮滚到内层时手势被截获，长对话里「继续往下读」会卡在工具块。对话应用标尺明确要求消息列表不能嵌套滚动。
- 建议：默认折叠为一行摘要 + 「展开」按钮（点击后进入独立弹层或 `details` 展开但 `overflow: visible` 由外层滚动承载）；确需限高时用 `overscroll-behavior: contain` 并保证外层仍可滚。

---

## S3 打磨（21 条）

### B-S3-01 消息区注释与实现漂移（px-8 / 头像列均已不存在）
- 位置：`packages/web/src/components/ChatPage.tsx:3108-3110`
- 证据：注释「消息区：px-8 给头像列留出外边距（头像不贴屏幕边）」，实际 `:3117` 是 `px-6 pb-5 pt-6`，且 `:3238` 注释与 d.126-C 说明已「不展示头像」。
- 建议：删掉过期注释，或改成解释「上下 py 差刻意留呼吸位」这一仍然有效的部分。

### B-S3-02 10px 元信息成为默认字号，关键上下文也用它
- 位置：`ChatPage.tsx:3233`、`:3305`；`AgentStreamBubble.tsx:54`、`:116`、`:150`、`:232`、`:238`；`NotificationCenter.tsx:172`、`:271`、`:285`；`HomePage.tsx:391`、`:395`、`:588`、`:598`；`CommandPalette.tsx:455`、`:490`、`:493`、`:534`
- 证据：时间分隔 `text-[10px]`、复制按钮 `text-[10px]`、工具名/候选链 10px、通知角标 `text-[9px]`、首页次要数字 10px、命令面板分组标题/详情/kbd 10px。
- 建议：建立字号阶梯（`12px` 正文下限、`11px` 仅用于 kbd/角标、`10px` 只允许出现在非信息性标签），把「工具名、模型候选、审批风险」这类需要读的清的单位提到 ≥12px。

### B-S3-03 图标系统双轨：SVG 图标集与字形字符混用
- 位置：`ConversationRail.tsx:254`(`⋯`)、`:325`(`›`)、`:377`(`‹`)；`NotificationCenter.tsx:220`/`:306`(`×`)；`ChatPage.tsx:3041`/`:3050`/`:3058`(`↑↓×`)；`AgentStreamBubble.tsx:116`/`:150`(`▾▸`)、`:245`(`✓`)；`AgentEditorView.tsx:39`(`‹ 返回名册`)
- 证据：上述位置直接以文本节点渲染字形，而 `icons.tsx` 提供同语义 SVG（CommandPalette `:566-590` 的 `kindIcon` 是正确范式：`<HomeIcon {...p} />` + `aria-hidden`）。
- 建议：全部换 SVG（尺寸 12-14px），装饰性 `aria-hidden="true"`，语义交给 `aria-label`；字形在不同字体/系统下宽度不一致，也是对齐抖动的来源。

### B-S3-04 同一 footer 内按钮尺寸三档混用
- 位置：`AssistantPage.tsx:391` vs `:398`；`AgentFormPanel.tsx:465`、`:478`、`:483`；`NotificationCenter.tsx:325`/`:335`
- 证据：
  ```tsx
  className="ui-btn ui-btn-md ui-btn-ghost ui-caption"   // 取消 md=32
  className="ui-btn ui-btn-sm ui-btn-danger"             // 删除 sm=28
  className="mr-auto rounded-lg border border-[var(--danger-line)] px-3 py-1.5 text-[13px] text-[var(--danger)]"  // 第三种手写
  ```
- 建议：弹窗 footer 统一 `ui-btn-md`；danger 一律 `.ui-btn-danger`（并修 B-S2-12）；删除 `ui-caption` 混进按钮的写法。

### B-S3-05 空状态是「居中标题 + 副标题 + 按钮」模板
- 位置：`packages/web/src/components/ui/EmptyState.tsx:44` + `index.css:606-617`
- 证据：
  ```css
  .ui-empty { display: flex; flex-direction: column; align-items: center; gap: .5rem; padding: 2.5rem 1.5rem; text-align: center; }
  ```
  图标块 32px + 居中标题 + 说明 + 按钮，正是审计标尺要避免的「空状态模板」；但 `home/NeedsAttention.tsx` 的空态（左对齐、与内容融合）是更好的方向。
- 建议：给 `EmptyState` 增加 `align="start"` 变体，聊天/列表面板内默认用左对齐内联式；居中版只保留给整页无内容场景。

### B-S3-06 代码块复制按钮 20px 热区、无 focus 提升
- 位置：`packages/web/src/components/MarkdownMessage.tsx:102-109`
- 证据：
  ```tsx
  className="rounded-sm px-1.5 py-0.5 text-[10px] ..."   // 复制代码
  ```
  与 ChatPage 的复制按钮同病（无 32px、无 `focus-visible` 类，依赖全局 outline）。
- 建议：抽 `<CopyButton size="sm">` 统一两处（见通用件清单）。

### B-S3-07 Markdown 图片无固有尺寸，加载时撑开布局（CLS）
- 位置：`packages/web/src/components/MarkdownMessage.tsx:145-152`
- 证据：
  ```tsx
  <button type="button" className="... cursor-zoom-in ...">
    <img src={...} alt={...} className="..." />   // 无 width/height
  </button>
  ```
- 建议：读取 markdown 图片的尺寸元数据或给 `width`/`height` + `aspect-ratio` + `max-h`；加载中显示同比例占位（`bg-[var(--subtle-3)]`）。

### B-S3-08 标题层级过平，内联代码借用危险色
- 位置：`packages/web/src/components/MarkdownMessage.tsx:229-231`、`:129`
- 证据：
  ```tsx
  h1/h2/h3 → 15px / 14px / 13px        // h3 与正文同为 13px，层级不可辨
  <code className="... text-[var(--danger)] ...">  // 内联代码 = 危险色
  ```
- 建议：18/16/14 阶梯（或按容器缩放），内联代码用 `bg-[var(--subtle-3)]` + 等宽 + `text-[var(--body)]`，把红色留给错误/删除语义。

### B-S3-09 图片灯箱有两套实现
- 位置：`MarkdownMessage.tsx:154-174` 与 `ChatPage.tsx:395-416`
- 证据：MarkdownMessage 的灯箱遮罩 `bg-black/75`、`autoFocus:false`、无可见关闭按钮；ChatPage 附件灯箱 `bg-black/75`、`onClick` 关闭、同样无关闭按钮。两处 Esc 均依赖 `useModalA11y`，但焦点/关闭入口/尺寸约束各写一遍。
- 建议：抽 `<ImageLightbox src alt onClose />`（含可见 `×`、`aria-modal`、缩放按钮位）。

### B-S3-10 Markdown 渲染有两套（MarkdownMessage vs 预览里的 MarkdownLite）
- 位置：`FilePreviewModal.tsx:48-99`（本地 `MarkdownLite`）与 `MarkdownMessage.tsx`
- 证据：MarkdownLite 只处理段落/粗体/行内代码，无表格/链接/引用，字号固定 13px；同一种 `.md` 文件在会话里与预览里长得不一样。
- 建议：预览复用 `MarkdownMessage`（如需安全差异，抽「允许的节点白名单」参数而不是第二份渲染器）。

### B-S3-11 图表卡按钮风格离群（rounded-md / bg-white / shadow-card）
- 位置：`packages/web/src/components/ChatChart.tsx:86`、`:94`
- 证据：
  ```tsx
  className="rounded-md border border-line bg-white px-2 py-0.5 text-[11px] shadow-card"
  ```
  按钮带卡片阴影、圆角比全站小一档、`bg-white` 靠兼容层映射。
- 建议：`ui-btn ui-btn-sm ui-btn-ghost`，去掉 `shadow-card`。

### B-S3-12 首页服务状态只是文字，异常时不变醒目
- 位置：`packages/web/src/components/HomePage.tsx:614-615`
- 证据：
  ```tsx
  <footer className="flex flex-wrap items-center gap-x-2 gap-y-1 px-1 ui-micro">
    <span>服务：{cloud}</span>
  ```
  「检测中/正常/失败」仅文字，无颜色/圆点/`role="status"`；注释说「异常时才变醒目」，代码里没有对应分支。
- 建议：状态点（success/warn/danger 令牌）+ 文字 + 异常时提升到 `text-[var(--danger)]`，并加 `role="status"`。

### B-S3-13 首页「查看」按钮视觉上像正文，靠 hover 下划线才可发现
- 位置：`packages/web/src/components/HomePage.tsx:457`
- 证据：
  ```tsx
  className="text-muted underline-offset-2 hover:underline"
  ```
  静态时与表格里的普通文字同色同重，用户不知道可点。
- 建议：常显下划线或 `ui-link`；或整行可点（配 `aria-expanded`）。

### B-S3-14 同类可点行在两套焦点样式间摇摆
- 位置：`HomePage.tsx:577` vs `home/NeedsAttention.tsx:128`、`home/RecentConversations.tsx:81`
- 证据：
  ```tsx
  className="flex w-full items-start gap-2.5 rounded-lg px-1.5 py-2 text-left transition-colors duration-150 hover:bg-[var(--subtle-2)]"  // 无 FOCUS_RING
  className={`flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-[var(--subtle)] ${FOCUS_RING}`}            // 有
  ```
  全局 `:focus-visible` outline 仍兜底，但同类行的焦点外形一处是 2px ring、一处是 outline，视觉语言不统一。
- 建议：定一条规则（「列表行一律 FOCUS_RING_TIGHT，容器内按钮用全局 outline」），或干脆全部依赖全局 outline 并删掉局部 FOCUS_RING。

### B-S3-15 同页两种错误色（danger vs muted）
- 位置：`home/HomeTeamUsage.tsx:96` 与 `HomePage.tsx:552`
- 证据：HomePage 用 `text-[var(--danger)]`，HomeTeamUsage 的错误文案用 `text-muted` → 同一屏内错误信号强度不同。
- 建议：错误一律 `--danger` + `role="alert"`，`muted` 只用于说明文字。

### B-S3-16 设置卡内再套卡片，且下拉只有 24px 高
- 位置：`packages/web/src/components/FileEditCard.tsx:95`、`:133`
- 证据：
  ```tsx
  className="mt-3 rounded-xl border border-line bg-[var(--surface)] p-4 shadow-card"   // 卡片套卡片
  className="px-2 py-0.5 text-[11px] outline-hidden focus:border-ink"                  // select ≈24px
  ```
- 建议：内层改 `border-t pt-3` 分组；select 换 `ui-input`（32px）。

### B-S3-17 工具确认弹窗把关键信息压到 10px
- 位置：`packages/web/src/components/ToolApprovalModal.tsx:168`、`:202-208`、`:212`、`:355`、`:368`
- 证据：跨会话按钮 `px-2 py-0.5 text-[10px]`、风险徽章 `text-[10px]`、工具名 `text-[10px]`、diff 预览提示与 summary 均 10px——这是用户做「批准/拒绝」决策的上下文。
- 建议：工具名 12px 等宽、风险徽章 11-12px、diff 区 12px；层级用底色/间距而不是继续缩小字号。

### B-S3-18 附件预览细节：加载无占位、图片无尺寸、大小恒为 KB、重试 20px
- 位置：`packages/web/src/components/ChatPage.tsx:384`、`:393`、`:427`、`:377`
- 证据：
  ```tsx
  if (!url) return null;                                            // :384 加载期什么都不画
  <img src={url} alt={file.name} className="max-h-40 rounded-md object-cover" />  // :393 无尺寸
  {(file.size / 1024).toFixed(1)} KB                                 // :427 3.4MB → 3481.6 KB
  className={`shrink-0 rounded-sm border border-line px-1.5 py-0.5 text-[11px] ...`}  // :377 重试 ≈20px
  ```
- 建议：加载期同尺寸骨架；`<img>` 加 `width/height`；大小格式化为 B/KB/MB；重试按钮 `p-2`。

### B-S3-19 音频消息直接用原生 `<audio controls>`，与全站视觉脱节
- 位置：`packages/web/src/components/ChatPage.tsx:479-485`
- 证据：
  ```tsx
  <audio controls src={url} aria-label="语音消息" className="mt-1 w-full max-w-[260px]" data-testid="audio-bubble" />
  ```
  原生控件在 Chromium/WebKit/Firefox 外观不同，暗色下也是浅色 chrome。
- 建议：自定义播放条（播放/暂停 + 进度 + 时长），或至少 `color-scheme: dark` 兜底并统一宽度。

### B-S3-20 智能体删除确认里出现未渲染的 markdown 星号
- 位置：`packages/web/src/components/AssistantPage.tsx:406`
- 证据：`<p>` 文本里直接写 `**不可恢复**`，React 不会解析 markdown → 屏幕上是四个星号。
- 建议：改 `<strong className="font-bold">不可恢复</strong>`（NotificationCenter:343 已是正确写法）。

### B-S3-21 命令面板结果数变化无播报，阴影硬编码
- 位置：`packages/web/src/components/CommandPalette.tsx:416`、`:516-523`
- 证据：
  ```tsx
  className="... shadow-[0_12px_40px_rgba(0,0,0,0.18)] ..."   // 硬编码阴影，暗色不加深
  ```
  过滤结果从 30 条变 2 条时，读屏用户听不到数量变化（只有「无结果」分支是文本）。
- 建议：`ui-overlay-shadow` 令牌；结果区加 `role="status" aria-live="polite"` 播报「N 条结果」。

---

## 跨组件共性问题（8 条）

1. **令牌双轨制导致暗色系统性漏网**：组件写 Tailwind 字面量，靠 `index.css:782-1101` 的**类名映射**在暗色生效。映射表未覆盖的写法（`divide-[#f4f4f4]`、`accent-[#1a1a1a]`、`focus:border-[#bbb]`、`border-white`、`bg-[var(--danger)] + text-white`）逐处在暗色失效，且新代码无法从类名判断「是否安全」。→ 建议 CI 加一条「暗色类名白名单」检查（禁 `#hex`、禁裸 `text-white`、禁 `bg-white`）。
2. **尺寸体系缺席**：可点目标 18/20/22/24/28/30/32px 混用，`.ui-btn-sm`=28px 是主要来源；字号 9/10/11/12/13/15 六档并存，无阶梯。→ 先定 token（`--tap-min: 32px`、`--text-micro: 11px`），再逐组件替换。
3. **图标双轨**：`icons.tsx` 的 SVG 集与字形字符（`› ‹ ⋯ × ↑ ↓ ▾ ▸ ✓`）并行；字形宽度随字体变化，是行内对齐抖动的来源之一。
4. **浮层四套**：`ConfirmDialog` 的骨架 vs `CommandPalette` 的自绘 vs `FilePreviewModal`/`AgentFormPanel` 的 `bg-black/20` vs 两处灯箱的 `bg-black/75`；遮罩色、关闭手势、圆角、边框 token 全不一致。
5. **三态覆盖不均**：ChatPage 三态齐全（骨架/错误/空），AgentPicker/Roster 缺 loading，FilePreviewModal loading 仅一行灰字，HomeTeamUsage 三态齐但错误色不一致。
6. **焦点策略双轨**：`GlobalFocusRing`（全局 `:focus-visible` outline）+ 局部 `FOCUS_RING`（ring 工具类）并存，同一屏内同类元素焦点外形不同；`overflow-hidden` 容器还会把 outline 裁成一条线（CommandPalette:411-416 注释已自证）。
7. **魔法断点遍地**：`1199px`（HomePage ×3、AgentPicker:57、AgentRosterView:64、AgentEditorView:33）、`900px`（LoginPage:58）、固定容器 960/880/380/360/320/264/60——没有 375/768/1024/1440 体系，聊天壳干脆 0 断点。
8. **「小字 + 密集信息」成为默认**：10px 被用于工具名、审批风险、通知时间、首页次要指标等需要读取的内容；可读性问题不是单点，而是全局排版策略。

## 建议抽成通用件的清单

| 通用件 | 现状（重复实现） | 收编位置 |
| --- | --- | --- |
| `<ImageLightbox>` | `MarkdownMessage.tsx:154-174`、`ChatPage.tsx:395-416` | 新增 `components/ui/ImageLightbox.tsx`，含可见关闭、`aria-modal`、`--scrim` |
| `<MarkdownBody>`（单一渲染器） | `MarkdownMessage.tsx` 与 `FilePreviewModal.tsx:48-99` 的 `MarkdownLite` | `components/MarkdownMessage.tsx` 增 `variant/nodes` 参数，删 MarkdownLite |
| `.ui-overlay` + `<Overlay>` | ConfirmDialog:48、CommandPalette:404、FilePreviewModal:194、AgentFormPanel:524、ChatPage:397 | `index.css` 加 `.ui-overlay`；z-index 三层常量 |
| `<Dialog>`（统一弹窗壳） | `ConfirmDialog.tsx:60` 骨架 + 4 处手写（含 380px 无 max-w） | 以 ConfirmDialog 为准抽 `components/ui/Dialog.tsx`，内置 `useModalA11y` |
| `<IconButton size="sm|md">` | ChatPage 头部 3 个、composer 工具栏 3 个、rail 5 个、通知 4 个、文件卡重试 | `components/ui/IconButton.tsx`（强制 32px、强制 `aria-label`、SVG only） |
| `.ui-checkbox` / `<Checkbox>` | ChatPage:3260 硬编码 accent、ToolApprovalModal:288 原生、AgentFormPanel 原生 | `index.css` 加 `.ui-checkbox`（`accent-[var(--ink)]`） |
| `<ComposerResizer>` | `ChatPage.tsx:3478-3489` + 逻辑 `:2258-2279` | `components/chat/ComposerResizer.tsx`（键盘 + aria-valuenow + localStorage） |
| `<CopyButton>` | `ChatPage.tsx:3302-3309`（消息）、`MarkdownMessage.tsx:102-109`（代码块） | `components/ui/CopyButton.tsx`（点击后 `aria-live` 播报「已复制」） |
| `<EmptyState align="start">` | `EmptyState.tsx:44` 居中模板被所有场景复用 | 增 `align` 变体；聊天/列表内默认左对齐 |
| `<StatusDot>` | `AgentStreamBubble.tsx:257-273` 6px pulse、HomePage 服务状态纯文字、NeedsAttention:117 内联 style | `components/ui/StatusDot.tsx`（color/tone + reduced-motion + label） |
| 字号/间距 token | 9-15px 六档、hero/卡片内边距随意 | `index.css`：`--text-micro/caption/body/title`，组件禁写 `text-[Npx]` |
| `<Loading>` 三态容器 | AgentPicker/Roster 缺 loading、FilePreviewModal 只有文字、ChatPage 自绘骨架 | 复用 `.ui-skeleton` + `role="status" aria-busy`，统一「三态」组件 |

## 值得保留的实现（正向证据）

- **单一滚动容器 + 880 居中列**：`ChatPage.tsx:3111-3120`，滚动只发生在外层 `overflow-y-auto`，内层只做宽度约束（本次审计里唯一的「标准对话滚动结构」）。
- **滚动不拽底**：`:1264-1362` 有贴底判定、追加历史时 `scrollTop` 补偿（`:1362`），`:3333` 用户上滑时只显示「↓ 新消息」入口而不抢滚动位置。
- **IME 与 Enter 语义正确**：`:2317-2323` `e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing`。
- **Esc 停止生成**：`:2301-2315` 文档级、带浮层/草稿门禁，避免误触。
- **附件 objectURL 生命周期**：`:341`/`:359`、`:452`/`:471` 晚到即 `revoke`，无泄漏。
- **命令面板键盘契约完整**：`:360-392` 面板级 ↑↓/Home/End/Enter/Esc + `:431` `aria-activedescendant` + `:471` `tabIndex={-1}` + `:566-590` SVG 图标 `aria-hidden`。
- **弹窗焦点基础设施**：`useModalA11y.ts:132-230` 焦点陷阱、背景 inert 引用计数、最内层 Esc、焦点归还；`GlobalFocusRing.tsx:20-31` 全局 `:focus-visible` + forced-colors。
- **实时播报**：`AgentStreamBubble.tsx:50-52`、`NotificationCenter.tsx:182-184`（未读数变化才播报）、LoginPage 的 caps lock 活区。
- **聊天页三态齐全**：`:3134-3170` 骨架/错误/真空三分支互斥，且注释解释了「加载中不能画成空会话」。
- **代码块与表格横滚**：`MarkdownMessage.tsx:114`/`:118`/`:239-243` `overflow-x-auto`，不撑破 880 列。

## 未验证项（需要运行时/真机）

1. B-S2-04 的 `h-full` 居中失效：CSS 百分比高度在 auto 父级不解析，判定为高置信，但需浏览器确认最终视觉。
2. B-S1-03 通知面板的越界像素：68 + 320 = 388 > 375 为静态推算，未在 375 模拟器确认。
3. `ChatChart` 的 `style={{ background: rendered.background }}`（`:73`）在暗色下是否为白色块——取决于图表 spec 的默认背景，未读取渲染器。
4. MarkdownMessage 灯箱 `autoFocus:false`（`:154-174`）时 Tab 是否仍被陷阱限制在面板内（`useModalA11y` 会处理，但初始焦点留在触发按钮上，读屏语义需实测）。
5. ConversationRail 菜单被裁切的具体触发条件（取决于滚动位置与容器高度），静态可判定 overflow 裁切存在。
6. 375px 下 `ChatPage` 头部标题与 3 个图标按钮是否换行/溢出、composer 5 控件是否挤压 textarea——未渲染确认。
7. 全站未跑 axe/Lighthouse：对比度为手算（WCAG 相对亮度公式），未做像素取样。
8. 少量次要文件（`BootWave.tsx`、`UpdateCard.tsx`、`UpdateMotion.tsx`）只做了 reduced-motion 抽查（`BootWave.tsx:249`、`UpdateMotion.tsx:96` 均有 `prefers-reduced-motion` 处理），未逐条审计。

---

*本报告为静态源码审计，所有引用均为仓库原文（`packages/web/src/...`），行号对应当前工作副本。*