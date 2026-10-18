# 和鸣启动动画 · 设计文档

- 日期：2026-10-18
- 设计者：美术设计会话
- 状态：**已实施并合入 main**（提交 `7207da2` 合并；**观感真机验证待做**，见 §9）

---

## 1. 概述

为和鸣桌面端设计从双击图标到主界面可见的完整启动动画，3 秒，双段式节奏，不可跳过。动画期间后台静默恢复登录态，动画结束后直接路由至主应用或登录页。

## 2. 整体流程

```
点击图标
  │
  ├─ 0ms: 主窗口创建（白底，后台加载远程页）
  ├─ 0ms: splash 窗口覆盖（无边框透明）
  │
  ├─ 0-1500ms: 【第一段·粒子聚拢】（splash 渲染）
  │   · 20-30 个光点从窗口四周向中心聚拢
  │   · 到达中心后合成一个柔和墨色圆点
  │   · 音效1：轻柔「聚集」音（约 300Hz 类正弦）
  │
  ├─ 1500-1700ms: 【静默】（约 200ms 停顿）
  │
  ├─ 1700-3000ms: 【第二段·声波扩散】（web 端渲染，splash 交棒）
  │   · 中心点发出 3 圈扩散波纹
  │   · 波纹扫到哪里，哪里的主界面内容就浮现
  │   · 音效2：轻柔「共鸣」音（叠加泛音的正弦）
  │
  └─ 3000ms: 启动完成，正常主界面
```

### 登录态处理

- splash 播第一段的同时，`restore()` 在后台执行
- 3 秒动画播完后：已登录 → 直接进主界面；未登录 → 进登录页（声波扩散完成后直接切换，视觉一致）

## 3. 两段渲染的交接机制

| 层 | 职责 |
|---|---|
| splash 窗口（Electron 原生） | 粒子聚拢段（1.5s）；播完后检查远程页是否就绪，通过 preload 发信号 |
| web 端（`App.tsx` 顶层） | 声波扩散段（1.5s）；收到主进程信号后开始播放 |

### 时序保障

- 远程页加载快（< 1.5s）→ splash 播完粒子段时页面已就绪，立即交棒
- 远程页加载慢（> 1.5s）→ splash 播完粒子段后保持等待，页面就绪后立即交棒，web 端立即开始声波段（总启动时间略超 3 秒，但动画始终连贯无白屏）

## 4. 视觉效果细节

### 粒子聚拢段

- 背景：纯白 `#ffffff`
- 粒子：20-30 个 2px 墨色（`#1a1a1a`）圆点，初始位置均匀分布在窗口边缘
- 运动：缓动 `cubic-bezier(0.22, 0.61, 0.36, 1)` 向中心聚拢
- 到达中心后：合成一个 40px 墨色圆点，轻微呼吸缩放

### 声波扩散段

- 背景：纯白 `#ffffff`
- 波纹：3 圈同心圆，间距约 300ms 依次发出，颜色从 `#1a1a1a` 渐隐到透明
- 揭示：波纹经过的区域，主界面内容（导航栏、内容区、文件树）从中心向外渐次显现
- 实现方式：主界面组件先 `opacity: 0`，波纹动画通过 CSS clip-path 或遮罩逐区揭示

## 5. 音效设计

| 时间点 | 音效 | Web Audio API 合成 |
|---|---|---|
| 粒子聚拢开始（0ms） | 轻柔「聚集」音 | ~300Hz 正弦，淡入 0.2s，持续 1s |
| 声波扩散开始（1700ms） | 轻柔「共鸣」音 | ~440Hz 正弦 + ~880Hz 泛音，淡入 0.1s，持续 1.3s |

## 6. 技术实现要点

1. **splash 窗口**：Electron `BrowserWindow`，`frame: false` + `transparent: true` + `alwaysOnTop: true`，加载本地 HTML（新增 `splash.html`，加入 `desktop/files` 白名单）
2. **preload 扩展**：`preload.js` 暴露 `window.heming.__onBootReady(cb)`（注册回调）与 `__startBootWave()`（主进程在远程页 `did-finish-load` 后调用）。
   - 实现要点：回调登记在 preload 的**隔离世界闭包**里，渲染进程只「调用」不「注入」——contextBridge 暴露的对象是冻结的，渲染进程赋值会抛 `TypeError`。
   - 信号会被缓冲：`__startBootWave()` 早于注册时先记 `bootStarted`，注册时立即补发。
3. **web 端**：`App.tsx` 顶层让 `AppShell` **从 T=0 常驻挂载**，`<BootWave>` 作为全屏遮罩盖在其上；`bootDone` 只控制遮罩卸载与 `inert`。
   - 这样 `AppShell` 的 `restore()` 与动画并行，动画结束时已是恢复后的界面（若把 `AppShell` 挡在动画之后，已登录用户会紧接着动画看到一个「加载中…」空窗）。
   - 遮罩以中心透明洞向外揭示，因此「先挂载、后揭开」在视觉上等于「主界面从中心向外渐次显现」，不会提前暴露真实 UI。
4. **新增文件**：`packages/desktop/splash.html`（粒子聚拢动画）、`packages/web/src/components/BootWave.tsx`（声波扩散动画）
5. **测试**：`splash.html` 的粒子运动逻辑抽纯函数可单测；`BootWave` 的波纹时间线可单测

## 7. 边界与约束

- 不修改 `shared`/`server`/WS 契约
- 不修改 `ChatPage`/`agentStream`/`TriggerDeps`
- 仅改 `App.tsx`（顶层条件渲染）和 `preload.js`（暴露回调）
- 动画期间不可跳过（不响应点击/键盘）
- 尊重 `prefers-reduced-motion`：若系统开启减弱动态效果，跳过动画直接显示主界面

## 8. 文件变更清单

| 文件 | 动作 | 说明 |
|---|---|---|
| `packages/desktop/splash.html` | 新增 | 粒子聚拢动画（含 Web Audio 音效；无 preload，自包含） |
| `packages/desktop/splash.test.js` | 新增 | 粒子布局单测（从 HTML 抽取 `particlePosition` 真实执行） |
| `packages/desktop/splash-config.js` | 新增 | 时序常量与纯净判定（`SPLASH_MS`/`GAP_MS`/`WAVE_MS`/`BOOT_TOTAL_MS`、`shouldShowSplash`、`splashWindowOptions`、`isFatalLoadFailure`）——抽出来才能对**生产同一份**逻辑做单测 |
| `packages/desktop/splash-lifecycle.js` | 新增 | splash 窗口生命周期（注入窗口/计时器，可单测；含关闭地板、8s 加载看门狗、失败兜底） |
| `packages/desktop/splash-lifecycle.test.js` | 新增 | 生命周期行为测试（假窗口） |
| `packages/desktop/main.test.js` | 新增 | 时序预算与配置断言 |
| `packages/desktop/main.js` | 修改 | 接线 splash 生命周期；主窗口 `show: !withSplash` 与 `backgroundThrottling: false` |
| `packages/desktop/package.json` | 修改 | `files` 白名单加入 `splash.html`/`splash-config.js`/`splash-lifecycle.js` |
| `packages/desktop/preload.js` | 修改 | 暴露 `__onBootReady`/`__startBootWave`（闭包登记表 + 信号缓冲） |
| `packages/desktop/preload.test.js` | 新增 | 桩掉 `electron` 后 `require` 真实 preload，验证信号真能触发回调 |
| `packages/web/src/components/BootWave.tsx` | 新增 | 声波扩散：白底遮罩 + 中心透明洞揭示 + 3 圈波纹（含 Web Audio 音效） |
| `packages/web/src/components/BootWave.test.tsx` | 新增 | 遮罩/逐帧揭示/兜底开播/节流不卡死 |
| `packages/web/src/App.boot.test.tsx` | 新增 | 门禁路由 + 证明 `restore()` 在动画期间完成 |
| `packages/web/src/types/heming.d.ts` | 新增 | `Window.heming` 全局声明（避免 `(window as any)`） |
| `packages/web/src/App.tsx` | 修改 | `AppShell` 常驻 + `<BootWave>` 遮罩 + 动画期间 `inert` |
| `packages/web/src/App.test.tsx` | 修改 | 既有用例改用「挂载即 onDone」的 BootWave 桩 |

---

## 9. 实施记录（2026-10-18）

分两段：Task 1–6 见 `docs/superpowers/plans/2026-10-18-boot-animation.md`；终审后 3 轮修复见下。

### 已落地

| 提交 | 内容 |
|---|---|
| `a4960aa` `fa6b35e` | splash.html 粒子段 + 修复（音效 resume / reduced-motion 无延迟 / 粒子不重叠） |
| `0ae2a94` `6162bd6` `2629424` | splash 窗口生命周期（真机可测的真逻辑、失败兜底、工作区尺寸、多显示器 x/y） |
| `8dbc2cb` `1083660` | preload 信号（闭包登记表，替代不可行的注入方案） |
| `698a76c` `d254e86` `063a3cd` | BootWave 组件（改为只调用 preload、不注入） |
| `4f2bacb` `fb8a323` | App 集成（AppShell 常驻 + 遮罩）+ 兜底开播 |
| `5a2fbfb` | 终审修复波（14 项：恢复并行化 / splash 生命周期 / 中心揭示 / 时序地板 / 类型…） |
| `d017603` | 复审残留（粒子铺满 / 重载信号 / 动画期间屏蔽输入） |
| `8cb2c93` | rAF 被节流时白遮罩永久盖住界面 |
| `7207da2` | 合并进 main |

### 与设计正文的偏差（及原因）

1. **preload API 改名并换机制**：正文写 `onBootReady(cb)`、web 端「注入实现」到 `window.heming`。实际是 `__onBootReady(cb)` + `__startBootWave()`，回调登记在 preload 的**隔离世界闭包**里。
   *原因*：`contextBridge` 暴露的对象是冻结的，渲染进程赋值会抛 `TypeError`——设计里的注入方案物理上不可能，且原计划的 jsdom 测试抓不到（测试用的是手搓普通对象）。
2. **揭示机制换成遮罩开洞**：正文写「主界面组件先 `opacity: 0`，用 clip-path 或遮罩逐区揭示」。实际是一块白底遮罩 + `mask-image: radial-gradient` 的中心透明洞，由 rAF 逐帧写 `--reveal`（不用 `@property`）。
   *原因*：`opacity` 逐区需要为每个区域写规则、与布局耦合；遮罩法只需一个元素，且「先挂载、后揭开」天然满足第 5 点。
3. **加了「splash 可见地板」**：正文只规定总时长 3s。实现让 splash 至少可见 `SPLASH_MS + GAP_MS`（`splashCloseDelayMs`）。
   *原因*：云端页面 86ms 就 `did-finish-load`，不设地板会在约 0.5s 就关掉 splash，粒子段被拦腰截断——「3 秒、不可跳过」名存实亡。
4. **主窗口延后 show**：`show: !withSplash`，splash 可见后再 show 主窗口。
   *原因*：默认 `show: true` 会让白底主窗口先于 splash 画出（白闪）。
5. **`AppShell` 常驻而非门禁**：正文 §6 原写「顶层条件渲染 + `bootState`」。实际 `AppShell` 从 T=0 挂载，`BootWave` 只是盖在上面的遮罩。
   *原因*：把 `AppShell` 挡在动画之后，`restore()` 要 T≈3s 才开始，已登录用户会紧接着动画看到一个「加载中…」空窗——正是本设计要消灭的东西（终审 C1）。
6. **信号缓冲**：`__startBootWave()` 早于注册时先记 `bootStarted`，注册时补发。
   *原因*：React 挂载时机与 `did-finish-load + 200ms` 之间没有顺序保证，丢了信号就只剩兜底。
7. **每次加载都重发信号**：不只是首次 `did-finish-load`。
   *原因*：否则 Ctrl+R / 视图→重新加载会在白遮罩后等满 5s 兜底（约 6.3s 看不见界面）。
8. **节流兜底（真机复现后补）**：`onDone` 除 rAF 外再挂 `setTimeout(WAVE_MS + 80)`；主窗口与 splash 均 `backgroundThrottling: false`。
   *原因*：splash 是 `alwaysOnTop` 全屏，Chromium 会把主窗口判为被遮挡并节流其 rAF 与定时器——揭示推不动、白遮罩永久盖住界面。已在隐藏窗口（`visibilityState: "hidden"`，rAF 全程不跑）下复现并确认修复。
9. **动画期间屏蔽输入**：遮罩 `pointer-events: auto` + 主界面容器挂 `inert`。
   *原因*：规格 §7 要求不可跳过，但 `AppShell` 已常驻——不挡的话点击会落在看不见的按钮上，全局快捷键（Alt+1–5 / Ctrl+\）也会在动画期间生效。

### 验证

| 项 | 结果 |
|---|---|
| 门禁（分支时点 `8cb2c93`） | desktop 74 / shared 63 / server 169 / web 639 = 945 全绿 |
| 门禁（合并进 main） | desktop 79 / shared 63 / server 169 / web 649 = 960 全绿 |
| 真实浏览器（DOM / 计算样式） | 粒子铺满 `20 → 1260`（= margin → W−margin，步长 177.14，原先空白的最后 1/6 已消失）；核心圆点 `transition: transform 0.4s`（1.4s 延迟已移除）且 `.visible`；遮罩 `mask-image` 生效；`pointer-events: auto` + 容器 `inert` 生效；**登录页在遮罩下已渲染完成**（证明 `restore()` 与动画并行） |
| 真实 Electron | preload 信号端到端触发（renderer `__onBootReady` + main `__startBootWave` → fired）；rAF 被节流时遮罩仍按时卸载，应用正常进入下一态 |
| 观感（肉眼连续观看） | **未做** —— 见待办 |

### 待办

1. **真机肉眼过一遍**：`pnpm --filter @heming/desktop dist` 重打安装包（当前 `release/` 里的包是合并前构建，不含后续修复）→ 安装 → 看 3 秒节奏、粒子聚拢质感、声波揭示的连贯度、音效音量。
2. **线上部署**：走 `docs/deploy.md`。

### 已知遗留（不阻塞，均为小项）

- 四角 2px 粒子重合（端点必须精确落框的直接推论；要消除可改 `t = (i + 0.5) / perSide`）。
- 正文 §4 圆点「轻微呼吸缩放」未实现——圆点 1400ms 出现、splash 1700ms 关闭，可用窗口仅约 300ms。
- `WAVE_MS` 在 `BootWave.tsx` 与 `splash-config.js` 各写一份，无跨包断言，漂移是静默的。
- `backgroundThrottling: false` 覆盖窗口整个生命周期，被遮挡/最小化时不再省电。
- 纯浏览器直开时每次加载都会播 1.3s 声波段（桌面端为主，影响有限）。
