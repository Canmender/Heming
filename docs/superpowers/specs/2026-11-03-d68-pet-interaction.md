# d.68 桌宠交互修复规格（拖动放大/裁切、闪烁、右键菜单不可用）

- 日期：2026-11-03
- 分支：`feat/d68-pet-nav-custom`（基线 = d.67 `19e08fe`）
- 工作流：A（teammate `pet-fix`）
- 相关文件：`packages/web/src/components/pet/*`、`packages/desktop/pet-host.js`、`docs/PET.md`
- 本轮**不宣称「肉眼已验证」**：单测覆盖到逻辑层，真机项见 §6 待验清单。

---

## 1. 现象（用户 2026-11-03 报告 + 追问确认）

| 编号 | 现象 | 追问后口径 |
|---|---|---|
| A1 | 拖动桌宠时画面「局部被放大 / 角色只露一部分」 | 拖动过程中才出现；跨高 DPI 屏最明显；松手后有时又自己恢复 |
| A2 | 拖动时有抽搐 / 闪烁 | d.67 已修过一轮（rAF 合并、位置去重、冻结舞台），仍有残影/边缘闪烁 |
| A3 | 右键菜单「说点什么 / 放大一档 / 缩小一档 / 设置 / 隐藏」点了没反应 | 菜单能弹出，但点菜单项没有任何动作；同窗口的托盘菜单正常 |
| A4 | （本轮顺带）换屏 / 改系统缩放后画面发虚 | 跨显示器拖动后边缘发虚，疑似 backing store 仍按旧 DPR |

---

## 2. 根因（先证实，再修）

### A1：`fitModel` 用「已缩放尺寸」当基准，缩放被取倒数（P0）

证据（d.67 基线 `19e08fe` 的 `packages/web/src/components/pet/useLive2D.ts:104-111`）：

```ts
function fitModel(model: FitTarget, width: number, height: number): void {
  const modelW = model.width || 1; // ← pixi 的 Container.width 已经乘过 scale
  const modelH = model.height || 1;
  const scale = Math.min(width / modelW, height / modelH);
  model.scale.set(scale, scale);
  model.anchor.set(0.5, 1);
  model.position.set(width / 2, height);
}
```

`pixi` 的 `Container.width` 是「局部包围盒 × scale」，不是自然尺寸。设模型自然宽 `L`、窗口宽 `W`：

- 首次：`s0 = W/L`（碰巧正确，初始 scale=1）；
- 第二次同尺寸：`s1 = W/(s0·L) = W/W = **1**` —— 无论窗口多大都跳回 100%，角色瞬间变大并被裁；
- 第三次：`s2 = W/(1·L) = s0` —— 又回来了。

触发条件也吻合：`useLive2D` 的 resize effect 挂在 `width/height`（`innerWidth/innerHeight`）上，
拖动跨屏 / DPI 变化 / 客户区像素取整都会派发一次 `resize`，于是缩放就在「正确值 ↔ 1.0」之间来回跳。
这就是「拖一下放大一下、再拖一下又正常」的直接成因。

对照用例（`live2dFit.test.ts`「旧实现对照」）把旧算法原样搬进测试：
同尺寸连续调用两次得到 `0.2625 → 1`，第三次回到 `0.2625`；新实现三次都稳定在 `0.2625`。
**先红后绿**：该分支文件在实现前运行会因模块缺失失败（已留档于本轮过程），实现后 15 条用例全绿。

### A2：拖动时的透明层逐帧重合成（P1，d.67 已缓解，本轮补两块）

d.67 已做：rAF 合并 IPC、主进程位置去重、拖拽期间 `setPaused(true)`（同时停 `app.ticker` 与
`model.autoUpdate`）、三条退出路径统一收尾。本轮补：

1. **拖动期间不再重排**：A1 的触发条件是「resize 在拖拽中真的执行了适配」。即使 A1 已修，
   拖动中改尺寸/重拟合仍会让画面在移动中跳变（一次 resize 一次重绘），所以拖拽期间直接忽略 resize。
2. **主进程少做无谓合成**：`dragTo` 在「光标没动」时连 `getBounds()` 都不做；位置没变时依旧不 `setPosition`。

### A3：菜单点不动 = 两个缺陷叠加（P0）

证据：

1. **命中区漏了菜单/错误条**（d.67 `PetWindow.tsx:270`）：
   `return [toRect(bubbleRef.current), toRect(inputRef.current)];`
   桌宠默认鼠标穿透（`clickThrough: true`）。穿透态下主进程只在「渲染层上报可交互」时拦截鼠标；
   菜单区域不在命中区 ⇒ 菜单上方的点击落到桌面，窗口收不到 `mousedown/click`。
2. **click-away 在 mousedown 阶段就卸载菜单**（d.67 `PetWindow.tsx:471`）：
   `const onClickAway = () => setMenu(null);` 全局无条件执行。
   点在菜单项上时先触发了 `mousedown` → 菜单被卸载 → `click` 永远派发不到按钮。

两个缺陷任一个都足以让菜单「点了没反应」，叠加后表现为「菜单能弹出，但点哪都没用」。
托盘菜单不受影响，因为托盘是主进程原生菜单，不走渲染层命中区。

### A4：`renderer.resolution` 只在建 app 时取一次（P1 → 本轮补）

`autoDensity` 只负责 canvas 的 CSS 尺寸，backing store 的像素倍数由 `resolution` 决定。
跨屏 DPI 变化后只 `resize` 不更新 `resolution`，画面就按旧 DPR 取样 ⇒ 发虚/边缘锯齿。
另外主进程此前没有监听 `screen` 的显示器事件，窗口 DIP 尺寸在换屏/改缩放后不会主动对齐档位。

---

## 3. 修法与设计

### 3.1 `live2dFit.ts`：把适配算法抽成纯函数，永远基于自然尺寸

新文件 `packages/web/src/components/pet/live2dFit.ts`：

| 导出 | 作用 |
|---|---|
| `readNaturalSize(model)` | 自然尺寸：优先 `internalModel.width/height`；退化用「`model.width / model.scale.x`」反推 |
| `fitViewport(natural, viewport)` | 纯计算 `{ scale, x, y }`：等比 `min(w/nW, h/nH)`，水平居中、底边贴底 |
| `nextFitScale(model, w, h)` | 只算不写（诊断/测试用） |
| `fitModel(model, w, h)` | 应用适配；入参非法时返回 `null` 且**不改动模型**，绝不写 NaN 变换 |

要点：

- **基准是自然尺寸，不是当前尺寸**：`readNaturalSize` 里除以当前 scale 就是修复的核心一步；
  两次同尺寸调用读出的自然尺寸相同 ⇒ 缩放相同 ⇒ 幂等。
- 为什么优先 `internalModel.width/height`：它是 Cubism 内部模型的画布尺寸，与 `model.scale` 无关
  （pixi-live2d-display 文档称其为 "scaled by the layout"，即内部 layout，不随窗口 resize 变化）。
  没有该字段时退化为「当前尺寸 ÷ 当前缩放」，同样稳定。
- 不采用 `internalModel.originalWidth` 当基准：pixi-live2d-display 文档明确它「不代表模型真实尺寸，
  模型可以溢出 canvas」，拿它做"装进窗口"的基准会偏小/偏移（见 `docs/research/2026-11-03-d68-ux-solutions.md` §1.3 缺口 1）。
- 抽成纯函数的收益：单测用一个「`width = natural × scale`」的假模型就能证明幂等，不需要起 pixi。

### 3.2 `useLive2D`：resize 时同步 DPR，并提供 `resizeTo`

- `stageRef.current.resize(w,h)` 顺序：**先同步 `renderer.resolution = devicePixelRatio`（try/catch）**，
  再 `renderer.resize(w,h)`，再 `fitModel`，再按**当前** w/h 重算命中区，最后 `app.render()` 立即出一帧。
  - `try/catch`：个别渲染后端不允许运行中改分辨率，此时退化为只 resize（尺寸仍正确）。
  - 命中区以前用初始 `width/height` 闭包值夹取，resize 后会夹错；改为传入当前视口。
- 新增 `Live2DStage.resizeTo(w,h)`（稳定引用）：props 尺寸变化的 effect 与「拖拽结束补测」共用同一条路径。
- `setPaused` 逻辑保持不变（两条时钟都停、恢复补一帧）。

### 3.3 `PetWindow`：拖拽期间冻结 viewport，dragEnd 一次性补测

- 拖拽中收到 `resize`：直接 **return**（不 `setViewport`）。
  拖拽中画面只搬静态位图，尺寸/DPI 变化攒到落点。
- `finishDrag`（三条退出路径共用）顺序：
  `flush 移动终值 → dragEnd IPC → 清 dragging → 重测 innerWidth/innerHeight → setViewport（变了才写）
  → resizeTo(重设分辨率+重拟合+渲染一帧) → setPaused(false) → 焦点 → 穿透判定`。
- `blur` 路径同样补测（拖拽中被 Alt+Tab 打断也会有尺寸变化）。

### 3.4 命中区单一来源 + click-away 守卫

- `extraRects()` 现在是 `[bubble, input, **menu**, **error**]`（新增 `menuRef` / `errorRef`）。
- 新纯函数 `petInteraction.resolveInteractive(hitBox, uiRects, x, y, floatingOpen)`：
  - **浮层（菜单/输入框）打开 ⇒ 直接 true**（整窗拦截）。理由：菜单刚弹出时鼠标可能不在任何矩形上，
    或从菜单移向桌面时先收到 `mouseleave`；只要有一帧判成"不拦截"，穿透就会把菜单点穿。
  - 否则按坐标判：角色 ∪ 气泡 ∪ 输入框 ∪ 菜单 ∪ 错误条。空白处仍穿透（不挡桌面点击）。
- 浮层开合时**主动重算并上报** `pet:set-interactive`（不等下一次 mousemove）；用最近一次已知光标位置，
  还没收到过 mousemove 时只有浮层能触发 true。
- click-away：`mousedown` 的 target 在 `[data-pet-ui]` 内则**不关**菜单；点窗外才关。
- `mouseleave` 在浮层打开时不清理穿透上报（否则菜单会在鼠标移出窗口后失去拦截）。

### 3.5 菜单键盘可达 + 能力项

- 菜单 `role="menu"` + `aria-label="桌宠菜单"`；菜单项 `role="menuitem"`、`minHeight: 28px`；
  打开后 `requestAnimationFrame` 聚焦第一项；`ArrowUp/ArrowDown/Home/End` 在项间移动；
  `Enter/空格` 由原生 `button` 触发 click；`Esc` 关闭菜单并把焦点还给根容器（`tabIndex={-1}`）。
- 菜单项（克制，7 项）：`说点什么 / 放大一档 / 缩小一档 / 重置位置 / 鼠标穿透（已开·已关）/ 设置 / 隐藏`。
  - **重置位置**：复用主进程 `defaultPetPosition(primaryArea(), petWindowSize(scale))`；
    渲染层调 `window.__heming_pet.resetPosition()`。旧 preload 没暴露该方法时**不渲染**这一项
    （能力探测 `typeof … === "function"`，避免出现「点了没反应」的死按钮）。
  - **鼠标穿透**：复用既有 `pet:set-click-through`；打开菜单时用 `state().clickThrough` 显示开/关，
    点击切换。状态没读到时点击会先重读一次再取反，不会把「未知」当成「关」写反。
- 点击菜单项统一走 `chooseMenu(action)`：先关菜单再执行动作，避免动作里的 `focus()` 被菜单卸载打断。

### 3.6 主进程（`pet-host.js`）

- `dragTo()`：光标位置与上一次相同 ⇒ 直接返回（不做 `getBounds`/`setPosition`）。
  收尾终值由 `endDrag` 按当前光标重算，跳过中间帧不丢位移。
- `resetPosition()`：默认落位（右下角，边距 24）+ `moveWindowTo`（位置没变也 no-op）+ **立即落盘**
  （语义是「把当前位置变成期望值」，不走 400ms 防抖）。`pet:reset-position` 只接受桌宠窗口来源。
- 显示器事件：`start()` 里注册 `display-metrics-changed` / `display-added` / `display-removed`；
  回调里若窗口 DIP 尺寸 ≠ `petWindowSize(state.scale)`，按**保持右下角不动**重设（与 `setScale` 同口径）；
  拖拽中跳过；`destroy()` 里 `removeListener` 解绑。`screen` 没有 `on`（纯 Node 测试）时 fail-soft 跳过。

---

## 4. 边界与约束

- **不新增持久化键**：桌宠状态仍在 `userData/pet-state.json` 与 `localStorage: heming.pet.v1`；
  菜单「重置位置」「鼠标穿透」都直接改主进程已有状态（无新键、无迁移）。
- **IPC 面**：只新增 `pet:reset-position` 一条，`pet:` 前缀通道由 `pet-host.js` 自校验来源
  （`main.test.js` 的 IPC 不变量对 `pet:` 前缀白名单放行，无需改 `TRUSTED_CHANNELS`）。
  preload 暴露与类型声明由 Lead 统一接线（本轮已接线：`preload.js` / `types/heming.d.ts`）。
- **数据边界不变**：桌宠不写会话、不落 msgCache；菜单/键盘操作不产生任何对话数据。
- **不做**：语音/TTS、模型市场、养成、macOS 真机、窗口缩放动画（与计划 §2.1 A4 一致）。
- 样式只用内联既有色值/尺寸，未引入新依赖、未改 `index.css`。

---

## 5. 测试清单（本轮新增/扩展）

| 文件 | 覆盖点 |
|---|---|
| `packages/web/src/components/pet/live2dFit.test.ts` | 自然尺寸两条来源；等比/贴底/居中；**同尺寸重复拟合幂等**；连续 5 次稳定；尺寸变化按自然尺寸适配；非法尺寸不写 NaN；`nextFitScale` 不改模型；**旧实现对照证明会翻转到 scale=1** |
| `packages/web/src/components/pet/petInteraction.test.ts` | 新增 `resolveInteractive`：命中区包含菜单/错误条；空白处不拦截；浮层打开整窗拦截；无命中区时只有浮层触发 |
| `packages/web/src/components/pet/PetWindow.menu.test.tsx`（新） | 菜单打开立即上报可交互、点窗外关闭并恢复穿透；`role=menu/menuitem` 与 ≥28px；**菜单项 mousedown 不关菜单、click 能派发**；说点什么聚焦输入框；设置/隐藏调用桥；打开聚焦首项 + 方向键/Home/End；Esc 关闭并还焦点给画布容器；穿透项显示状态并切换；重置位置出现/调用；旧 preload 无 `resetPosition` 时不渲染该项 |
| `packages/web/src/components/pet/PetWindow.drag.test.tsx` | 拖拽中 resize 被忽略（viewport 冻结）；dragEnd 后按真实尺寸 `resizeTo`；非拖拽 resize 照常同步；既有 rAF 合并/冻结/tap 后不残留用例保持绿 |
| `packages/desktop/pet-host.test.js` | 光标没动直接返回（不 `setPosition`，也不被外部挪动带走）；重置位置到默认落位并落盘；非桌宠来源被忽略；已在默认位 no-op；显示器变化按档位重算并保持右下角；拖拽中不重算；尺寸已一致不重复 `setBounds`；`destroy` 解绑显示器监听；既有吸附/钳制/终值用例保持绿 |

门禁结果见交付报告（`pnpm --filter @heming/web test`、`pnpm --filter @heming/desktop test`、
`pnpm --filter @heming/web typecheck`）。

---

## 6. 真机待验项（本轮**未**肉眼验证，交 Lead/用户）

1. **拖动时不再出现局部放大/裁切**：跨 100%/150% DPI 两块屏来回拖，观察角色是否始终完整、底边贴底。
2. **拖动中画面静止、松手立即恢复**：松手后应当看到呼吸/眨眼恢复，且尺寸/清晰度正确（不是停旧帧）。
3. **换屏后不发虚**：拖到另一块屏后边缘是否清晰（`renderer.resolution` 是否真的跟随 DPR）。
4. **右键菜单每一项都生效**：说点什么（弹输入框并聚焦）、放大/缩小（窗口尺寸变、右下角不动）、
   重置位置（回右下角）、鼠标穿透（再点右键菜单看开/关状态是否翻转）、设置、隐藏。
5. **键盘可达**：右键 → 方向键移动 → Enter 触发；Esc 关闭后焦点回到画布（再按方向键不应卡在菜单）。
6. **穿透边界**：默认穿透下，菜单间隙/空白处点击应落到桌面；菜单区域内点击必须被窗口接住。
7. **显示器事件**：拖动窗口到另一块屏 / 改系统缩放，窗户外框尺寸是否仍等于当前档位（不应出现"半像素"模糊）。
8. 失败时优先看：`pet:set-interactive` 上报序列、`pet:drag-*` 调用次数、`display-metrics-changed` 是否触发。

> 真机证据（日志/录屏）请在讨论里补充；本文档不写「已验证」。

---

## 7. 依据与来源

- 本仓调研：`docs/research/2026-11-03-d68-ux-solutions.md`
  - §1.2 透明窗 layered window 与 `setPosition` 的合成代价；
  - §1.3 缺口 1（`fitModel` 基准错误、缩放翻转的推导）与缺口 2（`renderer.resolution` 只在建 app 时取一次）；
  - 该文档对「live2dFit 修复 + resize 时同步 resolution」给出交叉验证结论，与本轮实现一致。
- pixi 容器尺寸语义与 `resolution`/`autoDensity`/`resize()`：
  [PIXI.AbstractRenderer (v6.5 docs)](https://pixijs.download/v6.5.10/docs/PIXI.AbstractRenderer.html)
- `InternalModel.width/height` / `originalWidth` 的语义：
  [pixi-live2d-display InternalModel API](https://guansss.github.io/pixi-live2d-display/api/classes/index.InternalModel.html)
- 跨显示器 DPI、`getCursorScreenPoint()` 返回 DIP、`display-metrics-changed` 的 `changedMetrics`：
  [screen (Electron Docs)](https://www.electronjs.org/docs/latest/api/screen)
- 程序化 `setPosition/setBounds` 不触发 `will-move`（节流责任在应用侧）：
  [BrowserWindow (Electron Docs)](https://www.electronjs.org/docs/latest/api/browser-window)
- DPR 变化可用 `(resolution: Xdppx)` 媒体查询侦测：
  [Window: devicePixelRatio (MDN)](https://developer.mozilla.org/en-US/docs/Web/API/Window/devicePixelRatio)

---

## 8. 已知限制 / 后续

- 菜单键盘导航目前覆盖「方向键 / Home / End / Enter / Esc」；`Tab` 未在菜单内做 roving focus
  （原生按钮 Tab 会离开菜单，菜单不自动关闭——真机项 5 一并确认是否可接受）。
- `resetPosition` 在旧 preload（未接线）下菜单项隐藏；若未来要做「拖丢了自动找回」，
  可在 `endDrag` 的钳制里复用 `defaultPetPosition`。
- 显示器事件只做尺寸对齐；多显示器间 workArea 变化的吸附策略仍按 `settlePetPosition` 的既有口径。
- 拖拽期间 `renderer.resolution` 未做「临时降 DPR」优化（调研 §1.4 建议项，本轮不做，避免在移动中改分辨率）。
