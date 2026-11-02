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
