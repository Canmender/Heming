# d.68 体验方案调研（2026-11-03）

> **外部资料，仅作参考。** 本文所有结论来自公开网页（官方文档 / 标准 / 权威机构文章），不是本仓实测数据；
> 凡标注 **【未核实】** 的条目，表示没有找到可引用的公开来源，只是基于相邻事实的推断，落地前需自行验证。
> 每条结论都附来源链接；产品文案不复述，只提炼机制。

**调研范围**：四个体验问题 ——
(1) 透明置顶窗拖动时的残影/闪烁/画面放大裁切；(2) 导航栏自动隐藏 + 边缘悬停 + 可固定；
(3) 中文高信息密度界面的字体与排版；(4) 自定义内容（自建智能体、自定义技能）的低门槛创建流程。

**检索限制**：本机网络策略拦截 `github.com` 与 `raw.githubusercontent.com`（解析到非公网地址），
因此 Electron / pixi 的 issue 讨论与源码改用官方文档站、W3C 标准、微软 Learn、NN/g 等替代来源。
凡是只能靠 GitHub issue 佐证的细节，本文一律降级为【未核实】而不是硬编。

**本仓基线（读代码得到的现状，用于对齐建议，不含改动）**：

| 位置 | 现状 |
| --- | --- |
| `packages/desktop/pet-window.js` | `frame:false, transparent:true, resizable:false, hasShadow:false, alwaysOnTop:true`，主进程按 `screen.getCursorScreenPoint()` 算位移 |
| `packages/web/src/components/pet/PetWindow.tsx` | 拖拽用 `createFrameCoalescer` 做 rAF 合并（每帧最多一次 IPC），拖拽期间 `setPaused(true)` 冻结舞台 |
| `packages/web/src/components/pet/useLive2D.ts` | `fitModel()` 用 `model.width/height` 等比缩放；`resolution: devicePixelRatio` 只在建 app 时取一次 |
| `packages/web/src/components/NavRail.tsx` | 54px 常驻图标轨 + 悬停胶囊提示 + Alt+数字 快捷键；无自动隐藏、无固定 |
| `packages/web/src/index.css` | Tailwind v4 `@import` + `@config`，`--line/--ink/--muted/--panel` 等 CSS 变量双主题；`body` 未声明 `font-family` |

---

## 0. 摘要（四条最关键结论）

1. **拖动残影不是"渲染太慢"，而是"窗口位置与画布内容在同一次合成里竞争"**：透明窗在 Windows 上按
   layered window 处理，系统会缓存整窗位图、并在相对移动时不再请求重绘；一旦你在移动的同时还在改画布内容
   （Live2D 逐帧重绘、分辨率变化、尺寸变化），每帧都要重算整张带 alpha 的位图，观感就是残影 + 边缘闪。
   本仓已做对两件事（rAF 合并 IPC、拖动期间冻结 ticker），**真正没做对的是"缩放基准"与"DPR 同步"**——
   这两条恰好能解释"画面局部放大/裁切"。
2. **导航栏自动隐藏的成熟解不是"贴边就弹"，而是"贴边只做唤醒，进入后给 120ms 宽限期，离开给 300ms 缓冲，且展开层浮在内容之上"**。
   VS Code 干脆不做边缘悬停（`Ctrl+B` + Zen Mode），Notion 用折叠按钮 + `Ctrl/Cmd+\`。屏幕物理边缘可以窄触发（2–4px），
   窗口内边缘必须宽（8–12px），否则误触率高一个数量级。
3. **中文界面的字体栈必须是"拉丁在前、CJK 在后"**：`Segoe UI` 在前保证英文数字字形正确，`Microsoft YaHei UI` 在后兜底汉字；
   反过来把中文字体放前面，英文会变宽变丑。字号不必追 14/16px 的网页惯例——本仓 13px/22px 对中文桌面端是合理的，
   真正要补的是**字体栈、`tabular-nums` 的使用边界、以及两处不达标的占位符对比度**。
4. **低门槛创建的关键不是"字段少"，而是"先给一个能跑的东西，再让用户改"**：模板预填 + 渐进披露（首屏只露 1 个必填）
   + 空态即引导。NN/g 的两条硬约束值得抄进验收标准：初始层必须覆盖高频需求、且"怎么进下一层"必须一眼可见。

---

## 1. 透明 / 置顶 / 无边框窗口：拖动残影、闪烁与"画面局部放大/裁切"

### 1.1 结论

| 现象 | 主因 | 处置优先级 |
| --- | --- | --- |
| 拖动时人物周围出现拖影、边缘锯齿闪 | 移动窗口的同时画布仍在逐帧重绘，带 alpha 的整窗位图每帧重算 | P1（本仓已缓解，见 1.3） |
| 拖动时"卡一下再追上光标" | 每次 `mousemove` 都发 IPC + `setPosition`，主进程消息队列积压 | P0（本仓已修，勿回退） |
| 画面突然变大 / 底部被裁掉一截 | `fitModel()` 用**已缩放**的 `model.width` 当基准，缩放值在每次 resize 间来回跳 | **P0（本仓现存 bug）** |
| 换到另一块屏后变糊、边缘发虚 | `renderer.resolution` 建 app 时固定，DPR 变化后没同步 | **P0（本仓现存缺口）** |
| 换屏瞬间窗口内容尺寸不对 | 只监听 `window.resize`，没监听 `display-metrics-changed` / DPR 变化 | P1 |
| 松手后画面停在旧帧 | 恢复时未补渲染一帧 | 已修（`setPaused(false)` 内 `app.render()`） |

一句话：**先修缩放基准与 DPR（能直接消掉"放大/裁切"），再谈合成优化。**

### 1.2 机理：为什么透明窗拖动比普通窗更容易花

**(a) 透明窗走的是 layered window 路径。** 微软对 layered window 的描述是：系统会"存储窗口的图像"，
当窗口因为桌面上其它窗口的相对移动而露出时，**系统不会再要求窗口重绘**；并且"为了动画或逐像素 alpha，
应改用 `UpdateLayeredWindow`，它能同时改位置与尺寸，是动画窗口最高效的方式"。
来源：[Window Features – Layered Windows (Microsoft Learn)](https://learn.microsoft.com/en-us/windows/win32/winmsg/window-features)。

这条对 Electron 的含义（**【未核实】** Electron/Chromium 在 Windows 上具体用
`SetLayeredWindowAttributes` 还是 `UpdateLayeredWindow`，官方文档未明写）：透明窗的"移动"本可以很便宜
——只要内容不变，搬位图即可。**一旦内容在变（动画、resize、分辨率切换），每帧都退化成"重新合成整张带 alpha 的位图"**，
这就是残影与边缘闪烁的来源。

**(b) `setPosition` 是跨进程的窗口操作，不是 CSS 变换。** 它触发一次真实的窗口位置变更；
Electron 文档明确 `will-move` 事件"只在用户手动移动时发出，用 `setPosition`/`setBounds`/`center` 移动不会发出"，
也就是说**程序化移动既不受 `will-move` 约束、也不会自动被合并**，节流责任完全在应用侧。
来源：[BrowserWindow (Electron Docs)](https://www.electronjs.org/docs/latest/api/browser-window)。

**(c) `app-region: drag` 是另一条完全不同的路径。** 官方说明：可拖拽区域**忽略所有指针事件**
（区域内按钮收不到 click / enter / exit），要恢复交互必须显式 `no-drag`；右键还可能弹出系统菜单
（因为该区域被当成非客户区）；并提供了实验性调试开关 `ELECTRON_DEBUG_DRAGGABLE_REGIONS` 来"画出拖拽区并记录它们变化多频繁、代价多大"。
来源：[Custom Window Interactions (Electron Docs)](https://www.electronjs.org/docs/latest/tutorial/custom-window-interactions)。

由"忽略指针事件 + 被当作非客户区"可推出（**【未核实】** 具体实现细节）：原生拖动会进入系统的模态移动循环，
期间页面的 `mousemove`/rAF 基本停摆。对桌宠这类"要跟随、要吸附、要限制在屏内"的场景，
**原生拖动拿不到逐帧位置，做不了软吸附**——这是本仓选自定义拖动的正当理由，不是历史包袱。

**(d) 跨显示器 DPI：三套坐标不能混用。** Electron `screen` 文档写明：
`getCursorScreenPoint()` **返回 DIP 点，不是物理像素**；Windows/Linux 另有
`screenToDipPoint` / `dipToScreenPoint` / `screenToDipRect` / `dipToScreenRect` 做换算；
`display-metrics-changed` 事件会带 `changedMetrics`，取值含 `bounds`、`workArea`、`scaleFactor`、`rotation`。
来源：[screen (Electron Docs)](https://www.electronjs.org/docs/latest/api/screen)。

同时，渲染侧的 DPR 变化官方推荐的侦测方式是**重建一条 `(resolution: Xdppx)` 媒体查询**并监听其 `change`
（MDN 明确举例"用户把窗口拖到另一块像素密度不同的显示器"）。
来源：[Window: devicePixelRatio (MDN)](https://developer.mozilla.org/en-US/docs/Web/API/Window/devicePixelRatio)。

**结论**：位移计算全程留在 DIP；画布分辨率单独跟 `devicePixelRatio` 走。两者混用就会在换屏时出现
"尺寸对不上、底部被裁、画面发虚"。

### 1.3 本仓现状与四个缺口（按代码推断，需实测确认）

**已做对（不要在重构中丢掉）**

1. `PetWindow.tsx` 的 `createFrameCoalescer`：同一帧内任意多次 `mousemove` 只发一次 IPC，`mouseup` 时 `flush()` 补终值。
2. 拖动开始 `setPaused(true)`：同时停 `app.ticker` 与 `model.autoUpdate`（两条独立时钟都停，避免恢复时 delta 累积导致动作跳一下），
   恢复时 `app.render()` 补一帧。
3. 三条退出路径（正常 `mouseup` / 拖拽中丢 `mouseup` / 窗口 `blur`）统一走 `finishDrag`，不留半截状态。

**缺口 1（P0，直接造成"画面局部放大/裁切"）：`fitModel()` 的缩放基准是"已缩放"的尺寸**

现状：

```ts
// useLive2D.ts
function fitModel(model: FitTarget, width: number, height: number): void {
  const modelW = model.width || 1;   // ← 这个 width 已经乘过 scale
  const modelH = model.height || 1;
  const scale = Math.min(width / modelW, height / modelH);
  model.scale.set(scale, scale);
  ...
}
```

pixi 容器的 `width`/`height` 是**缩放后的**尺寸（`pixi-live2d-display` 的 `InternalModel.width/height` 文档也写明是
"canvas width of the model, **scaled by the layout**"）；而 `originalWidth/originalHeight` 才是"原始 canvas 尺寸"。
来源：[InternalModel API (pixi-live2d-display v0.4.0)](https://guansss.github.io/pixi-live2d-display/api/classes/index.InternalModel.html)。

于是 `fitModel` 求出的 `scale` 实际是 **`(目标宽 / 当前已缩放宽)`**，是个"比例"而不是"绝对缩放"。设模型原始宽 `L`、
首次适配后 `s0 = W0/L`；窗口尺寸不变再调一次：

```
s1 = W0 / (s0 · L) = W0 / W0 = 1     → 模型跳回 100% 原始尺寸（视觉上"突然放大"，超出窗口即被裁）
s2 = W0 / (1 · L)  = W0 / L = s0     → 又回到正确值
```

也就是说：**每触发一次 `resize` 分支，缩放就在"正确值"与"1.0"之间来回跳**。
而 `useLive2D` 里恰好有 `useEffect(() => { stageRef.current.resize?.(width, height) }, [width, height])`，
`width/height` 来自 `window.innerWidth/innerHeight` —— 拖动跨屏、DPI 变化、甚至窗口被系统微调，
都会让这对值抖一次。用户看到的就是"拖一下放大一下、再拖一下又正常"，并伴随底部/侧边被裁。
这与"局部放大/裁切"的描述完全吻合，建议列为本次首要修复。

**正确做法**：缩放基准只在 `scale = 1` 时量一次并缓存，之后永远用缓存值。

```ts
// useLive2D.ts —— 建模型后量一次基准
model.scale.set(1, 1);
const base = { w: model.width || 1, h: model.height || 1 };

const fit = (w: number, h: number) => {
  const s = Math.min(w / base.w, h / base.h);
  model.scale.set(s, s);
  model.anchor.set(0.5, 1);
  model.position.set(w / 2, h);
};
```

要点：
- **不要**用 `model.internalModel.originalWidth` 当基准就直接上线——文档明确它"不代表模型真实尺寸，模型可以溢出 canvas"，
  用作"等比装进窗口"的基准会偏小/偏移；要的是"视觉包围盒"，所以"归一到 scale=1 后读 `model.width`"更稳。
- 基准要在**模型 `ready` 之后、首次 `fit` 之前**量，避免量到空 bounds。
- 缓存基准后，`fit` 变成纯函数，resize 多少次都不会漂移。

**缺口 2（P0）：`renderer.resolution` 只在建 app 时取一次**

现状：`new PIXI.Application({ ..., autoDensity: true, resolution: window.devicePixelRatio || 1 })`。
之后 `resize` 分支只调 `app.renderer.resize(w, h)`。pixi v6 的 `AbstractRenderer` 同时暴露
`resolution`、`autoDensity`、`resize()`（详见 [PIXI.AbstractRenderer (v6.5 docs)](https://pixijs.download/v6.5.10/docs/PIXI.AbstractRenderer.html)）。
`autoDensity` 负责把 canvas 的 **CSS 尺寸**设成逻辑尺寸，`resolution` 负责 **backing store** 的像素倍数；
只 resize 不更新 resolution，换屏后 backing store 仍按旧 DPR 分配 → 变糊、边缘发虚、极端情况下取样越界看起来像"被裁"。

```ts
resize: (w, h) => {
  const dpr = window.devicePixelRatio || 1;
  if (app.renderer.resolution !== dpr) {
    // v6 的 resize 接受第三参数 resolution；若当前小版本签名不同，
    // 先 app.renderer.resolution = dpr 再 resize(w, h) 等价
    app.renderer.resize(w, h, dpr);
  } else {
    app.renderer.resize(w, h);
  }
  fit(w, h);
  syncHitBox();
};
```

（`resize(w, h, resolution?)` 的第三参数以 v6.5 API 页为准；本仓若锁在更早的 6.x，请以实际 d.ts 为准 —— **【未核实】** 具体小版本。）

**缺口 3（P1）：没有监听 DPR / 显示器指标变化**

```ts
// 监听 DPR 变化（MDN 推荐写法：每次变化后重建 media query）
useEffect(() => {
  let cleanup = () => {};
  const watch = () => {
    cleanup();
    const mq = matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    mq.addEventListener("change", watch);
    cleanup = () => mq.removeEventListener("change", watch);
    stageRef.current.resize?.(window.innerWidth, window.innerHeight);
  };
  watch();
  return () => cleanup();
}, []);
```

主进程侧配合：`screen.on('display-metrics-changed', ...)`，`changedMetrics.includes('scaleFactor')` 时
按 DIP 重算窗口尺寸并 `setBounds`（**一次调用同时给位置和尺寸**，别 `setPosition` + `setSize` 分两次），
并通知渲染层重排。

**缺口 4（P2）：拖拽期间的合成开销还能再降**

- 拖动期间除停 ticker 外，可临时把 `renderer.resolution` 降到 1（或 0.75 倍），松手恢复——透明层每帧要合成的像素量直接按 DPR² 下降。
  代价是拖动中略糊，但拖的是"正在移动的位图"，人眼几乎看不出来。
- 拖动期间给根节点加 `will-change: transform` 意义不大（窗口移动不是 DOM 变换），**不要**为此引入合成层。
- `transparent: true` 时**别开** `hasShadow`（本仓已关），也别在窗口内画大面积半透明渐变——每帧 alpha 混合成本更高。

### 1.4 原生拖动 vs 自定义拖动：决策矩阵

| 维度 | `app-region: drag`（原生） | 自定义（mousedown + 主进程 `setPosition`） |
| --- | --- | --- |
| 平滑度 | 由系统移动循环接管，通常最顺 | 取决于合并与 IPC 延迟 |
| 逐帧位置回调 | 拿不到（区域忽略指针事件） | 有，可做吸附/钳制/惯性 |
| 拖动中做动画 | 不可控（页面事件停摆） | 可控（本仓选择冻结） |
| 点击/悬停 | 区域内全部失效，须逐个子元素 `no-drag` | 完全可控 |
| 右键菜单 | 可能弹系统菜单（被当非客户区） | 可控 |
| 双击最大化 | 系统默认行为，需额外拦截 | 无 |
| 适合场景 | 标题栏、大面积空白拖拽区 | 桌宠、悬浮球、需要吸附/边界约束的窗口 |

来源：[Custom Window Interactions (Electron Docs)](https://www.electronjs.org/docs/latest/tutorial/custom-window-interactions)。

**本仓建议**：桌宠主体继续走自定义拖动（要吸附、要钳制在 workArea 内、要拖拽期间冻结）；
若将来加"标题栏式拖拽带"，那一条带用 `app-region: drag`，且带内所有按钮显式 `app-region: no-drag` + `user-select: none`。

### 1.5 落地清单（可直接排期）

| # | 动作 | 文件 | 验收标准 |
| --- | --- | --- | --- |
| 1 | `fitModel` 改为"scale=1 量基准 + 缓存 + 纯函数适配" | `packages/web/src/components/pet/useLive2D.ts` | 连续 resize 20 次（拖动跨屏来回），模型包围盒尺寸偏差 < 1px；不再出现跳回 100% |
| 2 | resize 时同步 `renderer.resolution = devicePixelRatio` | 同上 | 1.0x ↔ 1.5x ↔ 2.0x 屏间拖动，画面不糊、边缘无发虚 |
| 3 | 监听 `(resolution: Xdppx)` 变化并触发重排 | 同上 / `PetWindow.tsx` | 换屏后 200ms 内完成一次重排，无中间态残影 |
| 4 | 主进程 `display-metrics-changed` → 单次 `setBounds` | `packages/desktop/pet-window.js` | 换屏后窗口不被裁出 workArea；无 `setPosition`+`setSize` 两次调用 |
| 5 | 位移计算全程 DIP，禁止混用物理像素 | `packages/desktop/pet-window.js` | 跨 1.5x 屏拖动，窗口与光标偏移 ≤ 2 DIP |
| 6 | 拖动期间降 `resolution` 到 1，松手恢复 | `PetWindow.tsx` / `useLive2D.ts` | 拖动中 CPU/GPU 占用下降，松手后 1 帧内恢复清晰 |
| 7 | 加自动化回归：`PetWindow.drag.test.tsx` 补"连续 resize 不漂移"用例 | 测试 | 现有测试全绿 + 新用例覆盖缺口 1 |

### 1.6 来源

- [Custom Window Interactions — Electron](https://www.electronjs.org/docs/latest/tutorial/custom-window-interactions)（可拖拽区忽略指针事件、`no-drag`、右键系统菜单、`ELECTRON_DEBUG_DRAGGABLE_REGIONS`）
- [BrowserWindow — Electron](https://www.electronjs.org/docs/latest/api/browser-window)（`ready-to-show`、`will-move` 仅手动移动触发、`transparent`/`paintWhenInitiallyHidden`）
- [screen — Electron](https://www.electronjs.org/docs/latest/api/screen)（`getCursorScreenPoint` 返回 DIP、`display-metrics-changed`、DIP/物理换算）
- [Window Features – Layered Windows — Microsoft Learn](https://learn.microsoft.com/en-us/windows/win32/winmsg/window-features)（系统缓存 layered window 图像、相对移动不重绘、`UpdateLayeredWindow` 用于动画）
- [Window: devicePixelRatio — MDN](https://developer.mozilla.org/en-US/docs/Web/API/Window/devicePixelRatio)（`(resolution: Xdppx)` 侦测 DPR 变化）
- [InternalModel — pixi-live2d-display v0.4.0](https://guansss.github.io/pixi-live2d-display/api/classes/index.InternalModel.html)（`width/height` 被 layout 缩放；`originalWidth/Height` 不等于真实尺寸）
- [Models — pixi-live2d-display](https://guansss.github.io/pixi-live2d-display/models/)（`autoUpdate` 与手动 `update(dt)` 两条更新链）
- [PIXI.AbstractRenderer v6.5 — PixiJS API](https://pixijs.download/v6.5.10/docs/PIXI.AbstractRenderer.html)（`resolution` / `autoDensity` / `resize`）

---

## 2. 导航栏 / 侧边栏：自动隐藏 + 边缘悬停呼出 + 可固定

### 2.1 结论

1. **主流产品几乎都不做"默认自动隐藏"**。VS Code 默认常驻侧栏，用 `Ctrl+B` 切换、Zen Mode 全隐；
   Notion 默认常驻，用 `>>`/`<<` 按钮与 `Ctrl/Cmd+\` 折叠。自动隐藏在桌面端是**可选项**，不是默认态。
   来源：[Custom Layout — VS Code](https://code.visualstudio.com/docs/configure/custom-layout)、
   [Navigate with the sidebar — Notion](https://www.notion.com/help/navigate-with-the-sidebar)。
2. **"边缘悬停"真正成熟的地方是操作系统，不是应用**：Windows 任务栏、macOS Dock 的自动隐藏都依赖
   "屏幕物理边缘是无限宽目标"这一 Fitts 定律红利。**窗口内边缘没有这个红利**，所以触发区必须更宽、延迟必须更长。
3. **展开必须浮在内容之上（overlay），不能推挤内容（push）**——这是"避免布局抖动"的唯一可靠解法。
4. **必须提供"固定"（pin）与"记住上次状态"**，否则用户每次启动都要重新呼出一次，第二次就关掉自动隐藏了。

### 2.2 竞品做法对照

| 产品 | 默认态 | 呼出方式 | 折叠快捷键 | 持久化 | 可信度 |
| --- | --- | --- | --- | --- | --- |
| VS Code | 侧栏常驻（左） | 标题栏按钮 / 命令面板 / `Ctrl+B` | `Ctrl+B`；Zen Mode `Ctrl+K Z` | 记住布局与视图位置（"across your sessions"） | 官方文档 |
| VS Code 次级侧栏 | 打开文件夹时默认显示，空窗口默认隐藏 | 标题栏布局按钮 / 命令 | `workbench.action.toggleAuxiliaryBar` | `workbench.secondarySideBar.defaultVisibility` 可配 | 官方文档 |
| Notion | 侧栏常驻 | `>>` / `<<` 按钮 | `Cmd/Ctrl + \` | 侧栏自定义（标签、显示/隐藏、顺序）持久 | 官方文档 |
| Slack | 侧栏常驻，可隐藏 | 视图菜单 / 快捷键 | 有隐藏项 | 记住偏好 | **【未核实】**（帮助中心该文已 404） |
| Linear | 侧栏常驻，可折叠 | 折叠按钮 | **【未核实】** | **【未核实】** | 未核实 |
| Arc | 侧栏（Tab 区）常驻，可收起 | 边缘悬停/按钮 | **【未核实】** | **【未核实】** | 未核实 |

> 说明：上表只保留能引用官方文档的格子；Slack / Linear / Arc 的细节没有找到可引用来源，故标未核实，
> 不拿"我记得是这样"当依据。VS Code 与 Notion 已足够支撑下面的默认值。

VS Code 值得单独抄的两点：
- **布局持久化是默认行为**，不是设置项："VS Code will remember the layout of views and panels across your sessions"。
- **渐进式隐藏**：先是可折叠侧栏 → 再是隐藏 Activity Bar（`Activity Bar Position: Hidden`）→ 最后 Zen Mode 全隐。
  用户按"需要多少屏幕"逐级降级，而不是一个开关从全开到全关。

### 2.3 一个成熟的"边缘呼出"由六个部件组成

| 部件 | 作用 | 缺了会怎样 |
| --- | --- | --- |
| 触发区（hot zone） | 判定"指针想呼出" | 太窄呼不出，太宽误触 |
| 进入延迟（enter delay） | 过滤"路过" | 鼠标横穿左缘就弹，烦 |
| 退出延迟（exit delay） | 过滤"手抖离开" | 面板疯狂开合 |
| 动效 | 表达"从哪来" | 突然出现，用户找不到来源 |
| 焦点管理 | 键盘可达 | 键盘用户永远打不开 |
| 持久化 | 记住意图 | 每次启动都要重来 |

### 2.4 默认值建议（可直接写进实现）

| 参数 | 建议值 | 依据 / 理由 |
| --- | --- | --- |
| 触发区宽度（贴**屏幕**左缘） | **2–4px** | 屏幕边缘是"无限宽"目标，窄区不会漏；同时避免挡住内容边缘的点击 |
| 触发区宽度（贴**窗口**内边缘 / 非全屏） | **8–12px** | 窗口内边缘没有 Fitts 红利，需靠宽度补偿 |
| 进入延迟（屏幕边缘） | **60ms** | 小于一次快速横穿的停留时间，又不至于"一碰就弹" |
| 进入延迟（窗口内边缘） | **150ms** | 窗口内横穿概率高得多 |
| 退出延迟 | **300ms** | 覆盖"手抖移出 1–2 帧"；VS Code/Notion 类桌面产品的常见量级 |
| 退出宽限（指针在触发区内移动） | **不收起** | 否则沿边缘上下移动时会反复开合 |
| 动效时长 | **160ms** | 与 150ms 级 hover 反馈同档；再长会"跟不上手" |
| 缓动 | `cubic-bezier(0.2, 0, 0, 1)`（ease-out） | 快进慢出，符合"被拉出来"的物理直觉 |
| 动效属性 | **只动 `transform` + `opacity`** | 动 `width` 会触发 reflow，是布局抖动的根源 |
| 折叠态宽度 | **54px**（本仓现值） | 与现有图标轨一致，不引入第二套栅格 |
| 展开态宽度 | **200–240px** | 容纳 2 行中文标签 + 快捷键提示 |
| 快捷键 | **`Ctrl+B`**（主）+ `Esc` 收起 | VS Code 肌肉记忆；`Ctrl+\` 被 Notion 占用，本仓已用 `Alt+数字`，不冲突 |
| 悬停提示延迟 | **400ms** | 折叠态靠 tooltip 补信息，太快会满屏气泡 |
| 固定（pin）语义 | pin 后**永不自动收起**，且忽略退出延迟 | 用户表达"别动它" |
| 记住的状态 | `{ pinned: boolean, lastOpen: boolean }` | 未 pin 时也要记住"用户上次手动关掉了" |

**注意**：本仓 `Alt+1..9/0` 已绑定页面切换，`Ctrl+B` 目前未被占用（需实测确认无冲突），
落地时用 `Ctrl+B` 而不是 `Ctrl+\`，避免与 Notion/编辑器习惯混淆。

### 2.5 避免布局抖动的三种做法（按推荐度）

1. **Overlay（推荐）**：折叠态占 54px 常驻轨道，展开层 `position:absolute; left:54px` + `translateX(-100%)→0`，
   内容区 `padding-left` **恒定 54px**。展开/收起不改变任何布局盒，零 reflow。
2. **Grid 列宽动画**：`grid-template-columns: 54px auto` → `240px auto`，用 `transition: grid-template-columns`。
   现代 Chromium 支持，但会持续触发布局计算，长列表页面掉帧。
3. **Width 动画（不推荐）**：`width: 54px → 240px` + `overflow:hidden`，每帧 reflow，内容会被挤压重排，
   中文尤其明显（文字换行跳变）。**不要用**。

### 2.6 本仓落地方案（`NavRail.tsx` 方向）

**状态机**（三个状态，别用多个 boolean 拼）：

```
collapsed ──hover hot zone(enter delay)──▶ peeking
collapsed ──click pin / Ctrl+B──▶ pinned
peeking  ──pointer leave(exit delay)──▶ collapsed
peeking  ──click pin──▶ pinned
pinned   ──Ctrl+B / unpin──▶ collapsed
```

**结构建议**：

```
<nav data-state="collapsed|peeking|pinned">      // 54px 常驻轨（不变宽）
  <div class="hot-zone" />                        // 左缘 8–12px 透明热区
  <ul class="rail">…图标…</ul>                    // 永远 54px
  <div class="drawer" aria-hidden={!open}>        // absolute，浮在内容上
    …标签 + 快捷键 + pin 按钮…
  </div>
</nav>
```

**键盘与无障碍（照 APG Disclosure 抄）**：折叠按钮 `role="button"` + `aria-expanded` + `aria-controls` 指向抽屉；
`Enter`/`Space` 切换；收起后焦点回到触发按钮；抽屉打开时**若由键盘触发**，焦点进第一个可聚焦项，
**若由悬停触发**，不抢焦点（否则打字会被打断）。
来源：[Disclosure (Show/Hide) Pattern — WAI-ARIA APG](https://www.w3.org/WAI/ARIA/apg/patterns/disclosure/)。

**必须处理的边界**：

- **拖拽冲突**：桌宠窗口贴着导航轨时，拖拽经过热区不应触发呼出（拖拽中禁用 hot zone）。
- **全屏/游戏**：全屏应用获得焦点时，`mousemove` 可能根本到不了我们（Electron 窗口失焦）——不要靠全局钩子，
  窗口内边缘触发即可。
- **多显示器接缝**：屏幕边缘热区在"两块屏的接缝处"会失效或误触，判断时应基于 `workArea` 而非 `bounds`。
- **本仓已有悬停胶囊提示**（`Tip`，150ms）：它与抽屉呼出是两套反馈，**展开态应禁用胶囊**，否则同屏两个浮层。

### 2.7 反例清单（都是真实产品里见过的坑）

| 反例 | 后果 |
| --- | --- |
| 贴边即弹（0 延迟） | 鼠标横穿左缘必弹，一天弹几十次 |
| 展开用 `width` 动画 | 内容重排、中文换行跳动、长列表掉帧 |
| 展开推挤内容（push） | 编辑器/聊天区宽度反复变化，阅读位置丢失 |
| 只做悬停、不做键盘 | 键盘用户无法到达任何导航项 |
| 不 pin 也不记忆 | 用户第二次就永久关掉该功能 |
| 悬停展开时抢焦点 | 正在输入的消息被吞掉 |
| 收起后焦点丢失 | `Tab` 从文档开头重新开始，键盘体验断裂 |

### 2.8 来源

- [Custom Layout — VS Code](https://code.visualstudio.com/docs/configure/custom-layout)（默认常驻、`Ctrl+B`、Zen Mode、次级侧栏默认可见性可配、布局跨会话记忆、Activity Bar 可隐藏）
- [Navigate with the sidebar — Notion](https://www.notion.com/help/navigate-with-the-sidebar)（`>>`/`<<` 与 `Cmd/Ctrl+\`、侧栏自定义持久化）
- [Disclosure (Show/Hide) Pattern — W3C WAI-ARIA APG](https://www.w3.org/WAI/ARIA/apg/patterns/disclosure/)（`aria-expanded`/`aria-controls`、Enter/Space）

---

## 3. 中文桌面应用（高信息密度）的字体栈与排版

### 3.1 结论

1. **字体栈顺序 = 拉丁在前、CJK 在后**。Windows 上 `system-ui` 解析到 Segoe UI，它没有汉字，
   Chromium 逐字回退到系统中文字体（通常是微软雅黑）。显式写栈能把"回退"变成"设计"，
   并保证英文/数字用 Segoe UI 的字形与字宽。
2. **本仓 `body` 目前没有 `font-family`**（`index.css` 里只有 `@apply bg-surface text-ink antialiased`），
   等于完全交给浏览器默认栈 —— 这是最该补的一处。
3. **字号不必追网页惯例**。本仓 10/11/12/13/18px + 行高 16/20/22/24 的分层，对中文桌面端是合理的：
   中文在 13px 下仍可读，而 14px 会让密集列表变松散。**要改的是字体栈、字重档位、数字对齐边界与两处对比度**。
4. **中文排版的硬规则来自 clreq**：汉字与标点是 1:1 方块、无缝并列；中西文混排时，
   汉字与西文之间应加"不多于四分之一汉字宽"的间距。这两条决定了"中英混排看起来是否专业"。
   来源：[Requirements for Chinese Text Layout (W3C clreq)](https://www.w3.org/TR/clreq/)。

### 3.2 字体栈（三级）

```css
/* 建议写入 index.css 的 @theme（见 3.6） */
--font-sans:
  "Segoe UI Variable Text", "Segoe UI",            /* Windows 11 / 10 拉丁 */
  system-ui, -apple-system, BlinkMacSystemFont,    /* macOS 兜底 */
  "PingFang SC", "Hiragino Sans GB",               /* macOS 中文 */
  "Microsoft YaHei UI", "Microsoft YaHei",         /* Windows 中文（UI 变体优先，字距更紧） */
  "Source Han Sans SC", "Noto Sans CJK SC",        /* Linux / 已装 Adobe-Noto 的机器 */
  "WenQuanYi Micro Hei", sans-serif;

--font-mono:
  ui-monospace, "Cascadia Mono", "Consolas",
  "Sarasa Mono SC", "Noto Sans Mono CJK SC", monospace;
```

要点：

- **为什么 `Microsoft YaHei UI` 在 `Microsoft YaHei` 前面**：UI 变体行高更紧、更适合界面；
  只装了普通版的机器会自动落到下一项，无副作用。
- **为什么不用 web font（思源黑体子集）**：桌面端首屏加载 2–5MB 字体是负收益；系统字体"无下载、无布局位移"。
  参考：[Modern Font Stacks](https://modernfontstacks.com/)（系统字体栈按字形分类，卖点正是"no downloading, no layout shifts, no flashes"）。
- **不要把中文字体放第一位**：`"Microsoft YaHei", "Segoe UI"` 会让所有英文也用雅黑渲染，字宽变宽、字重变糊。
- **等宽栈要带 CJK 等宽字体**：否则日志/代码块里的中文会与英文列不对齐（`Sarasa Mono SC`、`Noto Sans Mono CJK SC` 是等宽 CJK）。

### 3.3 字号 / 行高 / 字重层级

本仓已有 `.ui-h1`(18/24) `.ui-h2`(13/20) `.ui-body`(13/22) `.ui-body-sm`(12/20) `.ui-caption`(11/16) `.ui-micro`(10/16)。
保持不动，只补两条规则：

| 层级 | 字号 / 行高 | 字重 | 用途 | 备注 |
| --- | --- | --- | --- | --- |
| 页标题 | 18 / 24 | 600 | 页面 H1 | 已有 |
| 区块标题 | 13 / 20 | 600 | 卡片标题 | 已有 |
| 正文 | 13 / 22 | 400 | 段落、列表 | **行高/字号 ≈ 1.69**，中文舒适区 |
| 正文（次） | 12 / 20 | 400 | 表格单元、辅助说明 | 1.67 |
| 说明 | 11 / 16 | 500 | 标签、徽标 | 1.45，仅短文本 |
| 微字 | 10 / 16 | 500 | 角标、计数 | 1.6，仅 1–3 字符 |
| 代码/数字 | 12 / 18 | 400 | 日志、指标 | 等宽 + `tabular-nums` |

**行高经验值**：中文正文行高建议 **1.6–1.8**（西文常用 1.4–1.5）。原因：汉字满格、无升部降部的视觉留白，
行高低于 1.5 会显得"挤成一片"。本仓 13/22 落在 1.69，属正确区间。

**字重只用 400 / 500 / 600 / 700，不要用 300 或 800**：
- 微软雅黑的细体是独立字族（`Microsoft YaHei Light`），未安装时会**合成伪细**（笔画发灰、糊）；
- 800/900 在多数中文字体里直接映射到 Bold，视觉上等于 700，白写。

**【未核实】**：不同 Windows 版本预装的雅黑字族集合不同（Win7 无 Light，Win8+ 有），
所以"300 是否可用"必须按目标机器实测，不能假定。

### 3.4 数字对齐与表格

- **表格 / 统计 / 计数器**：`font-variant-numeric: tabular-nums`（等宽数字，纵向对齐）。本仓已有 `.ui-num` 工具类做这件事。
  来源：[font-variant-numeric — MDN](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/font-variant-numeric)。
- **正文内联数字**：用默认比例数字更自然，**不要**全局开 `tabular-nums`——中文正文里的"3 个"、"2026 年"
  用等宽数字会显得松散。
- **中英/中数混排间距**：clreq 6.3.3 建议汉字与西文之间加"不多于四分之一汉字宽"的间距；
  CSS 里没有原生实现，落地用两种方式之一：
  (a) 手写 `margin-inline: 0.125em` 的 `<span class="latin">`；
  (b) 在文案层直接加一个半角空格（成本最低，但依赖编辑规范）。
  **推荐 (a)**，可控且不污染文案。
- **表格里的负数/单位**：右对齐数字列、单位单独一列或用 `text-align: right` + 后缀 `<span>`，避免"12.5 MB"整串右对齐后小数点不齐。

### 3.5 暗色模式对比度（对本仓现有变量做核算）

按 WCAG 2.2 SC 1.4.3：正文 ≥ **4.5:1**，大字号（≥18pt / 14pt 粗，约 24px / 18.5px）≥ **3:1**；
占位符文本、悬停提示文本同样计入，不是"装饰"就豁免。
来源：[Understanding SC 1.4.3 Contrast (Minimum) — W3C WAI](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html)。

对本仓变量按 WCAG 公式近似手算（±0.2，建议用工具复核）：

| 变量 | 前景 | 背景 | 近似对比度 | 判定 |
| --- | --- | --- | --- | --- |
| `--ink`（light） | `#1a1a1a` | `#ffffff` | ≈ 17.4:1 | ✅ |
| `--body`（light） | `#555555` | `#ffffff` | ≈ 7.5:1 | ✅ |
| `--muted`（light） | `#6f6f6f` | `#ffffff` | ≈ 5.0:1 | ✅ |
| `--placeholder`（light） | `#b8b8b8` | `#ffffff` | ≈ **2.0:1** | ❌ 远低于 4.5 |
| `--ink`（dark） | `#f2f4f7` | `#16171a` | ≈ 15.9:1 | ✅ |
| `--body`（dark） | `#c7ccd3` | `#16171a` | ≈ 11.1:1 | ✅ |
| `--muted`（dark） | `#9aa0a8` | `#16171a` | ≈ 6.8:1 | ✅ |
| `--placeholder`（dark） | `#6b7078` | `#16171a` | ≈ **3.6:1** | ❌ 低于 4.5 |

**建议**：
- `--placeholder`（light）从 `#b8b8b8` 提到 **`#767676`**（≈ 4.5:1），
  或退一步 `#8a8a8a`（≈ 3.4:1，仅当占位符被视为"非必要提示"时）。
- `--placeholder`（dark）从 `#6b7078` 提到 **`#8b9199`**（≈ 5.3:1）。
- 占位符本身还承担"格式示例"职责，低对比会让用户误以为是已填内容——这是可用性问题，不只是无障碍问题。

### 3.6 Tailwind 4 + CSS 变量的 token 方案

本仓是 **v4 写法 + `@config` 兼容 v3 配置**，变量放在 `:root` / `[data-theme="dark"]`。
建议**增量**加一个 `@theme` 块（放在 `@config` 之后），只补字体与数字相关 token，不动既有色板，
避免影响 500+ 处 className：

```css
@import "tailwindcss";
@config "../tailwind.config.js";

@theme {
  /* 字体：覆盖 v4 默认 --font-sans，使 font-sans / 默认 body 都生效 */
  --font-sans: "Segoe UI Variable Text", "Segoe UI", system-ui, -apple-system,
    "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei UI", "Microsoft YaHei",
    "Source Han Sans SC", "Noto Sans CJK SC", sans-serif;
  --font-mono: ui-monospace, "Cascadia Mono", Consolas,
    "Sarasa Mono SC", "Noto Sans Mono CJK SC", monospace;

  /* 中文行高：与现有 10–18px 阶梯一一对应，不改字号只固定行高 */
  --text-micro: 10px;      --text-micro--line-height: 16px;
  --text-caption: 11px;    --text-caption--line-height: 16px;
  --text-body-sm: 12px;    --text-body-sm--line-height: 20px;
  --text-body: 13px;       --text-body--line-height: 22px;
  --text-title: 18px;      --text-title--line-height: 24px;

  /* 字重档位（只留 4 档，避免误用 300/800） */
  --font-weight-normal: 400;
  --font-weight-medium: 500;
  --font-weight-semibold: 600;
  --font-weight-bold: 700;
}

body {
  font-family: var(--font-sans);
  font-synthesis-weight: none;   /* 缺字重时不要合成伪粗/伪细 */
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
}
```

说明与注意：

- **`@theme` 与 `:root` 可以共存**：v4 的 `@theme` 本质仍是 CSS 变量，只是同时生成工具类。
  本仓色板继续留在 `:root`（因为要按 `[data-theme]` 覆盖），字体与字号放进 `@theme`（因为要生成 `font-sans` / `text-body`）。
  参考：[Theme variables — Tailwind CSS v4](https://tailwindcss.com/docs/theme)。
- **`font-synthesis-weight: none`** 是防伪粗的关键：中文字体缺 500/600 时，浏览器默认会"描粗"，
  在 13px 下会糊成一团；关掉后回退到最近的实有字重，反而更清晰。
- **不要给 `--text-*` 改字号**，只加 `--line-height`。改字号会波及所有已用 `text-[13px]` 字面量的地方（本仓大量使用字面量）。

### 3.7 中文排版细节清单（按"改起来便宜、收益明显"排序）

| # | 项 | 做法 | 来源 |
| --- | --- | --- | --- |
| 1 | 中西文混排间距 | 汉字与西文/数字间 ≈ 1/8–1/4 字宽 | clreq 6.3.3 |
| 2 | 标点挤压 | 连续标点（如 `。」`）不应占满两格；CSS 暂不支持，靠文案规避 | clreq 6.3.2 |
| 3 | 避头尾 | 行首不出现 `，。、）」`；用 `line-break: strict` + 人工检查 | clreq 6.1.1 |
| 4 | 省略号 | 用 `……`（两个三点），不要 `...` | clreq 5.4.1 |
| 5 | 引号 | 横排用弯引号 `“”`，不要直角引号 | clreq 2.1.2 |
| 6 | 数字与单位 | 数字与单位间加半角空格：`12.5 MB`、`80 ms` | 通用工程惯例 |
| 7 | 全角/半角括号 | 中文语境用全角 `（）`，代码/参数用半角 `()` | 本仓文案规范 |
| 8 | 字距 | 中文标题可 `letter-spacing: -0.01em`；正文**不要**加字距 | 本仓 `.ui-h1` 已有 |

### 3.8 来源

- [Requirements for Chinese Text Layout 中文排版需求 (W3C clreq)](https://www.w3.org/TR/clreq/)（1:1 方块、标点占位、中西文混排 1/4 字宽、避头尾、行高）
- [font-variant-numeric — MDN](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/font-variant-numeric)（`tabular-nums` 定义与用途）
- [Understanding SC 1.4.3 Contrast (Minimum) — W3C WAI](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html)（4.5:1 / 3:1、占位符与悬停文本同样计入）
- [Modern Font Stacks](https://modernfontstacks.com/)（系统字体栈按字形分类；"no downloading, no layout shifts, no flashes"）
- [Theme variables — Tailwind CSS v4](https://tailwindcss.com/docs/theme)（`@theme` 变量与工具类生成）

---

## 4. 「自定义内容」（自建智能体、自定义技能）的低门槛创建流程

### 4.1 结论

1. **先给成品，再给编辑**。默认落到"模板预填"，用户改两下就能用；"空白创建"作为第二入口（放在模板选择页的角落）。
2. **首屏只露 1 个必填字段**。NN/g 对渐进披露的两条硬约束：初始层必须覆盖高频需求、
   且"如何进入下一层"必须一眼可见；**超过 2 层披露可用性显著下降**。
   来源：[Progressive Disclosure — NN/g](https://www.nngroup.com/articles/progressive-disclosure/)。
3. **不要用向导（wizard）做"高频、可反复"的创建**。NN/g 明确：向导适合新手或低频流程（配置、首次设置），
   反复使用会因点击成本变烦。自定义技能/智能体属于"创建一次、偶尔改"，**用"表单 + 折叠高级区"而不是分步向导**。
   来源：[Wizards — NN/g](https://www.nngroup.com/articles/wizards/)。
4. **空态是教学位，不是占位符**。空态应同时做三件事：说明系统状态、给出下一步、提供直达入口；
   最糟的反例是"加载中先显示'暂无数据'"。
   来源：[Designing Empty States in Complex Applications — NN/g](https://www.nngroup.com/articles/empty-state-interface-design/)。

### 4.2 三种创建入口的取舍

| 入口 | 适用 | 成本 | 建议位置 |
| --- | --- | --- | --- |
| 从模板创建 | 80% 用户、首次创建 | 最低（预填名字/描述/提示词/连接） | **主按钮**（列表页右上 + 空态中央） |
| 从空白创建 | 有明确心智模型的老手 | 中 | 次按钮（模板页底部"从空白开始"） |
| 导入（JSON / 分享链接 / 复制现有） | 迁移、复用 | 低（但需校验） | 三级入口（`⋯` 菜单） |

**模板设计要点**：
- 模板要**可见地"像成品"**：卡片上直接展示"它会做什么"的一句话 + 一个示例输入输出，而不是"模板 A/B/C"。
- 模板数量 **3–6 个**；超过就得分组，否则选择成本超过创建成本。
- 每个模板必须能"一键创建后立刻可用"——需要外部连接（如 API Key）的模板，在创建后再提示补，
  **不要在创建表单里就要求填**。

### 4.3 渐进披露的三层结构（字段分层表）

以本仓 `AgentFormModal.tsx` 现有 5 个字段（`name` / `description` / `avatar` / `promptText` / `profileId`）为例：

| 层 | 字段 | 展示方式 | 理由 |
| --- | --- | --- | --- |
| L1 首屏（必填） | `name` | 单行输入，默认聚焦，预填模板名 | 唯一无法推断的信息 |
| L1 首屏（选填但高价值） | `description` | 单行输入，`placeholder` 给范例 | 决定列表可读性 |
| L2 折叠（"角色设定"） | `promptText` | `<details>` 折叠，展开后是 textarea | 长文本，首屏展开会挤压其它字段 |
| L2 折叠（"绑定连接"） | `profileId` | 下拉，默认"不绑定" | 需要用户已有连接，属进阶 |
| L3 二级弹层（"外观"） | `avatar` | 头像选择器（emoji / 上传 / 颜色） | 纯装饰，不影响可用 |

**验收标准**：新用户从点"新建"到"能用"的必填项 = 1 个；点击次数 ≤ 3；
折叠区默认收起且**标题写明里面有什么**（"角色设定（可选）"而不是"高级设置"）。

### 4.4 空态引导的写法

按 NN/g 三条准则组织（状态 → 学习线索 → 直达路径）：

```
[图标]
还没有自定义智能体
自定义智能体会按你的设定回答问题，只保存在本机。

[ 从模板创建 ]        ← 主按钮，直达
[ 从空白创建 ]        ← 次按钮
示例：把「周报助手」模板加进来，它会按你的格式整理本周提交 →
```

反例（必须避免）：
- ❌ 只写"暂无数据" —— 用户不知道是空、是错、还是在加载。
- ❌ 加载中先显示"暂无数据"，2 秒后替换成列表 —— NN/g 明确点名这是"最有害"的一类，会摧毁信任。
- ❌ 空态放大段功能介绍文字（超过 2 行）—— 空态是入口，不是文档。
- ❌ 空态只有插画没有按钮 —— 用户得自己找入口。

### 4.5 表单字段最少化的五条规则

1. **能从上下文推断的，不要问**：创建于某个团队页时，团队归属自动带入。
2. **能后置的，不要前置**：绑定连接、头像、高级参数全部后置到"创建成功之后"。
3. **能默认的，给默认值**：名字预填模板名（"我的周报助手"）、描述预填模板描述。
4. **能合并的，合并**：`name` 与 `description` 可合成"名称 + 一句话说明"两行同一视觉组。
5. **错误只在提交后出现，且定位到字段**：不要实时校验"名称不能为空"（用户刚点开就红一片）。

### 4.6 反例清单（每条都对应一个真实失败模式）

| 反例 | 失败模式 |
| --- | --- |
| 一上来就是 8 个字段的空白表单 | 首屏放弃率最高；用户不知道"最少要填几个才能用" |
| 分步向导做"改一个字段" | 改个名字要走 3 步，NN/g 点名的向导缺点 |
| 必填项用星号但不说明"为什么必填" | 用户填了假数据（"测试1"） |
| 模板卡片只有名字没有预览 | 用户无法判断差异，退回"从空白创建" |
| 创建后跳回列表、不打开新建项 | 用户不知道成功没有，会重复创建 |
| 高级设置默认展开 | 首屏认知负荷 = 全量表单，渐进披露失效 |
| 技能/智能体创建后没有"试一下"入口 | 用户无法验证，只能靠猜，第二次不再创建 |
| 删除与创建按钮同权重相邻 | 误删（本仓 `confirmDelete` 已做二次确认，保持） |

### 4.7 本仓落地建议（方向）

1. **新增"模板选择"步骤（不是向导，是一个弹层）**：点"新建"→ 先出 3–6 张模板卡（含"空白"）→ 选中后进入
   `AgentFormModal`，字段已预填。这样"模板"和"表单"解耦，模板可独立迭代。
2. **`AgentFormModal` 内部按 4.3 分层**：`promptText` / `profileId` 收进折叠区，`avatar` 收进"外观"二级弹层。
3. **技能创建复用同一套模式**：技能 = 名称 + 一句话说明（L1）+ 触发方式/工具（L2 折叠）+ 权限（L3）。
   插件区（能力中心）的"技能"视图应提供同样的模板入口。
4. **空态统一组件**：`{icon, title, body(≤2 行), primaryAction, secondaryAction, example?}`，
   智能体列表、技能列表、自动化列表共用，避免每个页面各写一套文案。
5. **创建成功后不要回列表**：直接打开新建项的详情/试用面板，给"发一条消息试试"的输入框。

### 4.8 来源

- [Progressive Disclosure — NN/g (Jakob Nielsen)](https://www.nngroup.com/articles/progressive-disclosure/)（两条硬约束、超过 2 层可用性下降、初始层覆盖高频需求）
- [Wizards: Definition and Design Recommendations — NN/g](https://www.nngroup.com/articles/wizards/)（向导适合新手/低频；点击成本、不可中断、阻断其它功能等缺点）
- [Designing Empty States in Complex Applications: 3 Guidelines — NN/g](https://www.nngroup.com/articles/empty-state-interface-design/)（状态沟通、学习线索、直达路径；"暂无数据"误导反例）

---

## 5. 附：来源清单与可信度分级

| 级别 | 来源 | 用于 |
| --- | --- | --- |
| A（官方文档/标准） | [Electron: Custom Window Interactions](https://www.electronjs.org/docs/latest/tutorial/custom-window-interactions)、[BrowserWindow](https://www.electronjs.org/docs/latest/api/browser-window)、[screen](https://www.electronjs.org/docs/latest/api/screen) | 主题 1 |
| A | [Microsoft Learn: Window Features（Layered Windows）](https://learn.microsoft.com/en-us/windows/win32/winmsg/window-features) | 主题 1 |
| A | [W3C clreq 中文排版需求](https://www.w3.org/TR/clreq/)、[WCAG 2.2 SC 1.4.3](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html)、[WAI-ARIA APG Disclosure](https://www.w3.org/WAI/ARIA/apg/patterns/disclosure/) | 主题 2/3 |
| A | [MDN: devicePixelRatio](https://developer.mozilla.org/en-US/docs/Web/API/Window/devicePixelRatio)、[font-variant-numeric](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/font-variant-numeric) | 主题 1/3 |
| A | [pixi-live2d-display v0.4.0 API](https://guansss.github.io/pixi-live2d-display/api/classes/index.InternalModel.html)、[Models](https://guansss.github.io/pixi-live2d-display/models/)、[PIXI.AbstractRenderer v6.5](https://pixijs.download/v6.5.10/docs/PIXI.AbstractRenderer.html) | 主题 1 |
| A | [VS Code Custom Layout](https://code.visualstudio.com/docs/configure/custom-layout)、[Notion sidebar help](https://www.notion.com/help/navigate-with-the-sidebar)、[Tailwind v4 Theme](https://tailwindcss.com/docs/theme) | 主题 2/3 |
| B（权威机构文章） | [NN/g: Progressive Disclosure](https://www.nngroup.com/articles/progressive-disclosure/)、[Wizards](https://www.nngroup.com/articles/wizards/)、[Empty States](https://www.nngroup.com/articles/empty-state-interface-design/)、[Modern Font Stacks](https://modernfontstacks.com/) | 主题 3/4 |

**未核实项汇总**（落地前需实测）：

1. Electron/Chromium 在 Windows 上透明窗具体走 `SetLayeredWindowAttributes` 还是 `UpdateLayeredWindow`（主题 1.2a）。
2. `app-region: drag` 是否进入系统模态移动循环、期间 rAF 是否停摆（主题 1.2c）——可由 `ELECTRON_DEBUG_DRAGGABLE_REGIONS` 与实测帧率确认。
3. pixi v6 早期小版本 `resize()` 是否接受第三参数 `resolution`（主题 1.3 缺口 2）。
4. Slack / Linear / Arc 的侧栏自动隐藏与快捷键细节（主题 2.2）——帮助中心无可用页面。
5. 各 Windows 版本预装的微软雅黑字族集合（是否含 Light）（主题 3.3）。
6. 本仓 `Ctrl+B` 当前是否已被占用（主题 2.4）。

**未采用的外部素材**：GitHub issue（网络策略拦截）、M3 导航抽屉规范页（JS 渲染，抓不到正文）、
Apple HIG 字体页（同上）。这些不影响上述结论，因为它们各自都有 A 级替代来源。
