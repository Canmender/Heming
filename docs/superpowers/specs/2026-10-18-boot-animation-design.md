# 和鸣启动动画 · 设计文档

- 日期：2026-10-18
- 设计者：美术设计会话
- 状态：已批准

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
2. **preload 扩展**：在 `preload.js` 暴露 `window.heming.onBootReady(cb)` 回调，主进程在远程页 `did-finish-load` 后触发
3. **web 端**：`App.tsx` 顶层加 `bootState`，条件渲染 `<BootWave>` 组件
   - `bootState` 取值：`booting`（动画进行中）/ `done`（动画结束，路由至登录页或主应用）
   - web 端收到主进程 `onBootReady` 信号后开始声波扩散段；若 splash 播完时页面未就绪，web 端在自身挂载后立即开始（时序由主进程 `did-finish-load` 回调保障）
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
| `packages/desktop/splash.html` | 新增 | 粒子聚拢动画（含 Web Audio 音效） |
| `packages/desktop/splash.test.js` | 新增 | 粒子运动纯函数单测 |
| `packages/desktop/main.js` | 修改 | 创建/销毁 splash 窗口，did-finish-load 后通知 web 端 |
| `packages/desktop/package.json` | 修改 | `files` 白名单加入 `splash.html` |
| `packages/desktop/preload.js` | 修改 | 暴露 `window.heming.onBootReady` |
| `packages/web/src/components/BootWave.tsx` | 新增 | 声波扩散动画组件（含 Web Audio 音效） |
| `packages/web/src/components/BootWave.test.tsx` | 新增 | 波纹时间线单测 |
| `packages/web/src/App.tsx` | 修改 | 顶层条件渲染 `<BootWave>`，登录态路由 |
