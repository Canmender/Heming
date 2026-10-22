# d.30 · 红线口子与安全兜底（P0-1..P0-4 + P1-3/P1-4/P1-8）

- 日期：2026-10-22
- 相关版本：d.29.1.8.0（基线）、本 spec = d.30.1.8.0
- 上游依据：`docs/research/2026-10-22-deep-audit-followup-plan.md` §2 P0-1..P0-4、§3 P1-3/P1-4/P1-8、§7 分轮表
- 涉及包：`packages/web`（HITL 策略 / WS 客户端 / 记忆 store）、`packages/server`（REST / WS）、`packages/desktop`（主进程）、`packages/shared`（WS 契约）

## 0. 这一轮要解决什么

上一轮的调研把红线相关的实现完整度摊开在桌面上。四条 P0 都是**已核实**的、且都是「一个下拉框 / 一个 URL / 一个 query 参数」的距离：

1. 设置页可以把 HITL 免问下限选到 `danger` ⇒ **所有档位恒真** ⇒ 等于一个设置页里的「全部放行」；
2. `/api/ice-servers` 无鉴权 ⇒ 一旦配了 TURN，凭据对任何未登录者可读；
3. WS 的 token 走 query string ⇒ 会进 nginx access_log 与任何中间代理日志；
4. 桌面主进程零崩溃兜底 ⇒ 未捕获异常直接静默退出，**没有任何本机日志可查**。

外加三处「静默降级」：记忆编辑无条件刷新 `updatedAt`（人改一个错别字，这条记忆在系统眼里「刚刚更新过」）、沉淀节奏计数只在内存（刷新即归零，长会话永远沉淀不出来）、WS 离线队列无上限且无 token 时不重排（链路进入「只进不出」的死状态）。

本轮把这七处一次做完。**不含新功能**——但按 `docs/VERSION-MANAGEMENT.md` 的口径，WS 首帧鉴权是新协议行为、记忆 `updatedAt` 拆分改变了数据格式语义，因此走 `feature`（特性位 +1）而非修订位。

## 1. 已核实的事实（本轮亲自读过源码）

| 编号 | 事实 | 位置 |
|---|---|---|
| P0-1 | 下拉框第三个选项是 `<option value="danger">危险（全部不问）</option>` | `packages/web/src/components/HitlPolicyCard.tsx:84` |
| P0-1 | 判定式是 `RISK_ORDER[call.risk] <= RISK_ORDER[policy.floor]`，`floor=danger` 时恒真 | `packages/web/src/lib/hitl/policy.ts:201` |
| P0-1 | `FLOORS` 合法值含 `"danger"`，`normalizePolicy` 会把旧 localStorage 里的 `danger` 原样放行 | `packages/web/src/lib/hitl/policy.ts:57,96-98` |
| P0-1 | 现有用例**钉死了** `floor:"danger"` 被接受（`expect(store.get()).toEqual({... floor: "danger" ...})`），改语义要同步改这条用例 | `packages/web/src/lib/hitl/policy.test.ts:58-60` |
| P0-2 | `app.get("/api/ice-servers", (_req, res) => …)` 无 `authOnly` | `packages/server/src/app.ts:455` |
| P0-2 | 现有用例断言「无鉴权即可访问」 | `packages/server/src/app.test.ts:942-946` |
| P0-2 | 桌面主进程**裸 fetch** 该路由（无 Authorization 头）并把结果注入渲染层 | `packages/desktop/main.js:315` |
| P0-3 | 客户端把 token 拼进 query：`${resolveWsUrl()}/api/ws?token=${token}` | `packages/web/src/lib/ws.ts:46` |
| P0-3 | 服务端在 **upgrade 阶段**用 `url.searchParams.get("token")` 鉴权 | `packages/server/src/ws.ts:34` |
| P0-3 | `socketsByUser` 在 connection 回调里就登记 socket，业务事件直接按 userId 广播 | `packages/server/src/ws.ts:120-126` |
| P0-4 | `packages/desktop/**` 内 `uncaughtException` / `unhandledRejection` / `render-process-gone` / `crashReporter` 均 **0 命中** | 全仓 grep |
| P1-3 | `updateSemantic` 无条件写 `updatedAt: new Date(this.now()).toISOString()`，patch 只含 `pinned`/`confidence` 也照刷 | `packages/web/src/lib/memory/store.ts:583` |
| P1-3 | recency 与淘汰打分都读 `updatedAt` | `packages/web/src/lib/memory/store.ts:537,704-705` |
| P1-4 | `private readonly pending = new Map<string, number>()`，注释自陈「仅本实例内存态，不落盘」 | `packages/web/src/lib/memory/store.ts:255` |
| P1-8 | `const queue: string[] = []`，`send` 未就绪就 `queue.push(frame)`，**无任何 cap** | `packages/web/src/lib/ws.ts:40,74` |
| P1-8 | `if (!token) return;` —— 无 token 时既不建连**也不安排重连**（只有 `onclose` 分支会重排） | `packages/web/src/lib/ws.ts:44-46` |
| P1-8 | 离线队列在 `onopen` 里 `queue.splice(0)` 一次性冲刷 | `packages/web/src/lib/ws.ts:50` |

## 2. 决策

### 2.1 P0-1 · 免问下限夹回 `write`（**读侧 + 写侧都改**）

**只删 UI 选项不够**：旧 localStorage 里已经存着 `floor:"danger"` 的用户，改完 UI 那个下拉框仍然会把它原样放行。所以两侧都要夹：

- **读侧**（`policy.ts`）：`normalizePolicy` 的 `FLOORS` 改为 `["read", "write"]`。存着 `danger` 的一律回落 `write`。
  判定式 `underFloor` 保持 `<=` 语义不变——`floor=write` ⇒ 只读与写入免问，**危险操作恒要问**。
  `RISK_ORDER` 里 `danger` 仍是合法 `RiskLevel`（分类、审计、界面文案都要用），只是**不再是合法的 floor 值**。
- **写侧**（`HitlPolicyCard.tsx`）：删掉 `danger` 选项；文案改成「风险不高于 X 的操作不问」，
  两个选项分别是「只读」「写入」，**去掉「全部不问」字样**。

**为什么 floor 最高只能到 `write` 而不是「保留 danger 但危险恒问」**：`floor` 的语义是「风险**不高于**此值的调用一律不问」。
一旦 floor=danger，「不高于 danger」就包含了 danger 本身 ⇒ 全放行。要表达「危险恒问」，
正确的取值是 `write`（danger 严格高于 write，不在免问范围内）。**没有第四个值**，因为那只是
「danger 恒问」的另一种写法，而 `floor=write` 已经精确表达了它。

**为什么读侧回落 `write` 而不是回落默认值 `read`**：回落 `read` 会把用户的既有偏好（他当初选 `danger`
就是想少被打扰）悄悄改严；回落 `write` 是「取该字段可表达的最宽安全值」——
既尊重了用户「别问那么多」的意图，又没打开全放行。界面同步提示一次。

**配套**：`policy.set()` 走同一个 `normalizePolicy`，所以写侧也自动夹（`set({floor:"danger"})` 存下去的是 `write`）。
`policy.test.ts:58-60` 那条钉住 `danger` 的用例要改成钉住「读回是 `write`」。

### 2.2 P0-2 · `/api/ice-servers` 加鉴权，ICE 改由渲染层自取

服务端加 `authOnly`。客户端必须同步改造，否则**配了 TURN 的环境等于没配**
（ICE 拿不到 → PeerConnection 只能用公共 STUN 兜底）。

**决策：ICE 改由渲染层自己拉，主进程那条路删掉。**

理由（这是复核代码后的修正，不是原计划的写法）：

- 主进程现在**裸 fetch** 该路由（`main.js:315`，无 Authorization 头）。加了鉴权后它必然 401。
- 要让它继续工作，就得把 token 从渲染层搬到主进程 → **主进程开始持有用户凭据**，
  这是新增的暴露面（主进程的内存会被 dump、崩溃日志可能带出）。
- 渲染层**本来就持有 token**，且 `api()` 已经带 Bearer 头、跨域也通（桌面页 `app://heming`
  是 secure origin，`Access-Control-Allow-Origin: *` 服务端已有）——现成的通道，不用再造。
- 桌面页现有的 `/api/me`、`/api/files` 等全走渲染层 `api()`，这条路是既成事实，不是新机制。

**具体做法**：

1. **服务端**：`app.get("/api/ice-servers", authOnly, …)`。
2. **web 侧**新增 `packages/web/src/lib/iceServers.ts`：
   ```ts
   export interface IceServerEntry { urls: string; username?: string; credential?: string }
   export const DEFAULT_ICE_SERVERS: RTCIceServer[];
   export function setIceServers(list: IceServerEntry[]): void;
   export function getIceServers(): RTCIceServer[];   // 模块缓存优先，回落公共 STUN
   export async function fetchIceServers(): Promise<void>;  // 走 api()，静默失败
   ```
3. **`voiceCall.ts`**：`getIceServers()` 改为「web 模块缓存 → preload 注入（兼容位）→ 公共 STUN」。
4. **登录成功后拉一次**：`store/auth.ts` 的 `login()` 成功分支调 `fetchIceServers()`（静默、失败不抛）。
   时序天然成立：必须登录才能进会话，而通话发生在进会话之后。
5. **主进程**：`main.js:310-325` 那段 ICE 拉取**整段删掉**（含 `iceBase` 变量与 `.catch`）。
   `preload.js` 的 `__heming_ice_servers_get` / `setIceServers` **保留**（web 侧仍按可选链读它，
   作为兼容位；当前已无注入方，标注清楚即可，不删是为了不牵动 `voiceCall.ts` 的兜底链）。
6. **网页端**：浏览器端也拉（它同样有 token）。通话在网页端本就不支持，拉不到也无害。

**顺带**：`deploy/` 文档里把「配 TURN 前先补鉴权」写成前置条件（这次一并补上，因为已经补了）。

**兼容性**：这是一次**破坏性变更**——未带 token 的调用从 200 变 401。


### 2.3 P0-3 · WS 改首帧鉴权（token 不再进 query）

**协议**（`packages/shared/src/schemas.ts`）：

- `WsClientEvent` 新增一个成员：`{ type: "auth", token: string }`。
  它是**唯一**允许在未鉴权状态下发送的事件。
- `WsServerEvent` 不新增成员：鉴权成功**不通知**（客户端本来就知道自己带对了 token）。
  鉴权失败走既有的 `error` 事件（`code: "unauthorized"`）。

**服务端**（`packages/server/src/ws.ts`）：

- upgrade 阶段**不再**读 query 里的 token，也不再因为 token 无效就 destroy 掉连接——
  连接先建立，等首帧鉴权。
- connection 回调里维护一个 `authed` 标志：
  - 收到 `{type:"auth", token}` → `userIdFromToken(token)`；成功则 `authed = true`，
    把 socket 登记进 `socketsByUser`；失败则回 `error(unauthorized)` 并 `ws.close()`。
  - **未鉴权时收到任何其它事件** → 回 `error(unauthorized)` 并 `ws.close()`。
  - 鉴权超时（比如 10s）没等到 auth 帧 → 服务端主动 close。
- 广播路径（`broadcastToConversation` / `sendToUser`）只看 `socketsByUser`，未鉴权的 socket 从未登记 ⇒
  **收不到任何业务事件**。这条是「未鉴权帧不返回业务事件」的结构性保证，不靠 if 判断。
- **向后兼容**：query 里的 token 仍**接受**（读 query token 也算鉴权通过），
  这样旧客户端（已经发出去的桌面安装包）在服务端升级后仍能连。
  **但新客户端一律走首帧鉴权**。理由：旧包是已发布产物，不能因为服务端升级就断链；
  而 query 这条路要**留到所有在网客户端都升级后**再删（记在 HANDOFF 待办里，不在本轮删）。

**客户端**（`packages/web/src/lib/ws.ts`）：

- URL 不带 query：`${resolveWsUrl()}/api/ws`。
- `onopen` 时**第一帧**发 `{type:"auth", token}`，**然后**才冲刷业务队列。
  顺序很重要：业务帧先到会被服务端当成未鉴权事件拒掉。
- 冲刷队列前要确保 auth 帧已发出（同一 WebSocket 的 send 是有序的，直接先 send auth 再 splice 冲刷即可）。

**nginx 兜底**（`deploy/nginx-heming.conf`）：`location = /api/ws` 关掉 `access_log`
（`access_log off;`），并从 `log_format` 里剔除 `$arg_token`。
云端的 `nginx.conf` 主文件不在本仓（`/etc/nginx/nginx.conf`），
但 `deploy/nginx-heming.conf` 是**站点**配置，`access_log off;` 在 location 块里是合法的、优先级高于 server 块。
**主 nginx.conf 的 `log_format` 不在本仓控制范围内**——这一步只能靠 `access_log off` 达成，
不依赖改 log_format。（`$arg_token` 剔除那半条在本仓改不到，删掉这半条，写进部署文档作为「若将来要改主配置」的可选项。）

**验收**：`grep token= /var/log/nginx/access.log` 命中 0。

### 2.4 P0-4 · 桌面主进程崩溃兜底（只写本机日志，不上报）

**放哪**：主进程 `process.on("uncaughtException")` / `process.on("unhandledRejection")`，
落到 `~/Heming/logs/crash-<ISO时间戳>-<pid>.log`。**只写本地文件，绝不发出网络请求。**

**为什么不上报**：红线的「个人数据不出设备」在这里也要守住——崩溃日志里可能带用户输入片段
（异常 message 里常常混着用户数据）。上报到云端等于把个人数据送出设备。
代价是「厂商拿不到崩溃率」——这个项目是个人工具，不是需要崩溃遥测的商业产品，**可接受**。

**内容**：版本号（`appVersion()`）、UTC 时间、异常类型、message、stack。
**不写**：用户 ID、token、消息正文。

**渲染进程崩溃**（`render-process-gone`）：`webContents.on("render-process-gone", ...)` →
写一条日志 + **一次**自动 reload（只一次，避免崩溃循环把机器刷爆；用一个模块级标志记「已经重载过一次」）。

**注意**：`uncaughtException` 处理器里**不能抛错、不能 await**——处理器本身抛异常会变成死循环。
写文件用 `fs.appendFileSync`（同步、简单、不抛未捕获异常），失败就 `console.error` 吞掉。

**测试**：`packages/desktop/main.test.js` 现在是**源码文本断言**风格（读 main.js 源码 grep）。
崩溃逻辑要可测，就得抽成独立模块 `packages/desktop/crash-log.js`（不依赖 electron，可单测）：

```js
// crash-log.js 导出
module.exports = { crashLogDir, writeCrashLog(kind, error, extra), installCrashHandlers(deps) };
```

`installCrashHandlers` 接受注入的 `process`/`fs`/`appVersion`，测试里用假 process 触发 uncaughtException，
断言**日志文件生成、内容含版本号、且没有任何网络发送**（注入一个假的 `https.request`/`fetch` 并断言未被调用）。

### 2.5 P1-3 · 记忆 `updatedAt` 拆分

**两个字段**：

- `updatedAt`：**内容**变更时间。只在 `value` / `key` 真的变了时刷新。
- `metaUpdatedAt`：**元数据**变更时间（`pinned` / `confidence` / `scope` / `source`）。

**判据**：`updateSemantic` 的 patch 里，若 `value` 或 `key` 变了 → 两个字段都刷新；
只改 `pinned`/`confidence` → **只刷 `metaUpdatedAt`**，`updatedAt` 原样保留。

**读侧**：`recencyScore` 与淘汰打分**只吃 `updatedAt`**（内容时效）。
`metaUpdatedAt` 只用于「这条被人动过」的展示（记忆页可以显示「上次整理：…」，可选）。
**旧数据兜底**：缺 `metaUpdatedAt` 的老条目以 `updatedAt` 顶替（不迁移、不报错）。

**`upsertSemantic` 怎么办**：它总是刷 `value`（本轮入参的 value 覆盖旧 value），
所以 `updatedAt` 照刷是对的；但 `metaUpdatedAt` 也要一起刷（因为 source/confidence 可能变）。

**类型**：`SemanticEntry` 加 `metaUpdatedAt?: string`（可选，兼容旧数据）。
`pickSemantic` 水合时缺字段则用 `updatedAt` 顶替。

**为什么 `metaUpdatedAt` 用可选字段而不是必填**：老 localStorage 里没有这个键，
必填会在水合时被填成"现在"，反而制造一批假的"刚刚整理过"。可选 + 兜底最稳。

### 2.6 P1-4 · 沉淀节奏计数落盘

**新键**：`heming.memory.pending.v1`（几十字节，`{ [会话键]: 计数 }`）。

- 键的形状沿用现有的 `${agentId} ${conversationId}`（内存里就是它）。
- 落盘时机：每次计数变化时写一次（这是低频操作——每轮对话一次）。
- **清空时机**：`clearConversation(conversationId)` 要清掉对应会话的计数（会话删了，计数不该留着）。
  `clearAgent(agentId)` 同样要清该 agent 的计数。
- 读侧容错：坏 JSON → 空表；非对象 → 空表；单条值不是有限非负整数 → 丢弃该条。

**为什么不是把 pending 并进 working 键**：working 键有 1.2MB 上限与淘汰逻辑，
pending 混进去会被 `guardScoredSize` 之类的逻辑误伤；而且 working 是「内容」，pending 是「计数器」，
**混在一起会让导出/导入把计数器当内容搬走**。独立键最干净。

### 2.7 P1-8 · WS 离线队列上限 + 无 token 不挂死

**队列上限**：帧数 100 或字节 4MB，先到者为准。
溢出时**丢弃并显式提示**——通过新增的 `onSendError`（可选回调）告知上层，
**不静默**。上层（ChatPage）收到后弹一条「发送失败：离线队列已满」的提示。

**字节怎么算**：`JSON.stringify` 后的 UTF-8 字节数（用 `utf8Length`，记忆层已有这个工具）。
注意：**帧本身就是 `JSON.stringify` 的结果**（`send` 里 `const frame = JSON.stringify(payload)`），
所以队列里存字符串，字节数就是 `utf8Length(frame)`。

**无 token 时不挂死**：`if (!token) return;` 改成——
**按退避重试**（复用现有的 `attempt` 与 30s 上限退避），而不是直接放弃。
但要避免「token 一直没来 → 无限重试」：`attempt` 已有上限 30s 的退避，
连接**不建立**（因为没 token），所以只会反复跑退避定时器，不会真的连出去。
这与「onclose 分支的重排」是同一条路径，统一处理。

**更重要的一点**：无 token 时 `send` 往队列里塞帧，而这些帧**永远不会发出去**（没有连接）。
用户以为在发、其实永远没发——这才是「死状态」的实质。所以：
**无 token 时的 `send` 直接走 `onSendError` 报错**，不排队。
「没连上但有 token」才排队（有重连会来，排队是对的）。

**队列满了怎么办**：丢最旧还是丢最新？丢最旧的旧帧（消息已经过时了），
但**要报错**——宁可让用户知道「有东西没发出去」，也不要假装都发成功了。
本轮：丢最旧 + `onSendError` 一次（说明丢了多少帧）。

## 3. 兼容与迁移

| 项 | 兼容性 |
|---|---|
| HITL `floor` | 旧 localStorage 的 `danger` → 读回 `write`（静默，用户下次打开设置区会看到「写入」） |
| `/api/ice-servers` | **破坏性**：未带 token 的调用从 200 变 401。ICE 改由渲染层 `api()` 拉（本来就持有 token）；桌面主进程那段裸 fetch 删掉 |
| WS 首帧鉴权 | 服务端**同时**接受 query token（旧包兼容）与首帧 auth（新包）。旧包在服务端升级后仍能连 |
| WS 事件契约 | `WsClientEvent` 新增 `auth` 成员 ⇒ **shared 契约变更** ⇒ 需 `pnpm --filter @heming/shared build` |
| 记忆 `metaUpdatedAt` | 可选字段，老数据不迁不报错，缺则用 `updatedAt` 顶替 |
| 记忆 pending | 独立新键，老用户没有 ⇒ 计数从 0 起（等于「刷新后重新开始攒」，比现状好） |
| 崩溃日志 | 新目录 `~/Heming/logs/`，不影响既有路径 |

## 4. 测试计划

| 文件 | 覆盖 |
|---|---|
| `web/src/lib/hitl/policy.test.ts` | 存 `floor:"danger"` → 读回是 `write`（**改**掉现有钉 `danger` 的用例）；`set({floor:"danger"})` 落盘的是 `write`；`floor=write` 时 danger 级调用恒进确认队列 |
| `web/src/components/HitlPolicyCard.test.tsx` | 下拉**没有** `danger` 选项（option 数量断言）；文案无「全部不问」 |
| `web/src/lib/hitl/gate.test.ts` | 任何策略下 `risk:"danger"` 的调用都进 pending（不被免问） |
| `server/src/app.test.ts` | `/api/ice-servers` 无 token → 401；带 token → 200 且结构不变（**改**掉「无鉴权即可访问」那条） |
| `server/src/ws.test.ts` | 首帧 auth 成功 → 业务事件正常；auth 失败 → 收到 error 且连接关闭；**未鉴权时发业务事件** → 不返回任何业务事件；超时未鉴权 → 服务端断开；query token（旧客户端）仍能连 |
| `web/src/lib/ws.test.ts` | URL **不含** `token=`；`onopen` 后第一帧是 `auth`；业务队列在 auth 之后冲刷；队列超 100 帧 → 报错回调；无 token 时 `send` → 报错回调且不入队；无 token 时安排退避重试 |
| `web/src/lib/iceServers.test.ts` | 拉取成功 → `getIceServers()` 返回服务端列表；拉取失败（401/网络）→ 静默回落公共 STUN，不抛 |

| `web/src/lib/memory/memory.test.ts` | 只改 `pinned` → `updatedAt` 不变、`recencyScore` 不变；改 `value` → 两者都变；缺 `metaUpdatedAt` 的老数据回退路径 |
| `web/src/lib/memory/memory.test.ts` | 新建 `MemoryStore` 实例后 pending 计数仍在、能按阈值触发沉淀；`clearConversation` 清计数 |
| `desktop/crash-log.test.js` | 假 process 触发 uncaughtException → 日志文件生成、内容含版本号、**断言无网络发送**；`render-process-gone` 只 reload 一次 |

## 5. 不做 / 边界

- **不做** P0-5（safeStorage 加密落盘）、P0-6（CSP）——各自需要独立设计规格与迁移方案，另立轮次。
- **不做** P4-6（更新源 HTTPS + 签名）——需要用户拍板运维成本。
- **不改** 云端主 `nginx.conf`（不在本仓）；`access_log off` 落在站点配置里已够。
- **不删** WS 的 query token 兼容路径——要等所有在网客户端都升级后再删。
- **不做** WS 队列的持久化——离线队列本来就是「本次会话内重连期间暂存」，落盘反而会让「发送成功」的语义变模糊。
- **不新造**「发送失败」提示组件——复用既有 `setSendNotice`（ChatPage 已有）。
- 崩溃日志**只写本机、不上报**（见 §2.4 的理由）。
