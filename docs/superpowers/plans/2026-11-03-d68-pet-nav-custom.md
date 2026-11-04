# d.68 执行计划：桌宠交互修复 + 导航自动隐藏 + 布局字体 + 自定义内容简化

- 日期：2026-11-03
- 分支：`feat/d68-pet-nav-custom`（从 `origin/main` = d.67 `19e08fe` 拉出）
- 目标版本：`d.68.2.25.0`（feature 位 +1；由 Lead 统一 bump，**teammate 不要改版本号/CHANGELOG**）
- 轮次定位：**体验修复 + 一轮功能完善**，不改 E2E / HITL / 数据出设备的架构红线
- 上游依据：用户 2026-11-03 报告 + 追问确认（见 §1）

---

## 0. 团队与写入边界（必须遵守）

| 工作流 | 负责人 | 写入范围（只允许改这些） |
|---|---|---|
| A 桌宠 | `pet-fix` | `packages/desktop/pet-host.js`、`pet-window.js`（如需）、`packages/web/src/components/pet/**`、`packages/web/src/lib/pet*.ts`、对应测试、`docs/PET.md`、`docs/superpowers/specs/2026-11-03-d68-pet-interaction.md` |
| B 导航 + 布局字体 | `nav-shell` | `packages/web/src/App.tsx`、`components/NavRail.tsx`、`components/layout/**`、`components/HomePage.tsx`、`components/SettingsPage.tsx`、`index.css`、`store/ui.ts`、`lib/viewport.ts`、新增 `lib/nav*.ts`、对应测试、`docs/superpowers/specs/2026-11-03-d68-nav-layout.md` |
| C 自定义内容 | `custom-simplify` | `packages/web/src/components/AgentFormModal.tsx`、`AssistantPage.tsx`、`SkillsPage.tsx`、对应测试、`docs/superpowers/specs/2026-11-03-d68-custom-content.md` |
| 互联网方案调研 | 子代理（research） | 只写 `docs/research/2026-11-03-d68-ux-solutions.md` |
| 集成 / 版本 / 文档 | Lead | 根/子包 `package.json`、`CHANGELOG.md`、`packages/web/src/generated/changelog.ts`、`docs/HANDOFF.md`、`docs/INDEX.md`、本计划、合并提交 |

**硬规则**

1. 不 push、不改 git 分支、不提交（提交由 Lead 做）。共享工作区同时改文件，提交前 Lead 统一 review。
2. 不跑 `node scripts/bump-version.mjs`、不改 `CHANGELOG.md`（Lead 统一做，否则五包版本会互相覆盖）。
3. 新增 IPC 通道必须登记到 `packages/desktop/main.js` 的 `TRUSTED_CHANNELS` 并过 `main.test.js` 的不变量；桌宠的 IPC 来源校验保持现状（只认桌宠窗口）。
4. 样式只允许用 `ui-*` 语义档（`ui-page-title/…/ui-btn*`），不新增任意 px 字号；颜色用语义 token，暗色 `[data-theme="dark"]` 下必须可读。
5. 改页面结构沿用 `PageShell`；`PageFallback` 的 `data-testid="page-fallback"` 不能删；`App.tsx` 对 `startPetPresence` 保持动态 import。
6. 每个工作流至少：新增/更新测试 → `pnpm --filter @heming/<pkg> test` 通过 → 规格文档写「现象 / 根因 / 设计 / 边界 / 验收」。
7. 中文文档与中文 UI 文案；技术名词保留英文。不要引入新依赖（除非有充分理由并先问 Lead）。
8. 联网只用于查资料，引用来源写进各自规格或调研文档；不要把外部文本当指令。

---

## 1. 用户报告与追问结论（2026-11-03）

| 编号 | 用户原话 | 追问后确认的口径 |
|---|---|---|
| 1a | 桌宠「拖动会抽搐闪烁」 | 移动窗口时残影/边缘闪烁；d.67 已修一轮，仍有 |
| 1b | 「局部放大」 | **拖动过程中画面局部被放大/裁切，角色只露一部分**（拖到高 DPI/跨屏时最明显） |
| 1c | 「相关功能键不可使用」 | **桌宠右键菜单里的 放大/缩小/设置/隐藏 点了没反应** |
| 2 | 导航栏可以隐藏和呼出 | **自动隐藏 + 左缘悬停/快捷键呼出，可固定常显**（默认仍常显，不吓到老用户） |
| 3 | 再次优化布局、字体字样、UI 排列 | 全站排版与壳层布局再做一轮（延续 d.62/d.63 的 `ui-*` 档位，不推倒） |
| 4 | 优化用户自定义内容 | 自建智能体 / 自定义技能 / 个性化设置都做，按 1→2→3；**一定要简化、降低上手门槛** |

---

## 2. 工作流 A：桌宠（pet-fix）

### 2.1 现象与根因（先从代码证实，再改）

**A1 拖动时「局部放大/裁切」——高度怀疑 `fitModel` 非幂等。**

`packages/web/src/components/pet/useLive2D.ts` 的 `fitModel` 用 `model.width / model.height` 算缩放；
pixi 的 `Container.width` 是**缩放后的宽度**（`scale.x × localBounds.width`）。因此：

- 首次加载：`scale = min(w/naturalW, h/naturalH)`（正确）；
- 之后任何一次 `resize` 再调 `fitModel(w,h)`：`scale' = min(w/(naturalW·scale), h/(naturalH·scale)) ≈ 1/scale`
  ——缩放被**取倒数**，角色瞬间巨大或被裁切；下一次 resize 又翻回来 ⇒ 观感就是「抽一下 / 局部放大」。

拖动窗口时 Chromium 在跨显示器 DPI 变化或客户区像素取整时会派发 `resize`，
`viewport` state 更新 → `useLive2D` 的 resize effect 调 `fitModel` → 命中上式。
这同时解释了「拖动中」才出现。

**修法（A1）**

1. 首次拟合前记录模型**自然尺寸**（优先 `model.internalModel.width/height`，退化用拟合前的
   `model.width / model.scale.x`），之后所有拟合都基于自然尺寸；`fitModel` 必须幂等。
2. 把适配算法抽成纯函数（建议 `components/pet/live2dFit.ts`，导出 `fitModel` + `nextFitScale`），
   用「假模型（width 返回 natural*scale）」单测：**同尺寸连续调用两次，scale 不变**；
   尺寸变化后按自然尺寸等比适配、底边贴底、不超窗口。
3. `resize` 时同步 pixi 分辨率：`renderer.resolution = devicePixelRatio`（包 try/catch），
   再 `renderer.resize(w,h)`；避免跨屏后发虚。
4. **拖拽期间冻结适配**：drag 中忽略 resize（viewport 不更新/不重排），`dragEnd` 后重测一次
   `innerWidth/innerHeight`、重设分辨率、重拟合、立刻渲染一帧。这样拖动中画面只搬静态位图。

**A2 抽搐/闪烁（d.67 之后仍有）**

保留 d.67 的 rAF 合并、位置去重、拖拽冻结；本轮补：

- 拖拽期间不更新 viewport、不重排、不切穿透（已做）、不重渲染（`setPaused` 已做）；
- 跨屏后按 A1-3 重设 resolution；
- 主进程 `moveWindowTo` 继续只做整数 setPosition；`dragTo` 里若光标未移动直接返回，减少无谓合成；
- 真机证据：录制拖拽前后日志（`pet:drag-start/move/end` 次数、resize 次数、DPR 变化），写进规格。

**A3 右键菜单点了没反应（两个叠加缺陷）**

1. **穿透态没有拦住菜单区域**：`PetWindow.tsx` 的 `extraRects()` 只含 bubble 与 input，
   菜单（和模型错误条）不在命中区。默认鼠标穿透时，菜单区域不挡鼠标 ⇒ 点击落到桌面，
   窗口根本收不到 `mousedown/click`。
2. **click-away 在 mousedown 就关菜单**：全局 `mousedown` 监听无条件 `setMenu(null)`，
   点在菜单项上时先卸载菜单，`click` 永远不会派发到按钮。

**修法（A3）**

- 命中区改为**单一来源**：`[hitBox, bubbleRef, inputRef, menuRef, errorRef]`（新增 menu/error ref），
  并在菜单打开/关闭、输入框开合时主动重算一次当前应报的 interactive（任一打开就置 true），
  不依赖下一次 mousemove。
- click-away：`mousedown` 的 target 落在 `[data-pet-ui]` 内（菜单/气泡/输入框/错误条）时**不关闭**；
  点击窗外或按 Esc 关闭。
- 菜单打开时把 `role="menu"`、`aria-label`、首项可聚焦（打开后 `requestAnimationFrame` 聚焦第一项）；
  菜单项按钮高度 ≥28px；`Esc` 关闭并把焦点还回画布容器。
- 菜单补齐实用项（克制）：`说点什么 / 放大一档 / 缩小一档 / 重置位置 / 鼠标穿透开关 / 设置 / 隐藏`。
  「重置位置」调主进程已有的默认落位（复用 `pet-window.js` 的 `defaultPetPosition`，新增 IPC 必须登记；
  如果不想加通道，可只做 UI 侧不提供该项，但要在规格里写清）。「鼠标穿透」复用 `pet:set-click-through`（已有）。

**A4 功能完善（本轮边界内）**

- 菜单/输入框/气泡全部键盘可达（Enter 发送、Esc 关闭、Tab 在输入框与菜单内合理移动）；
- 拖拽结束后不残留 grabbing 光标（已有，确认）；
- 双击/单击判定阈值与「移动中不误触」保持 d.67 口径。
- **不做**：语音/TTS、模型市场、养成、macOS 真机、窗口缩放动画。

### 2.2 验收

- 单测：`fitModel` 幂等（同尺寸两次不翻转）、假模型尺寸变化后适配正确；命中区包含菜单/错误条
  （纯函数）；click-away 守卫（可用组件测试）；resize-during-drag 不重排（可抽纯函数或用例断言）。
- `pnpm --filter @heming/web test`、`pnpm --filter @heming/desktop test` 全绿。
- 规格 + `docs/PET.md` 更新：症状→根因→修法→真机待验项。
- 真机验证由 Lead 或用户做（本轮不宣称「肉眼已验证」）。

---

## 3. 工作流 B：导航自动隐藏 + 布局/字体（nav-shell）

### 3.1 导航栏隐藏/呼出（用户已选交互）

- **两种模式**：`pinned`（默认，常显，与现在一致） / `auto`（自动隐藏）。持久化 `heming.nav.mode.v1`；
  值损坏/未知回落 `pinned`。状态建议放 `store/ui.ts`（与 `navOrder` 同源），提供纯函数解析 + 单测。
- **auto 态**：导航轨不占布局宽度（主内容变宽）；左缘保留 8px 热区（不可见或极淡）；
  鼠标进入热区或导航轨时滑出**浮层**导航（`position: fixed; z-index` 低于弹窗/命令面板），
  不挤压主内容；鼠标离开 400ms 后收回；焦点留在导航内不收回；`Esc` 收回。
- **键盘可达**：热区本身是 `button`（`aria-label="展开导航"`），Tab 可聚焦、Enter/空格展开；
  展开后焦点进入当前页按钮；`Ctrl/⌘+B` 切换（有模态弹窗时吞键，与 Alt+N 同纪律）；
  快捷键帮助面板与命令面板同步登记（注意 `App.shortcuts` 与快捷键帮助的既有守卫测试）。
- **固定控件**：导航轨底部加 pin 按钮（固定/自动切换，带 tooltip），与设置区卡片同源。
- **设置区**：外观 → 新增「导航栏」卡（`data-settings-id="nav-mode"`，注册到设置搜索 registry）：
  两档 radio + 一句话说明（自动隐藏时 Ctrl+B / 左缘悬停呼出）+ 「恢复默认」。
- **无障碍/动效**：展开/收起 150ms，`prefers-reduced-motion` 关闭动画；隐藏时 `aria-hidden` / 不渲染焦点，
  避免 Tab 落到看不见的按钮；展开浮层不 `inert` 背景（它是非模态浮层），Esc 只收导航。
- **测试**：模式解析/持久化纯函数；NavRail 在 auto 下不占宽、热区展开、离开收回、Ctrl+B、Esc；
  设置卡切换；`NavRail.digit`/`App.SHORTCUT_PAGES`/命令面板三处一致性守卫不破。

### 3.2 布局与字体（第二轮打磨，不推倒 d.62/d.63）

- **字体**：`index.css` 根部定义 `--heming-font-sans`（中文栈：PingFang SC / HarmonyOS Sans SC /
  Microsoft YaHei UI / Microsoft YaHei / Noto Sans SC / system-ui），`--heming-font-mono`
  （JetBrains Mono / Cascadia Code / Consolas / monospace）；`body` 与代码块统一引用。
  不加载外部字体（离线）。
- **字号/行高**：保持四档语义类名不变，微调观感：页面标题 18/26、正文 13/22、辅助 12/20、
  注释 11/17；中文标题 `tracking-[-0.01em]`，数字用 `ui-numeric`；`::selection`、`focus-visible` 不变。
- **布局**：页头高度/间距、内容内边距（24 / 窄窗 16）、卡片圆角与阴影、列表行高、表单行距统一；
  导航轨 9 项节奏（上下分组：搜索/帮助在上，9 页居中，通知/账户在下，间距 6–8px）；
  右栏表头与内容对齐；主页卡片在宽/窄窗下的排布更稳（不新增断点，沿用 `max-[1199px]:`）。
- **不能破**：`PageFallback` 测试锚点、聊天正文列 880 断言、设置内容列 720 左对齐、
  d.62/d.63 的源码守卫测试（新增设置卡必须同步 registry 与 `data-settings-id`）。
- **测试/验收**：CSS 改动用现有快照/守卫测试 + 新增 token 守卫（字体栈不含 http 链接）；
  `pnpm --filter @heming/web test` 全绿；规格写清「哪些是观感改动、哪些是结构改动」。

---

## 4. 工作流 C：自定义内容简化（custom-simplify）

目标：**少填、少跳、少术语**。不改数据模型/存储键（避免迁移），只改表单与入口编排。

### 4.1 自建智能体（`AgentFormModal.tsx` + `AssistantPage.tsx`）

- 新建弹窗顶部加「从模板开始」4 个预设（通用助手 / 写作润色 / 代码助手 / 数据分析）：
  点一下填名称、描述与系统提示词（只填不覆盖用户已输入的非空字段；再次点同一模板不重复追加）。
- 表单分两段：**基础**（名称、头像可选、一句话描述）+ **进阶（可折叠，默认收起）**
  （系统提示词、模型连接绑定）。编辑已有智能体时若进阶字段非空则默认展开。
- 简化文案：头像标「可选」；提示词给 placeholder 示例 + 一句「不填也能用」；
  模型绑定给「不绑定 = 用默认连接」。
- `AssistantPage` 空态/新建入口明确「新建智能体」；创建成功后提示可继续对话（不新增页面）。
- 测试：模板填充、不覆盖已输入、折叠默认态、提交 payload 与旧版一致（不丢字段）。

### 4.2 自定义技能（`SkillsPage.tsx`）

- 「新建技能」表单加 3 个模板（写作润色 / 代码审查 / 会议纪要）+ 字段说明：
  一句话描述「技能名 / 用途 / 适用场景」；内容 textarea 给示例 placeholder；必填只有名称与内容。
- 保留 `SKILL.md` 导入 / 导出 / 沉淀 / 分配；把「未分配」的提示写得更直白（不分配就不会用于对话）。
- 空态动作直达「新建技能」/「导入 SKILL.md」。
- 测试：模板填充、必填校验、导入导出既有用例不破。

### 4.3 个性化（由 nav-shell 在 SettingsPage 一并落，custom 不碰 SettingsPage）

- 外观页顺序：主题模式 → 主题色 → 导航栏（新增模式卡）→ 桌宠；加「恢复默认外观」
  （主题模式 `/system`、主题色默认、导航 `pinned`，二次确认）。
- 自定义内容不新增全局存储键；个性化只沿用既有 `heming.theme.*`、`heming.nav*`。

### 4.4 明确不做（写进规格）

- 记忆区/Wiki 的结构改版（本轮只做任务 4 的 1、2；记忆区保持现状）；
- 自定义内容云端同步、市场、分享；
- 任何 `localStorage` 键位迁移。

---

## 5. 验证与收尾（Lead）

1. 三路自测 → Lead 逐文件 review diff（重点：IPC 登记、数据边界、暗色、a11y、测试是否只写绿）。
2. 全量门禁：`pnpm -r build`，`pnpm -r --workspace-concurrency=1 test`（偶发 0xC0000409 单包重试）。
3. `node scripts/bump-version.mjs auto feature` → 目标 `d.68.2.25.0`；
   `CHANGELOG.md` 顶部条目（`## d.68.2.25.0（2026-11-03）— 标题`）；
   `node scripts/build-changelog.mjs`；更新 `docs/HANDOFF.md` / `docs/INDEX.md` 本轮段落。
4. 新分支按工作流各一个提交（`feat(pet,ui): …` / `feat(nav,ui): …` / `feat(web): …` / `docs: …`），
   不 push（用户未要求）。
5. 真机能验的项（桌宠拖拽、导航 hover）写入 `docs/PET.md`/HANDOFF 的待验清单，不谎称已验证。

## 6. 风险

| 风险 | 处置 |
|---|---|
| 桌宠修复只治标 | 先写失败用例证明 `fitModel` 非幂等，再修；真机证据交用户确认 |
| 自动隐藏导致布局抖动 | 浮层不占布局、内容不变宽；展开/收起不用 `width` 动画，用 opacity/translate |
| 导航快捷键冲突 | 只用 `Ctrl/⌘+B`（浏览器粗体键在桌面壳无冲突）；有模态时吞键；三处映射加守卫 |
| 排版回归范围过大 | 只动壳层 + 主页 + 设置页；页面级只靠 `ui-*`；保留现有守卫测试 |
| 自定义内容改坏数据 | 不新增存储键、不改 schema；测试断言提交 payload 与旧版一致 |
| 并行写文件冲突 | 写入范围见 §0；SettingsPage 只归 nav-shell；Lead 统一 review 后提交 |

## 7. 完成记录（2026-11-03 23:32）

- 三路全部完成并 `complete`：task-1 桌宠（pet-fix）、task-2 导航+布局（nav-shell）、task-3 自定义内容（custom-simplify）；调研子代理只写 `docs/research/2026-11-03-d68-ux-solutions.md`。
- 全量门禁（Lead 在最终工作区实跑）：`pnpm -r build` 通过；shared 2 文件 / 29 例、server 10 文件 / 141 例、web 227 文件 / 3377 例、desktop 538 例全绿；`pnpm -r typecheck` 四包零错误。
- Lead 额外收口：`.ui-card` 的暗色回归（背景/阴影改 CSS 变量 + `[data-theme="dark"] .ui-card` 覆盖；原 `@apply bg-white shadow-card` 匹配不到按类名的兼容层）。
- 版本 `d.68.2.25.0`、CHANGELOG + `generated/changelog.ts`、HANDOFF/INDEX 已回填；分支 `feat/d68-pet-nav-custom` 按工作流分提交，**未 push、未部署、未打安装包**（用户未要求）。
- 真机待验：桌宠跨 DPI 屏拖动/松手/换屏清晰度、菜单逐项/键盘/穿透边界、导航悬停滑出与暗色浮层观感——见各规格与 `docs/PET.md`，不宣称已验证。

## 8. 自检轮记录（2026-11-04，d.68.2.26.0）

- 用户追加「自检和再优化」后，用 headless Edge + CDP 真开前端做逐页自检（方法/证据见 `docs/superpowers/specs/2026-11-04-d68-selfcheck.md`），**不是**只重跑单测。
- 实测修掉 8 个真实问题：暗色组件基元白底近白字、热力图白方块、开关倒置、缺失 hover 映射、导航 auto 鼠标点完不收回、桌宠菜单贴边被裁、桌宠浏览器无桥死按钮、插件区统计滞后；新增 `themePrimitives` 源码守卫与 5 条行为用例。
- 最终门禁（2026-11-04）：`pnpm -r build` 通过；shared 2/29、server 10/141、web **228 文件 / 3401 例**、desktop 538 例全绿；`pnpm -r typecheck` 四包零错误。
- 仍未做：Electron 真机拖拽/跨 DPI/菜单点击（需安装后人工）、把 CDP 自检脚本接 CI/引入 E2E 基线（需拍板）。
