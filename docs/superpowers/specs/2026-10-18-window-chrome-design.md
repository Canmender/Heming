# 桌面窗口视觉优化（自定义标题栏）· 设计文档

- 日期：2026-10-18
- 范围：`packages/desktop`（窗口配置）+ `packages/web`（标题栏渲染）
- 状态：待实施

---

## 1. 背景与目标

当前桌面窗口使用**系统原生标题栏**（`main.js` 未设置任何 `titleBarStyle`），窗口背景为纯白 `#ffffff`。问题：

- 原生标题栏（Win 经典灰白）与应用的极简灰白设计语言（`#fafafa` / `#ececec` / 墨黑 `#1a1a1a`）割裂
- 无圆角、无阴影，窗口悬浮感弱
- 启动时纯白背景闪一下

**目标**：改为行业主流的**自定义标题栏**方案——隐藏系统标题栏，内容区延伸到窗口顶部，保留原生窗口控件（最小化/最大化/关闭）但可自定义其配色与高度。

## 2. 行业调研结论

主流桌面应用（VS Code、Slack、Discord、Notion、Obsidian、Figma、Linear）**绝大多数已抛弃系统原生标题栏**，共同模式：

| 模式 | 说明 |
|---|---|
| 隐藏系统栏 | `titleBarStyle: 'hidden'`，内容区延伸到窗口顶部 |
| 顶部拖拽带 | 约 32–40px，`-webkit-app-region: drag` |
| 窗口控件融入配色 | 控件颜色跟随应用主题，而非系统灰 |
| 圆角 + 细描边 | Win11 由 DWM 自动圆角 |

**技术选型**（依据本地 `electron@31.7.7/electron.d.ts` 实测）：

| 方案 | API | 取舍 |
|---|---|---|
| **A. titleBarOverlay（选用）** | `titleBarStyle: 'hidden'` + `titleBarOverlay: {color, symbolColor, height}` | **保留原生控件**——Win11 贴靠布局（hover 最大化按钮）等系统特性可用；只需自定义配色与高度 |
| B. 全自绘控件 | `titleBarStyle: 'hidden'` + IPC 接 minimize/maximize/close | 控件完全可控，但**丢失原生贴靠布局**，需处理双击最大化、拖拽缩放等边界 |
| C. Mica 材质 | `backgroundMaterial: 'mica'` | Win11 原生云母材质，但**按壁纸着色**（蓝/紫/暖橙），与和鸣克制的灰白调性冲突；且需 Win11 22H2+，Win10 仅纯色回退 |

**决策：方案 A**。理由：原生控件更稳健（贴靠布局是 Win11 的核心交互，自绘即丢失）；Mica 撞调性；A 已能满足"干净、克制、与卡片语言一致"的目标。

## 3. 视觉规格

| 项 | 值 | 说明 |
|---|---|---|
| 标题栏高度 | 38px | 比 Win 原生（约 32px + 菜单栏）更紧凑 |
| 标题栏背景 | `#fafafa` | 与左侧导航轨同色，视觉上连成一片 |
| 控件符号色 | `#666666` | 与导航图标 `text-[#666]` 一致 |
| 窗口背景 | `#fafafa` | 替代纯白，消除启动白闪 |
| 圆角 | 系统管理 | Win11 由 DWM 自动；`roundedCorners` 仅 macOS 有效，不设置 |
| 标题栏文字 | **无** | 遵循既有偏好「界面 chrome 不显示产品名」；导航轨已指示当前页 |

标题栏内容：**空的拖拽带**（Linear / Notion 风格）。不加页面名等文字，保持克制；后续如需可低成本追加。

## 4. 平台分支

```js
// win32 / linux
{ titleBarStyle: "hidden",
  titleBarOverlay: { color: "#fafafa", symbolColor: "#666666", height: 38 } }

// darwin：控件在左上，用 trafficLightPosition 微调位置
{ titleBarStyle: "hidden",
  trafficLightPosition: { x: 14, y: 12 } }
```

## 5. 渲染端检测（关键设计）

桌面端与浏览器端加载**同一份 web bundle**（`http://47.92.39.184`）。标题栏**只在 Electron 内渲染**，浏览器直接访问时保持现有布局。

**检测方式**：`window.heming`（由 `preload.js` 的 `contextBridge` 暴露，浏览器中不存在）。

```tsx
const isDesktop = typeof window !== "undefined" && !!window.heming;
```

**不修改 `preload.js`**——只读取既有字段，避免与 boot-animation 会话（其计划要改 preload 暴露 `__onBootReady`/`__startBootWave`）冲突。

## 6. 拖拽区与控件避让

用 Electron 提供的 CSS 环境变量（`titleBarOverlay` 启用时自动注入），避免手写死高度导致两处漂移：

```css
height: env(titlebar-area-height, 38px);
margin-left: env(titlebar-area-x, 0px);
width: env(titlebar-area-width, 100%);
```

- `titlebar-area-width` 自动排除右侧窗口控件区（macOS 则排除左侧红绿灯），拖拽区不会盖住控件
- 兜底值保证非 Electron 或变量缺失时不塌陷

## 7. 与 boot-animation 会话的冲突面

boot-animation 会话（`docs/superpowers/plans/2026-10-18-boot-animation.md`）计划修改 `main.js` / `preload.js` / `App.tsx` / `desktop/package.json`。本设计的避让策略：

| 文件 | 冲突风险 | 避让 |
|---|---|---|
| `preload.js` | 对方要改 | **本设计不碰**（只读 `window.heming`） |
| `main.js` | 对方加 `createSplashWindow` | 本设计只改 `BrowserWindow` 的构造参数 + 新增 `title-bar.js` 模块，不碰 splash 逻辑 |
| `App.tsx` | 对方加 `bootDone` 早返回 | 本设计改**最终 return 的包装结构**，对方的早返回在 `if (!authUser)` 之前——位置不同 |
| `desktop/package.json` | 对方加 `splash.html` | 本设计加 `title-bar.js` 到同一 `files` 数组（数组内容合并，非冲突） |

## 8. 文件变更清单

| 文件 | 动作 | 说明 |
|---|---|---|
| `packages/desktop/title-bar.js` | 新增 | 纯函数 `titleBarOptions(platform)` + 常量（可单测，仿 `secure-origins.js` 模式） |
| `packages/desktop/title-bar.test.js` | 新增 | 平台分支单测 |
| `packages/desktop/main.js` | 修改 | 展开 `titleBarOptions`，`backgroundColor` 改 `#fafafa` |
| `packages/desktop/package.json` | 修改 | `build.files` 加入 `title-bar.js` |
| `packages/web/src/components/TitleBar.tsx` | 新增 | 拖拽带组件（非桌面端渲染 null） |
| `packages/web/src/components/TitleBar.test.tsx` | 新增 | 检测分支 + 拖拽区属性单测 |
| `packages/web/src/App.tsx` | 修改 | 最终 return 包一层纵向 flex，顶部放 `<TitleBar />` |
| `packages/web/src/components/LoginPage.tsx` | 修改 | `h-screen` → `h-full`，背景 `#fafafa`（与标题栏连片，白卡更突出） |

## 9. 测试要点

- `titleBarOptions("win32")` 返回 `titleBarOverlay`，且 `color`/`symbolColor`/`height` 与常量一致
- `titleBarOptions("darwin")` 返回 `trafficLightPosition`，**不含** `titleBarOverlay`
- 两种平台均含 `titleBarStyle: "hidden"`
- `TitleBar` 在无 `window.heming` 时渲染 `null`
- `TitleBar` 在有 `window.heming` 时渲染拖拽带，含 `-webkit-app-region: drag` 与三个 env 兜底变量
- `App` 回归：登录页/主壳既有断言不破

## 10. 不做与风险

| 项 | 原因 |
|---|---|
| Mica / Acrylic 材质 | 撞灰白调性；需 Win11 22H2+ |
| 自绘窗口控件 | 丢失 Win11 原生贴靠布局 |
| 暗色模式 | 全站目前只有亮色一套变量，单独给标题栏做暗色无意义 |
| 标题栏文字 | 遵循「chrome 不显示产品名」；导航轨已指示当前页 |

**已知限制**：Win10 无自动圆角（`roundedCorners` 仅 macOS）；`titleBarOverlay` 在 Linux 上不受支持（当前只构建 Win 安装包，无影响）。
