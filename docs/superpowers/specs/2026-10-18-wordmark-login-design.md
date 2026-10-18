# 和鸣 · 手写字样 + 登录分栏 + 默认最大化 · 设计文档

- 日期：2026-10-18
- 设计者：美术设计会话
- 状态：设计中（待用户过目字形预览）
- 关联：`2026-10-18-boot-animation-design.md`（本设计在其前面插入一段，并改动其登录页与窗口形态）

---

## 1. 概述

三件事：

1. **启动动画前置一段手写**：「Heming」以单线手写体逐笔写出（1.5s），接现有粒子聚拢 → 静默 → 声波扩散。总时长 3.0s → **4.5s**。
2. **登录页改左右分栏**：左侧居中登录卡片，右侧居中「Heming」手写字样。
3. **启动默认最大化窗口**：铺满屏幕，保留已实现的自定义标题栏与原生窗口控件。

## 2. 时间轴（总 4.5s）

```
0.0–1.5s   【手写】「Heming」逐笔写出        ← 新增（splash 渲染）
           · 音效3：轻柔上行音（笔尖起笔）
1.5–3.0s   【粒子聚拢】四周光点聚拢 → 墨色圆点 ← 现有，不动
           · 音效1：轻柔「聚集」音
3.0–3.2s   【静默】
3.2–4.5s   【声波扩散】中心波纹揭示主界面     ← 现有，不动
           · 音效2：轻柔「共鸣」音
```

**时序常量**（`packages/desktop/splash-config.js`）：

| 常量 | 现在 | 改为 | 含义 |
|---|---|---|---|
| `WRITE_MS` | — | `1500` | 手写段时长（新增） |
| `SPLASH_MS` | `1500` | `1500` | 粒子段时长（不变） |
| `GAP_MS` | `200` | `200` | 静默（不变） |
| `WAVE_MS` | `1300` | `1300` | 声波段（不变） |
| `BOOT_TOTAL_MS` | `3000` | **`4500`** | 四段之和 |
| splash 可见地板 | `1700` | **`3200`** | `WRITE_MS + SPLASH_MS + GAP_MS` |

`BootWave` 的兜底开播时限从 `5000` 提到 **`7000`**：它要覆盖的「挂载 → 主进程送信号」间隔上限就是 splash 可见地板（3200ms），7000 留了一倍余量；若信号永不到来，用户最坏白等 7s（主进程 bug 场景）。

## 3. 手写字样

### 3.1 字形风格

**单线手写（monoline script）**，笔画等宽、圆头圆角，斜度约 8°。选它的理由：

- **零字体依赖**：项目目前没有任何字体文件与字体配置；引入手写字体要处理授权、自托管与子集化，桌面端 splash.html 还要求自包含（内联 base64 会让文件膨胀）。
- **真「书写」**：只有逐笔描边（`stroke-dashoffset`）是真的在写；用字体只能做擦除式显现，观感差一档。
- **与既有语言一致**：项目视觉是细线墨色 SVG（strokeWidth 1.5），单线手写是同一套语言的自然延伸。

### 3.2 笔画与书写顺序

按真实书写顺序逐笔描出，笔尖不抬起的连续段合并为一条 path：

```
H  ← 左竖（自上而下）→ 右竖 → 横（左→右）
e  ← 起笔横 → 上弧 → 回环 → 收笔尾
m  ← 起笔上挑 → 三个拱
i  ← 竖 → 点（最后落，独立 path）
n  ← 竖 → 一个拱
g  ← 起笔 → 上弧 → 回环 → 下伸尾
```

每条 path 按其**实际长度**分配时长（`getTotalLength()`），使笔画推进速度均匀；字与字之间留 ~60ms 间隔，模拟抬手。

### 3.3 尺寸与落位

- `viewBox="0 0 400 150"`；基线 y=104，x-height 顶 y=64，上伸至 y=22，下伸至 y=132
- 手写段：居中，宽约 `min(420px, 46vw)`，墨色 `#1a1a1a`，`stroke-width 3`（视觉上按缩放自适应）
- 写完停留约 150ms 后整体淡出（200ms），交棒粒子段——**淡出而非硬切**，避免两个墨色画面相撞

### 3.4 登录页右侧字样

同一份字形数据，**静态**呈现（不重播手写动画——每次登录都演一遍会烦）：

- 居中于右侧栏，宽约 `min(320px, 28vw)`
- 颜色 `#1a1a1a`，不描边动画
- 与左侧卡片形成「左交互 / 右品牌」的构图

### 3.5 单一真源

字形 path 数据只定义一次，放 `packages/web/src/components/wordmark.ts`（`LoginPage` 与测试直接 import）。`splash.html` 要求自包含（无打包器、无 preload），必须内嵌一份。

**防漂移**：新增 desktop 测试，读取 `packages/web/src/components/wordmark.ts` 抽出 path 字符串，断言与 `splash.html` 内嵌的完全一致。项目已把「`WAVE_MS` 两边各写一份无断言」记为技术债，这里不再重复那个坑。

## 4. 登录页分栏

```
┌────────────────────────────┬────────────────────────────┐
│                            │                            │
│                            │                            │
│      ┌──────────────┐      │                            │
│      │   和鸣        │      │                            │
│      │  登录你的账号  │      │        H e m i n g         │
│      │  ┌────────┐  │      │      （手写体字样居中）      │
│      │  │ 用户名  │  │      │                            │
│      │  ├────────┤  │      │                            │
│      │  │ 密码    │  │      │                            │
│      │  ├────────┤  │      │                            │
│      │  │  登录   │  │      │                            │
│      │  └────────┘  │      │                            │
│      └──────────────┘      │                            │
│                            │                            │
└────────────────────────────┴────────────────────────────┘
        左：卡片垂直居中              右：字样水平+垂直居中
```

- 两栏**等宽**（`flex-1` 各半），分隔不画线（留白分隔，符合「分割线只在必要时用」）
- 窗口窄于 `900px` 时退化为单栏：隐藏右侧字样，卡片居中（避免出现两块都挤扁）
- 卡片内容不变（「和鸣」+ 副标题 + 用户名/密码/登录），仅位置变化
- 背景沿用 `#fafafa`；卡片保持 `border-line` + `shadow-card`
- 桌面端顶部已有自定义标题栏占位，分栏区占其余高度

## 5. 默认最大化

- 主窗口创建后调用 `win.maximize()`（**不是** `fullscreen: true`——真全屏会隐藏刚做好的自定义标题栏与原生窗口控件）
- **窗口状态持久化改用 `win.getNormalBounds()`**：最大化时 `getBounds()` 返回屏幕尺寸，直接存会把用户偏好的窗口尺寸覆盖掉；`getNormalBounds()` 取的是还原态的尺寸，最大化/还原往返才正确
- 用户把窗口还原并调整尺寸后，下次启动仍是最大化（按「打开默认全屏」的要求），但再还原回的是他调过的尺寸
- `window-state.test.js` 补：最大化状态下落盘用 normal bounds

## 6. 音效（新增音效3）

| 时间点 | 音效 | Web Audio API 合成 |
|---|---|---|
| 手写开始（0ms） | 轻柔「起笔」音 | 正弦 220Hz → 440Hz 上滑，1.2s，增益 0.08（比另两个更轻，避免开场过响）；起笔处叠一个极短的低通噪声爆（8ms）模拟笔尖落纸 |

三个音共用一条设计规则：**正弦基频 + 线性淡入淡出 + 峰值增益 ≤0.15**，风格统一且不刺耳。

## 7. 边界与约束

- 不修改 `shared`/`server`/WS 契约
- 不修改 `ChatPage`/`agentStream`/`TriggerDeps`
- 不新增任何 npm 依赖、不新增字体文件
- 视觉规范：无 emoji、墨色 `#1a1a1a`、浅灰分割线、中文文案（英文仅是品牌字样）
- 尊重 `prefers-reduced-motion`：跳过全部三段动画直接进入登录页/主界面
- 动画期间不可跳过（沿用现有 `inert` + `pointer-events` 机制，手写段同样覆盖）

## 8. 文件变更清单

| 文件 | 动作 | 说明 |
|---|---|---|
| `packages/web/src/components/wordmarkGlyphs.ts` | 新增 | 字形 path 单一真源（含书写顺序）。**不叫 `wordmark.ts`**——Windows 文件系统大小写不敏感，会与 `Wordmark.tsx` 冲突（TS1261） |
| `packages/web/src/components/Wordmark.tsx` | 新增 | 渲染 SVG 字样（静态；`currentColor` 描边，颜色交使用处） |
| `packages/web/src/components/Wordmark.test.tsx` | 新增 | 字形几何（坐标在 viewBox 内）、书写顺序、渲染测试 |
| `packages/desktop/splash.html` | 修改 | 前置手写段（0–1.5s）+ 音效3；粒子段延后到 1.5s 起 |
| `packages/desktop/splash.test.js` | 修改 | 手写段与粒子段的起止时刻测试 |
| `packages/desktop/wordmark-drift.test.js` | 新增 | 断言 splash.html 内嵌 path 与 wordmarkGlyphs.ts 逐字节一致 |
| `packages/desktop/splash-config.js` | 修改 | `WRITE_MS`、`BOOT_TOTAL_MS=4500`、可见地板 3200 |
| `packages/desktop/main.test.js` | 修改 | 时序预算断言（4500 / 3200） |
| `packages/desktop/splash-lifecycle.test.js` | 修改 | 可见地板改为 `WRITE_MS + SPLASH_MS + GAP_MS` |
| `packages/web/src/components/BootWave.tsx` | 修改 | 兜底开播 5000 → 7000 |
| `packages/web/src/components/BootWave.test.tsx` | 修改 | 兜底时限断言 |
| `packages/web/src/components/LoginPage.tsx` | 修改 | 左右分栏 + 右侧字样 |
| `packages/web/src/components/LoginPage.test.tsx` | 修改 | 分栏与窄屏退化断言 |
| `packages/desktop/main.js` | 修改 | 启动 `maximize()`；落盘改用 `getNormalBounds()` |

## 9. 部署约束（重要）

桌面端加载的是云端页面（`http://47.92.39.184`），**登录页由云端构建产物渲染**。因此：

- 手写段与窗口最大化：改本地代码 → 重打包即生效
- **登录页分栏：源码改完后必须部署到云端，打包应用里才看得到**；本地 `vite dev` 可先看

## 10. 验证计划

| 项 | 方式 |
|---|---|
| 字形几何 | 单测：所有 path 落在 viewBox 内、书写顺序、各笔画非空、`i` 点最后 |
| 两处字形一致 | `wordmark-drift.test.js` |
| 时序 | `splash-config.test.js` 断言 `BOOT_TOTAL_MS === 4500`、可见地板 3200 |
| 分栏与窄屏 | `LoginPage.test.tsx` |
| 最大化落盘 | `window-state.test.js` |
| **字形观感** | **需要用户过目**——提供预览页（含 2 个风格变体），我无法在本会话截图 |
