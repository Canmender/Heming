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
| 拖动角色 | 移动窗口（位置记住，重启后回来） |
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
   │  pet-window.js  纯函数：几何 / 缩放 / 位置夹取 / 地址拼接 / 状态解析
   │
   ├─ preload.js  __heming_pet 桥（12 个动作 + 2 个订阅）
   │
渲染进程 packages/web/src/pet.tsx        ← 独立入口 pet.html，不加载主应用
   ├─ components/pet/PetWindow.tsx   画面 + 输入 + 角标 + 气泡
   ├─ components/pet/useLive2D.ts    pixi + Cubism 装配（动态 import）
   ├─ components/pet/petInteraction.ts  命中判定 / 点击 vs 拖拽（纯函数）
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

### 4.3 让桌宠对平台事件做出反应（**已预留，暂无生产者**）

通道已经打通，只差发送方：

```
主进程 petHost.pushEvent(payload)        // 主进程内部直接推
   或 主窗口 window.__heming_pet.emit(payload)   // 主窗口发起，主进程校验来源后转发
        ↓  IPC: pet:event
桌宠 window.__heming_pet.onEvent(cb)     // PetWindow 已订阅并消费
```

事件契约在 `lib/petEvent.ts`，支持五种：

| kind | 效果 | 典型来源 |
|---|---|---|
| `pose` | 覆盖当前姿态（发送方负责用 `reset` 收尾） | 幕僚开始总结 |
| `speak` | 气泡显示一句话，8 秒收回 | 晨报摘要 |
| `task` | 「完成了：xxx / 没成功：xxx」 | 任务区收尾（d.51） |
| `schedule` | 「19:00 晚自习」 | 日程临期（d.48） |
| `reset` | 清掉外部姿态与文案 | 任何主动表达结束时 |

**接入示例**（在任务收尾处）：

```ts
// 主窗口侧
window.__heming_pet?.emit({ kind: "task", title: task.title, ok: task.status === "done" });
```

注意三条现成约束：
- payload 跨进程**一律不可信**，消费端已用 `parsePetEvent` 校验，畸形事件静默忽略；
- 通道**单向**（主进程 → 桌宠）。桌宠要主窗口做事，走 `pet:open-conversation` / `pet:open-settings`；
- 姿态不自动过期——发送方必须发 `reset` 或下一条 `pose`，因为只有它知道这条信息该显示多久。

### 4.4 接语音

目前没有语音，但接口已经在了：`useLive2D` 返回的 `setMouthOpen(0..1)` 就是唯一的嘴部入口。

- **TTS**：按音频播放进度每帧算一个包络值，喂给 `setMouthOpen` 即可；
- 需要先把 `PET_POSES.speaking.mouth` 从 `"text"` 切到新的来源，否则会和流式文字的口型打架。

没有做：音频播放、TTS 供应商适配、打断处理。

---

## 5. 已知限制

- **只在 Windows 真机验证过**；macOS 未适配（托盘图标、`alwaysOnTop` 层级可能需要调整）。
- **盖不住独占全屏**：Windows 上独占全屏应用（多数游戏）会盖住所有置顶窗，这是系统行为，不做绕过。
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
| 角标不出现 | 未登录不建 WS；确认登录态与网络 |

真机验证脚本的写法可参考 `docs/superpowers/plans/2026-11-01-d46-desktop-pet.md` 末尾的验收记录——
注意 `ELECTRON_RUN_AS_NODE=1` 会让 Electron 退化成纯 Node，跑脚本前要 `env -u`。
