# d.38 对抗性自检（typing + 会话连续性）

- 日期：2026-10-28
- 版本：d.38.1.10.0（d.38.1.9.0 的修订位 +1）
- 范围：d.38「正在输入提示」的协议/服务端/客户端边界，另含 d.37 会话连续性的三条边界（未读分隔线、空未读、最近会话排序）
- 结论：**15 条对抗用例，14 条首跑通过，1 条（C2）按设计暴露真实体验缺口；已修复并转绿。未发现其他缺陷。**

## 1. 用例与结果

新增 15 条用例全部为工作区增量（`git diff` 可见），按文件分组如下。首跑基线：`pnpm --filter @heming/web test` 2022 例中 1 例失败（C2）；服务端与 HomePage 用例通过。

### 1.1 `packages/server/src/ws.test.ts`（5 条，全 PASS）

| 编号 | 用例 | 结果 | 说明 |
|---|---|---|---|
| S1 | 群聊 typing 扇出给所有成员 | PASS | 成员 b、c 都收到 `userId = a`，会话 id 一致 |
| S2 | 伪造字段/冒充 userId 被剥离 | PASS | 夹带 `text`、`userId:"spoofed"` 时，转发事件与 `{type,conversationId,userId}` **精确相等**，无未知字段，userId 由服务端身份决定 |
| S3 | 缺 `conversationId` 回 `bad_event` 且不广播 | PASS | 发送者收 `error/bad_event`；150ms 内对端零事件 |
| S4 | typing 不落库、不误入已读分支 | PASS | `listMessages` 数量不变；投递窗口内对端无 `read_update`/`message_new` |
| S5 | 发送者自己的 socket 也收到广播 | PASS | 广播按会话发全体（含自己多设备），客户端负责过滤自己 |

> 注：既有用例（同一文件）已覆盖「非成员 `forbidden`」「1 秒内第二条静默丢弃」「超过窗口后恢复转发」；本轮 S1–S5 不重复造轮子。

### 1.2 `packages/web/src/components/ChatPage.test.tsx`（9 条）

| 编号 | 用例 | 结果 | 说明 |
|---|---|---|---|
| C1 | 纯空白输入不发 typing | PASS | trim 判空在节流之前，越过 2s 窗口仍不发 |
| **C2** | **同一发送者消息到达后提示立即消失** | **首跑 FAIL → 修复后 PASS** | 见 §2 |
| C2b | 只清该发送者，不清其他输入者 | PASS | 群聊中 carol 在输入，bob 的消息到达后 carol 提示仍在 |
| C3 | 切走再切回，旧提示不跨会话残留 | PASS | 切到 c2 清空，切回 c1 不复活 |
| C4 | 私聊未知用户 typing 不渲染 | PASS | 无提示、无 `role="status"` |
| C5 | 断线期间不排队，重连不补发 | PASS | 断线输入不发；重连不冲刷迟到帧；重连后继续输入恢复发送（反向对照） |
| C6 | 同一用户重复 typing 只出一行 | PASS | `getAllByText` 长度为 1 |
| K1 | 未读边界严格大于（d.37） | PASS | `createdAt == lastReadAt` 算已读：分隔线在 m2 之后、m3 之前 |
| K2 | `unreadCount=0` 时不画分隔线并回底（d.37） | PASS | 无 separator，`scrollIntoView({behavior:"auto"})` 被调用 |

### 1.3 `packages/web/src/components/HomePage.test.tsx`（1 条，PASS）

| 编号 | 用例 | 结果 | 说明 |
|---|---|---|---|
| K3 | `lastMessageAt` 相同保持原序、缺省置后且稳定 | PASS | 三个同时间会话维持数组原序；`undefined` 会话排在最后 |

## 2. C2 缺陷：提示不随消息收口

- **期望**：对方的消息已经到达当前会话，其「正在输入」应立即消失。
- **实际**：提示继续挂最多 **3 秒**，直到 `TYPING_TTL_MS` 定时清理才消失。
- **根因**：`ChatPage` 的 `onEvent` 在当前会话 `message_new` 分支只做 `appendMessage` + `mark_read`；`typingBy` 的删除只发生在 TTL 清理定时器（`TYPING_TTL_MS`），消息到达不会触发清理。发送端又刻意不发「停止」事件（避免多一帧协议），于是 TTL 成了唯一收口路径。
- **修复**（`packages/web/src/components/ChatPage.tsx`，当前会话 `message_new` 分支、`appendMessage` 之后）：

```tsx
const senderId = e.message.senderId;
setTypingBy((prev) => {
  if (!(senderId in prev)) return prev; // 没变不触发重渲染
  const next = { ...prev };
  delete next[senderId];
  return next;
});
```

  只删除 `senderId` 一个键；该分支已有 `e.message.conversationId === convId` 守卫，不会误清其他会话；键不存在时返回原对象，避免无意义重渲染。C2b 钉死「不影响其他输入者」。
- **RED/GREEN 证据**：
  - RED：首跑 `pnpm --filter @heming/web test` → `C2` 失败，断言 `not.toBeInTheDocument()` 仍找到 `<div role="status">鲍勃 正在输入…</div>`；`Test Files 119 passed | 1 failed`、`Tests 2021 passed | 1 failed`，exit 1。
  - GREEN：修复后同一命令 → `Test Files 120 passed`、`Tests 2022 passed`，exit 0（其中一次运行命中已知 Windows `0xC0000409` 原生崩溃，重跑即绿，与本次改动无关）。

## 3. 明确「未发现」的项

以下均按契约工作，本轮**没有**发现缺陷：

- **字段剥离 / 冒充 userId**：schema strip 生效，转发体精确等于三字段（S2）。
- **非成员**：typing 走通用成员校验，非成员收 `forbidden` 且不广播（既有用例）。
- **不落库**：typing 前后消息数不变，也不会掉进 `mark_read` 分支广播 `read_update`（S4）。
- **离线不排队**：断线期间输入不发 typing，重连后不补发（C5）；与 d.30 的离线队列上限语义一致。
- **空白输入**：trim 判空先于节流，空白不产生任何帧（C1）。
- **切会话 / 旧连接晚到**：按 `convIdRef` 守卫，旧 socket 晚到事件不污染新会话；切走即清空（C3）。
- **未读边界**：严格大于（`>`），等于 `lastReadAt` 的消息算已读（K1）。
- **排序稳定性**：同 `lastMessageAt` 保持原数组顺序，缺省（null/undefined）统一置后（K3）。

## 4. 证据（实际运行）

| 命令 | 结果 |
|---|---|
| `pnpm --filter @heming/web test`（修复前） | 2022 例，1 失败（C2），exit 1 |
| `pnpm --filter @heming/web test`（修复后） | 2022 例全过，exit 0（一次 `0xC0000409` 后重跑绿） |
| `pnpm --filter @heming/shared build` | exit 0 |
| `pnpm -r build` | exit 0（shared/server/web 均 Done） |
| `pnpm -r --workspace-concurrency=1 test` | shared 2 文件/79 例；server 9 文件/227 例；web 120 文件/2022 例；desktop 21 个 `node --test` 文件/272 例；全部 exit 0 |

增量：server +5（222 → 227），web +10（2012 → 2022），合计 **+15**。

## 5. 后续项（不在本轮范围）

- **服务端节流按连接（1s）而非按会话**：切会话后首条 typing 可能被同连接上一条吃掉，最多延迟约 2s。属可接受体感，若日后要改，按 `(connection, conversationId)` 记账。
- **typing 更新粒度**：每个 typing 事件都会生成新的 `typingBy` 对象并触发 ChatPage 重渲染；当前频率（≤0.5 次/秒/人）可接受，未做细粒度订阅。
- **真实 presence** 仍未做：需先把 WS 连接上提 App 壳，另立规格（与 d.38 spec §2 一致）。
