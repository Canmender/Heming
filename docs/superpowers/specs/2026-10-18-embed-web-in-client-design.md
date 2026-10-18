# 和鸣 · web 界面嵌入桌面客户端 · 设计文档

- 日期：2026-10-18
- 设计者：美术设计会话
- 状态：**已实施**（端到端已验，见 §10）；自动更新另开一批
- 关联：`2026-10-13-heming-platform-design.md`（架构：原生桌面端）、`docs/deploy.md` §7（`VITE_API_BASE` 只服务桌面壳）

---

## 1. 动机

现状：桌面壳加载**远程** `http://47.92.39.184`，UI 完全来自云端。由此带来：

1. **UI 改动必须先部署云端**才在客户端可见（登录页分栏就是例子）。
2. **启动依赖网络**——云端不可用则客户端进不去。
3. 与「原生桌面端」定位不符（云端按架构红线只是 IM 桥梁，却承担了整个 UI 的供应）。

目标：把 web 构建产物**打进安装包**，本地加载；API 与 WS 仍走云端。UI 随包发布，启动不再依赖网络。

**明确的代价**（用户已知悉并接受）：给**已安装**客户端发 UI 更新需重打安装包。开发不受影响（开发走 `HEMING_DEV_URL` 连本地 vite，照样热更新）。自动更新（electron-updater）另开一批。

## 2. 关键约束：不能用 `file://`

`file://` 不是安全上下文，`crypto.subtle` 不可用 → E2E 加密无法初始化。项目红线是「无安全上下文时拒绝发送，绝不降级明文」，所以 `file://` 直接出局。

必须用**自定义协议**并注册为 privileged + secure，才能既本地加载又保住安全上下文。

## 3. 前置实验结论（真实 Electron 31 实测，非推断）

每变体独立进程、带真实 token：

| 变体 | 源 | `isSecureContext` | `crypto.subtle` | 明文 `ws://` |
|---|---|---|---|---|
| `http`（现状基线） | `http://47.92.39.184` | false | false | OPEN |
| **`app://`（本设计）** | `app://heming` | **true** | **true** | **OPEN** |
| `app://` + `allowRunningInsecureContent` | `app://heming` | true | true | OPEN |

结论：
1. `app://` 注册为 secure → 安全上下文成立，**E2E 不受影响**；甚至不再需要现在那个 `--unsafely-treat-insecure-origin-as-secure` 白名单技巧（该开关仍保留给「加载远程页」路径）。
2. 明文 `ws://` **没有**被当混合内容拦掉（原担心成立但我误读过一次：首次探针报 ERROR 是因为**没带 token**，服务端直接关连接）。
3. 故**不需要** `allowRunningInsecureContent` —— 不放宽任何安全开关。
4. 跨域前提已具备：服务端 `Access-Control-Allow-Origin: *`，预检对所有 origin 返回 204（实测 `Origin: app://heming`）。

## 4. 架构

```
安装包内                                  运行时
packages/desktop/web-dist/   ──打包──▶   resources/web/
（web 构建产物，VITE_API_BASE 注入）        ▲
                                          │ app://heming/... 由主进程 protocol.handle 读取
客户端窗口 ──loadURL("app://heming/index.html")
   ├── 静态资源：app:// 从 resources/web 读（无网络）
   ├── REST：http://47.92.39.184/api/*（跨域，CORS: *）
   └── WS  ：ws://47.92.39.184/api/ws（明文，已实测可连）
```

### 4.1 构建管线

- web 包新增 `build:desktop`：`VITE_API_BASE=<云端绝对地址> vite build`，产物拷到 `packages/desktop/web-dist/`
- `packages/desktop/package.json` 的 `dist` 脚本前置该步骤；`electron-builder` 用 `extraResources` 把 `web-dist` 放到 `resources/web`
- `web-dist/` 加进 `.gitignore`（构建产物不入库）
- 云端地址取值优先级：`HEMING_WEB_URL` > 默认 `http://47.92.39.184`（与 `secure-origins.js` 的 `APP_DEFAULT_URL` 同源，避免两处常量漂移）

### 4.2 协议服务（新增 `packages/desktop/app-protocol.js`）

与 Electron 解耦的**纯函数**部分（可直接单测）：
- `resolveAssetPath(urlPath, rootDir)` — URL 路径 → 磁盘路径，含**目录穿越防护**（`..` 越界一律拒绝）
- `contentTypeFor(filePath)` — 扩展名 → MIME
- `shouldSpaFallback(urlPath)` — 无扩展名路径回落 `index.html`（前端路由）

Electron 侧的 `protocol.handle("app", ...)` 只做「取路径 → 纯函数解析 → net.fetch」。

`registerSchemesAsPrivileged([{ scheme: "app", privileges: { standard, secure, supportFetchAPI, corsEnabled, stream } }])` **必须在 app ready 之前**调用。

### 4.3 地址解析

`resolveAppUrl` 优先级改为：

```
HEMING_DEV_URL（本地开发，热更新）
  > HEMING_WEB_URL（显式指定远程）
  > app://heming/index.html（默认：嵌入式，包内 web-dist 存在时）
  > APP_DEFAULT_URL（兜底：web-dist 缺失时仍能远程加载，不至于白屏）
```

最后一条兜底很重要：老包/构建异常时退回远程，而不是打不开。

### 4.4 导航白名单

主 frame 导航白名单加 `app://heming`；`isSafeExternalUrl`（交系统浏览器）保持只放行 http/https/mailto，**不放行 `app:`**——否则页面里的链接可能把自己导航走。

## 5. 与启动动画的相互作用

本地加载让 `did-finish-load` 几乎立刻到达（省掉网络往返），splash 的**可见地板（3.2s）**照旧兜住，四段动画仍完整播满 → 启动观感不变，但少了最坏情况下的网络等待。

## 6. 边界与约束

- 不修改 `shared`/`server`/WS 契约
- 不修改 `ChatPage`/`agentStream`/`TriggerDeps`
- **不放宽任何安全开关**（不用 `allowRunningInsecureContent`、不用 `webSecurity: false`）
- `app://` 之外的一切保持现状：远程加载路径、`secure-origins` 白名单、dev 流程
- 视觉规范不变

## 7. 文件变更清单

| 文件 | 动作 | 说明 |
|---|---|---|
| `packages/desktop/app-protocol.js` | 新增 | 协议服务纯函数（路径解析/穿越防护/MIME/SPA 回落） |
| `packages/desktop/app-protocol.test.js` | 新增 | 上述纯函数单测（含穿越攻击用例） |
| `packages/desktop/main.js` | 修改 | 注册 privileged scheme；`protocol.handle`；地址解析与导航白名单；`extraResources` 路径 |
| `packages/desktop/package.json` | 修改 | `dist` 前置 web 构建；`extraResources` 加 `web-dist`→`web` |
| `packages/web/package.json` | 修改 | 新增 `build:desktop`（注入 `VITE_API_BASE`） |
| `scripts/build-desktop-web.mjs` | 新增 | 构建并把 web 产物拷进 `packages/desktop/web-dist`（含 `VITE_API_BASE` 取值与拷贝清理） |
| `packages/desktop/main.test.js` | 修改 | 地址优先级、导航白名单、scheme 注册时机断言 |
| `.gitignore` | 修改 | 忽略 `packages/desktop/web-dist/` |
| `docs/deploy.md` | 修改 | 补「桌面端嵌入」一节：两套产物、更新方式变化 |

## 8. 验证计划

| 项 | 方式 |
|---|---|
| 纯函数（路径/MIME/穿越/回落） | `node --test` |
| 地址优先级与导航白名单 | `main.test.js` |
| scheme 注册时机（必须在 ready 前） | `main.test.js` 断言调用位置 |
| **端到端（真机）** | 装包启动 → 断网启动应仍能进登录页；登录后 WS/REST 正常；E2E 收发正常 |
| 安全上下文 | 包内页面 `isSecureContext === true`、`crypto.subtle` 存在（实验已验，装包后复验） |

## 9. 待办（本设计不做）

- **自动更新**（electron-updater）：装了旧包的客户端如何拿到新 UI。用户已确认另开一批。
- 设置页显示「当前 UI 版本 vs 云端版本」以便排查「为什么我这没有新功能」。

---

## 10. 实施记录

### 落地

| 文件 | 说明 |
|---|---|
| `packages/desktop/app-protocol.js` | 纯函数：`contentTypeFor` / `isAssetRequest` / `resolveAssetPath`（含目录穿越防护）/ `resolveRequest`（含 SPA 回落判定） |
| `packages/desktop/main.js` | 注册 privileged+secure scheme（**模块顶层，早于 ready**）；`installAppProtocol()`；地址优先级；导航白名单加嵌入式源 |
| `scripts/build-desktop-web.mjs` | 构建并注入 `VITE_API_BASE`，产物拷进 `packages/desktop/web-dist` |
| `packages/desktop/package.json` | `dist` 前置 web 构建；`extraResources` 把 `web-dist` 放进 `resources/web` |
| `.gitignore` | 忽略 `packages/desktop/web-dist/` |
| `docs/deploy.md` §10 | 两套产物对照、发布顺序、地址优先级 |

### 两个实现要点

1. **导航白名单必须按前缀判**，不能用 `originOf`：它走 Node 的 URL 实现，自定义非特殊 scheme 的 `origin` 会得到字符串 `"null"`，拿去比较永远不命中。
2. **资源缺失不回落 `index.html`**：回落会把「JS 404」变成「MIME 类型错误」，报错信息完全指不到真正原因。只有无扩展名的路径（前端路由）才回落。

### 踩到的坑：构建脚本的 `shell`

为消掉 Node 的 DEP0190（`execFile` 同时传参数数组与 `shell: true`）我先去掉了 `shell`，结果**打包直接失败**——Windows 上 `pnpm` 是 `.cmd`，Node 不能用 `execFile` 直接启动 `.cmd`。改为传**单个命令字符串** + `shell: true`：既避开该弃用告警，又能正常启动。

### 验证

| 项 | 结果 |
|---|---|
| 门禁 | desktop 110 / shared 73 / server 186 / web 705 = **1074 全绿** |
| 协议纯函数 | 14 例：MIME、资源/路由判定、路径解析、**目录穿越三种写法（明文/编码/反斜杠）一律拒绝**、资源缺失不回落 |
| main.js 接线 | 7 例：scheme 注册含 `secure: true` 且在 ready 之前、地址优先级顺序、产物缺失退回远程、导航白名单前缀判定、`isSafeExternalUrl` 不放行 `app:`、协议处理器早于建窗 |
| **端到端（真实 Electron，真实产物 + 真实 preload + 真实协议模块）** | 加载 `app://heming/index.html`；`origin=app://heming`；**`isSecureContext=true`**；**`crypto.subtle` 存在**；`window.heming` 桥接存在；**React 渲染出「和鸣 登录你的账号 登录」**；**跨域 REST `200 {"ok":true}`**；**WS `OPEN`**；启动动画遮罩存在 |

控制台只余 Electron 的标准 CSP 警告（CSP 本就在技术债清单里，非本次引入）。

### 已知影响

- **发布变成两处**：web 改动要分别发云端与桌面端，只发一处会出现浏览器与已装客户端版本不一致。已写进 `docs/deploy.md` §10。
- 已装客户端拿不到新 UI，需重装（自动更新待开批次）。
- 开发流程不受影响：`HEMING_DEV_URL` 仍在最高优先级，热更新照旧。
