# 和鸣 E2E 加密实施计划（前向保密棘轮）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 消息内容端到端加密（P-256 ECDH + HKDF 棘轮 + AES-256-GCM），服务端只见信封；服务端内容逻辑全部客户端化；本地明文缓存；明文存量自迁移；桌面端 HTTP 安全上下文打通。

**Architecture:** 规格见 `docs/superpowers/specs/2026-10-17-e2e-encryption-design.md`（**各任务实现者必读对应章节**，本计划不复述协议细节）。零新依赖，全部 WebCrypto。任务串行。

**Tech Stack:** WebCrypto（P-256 ECDH/ECDSA、HKDF-SHA256、AES-256-GCM）；Zod；Express5 + ws；Vitest（jsdom 注入 node:crypto webcrypto）。

## Global Constraints

- **零新依赖**；只用 `crypto.subtle` 与 `node:crypto` webcrypto（测试注入）。
- 服务端**永不见内容**：密文路径不解析 cipher；`enc:"plain"` 存量仍按旧 schema。
- 密钥只存本机（`heming.e2e.*` localStorage 前缀）；**不写任何恢复/备份/上云私钥代码**。
- 无 subtle 环境：**拒绝发送 + 横幅提示**，绝不降级明文发送。
- messages 新列走 db.ts 幂等 ALTER（PRAGMA table_info 模式，与 recalled_at 同款）；memory/sqlite 双实现同改 + 契约双跑。
- 图标细线 SVG、浅灰分割线、中文文案、无 emoji 图标（emoji 仅消息内容/回应数据）。
- `pnpm -r build && pnpm -r test` 全绿后提交；TDD 先红后绿。

---

### Task 1: 密码核心库（纯函数 + 向量测试）

**Files:**
- Create: `packages/web/src/lib/e2eCrypto.ts` + `e2eCrypto.test.ts`
- Modify: `packages/web/src/test-setup.ts`（注入 node webcrypto）

**Interfaces（Produces）:**
```ts
export interface DeviceIdentity { ikEcdh: CryptoKey; ikSign: CryptoKey; kid: string; }
export async function generateIdentity(): Promise<DeviceIdentity>;           // P-256 ECDH + ECDSA 密钥对，kid=SPKI sha256 base64url
export async function exportPub(k: CryptoKey): Promise<string>;              // SPKI base64
export async function importPub(spki: string, usages: KeyUsage[]): Promise<CryptoKey>;
export async function signPrekeyPayload(signKey: CryptoKey, pub: string): Promise<string>; // ECDSA over SPKI
export async function verifyPrekey(signPub: CryptoKey, pub: string, sig: string): Promise<boolean>;
/** X3DH 简化：dh1..dh4 的 HKDF 拼接 → 根密钥材料（32B）。initiator/ responder 各自参数序。 */
export async function x3dh(params: {
  role: "initiator" | "responder";
  ikEcdh: CryptoKey; ekPub?: CryptoKey; ekPriv?: CryptoKey;
  peerIK: CryptoKey; spkPub: CryptoKey; spkPriv?: CryptoKey; opkPub?: CryptoKey;
}): Promise<ArrayBuffer>;   // 实现：IK/SPK 的 ECDH 组合按规格 §3.1
export function hkdfChain(chainKey: ArrayBuffer, label: string): Promise<{ next: ArrayBuffer; msgKey: ArrayBuffer }>;
export async function encryptMsg(msgKey: ArrayBuffer, nonce12: Uint8Array, plaintext: Uint8Array, aad: Uint8Array): Promise<string>; // base64
export async function decryptMsg(msgKey: ArrayBuffer, nonce12: Uint8Array, cipher: Uint8Array, aad: Uint8Array): Promise<Uint8Array>;
export function toB64(buf: ArrayBuffer | Uint8Array): string;  export function fromB64(s: string): Uint8Array;
export function hasSubtle(): boolean;   // !!globalThis.crypto?.subtle
```

**Steps:**
- [ ] Step 1 失败测试：① `hkdfChain` 确定性（固定 32B 输入→固定输出 hex 断言，跑两次同值）与单向性（next ≠ prev 且无法从 next 推 prev——断言 next!==prev 即可，向量锁定）；② `encryptMsg→decryptMsg` 往返；③ AAD 篡改一位 → decrypt 抛/拒；④ `generateIdentity` 产出 kid 稳定格式 + `signPrekeyPayload/verifyPrekey` 往返 + 篡改 sig 失败；⑤ X3DH：硬编码一对 P-256 测试私钥（JWK 导入），initiator/responder 两路产出同根密钥（断言 hex 相等）；⑥ `hasSubtle()` 在 setup 注入后为 true。
- [ ] Step 2 跑 `pnpm --filter @heming/web test -- e2eCrypto` 确认 FAIL（文件不存在）。
- [ ] Step 3 test-setup.ts 注入：`import { webcrypto } from "node:crypto"; if (!globalThis.crypto?.subtle) Object.defineProperty(globalThis, "crypto", { value: webcrypto });`。实现 e2eCrypto（hkdfChain=label 派生：`crypto.subtle.deriveBits({name:"HKDF", hash:"SHA-256", salt: chainKey, info: label}, 256)` 分别产 msgKey 与 next）。
- [ ] Step 4 跑绿 + typecheck + commit `feat: E2E 密码核心（HKDF 棘轮/X3DH/GCM）与 webcrypto 注入`。

---

### Task 2: 信封契约与服务端

**Files:**
- Modify: `packages/shared/src/schemas.ts`；`packages/server/src/db.ts`、`store.ts`、`sqliteStore.ts`、`ws.ts`、`app.ts`
- Test: shared schemas.test / server storeContract + ws.test + app.test

**Interfaces:**
- shared：`MessageSchema` 加 `enc: z.enum(["plain","e2e"])`（存量构造缺省按 plain 需兼容——新列恒有：`enc: z.string()` 改双态时给**存量 JSON 无 enc → 视为 plain**：实现取 `enc: z.enum(["plain","e2e"]).default("plain")`，测试锁定 default 行为）；可选 `cipher: z.string().max(262144).optional()`、`chainKid: z.string().max(64).optional()`、`n: z.number().int().min(0).optional()`。`WsClientEventSchema.send_message` 加 `enc: z.enum(["plain","e2e"]).default("plain")` 与 `cipher/chainKid/n` 可选字段（enc=e2e 时 cipher 必填——用 `.superRefine` 断言）。
- server 新增：`GET /api/e2e/keys`（登录可读全部设备公钥 `{[userId]: [{ik, spk:{pub,sig,createdAt}, opks:[{id,pub}]}]}`）、`PUT /api/e2e/keys`（仅登记本人，body Zod 校验公钥 base64 长度）；`POST /api/e2e/keys/opk/consume`？——**YAGNI：不做 OPK 消耗管理**，首版 X3DH 免 OPK（可选字段恒缺，DH3/DH4 跳过），计划内明确砍掉 OPK。
- messages 表幂等加列：`enc TEXT NOT NULL DEFAULT 'plain'`、`cipher TEXT`、`chain_kid TEXT`、`n INTEGER`。
- **ws.ts**：`send_message` 明文路径保持现校验；`enc==="e2e"` 跳过空文本/payload 校验、直接入库信封并广播；**删除 react_message 分支**（含测试改写：原 react 用例改为「客户端以 message 事件实现回应」的 server 侧等价——server 只验 kind=reaction 的信封按普通消息入库，无需特判）。
- `PUT /api/messages/:id/reencrypt`（登录 + `sender===本人` + 当前 `enc="plain"` → 原子替换信封字段；403/409 语义测试）。
- Store 双实现：`addMessage` 扩信封参数；`listMessages` 返回新字段。

**Steps:** TDD 顺序——失败测试（信封 schema 边界含 superRefine：e2e 无 cipher 拒、plain 带 cipher 拒；keys PUT/GET 往返与他人不可冒写；reencrypt 三态；ws e2e 消息入库广播 + 空 cipher/plain 拒收；react_message 事件改为 bad_event）→ 实现 → `shared build` 后全绿 → commit `feat: E2E 信封契约、公钥服务与消息重加密接口`。

---

### Task 3: 会话层——链管理与收发（web）

**Files:**
- Create: `packages/web/src/lib/e2eSession.ts` + `e2eSession.test.ts`
- Modify: `packages/web/src/lib/api.ts`（e2eKeysGet/Put、reencryptMessage）

**Interfaces（纯逻辑 + 注入，测试不碰网络）:**
```ts
export interface E2eDeps { fetchPeerKeys(userId: string): Promise<PeerKeys | null>; sendRaw(e: WsClientEvent): void; now(): number; }
export interface ChainState { kid: string; ck: string /*b64*/; n: number; }   // 持久化于 heming.e2e.chains.<convId>
export async function initSession(convId: string, deps: E2eDeps): Promise<void>; // 生成/载入身份+链
export async function sealMessage(conv: {id:string; members:string[]}, plain: PlainEnvelope, deps): Promise<WsClientEvent>; // 无链先 seal chaindist/init
export async function openMessage(conv: {id:string; memberIdOf: (chainKid)=>string|undefined}, env: SealedEnvelope, cache: MsgCache): Promise<PlainEnvelope | "defer">;
export function handleChainDist(convId: string, from: string, dist: ChainDist): void; // 落链、重扫 deferred
export function sweepDeferred(convId: string): Promise<number>;                     // 5s 重扫
export interface MsgCache { append(convId: string, m: CachedMsg): void; list(convId: string): CachedMsg[]; }  // localStorage heming.msgCache.*
```
- `PlainEnvelope` = `{kind:"text"|"file"|"forward"|"reaction"|"chaindist", text?, file?, forward?, reaction?, replyTo?}`（规格 §3.3）。
- 链滚动：`sealMessage` 内 `n>=100` 或 `now()-createdAt>24h` → 轮换（自动生成新链 + 对每个 peer 发 chaindist）。
- 乱序：`openMessage` 缺链/超窗 → 存 `heming.e2e.deferred.<convId>`（上限 50 条）→ `"defer"`。

**Steps:** 失败测试——① 双内存 E2eDeps 收发往返（seal→open 还原且 cache 落盘）；② 超窗 n → open 返回 defer；③ chaindist 到达后 sweepDeferred 全部解开；④ 链轮换后旧 msgKey 解不开旧密文（前向保密断言：轮换前密文用旧链解，轮换后从状态中删除旧 ck，重新 open 同密文应 defer/失败）；⑤ AAD 含 convId，跨会话搬移密文解密失败。实现 → 绿 → commit `feat: E2E 会话层——链管理、封解密与本地明文缓存`。

---

### Task 4: ChatPage 接线（收发/横幅/流式/回应事件化）

**Files:**
- Modify: `packages/web/src/components/ChatPage.tsx`、`packages/web/src/store/chat.ts`、`packages/web/src/lib/agentStream.ts`
- Test: ChatPage.test / chat.test / agentStream.test

**改动点：**
1. **发送**：`send()` 文本/附件/转发/回复路径改为 `sealMessage` → `send_message{enc:"e2e",…}`；发送前 `hasSubtle()` false → `setSendNotice("当前环境不支持端到端加密，请使用桌面端或 HTTPS")` **且不发送**；`!hasSubtle()` 时输入区顶部常驻横幅（红字 border-l 提示）。
2. **接收**：onWsEvent `message_new` 若 `enc==="e2e"` → `openMessage`；`"defer"` 挂起；解密成功 → 写 MsgCache + setMessages 用明文形态渲染（store 内完成：chat store 收信封时先过 e2eSession.openMessage 再进 messages——**store 注入 openMessage 回调**避免循环依赖，签名 `setOpenHandler(fn)`）。plain 存量直通。
3. **表情回应事件化**：客户端点选 → `sealMessage({kind:"reaction", reaction:{target,emoji,op}})` 作为新消息发送；渲染层对 `kind:"reaction"` 消息不画气泡，而是聚合进目标消息的 chips（从 messages 过滤 kind=reaction 计算）；chips 点自己的 → 发 `op:"remove"`。删除 `react_message` 发送调用。
4. **agent 流式**：`agent_chunk/agent_error` 事件内新增可选 `cipher` 字段（shared）——触发端用会话链 seal（kind 视为 chunk，AAD=`convId+streamId+index`），收端 open；**finish/入库存明文？** 否——`agent_finish` 也改信封（text 进 cipher）。chunk 解不开时降级显示占位行（流式容错：解密失败跳过该 chunk 不崩）。
5. **fetchHistory/预览**：已有明文缓存优先；服务端信封拉取后解密合并（解不开的显示「无法解密」占位，不进 LLM 提示词）。
6. **reencrypt 自迁移**：挂载时后台扫本会话 `enc:"plain"` 且 `senderId===me.id` 的消息 → 调 `reencryptMessage`（20/s 节流）→ 成功后本地替换为 e2e 形态。

**Steps:** 每点先写失败测试（发送捕获 enc=e2e+cipher；无 subtle 拦截；reaction 消息不画气泡且 chips 聚合正确、op remove；reencrypt 对 plain 自发消息调用 PUT 且节流；defer 挂起→chaindist 后出现）→ 实现 → 全绿 → commit `feat: E2E 接线——加密收发、回应事件化与存量自迁移`。

---

### Task 5: 附件加密与文件下载解密

**Files:**
- Modify: `packages/web/src/lib/api.ts`（`uploadEncryptedFile(file): Promise<{id,name,mime,size}>`——随机 32B fileKey，AES-GCM 加密 blob 后 POST /api/files（mime 置 `application/octet-stream`，name 前缀 `.enc`），**fileKey 随消息进密文** `file: {id,name,mime,size,key}`）
- Modify: ChatPage 附件渲染（AttachmentPreview/AudioBubble/下载）：`fetchFileBlobUrl` 后若 `payload.file.key` → decrypt 再 blob URL（`downloadEncryptedFile(id, key)` 一个函数包 fetch+decrypt+Blob）
- Test: api.test / ChatPage.test

**边界**：右栏 FileTree 上传与投递**保持明文**（规格 §2.4）；只有 ChatPage 内 sendFile/语音/图片路径走加密。无 subtle 同样拦截。

**Steps:** 失败测试（uploadEncryptedFile 产物 mime 变 octet-stream、内容非明文（断言原文字节不出现）；带 key 的 file 消息渲染出图片/下载且解密回原文；无 key 的 legacy 明文附件照旧显示）→ 实现 → 绿 → commit `feat: E2E 附件加密与解密渲染`。

---

### Task 6: Electron 安全上下文 + 文档回填 + 全量验证

**Files:**
- Modify: `packages/desktop/main.js`（`app.commandLine.appendSwitch("unsafely-treat-insecure-origin-as-secure", …)` 在 `app.whenReady` 前，目标 origin 从 `HEMING_WEB_URL ?? "http://47.92.39.184"` 解析出 origin）
- Modify: `docs/superpowers/specs/2026-10-13-heming-platform-design.md`（§9 增「E2E 加密（已完成）」条目、§4 安全行改写一句）、`docs/superpowers/specs/2026-10-17-e2e-encryption-design.md` 状态行「已实现」、README 能力行
- Test: `packages/desktop` 既有测试 + 新增「main.js 启动注册了 switch」的单测（若 desktop 测试无法加载 main.js 则改为导出常量断言，做不到就记录说明）

**Steps:** 实现 → `pnpm -r build && pnpm -r test` exit 0 → 文档 → commit `feat: Electron 安全上下文白名单与 E2E 文档回填`。

---

## 遗留（非本批）

- OPK 一次性预配对消费管理（首版 X3DH 免 OPK）；Electron safeStorage；多设备密钥同步（明确不做）；元数据隐藏；网页 https；agent chunk 解密失败的用户级提示（首版静默跳过）。
