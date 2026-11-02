# d.46 · 桌宠：和鸣智能体的桌面化身（Live2D）

- 日期：2026-11-01
- 相关版本：d.45.1.11.0（写作基线）、d.52.1.13.0（合入基线）、本 spec = **d.53.1.13.0**（特性位 +1）
- 涉及包：`packages/desktop`（独立透明窗口 + 托盘 + 鼠标穿透 + 位置记忆 + preload 桥）、`packages/web`（`?hemingWindow=pet` 分支、Live2D 舞台、气泡对话、设置项）、`packages/web/public/pet`（Cubism Core + 示例模型）
- 上游判断：和鸣已经是「个人智能体工作台」，但智能体的存在感只发生在打开窗口之后——关掉窗口，它就从桌面上消失了。桌面化身是把「它一直在那儿」这件事做出来的最小形态。

> **编号说明（2026-11-02 补记）**：本文写作时基线为 d.45，故原编号为 d.46。合入前 main 已推进到 d.52.1.13.0，`d.46–d.48` 被信息中枢原生融入 / 自动化中心 / 常驻幕僚占用，两份设计稿亦预留了 d.53/d.54 —— 本文最终以 **d.53.1.13.0** 合入，两份设计稿顺延为 d.54/d.55。文件名保留写作日期的 d46 前缀，避免破坏既有链接。

## 0. 问题

- **智能体没有「在场感」**：现在要跟它说话必须先开主窗口、找会话、@ 它。桌宠要解决的是「随手点一下就说话」，而不是再做一个聊天入口。
- **透明置顶窗口不能白给**：一个盖在所有窗口之上的透明层，如果鼠标穿透没做对，用户会发现自己点不中桌面图标、拖不动别的窗口——这比没有桌宠更糟。
- **不能把 LLM 逻辑写第二遍**：模型 Key、供应商协议、工具、记忆全在渲染层的 `lib/` 里，且红线是「Key 只进供应商请求头」。桌宠若另起一套调用，等于把 Key 的处理逻辑复制一遍，迟早分叉。
- **不能把 1MB 渲染库塞进主包**：pixi + Live2D 只服务桌宠，主窗口用户不该为它买单。
- **授权必须可交代**：Live2D 的运行时是专有软件，模型素材另有条款。能打包进安装包的只有明确允许再分发的那几个文件。

## 1. 决策

### A. 窗口形态：独立透明悬浮窗

`packages/desktop/pet-window.js`（纯函数 + 窗口管理，可 `node --test`）：

```
transparent: true, frame: false, alwaysOnTop: true,
skipTaskbar: true, resizable: false, maximizable: false, minimizable: false,
hasShadow: false, backgroundColor: "#00000000",
webPreferences: { preload, sandbox: true, contextIsolation: true, backgroundThrottling: false }
```

- **`backgroundThrottling: false` 是硬要求**：桌宠是常驻置顶窗，但一旦被其他窗口完全遮挡，Chromium 会判定其不可见并暂停 `rAF`——表现是「切到别的应用再回来，角色卡在上一帧」。这与 splash 窗口踩过的坑同源（`splash-config.js:67`）。
- **默认尺寸 300×420**（半身立绘比例），缩放系数 `0.6 / 0.8 / 1.0 / 1.25 / 1.5` 由设置决定，窗口按 `Math.round(300 * scale)` 重算。
- **默认位置**：主显示器工作区右下角，距右/下各 24px。位置落 `userData/pet-state.json`（与 `window-state.js` 同目录、同风格），不进 localStorage（窗口几何属于主进程）。
- **不抢焦点**：首次显示用 `showInactive()`。用户点角色呼出输入框时窗口本就会拿到焦点，不需要额外处理。

### B. 鼠标穿透：默认穿透，按可交互区动态关闭

这是本设计的核心风险点。策略：

1. 窗口创建后立即 `setIgnoreMouseEvents(true, { forward: true })`——**默认不挡任何桌面点击**。
2. `forward: true` 让渲染进程在穿透状态下仍能收到 `mousemove`（Electron 在 Windows / macOS 上的既有能力）。
3. 渲染层把「光标是否落在可交互区」这一**布尔**上报给主进程（`pet:set-interactive`）。
   - 可交互区 = 角色包围盒 ∪ 气泡区 ∪ 输入框区，由渲染层按当前布局计算，主进程不重复算。
4. 主进程据此 `setIgnoreMouseEvents(!interactive)`。

边界与兜底：

- **只上报布尔，不上报坐标**：主进程不需要知道鼠标在哪，只需要知道「现在该不该拦」。这避免了高频 IPC 传坐标。
- **上报节流 50ms 且仅在值变化时发送**：`mousemove` 是高频事件，逐次 IPC 会让主进程空转。
- **窗口失焦时不重置为穿透**：用户可能正在气泡里选中文字。
- **穿透模式下右键菜单不可用**：这是穿透的固有代价，因此托盘菜单必须提供「关闭穿透」开关作为出口。

### C. 渲染：独立窗口复用 web 产物，懒加载

沿用 `CallWindow` 的既有模式（`packages/web/src/main.tsx`）：

```tsx
const isPetWindow = parsePetWindowParams(window.location.search) !== null;
{isPetWindow ? <PetWindowLazy /> : <App />}
```

- `PetWindow` 用 `React.lazy` + 动态 `import()`：**pixi 与 live2d 只在桌宠窗口加载**，不增加主窗口首屏体积。
- **同源带来的复用**：`app://heming` 下 localStorage 天然共享，LLM 连接配置（`heming.llmConfigs`）、智能体绑定（`heming.agentLlm`）、智能体提示词（`heming.agentPrompts`）直接读；对话走**同一个** `streamChat`（`lib/llmClient.ts`），Key 红线不旁路。
- **不做跨进程 RPC**：桌宠窗口自己持有对话逻辑，主进程只负责窗口。这样不引入「主窗口关了桌宠就哑了」的耦合，也不需要在 IPC 上搬运 Key。

### D. 渲染管线：pixi + pixi-live2d-display（Cubism 4）

- 依赖：`pixi.js@6.5.10` + `pixi-live2d-display@0.4.0`，入口 `pixi-live2d-display/cubism4`（真 ESM，不污染全局 `PIXI`）。
- `Live2DModel.registerTicker(PIXI.Ticker)` 接管模型更新，不用 `window.PIXI`。
- 资源经 `app://heming/pet/...` 加载（自定义协议已注册 `supportFetchAPI` + `standard`，可 `fetch`）。
- **Cubism Core 在页面里动态注入**：`live2dcubismcore.min.js` 是 UMD/全局脚本，不是 ESM 模块。渲染前用 `<script src="...">` 加载一次并 await `onload`，失败则显示可读错误而不是白屏。

角色表现：

| 能力 | 实现 |
|---|---|
| 呼吸 / 眨眼 / 头发摆动 | 模型自带（Cubism 参数 + physics3），不另写 |
| 视线跟随鼠标 | `model.focus(x, y)`，坐标归一化到窗口内；鼠标离开窗口回正 |
| 待机动作 | `motion("Idle")` 由 `IdleMotionGroup` 自动轮播（模型内置 9 组） |
| 点击反应 | 命中 `HitArea` → `motion("TapBody")`（模型内置 1 组） |
| 说话口型 | 流式文字到达时驱动 `ParamMouthOpenY`（模型 `LipSync` 组），按到达节奏振荡后回 0 |

### E. 模型资源与授权

`packages/web/public/pet/`：

- `live2dcubismcore.min.js`（207KB）：取自 Live2D 官方 CDN。SDK 自带 `RedistributableFiles.txt` 明确把该文件列为 **Redistributable Code**（允许随应用再分发），文件头版权声明保留不动。
- `Hiyori/`（约 4.8MB）：Live2D 官方示例模型，`CubismWebSamples` 仓库，遵循 **Free Material License**。
- `README.md` 写清两者授权与替换方式。

**模型按标准 Cubism 目录约定加载**（一个 `*.model3.json` + 它引用的 moc3 / 贴图 / 物理 / 动作），换形象只需换目录 + 改设置里的路径，渲染代码不动。

### F. 交互

| 操作 | 行为 |
|---|---|
| 左键拖拽角色 | 移动窗口（渲染层记按下点，经 IPC 逐帧告知主进程 `setPosition`，位移在**主进程**按屏幕坐标计算，避免渲染层与主进程各自维护一份窗口位置） |
| 单击角色 | 底部浮出输入框（对话） |
| 双击角色 | 播放 `TapBody` |
| 右键 | 应用内菜单：对话 / 穿透模式 / 缩放 / 隐藏 / 设置 |
| 滚轮 | 不做（易误触；缩放在菜单里） |

**拖拽的坐标真相只有一个**：渲染层只上报「按下 / 移动了 (dx, dy) / 抬起」和按下时的初始窗口坐标，主进程用 `screen.getCursorScreenPoint()` 计算最终位置——因为窗口本身在动，渲染层的 `clientX` 会随窗口移动而失真。

### G. 托盘

`Tray` + 生成式图标（`packages/desktop/assets/pet-tray.png`，32×32，细线风格，无 emoji）。

菜单：显示/隐藏桌宠 · 穿透模式（勾选）· 隐藏（Esc 级出口）· 退出和鸣。

- 托盘是穿透模式的**唯一可靠出口**，因此必须常驻。
- 桌宠被隐藏时托盘项变为「显示桌宠」。
- 应用退出时销毁托盘与窗口。

## 2. 数据边界

| 数据 | 位置 | 上云 |
|---|---|---|
| 桌宠开关 / 缩放 / 绑定智能体 / 穿透偏好 | localStorage `heming.pet.v1` | 否 |
| 窗口位置与尺寸 | `userData/pet-state.json` | 否 |
| 对话内容 | 仅窗口内存，关窗即散 | 否 |
| LLM Key | 读 `heming.llmConfigs`（d.36 起为 `safeStorage` 信封） | 否 |

- 桌宠**不写会话**、不进消息列表、不走 WS、不落 `msgCache`。它是一次性对话，不是会话——这是刻意的：让「随手问一句」不污染会话列表。
- 无 LLM 连接配置时不假装能对话：气泡直接说「还没配置模型连接」，点击跳设置区。

## 3. 明确不做

- **不做语音**：TTS / ASR 需要额外模型与运行时，另立规格。
- ~~**不做消息感知**~~ → **已在 d.53.1.14.0 补上（未读感知）**：第一期确实不建 WS、不读未读；第二期补了独立连接与未读角标。两个既有边界（d.39）的答案是：桌宠建**自己的**一条轻量连接（因为主窗口关闭后它必须还在），且**只计数不解密正文、不弹系统通知**。仍未做：正文预览、免打扰联动、系统级徽章。
- **不做多形象商店 / 模型市场**：只支持「一个内置默认 + 手动指定目录」。
- **不做表情包 / 道具 / 亲密度**等养成系统。
- **不保证盖住独占全屏应用**：Windows 上独占全屏（游戏）会盖住所有置顶窗，这是系统行为，不做绕过。
- **不做 macOS 特定适配验证**：本轮只在 Windows 真机验证。

## 4. 验收形态

1. `pnpm -r build && pnpm -r --workspace-concurrency=1 test` 全绿（desktop 新增 `pet-window.test.js` 用例）。
2. 启动桌面端 → 右下角出现 Hiyori，呼吸/眨眼正常，视线跟随鼠标。
3. 双击角色 → 播放 TapBody；单击 → 输入框浮出。
4. 配好 LLM 后输入一句话 → 气泡流式输出 + 口型动。
5. **穿透验证（最关键）**：光标移出角色 → 能点中桌宠背后的桌面图标；光标移到角色上 → 能拖动窗口。
6. 关闭主窗口 → 桌宠仍在且可对话（不依赖主窗口）。
7. 托盘菜单可隐藏/唤回/切穿透/退出。
8. 重启应用 → 桌宠位置与缩放保持。

## 5. 风险与已知边界

- **`forward: true` 的平台差异**：Windows / macOS 支持，Linux 不保证。若穿透态收不到 `mousemove`，可交互区判定失效 → 表现为「角色永远点不中」。兜底：菜单与托盘提供「关闭穿透」，关掉后窗口正常接收鼠标。**真机必须实测这一条**。
- **透明窗口 + 硬件加速**：少数 GPU 驱动下透明窗口会出现黑底。兜底：`backgroundColor: "#00000000"` + 若实测出黑底再评估 `disableHardwareAcceleration`（那是全局代价，能不启用就不启用）。
- **拖拽期间的高频 IPC**：按 `requestAnimationFrame` 节流，抬起时补一次终值，避免丢最后一段位移。
- **模型换装无 UI 校验**：用户填错路径时，模型加载失败要显示可读原因（哪个文件 404），不白屏。
- **多显示器**：位置记忆跨显示器时按 `displayWorkAreas()` 校验，落在屏幕外则回落到主屏右下角（复用 `window-state.js` 的思路）。

## 6. 实施记录与验证证据（2026-11-01 实跑）

### 6.1 门禁

| 包 | 结果 |
|---|---|
| shared | 2 文件 / 79 例 |
| server | 9 文件 全通过 |
| web | **139 文件 / 2221 例**（本轮 +43：`petWindow` 3 + `petPrefs` 13 + `petInteraction` 16 + `usePetChat` 11） |
| desktop | **365 例**（本轮 +55：`pet-window` 35 + `pet-host` 20） |
| typecheck | 四包全通过 |

### 6.2 真机验证（真实 Electron，非 jsdom）

用 Electron 主进程加载构建产物（`app://heming/pet.html` + 真实 `pet-host.js`），逐条确认：

1. **窗口几何**：`bounds {x:120,y:160,width:302,height:422}`（302/422 是 Windows 边框补偿）、`isVisible:true`、`isAlwaysOnTop:true` —— 位置记忆与置顶成立。
2. **渲染**：`Live2DCubismCore` 注册成功（Core 5.1.0）、PixiJS 6.5.10 / WebGL 2、canvas 自适应为 453×633（300×420 @ DPR 1.5），`capturePage()` 截图可见 Hiyori 全身立绘、透明背景、底边贴窗口下沿。
3. **桌面可见**：带 `visible:true` 的状态文件启动完整应用后，角色以无边框形态浮在最大化主窗口之上，位置即记忆的 (120,160)。
4. **打包产物**：`pet.html` 只加载 `pet-*.js`(12.7 kB) + `petPrefs-*.js`(158 kB) 共享 chunk，**不含** `main-*.js`(1.3 MB) 与全局 CSS；pixi(259 kB)/cubism4(120 kB) 为运行时动态加载。

### 6.3 真机上暴露并修掉的三个缺陷

1. **`canvasRef.current` 首渲染为 null** → `useLive2D` 的 effect 拿到 null 早退，ref 后续赋值不触发重渲染 ⇒ 模型永不加载，且控制台无任何报错。改为 `useState` 承载 canvas 元素。
2. **`window.location.origin` 在自定义 scheme 下不可靠** → 拼出的 Core 与模型地址落空。改为从 `href` 截掉文件名得到目录基址。
3. **状态文件带 UTF-8 BOM 时 `JSON.parse` 抛错**（被 catch 吞成 null）⇒ 桌宠静默不出现。新增 `parsePetStateJson` 纯函数剥 BOM，并补 3 例单测锁住。

### 6.4 一条**验证方法**上的教训

首轮验证用 `pnpm --filter @heming/web dev` 起的 dev server，结果 `/pet.html` 被 SPA 回落成 `index.html`，且模块解析指向了旧检出路径（`D:/Heming`）——**dev server 不能用来验证这个功能**。改用 `app://` 协议加载 `dist` 产物后才与安装版一致。

另外：验证脚本若没有注册 `app:version` / `secret:available` 这两个同步 IPC，preload 的 `sendSync` 会走进「无监听器」分支，**连带导致页面脚本不执行**（表现为模型不加载）。真实 `main.js` 里这两个 handler 在创建窗口前已注册，所以不影响产品；但任何人重跑这类验证脚本都必须先补上它们。
