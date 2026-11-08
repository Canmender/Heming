# 桌宠（界面插件 `heming.pet`）

> 桌面上的 Live2D 化身：关掉主窗口它还在，点它就能说话，有消息它会提醒。
>
> **d.97 起桌宠不再内置在主程序里**：它是和鸣的第一个**界面插件**，从云端插件目录下载安装，
> 代码、Live2D 模型与 Cubism Core 全部随插件包走，主程序里没有 pet 入口、没有 pixi、没有 5MB 模型。
> 设计契约见 [`superpowers/specs/2026-11-07-d94-pet-as-plugin.md`](superpowers/specs/2026-11-07-d94-pet-as-plugin.md)；
> 插件通用规则见 [`PLUGINS.md`](PLUGINS.md) §10，插件包自身说明见 `packages/pet-widget/README.md`。

本文面向两类读者：**使用者**（怎么装、怎么用、哪里调）与 **维护者**（改哪里、怎么打包、怎么排查）。

---

## 1. 怎么装、怎么用

| 动作 | 结果 |
|---|---|
| 插件区 → 桌面小组件 → 安装 | 从云端目录选「桌宠」（或本地导入 `package.tgz`），二次确认「包含可执行界面代码」后安装 |
| 设置区 → 外观 → 桌面小组件 → 「在桌面显示」 | 出现/收起桌宠（**默认不自动出现**） |
| 单击角色 | 浮出输入框，说一句话 |
| 双击角色 | 播一次「开心」动作 |
| 拖动角色 | 移动窗口（位置记住，重启后回来；松手贴边吸附，拖出屏幕会被拉回可见区） |
| 右键角色 | 菜单：说点什么 / 放大一档 / 缩小一档 / 重置位置 / 鼠标穿透 / 设置 / 隐藏 |
| 托盘图标左键 | 显隐切换；右键有完整菜单含「退出」 |
| 插件区 → 卸载 | 删掉插件文件、模型与插件设置（二次确认） |

**右键菜单键盘**：右键打开后焦点在第一项，`↑`/`↓` 移动，`Enter`/空格执行，`Esc` 关闭并把焦点还给画布。
菜单项最小高度 28px；「鼠标穿透」项显示当前开关状态；「重置位置」把桌宠放回右下角默认落位。

**点不中角色**：多半是鼠标穿透。设置区 → 外观 → 桌面小组件 → 关掉「鼠标穿透」，或从托盘菜单关。
穿透模式下只有角色、气泡、角标、输入框、右键菜单与错误提示条会拦截鼠标。

**说话用哪个模型**：设置区 → 外观 → 桌面小组件 → 「对话绑定智能体」；不绑定就用网关返回的第一个模型。
模型统一来自本机 magpie 网关（不是插件自带的供应商配置）。网关不可用时气泡直接说不可用并给「去设置」。

**旧版本用户**：从内置桌宠升级上来后，桌宠会先消失（因为它已经是插件）。插件区/设置区会给一次性提示；
装上插件后，旧的位置、缩放、穿透、绑定智能体与打扰强度会**自动迁移**，不用重配。

---

## 2. 架构：谁负责什么

```
插件包 packages/pet-widget/                       ← 独立 workspace 包，构建成 plugin.json + files/**
   ├─ src/main.tsx / index.html                   ← 独立渲染入口（React + pixi6 + Live2D）
   ├─ src/components/pet/**                       ← 画面/输入/气泡/角标/右键菜单/拖拽
   ├─ src/lib/widgetBridge.ts                     ← window.__heming_widget 契约（容错包装）
   ├─ src/lib/gatewayChat.ts                      ← 本机网关流式对话（OpenAI 兼容 SSE）
   ├─ src/lib/petPose.ts / petEvent.ts / petPrefs.ts
   └─ files/pet/**（Hiyori + Cubism Core）、files/tray.png、files/icon.png

宿主 packages/desktop/                            ← 主进程，窗口与安装都归它
   ├─ plugin-store.js     安装记录 / 版本目录 / 设置 / 窗口状态（userData/plugins/**）
   ├─ plugin-package.js   package.tgz 结构校验 + 解包 + 确定性打包
   ├─ plugin-window.js    清单 → 窗口参数、几何/吸附/档位、状态文件（纯函数）
   ├─ plugin-host.js      窗口生命周期/托盘/穿透/拖拽/事件转发、widget:* IPC 自校验
   ├─ widget-preload.js   最小桥 __heming_widget（不含 secrets/MCP/文件/会话）
   └─ app-protocol.js     widget://<id> 独立 origin 的静态资源与 CSP

主窗 packages/web/                                ← 只负责「装/停/卸 + 设置表单 + 事件源」
   ├─ lib/widgets/**      插件区「桌面小组件」、设置表单、通用动作、老数据迁移
   ├─ lib/widgetEvents.ts 通知中心 → 脱敏事件 → 主进程 → widget
   └─ preload 的 __heming_widgets（主窗专用）
```

**三种边界，改之前先记住**：

1. **origin 边界**：插件渲染在 `widget://heming.pet`，与主窗 `app://heming` **不同 origin**，读不到主窗的
   localStorage / 会话 / 记忆；插件需要的宿主信息只能经 `__heming_widget`（窗口动作、设置、主题、事件、`chatConfig`）。
2. **进程边界**：窗口、托盘、置顶、穿透、拖拽、位置记忆全在**主进程**；插件只能操作自己那一个窗。
   所有 `widget:*` IPC 都按 sender 自校验；主窗的 `widgets:*` 通道只认主窗。
3. **包边界**：插件是用户机器上的文件（`userData/plugins/heming.pet/`），主进程建窗/定 CSP 前会**再校验一次清单**
   （web 侧 zod 校验是安装预览，主进程校验是纵深防御，两边职责不同）。

**主题**：widget 读不到主窗的浅/深色（不同 origin）。主窗挂载时与每次切换 `data-theme` 都会把
`{kind:"theme"}` 发布给主进程（`lib/widgetTheme.ts`），主进程把最后一次主题写进
`userData/widget-theme.json`，下次启动建窗直接用——所以「暗色应用 + 桌宠」不会先亮一帧。

---

## 3. 数据边界

| 数据 | 存在哪 | 说明 |
|---|---|---|
| 插件文件 / 模型 / Cubism Core | `userData/plugins/heming.pet/<版本>/files/` | 卸载即删；版本升级保留旧版本目录回滚 |
| 窗口位置 / 缩放 / 穿透 / 是否显示 | `userData/plugins/heming.pet/state.json` | **主进程持有**（缩放决定窗口像素尺寸，两处各存一份必然打架） |
| 绑定智能体 / 模型路径 / 打扰强度 | `userData/plugins/heming.pet/settings.json` | 主进程持有，设置表单经 IPC 读写；**不写 localStorage** |
| 对话内容 | **不落盘** | 一次性对话：不写会话、不进消息列表、不落明文缓存 |
| 事件（任务/日程/简报） | 内存 | 主窗脱敏后转发：只带 `kind/title(≤60)/summary(≤60)/route/at`，**不带正文、附件、会话名、发送人** |

老键迁移（一次性、幂等）：`heming.pet.v1 {enabled, agentId, modelPath}` + `heming.pet.presence.v1 {intensity}`
→ `settings.json` 的 `{agentId, modelPath, presence}`；旧 `pet-state.json` 的 `{visible, scale, clickThrough, bounds}`
与新 `state.json` 同名直通。

---

## 4. 包与清单（维护者）

- 包：`package.tgz`（tar + gzip9，**确定性**）→ `plugin.json` + `files/**`；解包 ≤20MB / ≤2000 文件 / 单文件 ≤8MB。
- 清单：`schemaVersion: 4`、`distribution: "bundle"`、`contributions.desktopWidgets[0]`（窗口规格 + 设置字段）、
  `permissions {events, graphics, eval}`。字段级说明见 [PLUGINS.md](PLUGINS.md) §10 与规格 §2.3。
- `permissions.eval: true` 是**给 pixi 6 的**：它在 `generateProgram` 里用 `new Function` 生成着色器
  （pixi 8 已移除该依赖，但 `pixi-live2d-display` 仍硬绑 6）。这个豁免只作用于本插件自己的窗口 CSP。
- 构建与发布：

```bash
node scripts/build-pet-widget.mjs                     # → packages/pet-widget/dist/package/
node scripts/pack-plugin.mjs packages/pet-widget/dist/package   # → dist/package.tgz（sha256 可复现）
node scripts/publish-plugin.mjs packages/pet-widget/dist/package --dest <plugin-dir>
# 把 <plugin-dir> 同步到服务器 HEMING_PLUGIN_DIR，客户端「插件区 → 桌面小组件 → 从云端浏览」即可看到
```

---

## 5. 扩展指南

### 5.1 换形象

把标准 Cubism 3/4 模型放进插件包的 `files/pet/<名字>/`（构建前放 `packages/pet-widget/public/pet/<名字>/`），
在设置区「Live2D 模型路径」填 `pet/<名字>/<名字>.model3.json`（相对插件包 `files/`）。
换完自动重载插件窗口。模型缺某个动作组不会报错——`playMotion` 找不到就静默跳过。

### 5.2 加一种姿态

打开 `packages/pet-widget/src/lib/petPose.ts`：`PetPose` 联合里加一项 → `PET_POSES` 里给 `enterMotion`/`mouth` 映射 →
`resolvePose` 优先级链里决定何时生效。测试会检查「每个姿态都有映射」。**克制**：只有「开心」配了进入动作，
常驻窗口里每种状态都播动作会变噪音。

### 5.3 让桌宠对平台事件反应

事件源在主窗（通知中心），链路是：主窗 `lib/widgetEvents.ts` 订阅通知 → 脱敏 → `__heming_widgets.publish()` →
主进程 → widget `onEvent()` → 插件的 `petEvent.ts` 决定姿态/气泡/是否弹。**不要**在主窗里写桌宠语义；
插件侧只认「类型 + 标题级信息」。

### 5.4 加一个设置项

清单 `desktopWidgets[0].settings.fields` 里加一条（`boolean` / `select` / `text` / `number` / `agent`），
主窗会自动渲染表单并存进 `settings.json`；插件侧用 `settings()` / `onSettings()` 读。
**不要**再往 localStorage 写偏好。

### 5.5 拖拽：改之前先读（残影/闪烁与「被鼠标带着跑」的成因）

拖动桌宠 = 每帧移动一个**透明置顶窗**，而透明窗每次移动都要 DWM 重新合成。硬约束：

1. **移动上报按帧合并**：同一帧最多一次 IPC，`mouseup` 时补一次终值；
2. **位置没变就不调 `setPosition`**（主进程先比 bounds）；
3. **拖拽期间冻结 Live2D 与命中判定**：`setPaused(true)` 同时停 `app.ticker` 与 `model.autoUpdate`（两条独立时钟），
   抬起后恢复并立即补渲一帧；
4. **收尾吸附与可见性钳制**：12px 贴边、至少保留 60×80 可见；拖拽过程中不钳制（否则窗口与光标脱节）；
5. **tap 之后不残留拖拽**：`mouseup` 一律清空按下会话，继续移动先看 `e.buttons` 左键位；
6. **适配必须基于自然尺寸**：pixi 的 `Container.width` 是缩放后的宽度，拿它当基准第二次拟合会取倒数（角色突然变大被裁）。

---

## 6. 已知限制与排查

**限制**

- P0 只支持**本机 magpie 网关**：插件 CSP 的 `connect-src` 只放回环 + 清单 `network`；把网关改成远端地址会被拦
  （P1 做宿主代发后可解）。
- `permissions.eval: true` 是 pixi 6 的必要之恶，等 pixi 8 + live2d 升级后可删。
- 插件包未签名（P0 靠「官方目录 / 本地显式导入 + 二次确认」把关，Ed25519 逐包签名列 P1）。
- 卸载会删除插件文件与设置（二次确认）；旧 `heming.pet.v1` / `heming.pet.presence.v1` 老键保留一版供回滚。
- Electron 真机上的跨 DPI 拖动、菜单实际点击、悬停观感需要人工过一遍（自动化只覆盖纯函数与 jsdom）。

**排查表**

| 现象 | 先查什么 |
|---|---|
| 装完桌宠不出现 | 插件区里是否「已启用」；设置区「在桌面显示」是否打开；`userData/plugins/heming.pet/state.json` 的 `visible` |
| 装了但窗口空白 | `widget://heming.pet/files/index.html` 能否取到（日志 `[widget]`）；`files/` 是否完整 |
| 角色点不中 | 鼠标穿透是否开着（设置区/托盘）；`clickThrough: "auto"` 下渲染层是否上报交互区 |
| 对话 403 / 连不上 | 本机 magpie 网关是否就绪（设置区模型页）；`magpie-proxy` origin 白名单是否放行 `widget://<id>` |
| 拖动残影 / 被鼠标带着跑 | §5.5 的六条约束是否被改坏 |
| 气泡不弹 | 主窗是否在前台（前台时只进通知中心，故意不冒泡）；插件「打扰强度」是否「安静」 |
| 插件区看不到「桌宠」 | 云端目录是否已发布 bundle（`distribution: "bundle"` + `package.tgz`）；服务端 `/api/plugins` 是否列出 |
