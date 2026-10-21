# 语音通话断线重连 · 实施记录

- 日期：2026-10-21（d.25）
- 状态：**逐路 ICE restart，最多 2 次预算；断线期间通话不结束、不重新响铃**
- 关联：`2026-10-18-voice-call-design.md`（通话原始设计）、`2026-10-18-im-skills-memory-ui.md`

---

## 1. 要解决的问题

语音通话建立在 WebRTC 之上，链路是「WSS 信令 + UDP 媒体」。移动网络切基站、Wi-Fi 掉一拍、
NAT 端口老化，都会让某一路 `RTCPeerConnection` 进入 `disconnected` / `failed`。

d.24 之前的行为：这一路直接没了，用户看到的是一句错误、整通电话收线，只能重新呼叫。
重新呼叫等于**把已经建立的会议拆掉重开**——另外几路也要跟着重来一遍。

## 2. 决策

| 决策 | 选择 | 理由 |
| --- | --- | --- |
| 重连的粒度 | **逐路（per-peer）ICE restart**，不是整通重连 | 一路坏了不该惩罚其他路 |
| 触发方式 | `createOffer({ iceRestart: true })` | 复用同一个 `RTCPeerConnection`，只换 ICE 候选，不改编解码、不重新响铃 |
| 信令事件 | 新增 `voice_call_reconnect`（`sdpType ∈ offer\|answer`） | ★ 刻意**不复用** invite/accept：那会让对端再响一次铃 |
| 重试次数 | `RECONNECT_MAX_RESTARTS = 2` | 再多次只是拖时间，且每次 restart 都要对端配合 |
| `disconnected` 处理 | 先观察 `RECONNECT_PROBE_MS = 3000` 再重启 | 大多数抖动几秒内自己爬回来，立刻 restart 是白折腾 |
| `failed` 处理 | 有预算就立即重启；预算用尽给 `ICE_GIVEUP_MS = 5000` 宽限后收线 | failed 是确定坏了，等 3s 没有意义 |
| 计数归零 | `connected` / `completed` 时 `peer.restarts = 0` | 预算是「连续失败次数」，不是整通通话的总额 |
| 群通话策略 | 任一路彻底断开 → 整通结束并给出原因 | 少一人而其余人不知道，比散会更糟 |
| 状态机 | `status` 仍是 `idle\|ringing\|active`，重连期间**一直是 active** | 加一个 `reconnecting` 状态会让所有分支都要判两次；重连是 active 内部的子状态 |

UI 用 `VoiceCallState.reconnecting: number`（**路数，不是布尔**）提示：
- `CallWindow`：`连接中断，正在重连…`
- `VoiceCallPanel`：`连接中断，正在重连…（N 路）`，`role="status"`，不弹错误条

预算用尽才收线，错误文案给得具体：`连接已断开，请重新呼叫`。

## 3. 代码落点

| 位置 | 内容 |
| --- | --- |
| `packages/web/src/lib/voiceCall.ts:99-102` | `RECONNECT_PROBE_MS` / `RECONNECT_MAX_RESTARTS` / `ICE_GIVEUP_MS` |
| `voiceCall.ts:241` | `oniceconnectionstatechange`：四条分支（connected 归零 / disconnected 观察 / failed 重启 / 预算用尽 giveUp） |
| `voiceCall.ts:180` `restartPeer` | `createOffer({iceRestart:true})` → 发 `voice_call_reconnect` |
| `voiceCall.ts:165` `giveUp` | 收线 + 可读原因 |
| `voiceCall.ts:549-583` | 收到对端 reconnect offer：`callId` 不符或本路 `state === "connecting"` 时**忽略**，避免打断在飞的初始协商 |
| `voiceCall.ts:157` `syncReconnecting` | 把路数同步进状态，供界面显示 |
| `packages/server/src/ws.ts:243-263` | 定向转发给同一 `callId` 的其他参与者并补 `fromUserId`；`activeCalls` 不动 |
| `packages/shared/src/schemas.ts:202` / `:422` | 客户端事件与服务端事件分别校验；服务端事件 `fromUserId` 必填、`sdpType` 枚举 |

## 4. 安全边界

- **没有新增明文面**：`voice_call_invite` / `voice_call_accept` 本来就带明文 SDP（`schemas.ts:171-180`），
  `voice_call_reconnect` 与它们同级。SDP 走 WSS，媒体始终由 DTLS-SRTP 保护，
  重连是在**同一个 peer** 上重新协商，不涉及 E2E 会话密钥、也不触发重新握手。
  「消息端到端加密」与「通话媒体加密」是两条独立管线，本改动只碰后者之外的信令。
- **未知 `callId` 的 reconnect 一律 `forbidden`**（非成员同样 `forbidden`）：不给陌生通话搭车。
- 转发只给「同一通话的其他参与者」，不做广播。

## 5. 与聊天重连的区别

聊天走的是另一套早已存在的机制（`lib/ws.ts:57-66`：`delay = min(1000 × 2^attempt, 30000)`，
连上后重置并重发排队帧，`ChatPage.tsx:1696-1705` 在 `onOpen` 时补拉）。
本文件只讲通话，两者不要混为一谈。

## 6. 测试

- `packages/web/src/lib/voiceCall.test.ts`（`d.25 断线重连` 一节，6 例）：
  disconnected 持续 3s 才重启且 offer 带 `iceRestart` / 观察期内自愈就不重启且计数归零 /
  failed 直接重启、两次预算用尽后收线并留下原因 / 收到 reconnect offer 后应用并回 answer /
  初始协商在飞（connecting）时拒绝第二次 offer / 挂断后迟到的 ICE 回调不再触发重连
- `components/VoiceCallPanel.test.tsx:59` 「reconnecting 大于 0 时给出重连提示（不弹错误条）」
- `packages/server/src/ws.test.ts:465`、`:520`：定向转发补 `fromUserId` 且不影响 call 状态；未知 callId → forbidden
- `packages/shared/src/schemas.test.ts:757`、`:786`：`sdpType` 校验；服务端事件必带 `fromUserId`

## 7. 已知边界

- 真机与 TURN 环境仍未验证（审计里就写过这一条）。纯前端与单测能证明状态机正确，
  证明不了「在真实弱网下重启一定成功」；`RECONNECT_MAX_RESTARTS = 2` 是工程判断，不是测量结果。
- 通话状态不入库，所以没有「重连后恢复通话内记录」这件事——本来就没有记录。
