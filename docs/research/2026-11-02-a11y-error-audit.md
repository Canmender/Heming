# 无障碍与错误态巡检（③-2 / ③-3）· 2026-11-02

- 范围：`packages/web/src/components/**`（54 个非测试组件文件）+ 新增 `lib/a11y/focus.ts`；`App.tsx` / `main.tsx` 归 hotpath，未改；不动服务端。
- 方法：静态扫描（role/aria/outline/img/按钮可访问名/静默 catch）+ 组件用例 + 用 token 实际值算对比度（脚本，不靠目测）。
- 原则：**不改视觉设计**；只补语义、焦点可见性、错误态与可读性对比。清单逐条标 **已修 / 已存在 / 不适用 + 理由**。

---

## 0. 本轮修了什么（汇总）

| # | 文件 | 改动 | 用例 |
|---|---|---|---|
| F1 | `lib/a11y/focus.ts`（新） | 全仓焦点环口径常量（`FOCUS_RING` / `FOCUS_RING_TIGHT` / `withFocusRing` / `hasFocusRing`）；禁止 `outline-none` 的源码守卫 | `lib/a11y/focus.test.ts` 5 例 |
| F2 | `components/a11y/GlobalFocusRing.tsx`（新） + `NavRail.tsx` | 挂一条 `:focus-visible { outline: 2px solid var(--heming-accent); outline-offset: 2px }`，覆盖全站 59 处 `outline-hidden`（v4 改名后这些控件失去焦点环）；`forced-colors` 下交还系统色；幂等注入 | `GlobalFocusRing.test.tsx` 4 例 + `NavRail.test.tsx` +2 |
| F3 | `LoginPage.tsx` | 输入框 `aria-label`（不靠 placeholder 当名）、`autocomplete`；错误行 `role="alert"` + `id=login-error`；输入框 `aria-invalid` / `aria-describedby`；输入框与提交按钮加可见焦点环 | `LoginPage.test.tsx` +3 |
| F4 | `NotificationCenter.tsx` | 铃铛 `aria-haspopup="dialog"` + `aria-controls` + 面板 `id`；未读数 polite 活区播报（`sr-only`），角标 `aria-hidden` 防重复播报；时间戳对比度 `#999`→`#6f6f6f` | `NotificationCenter.test.tsx` +3 |
| F5 | `AgentStreamBubble.tsx` | 流式/失败只做粗粒度 live 播报（**正文不进 live region**，避免逐 token 念屏）；次级文字对比度 `#bbb/#999/#888/#777` → `#6f6f6f/#555`；思考过程/继续生成按钮焦点环 | `AgentStreamBubble.test.tsx` +3 |
| F6 | `ChatPage.tsx` | 附件下载失败占位 `role="alert"` 并给**「重试」**（重拉 blob，成功即渲染）；消息骨架补 `role="status"`；会话搜索输入框与消息输入框补可见焦点环；导出菜单说明文字对比度 | `ChatPage.test.tsx` +1（并强化既有 401 用例） |
| F7 | `TeamPage.tsx` | 成员搜索框焦点环；名册/动向/用量加载态 `role="status"`、失败态 `role="alert"`、同步失败 `role="alert"`；「上次同步」对比度 `#999`→`#6f6f6f` | `TeamPage.test.tsx` +2 |
| F8 | `FileEditCard.tsx` | 错误行 `role="alert"`（原先只有颜色差异，读屏不播报） | 既有用例覆盖 |
| F9 | `tailwind.config.js` + 25 个组件文件 | **token `muted #888888 → #6f6f6f`**（白底 3.54→5.02、`#fafafa` 3.40→4.81，达 AA 正文）；同时把 138 处硬编码 `text-[#999/#bbb/#888/#777/#aaa]`（**文字用途**）统一为 `text-muted`；占位符 `placeholder:text-[#bbb]`、`disabled:text-*`、装饰图标着色、深色提示 `#ccc` **刻意保留**并在 §4/§7 注明 | 全量 web 用例 2798 例绿（含 23 例新增） |
| F10 | `tailwind.config.js` + 21 个组件文件 | 新增 token **`line-strong: #8c8c8c`**（白底 3.36 / `#fafafa` 3.22 / `#fcfcfc` 3.28，均 ≥3:1），**只用于 input/select/textarea 的边界**；`focus:border-[#bbb]`（1.85:1）→ `focus:border-ink`；纯分隔线继续用 `line`。升级 50 处控件标签 | 同上（全量用例绿） |

> 焦点环系统修法说明：逐处改 59 个 `outline-hidden` 会跨多批文件、容易撞车；`index.css` 属样式链基线（不归本轨）。因此用组件层注入一条 `:focus-visible` 规则（NavRail 常驻，挂一次），只对**键盘**生效、不改任何既有 token/间距/颜色，等价于恢复浏览器默认焦点环且跟主题色一致。

**新增用例共 23 例**（全绿）：`focus.test.ts` 5、`GlobalFocusRing.test.tsx` 4、NavRail +2、LoginPage +3、NotificationCenter +3、AgentStreamBubble +3、ChatPage +1、TeamPage +2。相关文件定向回归 215 例绿；**全量 web 用例 2798 例全绿**（token/className 批量替换后的回归）；`tsc --noEmit` 0 报错。

---

## 1. 键盘可达性（③-2）

| # | 检查项 | 结论 | 证据 / 理由 |
|---|---|---|---|
| 1.1 | 全站 Tab 顺序 | 已存在 | 无正 tabindex（扫描 0 处 `tabIndex={1..9}`），DOM 顺序即视觉顺序；NavRail 在最前，主内容区随后 |
| 1.2 | 焦点环可见（`outline-hidden` 迁移后） | **已修（F1/F2）** | v4 把旧 `outline-none` 改名 `outline-hidden`（`outline: 2px solid transparent`），迁移后 59 处控件**没有可见焦点环**；全局 `:focus-visible` 规则已恢复，并给登录/聊天/团队高频输入框显式加 `FOCUS_RING` |
| 1.3 | 鼠标点击不出环（只键盘出） | **已修（F2）** | 规则用 `:focus-visible`，不用 `:focus`；用例断言 CSS 里没有裸 `:focus {` |
| 1.4 | 高对比模式焦点不被自定义色盖掉 | **已修（F2）** | `@media (forced-colors: active) { :focus-visible { outline: 2px solid Highlight } }` |
| 1.5 | Esc 归属（栈顶独占） | 已存在 | `useModalA11y` 维护 `openDialogs` 栈 + `topToken()` 按 DOM 嵌套取最内层，只有它响应 Esc；`App.tsx` 用 `hasOpenModal()` 拦全局快捷键；13 个弹窗全部走该 hook，`useModalA11y.test.tsx` 已覆盖嵌套/Esc/背景屏蔽 |
| 1.6 | 弹窗内焦点循环 | 已存在 | `useModalA11y` 在 `capture` 阶段监听 Tab/Shift+Tab，首尾回绕；打开落焦（`initialFocusRef` 或首个可聚焦元素）、关闭归还触发元素；`useModalA11y.test.tsx` 有对应用例 |
| 1.7 | 导航可键盘触发 | 已存在 | NavRail 是原生 `<button aria-label aria-current>`；Alt+1..9 快捷键在 `App.tsx`；图标按钮扫描 38 个，全部有 `aria-label` 或可见文字（0 漏网） |
| 1.8 | 行内操作/分页/开关可键盘触发 | 已存在 | 全部原生 `<button>`/`<input type="checkbox">`（TeamPage 共享开关、RolloutTimeline 筛选、TeamBoard 分页等），无 `div role=button`；`aria-pressed` 13 处、`aria-expanded` 8 处 |
| 1.9 | 模态背景屏蔽 | 已存在 | `useModalA11y` 对不含弹窗的兄弟节点挂 `inert`（引用计数），通知抽屉这类非模态用 `blockBackground:false` |
| 1.10 | 图片灯箱 Esc/焦点 | 已存在 | ChatPage 图片放大 `role="dialog" aria-modal` + `useModalA11y`；MarkdownMessage 同口径 |

---

## 2. 状态语义与播报（③-2）

| # | 检查项 | 结论 | 证据 / 理由 |
|---|---|---|---|
| 2.1 | 流式生成状态 | **已修（F5）** | 原先只有视觉「生成中…」。现每个流式气泡加一条 `sr-only role="status" aria-live="polite"`，**只播报「正在生成/生成失败/已生成」**；正文不放进活区——逐 token 变化会变成每 token 念一次。用例断言活区不含正文 |
| 2.2 | 错误行播报 | 已存在 + **已修（F6/F7/F8）** | ChatPage 发送失败 `role="alert"`（既有）；本轮补：登录失败、附件下载失败、名册/动向/用量加载失败、文件编辑错误、共享同步失败 |
| 2.3 | 通知中心 | **已修（F4）** | 未读数进 polite 活区；角标 `aria-hidden` 防「2」重复念；铃铛可展开语义 `aria-haspopup/aria-controls/aria-expanded` 与面板 `id` 对应 |
| 2.4 | 桌宠气泡 | 已存在 | `pet/PetWindow.tsx` 气泡已带 `role="status" aria-live="polite"`；桌宠事件通道本身不改消息协议（另一轨负责） |
| 2.5 | 团队用量/日程加载态 | **已修（F7）** | 加载中 `role="status"`、失败 `role="alert"` + 重试；空态文案仍在（日程「仅本机可见」/「未开启共享」/「暂无摘要」三态） |
| 2.6 | 不重复播报 | 已存在（巡检确认） | 同一事件只有一处播报：连接断开横幅（`role=status`）与恢复提示（`role=status`）不会同时出现；流式活区只播状态不播正文；通知角标 `aria-hidden`。`aria-live` 全站仅 4 处（PetWindow、流式气泡、通知活区、`role=status` 隐式），无重叠 |
| 2.7 | WS 重连横幅 | 已存在 | `connState==="closed"` 时 `role=status` 横幅「连接已断开，正在自动重连…消息会排队，恢复后自动补发」；恢复时「已恢复连接」`role=status` |
| 2.8 | 消息加载三态 | 已存在 + **已修（F6）** | 骨架（`aria-busy`，本轮补 `role="status"`）/ 失败（`role=alert` + 重试）/ 真空态文案；三种形态彼此可区分 |
| 2.9 | 团队名册/动向三态 | **已修（F7）** | 骨架 `role=status aria-busy`、失败 `role=alert` + 重试、空态（无成员/无符合条件/无可见动向） |

---

## 3. 表单与图片（③-2）

| # | 检查项 | 结论 | 证据 / 理由 |
|---|---|---|---|
| 3.1 | 表单字段有可访问名 | **已修（F3）** | 登录页原先只靠 placeholder（不能稳定作为可访问名）→ 补 `aria-label`；全站 `aria-label` 278 处，select/搜索框均有 `aria-label` 或可见 `<label>` |
| 3.2 | 错误与字段关联 | **已修（F3）** | 登录失败：错误行 `role=alert` + `id`，两个输入框 `aria-invalid="true"` + `aria-describedby="login-error"`（无错误时不挂 `aria-invalid`，避免误报） |
| 3.3 | 图片 alt | 已存在 | 内容图 `alt={file.name}`（聊天附件/预览/灯箱）；Markdown 图片用作者写的 alt；头像与 registry 图标 `alt=""`（装饰性，旁边始终有名字/首字）；Wordmark 为 `role="img" aria-label="Heming"` |
| 3.4 | 图标按钮可访问名 | 已存在 | 脚本扫描 38 个「按钮内只含图标」的场景：全部有 `aria-label` 或可见文字，0 漏网；图标 SVG 未默认 `aria-hidden`，但因不构成可访问名，不产生空名按钮（见 §7 建议） |
| 3.5 | 开关语义 | 已存在 | 桌宠/团队共享等自定义开关用 `role="switch" aria-checked` 或原生 checkbox（`accent-*`）；`aria-pressed` 13 处用于双态按钮 |
| 3.6 | 标签页语义 | 已存在 | 团队页三视图 `role="tablist"` + `role="tab" aria-selected`（本轮巡检确认；共 6 处 tablist/7 处 tab） |

---

## 4. 对比度（用 token 实际值计算，WCAG 2.1）

计算方式：sRGB 相对亮度 + `(L1+0.05)/(L2+0.05)`；正文阈值 4.5:1，大字/非文本 UI 3:1。

| 用途 | 前景 / 背景 | 实测比值 | 判定 | 处理 |
|---|---|---|---|---|
| 正文 | `ink #1a1a1a` / `#ffffff` | **17.40** | AA ✓ | — |
| 正文反白 | `#ffffff` / `ink #1a1a1a` | **17.40** | AA ✓ | — |
| 次要正文 | `#555` / `#ffffff` | 7.46 | AA ✓ | — |
| 次要正文 | `#666` / `#ffffff` | 5.74 | AA ✓ | — |
| **弱化文字（token `muted`）** | `#6f6f6f` / `#ffffff` | **5.02** | **AA ✓（已修）** | 原 `#888888` 为 3.54（✗）；`#fafafa` 上 4.81 也达标 |
| 弱化文字（token `muted`） | `#6f6f6f` / `#fafafa` | 4.81 | AA ✓（已修） | 同上 |
| 时间戳/次要文字（硬编码 `#999/#bbb/#888/#777/#aaa`） | 统一 `text-muted #6f6f6f` / 页面底 | 4.81–5.02 | **已修（138 处文字）** | 占位符 / disabled / 装饰图标 / 深色提示 `#ccc` 保留（§7-4） |
| **表单控件边界（新 token `line-strong`）** | `#8c8c8c` / `#ffffff`、`#fafafa`、`#fcfcfc` | **3.36 / 3.22 / 3.28** | **非文本 3:1 ✓（已修）** | 原控件边框 `line #e6e6e6` 仅 1.25（✗）；纯分隔线仍用 `line` |
| 控件聚焦边框 | `ink #1a1a1a`（`focus:border-ink`） | 17.40 | 非文本 3:1 ✓（已修） | 原 `focus:border-[#bbb]` 1.85（✗） |
| 状态绿 `#12b76a` | `#12b76a` / `#ffffff` | **2.62** | ✗ | 仅作圆点（装饰，非文本）；若当文字见 §7-3 |
| 状态绿 `#067647` | `#067647` / `#ecfdf3` | 5.40 | AA ✓ | — |
| 警示 `#b45309` | `#b45309` / `#fffaeb` | 4.81 | AA ✓ | — |
| 警示 `#92400e` | `#92400e` / `#fffbeb` | 6.84 | AA ✓ | — |
| 错误 `#b42318` | `#b42318` / `#fef3f2` | 6.05 | AA ✓ | — |
| 错误 `red-600` | `#dc2626` / `#ffffff` | 4.83 | AA ✓ | — |
| 成功 `#15803d` | `#15803d` / `#f0fdf4` | 4.79 | AA ✓ | — |
| 链接/分叉蓝 `#3538cd` | `#3538cd` / `#f5f8ff` | 7.60 | AA ✓ | — |
| 分割线 `line #e6e6e6` | / `#ffffff` | **1.25** | 非文本 1.4.11 ✗ | 仅作装饰性分隔（不承载控件边界）→ 可接受；若当输入框边界见 §7-4 |
| 细线 `line-soft #ececec` | / `#ffffff` | 1.18 | 同上 | 同上 |
| 占位/脉冲 `#98a2b3` | / `#ffffff` | 2.58 | ✗ | 仅装饰脉冲点/骨架，不承载文字 |
| 次要按钮 `#475467` | `#475467` / `#f9fafb` | 7.36 | AA ✓ | — |

> 本轮按 Lead 拍板改了**两个 token**（不在原「不改视觉设计」范围内，属 ③-2 可读性修复）：
> `muted #888888 → #6f6f6f`（文字，达 AA）、新增 `line-strong #8c8c8c`（仅表单控件边界，达 3:1）。
> 纯分隔线、`ink`、`panel` 均未动；占位符/disabled/装饰图标/深色提示 `#ccc` 保留（见 §7-4）。

---

## 5. 错误态与离线（③-3）

| # | 入口 | loading | error | retry | 结论 |
|---|---|---|---|---|---|
| 5.1 | 团队页-名册 | 骨架（`role=status aria-busy`） | `role=alert` 文案 | 「重试」 | **已修（F7）** |
| 5.2 | 团队页-动向 | 骨架（同上） | `role=alert` | 「重试」 | **已修（F7）** |
| 5.3 | 团队页-用量 | `role=status` 加载中 | `role=alert` | 「重试」 | **已修（F7）** |
| 5.4 | 团队页-共享同步失败 | — | 「共享同步失败」`role=alert` | 下一轮轮询自动重试（60s）/ 手动刷新 | **已修（F7）** |
| 5.5 | 团队页-清除用量 | 按钮「清除中…」+ disabled | 失败写 `usageError`（`role=alert`）| 清除按钮可再点 | 已存在（本轮复核） |
| 5.6 | 桌宠设置 | 运行态探测中（文案提示） | 模型路径错误 `role=alert`（既有） | 「默认」重置 + 重新保存 | 已存在 |
| 5.7 | 文件编辑卡 | 「选择目录」进行态 | 错误行（本轮补 `role=alert`） | 直接改路径/重选目录 | **已修（F8）** |
| 5.8 | 任务区 | 启动面板 pending（「启动中…」+ disabled） | 失败原因进任务记录 `error`，`role=status` 提示 | 「重跑」新建任务（原任务留痕） | 已存在（本轮复核） |
| 5.9 | 信息中枢 | `busy` 状态串（connecting/agenda…） | `role=alert` 错误条（既有） | 「重试/重建」按钮（既有） | 已存在 |
| 5.10 | 附件上传失败 | 「上传中…（≤6MB）」占位 | `sendNotice` 错误（附件场景**不提供重试**，避免重放一次上传；文案写明） | —（刻意不给） | 已存在 + 设计取舍记录 |
| 5.11 | 附件下载失败 | 取 blob 期间不渲染断链 | 「加载失败」`role=alert`（本轮补） | **「重试」**（本轮新增，重拉 blob 成功即渲染） | **已修（F6）** |
| 5.12 | 会话历史加载 | 骨架 `role=status`（本轮补） | `role=alert` + 重试（既有） | 「重试」 | 已存在 + **已修（F6）** |
| 5.13 | 发送失败 | — | `role=alert`；纯文本带「重试」，附件不带 | 有（文本） | 已存在 |
| 5.14 | WS 断线 | 「连接中…」文案 | 断线横幅 `role=status`（自动重连、消息排队） | 自动退避重连；恢复提示 | 已存在 |
| 5.15 | E2E 不降级 | — | 无 subtle：不发明文，拦截 + 横幅；解不开的密文不进提示词 | — | 已存在（既有硬验收用例） |
| 5.16 | 静默失败扫描 | — | `catch {}` 集中在：日志/记忆/通知等**非用户可见副作用**（设计上「失败不影响主链路」），或已有可见降级；用户可见的异步入口均已有 loading/error（本轮补 6 处） | — | 巡检结论 |

---

## 6. 不适用（本轮明确不做，附理由）

| # | 项 | 理由 |
|---|---|---|
| 6.1 | 全站逐处改 `outline-hidden` 的 className | 59 处跨多批文件，易与并行批次冲突；已用全局 `:focus-visible` 规则达成同一效果（F2），逐处显式环只加在高频输入框 |
| 6.2 | 改 `muted/line` 等设计 token 取值 | 本轮纪律「不改视觉设计」；token 达标注在 §7 由 Lead 决定 |
| 6.3 | 给图标 SVG 默认 `aria-hidden` | 扫描无空名按钮（38/38 有名字），改动收益低、误伤风险（若某处仅图标）需全量用例背书；列入 §7 建议 |
| 6.4 | 屏幕阅读器真机逐页走查 | 本机无 NVDA/VoiceOver 自动化；本轮以语义与用例断言为准，真机走查留人工（交接注明） |
| 6.5 | 键盘快捷键全表复核 | 属 `App.tsx`（hotpath 所有），本轨只确认弹窗门禁 `hasOpenModal` 口径 |
| 6.6 | 桌宠窗口本体（pet/**） | 另一轨（②-4）在改；只巡检其气泡 `role=status` 已存在 |

---

## 7. 后续项（1–3 已修，4–6 不做/人工）

**已修（Lead 拍板后本轮完成）：**
1. ~~token `muted #888 → #6f6f6f`~~ → **已修**（F9）。白底 3.54→**5.02**、`#fafafa` 3.40→**4.81**；全站弱化文字略深是预期。
2. ~~硬编码 `#999/#bbb` 统一到 `text-muted`~~ → **已修**（F9，138 处文字用途）。刻意保留：`placeholder:text-[#bbb]`（占位符语义不同，且浏览器占位符对比度另有口径）、`disabled:text-*`（禁用态不受 AA 约束）、装饰图标着色（`Icon` 同行，语义为装饰）、`kbd` 深色提示 `#ccc`（在深色浮层上对比度足够）。
3. ~~控件边框 `line` 不达 3:1~~ → **已修**（F10）：新增 `line-strong: #8c8c8c`，只用于 input/select/textarea 边界；聚焦边框改 `focus:border-ink`。纯分隔线继续 `line`。

**不做 / 留人工：**
4. 图标 SVG 默认 `aria-hidden="true"`：**本轮不做**（Lead 拍板；38/38 图标按钮已有可访问名，收益小于全量组件背书成本）。若将来做：在 `icons.tsx` 的 `base()` 加默认值，调用方可覆盖。
5. NVDA 真机走查：留人工；发版前按「登录 → 会话 → 任务区 → 团队页」过一遍（本轮已保证语义与焦点基础）。
6. `PetSettingsCard.tsx` 的 2 处表单控件边界仍是 `border-line`：该文件属 hotpath（②-4 桌宠在场感）写范围，本轮不跨界修改；已在此登记，待该轨收口后顺手换 `border-line-strong` 即可。
