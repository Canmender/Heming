# d.36 · 密钥改用系统安全存储（P0-5）

- 日期：2026-10-23
- 相关版本：d.35.1.8.0（基线）、本 spec = d.36.1.9.0（实施时按累计位规则取号）
- 实施状态：已实施（d.36.1.9.0；落盘与门禁见 `docs/HANDOFF.md` 里程碑 34）
- 上游依据：`docs/research/2026-10-22-deep-audit-followup-plan.md` §2 P0-5、§7 分轮表
- 涉及包：`packages/desktop`、`packages/web`
- **这是本项目风险最高的一轮改动**：它动的是「用户凭据在磁盘上的形态」，迁移写错就是丢配置。

## 0. 问题

桌面端把三类凭据直接写进 localStorage 明文：

| 键 | 内容 | 写/读点 |
|---|---|---|
| `heming.llmConfigs` | 每个 LLM 连接的 `apiKey`（直连供应商的付费凭据） | `packages/web/src/store/llm.ts` |
| `heming.mcp.servers.v1` | MCP 服务的自定义请求头（含 token） | `packages/web/src/lib/mcp/store.ts` |
| `heming.e2e.identity` | 设备身份：IK/SPK 私钥（JWK） | `packages/web/src/lib/e2eSession.ts` |

`packages/desktop/**` 内 `safeStorage` **0 命中**（本轮核实）。「个人数据不出设备」这条红线仍然成立
（数据没上云），但**设备上的静态保护为零**：同机任意进程、系统备份、误提交的 `.git` 拷走一份
localStorage 就能拿到全部密钥与 E2E 私钥。

## 1. 决策

### 1.1 只加密「三把钥匙」，如实标注未覆盖的部分

本轮加密上表三键。**明确不加密**（并写进 HANDOFF 与设置页说明的后续项）：

- `heming.msgCache.<convId>`：解密后的**消息正文**。它体量最大、更新最频繁（每条消息 O(n) 重写），
  就地逐条加密会让 E2E 热路径变成「每次收发都过一遍 IPC + DPAPI」，且一旦加密中途失败
  会留下半份数据。正确做法是搬去 IndexedDB/文件后再加密（P0-5b）。
- `heming.e2e.chains.<convId>`：棘轮状态。同样在热路径上；**且它是恢复解密能力的唯一来源**，
  迁移逻辑写错等于把历史消息永久锁死。需要单独的原子写与回滚设计（P0-5b）。

**为什么先做三把钥匙**：它们是「静态拷贝即失守」的那一类——apiKey 可直接产生费用，
E2E 私钥可解密此后所有消息；而 msgCache/chains 的暴露前提是攻击者已经能读本机存储，
量级和紧迫性都低一档。**先把最贵的锁上，把剩下的写清楚**，比半吊子全做更安全。

### 1.2 形态：**就地信封**（密文仍放 localStorage）

```json
{ "__hemingEnc": "v1", "data": "<base64(safeStorage.encryptString(plaintext))>" }
```

- 密文仍占原键位 ⇒ 存储水位统计、键位迁移、导出逻辑都不用改；
- 有信封标记 ⇒ 读侧能识别「这是密文」，不会把 base64 当 JSON 解析后静默回退空表；
- 明文永不出本机：加密/解密都在主进程的 `safeStorage` 里完成，渲染层只经 IPC 传字节。

**不用「主进程另存文件」的原因**：那样 web 侧的存储抽象（`StorageLike`）看不到数据，
要新增一整套读写生命周期；而就地信封只需替换三个读写点。

### 1.3 桥：同步 IPC（`sendSync`）

现有三个存储点都是**同步**读（store 在模块初始化时就读 localStorage）。
若桥做成异步，要么把整条初始化链改成 async（牵动面巨大），要么在首次渲染前等待——
都会把一个安全增强变成启动时序风险。

- preload 暴露 `window.__heming_secrets`：
  - `available: boolean`（preload 时经 `sendSync("secret:available")` 取得）
  - `encrypt(plain: string): string | null`（返回 base64 密文；失败 null）
  - `decrypt(cipherB64: string): string | null`
- 主进程 `secret-store.js`：`safeStorage.isEncryptionAvailable()` +
  `encryptString/decryptString`；**无网络能力**（测试钉死）。

`sendSync` 会阻塞渲染进程，但这三个键的读写频率是「启动一次 / 用户改一次配置」，
不在热路径上。**注释里写明这条前提**：谁把桥用到每次消息收发上，谁就得先改成批量/异步。

### 1.4 迁移：**懒迁移 + 幂等**，绝不静默丢

不做「启动时集中迁移」（ES 模块求值顺序会让「迁移先于 store 初始化」变得脆弱）。
改为**读时懒迁移**：

`secureGetItem(key)`：
1. `raw = localStorage.getItem(key)`；
2. `raw` 为空 → null；
3. `raw` 是信封 → 有桥则解密返回明文；无桥（浏览器）→ **返回 null 并标记「无法解密」**
   （浏览器与桌面端是**不同 origin、不同 localStorage**，正常不会看到对方的信封）；
4. `raw` 是明文：
   - 有桥且 `available` → **就地加密**：写回信封，返回明文（本次读到的仍是明文）；
     加密失败 → **保持明文**、记 fallback 标记、返回明文（**宁可明文也不丢配置**）；
   - 无桥 → 原样返回明文（浏览器路径，行为与今天一致）。

`secureSetItem(key, value)`：有桥 → 写信封；无桥或加密失败 → 写明文 + fallback 标记。
`secureRemoveItem` 不变。

**幂等性**：信封不会再被加密（第 3 步直接解密），跑多少次都不会二次加密、不会丢数据。
**迁移失败**：该键保持明文并在设置页提示——降级是**可见**的，不是静默的。

### 1.5 接入点（只改这三处）

1. `store/llm.ts`：`KEY_CONFIGS` 的读写走 `secureGetItem/secureSetItem`
   （`KEY_BINDINGS`/`KEY_PROMPTS` **不是凭据**，保持普通 localStorage——避免无谓的 IPC）。
2. `lib/mcp/store.ts`：构造函数默认 storage 换成
   `secureStorageFor(MCP_SERVERS_KEY)` 适配器——只对 `heming.mcp.servers.v1` 加密，
   其它键（工具清单/启停状态）直通。
3. `lib/e2eSession.ts`：`IDENTITY_KEY` 的三处读写（`readJson` 调用点、`writeJson` 调用点、
   `isForMe` 里的直接 `getItem`）改走 secure 适配器；**chains 不动**。

### 1.6 界面：如实说明

设置区（安全相关卡片附近）加一行状态：

- 桌面 + 可用：`密钥已用系统安全存储加密（Windows DPAPI）`
- 桌面 + 不可用（DPAPI 异常/降级）：`⚠ 本机安全存储不可用，密钥以明文保存`（琥珀色）
- 浏览器：`浏览器端不落安全存储，密钥明文保存在浏览器本地`

文案是**承诺的边界**，不许写成「所有数据都已加密」。

## 2. 风险与回滚

| 风险 | 处置 |
|---|---|
| 旧版客户端读到信封 → 解析失败 → 配置显示为空 | **数据还在**（密文在磁盘）。回滚到旧版会让配置「看起来丢了」，升级回来即恢复。写进发布说明 |
| 浏览器端读到信封（异常场景） | 返回 null 并在设置页提示；浏览器与桌面端 origin 不同，正常不共存 |
| DPAPI 不可用（Linux 无 keyring / 系统策略） | 懒迁移直接跳过，明文 + 可见提示 |
| `sendSync` 阻塞 | 只在三个低频键上用；注释写明前提 |
| 加密后字节数变化 | 信封 base64 比明文大约 1.4 倍；三键都很小，存储水位条会如实反映 |

## 3. 测试计划

| 文件 | 覆盖 |
|---|---|
| `desktop/secret-store.test.js`（新建） | mock `safeStorage` 可用/不可用两态；加密→解密往返；不可用时 `encrypt` 返回 null；**源码不出现网络模块** |
| `web/src/lib/secureStorage.test.ts`（新建） | 无桥 → 明文读写（行为与今天一致）；有桥 → 写入为信封、读出为明文；**懒迁移幂等**（读两次只加密一次、不二次加密）；加密失败 → 保留明文且标记 fallback；损坏信封 → 不抛 |
| `web/src/store/llm.test.ts`（补） | `apiKey` 经 secure 层往返；bindings/prompts 仍走普通 localStorage |
| `web/src/lib/mcp/store.test.ts`（补） | 只加密 servers 键，tools/enabled 不变 |
| `web/src/lib/e2eSession.test.ts` | 现有用例全绿（jsdom 无桥 → 明文路径）；identity 经 secure 层往返 |
| `web/src/components/SettingsPage.test.tsx` | 三种状态文案分别渲染 |

★ 现有测试在 jsdom 里**没有桥**，走的是明文路径——这正是「浏览器端不受影响」的证据。

## 4. 不做 / 后续

- **P0-5b（另立轮次）**：`msgCache` 与 `e2e.chains` 的加密。两者都在热路径上，
  需要「搬出 localStorage / 批量原子写」的设计，不能沿用本轮的懒迁移。
- **不做**云端密钥托管（红线：个人数据不出设备）。
- **不做**密钥导入/导出（会新增一条明文外流路径）。
- **不改**浏览器端的存储形态（没有安全存储可用，明文 + 明示是诚实的选择）。
