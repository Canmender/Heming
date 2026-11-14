# d.141 插件页面内嵌（iframe 宿主）契约

> 状态：实施中。取代 d.124 的「原生 `WebContentsView` 叠层」页面视图方案（§5.1）。
> 起因：用户反馈「插件内容是悬浮在和鸣上，他应该内嵌在其中」——原生视图永远盖在渲染层之上，
> 属于独立窗口观感，不参与 DOM 布局/圆角/浮层层级。改为**渲染层 `<iframe>` 内嵌 `widget://` 页面**。

## 0. 已实测的 Electron 45 行为（feasibility，勿再质疑）

在 `app://heming/index.html` 里 `<iframe src="widget://demo/files/index.html" sandbox="allow-scripts allow-same-origin">`：

- ✅ 正常加载；子框架保留独立 origin `widget://demo`，`localStorage` 可用，`isSecureContext === true`，
  `crypto.subtle.digest` 可用；
- ✅ 子框架内 `fetch('widget://demo/files/data.json')` 正常；
- ✅ `parent.postMessage` → 宿主 `message` 事件，`event.origin === "widget://demo"`、
  `event.source === iframe.contentWindow` 判定可用；
- ✅ 宿主 → 子框架 `postMessage` 可达（事件下行可行）；
- ✅ 协议处理器把 `<script src="/__heming_frame_bridge.js"></script>` 注入到 `<head>` 之后，
  **桥在页面自己的脚本之前就绪**（页面脚本里 `typeof window.__heming_widget === "object"`）；
- ✅ `script-src 'self'` 的 CSP 下注入脚本正常执行（同源）；
- ✅ CSP `frame-ancestors app://heming` 放行本宿主；文档若从别的 origin 加载会被拒（实测 ERR_BLOCKED_BY_RESPONSE）。

结论：**iframe 内嵌可行，且不需要给页面帧任何 preload / node 能力**。桥只经 postMessage 走主窗 preload。

## 1. 目标与不变量

1. 插件页面在**渲染层 DOM 内**（圆角容器内、可被应用自己的浮层/弹窗盖住、跟随布局）。
2. 插件代码仍然只在沙箱里跑：`sandbox="allow-scripts allow-same-origin"`，独立 origin，
   无 preload、无 node、无 Electron API；能力仍只经 `window.__heming_widget`（api 面与 d.124 页面模式一致）。
3. 能力不因内嵌而增加：窗口几何/拖拽/穿透类通道对页面帧一律 unsupported（与 d.124 页面视图同口径）。
4. 导航仍收口：页面帧只能在自己的 `widget://<id>/` origin 内导航，不得开新窗、不得下载。
5. 旧桌面端（没有 `pageOpen` 桥）必须降级，不假定方法存在。

## 2. 主窗桥（`window.__heming_widgets`，`packages/desktop/preload.js`）新增 5 个方法

```ts
/** 打开插件页面：主进程校验并返回要加载的 URL（含 entry 与 #intent）。 */
pageOpen?(input: { id: string; intent?: string }): Promise<WidgetPageOpenResult>;
/** 关闭当前插件页面（切页/卸载）。重复调用无害。 */
pageClose?(): void;
/** 页面帧 → 主进程：camelCase 方法名，主进程按**当前活动页面**授权。 */
pageCall?(input: { id: string; method: string; payload?: unknown }): Promise<WidgetPageCallResult>;
/** 同上但 fire-and-forget（log / openSettings / openPage）。 */
pageSend?(input: { id: string; method: string; payload?: unknown }): void;
/** 主进程 → 当前页面帧的推送；返回退订函数。 */
onPageEvent?(cb: (msg: { id: string; channel: WidgetPageEventChannel; payload: unknown }) => void): () => void;

type WidgetPageOpenResult = { ok: true; url: string; version: string } | { ok: false; error: string };
type WidgetPageCallResult = { ok: true; value: unknown } | { ok: false; error: { code: string; message: string } };
type WidgetPageEventChannel = "settings" | "event" | "lifecycle" | "engine-event";
```

`pageMount` / `pageBounds` / `pageUnmount` **删除**（主进程也不再有页面视图运行时）。

### 2.1 主进程 IPC 通道

| 通道 | 方向 | 载荷 / 返回 |
| --- | --- | --- |
| `widgets:page-open` | 主窗 → 主进程（invoke） | `{ id, intent? }` → `WidgetPageOpenResult` |
| `widgets:page-close` | 主窗 → 主进程（send） | 无 |
| `widgets:page-call` | 主窗 → 主进程（invoke） | `{ id, method, payload? }` → `WidgetPageCallResult`（**不抛**，错误走 `{ok:false}`） |
| `widgets:page-send` | 主窗 → 主进程（send） | `{ id, method, payload? }` |
| `widgets:page-event` | 主进程 → 主窗（send） | `{ id, channel, payload }` |

授权（fail-closed）：所有通道只认**主窗口 webContents**，且要求 `activePage && activePage.id === id`。

## 3. 页面 ↔ 宿主 postMessage 协议

宿主 = 渲染层的 `PluginBundlePage`（React）；子页 = 注入的桥脚本。双方用 `__heming_frame: 1` 区分消息，
宿主**必须**校验 `event.origin === "widget://" + 当前插件 id` 且 `event.source === iframe.contentWindow`。

子页 → 宿主：

```js
{ __heming_frame: 1, kind: "ready" }                                   // 桥就绪（宿主据此撤加载态）
{ __heming_frame: 1, kind: "call", id: 1, method: "dataKeys", args: [] } // id 自增，method 为 camelCase
```

宿主 → 子页：

```js
{ __heming_frame: 1, kind: "result", id: 1, ok: true, value: ... }
{ __heming_frame: 1, kind: "result", id: 1, ok: false, error: { code, message } }
{ __heming_frame: 1, kind: "event", channel: "settings" | "event" | "lifecycle" | "engine-event", payload: ... }
```

宿主收到 `call` 后按方法表拆成 `pageCall`（invoke）或 `pageSend`（send），再回 `result`。
未知方法 → `{ok:false,error:{code:"ERR_WIDGET_UNKNOWN_METHOD"}}`。宿主对 `call` 不设总超时（infohub 可长），
主进程自己的超时照旧。

## 4. 注入的桥脚本 `packages/desktop/widget-frame-bridge.js`

- 纯浏览器 JS，**不得** `require`、不得用 `import`；由 `widget://` 协议在根路径 `/__heming_frame_bridge.js` 原样返回。
- 开头自守卫：`if (window.__heming_widget) { /* 已被 preload 提供（widget 窗口） */ }` 直接 return；
  再守卫 `if (window.parent === window) return;`（不是帧就什么都不做）。
- `window.__heming_widget` 的 API 面与 d.124 页面模式一致：
  - `state()` → `null`；窗口几何/拖拽/穿透方法（`show/hide/toggle/setScale/setInteractive/dragStart/dragMove/dragEnd/resetPosition/setClickThrough`）
    直接返回 rejected Promise，`code === "ERR_WIDGET_PAGE_VIEW_UNSUPPORTED"`（与旧页面模式同码，插件侧 feature-detect 不变）；
  - `reload()` → 本地 `location.reload()`（不 IPC）；
  - `info/settings/setSetting/onSettings/dataGet/dataSet/dataDelete/dataKeys/dataDir/onEvent/onLifecycle/
    openSettings/openPage/chatConfig/engineStatus/engineCall/onEngineEvent/log/infohubCall/notify/homeCardSet`
    → 分别映射到 `pageCall` / `pageSend`；
  - `onEvent/onLifecycle/onEngineEvent/onSettings` 是本地订阅，由宿主推 `kind:"event"` 触发。
- 桥在 `ready` 之后不接受任何 `call`（未 ready 前的调用直接排队/拒绝均可，实现里选一次性握手）。

## 5. `widget://` 协议处理器（`packages/desktop/main.js` + `app-protocol.js`）

1. **保留路径**：`/__heming_frame_bridge.js` → 返回 `widget-frame-bridge.js` 文件内容，
   `Content-Type: application/javascript; charset=utf-8`、`Cache-Control: no-store`；
   该路径先于插件文件解析处理，任何插件文件都不能占用它。
2. **HTML 注入**：对 `.html` / `.htm` 且 200 的响应，在**第一个 `<head...>` 开标签之后**插入
   `<script src="/__heming_frame_bridge.js"></script>`；没有 `<head>` 时插到第一个 `<body...>` 之后；
   都没有则追加到文档末尾。大小上限 8MB，超过则不注入（记日志）。
3. **CSP**：`frame-ancestors` 从 `'none'` 改为 `'self' <主窗 origin 列表>`，由调用方传入：
   至少含 `EMBEDDED_ORIGIN`（`app://heming`）与开发期的 `HEMING_DEV_URL` / `HEMING_WEB_URL` origin。
   其余指令（含 `frame-src 'none'`）不变。
4. **导航守卫**：主窗 `webContents.on("will-frame-navigate")` —— `isMainFrame` 放行；
   子框架只放行 `widget://<activePage.id>/` 前缀，其余 `event.preventDefault()` 并记日志。
5. **下载/开窗**：主窗既有 `setWindowOpenHandler` deny 与 `will-download` 取消逻辑保持生效（页面帧同属主窗）。

## 6. 主进程 `plugin-host.js` 改造

- 删除页面视图运行时：`pageInfo`、`pageContentSize`、`clampPageRect`、`pageWebPreferences`、`attachPageGuards`、
  `destroyPageView`、`pageMount`、`pageBounds`、`pageUnmount`、`syncPageView`、`PAGE_VIEW_FLAG` 相关分支，
  以及 `main.js` 里 `widgets:page-mount|page-bounds|page-unmount` 接线。
- 新增 `activePage = { id, version, url } | null`；`pageOpen({id, intent})` 校验顺序沿用旧 `pageMount`
  （记录存在 → enabled → 有 page 贡献 → entry 合法），`#intent=<token>` 拼接规则不变，返回 `{ok:true, url, version}`。
  entry 解析与 URL 构造放主进程（渲染层不拼 URL）。
- 目标解析新增 `pageFrameTarget(event)`：`event.sender === 主窗 webContents && activePage` →
  `{ isPage: true, isFrame: true, pluginId: activePage.id, record }`。接进 `withRuntimeOrPage`，
  并让 `rejectPageWindowOp` 对帧目标同样拒绝窗口类通道。
- `widgets:page-call|page-send` 的派发：方法表 → 既有 `widget:*` 通道/内部函数（**不新增桥方法、不新增能力**）。
  非法方法 / 非当前页面 → `{ok:false, error:{code:"ERR_WIDGET_PAGE_SCOPE"}}`。
- 推送改造：`notifySettings` 以及事件/生命周期/引擎事件广播里，原来
  `pageInfo.webContents.send("widget:settings", …)` 的位置改为
  主窗 `webContents.send("widgets:page-event", { id, channel, payload })`（仅当 `activePage.id === pluginId`）。
- `widget-preload.js`：删除页面视图模式（`--heming-page-view` 与 `PAGE_VIEW_MODE`），后台常驻模式保留。

## 7. 渲染层 `PluginBundlePage.tsx`

- 结构：`<section>` + `<header>`（保持现有页头）→ 内容区 `rounded-xl border border-line-soft overflow-hidden`
  里放 `<iframe>`（`h-full w-full border-0`、`title`、`sandbox="allow-scripts allow-same-origin"`、
  `referrerPolicy="no-referrer"`）；加载态/错误态叠在 iframe 上（可被应用浮层盖住，这是本次的核心收益）。
- 流程：挂载 → 消费 intent（顺序：先 `setPage` 再 `setPluginPageIntent`，与既有约定一致）→ `pageOpen` →
  `iframe.src = url` → 收到 `ready`（或 `onload` 兜底）撤掉加载态；卸载 → `pageClose`。
- `canMount = typeof widgetsBridge()?.pageOpen === "function"`；缺失 → 沿用「插件页面只在安装版里可用」降级。
- 中继：`window` 上挂一个 `message` 监听，按 §3 校验后拆 `pageCall`/`pageSend` 并回 `result`；
  同时订阅 `onPageEvent`，`msg.id === 当前插件 id` 时把 `{kind:"event", channel, payload}` 投进 iframe。
- 重新加载按钮：让 iframe 重挂（`key` 自增）而不是 `pageBounds` 时代的重建视图。
- 旧 `pageMount/pageBounds/pageUnmount` 调用与 ResizeObserver/rect 测量**全部删除**（内嵌后不再需要）。

## 8. 验收

- `pnpm --filter @heming/web typecheck` / `pnpm --filter @heming/web test` 全绿；
- `pnpm --filter @heming/desktop typecheck` / `test` 全绿（含新增 frame 相关用例）；
- 真机：`pnpm --filter @heming/desktop start` 打开信息中枢插件页，页面**在内容卡片内**（圆角内、不被原生层覆盖），
  打开应用自己的弹窗能盖住它；插件页里的 infohub 数据、设置热更新、事件推送仍正常。

## 9. 实施记录（d.141.3.78.11 落地后补写）

实施与本文档的偏差（均收紧，未放宽任何一条）：

- 主窗 CSP 额外补了 `frame-src 'self' app: widget:`（本文档 §5 只写了 widget 侧的 `frame-ancestors`）。
  宿主默认策略是 `default-src 'self' app:`，不补这一条的话宿主压根不许嵌 `widget://` 帧；
  只放方案级来源，具体可嵌哪个插件仍由 §5 的 `will-frame-navigate` 逐次校验。
- `pageFrameTarget` 在「sender === 主窗 webContents」之外，额外要求 `event.frame === wc.mainFrame`：
  同进程其它帧也不能冒充页面帧。
- `widgets:page-event` 只由主进程发往主窗（`send`），**不进** `main.js` 的 `TRUSTED_CHANNELS`
  ——那条清单要求每个通道都有注册点，而它没有；`main.test.js` 改为断言「只发不注册」。
- 授权做了两层：`main.js` 侧 `isMainWindowSender` + `activePageOwns`，`plugin-host.pageCall` 内再校验
  `activePage.id === input.id`。

真机验收（Electron 45.2.1 + 真实安装的 `heming.infohub` 1.4.0，数据根用 `HEMING_DATA_ROOT` 隔离，
后端用本地 `packages/server` + `HEMING_SEED_USERS` 起的临时库）：

- 主窗 DOM 里页面就是 `iframe[data-testid="plugin-page-frame"]`，
  `src=widget://heming.infohub/files/index.html#intent=search`（intent 照常透传），
  位于 `rounded-xl`（12px）+ `overflow:hidden` + 1px 描边的卡片内，页头在帧外；主窗内 `webview` 计数 0。
- 帧内 `window.__heming_widget` 由注入的 `/__heming_frame_bridge.js` 提供（33 个方法与
  `widget-preload.js` 一一对应）：`info()` 返回 `{pluginId:"heming.infohub", pluginName:"信息中枢",
  appVersion, theme:"light"}`，`dataKeys()` 返回 `["homecards"]` —— 说明 postMessage → 主窗 → 主进程的
  往返链路通；窗口类 `show()` / `setScale()` 抛 `ERR_WIDGET_PAGE_VIEW_UNSUPPORTED`，`state()` 解析为 `null`。
- 插件页打开时按 Ctrl+K：命令面板（`role="dialog"`）盖住帧，帧中心 `elementFromPoint` 命中的是浮层里的
  DIV 而不是 `IFRAME` —— 这就是本次要解决的问题（此前原生视图永远在最上层）。
- 未能验证的部分：`pnpm --filter @heming/desktop start`（`electron .`）在本机会话的 **bash 执行器**里
  起 GUI 进程必崩（`EXIT=-2147483645 / 0x80000003`，`git stash` 到改动前同样崩，与本轮无关）；
  真机验收改由桌面 Shell 启动同一份代码完成（`.tmp/launch-heming.cmd` + 快捷方式）。

### 9.1 后续补丁 d.141.3.79.11（2026-11-14）：沙箱委派

iframe 内嵌落地后，真机逐页审计（自动化 / 信息中枢 / 建模室 / 剪辑室）确认四个页面插件全部已内嵌，
但检查出**能力委派缺失**，导致插件自身功能静默失效：

- `<a download>` 的导出在 `sandbox` 帧里被静默丢弃（信息中枢导出归档）。
- `requestFullscreen` 受权限策略门控（剪辑室预览全屏）。
- `navigator.clipboard.writeText` 在跨源帧里需宿主显式委派（信息中枢 / 建模室「复制」）。

因此宿主 iframe 改为 `sandbox="allow-scripts allow-same-origin allow-downloads"`
+ `allow="fullscreen; clipboard-write"` + `allowFullScreen`。仍未给 `allow-popups` /
`allow-top-navigation`：插件不能开窗、不能把宿主导航走；下载必须由用户手势触发并经系统「另存为」确认。
真机验证：信息中枢帧内点击 blob 导出 → 出现原生另存为对话框（窗口标题 `blob:widget://heming.infohub/…`）；
剪辑室帧内 `requestFullscreen()` → `document.fullscreenElement` 为真。剪贴板在无焦点帧里
`NotAllowedError: Document is not focused` 属自动化环境限制（真实点击可用，插件另有 `execCommand` 兜底）。