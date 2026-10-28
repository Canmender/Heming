# d.38 对抗性自检（typing + 会话连续性）

- 日期：2026-10-28
- 版本：d.38.1.10.0（d.38.1.9.0 的修订位 +1）
- 范围：d.38「正在输入提示」的协议/服务端/客户端边界，另含 d.37 会话连续性的三条边界（未读分隔线、空未读、最近会话排序）
- 结论：**16 条对抗用例，15 条首跑通过，1 条（C2）按设计暴露真实体验缺口；已修复并转绿；评审后补 C2c 钉死「旧连接晚到不清新会话」。未发现其他缺陷。**

## 1. 用例与结果

新增 16 条用例全部为相对 d.38.1.9.0 的测试增量，按文件分组如下。首跑基线：`pnpm --filter @heming/web test` 2022 例中 1 例失败（C2）；服务端与 HomePage 用例通过。评审后补 C2c（旧会话 handler 晚到不清新会话），web 最终 2023 例。

### 1.1 `packages/server/src/ws.test.ts`（5 条，全 PASS）

| 编号 | 用例 | 结果 | 说明 |
|---|---|---|---|
| S1 | 群聊 typing 扇出给所有成员 | PASS | 成员 b、c 都收到 `userId = a`，会话 id 一致 |
| S2 | 伪造字段/冒充 userId 被剥离 | PASS | 夹带 `text`、`userId:"spoofed"` 时，转发事件与 `{type,conversationId,userId}` **精确相等**，无未知字段，userId 由服务端身份决定 |
| S3 | 缺 `conversationId` 回 `bad_event` 且不广播 | PASS | 发送者收 `error/bad_event`；150ms 内对端零事件 |
| S4 | typing 不落库、不误入已读分支 | PASS | `listMessages` 数量不变；投递窗口内对端无 `read_update`/`message_new` |
| S5 | 发送者自己的 socket 也收到广播 | PASS | 广播按会话发全体（含自己多设备），客户端负责过滤自己 |

> 注：既有用例（同一文件）已覆盖「非成员 `forbidden`」「1 秒内第二条静默丢弃」「超过窗口后恢复转发」；本轮 S1–S5 不重复造轮子。

### 1.2 `packages/web/src/components/ChatPage.test.tsx`（10 条）

| 编号 | 用例 | 结果 | 说明 |
|---|---|---|---|
| C1 | 纯空白输入不发 typing | PASS | trim 判空在节流之前，越过 2s 窗口仍不发 |
| **C2** | **同一发送者消息到达后提示立即消失** | **首跑 FAIL → 修复后 PASS** | 见 §2 |
| C2b | 只清该发送者，不清其他输入者 | PASS | 群聊中 carol 在输入，bob 的消息到达后 carol 提示仍在 |
| C2c | 旧会话 handler 晚到的消息不清新会话输入态 | PASS | c2 群 u2 提示可见；c1 旧 socket 晚到 c1/u2 消息后 c2 提示仍在；临时去掉 `convIdRef` 守卫时该用例必红（已实跑验证） |
| C3 | 切走再切回，旧提示不跨会话残留 | PASS | 切到 c2 清空，切回 c1 不复活 |
| C4 | 私聊未知用户 typing 不渲染 | PASS | 无提示、无 `role="status"` |
| C5 | 断线期间不排队，重连不补发 | PASS | 断线输入不发；重连不冲刷迟到帧；重连后继续输入恢复发送（反向对照） |
| C6 | 同一用户重复 typing 只出一行 | PASS | `getAllByText` 长度为 1 |
| K1 | 未读边界严格大于（d.37） | PASS | `createdAt == lastReadAt` 算已读：分隔线在 m2 之后、m3 之前 |
| K2 | `unreadCount=0` 时不画分隔线并回底（d.37） | PASS | 无 separator，`scrollIntoView({behavior:"auto"})` 被调用 |

### 1.3 `packages/web/src/components/HomePage.test.tsx`（1 条，PASS）

| 编号 | 用例 | 结果 | 说明 |
|---|---|---|---|
| K3 | 最近会话降序、等值稳定、null/缺省置后 | PASS | 输入序 `[missing, null, a(t1), b(t1), c(t2)]`，断言 DOM 为 `c → a → b → missing → null`，且 5 行都在（不被截断）；输入序与期望不同，不排序必红 |

## 2. C2 缺陷：提示不随消息收口

- **期望**：对方的消息已经到达当前会话，其「正在输入」应立即消失。
- **实际**：提示继续挂最多 **3 秒**，直到 `TYPING_TTL_MS` 定时清理才消失。
- **根因**：`ChatPage` 的 `onEvent` 在当前会话 `message_new` 分支只做 `appendMessage` + `mark_read`；`typingBy` 的删除只发生在 TTL 清理定时器（`TYPING_TTL_MS`），消息到达不会触发清理。发送端又刻意不发「停止」事件（避免多一帧协议），于是 TTL 成了唯一收口路径。
- **修复**（`packages/web/src/components/ChatPage.tsx`，当前会话 `message_new` 分支、`appendMessage` 之后）：

```tsx
if (e.message.conversationId === convIdRef.current) {
  const senderId = e.message.senderId;
  setTypingBy((prev) => {
    if (!Object.prototype.hasOwnProperty.call(prev, senderId)) return prev; // 没变不触发重渲染
    const next = { ...prev };
    delete next[senderId];
    return next;
  });
}
```

  只删除 `senderId` 一个键；清理前用 `convIdRef.current` 再判一次当前会话（外层 `convId` 是闭包，切会话后旧 socket 晚到的消息仍匹配旧会话，会误清新会话的输入态），`appendMessage` / `mark_read` 的既有行为不动；键不存在时返回原对象，避免无意义重渲染。C2b 钉死「不影响其他输入者」，C2c 钉死「旧连接晚到不清新会话」。
- **RED/GREEN 证据**：
  - RED：首跑 `pnpm --filter @heming/web test` → `C2` 失败，断言 `not.toBeInTheDocument()` 仍找到 `<div role="status">鲍勃 正在输入…</div>`；`Test Files 119 passed | 1 failed`、`Tests 2021 passed | 1 failed`，exit 1。
  - GREEN：修复后同一命令 → `Test Files 120 passed`、`Tests 2022 passed`，exit 0（其中一次运行命中已知 Windows `0xC0000409` 原生崩溃，重跑即绿，与本次改动无关）。
  - 评审补丁：临时去掉 `convIdRef` 守卫后单跑 `C2c` → 1 failed；恢复守卫后全绿。

## 3. 明确「未发现」的项

以下均按契约工作，本轮**没有**发现缺陷：

- **字段剥离 / 冒充 userId**：schema strip 生效，转发体精确等于三字段（S2）。
- **非成员**：typing 走通用成员校验，非成员收 `forbidden` 且不广播（既有用例）。
- **不落库**：typing 前后消息数不变，也不会掉进 `mark_read` 分支广播 `read_update`（S4）。
- **离线不排队**：断线期间输入不发 typing，重连后不补发（C5）；与 d.30 的离线队列上限语义一致。
- **空白输入**：trim 判空先于节流，空白不产生任何帧（C1）。
- **切会话 / 旧连接晚到**：按 `convIdRef` 守卫，旧 socket 晚到事件不污染新会话；切走即清空（C3）。
- **未读边界**：严格大于（`>`），等于 `lastReadAt` 的消息算已读（K1）。
- **排序稳定性**：同 `lastMessageAt` 保持原数组顺序，缺省（null/undefined）统一置后且两者间保持原序（K3）。

## 4. 证据（实际运行）

| 命令 | 结果 |
|---|---|
| `pnpm --filter @heming/web test`（修复前） | 2022 例，1 失败（C2），exit 1 |
| `pnpm --filter @heming/web test`（修复后） | 2022 例全过，exit 0（一次 `0xC0000409` 后重跑绿） |
| 单跑 `vitest ... -t "C2c"`（临时去掉 `convIdRef` 守卫） | 1 failed（证明用例可判别） |
| `pnpm --filter @heming/shared build` | exit 0 |
| `pnpm -r build` | exit 0（shared/server/web 均 Done） |
| `pnpm -r --workspace-concurrency=1 test` | shared 2 文件/79 例；server 9 文件/227 例；web 120 文件/2023 例；desktop 21 个 `node --test` 文件/272 例；全部 exit 0 |

增量：server +5（222 → 227），web +11（2012 → 2023），合计 **+16**。

## 5. 后续项（不在本轮范围）

- **服务端节流按连接（1s）而非按会话**：切会话后首条 typing 可能被同连接上一条吃掉，最多延迟约 2s。属可接受体感，若日后要改，按 `(connection, conversationId)` 记账。
- **typing 更新粒度**：每个 typing 事件都会生成新的 `typingBy` 对象并触发 ChatPage 重渲染；当前频率（≤0.5 次/秒/人）可接受，未做细粒度订阅。
- **真实 presence** 仍未做：需先把 WS 连接上提 App 壳，另立规格（与 d.38 spec §2 一致）。
