# d.97 · 桌宠拆成插件（界面插件运行时）

> 分支 `feat/d94-pet-content`（从 `feat/d77-heming-core` 的 `93f9b65` 拉出）。
> 本文是**契约**：实施时字段名、IPC 名、目录布局、安全边界以本文为准；改契约先改本文。

## 0. 决策（用户口径）

1. 用户要求：**把桌宠模块从本体程序里拉出来，做成一个插件，不再合并进本体**。
2. 分发：**走云端插件目录，用户自行下载安装**，不随安装包分发（与 `plugins/infohub-collector` 同一条链路）。
3. 现有插件体系是「纯声明式、不执行第三方代码」（`docs/PLUGINS.md` §6 红线）。桌宠需要窗口 + 渲染代码，
   所以本轮新增**第二类包：界面插件（desktopWidget）**：
   - 代码/资源以**独立签名包**分发，主进程安装落盘；
   - 只在**独立 origin `widget://<id>`** 的 BrowserWindow 里渲染（sandbox、contextIsolation、无 nodeIntegration、最小 preload）；
   - 窗口/托盘/置顶/穿透/拖拽/位置记忆全部留在宿主，插件只能经 `widget:*` 命名空间操作**自己那一个窗**；
   - **只有第一方包允许携带代码**。第三方仍是纯声明式（`schemaVersion` 1/2/3 语义不变），
     打开第三方界面插件需要另立「沙箱化插件 UI」规格，本轮明确不做。
4. 桌宠是第一个界面插件：`heming.pet`。本体里的桌宠代码、资源、依赖、设置卡**全部删除**。

## 1. 名词

| 名词 | 含义 |
|---|---|
| 宿主 | `@heming/desktop` 主进程 + `@heming/web` 主窗口。负责窗口、托盘、IPC、安装、设置表单 |
| 插件包 | `plugin.json` + `files/**` 打成的 `package.tgz`（tar + gzip 9） |
| 界面插件 | 声明 `contributions.desktopWidgets` 的 v4 插件包（`distribution: "bundle"`） |
| widget 窗口 | 宿主按清单规格创建的独立 BrowserWindow，入口来自插件包 |

## 2. 包与清单

### 2.1 包格式

```
package.tgz
├── plugin.json                     # 清单（v4），必须在包根
└── files/                          # 入口与全部资源，路径相对包根
    ├── index.html                  # 清单里的 entry
    ├── assets/*.js|css|png
    └── pet/…                       # Live2D 模型与 Cubism Core（约 5MB）
```

- 生成：`scripts/build-pet-widget.mjs`（构建）→ `scripts/pack-plugin.mjs`（打包 + sha256）。
- 校验（安装时，主进程）：gzip 解压后 ≤ **20MB**、文件 ≤ **2000** 个、单文件 ≤ **8MB**；
  禁止绝对路径、`..`、符号链接/硬链接、NUL；`plugin.json` 必须在根；`entry` 必须存在且在包内。
- 完整性：目录条目 `package: { sha256, size }` 覆盖整个 tgz 字节；下载后先比 sha256 再解包。
- 升级：`userData/plugins/<id>/<version>/` + `current.json` 指针；同 id 新版本装完再切指针，旧版本目录清理。

### 2.2 清单 v4（新增字段，其余沿 v3）

```jsonc
{
  "schemaVersion": 4,
  "id": "heming.pet",
  "name": "桌宠",
  "version": "1.0.0",
  "description": "桌面上的 Live2D 化身",
  "author": "和鸣",
  "distribution": "bundle",                 // 新增：bundle = 带文件；缺省 manifest（v3 等价）
  "permissions": {
    "network": [],                          // 仍 ≤20 host，逐 host 校验
    "tools": "none",
    "files": [],
    "events": ["notify"],                   // 新增：可接收主窗转发的事件
    "graphics": ["webgl", "wasm"],          // 新增：渲染能力声明
    "eval": false                            // 新增：是否允许 unsafe-eval（pixi6 需要 true）
  },
  "contributions": {
    "desktopWidgets": [ /* 见 2.3，≤1 个（本轮） */ ],
    "commands": [],
    "skills": [],
    "mcpServers": [],
    "toolPacks": []
  }
}
```

- `schemaVersion: 4` **必须**：v3 客户端用 zod 会静默 strip 新字段（装完没桌宠 = 半可用）。
  抬到 v4 后旧客户端在 `manifest.ts` 的 union 处明确报「仅支持 1/2/3」，提示升级。
  d.88 的 v4（`llmPresets`）已被 d.90 收回，编号机制本身可用；本轮 v4 只加 `desktopWidgets`。
- v3 及更旧清单语义**一字不改**；`distribution` 缺省 `manifest`。
- 新增拒绝规则（安装时中文报错并给字段路径）：
  - `distribution: "bundle"` 但声明了 `skills/mcpServers/toolPacks` → 拒绝（界面插件只允许 commands + desktopWidgets）；
  - `desktopWidgets` 非空但 `distribution !== "bundle"` → 拒绝；
  - 非第一方（无官方签名）的 bundle → 拒绝。

### 2.3 `desktopWidget` 规格

```jsonc
{
  "id": "pet",                              // ^[a-z0-9][a-z0-9-]{0,31}$，插件内唯一
  "name": "桌宠",                          // ≤32，托盘/设置标题
  "entry": "files/index.html",              // 相对包根，.html，禁 .. / 绝对路径 / scheme
  "width": 300, "height": 420,              // 基准 DIP，96–1024
  "scales": [0.6, 0.8, 1, 1.25, 1.5],       // 1–6 档、递增、0.5–2、≤2 位小数
  "defaultScale": 1,
  "transparent": true,                      // true 时强制 hasShadow:false + 无边框
  "alwaysOnTop": true,
  "skipTaskbar": true,
  "resizable": false,
  "clickThrough": "auto",                   // "none" | "auto"；auto = 渲染层上报交互区
  "position": { "anchor": "bottom-right", "margin": 24, "remember": true },
  "icon": "files/icon.png",                 // png ≤256KB，可省
  "tray": { "icon": "files/tray.png", "items": ["toggle", "clickThrough", "resetPosition", "settings"] },
  "settings": {                             // 可选：宿主用通用表单渲染
    "title": "桌宠",
    "fields": [
      { "key": "agentId", "type": "agent", "label": "对话绑定智能体" },
      { "key": "modelPath", "type": "text", "label": "Live2D 模型路径", "default": "pet/Hiyori/Hiyori.model3.json" },
      { "key": "presence", "type": "select", "label": "打扰强度", "default": "normal",
        "options": [ {"value":"quiet","label":"安静"}, {"value":"normal","label":"正常"}, {"value":"eager","label":"积极"} ] }
    ]
  }
}
```

- 窗口通用动作（宿主渲染，不用插件声明）：在桌面显示/隐藏、放大一档/缩小一档、鼠标穿透、重置位置、卸载。
- `settings.fields` 支持类型（本轮）：`boolean` / `select` / `text` / `number` / `agent`。
  值由**主进程持有**：`userData/plugins/<id>/settings.json`；渲染层经 IPC 读写，widget 经 preload 读。

## 3. 宿主运行时

### 3.1 目录与注册表（主进程持有）

```
<userData>/plugins/
├── installed.json                    # [{id, version, enabled, packageSha256, installedAt, widget, settings}]
├── heming.pet/
│   ├── current.json                  # {"version":"1.0.0"}
│   ├── 1.0.0/plugin.json + files/**
│   ├── state.json                    # 窗口几何/缩放/穿透/可见（原 pet-state.json 迁移）
│   └── settings.json                 # 表单值（原 heming.pet.v1 迁移）
└── .staging/<id>-<version>/          # 解包中转，校验通过后 rename
```

- 启动时读 `installed.json`；`enabled` 且 `widget` 存在 → 创建窗口（默认隐藏，除非 state.visible）。
- 停用：销毁窗口与托盘，保留文件与设置；卸载：删目录 + 记录 + 设置（二次确认）。

### 3.2 协议与 CSP

- 注册特权 scheme `widget`（`standard/secure/supportFetchAPI/corsEnabled/stream`），
  `widget://<pluginId>/<path>` → `<userData>/plugins/<pluginId>/<currentVersion>/<path>`（复用 `resolveAssetPath` 防穿越）。
- `widget://` 每个插件是**独立 origin**：读不到 `app://heming` 的 localStorage。
- CSP（每个 widget 响应头）：
  - `default-src 'self'`；`script-src 'self'` + (`eval: true` 时 `'unsafe-eval'`) + 需要 wasm 时 `'wasm-unsafe-eval'`；
  - `style-src 'self' 'unsafe-inline'`（React 内联样式）；`img-src 'self' data: blob:`；`media-src blob: data:`；
  - `connect-src 'self'` + 本机回环 `http://127.0.0.1:*` `http://localhost:*` + 清单 `permissions.network` 逐 host；
  - **不继承**主窗的 `https:` / `wss:` 通配。
- `HEMING_CSP_MODE` 灰度沿用（默认 report）。

### 3.3 窗口

- `new BrowserWindow({ webPreferences: { preload: widget-preload.js, contextIsolation: true, nodeIntegration: false, sandbox: true } })`。
- 互斥单例（同 widget）：一个插件本轮只有一个窗口。
- 透明/置顶/穿透/拖拽/位置语义**原样沿用** `pet-host.js` / `pet-window.js` 的实现（rAF 合并、位置去重、
  拖拽期冻结、12px 吸附、可见性钳制），只是把「桌宠专用」参数化。
- 可见性：`show()` 时 `backgroundThrottling` 恢复，`hide()` 时暂停渲染（隐藏窗默认节流；
  透明窗首帧卡顿的已知问题用「显示前 re-render 一帧」兜底）。

### 3.4 preload API（widget 窗口）

```ts
window.__heming_widget = {
  // 窗口
  state(): Promise<{ visible: boolean; scale: number; clickThrough: boolean }>;
  show(): Promise<void>; hide(): void; toggle(): void;
  setScale(dir: 1 | -1): Promise<{ scale: number }>;
  setClickThrough(on: boolean): Promise<boolean>;
  setInteractive(on: boolean): void;          // 仅 clickThrough: "auto" 生效
  dragStart(): void; dragMove(): void; dragEnd(): void;
  resetPosition(): void; reload(): void;
  // 宿主环境
  info(): Promise<{ pluginId: string; pluginName: string; appVersion: string; theme: "light" | "dark" }>;
  settings(): Promise<Record<string, unknown>>;
  setSetting(key: string, value: unknown): Promise<Record<string, unknown>>;
  onSettings(cb: (s: Record<string, unknown>) => void): () => void;
  // 事件：{ kind: "notify", title, summary, route, at } | { kind: "theme", theme } | { kind: "tray", action }
  onEvent(cb: (e: unknown) => void): () => void;
  // 跳转（白名单页面）
  openSettings(): void;
  openPage(page: string): void;
  // 对话上下文（Key 不出主进程；P0 只给本机网关的地址与网关 Key，用户供应商 Key 不涉及）
  chatConfig(): Promise<{
    gateway: { baseUrl: string; key: string };
    agents: Array<{ id: string; name: string; prompt?: string }>;
    binding: { agentId: string | null };
  }>;
  log(line: string): void;
};
```

- 所有 `widget:*` 通道在**主进程按 sender 自校验**：`BrowserWindow.fromWebContents(event.sender) === 本 widget 窗口`，
  不匹配直接拒绝（照 `pet-host.js` 的 `fromPetWindow`）。插件无法操作别的窗口、主窗、文件、密钥、MCP。
- `chatConfig` 的数据由**主窗渲染层**提供（`useLlmStore` 派生）：主进程向主窗请求一次并缓存 30s；
  gateway 是主进程托管的本机 magpie 反代地址 + 网关 Key（本机默认值，不是用户供应商 Key）。

## 4. 主窗（web）改造

### 4.1 删除（本体不再有桌宠）

`pet.html`、`src/pet.tsx`、`components/pet/**`、`components/PetSettingsCard.tsx`、
`lib/petPose.ts`、`lib/petPrefs.ts`、`lib/petWindow.ts`、`lib/petEvent.ts`、`types` 里的 `__heming_pet`、
`vite.config.ts` 的 pet 入口、`web/package.json` 的 `pixi.js` / `pixi-live2d-display`、`public/pet/**`、
`App.tsx` 的 pet 设置跳转与 `startPetPresence`、设置区「桌宠」卡与搜索索引。

### 4.2 新增

- `lib/widgets/store.ts`：界面插件记录（经 IPC 从主进程读）、启用/停用/卸载、设置表单值、动作。
- `lib/widgetEvents.ts`：订阅通知中心新增条目，**脱敏**后经 `window.__heming_widgets.publish()` 转发给主进程；
  主进程再转发给声明了 `permissions.events` 含 `notify` 的 widget。脱敏口径：只带
  `kind/title/summary(≤60 字)/route/at`，**不带正文、附件、会话名、发送人**。
- 插件区新增「桌面小组件」区：安装（云端目录 bundle / 本地 `.tgz`）、启用停用、卸载、打开设置。
- 设置区新增「外观 · 桌面小组件」（通用表单 + 宿主动作按钮），设置项由清单 `settings.fields` 决定。
- 主窗 preload 新增 `window.__heming_widgets`（仅主窗可用）：
  `list / install / installFromFile / uninstall / setEnabled / settingsGet / settingsSet / action / state / publish / pickPackage / migrateLegacy`。

### 4.2.1 IPC 契约（精确，T1 实现 / T3 调用，两边以此为准）

主窗通道（`secureIpc`，只认主窗）：

| 通道 | 入参 | 返回 |
|---|---|---|
| `widgets:list` | — | `WidgetRecord[]`（`{id,name,version,enabled,widget,settings,installedAt,error?}`） |
| `widgets:pickPackage` | — | `{ canceled: boolean, path?: string }`（主进程开文件框选 `.tgz`） |
| `widgets:install` | `{ bytes: ArrayBuffer, expectedSha256?: string }` | `{ ok: true, record } \| { ok: false, error }` |
| `widgets:installFromFile` | — | 同上（主进程自己走 pick + 安装，渲染层不碰 fs） |
| `widgets:uninstall` | `{ id: string, removeData?: boolean }` | `{ ok: boolean, error?: string }` |
| `widgets:setEnabled` | `{ id: string, enabled: boolean }` | `{ ok: boolean, record?, error? }` |
| `widgets:settingsGet` | `{ id: string }` | `Record<string, unknown>` |
| `widgets:settingsSet` | `{ id: string, patch: Record<string, unknown> }` | `Record<string, unknown>`（合并后的全量） |
| `widgets:action` | `{ id: string, action: "show" \| "hide" \| "toggle" \| "scaleUp" \| "scaleDown" \| "toggleClickThrough" \| "resetPosition" \| "reload" }` | `{ ok: boolean, state?: WidgetState }` |
| `widgets:state` | `{ id: string }` | `{ visible: boolean, scale: number, clickThrough: boolean }` |
| `widgets:publish` | `{ kind: "notify", title, summary, route?, at }` | `void` |
| `widgets:migrateLegacy` | `{ prefs: Record<string, unknown> }` | `{ ok: boolean }`（把 `heming.pet.v1` 并进 heming.pet 的 settings/state，幂等） |

widget 窗口通道（主进程按 sender 自校验，通道名以 `widget:` 开头）：

`widget:state / widget:show / widget:hide / widget:toggle / widget:set-scale / widget:set-interactive / widget:drag-start / widget:drag-move / widget:drag-end / widget:reset-position / widget:set-click-through / widget:reload / widget:settings-get / widget:settings-set / widget:info / widget:open-settings / widget:open-page / widget:chat-config / widget:log`

主进程 → widget 的推送：`widget:event`（`{kind:"notify",title,summary,route,at}` / `{kind:"theme",theme}` / `{kind:"tray",action}`）、`widget:settings`（全量）。

### 4.3 迁移

- 老用户 `localStorage["heming.pet.v1"]`（开关/绑定/模型路径）与 `userData/pet-state.json`（位置/缩放/穿透）：
  首次安装 `heming.pet` 时由主窗读出 localStorage 值、主进程读出 state 文件，合并成插件 `settings.json` / `state.json`，
  幂等一次；老键保留一版不删（回滚）。
- 未安装插件时：设置区「外观」与插件区给出一次性提示「桌宠已改为插件，去安装」（localStorage 标记只提示一次）。

## 5. 分发

- 云端目录（`packages/shared/src/pluginCatalog.ts`）条目新增：
  `distribution: "manifest" | "bundle"`（缺省 `manifest`）、`package?: { sha256, size }`。
- 服务端新增 `GET /api/plugins/:id/:version/package`（`application/gzip`，读 `<dir>/<id>/<version>/package.tgz`），
  目录列表带上 `distribution/package`；与既有 `/manifest` 路由同一套 id/版本白名单与路径守卫。
- `scripts/publish-plugin.mjs` 支持目录型包：识别 v4 `plugin.json`（`distribution: "bundle"`）→ 把同目录 `files/**`
  打 `package.tgz`（确定性 tar：固定 mtime/uid/gid 排序）→ 写 `<dest>/<id>/<version>/{plugin.json,package.tgz}`。
- **并行会话提醒**：服务端 `pluginCatalog.ts` 正在被另一会话修改，本分支的服务端改动保持小而集中（新增文件 + 少量路由），
  合并时按 `docs/HANDOFF.md` 的门禁复跑。

## 6. 安全不变量（拆完必须继续成立）

1. `widget:*` 通道一律按 sender 自校验，未接线即拒绝；主窗 `secureIpc` 与 `TRUSTED_CHANNELS` 不放宽。
2. widget preload **不含** secrets / mcp / files / 会话 / 记忆任何桥；widget 无 Node、无 fs。
3. 桌宠「不写会话、不进消息列表、不落 msgCache、对话不落盘」继续成立。
4. 透明窗性能约束原样保留（rAF 合并、位置去重、拖拽期冻结渲染与穿透切换）。
5. CSP：`unsafe-eval` 只对声明了 `permissions.eval: true` 的第一方 widget 放开，不进主窗。
6. 包安装：sha256 → 解包配额 → 路径穿越 → 清单校验 → 原子切换；任一步失败不产生半可用状态。
7. 第一方限制（P0 信任模型）：只允许「官方云端目录里的 bundle」与「用户本地显式导入并二次确认」两个入口安装；
   安装弹窗必须写明「本插件包含可执行界面代码」。清单里的 `publisher` / `signature` **可选**，带则做结构校验
   （ed25519、base64url、有 signature 必须有 publisher），并在安装记录里记 `signed: true|false` 供 UI 展示。
   **逐包 Ed25519 签名与官方公钥白名单列为 P1**（仓库现有 `signature.ts` 是 TOFU，没有密钥分发链）；第三方界面插件继续关闭。

## 7. 分期

- **P0（本轮）**：清单 v4 + 包格式 + 宿主运行时（widget scheme / 窗口 / 托盘 / 穿透 / 拖拽 / 位置 / preload / CSP）+
  桌宠迁移成 `packages/pet-widget` + 本体删除 + 设置表单 + 本地 `.tgz` 安装 + `pet-state.json`/`heming.pet.v1` 迁移 +
  门禁全绿。云端下载与发布脚本同轮完成（服务端改动小、集中）。
- **P1**：对话改宿主代发（Key 完全不出主进程，若网关 Key 也要收口）、多显示器/缩放/可见性冻结复测、
  包体与性能复测、卸载时可选保留设置。
- **P2**：第三方界面插件（另立沙箱规格）、多 widget 并存、widget 页面贡献（主窗内嵌面板）。

## 8. 验收

- `pnpm -r build && pnpm -r test && pnpm -r typecheck` 全绿（desktop 的 `node --test` 含新用例）。
- 主窗构建产物里**不再出现** pet 入口 / pixi / Live2D（查 `dist/index.html` 的 modulepreload 与 chunk 清单）。
- 安装 `heming.pet` 后：桌面出现角色、可点、可拖、可穿透、右键菜单、托盘、设置表单生效、对话可用、事件气泡可用。
- 卸载后：窗口/托盘/设置/文件全部消失，主窗无报错。
- 旧 `pet-state.json` / `heming.pet.v1` 迁移后位置、缩放、穿透、绑定不丢。
- IPC 不变量用例（`main.test.js`）覆盖 `widget:` 前缀与自校验；`packaging.plugins.test.js` 覆盖 bundle 包不进安装包。
