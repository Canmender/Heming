# ③-4 安全复审（E2E / 本机存储 / IPC / 网络白名单 / 注入面）

- **复审时间**：2026-11-02（工作区基线 d.59.2.20.0，`feat/team-system`）
- **方法**：源码逐条读 + `file:line` 取证；真机 Electron 45.2.1 冒烟（`.tmp/ipc-guard-smoke.json`）；定向用例回归。
- **结论计数**：**28 条结论 / 已修 3 / 待修 4 / 新增（补充）用例 22**。
- **说明**：工作区同时有第四波 task-14（Electron 46 前置：E2E 热路径异步化）在改
  `secureStorage.ts`/`e2eSession.ts`。本文按「当前工作区」取证；涉及正在被重写的函数时
  以函数名 + 当次行号标注，语义以测试（`secureStorage.d58.test.ts`、`e2eSession.crypto.test.ts`）
  锁定的契约为准。

---

## 摘要：已修 / 待修清单（供 CHANGELOG 与交接）

### 已修（3 项，本轮）

| # | 问题 | 严重度 | 修法 | 回归用例 |
|---|---|---|---|---|
| F1 | **桌宠/任意渲染进程可越权调用能力型 IPC**（复审前只有 file-fs 有 sender 校验：wiki/chart/export/secret/mcp/update/infohub 对任意渲染进程开放；桌宠与主窗口同源、共用 preload） | 高 | 新增 `secure-origins.js` 的 `guardIpc`/`makeSenderCheck`（fail-closed，只认主窗口）；`main.js` 建 `secureIpc` 门面接入全部能力模块；`app:version` 显式豁免；另加「通道不变量」源码守卫防新通道绕过 | `secure-origins.test.js` +5（13）；`main.test.js` +2（36）；真机 12/12 |
| F2 | **桌宠窗口无导航拦截**：frame 被导航到远端页面后，远端脚本即可用 preload 桥（拉子进程/解密预言机/写文件） | 高 | `pet-host.js` 加 `will-navigate` 白名单（未接线 fail-closed）+ `setWindowOpenHandler` 一律 deny；白名单由 main.js 注入 `isAllowedNavigation(url, resolveAppUrl())` | `pet-host.test.js` +2（33） |
| F3 | **wiki-fs 缺参数上限**：`wiki:write` 内容无长度/字符约束、`wiki:log` 的 kind/title/extra 可注入换行且无上限 | 低 | 单文件 2MB + NUL 拒绝（`wiki-fs.js:44-49,90-92`）；log 的 kind 白名单、title 压一行/120 字、extra 4000 字（147-154） | `wiki-fs.test.js` 新增 8（新文件） |

### 待修（4 项，处置已定）

| # | 问题 | 处置（Lead 已定） | 本轮为什么不修 |
|---|---|---|---|
| P1 | `heming.draft.*` 输入框草稿明文（未发送正文） | **等 hotpath task-14（异步写优先）收口后由 Lead 协调本会话做** | 输入热路径，需与 task-14 同一套异步写/写穿缓存语义，避免并发冲突 |
| P2 | `heming.token` 会话 Bearer 明文 localStorage | **记入 HANDOFF 已知边界，单独立项** | d.36 三键外；改它牵动登录/401/多标签一致性 |
| P3 | file-fs 可写根清单由渲染层逐次传入（注入脚本可任选非盘符目录写） | **下一波改「主进程持久化根 + rootId」** | 属新能力 + 设置区迁移，不是复审能修一行解决的问题 |
| P4 | 服务端 `/api/files/:id/content` 回显用户提交的 mime 且无 `nosniff` | **下一波在 server 侧修**：固定 `application/octet-stream` + `X-Content-Type-Options: nosniff` + `Content-Disposition` | task-13 写域不含 `packages/server`，且需服务端契约测试 |

---

## 0. 结论总表

| # | 领域 | 结论 | 判定 |
|---|---|---|---|
| C1 | E2E | 无安全上下文（无 `crypto.subtle`）时，正文/agent chunk/附件/语音各发送路径全部前置拦截，不降级明文 | ✅ 通过 |
| C2 | E2E | 附件加密上传：服务端只见密文（`application/octet-stream` + `.enc` 前缀），`fileKey` 只随消息密文上行 | ✅ 通过 |
| C3 | E2E | 附件下载/回显只在渲染层解密，失败给可读占位，不落明文缓存 | ✅ 通过 |
| C4 | E2E | 棘轮状态写盘前「加密→解密→逐 byte 比对」自校验；失败 fail-open 写新明文并点名，不回退旧盘值（避免 msgKey 重用） | ✅ 通过 |
| C5 | E2E | 设备私钥只在设备内：`PUT /api/e2e/keys` 只登记**公钥**（schema 无 priv 字段；导出函数只 export 公钥） | ✅ 通过 |
| C6 | 存储 | `msgCache` 有桌面桥时是 v2 容器逐条密文（id 明文索引），无桥/不可用/配额时明文并按原因如实标注 | ✅ 通过 |
| C7 | 存储 | `chains` 有桥时 d.36 整值信封 + 自校验；`deferred` 本身是 E2E 密文，LRU 账本只有 convId+时间 | ✅ 通过 |
| C8 | 存储 | 迁移备份键 `.__heming_plaintext_backup` 只在「新密文自解密通过」后清理；`.__heming_undecryptable` 永不删 | ✅ 通过 |
| C9 | 存储 | 用户主动「导出会话/记忆」写明文文件属显式用户动作（导出入口），不是静默残留 | ✅ 通过（设计如此） |
| C10 | 存储 | 设置区「消息缓存」「密钥存储」卡三态/四态文案与实现一致，不谎报；备份键不提供清理入口 | ✅ 通过 |
| C11 | 存储 | **输入框草稿 `heming.draft.*` 是明文**（未发送的消息正文）——与「热路径本地加密」红线不一致 | ⚠️ 待修 |
| C12 | 存储 | `heming.token`（会话 Bearer）仍是明文 localStorage——d.36 三键范围外的已知边界 | ⚠️ 待修（记录） |
| C13 | IPC | preload 桥清单固定、无任意命令执行入口；`secret:bootstrap` 只认三个白名单键 | ✅ 通过 |
| C14 | IPC | 参数形状/长度在各自模块内复检：file-fs（根/路径/内容/文件数/总量）、export/chart（文件名白名单+后缀+内容上限）、wiki（路径/白名单/内容上限）、mcp-stdio（命令/参数长度）、infohub（方法白名单/行上限）、notify（标题/正文/会话 id） | ✅ 通过 |
| C15 | IPC | **只有 file-fs 有 sender 校验**；wiki/chart/export/secret/notify/mcp/update/infohub 对任意渲染进程开放——桌宠窗口与主窗口同源、共用 preload，可越权调用 | 🔧 已修 |
| C16 | IPC | 桌宠窗口没有导航拦截：frame 被导航到远端页面后，远端脚本可直接用 preload 桥（子进程/解密/写文件） | 🔧 已修 |
| C17 | IPC | file-fs 越界防线：绝对路径 + 根内夹取、逐级软链、硬链 `nlink>1`、NUL、Windows 保留名、非普通文件、上限、两阶段 tmp+rename | ✅ 通过 |
| C18 | IPC | export-fs/chart-fs 目录固定、文件名白名单、`..` 直接拒绝、后缀白名单；wiki-fs 路径夹取 + 相对路径白名单 | ✅ 通过 |
| C19 | IPC | **可写根清单由渲染层逐次随请求传入**：渲染层（若被注入脚本）可自带任意非盘符根，把 `file_patch` 变成任意目录写——需主进程侧持久化/授权根 | ⚠️ 待修 |
| C20 | 网络 | notify / crash-log / secret-store / export-fs / file-fs 五个「只该在本机」模块零网络能力，且各有源码守卫测试 | ✅ 通过（file-fs 的守卫本轮补齐） |
| C21 | 网络 | 其它桌面模块的网络/子进程能力集中在 auto-update / mcp-stdio / infohub（均为产品功能，非「只在本机」保险类） | ✅ 通过（边界明确） |
| C22 | 注入 | Markdown 用 react-markdown 且**未装 rehype-raw**：消息里的原始 HTML 只按文本渲染，不产生元素、不执行脚本 | ✅ 通过 |
| C23 | 注入 | KaTeX 走 rehype-katex（默认 `trust:false`），`\href{javascript:…}` 不产生可点链接；shiki 输出 HTML 由本库转义（唯一 innerHTML 注入点） | ✅ 通过 |
| C24 | 注入 | 图表 SVG 用 `esc()` 转义全部模型文本后注入 innerHTML；`charts.test.ts` 已有 `<script>` 注入断言 | ✅ 通过 |
| C25 | 注入 | 附件/文件名/通知文案：气泡与通知全部 React 文本节点；通知正文经 `cleanText` 掐控制符并限 80/160；会话 id 正则限制；导出/图表文件名白名单 | ✅ 通过 |
| C26 | 注入 | 服务端 `/api/files/:id/content` 回显用户上传时提交的 `mime`（`res.setHeader`），且无 `X-Content-Type-Options: nosniff` | ⚠️ 待修（服务端加固，非本轮写域） |
| C27 | IPC | 真机冒烟：主窗口 12 项能力桥全部放行（wiki/exports/charts/update/secrets/version），桌宠窗口同一批桥全部被 `untrusted-sender` 拒绝 | ✅ 已验（见 §6） |
| C28 | 注入 | `dangerouslySetInnerHTML` 全仓仅 3 处（Markdown 的 shiki 输出、图表 SVG、FilePreviewModal 注释说明），逐处有转义/白名单依据 | ✅ 通过 |

---

## 1. E2E 路径

### C1 无安全上下文拒绝发送（各路径）
- 统一开关：`ChatPage.tsx:633-634`（`subtleOk = hasSubtle()`）、常驻横幅 `ChatPage.tsx:2923`、提示文案 `ChatPage.tsx:124-125`。
- 正文发送：`ChatPage.tsx:726-737` 的 E2E 封发入口 `if (!hasSubtle()) { setSendNotice(NO_E2E_NOTICE); return… }`；
  附件/语音发送另有前置拦截 `ChatPage.tsx:2150-2156`；agent 触发端 `ChatPage.tsx:1196-1197`；
  链初始化/分发 `ChatPage.tsx:1675`、`1719`；发送前最后一道 `ChatPage.tsx:2018-2024`。
- 结论：**所有发送路径都没有「无 subtle 就发明文」的分支**；`hasSubtle()` 定义在 `e2eCrypto.ts:15-17`。

### C2/C3 附件加密
- 上传：`api.ts:279-314`——`if (!hasSubtle()) throw`（286）、随机 32B fileKey + AES-256-GCM + 固定 AAD（288-303）、
  服务端只见 `application/octet-stream` 与 `.enc<name>`（309-311）、**fileKey 不上行**（313 只回给调用方随消息密文走）。
- 下载/回显：`api.ts:324-359`——无 subtle 先拦（329）、IV 前置布局（340）、解密失败统一可读文案且不吐栈（355-358）；
  气泡侧 `ChatPage.tsx:249-250`（`payload.file.key` 存在才走解密）、`vision/history.ts:104-110`。
- 失败/占位的回归：`api.test.ts:337-520`（往返、错 key、坏字节、401 口径）。

### C4 棘轮状态写坏保护
- 写入前置：`secureStorage.ts:913-936` `encryptVerified()`——加密后立刻解密，`roundTrip !== plain` 即 `verify-failed`（逐 byte，注释 570-571）；
  失败**不写坏密文**，`secureSetItemVerified` fail-open 写新明文并标记（`secureStorage.ts:976-1040` 的步骤 2/4）。
- 链状态使用点：`e2eSession.ts:633-653`（`saveChains`：异步优先时排队落盘，失败 fail-open 新明文；同步桥路径走 `secureSetItemVerified`）；
  首读懒迁移 `e2eSession.ts:584-619`；坏 JSON 先原样备份再按空链继续（`parseChainsValue`，571-582）。
- 与「不回退旧盘值」的既定口径一致（Q1 补充口径，见 P0-5b spec §9）：链单调推进，回退会复用 msgKey。
- 回归：`e2eSession.crypto.test.ts:349-372`（自校验失败 fail-open + 点名）、`secureStorage.d58.test.ts`。

### C5 密钥不出设备
- 设备身份（含私钥 JWK）只在本地：`e2eSession.ts:495` 写 `IDENTITY_KEY`（有桥走安全存储信封；无桥明文，设置卡点名）。
- 上云只导出公钥：`e2eSession.ts:843-850` `exportOwnDeviceKeys()` 只 `exportPub`（spki）与 SPK 公钥+签名；
  schema `packages/shared/src/schemas.ts:380-392` 只有 `ikEcdh/ikSign/spk.pub/spk.sig`，**没有 priv 字段**；
  服务端 `packages/server/src/app.ts:426-431` `PUT /api/e2e/keys` 的 body 即该 schema。
- 结论：服务端/网络层拿不到私钥；私钥泄露面只在「本机 safeStorage 不可用时的明文身份」——该状态由设置区「密钥存储」卡点名（C10）。

---

## 2. 本机存储明文残留

### C6 msgCache
- v2 容器：`e2eSession.ts` 写侧 `writeCacheView/appendCache`（当前 1252/1564 起）、读侧 `list/get`；
  `id` 明文索引、正文逐条密文；形式判定 `MsgCacheStorageForm`（`e2eSession.ts:1434-1470`）区分
  `encrypted/plaintext/unreadable/absent`。
- 旧明文迁移：打开会话懒迁移（每批 ≤50）+ 启动全量兜底 `migrateAllMsgCaches`（`e2eSession.ts:1918` 起，幂等、fail-open、绝不丢消息）；
  覆盖前先写 `.__heming_plaintext_backup`（`secureStorage.ts:39`），加密失败保留明文条目标注。
- 回归：`e2eSession.crypto.test.ts`（容器/迁移/配额/坏数据）、`e2eSession.migrateAll.test.ts`。

### C7 deferred / LRU / chains
- `deferred` 前缀 `heming.e2e.deferred.*`（`e2eSession.ts:58`）：队列里是**已封好的 E2E 密文信封**，不加密是刻意的（再包一层无收益）。
- LRU 账本 `heming.msgCache.lru.v1`（`e2eSession.ts:2056`）：只有 convId→时间戳，无消息内容。
- `chains`：见 C4；有桥时整值信封、无桥时明文（浏览器行为不变，桌面不可用时设置卡点名）。

### C8 备份键清理
- 常量：`secureStorage.ts:34/39`；清理实现 `secureStorage.ts:1219` 起 `cleanupPlaintextBackups`（当前行号；函数语义未变）：
  只处理 `.__heming_plaintext_backup`（849-853 的注释口径）、主键缺失/仍明文/解不开一律保留、`.__heming_undecryptable` 永不删、
  版本标记幂等；守卫用例 `secureStorage.d58.test.ts:204/231`。
- 未做清理入口的 UI 口径：`StorageUsageCard.tsx:229-236`（备份键不在清理范围，理由「可能是唯一可恢复副本」）。

### C9 导出
- 导出是**用户显式动作**：会话导出 Markdown（`ChatPage.tsx` 导出按钮链路，`ChatPage.test.tsx:498` 用例）、
  记忆导出走 `export-fs.js`（固定 `~/Heming/exports`、`.json`、文件名白名单：`export-fs.js:62-97`）。
- 结论：不视为「明文残留漏洞」，但导出文件本身是明文，文档/设置区应保持「导出即解密后落盘」的预期（当前 UI 文案已按导出语义描述）。

### C10 设置区一致性
- 「消息缓存」三态：`StorageUsageCard.tsx:279-306`——已加密（点名平台）/ 未加密（原因：配额、备份失败、旧明文待迁移、安全存储不可用）/
  无法解密（密文仍在，可能来自其它设备或账户）；不含 `absent`（读不到 ≠ 未加密，见 287-288）。
- 「密钥存储」四态与覆盖范围：`KeyStorageCard.tsx:83-120`——明确只覆盖三把钥匙 + 会话链与消息缓存，浏览器端明文；
  不可用时只说「新写入」明文，不把旧密文说成明文（97-100）。
- 结论：与实现一致，不存在「谎报已加密」路径。

### C11（待修）草稿明文
- `drafts.ts:8-17`：`heming.draft.<convId>` 存 `{text, at}`，**明文**；`drafts.ts:17` 前缀、`MAX_DRAFT_CHARS=2000`（23）。
- 风险：草稿是「尚未发送的消息正文」，与 d.57 热路径加密红线（msgCache/chains 不落明文）不一致；磁盘取证/备份/换账户场景可读。
- 为什么本轮不修：草稿是**输入热路径**（每次输入防抖落盘），走同步桥会卡输入、走异步需要与 task-14 的
  「异步写优先」同一套排队/写后读语义；改它属于热路径加密的延伸设计，需单独评测（与 task-14 有写域重叠，避免并发冲突）。
- 建议：task-14 完成后，按 `secureSetItemAsync` + 写穿缓存同款模式加密草稿；无桥/不可用时保持明文并由「消息缓存」卡同一口径点名。

### C12（待修·记录）会话 token 明文
- `api.ts:64-69`：`heming.token` 直接 `localStorage.setItem`。d.36 只覆盖三把钥匙，token 不在范围内。
- 风险：Bearer 是短期会话凭据（服务端可吊销），但本机磁盘/备份可见；与「密钥存储」卡的承诺边界不冲突（卡只承诺三把钥匙，未提 token）。
- 为什么本轮不修：改 token 存储会牵动登录/401 重放/多标签一致性，属独立安全项；先记录边界，避免把它误算成「d.36 已覆盖」。

---

## 3. IPC 边界

### C13 preload 桥清单与固定入口
- 桥清单：`preload.js` 的 `exposeInMainWorld`——`heming`（启动信号）、`__mcp_stdio`（43-54）、`__heming_runtime`（60-63）、
  `__heming_version`（67）、`__heming_update`（72-93）、`__heming_wiki`（99-112）、`__heming_chart`（117-124）、
  `__heming_exports`（130-133）、`__heming_secrets`（218-273）、`__heming_notify`（274-293）、`__heming_pet`（294-349）、
  `__heming_files`（350-361）、`__heming_infohub`（362-390）。全部是**固定方法**，没有 `invoke(channel, …)` 这类透传口。
- `secret:bootstrap` 白名单三键：`secret-store.js` 的 `BOOTSTRAP_ALLOWED_KEYS`（白名单外一律拒绝，且不返回明文），
  条目上限 8、总量上限 2MB（同文件 `BOOTSTRAP_MAX_ENTRIES`/`MAX_BOOTSTRAP_CHARS`）；用例 `secret-store.test.js`。
- 主窗口 `webPreferences`：`main.js:412-421`（`contextIsolation:true, nodeIntegration:false, sandbox:true`）。

### C14 参数形状/长度（各模块复检）
- file-fs：`file-fs.js:63-83`（根规整：非盘符根/绝对路径/长度/NUL）、`193-247`（文件数 20、单文件 2MB、单次 4MB、父目录必须存在、保留名、NUL 内容）；
- export-fs：`export-fs.js:62-97`（白名单字符、禁 `..`、只 `.json`、根内双保险）、内容上限 8MB（37/113）；
- chart-fs：`chart-fs.js:39-65`（白名单、`.html`、根内双保险）、内容上限 2MB（72）；
- wiki-fs：`wiki-fs.js:36-68`（夹取 + 相对路径白名单）、本轮新增内容上限 2MB 与 NUL（90-92）、log 字段上限（44-49、147-154）；
- mcp-stdio：`mcp-stdio.js:53-61`（command ≤512 无换行、args ≤64 项且每项 ≤1024，`isValidCommand/isValidArgs` 在 spawn 前后各判一次 250-269）；
- infohub：`infohub-bridge.js:52-54`（行上限 4MB/err 尾 4KB）、`138-140`（方法白名单）；
- notify：`notify-bridge.js:10-27`（title 80 / body 160、控制符清洗、conversationId `^[A-Za-z0-9._:-]{1,128}$`）。

### C15/C16（已修）渲染层越权

**问题**：复审前只有 `file-fs.js:342-371` 有 sender 校验（`isTrustedSender`，fail-closed）；wiki/chart/export/secret/notify/
mcp/update/infohub 的 handler 对**任意渲染进程**开放。桌宠窗口与主窗口同源（`app://heming`）、共用同一份 preload 与 localStorage，
且复审前桌宠窗口**没有导航拦截**（`pet-host.js` 只有窗口/托盘逻辑）——一旦桌宠 frame 被导航到远端页面（或任何页面被注入脚本），
远端脚本即可：`__mcp_stdio` 拉子进程、`__heming_secrets.decryptAsync` 当解密预言机、`__heming_files` 写用户文件。

**修复**：

1. 主进程集中来源守卫（新，`secure-origins.js:41-132`）：
   - `IPC_UNTRUSTED` 统一拒绝值；`makeSenderCheck(getMainWindow)`（60-74）只认「当前主窗口的 webContents」，窗口缺失/已销毁/比较抛错一律 false（fail-closed）；
   - `denyValueFor(channel)`（76-81）：同步桥（secret:*/update:*/runtime:probe）返回 `null`（preload 按不可用处理），其余返回结构化错误；
   - `guardIpc(ipcMain, {isTrusted, channels})`（97-132）：只包装清单内通道，非清单通道原样透传（`app:version` 例外必须放行，见下）。
2. 接线（`main.js:61-95` 的 `TRUSTED_CHANNELS`、`394-397` 的 `secureIpc`）：
   - 能力模块全部改用 `secureIpc` 注册：wiki/chart/export（`main.js:786-790`）、secret（804）、notify（807）、infohub（831）、
     mcp stdio（`secureIpc.handle`，587-599）、runtime:probe（614-618）、update 四通道（679-682）；
   - `app:version` 保持裸 `ipcMain.on`（preload 顶层任何窗口都要能问版本，见 `main.js:606-610`；用例 `main.test.js` 新增断言钉住）。
3. 桌宠窗口导航闸（`pet-host.js:210-232`）：`will-navigate` 只放行 `deps.isAllowedNavigation`（main 注入
   `isAllowedNavigation(url, resolveAppUrl())`，`main.js` createPetHost 参数）；未接入时 **fail-closed 全拦**；
   `setWindowOpenHandler` 一律 deny。用例 `pet-host.test.js` 新增 2 条（远端 URL 被 preventDefault、未注入时全拦）。
4. 防以后再绕过：`main.test.js` 新增「IPC 通道不变量」源码守卫（裸 `ipcMain` 只许白名单、`secureIpc` 注册必须在
   `TRUSTED_CHANNELS`、模块注册必须全在清单、清单不得有死项、preload 每个调用型通道必须受守卫/白名单/自守卫），
   并做过负向验证（注入清单外通道 → 用例按预期变红）。

**真机验证**（`.tmp/ipc-guard-smoke.json`，Electron 45.2.1）：
主窗口 `wiki/exports/charts/update/secrets/version` 全部正常；桌宠窗口同一批桥返回
`{ok:false, code:"untrusted-sender"}`（`update`/`runtime` 为 `null`），且两个窗口都正常渲染、无报错。12/12 检查通过。

### C17 file-fs 越界复检（通过）
- 根内夹取 + 绝对路径：`path-guard.js:69-79` `checkAbsoluteInside`；NUL/超长 `73-74`；盘符根拒绝 `file-fs.js:76`。
- 逐级软链：`path-guard.js:96-123`（从根到目标父目录逐级 `lstat`，目标本身 + 祖先都查）；目标软链/非普通文件 `file-fs.js:137-138/163-176`。
- 硬链：`file-fs.js:174`（`nlink>1` 拒绝——写它等于同时改根外另一份）。
- Windows 保留名：`file-fs.js:208-210`、`path-guard.js:82-84`。
- 写入原子性：`file-fs.js:253-307`（同目录 tmp + fsync → 统一 rename → 删除置后；中途失败清 tmp、原文件不动）。
- 用例：`file-fs.test.js`（越界/软链/硬链/编码/并发等 31 条，含本轮新增网络守卫）。

### C18 export/chart/wiki 越界复检（通过）
- export-fs：目录固定 `exportsRoot()`（`export-fs.js:46-52`，环境变量只给测试）、文件名清洗（62-84）、解析后根内双保险（87-97）。
- chart-fs：目录固定 `chartsRoot()`（25-27）、白名单（39-51）、根内双保险（54-65）；`chart:open` 也先经 `resolveTarget`（101-111）。
- wiki-fs：`resolveInsideRoot`（`path-guard.js:36-49`）+ 相对路径白名单（`wiki-fs.js:52-68`）；不做递归删除（`removeFileSafe` 只删 `.md`）。
- 说明：wiki 桥用相对路径白名单而非软链检查——它不接受渲染层传绝对路径、也不能创建软链；本机其它进程预先埋软链属本地攻击者模型（与 file-fs 的威胁模型不同，记录差异）。

### C19（待修）可写根由渲染层传入
- 事实：`file:read`/`file:write` 的 payload 里带 `roots`（`preload.js:350-361` → `file-fs.js:342-371`），主进程只做「根清单规整」
  （`file-fs.js:63-83`），**不校验根是否由用户设置产生**。因此渲染层（若被 XSS/自我修改注入）可以自带任意非盘符根，
  把 `file_patch` 变成「任意目录写」（软链/硬链/NUL 仍被挡，但目标目录可任选）。
- 为什么本轮不修：正确修法是「主进程持久化可写根 + 渲染层只能引用根 id」，属于新能力/迁移（会把设置区根编辑改成主进程授权），
  不是复审修一行能完成的；且当前 HITL 确认卡 + 路径基线已把「正常产品路径」限制在用户配置的根内。
- 建议下轮：主进程 `settings.json` 持久化根（或启动时从渲染层同步一次并由主进程持有），`file:*` 改为 `rootId + rel`；
  过渡期可在主进程记录「最近一次 pick-root/设置同步」的根集合做白名单。

---

## 4. 主进程网络能力（零网络红线）

### C20 五个保险类模块零网络 + 源码守卫
| 模块 | 用途 | 零网络证据 |
|---|---|---|
| `notify-bridge.js` | 系统通知 | 只 `cleanText` + `Notification`；守卫用例 `notify-bridge.test.js:241` |
| `crash-log.js` | 崩溃日志 | 打桩 http/https/net/tls 断言零调用 `crash-log.test.js:304/332` |
| `secret-store.js` | safeStorage 信封 | 无 require 网络模块；守卫 `secret-store.test.js:316` |
| `export-fs.js` | 记忆导出 | require 白名单 fs/os/path；守卫 `export-fs.test.js:141` |
| `file-fs.js` | 文件编辑 | **本轮补**：剥注释后断言无 fetch/XHR/WebSocket/http/net/dns/tls，require 白名单 fs/fs-promises/path/crypto/path-guard；`file-fs.test.js:490` |

补充复核：`chart-fs.js`/`wiki-fs.js` 同样只 require `fs/os/path`（+ chart 的 `electron.shell`），无网络能力（本轮人工复核，未新增守卫；
如需一并钉死可复用同款断言）。

### C21 边界
- 有网络/子进程能力的桌面模块集中在：`auto-update.js`（electron-updater）、`mcp-stdio.js`（用户配置的 MCP 子进程）、
  `infohub-bridge.js`（本机 Python stdio，不开端口）、`child-kill.js`（进程回收）。它们是产品功能且输入受白名单/上限约束（C14），
  不属于「只该在本机」的保险类模块。

---

## 5. 注入面

### C22 Markdown
- 渲染器：`MarkdownMessage.tsx:185-274`，插件仅 `remarkGfm/remarkMath/rehypeKatex`（266-267），**全仓无 `rehype-raw`**（grep 0 命中）。
  react-markdown 默认丢弃原始 HTML → `<script>`/`<img onerror>` 只按文本显示。
- 唯一 `dangerouslySetInnerHTML`（`MarkdownMessage.tsx:111-116`）注入的是 **shiki 生成的 HTML**（代码内容由 shiki 转义），不是模型原文。
- 回归：本轮新增 4 条（原始 HTML 不产生元素/不执行、`javascript:` 链接被清洗、KaTeX `\href` 不产生危险链接、代码块按文本渲染），
  `MarkdownMessage.test.tsx`（16 tests 全绿）。

### C23 KaTeX
- `rehype-katex` 默认 `trust:false`（不放开 `\href`/`\htmlClass`）；本轮用例断言 `\href{javascript:…}` 不产生 `javascript:` 链接。
- 样式侧只有 `style-src 'unsafe-inline'`（KaTeX 输出带 style 属性，CSP 文档已记录豁免理由），与 XSS 无关。

### C24 图表
- 文本一律 `esc()`（`tokens.ts:117-124`，转义 `& < > " '`）后进入 SVG；`ChatChart.tsx:71-79` 注入 `rendered.svg`；
  注入点为 SVG，`<script>` 由 HTML 解析器插入 innerHTML 时不执行，且所有模型文本已转义（事件属性无法被注入）。
- 既有用例 `charts.test.ts:90-100`（`<script>` 标题被转义为 `&lt;script&gt;`）、`charts.test.ts:314`（esc 全覆盖）。

### C25 文件名 / 通知文案 / 附件名
- 通知：`notify-bridge.js:15-27` 清洗 + 限长；渲染层 `NotificationCenter.tsx` 全部 React 文本节点（无 innerHTML）。
- 文件名：chart/export 白名单（C18）；wiki 相对路径白名单；附件名只作 React 文本 / `download` 属性，不进文件系统；
  服务端文件存内存 Map（`store.ts` `files`），不以文件名拼路径（无路径穿越面）。
- 附件 mime 决定气泡类型，但 `<img>/<audio>` 的 blob URL 不执行脚本；`image/svg+xml` 在 `<img>` 中不执行。

### C26（待修）服务端文件响应头
- `app.ts:359-368`：`res.setHeader("Content-Type", stored.meta.mime)`，mime 来自上传 body（`CreateFileBodySchema.mime` 字符串），
  未固定为 `application/octet-stream`，也没有 `X-Content-Type-Options: nosniff`。
- 可达性：`/api/files/:id/content` 是 `authOnly`（要求 `Authorization: Bearer`），浏览器直接导航不会带 token，故**当前不可被
  受害者浏览器当作同源 HTML 执行**；但若未来客户端把该 URL 放进 `<iframe>`/新窗口、或 token 通过 cookie 化，风险面会扩大。
- 为什么本轮不修：task-13 写域不含 `packages/server`，且改响应头需要在服务端补契约测试；记为待修并给出建议（固定
  `application/octet-stream` + `nosniff` + `Content-Disposition: attachment`）。

### C28 `dangerouslySetInnerHTML` 清单（全仓 3 处）
1. `MarkdownMessage.tsx:111-116`（shiki HTML，内容已转义）——见 C22；
2. `ChatChart.tsx:71-79`（自渲染 SVG，文本 esc）——见 C24；
3. `FilePreviewModal.tsx` 仅在注释里说明「全部 React 元素拼装、禁用 innerHTML」（46），无实际注入点。

---

## 6. 验证记录（定向测试）

### 已修带来的新用例（22 条）
| 文件 | 新增/补充 | 数量 |
|---|---|---|
| `packages/desktop/secure-origins.test.js` | 来源守卫：makeSenderCheck / denyValueFor / guardIpc（含同步 on 通道与未接线 fail-closed） | +5（13） |
| `packages/desktop/pet-host.test.js` | 桌宠导航闸：远端 URL 被拦、未注入白名单时全拦 | +2（33） |
| `packages/desktop/wiki-fs.test.js` | 新文件：夹取/白名单/读写上限/NUL/log 字段规范化/删除约束/list 过滤 | +8（新） |
| `packages/desktop/file-fs.test.js` | 零网络源码守卫（剥注释后） | +1（31） |
| `packages/desktop/main.test.js` | ① 守卫接线断言（TRUSTED_CHANNELS/secureIpc/app:version 例外）；② **IPC 通道不变量**（防新通道绕过门面，见下）；修正 3 条旧字符串断言以匹配新接线 | +2（36） |
| `packages/web/src/components/MarkdownMessage.test.tsx` | 注入面回归 4 条 | +4（16） |

合计新增 **22** 条（另有 `main.test.js` 3 条既有断言随接线更新，非新增结论）。

**IPC 通道不变量（防绕过守卫，Lead 指定）**：`main.test.js` 新增一条源码守卫，断言——
1. `main.js` 里裸 `ipcMain.handle/on` 只允许显式白名单（当前仅 `app:version`）；
2. `secureIpc.handle/on` 注册的每个通道都在 `TRUSTED_CHANNELS` 里（拼错通道名 = 静默放行 → 红）；
3. wiki/chart/export/secret/notify/infohub 模块内注册的通道全部在 `TRUSTED_CHANNELS`（新增通道忘了登记 → 红）；
4. `TRUSTED_CHANNELS` 每条都有真实注册点（改名残留 → 红）；
5. `preload.js` 暴露的每个 invoke/sendSync/send 通道要么受守卫、要么在白名单（`app:version`）/自守卫（`file:*`，并断言 file-fs 的 `isTrustedSender` 仍是 fail-closed）/桌宠前缀（`pet:*`，并断言 pet-host 只注册 `pet:` 通道）。
负向验证：临时给 `main.js` 注入 `secureIpc.handle("debug:bypass", …)`，该用例按预期变红并报
「secureIpc 注册了清单外通道（会静默放行）：debug:bypass」；移除后恢复 36/36。

### 运行结果（全部定向）
- `packages/desktop`：`secure-origins 13/13`、`pet-host 33/33`、`wiki-fs 8/8`、`file-fs 31/31`、`main 36/36`、
  `preload 28/28`、`secret-store 24/24`、`notify-bridge 14/14`、`chart-fs 8/8`、`export-fs 12/12`、`infohub-bridge 20/20`、`path-guard 11/11` —— 全绿；
  `pnpm --filter @heming/desktop test` exit 0。
- `packages/web`：`vitest run src/components/MarkdownMessage.test.tsx` —— 16/16 全绿；
  `e2eSession.crypto + e2eCrypto + secureStorage.d58` —— 48/48 全绿（E2E/存储结论的契约回归）。
- 真机冒烟：`.tmp/ipc-guard-smoke.mjs` → `.tmp/ipc-guard-smoke.json`，12/12 检查通过（主窗口放行、桌宠窗口拒绝）。
  （脚本与 JSON 在 `.tmp/`，按仓库约定不参与入库；复跑：`node .tmp/ipc-guard-smoke.mjs`，需要 `packages/desktop/web-dist` 存在。）

---

## 7. 待修清单（为什么本轮不修）

> 处置已定（见文首「摘要」）：P1 等 task-14 收口后协调；P2 记入 HANDOFF 单独立项；P3 下一波改「主进程持久化根 + rootId」；
> P4 下一波在 server 侧修（固定 mime + nosniff + Content-Disposition）。

| # | 问题 | 风险 | 本轮不修原因 | 建议 |
|---|---|---|---|---|
| C11 | 输入框草稿明文（`heming.draft.*`） | 未发送正文可被本机取证 | 输入热路径，需与 task-14 的异步写优先/写穿缓存同一套设计，避免并发冲突 | task-14 后按 `secureSetItemAsync` 加密；无桥/不可用时按现有三态卡口径点名 |
| C12 | 会话 token 明文（`heming.token`） | 本机会话凭据可见 | 不在 d.36 三键范围；改它牵动登录/401/多标签一致性 | 记入 HANDOFF 已知边界，单独立项 |
| C19 | file-fs 根清单由渲染层传入 | 渲染层被注入后可任意目录写 | 需要主进程持久化根/授权根（新能力 + 设置迁移） | 下一波：主进程持有根，IPC 改 rootId+rel；过渡期做主进程侧根白名单 |
| C26 | 服务端文件响应 mime 用户可控且无 nosniff | 未来若同源导航/iframe 场景扩大则为存储型 XSS 面 | 不在 task-13 写域（server），需服务端契约测试 | 固定 `application/octet-stream` + `nosniff` + `Content-Disposition: attachment` |

**已知边界（非缺陷）**：动态 `baseUrl`/MCP/Registry 使用 `https:` 放通（CSP 文档已记录）；本机其它进程预埋软链属本地攻击者模型；
浏览器端（无桌面桥）按设计明文；用户主动导出为明文文件（C9）。

---

## 8. 一句话结论

E2E 拒绝降级、附件密文、链自校验、密钥不出设备四条红线**实现完整且有测试**；本机存储的明文面只剩草稿与 token 两个
已记录边界（msgCache/chains/备份键/设置卡均一致）；IPC 边界本轮补上了**主窗口来源守卫 + 桌宠窗口导航闸**（真机验证桌宠
越权被拒），file-fs/export/chart/wiki 的越界防线复检通过；五个保险类模块零网络有守卫测试（file-fs 新补）；注入面
（Markdown/KaTeX/图表/文件名/通知）无 XSS 缺陷，仅服务端响应头一条待修。
