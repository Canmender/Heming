# 第二轮对抗审计：窗口/协议、IPC、浏览器降级、社区浏览器态、枚举一致性（d.113）

> 审计基线：`8a5caac`（合并 team-optimization 后）；收尾 HEAD `1dacabe`。只读，未改代码。
> 结论：**P0 1 条 + P1 8 条 + P2 11 条**。修复状态见文末「修复记录」。
> 本文保留审计原文（行号以审计时点为准），便于复核修复是否覆盖到位。

# d.113 第二轮只读对抗审计（此前未覆盖路径）

- **基线**：审计开始于 `8a5caac`（工作树 clean），收尾时 HEAD 已到 `1dacabe`；并行会话正在改 `components/PluginsPage.tsx`、`plugins/UnitDiagnostics.tsx`（未提交）。`git diff d359d20..HEAD -- packages/desktop packages/web/src/lib/widgets` 只有 `version-sync.test.js`（测试）——**窗口/协议/widgets 库代码未变，暂停前结论仍成立**；`PluginsPage` 相关行号已按当前工作树重定位，会随该会话继续漂移。
- **范围**：只审上轮明确未覆盖的 5 组路径（窗口/协议、plugin-host IPC、浏览器降级、技能社区浏览器态、枚举一致性）。`packages/server/src/zip.ts` 由并行会话收尾，本轮**未审**。
- **方法**：只读静态审计 + 对照 `docs/PLUGINS.md` 承诺与既有测试注释；未运行测试、未构造恶意包（P0 链条已按代码逐跳验证调用关系）。
- **上轮遗留复核**：✅ P0-1「签名不覆盖代码字节」已由 `packageSha256`（清单内 files/** 摘要 + 安装端重算，`plugin-package.js:85-101, 464-476`）修复；✅ P1-1「只有 dev 公钥」已由 `official-2026-11` + `scripts/check-release-keys.mjs` 修复（`d359d20` 提交）。
- **本轮**：P0 1 条、P1 8 条、P2 11 条。

---

## 0. 分区结论（对应任务 5 组）

| 分区 | 结论 |
|---|---|
| 1. `plugin-window.js` + `app-protocol.js` | 窗口 `webPreferences` **全硬编码**，清单无法影响 sandbox/contextIsolation/nodeIntegration/devTools/preload；`widget://` 路径与 MIME 收口良好；**CSP 未覆盖 400 响应**（P2）；导航闸只放行本插件 origin（OK） |
| 2. `plugin-host.js` IPC | `widget:*` 全部 `withRuntime` sender 校验（fail-closed）、参数逐通道收敛；**theme/tray 事件无条件广播**绕过 `permissions.events`（P1）；`chatConfig` 无权限门（P1，且是 P0 链的数据源）；监听器/托盘/队列清理完整（OK） |
| 3. 浏览器降级 | `widgetsAvailable()` 门禁覆盖全部入口（WidgetsView / 设置卡 / 市场详情 / 命令面板 / 安装弹窗），空态文案齐全；仓库列表 bundle 条目缺前置禁用（P2）；市场降级提示不可恢复（P2） |
| 4. 技能社区浏览器态 | 明文 Key / 无 localStorage 兜底与 UI 提示 OK；401/503/404 有专文案，**429/402 丢服务端中文与 retryAfter**（P1）；**首次无 Key 点「全部更新」会空跑 0 条**（P1）；批量更新不可取消（P2） |
| 5. 枚举一致性 | `docs/plugin.schema.json` 与 shared v5 解析器基本一致（id/version/数量上限逐项对齐）；**`events:["lifecycle"]`、`graphics:["webgl2"]` 三方不一致**（P1）；bundle target 主进程/网页两处同口径（OK）；**`store.repair` 不存在**（无需审） |

---

## 1. P0 清单

### P0-1 ★ 界面插件可绕过「无网络权限」经回环访问本机 API，并借注册接口把用户数据带出本机（数据外泄链）

**三跳全部有代码证据**
1. **数据源（无权限门）**：widget 的 `chatConfig()` 返回全部智能体 `{id,name,prompt}` 与本机网关地址（`packages/desktop/widget-preload.js:89` → `plugin-host.js` `widget:chat-config` → `main.js:1203-1206` `{ baseUrl: ensureMagpieProxy(), key:"local" }`；`packages/web/src/App.tsx:644-646` 把 `agentsRoster` 连同 **`prompt`（人设提示词）** 一起回给主进程）。清单里没有任何 `permissions.chat`/`agents` 声明位，`permissions` 只有 network/tools/files/events/graphics/eval（`packages/shared/src/plugin/manifest.ts:367-371`）——即**装了就有，无需声明**。
2. **回环通道**：widget CSP 的 `connect-src` 固定包含 `http://127.0.0.1:*`、`http://localhost:*`（`packages/desktop/app-protocol.js:136, 266-270`），插件无需 `permissions.network` 即可请求任意本机端口。
3. **出口（无鉴权）**：本机 Express 用 `Access-Control-Allow-Origin: *`（`packages/server/src/app.ts:63-66`），默认只监听 `127.0.0.1`（`packages/server/src/index.ts:20`）；`POST /api/skill-hub/register` **无鉴权、无本地限流**（`packages/server/src/skillHub.ts:859-905, 952`），body 的 `name` 最长 128 字并**原样转发到上游虾评**（`skillHub.ts:864-880`）。

**复现思路**：装一个带 `permissions.network: []` 的界面插件 → `const c = await __heming_widget.chatConfig()` → 把 `c.agents[i].prompt` 分片塞进 `fetch("http://127.0.0.1:<port>/api/skill-hub/register", {method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify({name: 分片})})` → 数据出现在上游账号名里，整条链**没有声明任何网络主机**。

**影响**：与「界面插件没有 secrets/会话/文件桥，只能通过 `widget:*` 与本机交互」的隔离承诺（`widget-preload.js:1-20`、规格 §3.4）直接冲突；用户智能体提示词（可能含个人偏好/业务上下文）可外泄。Token 保护的端点读不到（token 在 `app://` localStorage，widget 无同源），所以不是全量 API 泄露，但上述链已成立。

**建议修法（任一即可断链，建议叠加）**
- CSP `connect-src` 只放行 magpie 实际端口（渲染时从 `getGateway()` 动态注入），去掉 `127.0.0.1:*` 通配；
- `chatConfig` 增加清单声明位（如 `permissions.chat`/`permissions.agents`），未声明返回空；`agents[].prompt` 默认不下发（只需 name/id 即可绑定）；
- `/api/skill-hub/register`（及所有无鉴权端点）加 Origin/同源或本地令牌校验 + 限流；
- 服务端 CORS 改为仅允许 `app://heming`（Electron 自定义 origin）而非 `*`。

---

## 2. P1 清单

### P1-1 ★ 清单许可值与解析器/文档三方不一致：`lifecycle` 事件与 `webgl2` 无法通过官方校验
- **文档承诺**：`docs/PLUGINS.md:332` 示例 `"events": ["lifecycle"]`、`:353` 明确「不含 lifecycle 收不到事件」；`widget-preload.js:74-83` 暴露 `onLifecycle`。
- **桌面侧接受**：`packages/desktop/plugin-package.js:49-50` `ALLOWED_EVENTS = ["notify","lifecycle"]`、`ALLOWED_GRAPHICS = ["webgl","webgl2","wasm"]`。
- **shared 解析器拒绝**：`packages/shared/src/plugin/manifest.ts:369-370` 只允许 `notify` / `webgl|wasm`；`docs/plugin.schema.json:141-144, 151-154` 同 shared。
- **后果**：①按文档写的 bundle 清单过不了 `node scripts/plugin-lint.mjs`（其权威校验就是 `parsePluginManifestV5`）；②市场详情对 bundle 也走 `parsePluginManifest` 展示贡献（`MarketDetailDialog.tsx:160-172`），会显示「事件只支持 notify」而安装本身却能成功（桌面侧独立校验）——工具/UI 与运行时结论相反。
- **修法**：shared v5 的 permissions 对 `distribution: bundle` 放宽 `lifecycle`（webgl2 决定是否保留），并同步 schema/docs；或统一为单一权威校验入口（桌面 `plugin-package.js` 不再维护第二份 allowlist）。

### P1-2 ★ 首次无 Key 点「全部更新」会空跑 0 条（状态机断链）
- `openBulkUpdate()` 在无 Key 时 `setPendingBulk(true)` 后**直接 return**，没有执行 `setBulkRows([...communityUpdates])`（`SkillHubPanel.tsx:969-980`，对比有 Key 分支 `:981-984`）。
- Key 弹窗保存后的续跑用 `runBulkUpdate(state.key, bulkRows)`（`:1330`），而 `bulkRows` 仍是初始 `[]` → 循环 0 次、`bulkDone=true`，弹窗显示「将按顺序更新 0 个」。
- 触发：新用户/清过 Key，社区技能有可更新项 → 点「全部更新」→ 填 Key → 什么都没更。
- 修：无 Key 分支先冻结 `bulkRows` 再开 Key 弹窗（或 onSaved 时用 `communityUpdates` 兜底）。

### P1-3 客户端吞掉服务端的中文错误与 `retryAfter`（429/402 变成裸 HTTP 码）
- 服务端已构造可行动文案：429 带 `retryAfter`（`skillHub.ts:457-460`、`:646`、`:758`），402/上游错误走 `messageOf`。
- 客户端只特判 401/503/404，其余一律 `HTTP ${status}`（`packages/web/src/lib/skills/hubClient.ts:82-92`），**不读 response body**。用户看到「技能社区请求失败：HTTP 429」而不是「上游限流，请稍后重试」。
- 修：非 ok 时先尝试解析 `{error, retryAfter}`，拼进 `SkillHubError`。

### P1-4 界面插件安装/卸载的落盘失败没有回滚（记录与目录会不一致）
- `install()`：`Object.assign(existing, record)` 已在内存生效后才 `writeJsonAtomic(current.json)`/`save()`（`plugin-store.js:261-265`）；`save()` 抛错未被捕获（IPC handler 也无 try/catch，`main.js:1242-1248`），渲染层只得到 Electron 的 invoke 异常文案。
- `uninstall()`：先 `rmSync` 删版本目录/文件，最后 `save()`（`plugin-store.js:279-330`）——save 失败时文件已删、记录仍指向缺失目录；能靠 `init()` 自检标 `error` 并停用（`:140-150`），但用户设置/模型数据已丢。
- 修：`install` 先写注册表再切指针（或二者同 try 回滚）；`uninstall` 先写注册表后删文件，失败可重试。

### P1-5 `theme`/`tray` 事件绕过 `permissions.events` 门禁（与文档口径冲突）
- `publish()` 对 `theme`、`tray` 直接遍历**所有** runtime 广播（`plugin-host.js:1171-1185`），只有 `notify` 才检查 `permissions.events.includes("notify")`（`:1186-1190`）；而 `permissions.events` 的合法值只有 `notify`（+桌面侧 `lifecycle`）。
- 后果：未声明任何事件的插件也能收到主题变化与托盘动作；文档「未声明就收不到」（`docs/PLUGINS.md:353` 语境）与实际不一致。信息量低（theme 字符串、tray 动作名），但违反最小权限口径。
- 修：`theme`/`tray` 也纳入 events allowlist（或明确它们是系统级广播并写进文档/`events` 枚举）。

### P1-6 `chatConfig` 能力未进权限模型（P0-1 的数据源）
- 见 P0-1：任何已装界面插件都能读全部智能体 `prompt` 与本机网关地址；`permissions` 没有对应声明位。即使修掉回环外泄，**读取本身**也超出「插件只拿到自己设置与窗口能力」的最小授权（`widget-preload.js:1-20` 的承诺）。
- 修：加声明位；或在设置里让用户显式勾选「允许该插件读取智能体列表」。

### P1-7 源码混入 NUL 字节，导致工具链把文件当二进制（审计/供应链盲区，范围外但重要）
- `packages/web/src/lib/wiki/index.ts` 第 7628 字节有 NUL → `git log --numstat` 显示 `- -`，**该文件的历史 diff 在 git 里不可读**（实测 `7ee9728` 提交）；`packages/shared/src/plugin/manifest.ts`（20124/20128，安全解析器）与 `docs/superpowers/specs/...md`（15215）也有 NUL，`grep/file` 会把它们判为 binary（本轮审计必须用 `grep -a` 才读得到 manifest.ts）。
- 风险：review/扫描工具跳过或误判这些文件，恶意改动可借「二进制」形态逃过 diff 审视（manifest.ts 尤其敏感）。
- 修：把注释里的裸 NUL 改成文本 `\0` 转义（纯注释，零行为变化），加一条 CI 检查「源码不得含 NUL」。

### P1-8 并发/取消语义缺失（技能下载与批量更新）
- `busyId` 只锁当前条目（`SkillHubPanel.tsx:1264`），点另一条会并发下载安装；`hubClient` 所有请求**无 AbortSignal/超时**（全文件无 `signal`），关面板/关弹窗后请求继续跑（`BulkUpdateDialog` 运行中关闭按钮 `onClick={onClose}` 未禁用，`:611-617`）。
- 后果：弱网下重复下载、UI 状态与真实安装错位；批量更新无「停止」。
- 修：请求加 `AbortSignal.timeout` + 全局 in-flight 锁；批量更新加「停止」并让关闭按钮在 running 时确认。

---

## 3. P2 清单（简短）

1. **CSP 未覆盖 400 响应**：`app://`/`widget://` 的 catch 分支 `new Response("bad request",{status:400})` 未带 CSP（`main.js:345-348, 416-419`）；当前 body 是静态文本，属纵深防御缺口。建议所有响应统一过 CSP 头。
2. **无 `X-Content-Type-Options: nosniff`**：`widget://` 按扩展名给 Content-Type（`main.js:437-448`），MIME 嗅探对自定义 scheme 影响有限，建议补 nosniff。
3. **`permissions.files` 仅展示**：`plugin-package.js:249-250` 注释自述「本轮仅展示」；用户会误以为文件权限受限。
4. **`current.json` 只写不读**：`plugin-store.js:261` 写入后全仓无读取点（`currentDir` 用注册表版本），死状态易误导后人。
5. **界面插件无防降级**：`plugin-store.install` 不比较版本，旧版官方签名包可随时重装（与声明式 `highestVersion` 口径不同）；建议至少提示「正在降级」。
6. **卸载 keepData 中途失败丢设置**：先删文件后写回 settings/state（`plugin-store.js:296-330`），中间失败即丢。
7. **本地安装取消显示为红色错误**：「已取消」走 `outcome.ok=false` → `setError`（`PluginInstallDialog.tsx:140-148`），应视为中性返回。
8. **仓库列表 bundle 条目无前置禁用**：浏览器点安装会先下完整 tgz 再报「仅桌面端可用」（`PluginsPage.tsx:407-421` 先 `installBundleFromMarket` 后判错）；市场详情页已正确前置禁用（`MarketDetailDialog.tsx:88-93`），两处口径不一。
9. **市场降级提示不可恢复**：`marketFallback` 只 set 不清（`PluginsPage.tsx:164, 620-624`），市场恢复后仍显示「目录暂时不可用」。
10. **`widgets:install` 无 IPC 层大小上限**：`payload.bytes` 可直接进 `readPackage`（`main.js:1242-1248`）；主进程解包上限兜底，但 IPC 先整包入内存。
11. **bundle 命令 target 只在 web 侧解析存在性**：主进程只校验形状（`plugin-package.js:288-330`），`page`/`settings.card`/`unit` 是否存在由 `widgets/commands.ts:38-59` 二次过滤 → 不存在的目标会「命令静默消失」；建议安装时提示或拒绝。

---

## 4. 明确确认 OK 的部分（避免误伤）

- **窗口安全选项不可被清单影响**：`widgetWindowOptions` 显式写死 `preload`（固定路径）、`contextIsolation:true`、`nodeIntegration:false`、`sandbox:true`（`plugin-window.js:286-292`）；清单只影响 `transparent/alwaysOnTop/skipTaskbar/resizable/宽高/title`，宽高有 `MIN/MAX_WIDGET_SIZE` 夹取（`:507-514`）；`entry/icon` 只接受包内相对路径且分别限 `.html/.png`（`:75-86, 502-553`）。
- **IPC 收口**：`widget:*` 全部经 `runtimeForEvent`→`withRuntime`（`plugin-host.js:752-775`），查不到 sender 一律拒绝；`settings-set` 经 `patchSettings` 按清单字段白名单 + 类型收敛（`plugin-store.js:339-353` + `coerceSetting`）；`action` 走 switch 白名单（`plugin-host.js:1118-1152`）；`open-page` 经 `normalizeWidgetPage` 白名单。
- **生命周期清理**：`destroy()` 清 saveTimer、销毁窗口与托盘（`plugin-host.js:463-478`）；`destroyAll` 清 pendingLifecycle + `unwatchDisplays`（`:1111-1115`）；`retireRuntime` 的延迟销毁带 clear（`:1009-1015`）；`chatConfigPending` 有超时清理（`main.js:493-518`）。
- **协议与 CSP**：`widget://` host 必须是已安装插件 id，路径解析复用 `resolveAssetPath` 且无 SPA 回落（`main.js:409-456`）；CSP `frame-src 'none'`/`base-uri 'none'`/`form-action 'none'`/`object-src 'none'`，`eval` 仅在清单 `eval:true` 时放行（`app-protocol.js:258-292`）；tar 拒符号链接/硬链接（`plugin-tar.js`）。
- **浏览器降级**：`widgetsAvailable()` 为 false 时——WidgetsView 空态（`:99-108`）、设置卡「仅桌面端可用」（`WidgetSettingsCard.tsx:110-118`）、市场详情禁用并给原因、命令面板跳过（`CommandPalette.tsx:147-155`）、安装弹窗显示说明（`PluginInstallDialog.tsx:193-197`）。
- **技能社区 Key**：优先加密桥、无桥明文兜底并在 UI 明示（`hubClient.ts:266-292`；`SkillHubPanel.tsx:145-147`）；无 localStorage 时退化为**会话内存**（不落盘，UI 文案写「保存在本机」略不准确，但比落明文好）。
- **枚举/上限一致性**：schema 的 `maxItems` 与 `PLUGIN_LIMITS`（skills 50 / mcp 10 / commands 30 / toolPacks 10 / network 20 / files 5 / events 8 / graphics 8）逐项一致；command target 五类与 shared 一致；bundle 侧四类（无 skill）在桌面与 `widgets/commands.ts` 两处同口径。

---

## 5. 未覆盖 / 限制

- 未运行任何测试、未做动态验证（恶意插件、超大包、DNS/本机端口探测均未实跑）；P0-1 的三跳均按源码逐一核对，复现需自建已签名 bundle（可用仓库测试夹具私钥 + `allowDevKeys`，但**不能**在打包版验证）。
- `packages/server/src/zip.ts` 按 lead 指示本轮未审（并行会话收尾中）。
- 未逐行读：`plugin-host.js` 的拖拽/显示器几何数学、`plugin-store.js` 的状态迁移细节、`MarketView` 全部分支、`SkillHubPanel` 的列表缓存/远程版本聚合。
- `store.repair`：全仓 grep 无实现（`packages/web/src`、`packages/desktop`、`packages/server` 均无），故「越权/误删」路径不存在，无需审计。

---

## 6. 最该先修的 3 条

1. **P0-1（回环 + 无鉴权注册出口 + chatConfig 无权限门）**：链式数据外泄，且修法都小（CSP 收紧到 magpie 端口 / 加声明位 / 服务端 Origin 校验）。
2. **P1-1（lifecycle/webgl2 三方不一致）**：官方文档示例过不了官方 lint，市场预览与安装结论相反——发布前必须统一。
3. **P1-2（全部更新空跑）**：一次性状态机 bug，丢 `setBulkRows` 一行，用户第一次用社区更新就会踩到。

---

## 修复记录（d.113 落点）

| 编号 | 修复 |
|---|---|
| P0-1 | chatConfig 不再下发 `agents[].prompt`；新增 `permissions.chat` 声明位（默认 false）；widget CSP 去掉 `127.0.0.1:*` 通配、改为网关 origin + 声明主机；桌宠 1.0.2 声明 `chat: true` |
| P1-1 | shared v5 权限枚举与桌面运行时对齐：`events` 增 `lifecycle`/`theme`/`tray`，`graphics` 增 `webgl2`；schema/文档同步 |
| P1-2 | 「全部更新」无 Key 时先冻结清单，保存 Key 后续跑 |
| P1-3 | hubClient 透传服务端中文错误与 `retryAfter`（429 文案） |
| P1-4 | 界面插件安装/卸载改为可回滚顺序（先写记录后删文件/失败还原） |
| P1-5 | `theme`/`tray` 事件纳入 `permissions.events` 门禁 |
| P1-6 | 由 P0-1 的 `permissions.chat` 一并收口 |
| P1-7 | 清除源码 NUL 字节 + `scripts/check-source-encoding.mjs` 守卫 |
| P1-8 | 社区请求统一 15s 超时/可取消、安装单飞、批量更新可停止 |

P2 未全部处理，保留在原文 §3 供后续排期。
