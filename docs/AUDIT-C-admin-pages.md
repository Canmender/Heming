# 和鸣 Web · 管理页 UI/UX 静态审计（C 组：Settings / Plugins / Model / Skills / Team / Knowledge / Memory）

- **审计对象**：`D:\Heming\packages\web`（React 18 + TypeScript + Vite + Tailwind v4）
- **范围**：管理类页面及其组件——`SettingsPage`、`components/settings/*`、`HitlPolicyCard`、`RouteGroupsCard`、`PluginsPage`、`components/plugins/*`、`ModelPage`、`components/model/*`、`ModelUsageView`、`ModelTraceView`、`SkillsPage`、`components/skills/SkillHubPanel`、`TeamPage`、`components/team/*`、`TeamBoardPage`、`components/collaboration/*`、`KnowledgePage` 与 `components/knowledge/*`、`MemoryPage`、以及 `InterfacesPage` / `RegistryPage` / `WikiPanel` / `FileTree` / `Avatar` / `TokenHeatmap` / `EmojiPicker` 等零散件
- **方法**：**纯静态源码审计**（逐文件读源码 + 跨仓 grep 普查）。本机 Bash 执行通道不可用（`EXECUTOR_UNAVAILABLE`），且无外网，因此**没有跑 dev server、没有截图、没有运行时验证**。凡无法从代码确证的，条目内标「未验证」。
- **未覆盖**：`ChatPage`（已有独立审计）、`assistant/*` 主流程、移动端手势、真实暗色渲染观感、实际对比度测量（仅按 token 值手算）。
- **分级**：`S1` = 发布前必须修（数据/信任/可理解性硬伤）；`S2` = 明显缺陷（同类东西长得不一样、状态缺失、可达性不达标）；`S3` = 打磨项（数值/文案/细节漂移）。
- **总量**：**48 条** —— S1 × 4、S2 × 28、S3 × 16。

---

## 0. 一句话结论

**页面外壳（`PageShell`）已经统一，设计令牌也已经齐备，但「壳内」没有统一**：`components/ui/` 里的 8 个基元（Button / EmptyState / ErrorState / Field / Switch / Stat / Skeleton + `model/SectionCard`）大多**建好了却几乎没被采用**，于是同一语义的卡片、按钮、空态、失败态、加载态、对话框、表格、页签在每个管理页里各写一遍——这正是「缝合怪」观感的来源，而不是配色或字体的问题。

同时，暗色主题不是靠 token 生效，而是靠 `index.css` 里 **116 条按类名兜底的覆盖规则**；一旦页面写了一个白名单外的颜色/调色板类，暗色就会破相。

---

## 1. 采用率普查（本次审计的核心证据）

| 基元 | 定义处 | 生产代码采用 | 同类手写实现 |
|---|---|---|---|
| `Button` | `components/ui/Button.tsx` | **3 个文件**（HomePage:23、ModelPage:15、ToolApprovalModal:12） | **265 处** `"ui-btn ui-btn-…"` 字符串，分布在 **51 个**非测试文件 |
| `EmptyState` | `components/ui/EmptyState.tsx` | **4 个文件**（HomePage:25、HomeTeamUsage:9、MemoryPage:59、TeamBoardPage:5） | 19 处 `.ui-empty*` 类（5 个文件）+ 6 处完全手写 div |
| `ErrorState` | `components/ui/ErrorState.tsx` | **0 个文件** | 全站「加载失败」十几种写法（见 S2-03） |
| `Skeleton` | `components/ui/Skeleton.tsx` | **3 个文件**（HomePage:26、HomeTeamUsage:10、TeamBoardPage:6） | `animate-pulse` 手写块（ModelPage:437 等） |
| `Stat` | `components/ui/Stat.tsx` | **2 个文件**（HomePage:27、ModelPage:16） | 各页自绘指标卡 |
| `Switch` | `components/ui/Switch.tsx` | **3 个文件**（ContextSettingsCard:9、MemoryPage:60、SkillsPage:19） | **2 份新拷贝**（plugins/shared.tsx:38-69、WidgetSettingsCard:345-356） |
| `TextField` | `components/ui/Field.tsx` | **1 个文件 / 1 个字段**（SettingsPage:502 昵称） | 管理页表单 20+ 个裸 `<input aria-label>` + placeholder |
| `SectionCard` | `components/model/SectionCard.tsx` | **1 个文件**（model/BackupPanel.tsx:4） | 设置页 6 张卡片各写壳 |
| `FOCUS_RING` | `lib/a11y/focus.ts:20` | 16 个文件手贴 | `.ui-btn` / `.ui-chip` / `.ui-segment` / `.ui-disclosure` 均无 |

`Button` 的 265 处手拼分布（前几）：ModelPage 37、KnowledgePage 18、TeamPage 16、MemoryPage 15、TeamWorkspace 12、InterfacesPage 12、SkillsPage 9、SettingsPage 8、CollabView 7、AgentRosterView 7、RouteGroupsCard 6、HitlPolicyCard 6、RegistryPage 6、StorageUsageCard 5、BackupPanel 5。

> 这不是「没有设计系统」，而是**设计系统存在、却绕过了它**。所以修复成本主要在「替换调用」而不是「重新设计」。

---

## 2. S1 — 发布前必须修（4 条）

### S1-01 删除「候选链」无二次确认、无撤销

- `[S1]` `packages/web/src/components/RouteGroupsCard.tsx:245-255` — 「删除」按钮点击即执行 `removeRoute`，**没有任何确认**，也不可撤销；该文件的 import（1-14 行）里**没有 `ConfirmDialog`**。
- 证据：

```tsx
<button
  type="button"
  aria-label={`删除 ${g.label}`}
  onClick={() => {
    removeRoute(g.id);
    if (editingId === g.id) resetForm();
  }}
  className={btnGhost}
>
  删除
</button>
```

- 对照：`ConfirmDialog` 已被 **24 个文件**正确使用（`SettingsPage.tsx:18`、`SkillsPage.tsx:5`、`TeamPage.tsx:35`、`HitlPolicyCard.tsx:5`、`MemoryPage.tsx:57`、`knowledge/FileTree.tsx:4`…），`RouteGroupsCard` 是明显的例外；「编辑」与「删除」还共用同一个 `btnGhost`（242-252），视觉等级完全相同。
- 建议：改用 `ConfirmDialog`（标题「删除候选链 <label>？」+ 影响说明「N 个智能体将回落到默认连接」），确认按钮用 `.ui-btn-danger`；删除按钮与编辑按钮之间加分隔或把删除收进「⋯」次级菜单。

### S1-02 模型页「删除分组 / 删除密钥」直接命中服务端

- `[S1]` `packages/web/src/components/ModelPage.tsx:1237-1244` — 危险按钮与「详情」同排同尺寸，点击即 `group rm`：

```tsx
<button
  type="button"
  className="ui-btn ui-btn-sm ui-btn-danger"
  disabled={!cli || !groupForm.target.trim()}
  onClick={() => void run("删除分组", ["group", "rm", groupForm.target.trim()])}
>
  删除
</button>
```

- `[S1]` `packages/web/src/components/ModelPage.tsx:1483-1490` — 同类问题，密钥删除直接执行：

```tsx
className="ui-btn ui-btn-sm ui-btn-danger"
onClick={() => void run("删除密钥", ["gateway-key", "remove", gatewayKeyForm.target.trim()])}
```

- `ModelPage.tsx` 的 import（1-30 行）中也**没有 `ConfirmDialog`**。
- 后果：删除目标由一个自由文本输入框（`分组 ID` / `密钥 ID`）决定，打错一个字就删错对象，且无确认、无撤销、无「已删除什么」的回执标题以外的痕迹。
- 建议：这两处改为「选中列表项 → 行内危险动作 → ConfirmDialog」，并复用 S1-01 的确认组件；`group rm` / `gateway-key remove` 的结果回执里带上被删对象名。

### S1-03 「运行」Tab 把 CLI 原语直接当界面：6 个英文枚举 + 手敲参数语法

- `[S1]` `packages/web/src/components/ModelPage.tsx:1332-1345` — 两个下拉直接渲染命令枚举，用户看到的是 `webdav` / `s3` / `github`、`now` / `on` / `off` / `set`：

```tsx
<select aria-label="同步类型" className="ui-input" value={syncKind} onChange={…}>
  {["webdav", "s3", "github"].map((kind) => (
    <option key={kind} value={kind}>{kind}</option>
  ))}
</select>
<select aria-label="同步动作" className="ui-input" value={syncCommand} onChange={…}>
  {["now", "on", "off", "set"].map((command) => (
    <option key={command} value={command}>{command}</option>
  ))}
</select>
```

- 同页还有：`placeholder="set 的参数：key=value key2=value2"`（1349）、`placeholder="provider/model,provider/model2"`（1188）、`placeholder="够长才用：如 150k（可留空）"`（1267）、`placeholder="时段（如 14:00-18:00，可留空）"`（1281）、「高级命令」`placeholder="providers"`（1526），以及一个真正的终端（1553-1568）：

```tsx
<pre aria-label="命令输出" className="mt-2 h-56 overflow-auto rounded-xl bg-[var(--console-bg)] p-3 text-[12px] text-[var(--console-ink)]">
  {live || "（输出会出现在这里）"}
</pre>
<input aria-label="命令输入" className="ui-input mt-2 w-full font-mono text-[12px]" placeholder="回车把这一行发给正在运行的命令" … />
```

- 问题不是「露出终端」本身（高级用户需要），而是**把它和日常设置平权铺开**：7 个 `<details>` 同权平铺（1174 路由分组、1329 多机同步、1370 资源库与网页搜索、~1436 网关密钥、1494 会话与启动器、1520 高级命令），用户无法判断哪些是常用、哪些是危险。
- 建议：把 CLI 原语整体收进「高级 / 维护」页签（或「诊断」折叠区）并加一句「以下为模型服务命令，改动会影响所有会话」；日常操作只保留中文语义动作（「立即同步」「查看最近会话」等）和中文枚举标签（映射表 `{ now: "立即", on: "开启自动同步", … }`）。

### S1-04 管理表单没有可见标签、没有必填标记、没有错误关联

- `[S1]` `packages/web/src/components/ModelPage.tsx:1178-1191` — 典型形态：只有 placeholder + `aria-label`，输入后标签消失：

```tsx
<input
  aria-label="分组名称"
  className="ui-input"
  placeholder="分组名"
  value={groupForm.name}
  onChange={(event) => setGroupForm({ ...groupForm, name: event.target.value })}
/>
```

- 同类字段在 `ModelPage` 运行页有 20+ 个（1178-1284、1346-1352、1384-1405、1466-1474、1523-1532、1556-1568），全部**无可见 label、无必填标记、无字符/格式提示位、无错误位**。
- 全仓可达性事实（grep）：`aria-invalid` 仅出现在 `LoginPage.tsx:78/89`、`assistant/AgentFormPanel.tsx:328`、`ui/Field.tsx:43`；`required` 仅出现在 `LoginPage.tsx:84/101`；管理页 **0 处**。`ui/Field.tsx` 的 `TextField` 因此只被用了 1 次（`SettingsPage.tsx:502` 昵称）。
- `ui/Field.tsx:8` 的文件注释本身承认：「而且绝大多数**没有**把错误行和输入框连起来（`aria-describedby` / `aria-invalid`）」。
- 建议：把这些字段切换成 `TextField`（`label` / `hint` / `error` 三件套已实现，含 `useId` + `aria-describedby`）；表单改为 `<form>` + 提交时逐字段校验，错误就地显示并聚焦第一个错误字段。

---

## 3. S2 — 明显缺陷（28 条）

### S2-01 空态有三套系统，且都在同时使用

- `[S2]` `.ui-empty` 类（`index.css:606-615`）被 5 个文件使用 19 次：`RegistryPage.tsx`（4）、`SkillsPage.tsx`（4）、`AssistantPage` 侧栏 `ConversationRail.tsx`（6）、`CollabView.tsx`（4）、`TeamPage.tsx`（1）。
- `[S2]` `<EmptyState>` 组件被 4 个文件使用。
- `[S2]` 第三套是**完全手写的 div**，且类串在 4 个文件里逐字重复：

```tsx
// PluginsPage.tsx:707、UnitListView.tsx:403、PluginBundlePage.tsx:202 与 :234
<div className="mt-3 flex flex-col items-center gap-2 rounded-xl border border-line-soft bg-[var(--surface)] py-10 text-center shadow-card">
```

- 第四种（卡片内）：`ModelTraceView.tsx:231` `flex min-h-[240px] flex-col items-center justify-center gap-2 text-center`。
- 关键点：`EmptyState` 与 `.ui-empty` **是同一套视觉**（`EmptyState.tsx:7` 明写「视觉走 `index.css` 的 `.ui-empty*` 基元」），所以替换是零视觉风险的纯机械工作。
- 建议：`EmptyState` 唯一化，`compact` 覆盖卡片内场景；删除 `index.css` 里给页面直接调用的 `.ui-empty-*` 用法（保留类给 `EmptyState`/`ErrorState` 内部）。

### S2-02 失败态有十几种写法，`ErrorState` 零采用

- `[S2]` `components/ui/ErrorState.tsx:7-8` 自述：「全站 `加载失败` 的呈现有十几种——一行红字、居中一段灰字、带不带重试、重试按钮尺寸各不相同」；`:18-19` 还写明「现有 28 处断言把文案写成了『加载失败：{原因}』的整串」，说明**接线的技术债已被记录但没做**。
- 五种并存的形态：
  - 裸段落、无重试：`TeamPage.tsx:679` `<p role="alert" className="text-[var(--danger)]">名册加载失败：{rosterError}</p>`；同款 `:877`、`:967`、`:1120`、`TeamBoardPage.tsx:240`、`HomeTeamUsage.tsx:97`。
  - 页头统计里塞一句被 `truncate` 截断的错误：`HomePage.tsx:552` `<span role="alert" className="min-w-0 truncate text-[var(--danger)]">加载失败：{teamError}</span>`。
  - 居中块 + 自绘 11px 重试按钮：`TeamBoardPage.tsx:239-247`（`rounded-sm border border-line px-2 py-0.5 text-[11px]`）。
  - 弹窗内一行红字：`FilePreviewModal.tsx:157`。
  - 11px 行内红字：`ChatPage.tsx:477`。
- 建议：`ErrorState` 设为唯一失败态；先批量把「裸 `<p role="alert">` 无重试」的 6-8 处换掉（这几处没有测试断言负担），再按 `ErrorState` 注释里的「28 处断言」清单分批迁移。

### S2-03 加载态四种

- `[S2]` ① `SkeletonCard`：`TeamBoardPage.tsx:233-237`（正确）。
- `[S2]` ② 手写脉冲块：`ModelPage.tsx:437` `<div key={index} className="h-14 animate-pulse rounded-2xl bg-[var(--subtle-3)]" />`（且半径 `rounded-2xl` ≠ `.ui-card` 的 `rounded-xl`）。
- `[S2]` ③ 纯文字：`TeamPage.tsx:964` `<p role="status" className="mt-3 ui-caption">加载中…</p>`、`:1117`、`FilePreviewModal.tsx:153`、`SkillsPage.tsx:1130`（`（名册加载中…）` 塞进 `<option>`）。
- `[S2]` ④ 静态 `aria-busy` 容器：`TeamPage.tsx:672` `<div role="status" aria-busy="true" aria-label="正在加载团队成员" className="space-y-1.5 p-1.5">`、`:870`。
- 建议：`Skeleton`（`SkeletonLine/Block/Card`）唯一化；只有「多行列表」允许用「加载中…」文本，且必须 `role="status"`。

### S2-04 同一张卡片，至少 4 种壳

- `[S2]` `ContextSettingsCard.tsx:69`、`KeyStorageCard.tsx:112`、`RouteGroupsCard.tsx:205` 三处逐字相同：

```tsx
<section className="mt-3 rounded-xl border border-line bg-white p-4 shadow-card">
```

- `[S2]` `settings/ThemeModeCard.tsx:56-61` 是另一种（`bg-surface` + 15px 标题）：

```tsx
<section aria-label="主题模式" className="max-w-full rounded-xl border border-line bg-surface p-4 shadow-card">
  <div className="flex items-center gap-2">
    <span className="ui-section-title">主题模式</span>
```

- `[S2]` `HitlPolicyCard.tsx:109` 与 `StorageUsageCard.tsx:486` 又是 `bg-[var(--surface)]` 变体；只有 `SettingsPage.tsx:655` 的 `NavModeSection` 用了 `.ui-card`：

```tsx
<section aria-label="工具调用确认" className="mt-3 rounded-xl border border-line bg-[var(--surface)] p-4 shadow-card">
```

- `[S2]` 三个副作用：①`.ui-card` 的 `--surface` / `shadow` / 暗色覆盖被绕过（`bg-white` 靠 `index.css` 兼容层 864 行附近才能变暗）；②卡片自带 `mt-3`，与父级 `flex flex-col gap-*` 的间距叠加成 12+12；③卡片组件散落：设置页 9 张卡里只有 2 张在 `components/settings/`，其余 7 张散在 `components/` 根目录（`RouteGroupsCard`/`HitlPolicyCard`/`KeyStorageCard`/`ContextSettingsCard`/`FileEditCard`/`StorageUsageCard` + `NavModeSection`）。
- 建议：`SectionCard` 从 `model/` 提到 `ui/`，成为唯一卡片壳（`ui-card` + 标题 + 说明 + action）；同时把设置卡片归拢到 `components/settings/`。

### S2-05 卡中卡（三层嵌套）

- `[S2]` `RouteGroupsCard.tsx:205`（壳）→ `:232`（每条候选链 `mt-3 rounded-lg border border-line p-3`）→ `:292`（休息名单 `mt-3 rounded-lg border border-line bg-[#fcfcfc] p-3`）三层同级边框卡片叠在一起。
- `[S2]` `ModelPage.tsx:699` 的 `ui-card p-4` 里又塞了 6 个 `ui-card ui-card-interactive`（`:713`）：

```tsx
<div className="ui-card p-4">
  …
  <div className="mt-3 grid gap-2 sm:grid-cols-3 lg:grid-cols-6">
    {MAGPIE_PRESETS.map((preset) => (
      <button className={`ui-card ui-card-interactive px-3 py-2.5 text-left disabled:opacity-50 …`}>
```

- 后果：卡片阴影/lift 动效叠加，6 个小卡悬浮在一张大卡上，视觉噪声明显高于信息量。
- 建议：嵌套层用「无边框 + `--subtle-2` 底」，只有最外层用 `.ui-card`；`ModelPage` 的预设选择器改用 `.ui-segment-group` 或「无卡片的分段列表」。

### S2-06 卡片标题三套字号

- `[S2]` ① `text-[13px] font-bold`：`ModelPage.tsx:456`、`:701`、`ModelUsageView.tsx:198/251/294`、`model/SectionCard.tsx:34`。
- `[S2]` ② `.ui-section-title`（15px semibold）：`settings/ThemeModeCard.tsx:61`、`TeamBoardPage.tsx:252/279`。
- `[S2]` ③ `text-[12px] font-bold text-muted`：`ContextSettingsCard.tsx:70`、`HitlPolicyCard.tsx:110`、`RouteGroupsCard.tsx:208/294`、`SkillsPage.tsx:1004`。
- 最刺眼的是**同一页并存**：设置页里 `ThemeModeCard` 用 15px ink 标题，紧邻的 `ContextSettingsCard` 用 12px muted 标题。
- 建议：卡片标题统一 `.ui-section-title`（或统一 13px bold），muted 小标题只用于「卡片内分组」。

### S2-07 对话框壳：4 种宽度、2 种圆角、有无边框不一致

- `[S2]` `plugins/InstallDialog.tsx:264` 与 `plugins/PluginDetailDialog.tsx:104`：

```tsx
className="plugin-dialog-pop flex max-h-[88vh] w-[min(660px,94vw)] flex-col overflow-hidden rounded-2xl border border-line bg-[var(--surface)] shadow-xl"
```

- `[S2]` `plugins/PluginRepositoryDialog.tsx:117`：`rounded-2xl … max-h-[86vh] … max-w-[860px]`。
- `[S2]` `skills/SkillHubPanel.tsx:359`：`w-[min(720px,94vw)] … rounded-xl bg-[var(--surface)] shadow-xl` — **没有 `border`**，与前两个视觉不同；同文件 `:611` 又是 `rounded-xl border border-line … w-[min(620px,94vw)]`。
- `[S2]` `components/ui/` 里**没有 Dialog/Modal 基元**（只有 8 个：Button/EmptyState/ErrorState/Field/Skeleton/Stat/Switch），所以 11 个对话框组件各自拼遮罩 + 壳；遮罩也各自写（见 S2-22）。
- 建议：抽 `ui/Dialog`（尺寸档 sm/md/lg = 520/660/860，统一 `rounded-xl` + `shadow-card` 或单一 `shadow` 令牌，统一遮罩 `var(--scrim)`，内置 `useModalA11y`），现有 11 个对话框改为薄壳。

### S2-08 表格两套：`.ui-table` 只有 3 处，手写 `<table>` 6 处

- `[S2]` 用基元：`InterfacesPage.tsx:702`（`ui-table min-w-[560px]`）、`SkillsPage.tsx:1016`（`ui-table min-w-[760px]`）、`MemoryPage.tsx:2266`。
- `[S2]` 手写：`ModelUsageView.tsx:297` `<table className="mt-2 w-full text-left text-[12px]">`（无 `.ui-table` 的行高/边框/悬停规则），`HomePage.tsx:440` `text-[11px]`，`PluginDeclarativePage.tsx:267`、`MarkdownMessage.tsx:241`、`knowledge/BacklinkPane.tsx:253`、`knowledge/PreviewPane.tsx:351`（后三个是 markdown 渲染，可豁免）。
- `[S2]` 另外 `ModelUsageView.tsx:292` 把横向滚动加在**卡片本体**上：

```tsx
<div className="overflow-x-auto ui-card p-4">
```

  结果：横向拖动时标题「最近请求」跟着一起滚走，且圆角内的 padding 也参与滚动。
- `[S2]` 长文本：`ModelUsageView.tsx:315` `<td className="py-1.5 pr-3 font-mono text-[11px]">{row.req || row.model}</td>` 无 `truncate` / 无 `max-w`，模型名最长的一行决定整表宽度；`SkillsPage.tsx:1032` 有 `truncate`，`InterfacesPage.tsx:718` 有 `max-w-[320px] truncate`，三处策略不同。
- 建议：`.ui-table` 唯一化；表格统一包一层 `<div className="overflow-x-auto">`（滚动层不承担卡片外观）；单元格默认 `truncate` + `title`；窄屏给小屏转录（卡片式行）。

### S2-09 页签只统一了外观，没有统一行为

- `[S2]` `lib/ui/tabStyles.ts:12-22` 只导出 class 字符串（`PAGE_TABLIST`、`PAGE_TAB`、`pageTabClass`），**没有任何键盘/ARIA 行为**；文件注释（4-10 行）说明统一动机是「各页抄类名 + 两套视觉语言」，但只解决了「长得一样」。
- `[S2]` 5 个页面级 tablist 的可达性各不相同：

| 页面 | role=tab | id/aria-controls | tabpanel | ←→ 键 |
|---|---|---|---|---|
| `PluginsPage.tsx:567-601` | 有 | **有** | **有** | 无 |
| `MemoryPage.tsx:2499-2531` | 有 | **有** | **有** | 无 |
| `SettingsPage.tsx:229-248` | 有 | 无 | 无 | 无 |
| `ModelPage.tsx:389-408` | 有 | 无 | 无 | 无 |
| `TeamPage.tsx:799-821` | 有 | 无 | 无 | 无 |

  而同一个文件里的 **radio group 却实现了方向键**（`SettingsPage.tsx:642-652`、`settings/ThemeModeCard.tsx:44-53`）——同一套「选项切换」交互，键盘支持有/无混在一起。
- 建议：抽 `useTabList` / `<TabList>`（含 roving tabindex、Home/End、←→、`aria-controls`、`tabpanel` 包装），`tabStyles.ts` 只保留视觉；把 radio group 和 tab 的行为合并成一套。

### S2-10 页面宽度档位（full/1200/960/720）被大面积绕过

- `[S2]` `PageShell.tsx:27-32` 定义了 4 档，但页面内又各自写死容器宽：

| 位置 | 宽度 |
|---|---|
| `SettingsPage.tsx:227` 与 `:280` | `max-w-[760px]`（两处重复，非 4 档之一） |
| `MemoryPage.tsx:2491` 与 `:2532` | `max-w-[1200px]`（两处重复，等于 `width="wide"`，但绕过了 PageShell） |
| `team/TeamWorkspace.tsx:379` | `max-w-[1000px]` |
| `collaboration/CollabView.tsx:375` | `max-w-[880px]` |
| `assistant/AgentPicker.tsx:57`、`AgentRosterView.tsx:64` | `max-w-[960px]` |
| `knowledge/KnowledgePage.tsx:596/617` | `max-w-[440px]` |
| `PluginsPage.tsx:728` | `max-w-[680px]` |
| `RegistryPage.tsx:176` | `max-w-[360px]` |
| `ModelPage.tsx:446`、`ModelUsageView.tsx:165` | `max-w-[420px]` |

- `[S2]` `SettingsPage.tsx:223-226` 的注释记录了另一段历史：曾 `mx-auto` 居中，后来改回左对齐，理由是「与首页/记忆/插件页的左边缘对不上，同一站点两种对齐网格」——说明这个议题已经被撞过两次，但结论只落在注释里，没进 `PageShell`。
- 建议：把 `760`（表单列）、`440`（说明段）纳入 `PageShell` 的宽度令牌（例如 `form` / `prose`），页面改用 `width` 属性而非自写容器；同一页里重复的容器合并成一处。

### S2-11 知识库页自绘页头，与 PageShell 高度/字号/内边距都不同

- `[S2]` `knowledge/KnowledgePage.tsx:633-637`：

```tsx
<header className="flex shrink-0 items-center gap-2 border-b border-line-soft px-3 py-1.5">
  <span className="ui-section-title">知识库</span>
  <select aria-label="切换知识库" className="ui-input h-7 w-[168px] text-[12px]" …>
```

- 对照 `layout/PageShell.tsx:73-75`：

```tsx
<header className="flex shrink-0 flex-wrap items-start justify-between gap-4 border-b border-line-soft px-6 py-4 max-[1199px]:px-4">
  <div className="min-w-0">
    <h1 className="ui-page-title">{title}</h1>
```

- 差异：内边距 12/6 vs 24/16、标题 15px vs 28px、页头高度约 40px vs 约 76px。在侧边栏切到「知识库」时，页头会明显「塌一下」。
- 建议：知识库是编辑器型页面，可用 `PageShell scroll={false} padded={false}` 保留统一页头（或在 `PageShell` 增加 `variant="dense"`），不要另写一份 header。

### S2-12 知识库空库态是被禁的「居中大标题 + 说明 + 按钮」模板

- `[S2]` `knowledge/KnowledgePage.tsx:592-615`：

```tsx
<div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
  <h1 className="ui-page-title">知识库</h1>
  <p className="ui-body max-w-[440px] text-muted">
    打开一个本地目录作为知识库：笔记就是普通的 .md 文件，双链、标签、反链、搜索与图谱都在本机计算。
    …
  </p>
  <div className="mt-1 flex items-center gap-2">
    <button className="ui-btn ui-btn-md ui-btn-primary" …>打开本地库</button>
    <button className="ui-btn ui-btn-md ui-btn-ghost" …>重新读取库列表</button>
```

- 三处反常：①`h1` 只在「空库」这一状态下出现，进入正常态后页面标题变成 15px 的 `span`（S2-11），语义层级翻转；②既没走 `EmptyState`，也没走 `PageShell`；③两个按钮都是主/次动作但权重接近（「重新读取库列表」其实应降为文字链接）。
- 建议：空态用 `EmptyState`（`icon` + `title` + `desc` + `actions`），页面标题始终由 `PageShell` 提供，空态只替换内容区。

### S2-13 输入控件第三套样式（textarea / 覆盖档位）

- `[S2]` `SkillsPage.tsx:917` — 导入技能的手写 textarea，与 `.ui-input` 完全不同的半径/内距/字号/焦点：

```tsx
<textarea
  aria-label="导入技能内容"
  …
  className="mt-1 block min-h-[110px] w-full resize-y rounded-lg border border-line-strong px-3 py-2 font-mono text-[11px] outline-hidden focus:border-ink"
/>
```

  对照 `index.css:490-507` 的 `.ui-input`：`rounded-md`（6px）/ `px-2.5` / `text-[13px]` / `h-8`。此处是 8px 圆角 + `px-3 py-2` + 11px 等宽字，且移除了 outline 只留边框变色。
- `[S2]` `KnowledgePage.tsx:637` 用 `ui-input h-7 w-[168px] text-[12px]` 覆盖基元的高度与字号（第 3 档高度）。
- `[S2]` `ModelPage.tsx:1525`、`:1558` 用 `ui-input flex-1 font-mono text-[12px]` 再覆盖字号。
- 建议：新增 `.ui-textarea`（同一套半径/边框/焦点）与 `.ui-input-sm`，取代表单内的 `h-7` / `text-[12px]` 覆盖；等宽场景只加 `font-mono` 不改字号。

### S2-14 工具条里的搜索/筛选宽度没有档位

- `[S2]` `ModelPage.tsx:457-463` `className="ui-input w-56"`（224px 固定）vs `SettingsPage.tsx:266` `w-full max-w-[420px]` vs `RegistryPage.tsx:176` `ui-input w-full max-w-[360px]` vs `SkillsPage.tsx:1191` `min-w-[180px] max-w-[320px] flex-1` vs `UnitListView.tsx:339` `min-w-[200px] max-w-[320px] flex-1`。
- 后果：同样「搜索本页」的框，在 5 个页面上宽度、是否随窗口伸缩、右对齐还是左对齐全不一样。
- 建议：`.ui-toolbar` + `.ui-search`（`w-full max-w-[320px]` 一档），所有页面工具条复用。

### S2-15 危险按钮有两套语义，视觉等级不一致

- `[S2]` `plugins/shared.tsx:14` 把「危险」实现成**幽灵按钮 + 红字**：

```ts
export const BTN_DANGER_SM = "ui-btn ui-btn-sm ui-btn-ghost text-[#b42318]";
```

- `[S2]` 而 `index.css:519-543` 已有 `.ui-btn-danger`（真·危险样式），`ModelPage.tsx:1239`、`:1485` 用的是后者。于是「删除」在插件区是一个普通幽灵按钮、在模型区是红底按钮、在设置区是 `.ui-btn-ghost` + `ConfirmDialog`（`SettingsPage.tsx:587`）。
- `[S2]` 同文件 `:10` 的 `ERROR_TEXT = "ui-body-sm text-[#b42318]"` 也是写死 hex（靠 `index.css` 的类名兜底才在暗色可用）。
- 建议：删除 `plugins/shared.tsx:10-15` 这组「假令牌」，改用 `<Button variant="danger">`；`ERROR_TEXT` 换成 `.ui-caption text-[var(--danger)]`。

### S2-16 焦点环要靠手贴，按钮基类没有

- `[S2]` 存在焦点令牌：`lib/a11y/focus.ts:20`

```ts
export const FOCUS_RING = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink";
```

- `[S2]` 但 `index.css` 全文只有 **1 条**焦点规则（`:501 .ui-input:focus`，且只改 `border-color`，靠 `--line-strong #8c8c8c → --ink #1a1a1a` 的色差）；`.ui-btn`、`.ui-chip`、`.ui-segment`、`.ui-filter-chip`、`.ui-disclosure` 都**没有** `focus-visible`。
- `[S2]` `FOCUS_RING` 只在 16 个文件里手贴（`SettingsPage.tsx` 3 处、`Stat.tsx` 2、`OnboardingCard.tsx` 4…），而体量最大的 `ModelPage`、`PluginsPage`、`SkillsPage`、`MemoryPage`、`KnowledgePage` **一次都没贴**。
- 建议：把 `FOCUS_RING` 合入 `.ui-btn` / `.ui-chip` / `.ui-segment` / `.ui-disclosure summary` / `.ui-card-interactive` 的 `@apply`；`focus-visible` 用 `outline` 而非 `box-shadow`（避免被 `overflow-hidden` 裁掉）。

### S2-17 `cursor: pointer` 基本缺失

- `[S2]` `index.css` 全文只有 3 处 `cursor`：`:252`（`.ui-disclosure > summary` 有 `cursor-pointer`）、`:505`（`.ui-input:disabled` 的 `cursor-not-allowed`）、`:511`（`.ui-btn` 的 `disabled:cursor-not-allowed`）。**`.ui-btn` 本身没有 `cursor-pointer`**。
- `[S2]` `@layer base`（`index.css:37-45`）只设置了 `border-color`，没有 `button { cursor: pointer }` 兜底。*（Tailwind v4 preflight 是否为 `button` 提供 `cursor: pointer`——**未验证**；即便提供，`<div role="button">` / 可点卡片仍不会变手型。）*
- 影响面：265 处 `.ui-btn` + tab + chip + `ui-card-interactive` 卡片。
- 建议：`.ui-btn` 加 `cursor-pointer`；`@layer base` 加 `button:not(:disabled), [role="button"]:not([aria-disabled="true"]) { cursor: pointer }`。

### S2-18 触摸目标普遍低于 32px（多处 16-28px）

- `[S2]` 按钮最小档 28px：`index.css:510-518` 的 `.ui-btn-sm h-7`，注释（`:483`/`:485`）明确「高度只两档 sm 28 / md 32」「可点击元素点击区 ≥28px」——这条内部标准本身就低于本次标尺的 32px，且 28px 已在大量使用（`PluginCard.tsx:146-195` 的 5 个动作、`ModelPage` 全页）。
- `[S2]` 分段控件 28px：`index.css:214-215` `.ui-segment { px-3 py-1 text-[12px] leading-5 }`；`ModelUsageView.tsx:205/258` 再压到 `px-2.5 py-0.5` ≈ **24px**。
- `[S2]` 主题色色点 **24×24**：`SettingsPage.tsx:766` `className={`h-6 w-6 rounded-full border border-line shadow-card …`}`（10 个色点并排，误点成本高）。
- `[S2]` 开关被换成 **16×16 复选框**：`settings/WidgetSettingsCard.tsx:354` `className="h-4 w-4 accent-[var(--accent,#2f5bd7)]"`（见 S2-19）。
- `[S2]` 自绘重试按钮 ≈20px：`TeamBoardPage.tsx:244` `rounded-sm border border-line px-2 py-0.5 text-[11px]`。
- 建议：交互控件最小 `h-8`（32px），图标/色点用 `p-1` 撑开点击区到 40px（视觉 24px 不放大）；`.ui-segment`/`.ui-filter-chip` 提到 `py-1.5`。

### S2-19 开关（Switch）还有 2 份新拷贝

- `[S2]` `settings/WidgetSettingsCard.tsx:345-356` 用原生 checkbox 冒充开关：

```tsx
<label className="flex items-center justify-between gap-3">
  <span className="ui-body-sm text-ink">{field.label}</span>
  <input
    type="checkbox"
    role="switch"
    aria-checked={value === true}
    checked={value === true}
    disabled={disabled}
    onChange={(event) => onCommit(field, event.target.checked)}
    className="h-4 w-4 accent-[var(--accent,#2f5bd7)]"
  />
</label>
```

- `[S2]` `plugins/shared.tsx:38-69` 另有一份自绘 18×32 开关（`disabled:opacity-40`），与 `ui/Switch.tsx`（18×32 + `role=switch` + 暗色 `--switch-off/knob`）重复。
- `[S2]` `ui/Switch.tsx` 的文件注释还记录过更早的三份逐字节拷贝（`ContextSettingsCard.tsx:34`、`MemoryPage.tsx:311`、`SkillsPage.tsx:344`）——即这份拷贝已经复发过一次。
- 后果：同一页里「桌宠设置」的开关是 16px 复选框、「上下文预算」的开关是 18×32 轨道，暗色下 `accent-color` 还是写死 `#2f5bd7`。
- 建议：两处都换 `ui/Switch`；加一条 lint/测试约束（`lib/themePrimitives.test.ts:103` 已经在断言 `from "./ui/Switch`，可扩成「禁止本地 `role="switch"` 实现」）。

### S2-20 「选中/高亮」有两种语言

- `[S2]` `plugins/PluginCard.tsx:68` 用写死 ring：`ring-2 ring-[#1a1a1a]/25`（`index.css` 没有 ring 的暗色兜底 → 暗色下几乎不可见）。
- `[S2]` `SettingsPage.tsx:118` 用 outline：`outline outline-2 outline-offset-2 outline-ink`。
- `[S2]` `SettingsPage.tsx:769` 又是 ring + offset 的 token 版：`ring-2 ring-offset-2 ring-[var(--ink)] ring-offset-[var(--surface)]`。
- 建议：统一成 `outline-2 outline-offset-2 outline-ink` 一种（outline 不受 `overflow-hidden` 影响，暗色自动跟随 token）。

### S2-21 暗色主题靠 116 条「类名白名单」兜底，调色板类完全没覆盖

- `[S2]` `index.css` 里形如 `[data-theme="dark"] .bg-\[\#fffbeb\]` 的覆盖规则共 **116 条**（如 `:835`、`:870`、`:1054`）。这意味着：任何新写的十六进制工具类，暗色下都「碰运气」——命中白名单才正常。
- `[S2]` 更危险的是 Tailwind 调色板类：`plugins/shared.tsx:72-76` 的 `diffTone`

```ts
border-emerald-200 bg-emerald-50 text-emerald-700   // 新增
border-amber-200 bg-amber-50 text-amber-700         // 修改
border-red-200 bg-red-50 text-red-700               // 删除
```

- `[S2]` 以及 `RouteGroupsCard.tsx:279` 的 `text-[10px] text-amber-700`、`RouteGroupsCard.tsx:292` 的 `bg-[#fcfcfc]`。调色板类在白名单机制之外 → 暗色下出现亮底药丸/深字。
- `[S2]` 全仓写死色值普查：**102 处 / 53 个文件**（`ContextSettingsCard` 3、`RouteGroupsCard` 4、`MemoryPage` 5、`SkillsPage` 4、`WikiPanel` 4、`SkillHubPanel` 4、`FileTree` 3、`ModelTraceView` 3、`NotificationCenter` 3…）。
- 建议：①新增 `--diff-add/-mod/-del` 语义 token 替换调色板类；②加一条 CI grep：组件里出现 `#[0-9a-f]{3,6}` 或 `-(amber|emerald|red|blue|green|gray)-\d{2,3}` 即失败（SVG 走 token 变量）；③把 116 条兜底逐步删掉，用 token 替代。

### S2-22 `--scrim` 令牌建了，17 处仍在手写遮罩

- `[S2]` `index.css:68-70` 的注释写明动机：

```css
/* 弹窗遮罩：此前 23 处手写 bg-black/10·20·30·75，四种不透明度的「同一层意思」。
   统一成一个 token，暗色下需要更重（深底上 20% 黑几乎看不出遮罩）。 */
--scrim: rgb(0 0 0 / 0.20);
```

- `[S2]` 现状：只有 2 处用了 token（`ConfirmDialog.tsx:48`、`ShortcutsHelp.tsx:96`），**17 处仍写死**：`bg-black/10` ×1（`SkillsPage.tsx:450`）、`bg-black/20` ×9（`CommandPalette.tsx:404`、`FilePreviewModal.tsx:194`、`MemoryPage.tsx:330`、`SkillsPage.tsx:219`/`:1232`、`AgentFormPanel.tsx:524`、`knowledge/QuickOpen.tsx:100`、`InstallDialog.tsx:256`、`PluginDetailDialog.tsx:96`）、`bg-black/30` ×5（`PluginRepositoryDialog.tsx:111`、`SkillHubPanel.tsx:192/353/501/605`）、`bg-black/75` ×2（`ChatPage.tsx:397`、`MarkdownMessage.tsx:155`）。
- 后果：暗色下 20%/30% 的遮罩几乎看不出层次，弹窗「浮起」感消失；同一产品里 4 种遮罩浓度。
- 建议：全量替换为 `bg-[var(--scrim)]`（图片查看可另加 `--scrim-strong`），并加 lint。

### S2-23 图表轴标签 = 9px + 2.5:1 对比度

- `[S2]` `ModelUsageView.tsx:239`：

```tsx
<text x={x + 7} y={138} textAnchor="middle" fontSize="9" fill="var(--chart-label)">
  {bar.label}
</text>
```

- `[S2]` `--chart-label` 亮色为 `#98a2b3`（`index.css:98`），在 `--surface #ffffff` 上约 **2.5:1**，远低于 4.5:1；暗色 `#9aa0a8`（`:162`）在 `#16171a` 上约 6.5:1（达标）。
- `[S2]` 9px 也低于 `.ui-micro`（10px）这一最小档；该标签是「日期」，属于需要读的信息，不是装饰。
- 建议：`--chart-label` 亮色改到 `#5c6673` 级（≈4.6:1），`fontSize` 提到 10-11；或用 `<title>` + 轴外标注（每 7 天一个）避免拥挤。

### S2-24 设置页分组层级弱：「高级」一栏塞 6 张卡

- `[S2]` `SettingsPage.tsx:102-108` 的 `SETTINGS_TABS` 里，`id: "model"` 的标签是「高级」，下挂 `KeyStorageCard` / `ContextSettingsCard` / `BackgroundModelCard` / `HitlPolicyCard` / `FileEditCard` / `StorageUsageCard` 六张卡——六个互不相关的主题靠一个模糊词归类。
- `[S2]` 卡片内部也没有二级分组：`RouteGroupsCard.tsx:205-292` 把「候选链」「休息名单」两大块用同尺寸 `border-line` 小卡并列，`:235` 甚至用 `truncate ui-section-title`（15px）做**单条候选链的名字**，与卡片标题（12px muted）层级倒挂。
- `[S2]` `HitlPolicyCard.tsx:109-113` 的标题/说明/表单之间只有 `mt-3`、`mt-1` 的手写间距，没有「行」容器，长说明与控件之间无分组线。
- 建议：设置分组改成语义命名（「模型与密钥」「工具与权限」「界面」「存储与更新」），卡内用 `<fieldset>` + `<legend>` 或 `.ui-section-title` 二级标题分组；条目名降为 `.ui-body-sm`。

### S2-25 `HitlPolicyCard` 的可访问名与可见文案分叉

- `[S2]` `HitlPolicyCard.tsx:157`、`:184` 的 `<select>` 既被 `<label>` 包裹（隐式关联），又写了 `aria-label`——读屏念 `aria-label`，可视用户看 label 文本，两者一旦文案不同就「说的不是一回事」。
- `[S2]` `HitlPolicyCard.tsx:171-176` 的 `clampedNotice` 是普通 `<div>`，没有 `role="status"`：数值被夹紧这件事只在视觉上「多一行小字」，读屏不会播报。
- 建议：`<select>` 只用 `id` + `htmlFor` 关联可见 label（去掉 `aria-label`）；提示语加 `role="status"`。

### S2-26 用量热力图的数据只能靠鼠标悬停读到

- `[S2]` `TokenHeatmap.tsx:14` 容器是 `role="img" aria-label="近 30 日 token 用量"`，30 个格子的唯一信息载体是 `title`：

```tsx
<div className="flex items-center gap-[3px]" role="img" aria-label="近 30 日 token 用量">
  {days.map((d, i) => (
    <span key={d.day} title={title} data-day={d.day} data-total={d.total} style={{ backgroundColor: LEVEL_BG[level] }} />
```

- 后果：键盘不可聚焦（`<span>` 无 tabindex）、读屏只得到一句总述、触屏无 hover → **30 天逐日用量对非鼠标用户完全不可得**；同时 `<title>` 的可见性依赖浏览器（未验证各端表现）。
- 建议：改成 `<table>`（30 列 × 1 行，`aria-label` 描述）+ 可见的「← 30 天 →」文字摘要；或保留图形 + 在下方给「最高/合计/最近 7 天」三个数字（`Stat` 已存在）。

### S2-27 链路图固定 960px 宽 + 手写空态

- `[S2]` `ModelTraceView.tsx:36` `const W = 960;`，`:249` `<svg role="img" aria-label="路由节点图" width={W} height={height}>`，外层 `:229` `<div className="ui-card overflow-x-auto p-4">`。
- 后果：1024 及以下窗口（含 768/375）必须横向拖动近 600px 才能看到「右侧账号列」——而右侧列正是「谁在回答」的关键信息。图内字号固定（不随 SVG 缩放），无缩放/小地图。
- `[S2]` 空态是第四套手写：`:231-233` `flex min-h-[240px] flex-col items-center justify-center gap-2 text-center` + `ui-icon-tile`。
- 建议：改成 `viewBox` + `width="100%"` 让它缩放（或提供「紧凑模式」只画 客户端→和鸣→账号 三列的单条链路）；窄屏退化为列表（已有下方「最近请求」表，可直接复用）。空态换 `EmptyState`。

### S2-28 团队页一级 Tab 的五个视图没有 tabpanel 关联

- `[S2]` `TeamPage.tsx:799-821` 的 tablist 有 `role="tablist"` + `role="tab"` + `aria-selected`，但没有 `id` / `aria-controls`；视图是条件渲染的裸节点：

```tsx
{tab === "workspace" && <TeamWorkspace />}
…
{tab === "board" && (<TeamBoardView … />)}
```

- 后果：读屏拿不到「这个 tab 控制哪块内容」；`Workspace` 与 `Board` 内部又有各自的工具栏，页面级切换与页内筛选两层控件的层级关系全靠视觉。
- 建议：与 S2-09 合并解决（统一 `TabList` + `tabpanel`）。

---

## 4. S3 — 打磨（16 条）

1. `[S3]` `ModelPage.tsx:1575-1594` — 所有操作结果（成功/失败）都渲染在**页面最底部**的固定条里（`role={output.ok ? "status" : "alert"}`），而触发按钮可能在页面中部或折叠区内，距离数屏；且该条与页面内多个 `details` 并列，滚动时会被滚出视口。→ 结果条改为就近（区块内）或 sticky 顶部 toast 队列。

2. `[S3]` `ModelPage.tsx:437` — loading 块 `rounded-2xl`（16px）与全站卡片 `rounded-xl`（12px，`index.css:462-466`）不一致。

3. `[S3]` `SettingsPage.tsx:284` — 搜索空结果只有一段正文文字（`<p className="ui-body-sm text-muted">`），而同一流程的列表版有 `role="status"`（`:289`）和无障碍播报；两句提示语还各写一遍（`:268-272` 与 `:284-286`）。→ 统一用 `EmptyState compact` + 一个 `role="status"` 计数。

4. `[S3]` `SettingsPage.tsx:266` — `className={`w-full max-w-[420px] ui-input ${FOCUS_RING}`}`：`FOCUS_RING` 只贴在这一处输入框上，同页其他输入（如 `TextField`）没有，焦点样式按元素手贴。

5. `[S3]` `InterfacesPage.tsx:692` — `mt-1 truncate font-mono text-[10px] text-muted`：传输命令行被截断且用 10px；同类信息在 `PluginsPage` 用 `ui-micro`（10px 档）但无 `truncate` 兜底。→ 统一 `ui-micro` + `title` 全文。

6. `[S3]` `FileTree.tsx:132` 与 `:159` — `px-2 pb-1 text-[10px] font-bold uppercase tracking-wider text-muted` 是第三种「分区标题」样式（前两种见 S2-06）。

7. `[S3]` `RegistryPage.tsx:344`、`:354` — `text-[11px] text-muted underline decoration-[#ddd] underline-offset-2 hover:text-ink`：写死 `#ddd` 下划线色（靠 `index.css:1054` 白名单才在暗色可用），且 11px 低于 `.ui-caption`。

8. `[S3]` `WikiPanel.tsx:287`、`:291` — 标签/时间用 `text-[10px]`；`:237` 的警告条 `bg-[#fffbeb] text-[#92400e]` 是写死色（同白名单）。

9. `[S3]` `SkillsPage.tsx:461` — 抽屉标题 `text-[14px] font-extrabold`，是第 4 种标题字号（其余见 S2-06）；同一抽屉 `:481/486/491/496` 又用 `text-[12px] font-bold text-muted` 做小节标题。

10. `[S3]` `RouteGroupsCard.tsx:228` — 空态是一句 `<div className="mt-3 ui-caption">还没有候选链</div>`，没有下一步动作；同页其他卡片都有「新建」按钮。

11. `[S3]` `ModelUsageView.tsx:287` — 空态 `<li className="ui-caption">这个时间段还没有可拆分的调用。</li>`，在 `<ul>` 里充当列表项，语义上是空态。（同类：`:165` 的 `max-w-[420px]` 居中说明。）

12. `[S3]` `TeamBoardPage.tsx:220-223` — 刷新按钮自绘：

```tsx
<button type="button" onClick={…} className="rounded-lg border border-line bg-[var(--surface)] px-2.5 py-1 ui-caption hover:bg-[var(--subtle-2)]">刷新</button>
```

    对照 `ModelPage.tsx:368` 的 `ui-btn ui-btn-md ui-btn-ghost`（带 `RefreshIcon`）——同一个「刷新」动作两种外观，且这版没有图标、没有 focus 环、高度约 26px。

13. `[S3]` `FileTree.tsx:145` — 空态文案 `<p className="text-[11px] leading-relaxed text-muted">还没有文件。点上方「上传」或「绑定」，把文件放进来。</p>`：第 5 套空态写法。

14. `[S3]` `SettingsPage.tsx:579` — 「恢复默认外观」行自绘：

```tsx
<div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line-soft bg-subtle px-4 py-3">
```

    既非 `.ui-card`，也不是公共「危险设置行」组件——但它旁边就是同一语义的「清空短期记忆」（`MemoryPage.tsx:2545` 用 `ConfirmDialog`）。→ 抽 `DangerZone`/`SettingsRow` 组件。

15. `[S3]` `PluginCard.tsx:128-144` + `:146-195` — 技能/MCP chip 全量铺开（无 `+N` 上限）导致网格内卡片高度差异大；底部 5 个 `ui-btn-sm`（28px）在 `flex flex-wrap` 里换行成两排，「卸载」紧邻「查看技能」且同色，无分隔线/危险色。

16. `[S3]` `PluginsPage.tsx:728` + `plugins/shared.tsx:9` — `max-w-[680px]` 任意宽度 + `HINT = "ui-caption"` 这种「常量别名」；同类别名在 `MemoryPage.tsx:84/93/98` 又重复定义了 `cardCls = "ui-card p-4"`、`hintCls = "ui-caption"`、`badgeCls = "ui-chip"`，`SkillsPage.tsx:85/88/94` 再定义一遍，`ContextSettingsCard.tsx:33` 又有一份 `hintCls`。→ 四份同名常量，删掉别名直接写语义类名（或由组件承载）。

---

## 5. 跨页面共性问题（这才是「缝合怪」的根因）

**P1 — 基元建了不用（最严重）**
`components/ui/` 有 8 个基元 + `lib/a11y/focus.ts` + `model/SectionCard`，却出现「Button 3 文件 vs 265 处手拼」「ErrorState 0 采用」「TextField 1 字段」的倒挂。每一页都在「重新发明一个按钮/卡片/空态」，于是间距、圆角、字号、焦点、暗色的处理处处不同。**这是所有其它问题的放大器。**

**P2 — 只统一了外观，没统一行为**
`tabStyles.ts` 只收口 class（`S2-09`），`ui/Switch` 只收口样式（`S2-19` 立刻复发），`EmptyState` 与 `.ui-empty` 两套 API 同一视觉（`S2-01`）。统一停在「长得像」，键盘、ARIA、状态语义仍各写一遍——5 个 tablist 的可达性表就是证据。

**P3 — 主题靠「类名白名单」而不是 token**
116 条 `[data-theme="dark"] .text-\[\#…\]` 覆盖规则 + 102 处写死色值 + 调色板类无覆盖（`S2-21`）。暗色不是设计系统的性质，而是补丁的集合；任何新颜色都在赌自己进没进白名单。`--scrim` 有 token 仍被 17 处绕过（`S2-22`）是同一个病的另一面。

**P4 — 页面外壳统一了，壳内没有版式语言**
`PageShell` 修好了页头/内边距/滚动（`PageShell.tsx:1-22` 的注释记录了它修掉的历史问题），但壳内的宽度（760/880/1000/1200 混用）、卡片壳（4 种）、卡片标题（3 种）、工具条（5 种搜索宽度）、对话框（4 种宽度）又长回来了。`PageShell.tsx:4-8` 当年列的四条病症（内边距 24/32 混用、标题 15/16/17、宽度 520/900、滚动容器不一致）**在壳内原样复发**。

**P5 — 三态各自为战**
loading 4 种、empty 3 套 + 5 种手写、error 5 种（`S2-01/02/03`）。管理页最需要的不是「炫」，而是「永远知道现在是什么状态、下一步点什么」；三种状态三种写法，读屏与视觉都没有稳定契约。

**P6 — 管理页的三处专业度缺口：表单 / 表格 / 危险操作**
- 表单：无可见标签、无必填、无错误关联（`S1-04`），`Field` 基元近乎闲置。
- 表格：`.ui-table` 只 3 处、抽成 6 处手写、长文本截断策略三样（`S2-08`）。
- 危险操作：3 处无确认（`S1-01/02`）、危险按钮 3 种视觉（`S2-15`）、危险行没有公共组件（`S3-14`）。
  这三项恰好是「管理后台像不像专业工具」的判定点。

---

## 6. 建议抽成公共组件 / 令牌的清单

> 顺序 = 投入产出比。每项都给了「现状证据 → 落点 → 可替换数量 → 验收」，可直接当施工单。

| # | 抽出物 | 现状证据 | 落点 | 可替换 | 验收 |
|---|---|---|---|---|---|
| 1 | `ui/SectionCard`（卡片壳 + 标题 + 说明 + action） | 4 种壳（`ContextSettingsCard:69`、`ThemeModeCard:56`、`HitlPolicyCard:109`、`ui-card`）；`model/SectionCard` 已存在但仅 1 用 | 从 `components/model/` 提升到 `components/ui/` | 设置页 6 卡 + 模型页 3 卡 + 团队卡 ≈ 15 处 | 全仓无 `rounded-xl border border-line` 手写壳；卡片标题只用一种类 |
| 2 | `<Button>` + 删除 `ui-btn` 字符串 | 265 处 / 51 文件 | 直接替换调用 | 51 文件 | `grep '"ui-btn '` = 0；`variant/size/leadingIcon/busy` 全覆盖 |
| 3 | `ui/Dialog`（尺寸档 + 遮罩 + `useModalA11y`） | 4 种宽度、2 种圆角、有/无 border（`InstallDialog:264`、`PluginRepositoryDialog:117`、`SkillHubPanel:359/611`） | 新组件，`ui/` 下 | 11 个 dialog 组件 | 遮罩只用 `var(--scrim)`；宽度只用 3 档 |
| 4 | `<TabList>` / `useTabList`（含 roving tabindex + ←→ + `tabpanel`） | 5 个 tablist，可达性 3 种（`S2-09`） | `components/ui/TabList.tsx` + 保留 `tabStyles` 视觉 | 5 处页面级 + N 处二级 | 每个 tab 有 `id`/`aria-controls`；键盘 ←→/Home/End 通过 |
| 5 | `.ui-btn` 内置 `FOCUS_RING` / `cursor-pointer` | `index.css:511` 无二者；`focus.ts:20` 手贴 16 文件 | `index.css` `@layer components` + `@layer base` | 全站交互元素 | Tab 走查每个可交互元素有可见 outline |
| 6 | `ui/ErrorState` 接线 | 0 采用；5 种失败态；`ErrorState.tsx:18` 自述 28 处断言 | 先换 6-8 处无断言的裸 `<p role="alert">` | 8-28 处 | `grep '加载失败：'` 只剩 `title`/`desc` 两种用法 |
| 7 | `ui/EmptyState` 唯一化 | 3 套系统 + 5 种手写 | 删除页面里的 `.ui-empty-*` 直接调用 | 19 处 `.ui-empty` + 6 处手写 | 全站空态只有 `EmptyState` |
| 8 | `.ui-textarea` / `.ui-input-sm` | `SkillsPage:917` 第三套样式；`h-7`/`text-[12px]` 覆盖 3 处 | `index.css` | 4-6 处 | 输入控件半径/焦点/字号只有一档 |
| 9 | 语义色 token：`--diff-add/-mod/-del`、`--chart-label` 提对比度 | `plugins/shared:72-76` 调色板类；`ModelUsageView:239` 2.5:1 | `index.css :root` + 暗色 | 5+ 处 | 组件内无 `emerald/amber/red-\d+`；轴标签 ≥4.5:1 |
| 10 | `--scrim` 全量替换 | 17 处 `bg-black/10·20·30·75` | 直接替换 | 17 处 | `grep 'bg-black/'` = 0 |
| 11 | `ui/Toolbar` + `.ui-search` | 5 种搜索宽度（`S2-14`） | 新组件 | 5 页工具条 | 搜索框宽度一致、行为一致 |
| 12 | `DangerZone` / `SettingsRow` | `SettingsPage:579` 自绘行；3 处无确认删除 | 新组件（内建 `ConfirmDialog`） | 4-6 处 | 危险动作 0 处直接执行 |
| 13 | `ui/Switch` 唯一化 + 约束 | 2 份新拷贝（`S2-19`） | 替换 + 扩 `themePrimitives.test.ts` | 2 处 | 无本地 `role="switch"` |
| 14 | 触摸目标令牌（`.ui-hit` = 最小 32px 点击区） | 28/24/20/16px 多处（`S2-18`） | `index.css` | 全站小控件 | 所有可点元素 bounding box ≥32px |
| 15 | 宽度令牌补 `form`(760) / `prose`(440) | `SettingsPage:227/280`、`KnowledgePage:596` 手写 | `PageShell` `PageWidth` 扩展 | 4 处 | 页面内无 `max-w-[760px]` 等手写 |
| 16 | 管理页表格规范（`.ui-table` + 滚动层 + 截断） | `.ui-table` 3 处 vs 手写 6 处；`ModelUsageView:292` 滚动加在卡片上 | `.ui-table` + `<TableScroller>` | 3-5 处 | 滚动层不含卡片外观；单元格默认 `truncate`+`title` |

---

## 7. Top 10 优先修复（建议按序）

1. **3 处无确认删除**（`RouteGroupsCard.tsx:245`、`ModelPage.tsx:1237`、`ModelPage.tsx:1483`）→ 全部接 `ConfirmDialog`。—— 数据不可逆，风险最高，改动量最小。
2. **`SectionCard` 提升 + 统一卡片壳**（消灭 `bg-white` + `mt-3` + 3 种标题）。—— 「缝合怪」最直观的来源。
3. **`<Button>` 替换 265 处 `ui-btn` 手拼 + `.ui-btn` 内置 focus/cursor。** —— 一次性解决焦点、光标、尺寸三件事。
4. **`ErrorState` / `EmptyState` / `Skeleton` 接线**（先做无断言负担的 8-10 处）。—— 三态是管理页的骨架。
5. **`ui/Dialog` + `--scrim` 全量替换。** —— 暗色遮罩与弹窗尺寸立刻一致。
6. **表单改用 `TextField`**（模型页运行页 20 字段优先）。—— 可见 label / 必填 / 错误关联。
7. **`TabList` 行为统一 + 补 `tabpanel`。** —— 5 个页面级 tablist 一次修完。
8. **危险按钮语义统一（删 `BTN_DANGER_SM`）+ 调色板类换 token。** —— 暗色与危险语义同时收敛。
9. **模型页「运行」Tab 收进「高级」，英文枚举中文化。** —— 可理解性最大的单点提升。
10. **知识库页头并入 `PageShell` + 空态换 `EmptyState`。** —— 消除「切页时页头塌一下」的观感割裂。

---

## 8. 已经做对的（不要动）

- **无 AI 味视觉**：全仓 `bg-gradient|from-purple|from-violet|to-pink|indigo-|violet-` **0 匹配**；有质感的克制用色，没有被「紫粉渐变」污染。
- **禁用 emoji 当图标**：除 `EmojiPicker.tsx:9-10`（表情选择器本身，合理）外，UI 图标全部走 `icons.tsx` 的 SVG。
- **`prefers-reduced-motion` 全局覆盖**：`index.css:624-626`（skeleton）、`:741-749`（plugin-rise / dialog-pop）、`:1144-1148`（`animation: none !important`）；`ModelTraceView.tsx:95-100` 还单独监听 `matchMedia` 停掉链路流动。这条做得比多数项目好。
- **`useModalA11y` 存在且被 14+ 处使用**（焦点陷阱 + Esc + 背景块），`SkillsPage.tsx:441-457` 的抽屉是 `role=dialog` + `aria-modal` 的正确用法。
- **`MemoryPage.tsx:2499-2531`** 是 tablist 的最佳实现（`id` + `aria-controls` + `tabpanel` + `aria-labelledby`），可作为 `TabList` 抽出的参考实现。
- **`--placeholder: #767676`** 的选择有 WCAG 依据（`index.css:72-74` 注释写明 4.5:1 的理由）；`--scrim` 的动机注释同样写清了暗色问题——**设计意图是清楚的，缺的是执行收口**。
- **`model/SectionCard.tsx`** 的文件注释（`:4-10`）几乎就是本报告的建议书；把它往上提一层就能解决 P4 的一半。

---

## 9. 未验证 / 无法静态确认

- 暗色主题下的**真实观感**（116 条兜底规则是否真的覆盖到每一处；`ring-[#1a1a1a]/25` 在 `#16171a` 上的实际可见度）——需要渲染截图。
- 对比度：`--chart-label #98a2b3` / `--muted #6f6f6f` / `--placeholder #767676` 的比值按公式手算，未用工具实测渲染后像素。
- Tailwind v4 preflight 是否为 `button` 提供 `cursor: pointer`（关系到 `S2-17` 的实际严重度）。
- 375/768/1024/1440 四断点下是否**出现页面级横向滚动**：代码层面未发现 `w-screen`/超宽固定容器（`ModelTraceView` 的 960px 在 `overflow-x-auto` 卡片内，不外溢），但未做运行时验证。
- 拖拽、键盘方向键、焦点陷阱在真实浏览器中的行为（仅读代码判断为「未实现」或「已实现」）。
- 文案/信息架构是否与最新产品定义一致（审计只判断「同一语义在不同页面是否一致」，不判断业务是否正确）。

---

*审计方式：纯静态源码阅读 + 跨仓 grep 普查；未执行任何构建、测试或浏览器操作。所有行号以审计当时的 `D:\Heming\packages\web\src` 为准。*