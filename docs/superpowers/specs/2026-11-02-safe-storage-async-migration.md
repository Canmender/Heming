# safeStorage 异步迁移与 P0-5b P3 清理（规格 + 实施记录，d.58）

- 日期：2026-11-02（第二波，发布位 `fix`）
- 状态：**已实施**（主进程异步化 + 启动预取缓存 + P3 清理；渲染层启动门禁待 Baseline 接 `main.tsx`/`pet.tsx`）
- 任务：共享任务 `task-8`「安全收口」
- 依赖文档：`docs/superpowers/specs/2026-10-17-e2e-encryption-design.md`（P0-5/P0-5b 原始设计）

---

## 1. 背景与约束

Electron 45 起 `safeStorage` 的三个**同步**方法（`isEncryptionAvailable` / `encryptString` / `decryptString`）
已标记弃用，46 将随 Chromium 删除同步 OSCrypt 后端而移除；替代品是
`isAsyncEncryptionAvailable` / `encryptStringAsync` / `decryptStringAsync`
（异步 decrypt 返回 `{ result, shouldReEncrypt }` **对象**，少解构一层会静默拿到 undefined）。

本仓现状（迁移前）：

| 层 | 现状 |
|---|---|
| 主进程 `secret-store.js` | 同步三件套 + `ipcMain.on` 同步通道 |
| `preload.js` | `sendSync("secret:available/encrypt/decrypt")`，暴露 `available/encrypt/decrypt` 同步 API |
| 渲染层 `secureStorage.ts` | `secureGetItem/secureSetItem` 同步调用桥 |
| 三个低频键消费方 | `store/llm.ts` 的 `loadProfiles()`、`lib/mcp/store.ts` 的 `defaultStorage()`、`e2eSession` 的 identity——**都在模块初始化时同步读** |

约束（本轮不可破）：

1. **语义不变**：加密失败/安全存储不可用 → 保留明文 + 进程内标记 + 设置区点名；绝不因迁移丢配置；
2. `store/llm.ts`、`lib/mcp/store.ts` 与 `main.tsx`/`App.tsx` **不在本轮范围**（分别属第三波/基线）；
3. 不改变用户可见的既有状态卡文案语义。

## 2. 方案：异步优先 + 预取缓存 + 首读同步兜底（b′）

不选「纯异步（b）」的原因：三个键在**模块初始化时同步读**，消费方不在本轮范围，
纯异步会让首屏读到空配置（观感等于配置丢失），违反约束 1。

### 2.1 主进程（`packages/desktop/secret-store.js`）

- 新增 **异步三件套**：`isAvailableAsync` / `encryptAsync` / `decryptAsync`
  （优先异步 API；没有异步 API 的旧版 Electron 自动回退同步实现，调用方永远拿到 Promise）；
- 新增 **异步 IPC**：`secret:availableAsync` / `secret:encryptAsync` / `secret:decryptAsync`（`ipcMain.handle`，带参数形状与长度校验）；
- 新增 **批量通道** `secret:bootstrap`：一次 IPC 解多个键，**键白名单固定为三个低频键**
  （`BOOTSTRAP_ALLOWED_KEYS`）。白名单之外一律丢弃、不返回任何明文/密文——
  批量解密通道的能力边界就是这三个键，不能变成「渲染层可枚举的解密 API」；
- 新增同步能力探测 `secret:capabilities` → `{ mode: "async"|"sync"|null, sync, async }`；
- **旧同步通道保留一个版本**（弃用，兜底）：`secret:available/encrypt/decrypt` 与导出函数
  `isAvailable/encrypt/decrypt` 原样保留，供本轮尚未迁移的渲染层调用。

### 2.2 preload（`packages/desktop/preload.js`）

- 启动时（页面脚本执行前）发起一次**异步预取**：读三个白名单键在 `localStorage` 里的信封 →
  `invoke("secret:bootstrap")` → 明文进 preload 闭包缓存；`ready` Promise 暴露给渲染层（永不 reject）；
- 暴露同步 `cachedRead(key)` / `cacheSet(key, plain)` / `cacheDelete(key)`（缓存读写，只对三个键生效）；
- 暴露 `availableAsync` / `encryptAsync` / `decryptAsync` / `bootstrap`；
- 保留旧同步 `available` / `encrypt` / `decrypt`（兜底）。

### 2.3 渲染层（`packages/web/src/lib/secureStorage.ts`）

- `secureGetItem` 读优先级：**预取缓存** → 旧同步桥（并回填缓存）→ 纯异步环境异步补取（本次返回 null）；
- `secureSetItem`：先更新缓存（保证「写后立即读」一致），再落盘——同步桥可用时照旧同步写，
  否则后台异步加密写（失败退回明文，绝不丢配置）；
- `storage` 事件：别的窗口改了这三个键（或备份键）→ 即时失效本窗口缓存，下一次读回退同步桥拿最新值；
- 新增 `hydrateSecureStorage()`：等 `ready`（超时 3s）→ 装 storage 监听 → 跑一次 P3 清理 → 通知订阅者。
  **单飞、永不 reject**；`onSecureHydrated()` 给 e2eSession 等模块挂「启动后全量迁移」；
- `secureStorageStatus()` 的 `available` 改为「实际能否加解密」（纯异步环境不再误报降级），文案不变。

### 2.4 启动接线（Baseline 负责：`main.tsx` / `pet.tsx` 各一处）

`packages/web/src/main.tsx`（主窗口）与 `packages/web/src/pet.tsx`（桌宠窗口，`usePetChat` 也读模型 Key）
都接一次 hydrate，**用 300ms 短帽后渲染**，不要无限等：

```ts
import { hydrateSecureStorage } from "./lib/secureStorage.js";

// 300ms 短帽：最多等这么久；超时先渲染，晚到的预取结果由 task-10 的 setState 补偿。
void hydrateSecureStorage({ timeoutMs: 300 }).finally(() => {
  createRoot(document.getElementById("root")!).render(/* 原有内容 */);
});
```

★ 定位：hydrate **只保证「缓存尽量先热」**，不承担正确性。晚到（或根本没跑到）时，
首读回退同步桥（Electron 45）/ 由 task-10 的「hydrate 后 setState」补上配置；
不接这一步的话，Electron 46 上三个键的首读会全部落在已失效的同步兜底上，等于没迁。

## 3. 时序风险评估（Lead 要求的三项）

| 风险 | 评估 | 本方案的处置 |
|---|---|---|
| **启动窗口内读到空** | 纯异步方案必然存在（模块初始化同步读早于预取） | 首读走**旧同步桥**（45 可用）并回填缓存；`hydrate` 接上后缓存先热，兜底只处理极端情况。46 上由「渲染前 hydrate」消除窗口 |
| **多窗口竞争** | 主窗口写、桌宠窗口读，缓存可能过期 | 各窗口独立 preload 缓存；`storage` 事件即时失效；写方 `cacheSet` 只影响本窗口。失效后下一次读回退同步桥（45）/异步补取（46） |
| **写后立即读一致性** | 异步加密落盘有延迟 | 写路径**先更新缓存再落盘**；同窗口读永远命中新值。落盘失败退回明文（可见标记） |

## 4. 回退路径

- 数据格式**完全未变**（仍是 `{"__hemingEnc":"v1","data":…}` 就地信封），没有数据迁移，因此**不存在数据回滚**；
- 代码回退：删掉 `main.tsx`/`pet.tsx` 的 hydrate 调用即回到「同步桥」行为（旧通道本轮保留）；
- Electron 45 上即使 hydrate 不跑，行为与迁移前**逐字等价**（同步桥兜底）。

## 5. Electron 46 之前的切换清单（本轮未做完的部分）

1. （Baseline 负责，300ms 短帽）`main.tsx` / `pet.tsx` 渲染前 hydrate；晚到由 task-10 的 setState 补偿；
2. 删除 `secret-store.js` 的同步三件套与同步 IPC 通道、`preload.js` 的同步 `encrypt/decrypt/available`；
3. `store/llm.ts` / `lib/mcp/store.ts` / `e2eSession` 三个消费方在 hydrate 后重新 `setState`/重建实例
   （第三波「启动时序」）；
4. **e2e 热路径仍用同步桥**：`e2eSession` 的 chains/msgCache 逐条加解密走 `secureBridge()` 的同步
   `encrypt/decrypt`（消息收发热路径，异步化要改收发编排），需另开一轮；
5. 主进程 `secret:capabilities` 可简化为恒 `async`。

## 6. P0-5b P3 · 清理口径

### 6.1 明文备份清理（`cleanupPlaintextBackups`）

- 只处理 `<键>.__heming_plaintext_backup`；**`<键>.__heming_undecryptable`（唯一可恢复的旧密文）永不删**；
- 安全序（不可调换）：主键缺失 → 保留（备份是唯一副本）；主键仍是明文 → 保留（迁移未完）；
  主键是信封/容器 → **先自解密校验**（msgCache 容器要求全部条目可解），通过才删备份；
- 幂等：版本标记 `heming.secure.backupCleanup.v1` = `{v: 策略版本, version: 5 段应用版本}`，
  同版本只跑一次；`force` 供测试/手动强跑；标记损坏按「没跑过」处理；
- 无桥 / 安全存储不可用：不跑、不写标记，等可用时再清；
- 触发：`hydrateSecureStorage()` 完成时跑一次。

### 6.2 msgCache 明文全量扫描兜底（`migrateAllMsgCaches`）

- 遍历所有 `heming.msgCache.*`（排除 LRU/备份等辅助键），把**未打开过的会话**里的明文条目
  也迁到 v2 密文容器（每批 ≤50 条，每会话最多 20 批，剩余下次启动继续）；
- 幂等（已是密文的条目原样跳过，绝不二次加密）；加密失败保留明文并标记 `encrypt-failed`；
- 触发：`onSecureHydrated()` 订阅（hydrate 完成后自动跑）。

## 7. 测试

| 侧 | 文件 | 覆盖 |
|---|---|---|
| desktop | `secret-store.test.js` | 同步/异步三件套、`{result}` 解构、旧版回退、批量通道白名单（含「chains/任意键被拒且不返回明文」）、IPC 通道与非法入参 |
| desktop | `preload.test.js` | 异步/缓存接口、启动预取（只送三个白名单键的信封）、预取失败不阻塞、无异步能力跳过、缓存只对白名单生效、`openSettings(page)` 透传 |
| web | `secureStorage.d58.test.ts` | hydrate 状态/单飞/失败兜底、缓存优先读、写后立即读、storage 失效、P3 清理（可解才删、解不开保留、主键缺失保留、仍明文保留、坏信封保留、undecryptable 永不删、无桥不跑、幂等、版本标记损坏） |
| web | `e2eSession.migrateAll.test.ts` | 未打开会话全量迁移、幂等、加密失败 fail-open、无桥不动、辅助键不误当会话、身份键不动 |

定向命令：

```
node --test packages/desktop/secret-store.test.js packages/desktop/preload.test.js
pnpm --filter @heming/web test -- src/lib/secureStorage.d58.test.ts src/lib/e2eSession.migrateAll.test.ts \
  src/lib/secureStorage.test.ts src/lib/e2eSession.test.ts src/lib/e2eSession.crypto.test.ts src/lib/e2e
pnpm --filter @heming/web exec tsc --noEmit
```

## 8. 已知边界

- **e2e 热路径未异步化**（见 §5.4）：Electron 46 前需单独一轮，否则收发消息的链/缓存加解密会失效；
- **未接 setState 时**（task-10 之前）：hydrate 完成后不会主动刷新已渲染的 store——
  300ms 短帽超时先渲染的窗口，首屏可能读到空配置，需等 task-10「hydrate 后 setState」补上；
  跨窗口写后，另一个窗口的已渲染状态也不会自动刷新（沿用旧行为）；
- 预取缓存里是**明文字符串**（与渲染层本来就能拿到的内容等价），只缓存三个白名单键，进程退出即消失；
- 缓存失效粒度是「键」（`storage` 事件），不区分是本窗口自己的写（Electron 下 storage 事件不发给写方窗口，无额外抖动）。
---

## 9. 启动接线状态（baseline 负责）

**启动接线（baseline 负责）**：`main.tsx` / `pet.tsx` 各一处，300ms 短帽后渲染，晚到由 task-10 的 setState 补。
---

## 10. 启动时序契约（d.59.2 收口）

> 本节是第三波「启动时序」的收口结论，**修改 `main.tsx` 的 hydrate 接线、或给
> `secureStorage` 增加启动期消费方之前，先读完这一节**。

### 10.1 时序图

```
main.tsx
 └─ hydrateSecureStorage() 启动（300ms 短帽；不 await 到底，渲染门禁只看这段 race）
      ↓（与渲染并行）
    React 渲染 → App 挂载
      ★ 注意：store 模块在 main.tsx body 之前就求值了（ES import 提升）
        llm/mcp 构造期同步读 secure 键：
          ├─ 缓存命中（Electron 45 同步桥 / 预取已完成）→ 真实值（正常路径）
          └─ 缓存未命中（Electron 46 纯异步）→ 只能读到空 / null（危险窗口）
      ↓
    hydrate 落定 → finish(state) → onSecureHydrated(state) 广播
        ├─ llm：空且用户未改过 → 重读 profiles 并 setState（bindings/prompts 不动）
        ├─ mcp：用户未改过 → 重读 servers/tools/enabled；仍空才补预置
        │       （构造期「有桥且 hydrate 未完成」时推迟预置，绝不写盘）
        └─ e2e：首帧已进 ensureIdentity 且无现存身份 → 先等 hydrate（≤1.5s）再读一次；
                 只有「等完仍没有」才走 d.36 失败口径（备份旧密文后重建）
```

### 10.2 三条合并规则（llm / mcp 同构）

hydrate 完成后的补读**只在一种情况下发生**，其余一律不覆盖内存：

1. **用户已改过**（`profilesMutated` / `serversMutated`）→ 不重读。用户刚才的写路径已经落盘，
   重读只可能把他刚改的冲掉；
2. **内存非空** → 不重读。说明首帧已经读到真实数据（同步兜底 / 缓存命中），重读没有收益；
3. **内存为空且用户未改过** → 重读并 `setState`。这是「首帧读到空配置」的补全路径。

补充口径：
- 「未保存编辑」在组件本地 draft 里，store 重读不写盘；用户之后保存时以组件内容为准，因此不会丢输入；
- `mcp` 还有一条启动期保护：**hydrate 未完成时推迟 `seedDefaults()`**——纯异步环境下
  `readServers()` 的「空」可能只是缓存未命中，此时预置会写盘覆盖磁盘上的密文配置（请求头 token 一起丢）。
  hydrate 后再判断是否真的为空、才补预置。

### 10.3 `secureHydrationInFlight()` / `whenSecureHydrated()` 语义

- `secureHydrationInFlight(): boolean`：hydrate **已启动但未落定**（`hydrationPromise !== null && !done`）。
  给启动期「没有同步兜底时做决定会做错」的调用方用（典型：E2E 身份）。**它不会启动 hydrate**。
- `whenSecureHydrated(timeoutMs = 3000): Promise<SecureHydration>`：等 hydrate 落定，
  **永不 reject**，已完成则立即返回；超时返回当前快照（调用方按「没等到」处理，不能因此挂住启动）。
  只等不启动——谁启动 hydrate 由启动门禁（`main.tsx`）决定。
- `e2eSession.ensureIdentity` 的等待上限是 **1500ms**（`IDENTITY_HYDRATE_WAIT_MS`）：
  等太久会把收发挂住；超时后按「没等到」继续走 d.36 失败口径（覆盖前先备份旧密文）。

### 10.4 维护约束（别改回去）

1. **不要**把入口改成顶层 `await import()` / `await hydrateSecureStorage()`：
   入口一旦变成 async 模块，Rolldown 不再把首屏依赖合并进入口 chunk（实测碎成 20+ 个预载块、gzip 反而更大），
   而且把「安全存储不可用」变成启动阻塞。
2. **不要删 300ms 短帽**（`HYDRATE_CAP_MS`）：hydrate 只保证「缓存尽量先热」，不承担正确性；
   晚到/失败由 §10.2 的 store 补读兜底。
3. **不要**在 `pet.tsx` 之外的桌宠入口加 hydrate 消费者：桌宠窗口不依赖这三个键（`usePetChat` 读模型 Key
   走同一份缓存，由主窗口的 hydrate 与 storage 事件保证，见 §2.3）；
   `pet.tsx` 的短帽接线保持不变。
4. 给 `secureStorage` 增加启动期消费方时：优先订阅 `onSecureHydrated`；
   需要「是否在途」才用 `secureHydrationInFlight()`/`whenSecureHydrated()`，**不要**自己复制单飞状态。
5. 单测里 `resetSecureStorageState()` 会重置 hydrate 状态与单飞 promise，但**保留已注册的订阅**；
   需要重复验证「hydrate 后补读」时按此顺序：reset → 设数据/桩桥 → 再次 `hydrateSecureStorage()`。

### 10.5 对应测试

| 文件 | 覆盖 |
|---|---|
| `store/llm.hydrate.test.ts`（5 例） | 启动读空→补全；hydrate 前保存不被覆盖；删改后不重读；失败不抛不阻塞；无桥不清空 |
| `lib/mcp/store.hydrate.test.ts`（5 例） | 构造期推迟预置不写盘 + hydrate 后补读；用户改动不被覆盖；仍解不开时不动密文；失败不抛且补预置；无桥行为不变 |
| `lib/e2eSession.hydrate.test.ts`（3 例） | hydrate 在途沿用磁盘身份不生成临时身份；失败按 d.36 备份重建；没人调 hydrate 时不等待 |

### 10.6 46 前剩余项（本轮未做）

- **保存早于 hydrate 的明文窗口**：`secureSetItem` 在纯异步且未 hydrate 时仍先落明文（d.36 fail-open，
  状态卡可见），下一次读后台自迁；要彻底消除需放开 async 写的 `effectiveAvailable` 门禁（与 task-8 一起做）；
- **mcp 首帧短暂空表**：hydrate 完成前（≤300ms 帽内）服务列表可能为空，hydrate 后自动补，UI loading 态是 UX 候选；
- **真机验证**：45→46 升级环境上手动验「hydrate 晚到 / 失败 / DPAPI 不可用」三条路径。

## 11. task-14 收尾（d.59.2.20）· 已完成 / 仍剩

### 11.1 E2E 收发热路径的方案选择

对比两条路：

- **(a) 预取 + 内存视图 + 异步落盘**（采用）：进入会话/解信封前 `ensureE2eStorageReady()`
  一次性批量异步解密 chains/msgCache 进内存视图；此后所有同步读（`loadChains` / `msgCache.list/get` /
  `recvChainOwners`）都命中内存，零 IPC；写路径「内存先更新、加密落盘排队」，`seal`/`open`/`chaindist`
  在返回前 `await flush`，保证链状态与缓存都不丢。
- **(b) 把 E2E 加解密搬进主进程**（否决）：链状态机、AAD 绑定、`(chainKid,n)` 去重窗口、暂挂重扫
  都要跨进程重写；`safeStorage` 的同步限制只是「怎么落盘」，不该为它重写协议。风险与工期都高一个数量级。

实现要点（`packages/web/src/lib/e2eSession.ts`）：

- `ensureE2eStorageReady(convId)`：chains 走 `readSecureValueAsync` + 首读明文懒迁移（异步）；
  msgCache 容器走批量 `secureDecryptManyAsync`；整值信封/明文数组按异步迁移处理。
- `saveChains` 默认路径：内存视图先更新（同步读立即见新链状态）→ `enqueueChainsPersist` 同会话串行
  异步落盘；落盘失败 fail-open 写新明文 + 可见标记，**绝不回退旧盘值**（回退会复用 msgKey）。
- `initSession` / `doSealMessage` / `openChainMsg` / `openX3dhDist` 返回前 `await flushChains`；
  `appendCache` 在异步桥下 `await flushMsgCache`（收到即落盘）。
- `ensureIdentity` 用 `writeSecureJsonAsync` 把身份**异步写完再返回**：46 上 `isForMe` 依赖
  「磁盘已有身份 raw」，否则首帧会误丢定向 chaindist。
- `handleChainDist` 在「异步桥 + 未预热」时先后台 `ensure` 再幂等重放，防止空链覆盖磁盘上的其它 recv 链。
- `loadChains` / `readCacheView` 对 `reason:"async-pending"` 与「46 无同步解密能力但值还在」的形态
  **不**标记 `undecryptableKeys`、不备份——那是「还没解」而不是「解不开」。
- `msgCacheEncryptionState().available` 纳入 `asyncAvailable`（46 上 `available` 恒 false）。
- `msgCache.list/get/peek` 遇到「未预热、视图未解码」时后台补一次 `ensureE2eStorageReady` 并返回空
  （下一帧命中内存视图），不阻塞渲染。

### 11.2 已完成（本轮）

| 项 | 状态 | 说明 |
|---|---|---|
| `secureSetItem` 不再先落明文 | ✅ | 默认异步写：加密→自校验→写信封；失败才明文 + `plaintextKeys` 可见。新增 `pendingPlain`（已入队未落盘明文）+ `plainCache`（raw 写穿）保证「写后立即读一致」 |
| 写后立即读一致 | ✅ | `secureGetItem` 读优先级：未落盘明文记录 → 写穿缓存（raw 一致）→ preload 预取缓存 → 异步补取/旧同步桥 |
| 同步桥降级为兜底 | ✅ | `prefersAsync` 只在「有异步 API」时走异步；同步三件套仅在旧版 Electron / 无异步 API 时使用；`secret-store.js`/`preload.js` 注释已改为「已迁移，同步桥仅兜底」，同步桥**保留不删**（45 回退） |
| 批量热路径 IPC | ✅ | `secret:encryptMany` / `secret:decryptMany`（主进程 `BATCH_MAX_ITEMS=256`、`BATCH_MAX_CHARS=2MB` 安全边界；web 侧 128 条/1MB 自动分片，顺序敏感、失败位 null） |
| E2E 热路径异步化 | ✅ | 见 11.1；`chains`/`msgCache` 均在返回前落盘 |
| 46 降级可见 | ✅ | 加密失败/不可用 → fail-open 明文 + `plaintextKeys` / `cacheEncryptionIssues` 标记，绝不静默假装加密 |
| 定向用例 | ✅ | `secret-store.test.js` 批量 6 例；`secureStorage.async.test.ts` 9 例；`e2eSession.async46.test.ts` 4 例；既有 178 例定向回归全绿（见 11.4） |

### 11.3 仍剩（46 升级前明确接受）

1. **`migrateAllMsgCaches()` 在 46 上会跳过**：它依赖同步加密能力（`cacheCrypto()`），46 上返回
   `{conversations:0}`。未打开过的旧明文缓存要等「打开该会话」时经 `ensureE2eStorageReady` 懒迁。
   → **升级前必须在 45 上跑完一次全量迁移**（见 12.1）。
2. **msgCache 首帧可能空一帧**：进会话前未 `ensure` 时 `list/get` 返回空并后台预热；
   `initSession`/`openMessage` 入口已 await，UI 层若在会话打开前先渲染列表，需要自己 await
   `ensureE2eStorageReady(convId)`（接线建议，非本轮范围）。
3. **真机验证**：45→46 升级环境手动验「hydrate 晚到 / 失败 / DPAPI 不可用」三条路径。
4. **agent 流式 chunk**：走 `openMessage(..., {noDefer:true})` 同一入口（已 ensure + flush），无独立风险；
   未额外加「chunk 不落缓存」以外的异步分支。

### 11.4 验证记录（本轮）

```text
node --test packages/desktop/secret-store.test.js packages/desktop/preload.test.js   → 58 passed
pnpm --filter @heming/web exec tsc --noEmit                                          → clean
pnpm --filter @heming/web test -- src/lib/secureStorage*.test.ts \
  src/lib/e2eSession*.test.ts src/store/llm.test.ts src/lib/mcp                      → 16 files / 178 passed
```

新增用例分布：

| 文件 | 例数 | 覆盖 |
|---|---|---|
| `packages/desktop/secret-store.test.js` | +6 | 批量顺序/失败位/256 条上限/2MB 上限/非数组/IPC 往返 |
| `packages/web/src/lib/secureStorage.async.test.ts` | 9 | 明文窗口不存在、写后立即读一致、异步失败 fail-open 可见、46 不可用降级、45 同步桥兜底、批量分片 |
| `packages/web/src/lib/e2eSession.async46.test.ts` | 4 | 冷启动 ensure 后同步读、收发往返（收即可解 + 链/缓存已落盘）、`isForMe` 身份时序、异步桥不可用降级 |

## 12. Electron 46 升级检查清单（最终版）

按顺序做，任何一步失败都先停下、不要升 46。

1. **升级前（仍在 45 上）完成全量迁移**
   - 正常打开应用一次，等启动的 `migrateAllMsgCaches()` 跑完（hydrate 后自动触发）；
   - 「设置 → 存储」水质卡应无 `plaintextKeys` 提示；`msgCacheEncryptionState(convId).form` 全为
     `encrypted`（或 `absent`），不应再有 `plaintext`；
   - 抽查 `localStorage`：`heming.e2e.chains.*` 是 `{"__hemingEnc":"v1",...}` 信封，
     `heming.msgCache.*` 是 `{"__hemingMsgCache":"v2","items":[...]}` 容器。
2. **preload 能力自检**：`window.__heming_secrets.asyncAvailable === true` 且存在
   `encryptAsync` / `decryptAsync` / `encryptManyAsync` / `decryptManyAsync`；
   `secret:capabilities` 报 `{mode:"async", sync:false, async:true}`。
3. **启动门禁**：`main.tsx` 仍 `await hydrateSecureStorage()`（300ms 帽）后再 render；
   三个白名单键（`heming.llmConfigs` / `heming.mcp.servers.v1` / `heming.e2e.identity`）首帧读
   不得落到「异步补取返回 null」。
4. **46 首次启动自检**：设置-存储卡不应出现 `undecryptableKeys`（出现 = 新环境解不开旧密文，
   先回退 45 导出/恢复）；不应出现新增 `plaintextKeys`。
5. **E2E 自检**：双端各发一条消息 + 冷启动后历史消息可见；确认磁盘上 chains/msgCache 仍是密文形态；
   确认收消息后 `msgCache.list()` 立即可见（不需要二次渲染）。
6. **同步桥路径确认**：46 上 `secret:available` 返回 false；渲染层日志/代码不应命中同步
   `encrypt`/`decrypt` 兜底（除旧版 Electron 分支）。同步桥代码保留，用于 45 回退。
7. **回退预案**：若 46 上出现不可挽回的解密问题，回退到 45 构建即可（同步桥未删、数据格式向后兼容）；
   不要手工删 `__heming_undecryptable` 备份键。
8. **门禁**：`pnpm --filter @heming/web exec tsc --noEmit` + 11.4 的两条测试命令全绿后再升 46。

