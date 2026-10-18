# 语音通话功能设计规格

- 日期：2026-10-18
- 状态：已确认，待实施
- 作者：IM 功能分区会话

---

## 1. 概述

为和鸣 IM 系统添加实时语音通话能力，支持 1:1 会话和群聊。媒体流采用 Mesh 点对点架构，通过 WebRTC DTLS-SRTP 实现端到端加密，信令复用现有 WebSocket 通道。

### 1.1 需求确认

| 项 | 决定 |
|---|---|
| 场景 | 1:1 + 群聊通话 |
| 加密 | 必须 E2E（DTLS-SRTP） |
| 媒体路由 | Mesh 点对点（每对参与者直连） |
| 平台 | 仅桌面端（Electron） |
| 入口 | 聊天页头部按钮 |
| 通话范围 | 1:1 会话 + 群聊 |

### 1.2 设计原则

- **E2E 红线**：媒体流 DTLS-SRTP 加密，服务端只见信令（SDP/ICE），不碰媒体
- **零新依赖**：复用现有 WS 通道，不引入 LiveKit/mediasoup 等框架
- **最小服务端改动**：信令路由 + 内存状态跟踪，不持久化通话记录
- **YAGNI**：不做视频、录音、回放、SFU、macOS 适配

---

## 2. 架构

### 2.1 整体数据流

```
发起方                          服务端                        被叫方
  │                              │                              │
  ├─ getUserMedia(audio) ──────┤                              │
  │                              │                              │
  ├─ new RTCPeerConnection ────┤                              │
  │  (addTrack, createOffer)     │                              │
  │                              │                              │
  ├─ voice_call_invite ────────>│── 定向单播 ──────────────────>│
  │  {callId, sdp, kind:1:1}   │                              │
  │                              │                              ├─ getUserMedia
  │                              │                              ├─ new RTCPeerConnection
  │                              │<───── voice_call_accept ─────┤
  │<── 定向单播 ─────────────────┤  {callId, sdp(answer)}       │
  │                              │                              │
  ├─ ICE candidate ──────────>│── 定向单播 ──────────────────>│
  │<── voice_call_ice ──────────┤<───── voice_call_ice ─────────┤
  │                              │                              │
  │◄══════════ DTLS-SRTP 加密媒体流（Mesh 点对点）══════════════►│
```

### 2.2 群聊差异

发起方对群内每个成员各建一条 `RTCPeerConnection`，被叫方同理，形成 Mesh。服务端信令路由按 `peerId` 定向单播，不做全群广播。

### 2.3 通话生命周期

```
idle ──invite──> ringing ──accept──> connected ──hangup──> idle
                    │                    │
                    ├──reject──> idle    ├──断开重连──> reconnecting
                    ├──timeout──> idle   └──超时无 ICE──> idle
```

### 2.4 服务端状态

内存 `Map<callId, {conversationId, initiatorId, peerIds[], state, startedAt}>`，不入库（通话是实时态，不持久化）。

---

## 3. 契约扩展（packages/shared/src/schemas.ts）

### 3.1 新增客户端事件

```typescript
z.object({
  type: z.literal("voice_call_invite"),
  conversationId: z.string().min(1),
  callId: z.string().min(1),
  sdp: z.string().min(1),
}),
z.object({
  type: z.literal("voice_call_accept"),
  conversationId: z.string().min(1),
  callId: z.string().min(1),
  sdp: z.string().min(1),
}),
z.object({
  type: z.literal("voice_call_reject"),
  conversationId: z.string().min(1),
  callId: z.string().min(1),
  reason: z.enum(["busy", "decline", "timeout"]),
}),
z.object({
  type: z.literal("voice_call_hangup"),
  conversationId: z.string().min(1),
  callId: z.string().min(1),
}),
z.object({
  type: z.literal("voice_call_ice"),
  conversationId: z.string().min(1),
  callId: z.string().min(1),
  candidate: z.string().min(1),
}),
```

### 3.2 新增服务端事件

同名镜像：`voice_call_invite/accept/reject/hangup/ice`。

### 3.3 设计决策

- **不走 E2E 信封**：SDP/ICE 是实时帧，套 GCM 加密每帧做 KDF 开销不合理。SDP 不含消息内容，元数据（IP/端口）由 TURN 中继隐藏。
- **定向单播**：服务端新增 `sendToUser(userId, event)` 辅助函数，信令只发给目标用户。
- **幂等**：`callId` 由发起方生成（`crypto.randomUUID()`），接收端按 `callId` 去重。

---

## 4. 服务端信令路由（packages/server/src/ws.ts）

### 4.1 新增辅助函数

```typescript
function sendToUser(userId: string, event: WsServerEvent): void {
  const sockets = socketsByUser.get(userId);
  if (!sockets) return;
  for (const ws of sockets) send(ws, event);
}
```

### 4.2 通话状态跟踪

```typescript
interface CallState {
  conversationId: string;
  initiatorId: string;
  peerIds: string[];
  state: "ringing" | "active";
  startedAt: number;
}
const activeCalls = new Map<string, CallState>();
```

### 4.3 信令路由分支

在 `ws.on("message")` 中，通用 `isMember` 校验之前：

- **invite**：校验 isMember → 写 activeCalls → 对每个 peerId 调 sendToUser
- **accept**：校验 activeCalls 存在且 userId 是 peerIds 之一 → 更新 state → 定向投递给 initiator
- **reject/hangup**：校验存在且参与者 → 删除 activeCalls → 定向投递给其他参与者
- **ice**：校验存在且参与者 → 定向投递给其他参与者

### 4.4 WS 关闭清理

`ws.on("close")` 中遍历 activeCalls，找到该用户参与的通话，向其他参与者广播 `voice_call_hangup`，删除对应条目。

### 4.5 超时兜底

`setInterval` 每 30s 扫描 activeCalls，`ringing` 超 30s 未 accept → 自动 `reject(timeout)`。

---

## 5. 前端通话状态机（packages/web/src/lib/voiceCall.ts）

### 5.1 数据结构

```typescript
interface PeerConnection {
  userId: string;
  pc: RTCPeerConnection;
  stream?: MediaStream;
  state: "connecting" | "connected" | "disconnected";
}

interface VoiceCallState {
  callId: string | null;
  conversationId: string | null;
  role: "caller" | "callee" | null;
  status: "idle" | "ringing" | "active" | "reconnecting";
  peers: Map<string, PeerConnection>;
  startedAt: number | null;
  muted: boolean;
}
```

### 5.2 状态机流程

- **caller**：call() → getUserMedia → new RTCPeerConnection × (N-1) → createOffer → setLocalDescription → send invite → status = "ringing"
- **callee**：invite 收到 → getUserMedia → new RTCPeerConnection × (N-1) → setRemoteDescription(offer) → createAnswer → send accept → status = "active"
- **共同**：onicecandidate → send ice；ice 收到 → addIceCandidate；hangup → 关闭所有 pc + 停止本地流 + send hangup

### 5.3 ICE 配置

```typescript
const ICE_SERVERS = window.__heming_ice_servers ?? [
  { urls: "stun:stun.miwifi.com:3478" },
];
```

### 5.4 错误处理

- getUserMedia 失败 → 提示权限/设备问题，不发起通话
- iceconnectionstatechange === "failed" → 5s 后重连，仍失败则挂断
- iceconnectionstatechange === "disconnected" → 3s 内显示"重连中"
- WS 断开 → 显示"重连中"，恢复后重新协商 SDP

### 5.5 群聊后期加入

新成员收到 `voice_call_invite{state:"ringing"}`，主动 call() 加入，向所有现有成员发 `voice_call_accept`，现有成员收到后与新成员建立新 `RTCPeerConnection`。

---

## 6. UI 呈现（packages/web/src/components/VoiceCallPanel.tsx）

### 6.1 1:1 通话面板

```
┌─────────────────────────────────┐
│         和鸣 · 语音通话          │
├─────────────────────────────────┤
│                                 │
│     ┌───┐                       │
│     │头像│   张三               │
│     └───┘   00:42               │
│                                 │
│  ── ── ── 波形动画 ── ── ──     │
│                                 │
├─────────────────────────────────┤
│  [麦克风静音]  [挂断]  [扬声器]  │
└─────────────────────────────────┘
```

### 6.2 群通话面板

```
┌─────────────────────────────────┐
│  群通话 · 设计讨论组             │
├─────────────────────────────────┤
│  张三    ● 通话中               │
│  李四    ● 通话中               │
│  王五    ○ 已挂断               │
│                                 │
│  通话时长 03:21                 │
├─────────────────────────────────┤
│  [麦克风]  [挂断]  [扬声器]     │
└─────────────────────────────────┘
```

### 6.3 视觉规范

- 深色背景 `#1a1a2e`，头像圆形细线边框 `#e6e6e6`
- 通话中绿色呼吸灯 `#4ade80`（2s 脉冲）
- 按钮圆形 60px：静音/扬声器 `#3b82f6`，挂断 `#ef4444`
- 计时器等宽数字 `tabular-nums`
- 图标：PhoneIcon/PhoneOffIcon/MicIcon/MicOffIcon/VolumeIcon（1.5px 细线 SVG）

### 6.4 ChatPage 集成点

- 头部工具栏右侧新增电话图标按钮
- 1:1 会话：点击直接发起通话
- 群聊：点击弹确认"邀请 N 人加入通话？"
- 通话中：聊天页底部显示通话横幅条（"通话中 · 张三 · 00:42" + 回到通话 + 挂断）
- 来电：聊天页全屏覆盖来电弹窗（接听/拒绝 + 头像）

### 6.5 桌面端适配

- 窗口最小化 → 任务栏闪烁 + 系统通知"通话中"
- 来电时任务栏闪烁 + 系统通知

---

## 7. Electron 桌面端适配

### 7.1 main.js

- ICE 配置从服务端 `GET /api/ice-servers` 动态获取
- 窗口最小化时通知渲染层
- 系统通知（来电/通话中）

### 7.2 preload.js

```javascript
contextBridge.exposeInMainWorld("__heming_ice_servers", []);
contextBridge.exposeInMainWorld("__heming_voice_call", {
  onMinimize: (callback) => ipcRenderer.on("voice-call:minimized", callback),
  notify: (title, body) => ipcRenderer.send("voice-call:notify", title, body),
});
```

### 7.3 服务端 REST 端点

`GET /api/ice-servers` 返回 STUN/TURN 配置（从环境变量读取，不入库）。

---

## 8. 测试策略

### 8.1 shared 契约测试

- voice_call_* 合法帧解析通过
- 缺 callId/sdp/candidate → schema 拒绝
- reject reason 枚举校验

### 8.2 server 信令测试

- invite → 定向投递（非全群广播）
- accept → 定向投递给 initiator
- ice → 定向投递
- hangup → activeCalls 清理
- 非成员 → error(forbidden)
- WS 断开 → activeCalls 自动清理

### 8.3 前端状态机测试

- call() 发起通话 → offer 生成 → invite 发送
- 收到 invite → answer 生成 → accept 发送
- 收到 accept → status = active
- 收到 hangup → pc 关闭
- icecandidate → ice 发送
- ice failed → 自动挂断

### 8.4 前端组件测试

- 渲染通话面板，显示参与者列表
- 静音/挂断按钮
- 计时器更新
- 群通话多参与者

### 8.5 E2E 测试

- 双标签：A 发起 → B 收到来电 → B 接听 → 双方通话中 → B 挂断
- 通话中 WS 断开 → 重连恢复

### 8.6 测试门禁

`pnpm -r build && pnpm -r test` 全绿才提交。

---

## 9. 错误处理

### 9.1 发起方

| 场景 | 处理 |
|---|---|
| getUserMedia 失败（权限） | 提示"麦克风权限被拒绝" |
| getUserMedia 失败（无设备） | 提示"未检测到麦克风设备" |
| createOffer 失败 | 提示"通话初始化失败"，回 idle |
| 超时未接听（30s） | 自动 reject(timeout)，提示"对方未接听" |
| 被叫方拒绝 | 提示"对方已拒绝" |
| 本地流断开 | 重新 getUserMedia，失败则挂断 |

### 9.2 接收方

| 场景 | 处理 |
|---|---|
| 不在聊天页 | 系统通知 + 任务栏闪烁 |
| 麦克风权限未授权 | 弹权限请求，拒绝则 reject(decline) |
| 通话中收到第二个 invite | 提示"正在通话中"，reject(busy) |

### 9.3 双方共同

| 场景 | 处理 |
|---|---|
| ICE failed | 5s 后重连，仍失败则挂断 |
| ICE disconnected | 3s 内显示"重连中" |
| WS 断开 | 显示"信令重连中"，恢复后重新协商 |
| 对端 WS 断开 | 收到 hangup，提示"对方已挂断" |
| 页面刷新 | 通话中断，回 idle |

### 9.4 群聊特有

| 场景 | 处理 |
|---|---|
| 部分成员 ICE 失败 | 不影响其他成员 |
| 新成员加入 | 收到 invite，可直接加入 |
| 有人退出通话 | 对应 pc 关闭，不影响其他人 |
| 超过 6 人 | 提示"建议 6 人以内" |

---

## 10. 实施计划

### 10.1 任务拆分

| 序号 | 任务 | 涉及包 | 依赖 |
|---|---|---|---|
| T1 | shared 契约扩展 + 契约测试 | shared | 无 |
| T2 | 服务端信令路由 + 通话状态跟踪 + 测试 | server | T1 |
| T3 | 前端通话状态机 voiceCall.ts + 测试 | web | T1 |
| T4 | 通话面板 UI + ChatPage 集成 | web | T3 |
| T5 | Electron 桌面端适配 + ICE 配置 | desktop | T3 |

### 10.2 执行方式

- 每任务派一个子代理实现
- 子代理完成后主控评审（规格 + 测试）
- 修复轮不超过 5 轮
- 整分支终审后合并 main

### 10.3 新增文件

- `packages/web/src/lib/voiceCall.ts`
- `packages/web/src/lib/voiceCall.test.ts`
- `packages/web/src/components/VoiceCallPanel.tsx`
- `packages/web/src/components/VoiceCallPanel.test.tsx`
- `packages/web/src/e2e/voiceCall.spec.ts`

### 10.4 修改文件

- `packages/shared/src/schemas.ts`（追加 voice_call_* 事件）
- `packages/shared/src/schemas.test.ts`（追加用例）
- `packages/server/src/ws.ts`（信令路由 + 状态跟踪）
- `packages/server/src/ws.test.ts`（追加用例）
- `packages/server/src/app.ts`（追加 GET /api/ice-servers）
- `packages/web/src/components/ChatPage.tsx`（通话集成点）
- `packages/desktop/main.js`（ICE 配置 + 通知）
- `packages/desktop/preload.js`（暴露桥接）

---

## 11. 不做的事（YAGNI）

- 不做视频通话（仅语音）
- 不做通话录音/回放
- 不做通话记录持久化
- 不做 SFU/混音（Mesh 直连）
- 不做 macOS 适配（仅 Windows）
- 不做 TURN 凭据动态下发（首期用环境变量）

---

## 12. 跨会话边界

- 不改现有 WS 消息契约（仅扩展，不修改现有事件）
- ChatPage.tsx 仅加通话集成点，不改消息收发逻辑
- 与智能体会话边界不变：不动 TriggerDeps/agentStream
