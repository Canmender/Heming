# 和鸣 E2E 端到端加密设计（前向保密棘轮）

- 日期：2026-10-17
- 状态：用户已确认三项选型（AskUserQuestion）：**①前向保密棘轮 ②服务端逻辑全部客户端化 ③密钥不恢复**
- 关联：`2026-10-13-heming-platform-design.md`（总规格）、`2026-10-16-m3-agents-design.md`（本地驱动红线）

## 1. 红线与目标

- **服务端只见信封**：密文、公开元数据（会话 id、发送者、消息 id、时间戳、棘轮公钥材料）；**永不见内容**（正文、附件、回应、转发来源、回复指向）。
- **前向保密**：每条消息独立消息密钥；密钥链 KDF 单向推进；旧链键与已用消息键滚动删除（保留最近 1000 个乱序窗口键）。泄露当前链键不能回溯历史、不能预测未来（配合定期轮换）。
- **密钥不出设备**：身份键/链键存本机（web `localStorage["heming.e2e.*"]`，Electron 后续 safeStorage）；**无云备份、无恢复**——换设备历史在新设备不可解（本机已有明文缓存随设备走，见 §6）。
- 算法一律 **WebCrypto**（零新依赖）：P-256 ECDH + HKDF-SHA256 + AES-256-GCM。

## 2. 关键约束（实现必须处理）

1. **HTTP 非安全上下文**：生产是 `http://47.92.39.184`，浏览器 `crypto.subtle` 在非安全上下文不可用。
   - 桌面端（主目标）：Electron 主进程 `app.commandLine.appendSwitch("unsafely-treat-insecure-origin-as-secure", "http://47.92.39.184")`（加载前调用），恢复 subtle。
   - 网页端 http：启动检测 `crypto.subtle` 缺失 → 顶部横幅「当前环境不支持端到端加密，请使用桌面端或 HTTPS」，**拒绝发送**（不降级明文）。
   - 测试：vitest `test-setup.ts` 注入 `node:crypto` 的 webcrypto 到 `globalThis.crypto`（jsdom 默认无 subtle）。
2. **服务端读不到内容 ⇒ 原服务端内容逻辑全部迁移**：
   - 空文本拦截 → 客户端发送前校验（server 对 cipher 不再检查）。
   - 表情回应 toggle → 改为**加密事件消息**（§5.2），服务端只存事件，客户端解密聚合。
   - 撤回保持服务端（只依赖公开元数据：senderId/isMember/messageId，不读内容）。
   - agent 空文本拒收、finish 校验 → 触发端客户端完成。
3. **语义变化（接受）**：新成员加入后只能解密**加入之后**的消息（明文时代的存量与他人历史不可解）；明文存量见 §7 迁移。
4. 文件边界：**消息附件加密**（blob 密文上传，密钥在密文消息内）；右栏「云端共享」直传文件保持明文（显式共享=明文是既定产品语义，spec §1.2）。

## 3. 密钥体系

### 3.1 设备身份与预配对
- 每设备生成：身份键对 `IK`（P-256 ECDH，`kid = base64(SPKI thumbprint)`）。
- 上云（仅公钥）：`POST/GET /api/e2e/keys` → `{ ik, signedPrekey: {pub, sig, createdAt}, onetime: [{pub}] }`；签名用 IK 的 ECDSA P-256 签名键（身份键对附带签名用途：生成 ECDH+签名两个算法键或用 SPKI 派生——实现取「IK 为 ECDSA 签名 + EK 为 ECDH」双键，简化签名链）。
- 发起方取对方 IK+SPK+OPK → X3DH 简化版（DH1=EK×IK, DH2=EK×SPK, DH3=SK×IK, DH4=SK×SPK → HKDF 拼接 → 根密钥 RK）。

### 3.2 会话棘轮（统一模型：Sender-Keys，直聊=1 人组）
- 每个「会话内每台设备」有一条**发送链**（sender chain）：链键 `CK_n`、链索引 `n`、当前链公钥（用于轮换）。
- 对方持有你的发送链（经 §3.1 初始化或链分发消息），逐消息 KDF：`msgKey = HKDF(CK_n, "msg")`，`CK_{n+1} = HKDF(CK_n, "chain")`，密文内带 `n`。
- **轮换（DH 棘轮步）**：新设备加入/周期（每 100 条或 24h）→ 生成新链密钥对，向会话内其他设备各发一条**链分发消息**（用对方 §3.1 会话加密），旧链键删除 ⇒ 前向保密。
- **乱序窗口**：收端缓存最近 1000 个 msgKey；超窗丢弃旧键（不可再解，接受）。
- **首次会话**：发起方在首条消息前发 X3DH 初始化包（内含 EK、OPK 引用、初始链）；收端解不开时回 `e2e_need_init`（客户端自动触发初始化重发）。

### 3.3 消息信封（协议）
- `Message` 双形态（`enc` 判别）：
  - 明文存量：`enc: "plain"`（既有形状不变）。
  - 密文：`enc: "e2e"`，`cipher: base64({v:1, n: number, nonce, data})`，公开字段仅 `chainKid`(发送链指纹)、`n`；**payload/replyTo/mentions 全进密文**。
- 服务端 Store 持久化信封；REST/WS 转发信封不解析。
- 新消息体结构（密文内 JSON，AAD 绑定 `conversationId+messageId` 防搬移）：
  `{ v:1, kind:"text"|"file"|"forward"|"reaction"|"chaindist"|"init", text?, file?, forward?, replyTo?, reaction?:{target,emoji,op:"add"|"remove"}, ... }`

## 4. 协议改动清单（服务端）

| 现有 | 改为 |
|---|---|
| `MessagePayloadSchema` 校验 text/mentions/file/forward/reactions | 信封字段校验（cipher 长度上限、chainKid/n 形状）；`enc:"plain"` 存量仍按旧 schema 校验 |
| ws send_message 空文本拒收 | 明文路径保留；密文路径不读内容 |
| react_message 分支 | **删除**；回应随密文消息（kind=reaction 事件）入库广播 |
| recall_message | 保留（公开元数据权限） |
| agent_finish 空文本/超长校验 | 触发端客户端校验；服务端对信封只存 |
| 新增 `POST/GET /api/e2e/keys` | 公钥分发（§3.1），鉴权=登录 |
| messages 表 | 加列 `enc TEXT`、`cipher TEXT`、`chain_kid TEXT`、`n INTEGER`（幂等 ALTER 同 recalled_at 模式） |

## 5. 客户端数据流

1. **发送**：客户端组装明文 JSON → 查会话链（无则先发 init/chaindist）→ 派生 msgKey → AES-GCM(AAD) → `send_message{enc:"e2e", cipher, chainKid, n}`。
2. **接收**：`message_new` 信封 → 找链 → 解密 → **写入本地明文缓存**（§6）→ 渲染；缺链/超窗 → 暂挂待 `chaindist` 到达重试（最多 5s 定时重扫）。
3. **agent 流式**：chunk 用**会话链**同款派生但独立命名空间（`kind:"chunk"`，`n` 递增，允许缺口）；finish 的完整消息走正常信封；触发端负责所有 agent 文本校验。
4. **表情回应**：`kind:"reaction"` 事件；客户端按 `target` 聚合到本地缓存渲染；已撤回目标忽略。
5. **转发**：解密原文 → 重新封装新信封（新链索引），`forward` 来源进密文。

## 6. 本地明文缓存（message_cache 落地）

- `localStorage["heming.msgCache.<convId>"]`：解密后的明文消息（截尾 500 条/会话，容量约 5MB 内裁剪）。
- 读取顺序：缓存优先渲染 → REST 拉信封 → 解密增量合并（缓存无键的信封显示「无法解密」占位）。
- 撤回/表情事件同样落缓存。缓存随设备走 = 「换设备不可恢复」语义的正面（旧设备仍能看自己已解密历史）。

## 7. 明文存量迁移

- 存量消息 `enc:"plain"` 继续可读（渲染不变）。
- **自发历史重加密**：客户端发现「自己发送的 plain 消息」→ 批量重封为 e2e 信封 → `PUT /api/messages/:id/reencrypt`（服务端仅校验 sender=自己且当前为 plain，原子替换）。分批 20 条/秒防风暴。他人明文历史保持明文（服务端不回读内容给客户端重加密——只有发送者能做）。

## 8. 错误与降级

| 场景 | 行为 |
|---|---|
| 无 subtle（http 浏览器） | 横幅 + 拒绝发送，不降级 |
| 解密失败 | 气泡位「无法解密（密钥缺失）」占位，不吞不崩 |
| 缺链/乱序 | 暂挂队列，chaindist 到达或 5s 重扫后解密 |
| e2e_need_init（对端未初始化） | 自动发 init 包一次，失败提示重试 |
| 附件密文加载失败 | 复用既有「音频/图片加载失败」模式 |

## 9. 测试策略（Vitest）

- **crypto 核**：HKDF 链推进确定性、msgKey 派生向量（固定输入→固定输出）、GCM 往返、AAD 篡改拒绝、乱序/超窗行为、链键滚动删除后旧密文不可解（前向保密断言）。
- **X3DH**：固定向量（P-256 测试密钥对硬编码）→ 双端根密钥一致。
- **契约**：信封 schema 边界（cipher 超长、enc 枚举）；server 对 cipher 不做内容校验的负例；reencrypt 权限（非 sender 403）。
- **集成**：双端 store 模拟收发往返（明文缓存落盘）；reaction 事件聚合；plain 存量迁移。
- **UI**：无 subtle 横幅与拒绝发送；无法解密占位；缓存优先渲染。

## 10. 遗留（非本批）

- Electron safeStorage 落盘密钥；多设备同账号密钥同步（明确不做）；元数据隐藏（sealed sender）；群外转发的持续轮换策略调优；网页端 https 化。
