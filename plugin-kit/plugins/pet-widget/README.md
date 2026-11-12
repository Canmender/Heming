# @heming/pet-widget · 桌宠界面插件包

把「桌宠」从和鸣本体拆出来的**界面插件**（插件 id `heming.pet`，界面小组件 `pet`）。
按 `docs/superpowers/specs/2026-11-07-d94-pet-as-plugin.md`（清单 v4 / 包格式 / widget preload 契约）实现。

- 包格式：`package.tgz`（tar + gzip 9），根目录 `plugin.json` + `files/**`
- 运行位置：宿主 `widget://heming.pet/files/index.html`，**独立 origin**、`sandbox` + `contextIsolation`、最小 preload
- 代码/资源随包分发：React 19 + pixi 6 + pixi-live2d-display + Hiyori 模型 + Cubism Core（约 5 MB）
- 宿主只负责窗口、托盘、置顶、穿透、拖拽、位置记忆与安装；插件只经 `window.__heming_widget` 操作**自己那一个窗**

---

## 1. 目录结构

```
plugin-kit/plugins/pet-widget/
├── plugin.json                 # 清单 v4（schemaVersion 4 / distribution: "bundle"）
├── index.html                  # Vite 入口（产物名 files/index.html）
├── vite.config.ts              # base "./"、outDir dist/package/files、pixi/live2d 动态 import
├── tsconfig.json
├── package.json
├── public/                     # 原样拷进产物 files/
│   ├── pet/                    # Cubism Core + Hiyori（授权见 public/pet/README.md）
│   ├── tray.png                # 托盘图标（由 scripts/make-widget-tray-icon.mjs 生成，原 desktop/assets/pet-tray.png 已随插件走）
│   └── icon.png                # 插件卡/窗口图标
└── src/
    ├── main.tsx                # 挂载 PetWindow（无 StrictMode：避免 Live2D effect 双跑）
    ├── lib/
    │   ├── widgetBridge.ts     # __heming_widget 契约类型 + createWidgetApi 容错包装
    │   ├── gatewayChat.ts      # 本机 magpie 网关的 OpenAI 兼容 SSE 对话
    │   ├── petEvent.ts         # 宿主事件 → 气泡/姿态（规格 notify + 旧契约兼容）
    │   ├── petPose.ts          # 姿态判定与表现映射表
    │   └── petPrefs.ts         # settings 收敛（agentId / modelPath / presence）
    └── components/pet/
        ├── PetWindow.tsx       # 画面 + 输入 + 气泡 + 右键菜单 + 拖拽
        ├── useLive2D.ts        # pixi + Cubism 装配（动态 import / 自然尺寸拟合）
        ├── usePetChat.ts       # 对话（人设 + 网关流式）
        ├── live2dFit.ts        # 适配纯函数（幂等）
        └── petInteraction.ts   # 命中判定 / 点击 vs 拖拽 / rAF 合并（纯函数）
```

构建产物（不入库，`.gitignore` 的 `dist/` 覆盖）：

```
plugin-kit/plugins/pet-widget/dist/
├── package/                    # ← 本地安装/联调直接用这个目录
│   ├── plugin.json
│   └── files/                  # index.html + assets/*.js + pet/** + tray.png + icon.png
└── package.tgz                  # ← 发布/安装用（与 package/ 内容一致）
```

---

## 2. 构建 / 打包 / 测试

```bash
# 依赖（本包在根 pnpm-workspace.yaml 里单独声明，装一次即可）
pnpm install --prefer-offline

# 构建：vite → 组装 dist/package/{plugin.json,files/**}
pnpm --filter @heming/pet-widget build

# 打包：先首方签名，再确定性 tar+gzip9 → dist/package.tgz（打印 sha256/size）
pnpm --filter @heming/pet-widget build
node scripts/sign-plugin.mjs sign plugin-kit/plugins/pet-widget/dist/package/plugin.json <正式私钥> --id heming --write
pnpm --filter @heming/pet-widget run pack

# 单测 / 类型
pnpm --filter @heming/pet-widget test        # 11 文件 / 138 例
pnpm --filter @heming/pet-widget typecheck
```

两个脚本在仓库根（`packages/desktop` 不参与本包构建）：

| 脚本 | 作用 |
|---|---|
| `scripts/build-pet-widget.mjs` | 跑 vite；把清单规范化写到 `dist/package/plugin.json`；自检 `schemaVersion=4`/`distribution=bundle`/`entry` 位于 `files/` 且存在；按安装配额自检（≤20MB / ≤2000 文件 / 单文件 ≤8MB） |
| `scripts/pack-plugin.mjs` | 收集包根所有文件 → 确定性打包（mtime/uid/gid 固定、路径排序）→ 回读校验。**优先复用** `packages/desktop/plugin-package.js` 的 `packPackage/readPackage`（与安装端同一实现），缺位时回落 `plugin-tar.js` / 内置实现 |

**确定性**：同一份产物重复打包得到同一 sha256（发布目录按 `sha256(package.tgz)` 做完整性校验）。
当前基线：`4.57 MB (gzip) / 5.74 MB 解包 / 28 文件`；`node --version` 与 zlib 版本一致时 sha 稳定。

---

## 3. 安装 / 启用 / 卸载（宿主侧语义）

- 安装入口：主窗「插件区 →「从插件仓库安装」」，走官方云端目录（带 `sha256` 校验）；**本地 `.tgz` 导入**在当前客户端界面没有入口（主进程 `widgets:installFromFile` 仍保留给本地联调）。
  未签名包只允许本地联调（`bundle` 的签名可选、带则做结构校验）。
- 落盘：`<userData>/plugins/heming.pet/<version>/`（`plugin.json` + `files/**`）+ `current.json` 指针；
  设置 `settings.json`、窗口状态 `state.json` 同目录；注册表 `installed.json`。
- 启用/停用：停用销毁窗口与托盘、保留文件与设置；重新启用即恢复。卸载：删版本目录 + 记录 + 设置（二次确认）。
- 启动：`enabled` 且文件完好才建窗；**默认隐藏**（`state.visible` 为 true 才显示），不抢焦点。
- 旧数据迁移（一次性，幂等，由宿主做，插件不读 localStorage）：
  - `localStorage["heming.pet.v1"]` → `settings.json`（见 §5）
  - `localStorage["heming.pet.presence.v1"]` → `settings.presence`
  - `userData/pet-state.json`（位置/缩放/穿透/可见）→ `state.json`（字段同名直通）
  - 老键保留一版不删（回滚用）

---

## 4. 与宿主的契约（`window.__heming_widget`）

规格 §3.4；实现在 `packages/desktop/widget-preload.js`，每个 `widget:*` 通道都由主进程按 sender 反查「是不是这个 widget 自己的窗口」，查不到直接拒绝。
本包通过 `src/lib/widgetBridge.ts` 的 `createWidgetApi()` 使用它们（缺方法时安全回落，便于浏览器预览与单测）。

| `__heming_widget` | IPC | 本包用途 |
|---|---|---|
| `state()` | `widget:state` | 右键菜单显示「鼠标穿透（已开/已关）」 |
| `show()/hide()/toggle()` | `widget:show/hide/toggle` | 菜单「隐藏」；宿主托盘/插件详情「窗口设置」也走同一状态 |
| `setScale(1 \| -1)` | `widget:set-scale` | 菜单「放大一档 / 缩小一档」（绝对档位由宿主决定） |
| `setClickThrough(on)` | `widget:set-click-through` | 菜单切换穿透 |
| `setInteractive(on)` | `widget:set-interactive` | 命中区变化时上报（仅 `clickThrough:"auto"` 生效） |
| `dragStart/dragMove/dragEnd()` | `widget:drag-*` | 拖拽只上报信号，位移由主进程按屏幕光标算（`dragMove` 经 rAF 合并） |
| `resetPosition()` | `widget:reset-position` | 菜单「重置位置」 |
| `reload()` | `widget:reload` | 预留（换模型/绑定后重载自己；当前主要靠 `onSettings` 热更新） |
| `info()` | `widget:info` | `info().theme` 应用主题；`pluginId/pluginName/appVersion` 仅展示/日志 |
| `settings()` / `setSetting(k,v)` | `widget:settings-get/set` | 读三字段；写由宿主设置表单负责（本包只读，`setSetting` 预留） |
| `onSettings(cb)` | 推送 `widget:settings` | 设置表单改动 → 热更新（模型路径/打扰强度立即生效） |
| `onEvent(cb)` | 推送 `widget:event` | 气泡/姿态/主题；见下 |
| `openSettings()` | `widget:open-settings` | 「还没有可用的模型连接」→「去设置」 |
| `openPage(page)` | `widget:open-page` | 点气泡直达主窗页面；白名单 `settings/team/tasks/staff/infohub` |
| `chatConfig()` | `widget:chat-config` | 对话上下文：本机网关地址+网关 Key、可用智能体、当前绑定 |
| `log(line)` | `widget:log` | 排障日志（主进程统一加前缀、限长 500） |

**事件形状**（宿主 → 插件）：

```ts
{ kind: "notify", title, summary?, route?, at? }  // 主窗脱敏转发；只带标题级信息，不带正文/附件/会话名/发送人
{ kind: "theme",  theme: "light" | "dark" }       // 主题变更
{ kind: "tray",   action }                        // 托盘动作（本包不消费，预留）
```

本包同时兼容拆分前的旧契约（`speak/task/schedule/pose/reset`），迁移期可先用旧事件联调；
`notify` 的映射规则：带 `at` → 日程气泡「19:00 晚自习」；否则优先 `summary`、没有就 `title`。
打扰强度决定「只换姿态 / 只冒泡 / 姿态+气泡+动作」；气泡 4 秒收回，对话中收到的事件排队 ≤10 秒。

---

## 5. 设置字段与老数据映射（契约）

清单 `settings.fields` 与宿主 `settings.json` 的键**固定**为三个（改名前先改规格）：

| 字段 | 类型 | 默认 | 校验（宿主 `coerceSetting` + 插件 `normalizePetSettings` 双重） |
|---|---|---|---|
| `agentId` | `agent` | 无（缺省 = 未绑定） | `string \| null`；空串/非字符串 → 插件侧按 `null` |
| `modelPath` | `text` | `pet/Hiyori/Hiyori.model3.json` | 相对路径、不含 `..`/盘符/`//`、必须以 `.model3.json` 结尾；坏值回落默认 |
| `presence` | `select` | `normal` | `quiet \| normal \| eager`；坏值回落 `normal` |

老数据 → 新设置（**宿主迁移负责**，插件只读结果）：

| 老存储 | 老字段 | → 新位置 | 说明 |
|---|---|---|---|
| `localStorage["heming.pet.v1"]` | `agentId` | `settings.agentId` | 同名直通；空值 → 不写（插件读作 `null`） |
| 同上 | `modelPath` | `settings.modelPath` | 同名直通；插件侧仍会做白名单校验 |
| 同上 | `enabled` | **不进 settings** | 「是否在桌面显示」在插件模型里是宿主的启用/可见状态：`installed.json.enabled` + `state.json.visible` |
| `localStorage["heming.pet.presence.v1"]` | `intensity` | `settings.presence` | **键不同名**：迁移方必须显式改名（主进程 `migrateLegacy` 只按字段名直通，另兼容 `boundAgentId→agentId`、`model→modelPath`） |
| `userData/pet-state.json` | `visible/scale/clickThrough/bounds` | 宿主 `state.json` | 字段同名，主进程一次性种入；插件不读写 |

- `settings()` 返回**已合并清单默认值**的全量（缺键时宿主用 `field.default` 补），因此首次安装即返回
  `{ modelPath: "pet/Hiyori/Hiyori.model3.json", presence: "normal" }`，`agentId` 键可能缺席（插件按未绑定处理）。
- 写入只接受清单声明的字段；`text` 截断 500 字、`select` 必须命中 options、`agent` 只收 `string|null`。

---

## 6. Live2D 授权（沿用，未改动）

模型与运行时**不属本仓库**，授权随包分发，详细条款见 [`public/pet/README.md`](public/pet/README.md)：

- **Cubism Core** `live2dcubismcore.min.js`：Live2D 专有软件，但官方 `RedistributableFiles.txt` 明确列为 **Redistributable Code**（允许随应用再分发）；**文件头版权声明不得移除**。
- **Hiyori 模型**：Live2D 官方示例素材，遵循 **Free Material License**（仅用于 Live2D 相关创作/演示，不得单独转售或再分发素材本身）。
- 换形象：放入另一个同构的 Cubism 3/4 目录，把设置 `modelPath` 指过去即可，渲染代码不动；第三方模型请自行确认授权。
- **CSP / `unsafe-eval`**：pixi 6 生成着色器需要 `new Function`，所以清单声明 `permissions.eval: true`
  （仅第一方 widget 会被宿主放开，且只对 `widget://` 响应生效，不进主窗）。
  `permissions.graphics: ["webgl","wasm"]` 对应 WebGL 渲染与 Cubism Core 的 wasm 编译。

---

## 7. 安全与边界（拆完后仍成立）

- **独立 origin**：`widget://heming.pet` 读不到 `app://heming` 的 localStorage；本包**不使用任何宿主持久化**。
- **最小桥**：widget preload 不含 secrets / mcp / files / 会话 / 记忆；无 Node、无 fs。
- **对话**：只走本机 magpie 反代（回环地址 + 网关 Key，用户供应商 Key 不出主进程）；
  **不写会话、不进消息列表、不落 msgCache、对话不落盘**。
- **透明窗性能约束**（d.67/d.68 的约束原样保留）：拖拽按 rAF 合并上报、位置不变不重复 `setPosition`、
  拖拽期间冻结 Live2D 与穿透切换、适配基于自然尺寸（幂等）、跨屏 DPR 在 dragEnd 时重设。
- **CSP**：`default-src 'self'`；`connect-src` 只放本机回环 + 清单 `permissions.network`（本包为空，
  假定网关是本机回环；如果宿主改成远端网关，需要同时声明 network 或走 P1 的宿主代发）。
- 插件在「没有桥」时（浏览器直接打开构建产物）只保留纯渲染能力，不渲染会「点了没反应」的菜单项。

---

## 8. 扩展指南

- **换模型**：只改 `settings.modelPath`（或 `public/pet/` 里放新目录后改默认值）。模型没有某动作组时静默跳过。
- **加姿态**：`src/lib/petPose.ts` 里加 `PetPose` 联合项 + `PET_POSES` 映射 + `resolvePose`（或 `poseForEvent`）优先级；
  `petPose.test.ts` 会拦住漏映射。渲染代码不需要改。
- **加事件字段**：`src/lib/petEvent.ts` 的 `adaptWidgetEvent` + `bubbleTextForEvent`；跨进程载荷一律先校验，畸形静默忽略。
- **加设置字段**：`plugin.json` 的 `settings.fields`、`src/lib/petPrefs.ts` 的 `normalizePetSettings`、宿主迁移口径三处必须同步。
- **升级版本**：改 `plugin.json` 的 `version`（宿主按同 id 新版本「更新」，旧版本目录会在切换后清理），然后 `build` + `pack`。

---

## 9. 门禁基线（2026-11-10 迁入 `plugin-kit` 后复跑）

| 项 | 结果 |
|---|---|
| `pnpm --filter @heming/pet-widget build` | ✓ 产物 `dist/package/files`（27 文件 / 5.73 MB） |
| `pnpm --filter @heming/pet-widget typecheck` | ✓ |
| `pnpm --filter @heming/pet-widget test` | ✓ 11 文件 / 138 例（含 petPose/live2dFit/petInteraction 与 3 套 PetWindow jsdom 用例） |
| `node scripts/pack-plugin.mjs dist/package` | 需先首方签名（`readPackage` 按 d.105 口径硬拒未签名包）；签名产物的 sha256 见输出 |
| 主窗包体 | 本体不再含 pet 入口 / pixi / Live2D / 5MB 模型（验收项见规格 §8） |
