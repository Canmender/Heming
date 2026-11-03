# 桌宠

> 桌面上的 Live2D 化身：关掉主窗口它还在，点它就能说话，有消息它会提醒。

本文面向两类读者：**使用者**（怎么开、怎么关、哪里调）与**维护者**（改哪里、怎么加东西）。
设计取舍与决策过程见 `docs/superpowers/specs/2026-11-01-d46-desktop-pet.md`（文件名沿用写作时的编号）。

---

## 1. 怎么用

| 动作 | 结果 |
|---|---|
| 设置区 → 外观 → 桌宠 → 「在桌面显示桌宠」 | 出现/收起桌宠（默认**不自动出现**） |
| 单击角色 | 浮出输入框，说一句话 |
| 双击角色 | 播一次「开心」动作 |
| 拖动角色 | 移动窗口（位置记住，重启后回来；松手会贴边吸附，拖出屏幕也会被拉回可见区） |
| 点右上角红色角标 | 叫起主窗口并打开那个会话 |
| 右键角色 | 菜单：说点什么 / 放大 / 缩小 / 设置 / 隐藏 |
| 托盘图标左键 | 显隐切换；右键有完整菜单含「退出」 |

**如果角色点不中**：多半是鼠标穿透。设置区 → 外观 → 桌宠 → 关掉「鼠标穿透」，或从托盘菜单关。
穿透模式下只有角色、气泡、角标、输入框会拦截鼠标，其余区域点击直接落到桌面。

**说话用哪个模型**：设置区可绑定某个智能体的模型连接；不绑定就用第一个可用连接。
没配任何连接时，点它会直接说「还没有可用的模型连接」并给一个「去设置」。

---

## 2. 架构：谁负责什么

```
主进程 packages/desktop/pet-host.js      ← 窗口、托盘、穿透、位置记忆、拖拽
   │  pet-window.js  纯函数：几何 / 缩放 / 位置夹取 / 拖拽收尾吸附与钳制 / 地址拼接 / 状态解析
   │
   ├─ preload.js  __heming_pet 桥（12 个动作 + 2 个订阅）
   │
渲染进程 packages/web/src/pet.tsx        ← 独立入口 pet.html，不加载主应用
   ├─ components/pet/PetWindow.tsx   画面 + 输入 + 角标 + 气泡
   ├─ components/pet/useLive2D.ts    pixi + Cubism 装配（动态 import）
   ├─ components/pet/petInteraction.ts  命中判定 / 点击 vs 拖拽 / rAF 合并（纯函数）
   ├─ lib/petPose.ts                 姿态判定与表现映射（纯函数）
   ├─ lib/petPrefs.ts                本机偏好（开关 / 绑定 / 模型路径）
   ├─ lib/petUnread.ts               未读归约（纯函数 + 一条自己的 WS）
   └─ lib/petEvent.ts                主进程 → 桌宠的事件契约（校验，纯函数）
```

**两个渲染进程**：主窗口与桌宠各是一个独立的 `BrowserWindow`，同源、共享 localStorage，
但内存不共享。所以桌宠读不到主窗口的 store——它需要什么就自己订阅什么（这就是 `petUnread` 存在的理由）。

**为什么 `pet.html` 是独立入口**：`main.tsx` 静态 import 了整个 `App`，即使加 query 分支，
浏览器也会下载整套应用代码（含聊天、Markdown、KaTeX，约 1.5 MB）。桌宠是常驻窗口，
只该付 pixi + Live2D 的钱（入口 14 kB + 共享 chunk 158 kB + 运行时按需加载 259/120 kB）。

---

## 3. 数据边界

| 数据 | 存在哪 | 说明 |
|---|---|---|
| 开关 / 绑定的智能体 / 模型路径 | `localStorage: heming.pet.v1` | 只在本机，不上云、不导出 |
| 窗口位置 / 缩放 / 穿透开关 | `userData/pet-state.json` | **主进程持有**——缩放决定窗口像素尺寸，两处各存一份必然打架 |
| 对话内容 | **不落盘** | 桌宠对话是一次性的：不写会话、不进消息列表、不落明文缓存 |
| 未读计数 | 内存 | 窗口关闭即丢，重连后由服务端事实补齐 |
| 模型文件 | `packages/web/public/pet/` | 随包分发，见该目录 README 的授权说明 |

---

## 4. 扩展指南

### 4.1 换形象

把模型放进 `packages/web/public/pet/<名字>/`，在设置区填相对路径（如 `pet/Shizuku/shizuku.model3.json`）。
要求：标准 Cubism 3/4 模型（`.model3.json` 入口）。换完会自动重载桌宠页。

模型**没有**某些动作组不会报错——`playMotion` 找不到就静默跳过。

### 4.2 加一种姿态

打开 `lib/petPose.ts`：

1. 在 `PetPose` 联合里加一项（如 `"shy"`）；
2. 在 `PET_POSES` 表里给它一条映射（`enterMotion` / `mouth`）；
3. 在 `resolvePose` 的优先级链里决定它什么时候生效。

测试 `lib/petPose.test.ts` 会检查「每个姿态都有映射」，漏了会红。
渲染代码不需要改——它只认姿态，不认动作组名。

**克制原则**：`PET_POSES` 里只有「开心」配了进入动作。桌宠常驻桌面，
每种状态都播一次动作很快会变成噪音；其余状态交给角标、口型、输入框这些视觉元素表达。

### 4.3 让桌宠对平台事件做出反应（**已接线：任务收尾 / 日程临期 / 幕僚简报**）

```
主进程 petHost.pushEvent(payload)             // 主进程内部直接推（不做 gating）
   或 主窗口 window.__heming_pet.emit(payload) // 主窗口发起，主进程校验来源后转发
        ↓  IPC: pet:event
桌宠 window.__heming_pet.onEvent(cb)          // PetWindow 已订阅并消费
```

事件契约在 `lib/petEvent.ts`，支持五种（`speak`/`task`/`schedule` 可带 `route` 用于点击直达）：

| kind | 效果 | 现在的来源 |
|---|---|---|
| `pose` | 覆盖当前姿态 4 秒（显式表达，发送方负责语义） | 预留（暂无生产者） |
| `speak` | 气泡显示一句话，**4 秒**收回 | 幕僚简报（无临期日程时） |
| `task` | 「完成了：xxx / 没成功：xxx」 | 任务收尾（`ChatPage` 的 `onRunSettled` 与任务区落库，均经通知中心） |
| `schedule` | 「19:00 晚自习」 | 日程临期（幕僚巡检触发、信息中枢议程里最紧急的一条） |
| `reset` | 清掉外部姿态与文案 | 预留（事件自带过期，一般不需要） |

**生产者怎么接的（零侵入）**：不改造任务/幕僚/信息中枢的代码。`lib/petEvent.ts` 的
`startPetPresence()` 在 App 挂载时订阅**通知中心新增条目**，把「已经决定要让用户知道」的通知
派生为桌宠事件：
- `kind:"task"` 通知 → 剥掉「已完成 / 执行失败 / 已中断」后缀，只留任务标题；
- `kind:"staff"` 通知 → 若有临期日程（复用 `staff/model.agendaBucket` 的 24h 判据）给
  `schedule`（标题 + `HH:MM`），否则给 `speak`（「幕僚简报：<summary 截断>」）。

**谁来决定该不该开口（渠道互斥，单一判据）**：
1. 主窗口在前台（`document.hasFocus()` + 可见）→ 只进通知中心，桌宠不冒泡（主进程 `pet:emit`
   还会再用 `main.isFocused()` 判一次，跨进程边界不信任调用方）；
2. 主窗口不在前台 → 桌宠冒泡；桌宠隐藏时事件**直接丢弃，不排队、不补发**；
3. 同一事件 10 分钟内只冒泡一次，10 分钟内最多 3 次（批量任务收尾不刷屏）。

**三档打扰强度**（设置区 → 外观 → 桌宠 → 打扰强度，存 `heming.pet.presence.v1`，默认正常）：

| 档位 | 行为 |
|---|---|
| 安静 | 只换姿态（成功=开心/失败与日程=提醒/简报=说话），不冒泡 |
| 正常（默认） | 只冒泡 4 秒后收回，不动姿态 |
| 积极 | 姿态 + 气泡；成功任务的「开心」会顺带播一次 TapBody（唯一带进入动作的姿态） |

**点击气泡直达**：气泡带 `route` 时点击/回车会复用既有 `pet:open-settings` 通道并带 page，
主进程白名单归一（settings/team/tasks/staff/infohub）后转给主窗口，App 按 page 切页。

**边界**：payload 跨进程一律不可信，消费端先用 `parsePetEvent` 校验（畸形静默忽略）；
气泡只带「类型 + 标题级信息」（任务标题 / 简报摘要 ≤60 字 / 日程标题+时刻），**不带结果正文、
工具参数、会话名或发送人**；桌宠不写会话、不进消息列表、不落 msgCache；错过不补发。

**包体口径（改依赖前后的必看项，别把这些预载当冗余删掉）**：

- `lib/petEvent.ts` 是**桌宠事件协议层**，必须保持轻：它只该依赖纯数据/协议小模块
  （`petPose`、`agendaBucket`、通知 store），**不要依赖幕僚/任务/信息中枢的业务模型**
  （30KB 的 `staff/model` 曾把这块拖到 261KB raw / 82.8KB gzip）。
- 测量方法：`pnpm --filter @heming/web exec vite build` 后看 `dist/assets/petEvent-*.js`；
  gzip 用 **level 9** 实测（`zlib.gzipSync(buf, { level: 9 })`），不要只看 raw。
  **2026-11 基准**：抽 `lib/agendaBucket.ts` 之后 261KB raw / 82.8KB gzip →
  **6.5KB raw / 2.7KB gzip**（gzip −96.7%）。
- **`pet.html` 预载 `petEvent` 是必须的**：桌宠窗口要解析事件；不要当冗余模块删掉或改懒加载。
- **`index.html` 侧不预载**靠 App 启动后 `import()` 动态加载 `startPetPresence`；
  不要把这条 import 改回顶层静态导入（改回去协议层会重新回到首屏预载）。
- 想看真实预载列表就直接读 `dist/index.html` / `dist/pet.html` 的 `modulepreload` 行。

### 4.4 接语音

目前没有语音，但接口已经在了：`useLive2D` 返回的 `setMouthOpen(0..1)` 就是唯一的嘴部入口。

- **TTS**：按音频播放进度每帧算一个包络值，喂给 `setMouthOpen` 即可；
- 需要先把 `PET_POSES.speaking.mouth` 从 `"text"` 切到新的来源，否则会和流式文字的口型打架。

没有做：音频播放、TTS 供应商适配、打断处理。

### 4.5 拖拽：改之前先读（残影/闪烁与「被鼠标带着跑」的成因）

拖动桌宠 = 每帧移动一个**透明置顶窗**，而透明窗每次移动都要 DWM 重新合成。下面几条
硬约束，改动前先读懂：

1. **移动上报按帧合并**（`petInteraction.createFrameCoalescer`）：Windows 上原生
   `mousemove` 可达 125–1000Hz，逐次 `pet:drag-move` IPC + 主进程逐次 `win.setPosition`
   会让透明层合成跟不上输入频率——表现就是拖动时的**残影、边缘闪烁**。现在同一帧最多
   一次 IPC，`mouseup` 时 `flush()` 补一次终值，最后一段位移不会丢。
2. **位置没变就不调 `setPosition`**：主进程 `moveWindowTo()` 先比 `getBounds()`，相同直接
   跳过。重复设置同一个位置同样会触发一次合成，纯属浪费。
3. **拖拽期间冻结 Live2D 与命中判定**：`useLive2D.setPaused(true)` 同时停 `app.ticker`
   与 `model.autoUpdate`——两者是两条独立时钟，只停一条的话物理/呼吸仍在后台算。
   移动期间只搬静态位图；同时不追视、不做命中判定、不上报 `pet:set-interactive`
   （移动中来回切 ignore-mouse 会让鼠标事件抖动）。抬起后 `setPaused(false)` 恢复
   并立即渲染一帧，画面不会停在旧帧。
4. **收尾吸附与可见性钳制**（`pet-window.settlePetPosition`，纯函数）：`drag-end` 先按
   当前光标补终值，再在选中的工作区上做两件事——距边 ≤ `PET_SNAP_PX`（12px）时吸附到
   该边；至少保留 `MIN_VISIBLE_WIDTH/HEIGHT`（60×80）可见，因此拖到屏幕外也能拖回来
   （与重启校验 `isOnVisibleDisplay` 同一口径）。**拖拽过程中不钳制**，否则窗口会和
   光标脱节。多显示器按重叠面积最大的工作区吸附，完全出屏时取最近的一块。
5. **tap 之后不残留拖拽**：`mouseup` 一律清空按下会话；继续移动时先看
   `MouseEvent.buttons` 的左键位（`isPrimaryButtonDown`），没按着就不开始拖拽。
   双击计时单独放 `lastTapAtRef`，不再写回按下会话——把 `dragging:false` 的对象塞回去
   正是「松开鼠标后桌宠仍被带着跑」的成因。

**改这些时的验收**：`packages/desktop` 的 `pet-window.test.js` / `pet-host.test.js` 覆盖
吸附、钳制、跳过重复位置、终值对齐；`packages/web` 的 `petInteraction.test.ts` 与
`PetWindow.drag.test.tsx` 覆盖 rAF 合并、抬起补终值、拖拽期不上报交互、tap 后不残留拖拽。
取舍与现象口径见 `docs/superpowers/specs/2026-11-03-pet-drag-flicker.md`。

---

## 5. 已知限制

- **只在 Windows 真机验证过**；macOS 未适配（托盘图标、`alwaysOnTop` 层级可能需要调整）。
- **盖不住独占全屏**：Windows 上独占全屏应用（多数游戏）会盖住所有置顶窗，这是系统行为，不做绕过。
- **拖拽时角色画面是静止的**（`setPaused` 冻结 ticker 与物理，这是刻意的：移动期间不重绘
  透明画布）。松手立即恢复并渲染一帧；模型尚未加载完成时冻结/恢复都是空操作。
- **吸附只认工作区矩形**：不处理「拖拽中途任务栏自动隐藏导致工作区变化」的情况——
  那次收尾仍按旧工作区算，下一次拖拽会重新取。
- **窗口外松开鼠标**靠后续 `mousemove` 的 `buttons=0` 取消会话；若系统之后完全不再派发
  鼠标事件，窗口会停在最后一次移动的位置（收尾吸附不执行，但位置仍可再次拖回）。
- **鼠标穿透依赖 `forward: true`**：个别平台/驱动下穿透态收不到 `mousemove`，表现为「角色点不中」。
  出口是关掉穿透（设置区或托盘）。
- **不做**：语音、正文预览、系统级徽章（任务栏/托盘计数）、按会话免打扰联动、养成系统、模型市场。

---

## 6. 排查

| 现象 | 先看 |
|---|---|
| 桌宠不出现 | 日志里 `[heming] 桌宠: {"visible":false}` → 状态文件为关闭；设置区开关 |
| 窗口在、角色不在 | Cubism Core 与模型是否 200；`pet-state.json` 是否带 BOM（已兼容）；控制台有无 404 |
| 角色点不中 | 关掉鼠标穿透试一次 |
| 拖动没反应 | 渲染层只上报按下/移动/抬起，位移由**主进程**用 `getCursorScreenPoint()` 算；查 IPC 是否到了主进程 |
| **拖动时有残影 / 边缘闪烁** | ① 移动是否还按原生 mousemove 逐次发 `pet:drag-move`（应经 `createFrameCoalescer` 每帧一次）；② 拖拽期间 Live2D 是否被冻结（`useLive2D.setPaused(true)` 停 ticker 与物理）；③ 主进程是否对相同位置重复 `setPosition`（`moveWindowTo` 应跳过）；④ 拖拽中是否还在切 `pet:set-interactive`（渲染层与主进程都不该切换） |
| **松开鼠标后桌宠被鼠标带着跑** | ① `mouseup` 是否清空了按下会话（不要再把 `dragging:false` 的对象写回 `dragRef`）；② 拖拽起点是否检查 `MouseEvent.buttons` 左键位；③ 双击计时是否独立的 `lastTapAtRef` 而不是塞在按下会话里 |
| 松手后窗口跑到屏幕外 / 贴不住边 | 看 `settlePetPosition` 是否在 `drag-end` 执行；`PET_SNAP_PX`、`MIN_VISIBLE_*` 与工作区是否被意外改动 |
| 角标不出现 | 未登录不建 WS；确认登录态与网络 |

真机验证脚本的写法可参考 `docs/superpowers/plans/2026-11-01-d46-desktop-pet.md` 末尾的验收记录——
注意 `ELECTRON_RUN_AS_NODE=1` 会让 Electron 退化成纯 Node，跑脚本前要 `env -u`。
