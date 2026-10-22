# 弹窗屏蔽背景 + 焦点归还 + 工作区首帧状态（d.26.1.7.0）

日期：2026-10-22
状态：已实现
相关：`docs/superpowers/specs/2026-10-21-*.md`（弹窗骨架 `useModalA11y` 那一轮的 §2）、`docs/HANDOFF.md` §5

## 1. 问题

上一轮把弹窗骨架统一成了 `useModalA11y`（Esc 栈顶独占、Tab 循环、打开落焦），但骨架只做了一半：

1. **背景没屏蔽**。弹窗打开时，背后的侧栏、会话列表、导航仍然可点可 Tab——鼠标能点进背景，Tab 从弹窗里按出去就落到背景元素上，读屏也把整个页面当成本轮内容。`App.tsx:130` 早就给启动动画做过 `inert`，说明这条路在本仓是通的，只是没人把它接到弹窗上。
2. **关闭后焦点不归还**。弹窗卸载后焦点掉到 `<body>`，用户 Tab 一下要从页面最开头重新走。键盘用户的直觉是「Esc 关掉，回到我按的那个按钮」。
3. **`loadWorkspace` 的加载态与失败态没上屏**。首帧三路请求（会话、好友、入站申请）在飞的时候 `conversations=[]`，HomePage 就渲染「暂无会话，从工作区开始」；请求失败也一样，只是多一条 `console.warn`。**「正在加载」和「加载失败」都伪装成了「你还没有数据」**，用户不知道该等、该重试，还是该去建会话。

## 2. 决策

### 2.1 屏蔽背景：兄弟屏蔽，不是 shell 屏蔽

**本仓弹窗没有 portal**（全仓 `createPortal` 零命中），弹窗就渲染在页面组件的子树里。直接 `inert` 最外层 shell 会把弹窗自己也屏蔽掉——点不动、读屏也读不到，等于把界面锁死。

所以从弹窗往上走，**每一层只屏蔽「不在通往 panel 那条链上」的兄弟元素**：

- 祖先链上的元素一律不碰：遮罩（`fixed inset-0`）是 panel 的祖先，点遮罩关闭的口径不受影响；
- 其余兄弟逐个 `toggleAttribute("inert", true)`；
- 走到 `document.body` 为止（body 的兄弟是 `<head>`，不属于背景）。

**起点是「遮罩根」而不是 panel**：从 panel 往上连续找带 `fixed` 类名的祖先，取最外面那个。因为技能详情抽屉（`SkillsPage.tsx:169`）的关闭遮罩是 panel 的**兄弟**（`absolute inset-0` 的 button）而不是父级，从 panel 起屏蔽会把这个遮罩按钮一起 inert 掉——点遮罩就关不上抽屉了。用类名判定而不是 `getComputedStyle`：jsdom 不加载 Tailwind，算出来的 `position` 恒为 `static`。

**只挂 `inert`，不补 `aria-hidden`**：inert 子树本身就不进可访问性树，重复挂一遍是噪音；而 `aria-hidden` 在 jsdom 里是真生效的（testing-library 的 `byRole` 直接查不到背景元素），会把一堆与本特性无关的用例拖进改动面。

**嵌套用引用计数，不用各自记原值**。React 先跑子 effect 再跑父 effect，所以嵌套弹窗是**内层先屏蔽**。如果每个 hook 各自记住「动之前的值」再还原：内层关闭会把外层还需要的屏蔽一起解除（外层当初记下的「原值」已经是内层设上的 `inert`），外层再还原就变成永久锁死。改成模块级 `Map<Element, {count, inert}>`：0→1 时记下原值并屏蔽，计数归零时才写回原值。

**逃生门 `data-a11y-keep`**：通话面板（`VoiceCallPanel.tsx`）是常驻全屏浮层，HITL 确认框压在它上面时也必须能点挂断/静音——屏蔽它等于把用户锁在通话里。带这个属性的兄弟跳过。

**非模态浮层退出**：通知中心是 `aria-modal="false"` 的浮层，靠「点面板外关闭」收拢；背景被 inert 后 pointerdown 落不到背景上，浮层就关不掉了。给它传 `blockBackground: false`。

### 2.2 焦点归还：只在焦点确实无处可去时还

激活时记录 `document.activeElement`（不在 panel 内才算触发元素），关闭时**满足「焦点已丢失」才归还**：`activeElement` 是 `document.body`、为 null、或已经不在文档里。

条件不是多余的：关闭方经常自己安排焦点（跳会话、接着开下一个弹窗、把焦点移到列表下一项），无条件归还会抢掉刚放好的焦点。触发元素自己被卸载（列表项删掉了）也不归还——`isConnected` 已假，硬 focus 只会静默失败并迷惑后来的排查者。

实现上这段必须**声明在聚焦 effect 之前**：effect 按声明顺序执行，晚一步记录到的「触发元素」就已经是弹窗里的按钮了。

### 2.3 工作区首帧状态：ready 与 error，不管后台刷新

store 加两个字段而不是一个三态枚举：

- `workspaceReady: boolean`：首帧成功过没有。
- `workspaceError: string | null`：首帧失败原因（错误原文，供重试条直接显示）。

`loadWorkspace` 只在 `!workspaceReady` 时动这两个字段，成功后一次性写 `ready:true, error:null`。**后台刷新失败不推翻已就绪**——WS 事件、建会话后都会再调 `loadWorkspace`，为一次后台失败把整页打回重试态是倒退，旧列表继续可用比「页面塌了」好。rejection 原样抛回：调用方原本就在 catch（`HomePage.tsx:118`、`RadarContacts.tsx:265`），语义不变。

UI：`recent.length===0` / `incoming.length===0` 时先看 `workspaceReady`——未就绪渲染 `WorkspaceFallback`（骨架条，`role="status"`；失败则「加载失败：原因」+ 重试按钮），就绪才渲染原来的「暂无会话 / 没有待处理申请」。

**智能体动态那一栏不改**：它的数据来自 `loadAgentsRoster`，不是 `loadWorkspace`，用 `workspaceReady` 给它判加载态是另一套口径，留给名册自己的状态。

## 3. 明确不做

- **不做 portal 改造**。把弹窗统一挂到 `body` 能让屏蔽简单一层，但要动 10 个调用点的挂载位置、z-index 与祖先样式继承，收益不抵风险；兄弟屏蔽已经覆盖同样的语义。
- **不做读屏实测**。`inert` 与焦点归还的行为在 jsdom 里只能断言属性与 `activeElement`，真实 NVDA/VoiceOver 表现未验证——这条留在 HANDOFF §5 作为验证项，不是实现项。
- **不加焦点环样式**。归还后的可见焦点依赖既有的 `focus-visible` 样式。
- **不动全局快捷键**。弹窗打开时 `Alt+1–8`、`Ctrl+\` 仍然生效（监听挂在 `window` 上，`inert` 不影响 JS 事件）。这与本特性正交，另议。

## 4. 测试清单

`useModalA11y.test.tsx`（新增 6 例）：

1. 打开时屏蔽背景兄弟、卸载后解除；弹窗自己不带 `inert`。
2. 内层卸载不会解除外层仍在生效的背景屏蔽（引用计数）。
3. 遮罩根以内的兄弟不屏蔽（抽屉那种点遮罩关闭仍可用）。
4. `data-a11y-keep` 的常驻浮层不屏蔽。
5. `blockBackground:false` 时不动背景。
6. 关闭后焦点还给触发元素；关闭方已主动移走焦点时不抢。

`store/chat.test.ts`（新增 2 例）：首帧失败写 `workspaceError` 且 rejection 交回调用方；成功后 `ready`、清空错误，后台刷新再失败不推翻已就绪。

`HomePage.test.tsx`（新增 2 例）：首帧未落地显示加载骨架而非「暂无会话」；首帧失败显示重试条，重试成功后回到正常空态。
