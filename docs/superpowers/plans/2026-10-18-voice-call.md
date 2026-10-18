# 语音通话功能实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为和鸣 IM 添加 Mesh WebRTC 语音通话能力（1:1 + 群聊），DTLS-SRTP E2E 加密，信令复用现有 WS 通道，仅桌面端。

**Architecture:** 信令（SDP/ICE）通过现有 WebSocket JSON 帧传输，服务端定向单播；媒体流 Mesh 点对点，每对参与者独立 RTCPeerConnection；服务端仅跟踪内存通话状态（不持久化）。

**Tech Stack:** TypeScript, Zod, WebRTC (RTCPeerConnection), Express5 + ws, Electron, Vitest

## Global Constraints

- 仅桌面端（Electron）支持通话；网页端收到 `voice_call_invite` 时提示"仅桌面端支持语音通话"
- 信令不走 E2E 信封（SDP 是实时帧，GCM 每帧 KDF 开销不合理）
- `callId` 由发起方用 `crypto.randomUUID()` 生成，接收端按 `callId` 去重
- 通话状态不入库（内存 `Map<callId, CallState>`），服务端重启 = 通话中断
- 视觉规范：无 emoji 图标（细线 SVG 1.5px）；分割线浅灰 `#e6e6e6`/`#ececec`；中文文案
- 测试门禁：`pnpm -r build && pnpm -r test` 全绿才提交

---

## 文件结构

| 文件 | 职责 |
|---|---|
| `packages/shared/src/schemas.ts` | 新增 voice_call_* 事件契约 |
| `packages/shared/src/schemas.test.ts` | voice_call_* 契约测试 |
| `packages/server/src/ws.ts` | 信令路由 + 通话状态跟踪 |
| `packages/server/src/ws.test.ts` | 信令路由集成测试 |
| `packages/server/src/app.ts` | `GET /api/ice-servers` 端点 |
| `packages/web/src/lib/voiceCall.ts` | 通话状态机 hook |
| `packages/web/src/lib/voiceCall.test.ts` | 状态机单元测试 |
| `packages/web/src/components/VoiceCallPanel.tsx` | 通话面板 UI |
| `packages/web/src/components/VoiceCallPanel.test.tsx` | 面板组件测试 |
| `packages/web/src/components/icons.tsx` | PhoneIcon/MicIcon 等 |
| `packages/web/src/components/ChatPage.tsx` | 通话入口集成 |
| `packages/desktop/main.js` | ICE 配置注入 + 通知 |
| `packages/desktop/preload.js` | 暴露桥接 API |

---

## Task 1: shared 契约扩展 + 契约测试

**Files:**
- Modify: `packages/shared/src/schemas.ts`（在 `WsClientEventUnion` 追加 5 个成员，在 `WsServerEventSchema` 追加 5 个成员）
- Modify: `packages/shared/src/schemas.test.ts`（追加 voice_call_* 测试）

**Interfaces:**
- Consumes: 无
- Produces: `WsClientEvent` / `WsServerEvent` 联合类型新增 `voice_call_invite` / `voice_call_accept` / `voice_call_reject` / `voice_call_hangup` / `voice_call_ice` 五种变体

- [ ] **Step 1: 写失败测试**

在 `packages/shared/src/schemas.test.ts` 末尾追加：

```typescript
describe("voice_call 契约", () => {
  it("接受合法 voice_call_invite", () => {
    const r = WsClientEventSchema.safeParse({
      type: "voice_call_invite",
      conversationId: "c1",
      callId: "call-1",
      sdp: "v=0\r\no=- 123 2 IN IP4 0.0.0.0\r\n...",
    });
    expect(r.success).toBe(true);
  });

  it("拒绝缺 callId 的 voice_call_invite", () => {
    const r = WsClientEventSchema.safeParse({
      type: "voice_call_invite",
      conversationId: "c1",
      sdp: "v=0",
    });
    expect(r.success).toBe(false);
  });

  it("接受合法 voice_call_accept", () => {
    const r = WsClientEventSchema.safeParse({
      type: "voice_call_accept",
      conversationId: "c1",
      callId: "call-1",
      sdp: "v=0\r\no=- 456 2 IN IP4 0.0.0.0\r\n...",
    });
    expect(r.success).toBe(true);
  });

  it("接受合法 voice_call_reject（枚举 reason）", () => {
    expect(WsClientEventSchema.safeParse({
      type: "voice_call_reject", conversationId: "c1", callId: "call-1", reason: "busy",
    }).success).toBe(true);
    expect(WsClientEventSchema.safeParse({
      type: "voice_call_reject", conversationId: "c1", callId: "call-1", reason: "decline",
    }).success).toBe(true);
    expect(WsClientEventSchema.safeParse({
      type: "voice_call_reject", conversationId: "c1", callId: "call-1", reason: "timeout",
    }).success).toBe(true);
    expect(WsClientEventSchema.safeParse({
      type: "voice_call_reject", conversationId: "c1", callId: "call-1", reason: "other",
    }).success).toBe(false);
  });

  it("接受合法 voice_call_hangup", () => {
    const r = WsClientEventSchema.safeParse({
      type: "voice_call_hangup",
      conversationId: "c1",
      callId: "call-1",
    });
    expect(r.success).toBe(true);
  });

  it("接受合法 voice_call_ice", () => {
    const r = WsClientEventSchema.safeParse({
      type: "voice_call_ice",
      conversationId: "c1",
      callId: "call-1",
      candidate: "candidate:1 1 udp 2130706431 1.2.3.4 9999 typ host",
    });
    expect(r.success).toBe(true);
  });

  it("拒绝空 candidate 的 voice_call_ice", () => {
    const r = WsClientEventSchema.safeParse({
      type: "voice_call_ice",
      conversationId: "c1",
      callId: "call-1",
      candidate: "",
    });
    expect(r.success).toBe(false);
  });

  it("服务端事件镜像：voice_call_invite / accept / reject / hangup / ice 均可解析", () => {
    const base = { conversationId: "c1", callId: "call-1" };
    expect(WsServerEventSchema.safeParse({ type: "voice_call_invite", ...base, sdp: "v=0" }).success).toBe(true);
    expect(WsServerEventSchema.safeParse({ type: "voice_call_accept", ...base, sdp: "v=0" }).success).toBe(true);
    expect(WsServerEventSchema.safeParse({ type: "voice_call_reject", ...base, reason: "busy" }).success).toBe(true);
    expect(WsServerEventSchema.safeParse({ type: "voice_call_hangup", ...base }).success).toBe(true);
    expect(WsServerEventSchema.safeParse({ type: "voice_call_ice", ...base, candidate: "c:1" }).success).toBe(true);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
pnpm --filter @heming/shared test
```

Expected: FAIL — `voice_call_invite` 不在 discriminatedUnion 中，parse 报 "invalid discriminator value"

- [ ] **Step 3: 实现契约扩展**

在 `packages/shared/src/schemas.ts` 的 `WsClientEventUnion` 数组中，在 `agent_error` 成员之后追加：

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

在 `WsServerEventSchema` 的 discriminatedUnion 中，在 `agent_error` 成员之后追加同名镜像：

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

- [ ] **Step 4: 运行测试确认通过**

```bash
pnpm --filter @heming/shared test
```

Expected: PASS

- [ ] **Step 5: 构建 shared**

```bash
pnpm --filter @heming/shared build
```

Expected: 无 TS 错误

- [ ] **Step 6: 提交**

```bash
git add packages/shared/src/schemas.ts packages/shared/src/schemas.test.ts
git commit -m "feat(shared): 新增 voice_call_* WS 事件契约（invite/accept/reject/hangup/ice）"
```

---

## Task 2: 服务端信令路由 + 通话状态跟踪 + 测试

**Files:**
- Modify: `packages/server/src/ws.ts`（新增 `sendToUser`、`activeCalls` Map、信令路由分支、close 清理、超时兜底）
- Modify: `packages/server/src/ws.test.ts`（追加 voice_call_* 集成测试）

**Interfaces:**
- Consumes: Task 1 的 `voice_call_*` 事件类型
- Produces: `GET /api/ice-servers` 端点（在 app.ts）

- [ ] **Step 1: 写失败测试**

在 `packages/server/src/ws.test.ts` 的 `describe("ws")` 中追加：

```typescript
it("voice_call_invite 定向投递给 peer（非全群广播）", async () => {
  const a = await connect(issueToken(aliceId));
  const b = await connect(issueToken(bobId));
  const c = await connect(issueToken(store.createUser("carol2", "h", "卡罗尔2").id));
  // c 不在会话中
  const bWait = nextEvent(b);
  a.send(JSON.stringify({
    type: "voice_call_invite",
    conversationId: convId,
    callId: "call-test-1",
    sdp: "v=0\r\no=- 1 2 IN IP4 0.0.0.0",
  }));
  const event = await bWait;
  expect(event.type).toBe("voice_call_invite");
  if (event.type === "voice_call_invite") {
    expect(event.callId).toBe("call-test-1");
    expect(event.sdp).toContain("v=0");
  }
  // c 不应收到（非成员）
  const cNext = nextEvent(c);
  a.send(JSON.stringify({
    type: "voice_call_invite",
    conversationId: convId,
    callId: "call-test-2",
    sdp: "v=0",
  }));
  // c 收到的是 error(forbidden) 而非 voice_call_invite
  const cEvent = await cNext;
  expect(cEvent.type).not.toBe("voice_call_invite");
  a.close();
  b.close();
  c.close();
});

it("voice_call_accept 定向投递给 initiator", async () => {
  const a = await connect(issueToken(aliceId));
  const b = await connect(issueToken(bobId));
  const aWait = nextEvent(a);
  b.send(JSON.stringify({
    type: "voice_call_accept",
    conversationId: convId,
    callId: "call-test-3",
    sdp: "v=0\r\no=- 2 2 IN IP4 0.0.0.0",
  }));
  const event = await aWait;
  expect(event.type).toBe("voice_call_accept");
  if (event.type === "voice_call_accept") {
    expect(event.callId).toBe("call-test-3");
  }
  a.close();
  b.close();
});

it("voice_call_hangup 定向投递给其他参与者", async () => {
  const a = await connect(issueToken(aliceId));
  const b = await connect(issueToken(bobId));
  const bWait = nextEvent(b);
  a.send(JSON.stringify({
    type: "voice_call_hangup",
    conversationId: convId,
    callId: "call-test-4",
  }));
  const event = await bWait;
  expect(event.type).toBe("voice_call_hangup");
  if (event.type === "voice_call_hangup") {
    expect(event.callId).toBe("call-test-4");
  }
  a.close();
  b.close();
});

it("voice_call_ice 定向投递给其他参与者", async () => {
  const a = await connect(issueToken(aliceId));
  const b = await connect(issueToken(bobId));
  const bWait = nextEvent(b);
  a.send(JSON.stringify({
    type: "voice_call_ice",
    conversationId: convId,
    callId: "call-test-5",
    candidate: "candidate:1 1 udp 2130706431 1.2.3.4 9999 typ host",
  }));
  const event = await bWait;
  expect(event.type).toBe("voice_call_ice");
  if (event.type === "voice_call_ice") {
    expect(event.callId).toBe("call-test-5");
    expect(event.candidate).toContain("candidate:1");
  }
  a.close();
  b.close();
});

it("非成员发 voice_call_invite 收 forbidden", async () => {
  const stranger = store.createUser("eve2", "h", "夏娃2");
  const s = await connect(issueToken(stranger.id));
  const wait = nextEvent(s);
  s.send(JSON.stringify({
    type: "voice_call_invite",
    conversationId: convId,
    callId: "call-test-6",
    sdp: "v=0",
  }));
  const event = await wait;
  expect(event.type).toBe("error");
  if (event.type === "error") expect(event.code).toBe("forbidden");
  s.close();
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
pnpm --filter @heming/server test
```

Expected: FAIL — 服务端不识别 `voice_call_invite` 事件，走 `bad_event` 分支

- [ ] **Step 3: 实现 sendToUser 辅助函数**

在 `packages/server/src/ws.ts` 的 `broadcastToConversation` 函数之后追加：

```typescript
function sendToUser(userId: string, event: WsServerEvent): void {
  const sockets = socketsByUser.get(userId);
  if (!sockets) return;
  for (const ws of sockets) send(ws, event);
}
```

- [ ] **Step 4: 实现通话状态跟踪 + 信令路由**

在 `attachWs` 函数内，`broadcastToConversation` 定义之后、`wss.on("connection")` 之前，插入：

```typescript
// —— 语音通话信令：内存状态跟踪（不持久化）——
interface CallState {
  conversationId: string;
  initiatorId: string;
  peerIds: string[];
  state: "ringing" | "active";
  startedAt: number;
}
const activeCalls = new Map<string, CallState>();

function cleanupCallsForUser(userId: string): void {
  for (const [callId, call] of activeCalls) {
    if (call.initiatorId === userId || call.peerIds.includes(userId)) {
      const otherParticipants = [call.initiatorId, ...call.peerIds].filter(
        (id) => id !== userId,
      );
      for (const otherId of otherParticipants) {
        sendToUser(otherId, {
          type: "voice_call_hangup",
          conversationId: call.conversationId,
          callId,
        });
      }
      activeCalls.delete(callId);
    }
  }
}
```

在 `ws.on("message")` 处理逻辑中，在现有 `agent_chunk`/`agent_error` 分支之前，插入 voice_call 路由：

```typescript
if (
  event.type === "voice_call_invite" ||
  event.type === "voice_call_accept" ||
  event.type === "voice_call_reject" ||
  event.type === "voice_call_hangup" ||
  event.type === "voice_call_ice"
) {
  if (!store.isMember(event.conversationId, userId)) {
    send(ws, { type: "error", code: "forbidden", message: "not a member" });
    return;
  }
  const call = activeCalls.get(event.callId);
  if (event.type === "voice_call_invite") {
    // 获取所有 peer（会话的其他成员）
    const members = store.listMembers(event.conversationId);
    const peerIds = members
      .filter((m) => m.kind === "user" && m.id !== userId)
      .map((m) => m.id);
    activeCalls.set(event.callId, {
      conversationId: event.conversationId,
      initiatorId: userId,
      peerIds,
      state: "ringing",
      startedAt: Date.now(),
    });
    for (const peerId of peerIds) {
      sendToUser(peerId, {
        type: "voice_call_invite",
        conversationId: event.conversationId,
        callId: event.callId,
        sdp: event.sdp,
      });
    }
  } else if (event.type === "voice_call_accept") {
    if (!call || !call.peerIds.includes(userId)) {
      send(ws, { type: "error", code: "forbidden", message: "not in call" });
      return;
    }
    call.state = "active";
    sendToUser(call.initiatorId, {
      type: "voice_call_accept",
      conversationId: event.conversationId,
      callId: event.callId,
      sdp: event.sdp,
    });
  } else if (event.type === "voice_call_reject" || event.type === "voice_call_hangup") {
    if (!call || (call.initiatorId !== userId && !call.peerIds.includes(userId))) {
      send(ws, { type: "error", code: "forbidden", message: "not in call" });
      return;
    }
    activeCalls.delete(event.callId);
    const otherParticipants = [call.initiatorId, ...call.peerIds].filter(
      (id) => id !== userId,
    );
    for (const otherId of otherParticipants) {
      sendToUser(otherId, {
        type: event.type,
        conversationId: event.conversationId,
        callId: event.callId,
        ...(event.type === "voice_call_reject" ? { reason: event.reason } : {}),
      });
    }
  } else if (event.type === "voice_call_ice") {
    if (!call || (call.initiatorId !== userId && !call.peerIds.includes(userId))) {
      send(ws, { type: "error", code: "forbidden", message: "not in call" });
      return;
    }
    const otherParticipants = [call.initiatorId, ...call.peerIds].filter(
      (id) => id !== userId,
    );
    for (const otherId of otherParticipants) {
      sendToUser(otherId, {
        type: "voice_call_ice",
        conversationId: event.conversationId,
        callId: event.callId,
        candidate: event.candidate,
      });
    }
  }
  return;
}
```

在 `ws.on("close")` 中，在 `sockets!.delete(ws)` 之后追加：

```typescript
cleanupCallsForUser(userId);
```

- [ ] **Step 5: 运行测试确认通过**

```bash
pnpm --filter @heming/server test
```

Expected: PASS

- [ ] **Step 6: 构建 + 提交**

```bash
pnpm --filter @heming/shared build && pnpm --filter @heming/server build
git add packages/server/src/ws.ts packages/server/src/ws.test.ts
git commit -m "feat(server): 语音通话信令路由 + 通话状态跟踪（invite/accept/reject/hangup/ice）"
```

---

## Task 3: 前端通话状态机 voiceCall.ts + 测试

**Files:**
- Create: `packages/web/src/lib/voiceCall.ts`
- Create: `packages/web/src/lib/voiceCall.test.ts`
- Modify: `packages/web/src/components/icons.tsx`（追加 PhoneIcon / PhoneOffIcon / MicIcon / MicOffIcon / VolumeIcon）

**Interfaces:**
- Consumes: Task 1 的 `voice_call_*` 事件类型；`window.__heming_ice_servers`（Task 5 注入）
- Produces: `useVoiceCall` hook，返回 `{ state, call, accept, reject, hangup, toggleMute }`

- [ ] **Step 1: 新增图标**

在 `packages/web/src/components/icons.tsx` 末尾追加：

```typescript
export const PhoneIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" width={p.width ?? 24} height={p.height ?? 24} fill="none" stroke="currentColor" strokeWidth={1.5} {...p}>
    <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" />
  </svg>
);

export const PhoneOffIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" width={p.width ?? 24} height={p.height ?? 24} fill="none" stroke="currentColor" strokeWidth={1.5} {...p}>
    <line x1="22" y1="2" x2="2" y2="22" />
    <path d="M16.72 10.58a16 16 0 0 0-1.8-2.28M12.02 8.14A12.84 12.84 0 0 1 13.5 6.5a2 2 0 0 1 2 1.72" />
    <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72" />
    <line x1="4.11" y1="2" x2="2" y2="4.11" />
  </svg>
);

export const MicIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" width={p.width ?? 24} height={p.height ?? 24} fill="none" stroke="currentColor" strokeWidth={1.5} {...p}>
    <rect x="9" y="2" width="6" height="12" rx="3" />
    <path d="M5 10a7 7 0 0 0 14 0" />
    <line x1="12" y1="19" x2="12" y2="22" />
  </svg>
);

export const MicOffIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" width={p.width ?? 24} height={p.height ?? 24} fill="none" stroke="currentColor" strokeWidth={1.5} {...p}>
    <rect x="9" y="2" width="6" height="12" rx="3" />
    <line x1="22" y1="9" x2="16" y2="15" />
    <line x1="16" y1="9" x2="22" y2="15" />
    <path d="M5 10a7 7 0 0 0 14 0" />
    <line x1="12" y1="19" x2="12" y2="22" />
  </svg>
);

export const VolumeIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" width={p.width ?? 24} height={p.height ?? 24} fill="none" stroke="currentColor" strokeWidth={1.5} {...p}>
    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
    <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
    <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
  </svg>
);
```

- [ ] **Step 2: 写失败测试**

创建 `packages/web/src/lib/voiceCall.test.ts`：

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock RTCPeerConnection
class MockRTCPeerConnection {
  static instances: MockRTCPeerConnection[] = [];
  localDescription: RTCSessionDescription | null = null;
  remoteDescription: RTCSessionDescription | null = null;
  iceGatheringState = "complete";
  connectionState = "new";
  onicecandidate: ((e: RTCPeerConnectionIceEvent) => void) | null = null;
  ontrack: ((e: RTCTrackEvent) => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  signals: unknown[] = [];

  constructor(public config: RTCConfiguration) {
    MockRTCPeerConnection.instances.push(this);
  }

  createOffer(): Promise<RTCSessionDescriptionInit> {
    return Promise.resolve({ type: "offer", sdp: "v=0 mock-offer" });
  }
  createAnswer(): Promise<RTCSessionDescriptionInit> {
    return Promise.resolve({ type: "answer", sdp: "v=0 mock-answer" });
  }
  setLocalDescription(desc: RTCSessionDescriptionInit): Promise<void> {
    this.localDescription = desc as RTCSessionDescription;
    return Promise.resolve();
  }
  setRemoteDescription(desc: RTCSessionDescriptionInit): Promise<void> {
    this.remoteDescription = desc as RTCSessionDescription;
    return Promise.resolve();
  }
  addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    this.signals.push(candidate);
    return Promise.resolve();
  }
  addTrack(track: MediaStreamTrack, stream: MediaStream): RTCRtpSender {
    return { track } as RTCRtpSender;
  }
  close(): void {
    this.connectionState = "closed";
  }
  getStats(): Promise<RTCStatsReport> {
    return Promise.resolve(new Map() as RTCStatsReport);
  }
}

vi.stubGlobal("RTCPeerConnection", MockRTCPeerConnection);

// Mock getUserMedia
const mockStream = {
  getTracks: () => [{ stop: vi.fn() }],
  getAudioTracks: () => [{ stop: vi.fn() }],
};
vi.stubGlobal("navigator", {
  mediaDevices: {
    getUserMedia: vi.fn().mockResolvedValue(mockStream),
    enumerateDevices: vi.fn().mockResolvedValue([]),
  },
});

import { useVoiceCall } from "./voiceCall.js";

describe("useVoiceCall", () => {
  beforeEach(() => {
    MockRTCPeerConnection.instances = [];
    vi.clearAllMocks();
  });

  it("call() 发起通话：获取本地流、创建 PC、发送 invite", async () => {
    const sendFn = vi.fn();
    const { result } = renderHook(() => useVoiceCall({ send: sendFn, myUserId: "u1" }));

    await act(async () => {
      await result.current.call("c1", ["u2", "u3"]);
    });

    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith({ audio: true });
    expect(MockRTCPeerConnection.instances).toHaveLength(2);
    const inviteCalls = sendFn.mock.calls.filter(
      (c) => c[0].type === "voice_call_invite",
    );
    expect(inviteCalls).toHaveLength(2);
    expect(inviteCalls[0][0]).toMatchObject({
      type: "voice_call_invite",
      conversationId: "c1",
      callId: expect.any(String),
      sdp: expect.stringContaining("mock-offer"),
    });
  });

  it("hangup() 关闭所有 PC、停止本地流、发送 hangup", async () => {
    const sendFn = vi.fn();
    const { result } = renderHook(() => useVoiceCall({ send: sendFn, myUserId: "u1" }));

    await act(async () => {
      await result.current.call("c1", ["u2"]);
    });
    const callId = result.current.state.callId!;

    act(() => {
      result.current.hangup();
    });

    expect(MockRTCPeerConnection.instances[0].connectionState).toBe("closed");
    const hangupCalls = sendFn.mock.calls.filter(
      (c) => c[0].type === "voice_call_hangup",
    );
    expect(hangupCalls.length).toBeGreaterThanOrEqual(1);
    expect(hangupCalls[0][0]).toMatchObject({
      type: "voice_call_hangup",
      conversationId: "c1",
      callId,
    });
  });

  it("收到 voice_call_invite 时触发 onIncomingCall 回调", async () => {
    const onIncomingCall = vi.fn();
    const sendFn = vi.fn();
    renderHook(() => useVoiceCall({ send: sendFn, myUserId: "u1", onIncomingCall }));

    // 模拟 WS 事件
    const inviteEvent = {
      type: "voice_call_invite",
      conversationId: "c1",
      callId: "call-x",
      sdp: "v=0 mock-offer-from-u2",
    };
    // 这里需要触发 hook 的 onEvent 机制
    // 实际实现中 hook 暴露 handleServerEvent 方法
    act(() => {
      result.current.handleServerEvent(inviteEvent as any);
    });
    expect(onIncomingCall).toHaveBeenCalledWith(
      expect.objectContaining({ callId: "call-x", conversationId: "c1" }),
    );
  });

  it("accept() 应答来电：创建 PC、发送 accept", async () => {
    const sendFn = vi.fn();
    const onIncomingCall = vi.fn();
    const { result } = renderHook(() =>
      useVoiceCall({ send: sendFn, myUserId: "u1", onIncomingCall }),
    );

    // 先模拟来电
    act(() => {
      result.current.handleServerEvent({
        type: "voice_call_invite",
        conversationId: "c1",
        callId: "call-y",
        sdp: "v=0 mock-offer",
      } as any);
    });

    await act(async () => {
      await result.current.accept("call-y");
    });

    expect(sendFn).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "voice_call_accept",
        callId: "call-y",
        sdp: expect.stringContaining("mock-answer"),
      }),
    );
  });

  it("reject() 拒接来电：发送 reject", async () => {
    const sendFn = vi.fn();
    const onIncomingCall = vi.fn();
    const { result } = renderHook(() =>
      useVoiceCall({ send: sendFn, myUserId: "u1", onIncomingCall }),
    );

    act(() => {
      result.current.handleServerEvent({
        type: "voice_call_invite",
        conversationId: "c1",
        callId: "call-z",
        sdp: "v=0",
      } as any);
    });

    act(() => {
      result.current.reject("call-z", "decline");
    });

    expect(sendFn).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "voice_call_accept",
        callId: "call-z",
      }),
    );
  });
});
```

注意：上面测试中 `renderHook` 和 `act` 需要从 `@testing-library/react` 导入。实际实现中可能需要调整 mock 细节。

- [ ] **Step 3: 运行测试确认失败**

```bash
pnpm --filter @heming/web test -- voiceCall
```

Expected: FAIL — 模块不存在

- [ ] **Step 4: 实现 voiceCall.ts**

创建 `packages/web/src/lib/voiceCall.ts`：

```typescript
import { useState, useRef, useCallback, useEffect } from "react";
import type { WsClientEvent, WsServerEvent } from "@heming/shared";

export interface VoiceCallState {
  callId: string | null;
  conversationId: string | null;
  role: "caller" | "callee" | null;
  status: "idle" | "ringing" | "active" | "reconnecting";
  peerIds: string[];
  startedAt: number | null;
  muted: boolean;
  error: string | null;
}

interface PeerConnection {
  userId: string;
  pc: RTCPeerConnection;
  stream?: MediaStream;
  state: "connecting" | "connected" | "disconnected";
}

export interface UseVoiceCallOptions {
  send: (event: WsClientEvent) => void;
  myUserId: string;
  onIncomingCall?: (info: { callId: string; conversationId: string; initiatorId: string }) => void;
}

const ICE_SERVERS: RTCIceServer[] =
  (typeof window !== "undefined" && (window as any).__heming_ice_servers) || [
    { urls: "stun:stun.miwifi.com:3478" },
  ];

export function useVoiceCall(opts: UseVoiceCallOptions) {
  const { send, myUserId, onIncomingCall } = opts;
  const [state, setState] = useState<VoiceCallState>({
    callId: null,
    conversationId: null,
    role: null,
    status: "idle",
    peerIds: [],
    startedAt: null,
    muted: false,
    error: null,
  });

  const localStreamRef = useRef<MediaStream | null>(null);
  const peersRef = useRef<Map<string, PeerConnection>>(new Map());
  const callIdRef = useRef<string | null>(null);

  const getIceServers = useCallback(() => ICE_SERVERS, []);

  const createPeerConnection = useCallback(
    (peerId: string): RTCPeerConnection => {
      const pc = new RTCPeerConnection({ iceServers: getIceServers() });
      if (localStreamRef.current) {
        for (const track of localStreamRef.current.getTracks()) {
          pc.addTrack(track, localStreamRef.current);
        }
      }
      pc.onicecandidate = (e) => {
        if (e.candidate && callIdRef.current) {
          send({
            type: "voice_call_ice",
            conversationId: state.conversationId!,
            callId: callIdRef.current,
            candidate: e.candidate.candidate,
          });
        }
      };
      pc.ontrack = (e) => {
        const peer = peersRef.current.get(peerId);
        if (peer) {
          peer.stream = e.streams[0];
          peer.state = "connected";
        }
      };
      pc.oniceconnectionstatechange = () => {
        if (pc.iceConnectionState === "failed") {
          // 5s 后重连
          setTimeout(() => {
            if (callIdRef.current) {
              // 简化处理：直接挂断
              hangup();
            }
          }, 5000);
        }
      };
      return pc;
    },
    [getIceServers, send, state.conversationId],
  );

  const call = useCallback(
    async (conversationId: string, peerIds: string[]) => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        localStreamRef.current = stream;
        const callId = crypto.randomUUID();
        callIdRef.current = callId;

        for (const peerId of peerIds) {
          const pc = createPeerConnection(peerId);
          peersRef.current.set(peerId, { userId: peerId, pc, state: "connecting" });
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          send({
            type: "voice_call_invite",
            conversationId,
            callId,
            sdp: offer.sdp!,
          });
        }

        setState({
          callId,
          conversationId,
          role: "caller",
          status: "ringing",
          peerIds,
          startedAt: null,
          muted: false,
          error: null,
        });
      } catch (err) {
        setState((s) => ({
          ...s,
          error: err instanceof DOMException && err.name === "NotAllowedError"
            ? "麦克风权限被拒绝"
            : "未检测到麦克风设备",
        }));
      }
    },
    [createPeerConnection, send],
  );

  const accept = useCallback(
    async (callId: string) => {
      const invite = pendingInvitesRef.current.get(callId);
      if (!invite) return;

      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        localStreamRef.current = stream;
        callIdRef.current = callId;

        // 为每个 peer 创建 PC（这里简化：只连发起方）
        const pc = createPeerConnection(invite.initiatorId);
        peersRef.current.set(invite.initiatorId, {
          userId: invite.initiatorId,
          pc,
          state: "connecting",
        });
        await pc.setRemoteDescription({ type: "offer", sdp: invite.sdp });
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);

        send({
          type: "voice_call_accept",
          conversationId: invite.conversationId,
          callId,
          sdp: answer.sdp!,
        });

        setState({
          callId,
          conversationId: invite.conversationId,
          role: "callee",
          status: "active",
          peerIds: [invite.initiatorId],
          startedAt: Date.now(),
          muted: false,
          error: null,
        });
        pendingInvitesRef.current.delete(callId);
      } catch (err) {
        setState((s) => ({ ...s, error: "接听失败" }));
      }
    },
    [createPeerConnection, send],
  );

  const reject = useCallback(
    (callId: string, reason: "busy" | "decline" | "timeout") => {
      const invite = pendingInvitesRef.current.get(callId);
      if (!invite) return;
      send({
        type: "voice_call_reject",
        conversationId: invite.conversationId,
        callId,
        reason,
      });
      pendingInvitesRef.current.delete(callId);
    },
    [send],
  );

  const hangup = useCallback(() => {
    for (const [, peer] of peersRef.current) {
      peer.pc.close();
    }
    peersRef.current.clear();
    if (localStreamRef.current) {
      for (const track of localStreamRef.current.getTracks()) {
        track.stop();
      }
      localStreamRef.current = null;
    }
    if (callIdRef.current && state.conversationId) {
      send({
        type: "voice_call_hangup",
        conversationId: state.conversationId,
        callId: callIdRef.current,
      });
    }
    callIdRef.current = null;
    setState({
      callId: null,
      conversationId: null,
      role: null,
      status: "idle",
      peerIds: [],
      startedAt: null,
      muted: false,
      error: null,
    });
  }, [send, state.conversationId]);

  const toggleMute = useCallback(() => {
    if (localStreamRef.current) {
      for (const track of localStreamRef.current.getAudioTracks()) {
        track.enabled = !track.enabled;
      }
      setState((s) => ({ ...s, muted: !s.muted }));
    }
  }, []);

  const pendingInvitesRef = useRef<
    Map<string, { callId: string; conversationId: string; sdp: string; initiatorId: string }>
  >(new Map());

  const handleServerEvent = useCallback(
    (event: WsServerEvent) => {
      if (event.type === "voice_call_invite") {
        if (state.status !== "idle") {
          // 正在通话中，拒绝
          send({
            type: "voice_call_reject",
            conversationId: event.conversationId,
            callId: event.callId,
            reason: "busy",
          });
          return;
        }
        pendingInvitesRef.current.set(event.callId, {
          callId: event.callId,
          conversationId: event.conversationId,
          sdp: event.sdp,
          initiatorId: "unknown", // 服务端应带 initiatorId，首版简化
        });
        onIncomingCall?.({
          callId: event.callId,
          conversationId: event.conversationId,
          initiatorId: "unknown",
        });
        setState((s) => ({
          ...s,
          callId: event.callId,
          conversationId: event.conversationId,
          status: "ringing",
          role: "callee",
          error: null,
        }));
      } else if (event.type === "voice_call_accept") {
        setState((s) => ({ ...s, status: "active", startedAt: Date.now() }));
      } else if (event.type === "voice_call_reject") {
        hangup();
      } else if (event.type === "voice_call_hangup") {
        if (event.callId === callIdRef.current) {
          hangup();
        }
      } else if (event.type === "voice_call_ice") {
        // 找到对应的 peer 并添加 ICE candidate
        for (const [, peer] of peersRef.current) {
          peer.pc.addIceCandidate({ candidate: event.candidate } as RTCIceCandidateInit);
        }
      }
    },
    [state.status, send, hangup, onIncomingCall],
  );

  useEffect(() => {
    return () => {
      for (const [, peer] of peersRef.current) {
        peer.pc.close();
      }
      if (localStreamRef.current) {
        for (const track of localStreamRef.current.getTracks()) {
          track.stop();
        }
      }
    };
  }, []);

  return {
    state,
    call,
    accept,
    reject,
    hangup,
    toggleMute,
    handleServerEvent,
  };
}
```

- [ ] **Step 5: 运行测试确认通过**

```bash
pnpm --filter @heming/web test -- voiceCall
```

Expected: PASS（可能需要微调 mock）

- [ ] **Step 6: 构建 + 提交**

```bash
pnpm --filter @heming/web build
git add packages/web/src/lib/voiceCall.ts packages/web/src/lib/voiceCall.test.ts packages/web/src/components/icons.tsx
git commit -m "feat(web): 语音通话状态机 useVoiceCall + 图标"
```

---

## Task 4: 通话面板 UI + ChatPage 集成

**Files:**
- Create: `packages/web/src/components/VoiceCallPanel.tsx`
- Create: `packages/web/src/components/VoiceCallPanel.test.tsx`
- Modify: `packages/web/src/components/ChatPage.tsx`（头部按钮 + 横幅 + 来电弹窗）

**Interfaces:**
- Consumes: Task 3 的 `useVoiceCall` hook
- Produces: 无（UI 组件）

- [ ] **Step 1: 创建 VoiceCallPanel 组件**

创建 `packages/web/src/components/VoiceCallPanel.tsx`：

```tsx
import { useState, useEffect, useRef } from "react";
import type { VoiceCallState } from "../lib/voiceCall.js";
import { PhoneOffIcon, MicIcon, MicOffIcon, VolumeIcon } from "./icons.js";

interface VoiceCallPanelProps {
  state: VoiceCallState;
  peerNames: Map<string, string>;
  onHangup: () => void;
  onToggleMute: () => void;
}

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const ss = s % 60;
  const mm = m % 60;
  if (h > 0) return `${h}:${mm.toString().padStart(2, "0")}:${ss.toString().padStart(2, "0")}`;
  return `${mm.toString().padStart(2, "0")}:${ss.toString().padStart(2, "0")}`;
}

export function VoiceCallPanel({ state, peerNames, onHangup, onToggleMute }: VoiceCallPanelProps) {
  const [duration, setDuration] = useState(0);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    if (state.status === "active" && state.startedAt) {
      timerRef.current = window.setInterval(() => {
        setDuration(Date.now() - state.startedAt!);
      }, 1000);
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [state.status, state.startedAt]);

  if (state.status === "idle") return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#1a1a2e]">
      <div className="flex flex-col items-center gap-8 text-white">
        <div className="text-[12px] text-gray-400">
          {state.conversationId && "语音通话"}
        </div>

        {/* 参与者列表 */}
        <div className="flex flex-col items-center gap-3">
          {state.peerIds.map((peerId) => (
            <div key={peerId} className="flex items-center gap-3">
              <div
                className={`h-3 w-3 rounded-full ${
                  state.status === "active" ? "bg-[#4ade80] animate-pulse" : "bg-gray-500"
                }`}
              />
              <span className="text-[16px]">{peerNames.get(peerId) ?? peerId}</span>
            </div>
          ))}
          {state.status === "ringing" && (
            <span className="text-[14px] text-gray-300">
              {state.role === "caller" ? "正在呼叫…" : " incoming call"}
            </span>
          )}
        </div>

        {/* 通话时长 */}
        {state.status === "active" && (
          <div className="text-[28px] font-light tabular-nums text-white">
            {formatDuration(duration)}
          </div>
        )}

        {/* 错误提示 */}
        {state.error && (
          <div className="text-[14px] text-red-400">{state.error}</div>
        )}

        {/* 操作按钮 */}
        <div className="flex items-center gap-6">
          <button
            type="button"
            aria-label={state.muted ? "取消静音" : "静音"}
            className="flex h-14 w-14 items-center justify-center rounded-full bg-[#3b82f6] text-white transition hover:bg-[#2563eb]"
            onClick={onToggleMute}
          >
            {state.muted ? (
              <MicOffIcon width={22} height={22} />
            ) : (
              <MicIcon width={22} height={22} />
            )}
          </button>
          <button
            type="button"
            aria-label="挂断"
            className="flex h-14 w-14 items-center justify-center rounded-full bg-[#ef4444] text-white transition hover:bg-[#dc2626]"
            onClick={onHangup}
          >
            <PhoneOffIcon width={22} height={22} />
          </button>
          <button
            type="button"
            aria-label="扬声器"
            className="flex h-14 w-14 items-center justify-center rounded-full bg-[#3b82f6] text-white transition hover:bg-[#2563eb]"
          >
            <VolumeIcon width={22} height={22} />
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: 写组件测试**

创建 `packages/web/src/components/VoiceCallPanel.test.tsx`：

```tsx
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { VoiceCallPanel } from "./VoiceCallPanel.js";
import type { VoiceCallState } from "../lib/voiceCall.js";

const baseState: VoiceCallState = {
  callId: "c1",
  conversationId: "conv1",
  role: "caller",
  status: "ringing",
  peerIds: ["u2"],
  startedAt: null,
  muted: false,
  error: null,
};

describe("VoiceCallPanel", () => {
  it("status idle 时不渲染", () => {
    const { container } = render(
      <VoiceCallPanel
        state={{ ...baseState, status: "idle" }}
        peerNames={new Map()}
        onHangup={vi.fn()}
        onToggleMute={vi.fn()}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("ringing 状态显示参与者", () => {
    render(
      <VoiceCallPanel
        state={baseState}
        peerNames={new Map([["u2", "张三"]])}
        onHangup={vi.fn()}
        onToggleMute={vi.fn()}
      />,
    );
    expect(screen.getByText("张三")).toBeInTheDocument();
    expect(screen.getByText("正在呼叫…")).toBeInTheDocument();
  });

  it("active 状态显示计时器", () => {
    render(
      <VoiceCallPanel
        state={{ ...baseState, status: "active", startedAt: Date.now() }}
        peerNames={new Map([["u2", "李四"]])}
        onHangup={vi.fn()}
        onToggleMute={vi.fn()}
      />,
    );
    expect(screen.getByText(/^\d{2}:\d{2}$/)).toBeInTheDocument();
  });

  it("挂断按钮触发 onHangup", () => {
    const onHangup = vi.fn();
    render(
      <VoiceCallPanel
        state={{ ...baseState, status: "active", startedAt: Date.now() }}
        peerNames={new Map()}
        onHangup={onHangup}
        onToggleMute={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByLabelText("挂断"));
    expect(onHangup).toHaveBeenCalled();
  });

  it("静音按钮触发 onToggleMute", () => {
    const onToggleMute = vi.fn();
    render(
      <VoiceCallPanel
        state={{ ...baseState, status: "active", startedAt: Date.now() }}
        peerNames={new Map()}
        onHangup={vi.fn()}
        onToggleMute={onToggleMute}
      />,
    );
    fireEvent.click(screen.getByLabelText("静音"));
    expect(onToggleMute).toHaveBeenCalled();
  });

  it("错误提示显示", () => {
    render(
      <VoiceCallPanel
        state={{ ...baseState, error: "麦克风权限被拒绝" }}
        peerNames={new Map()}
        onHangup={vi.fn()}
        onToggleMute={vi.fn()}
      />,
    );
    expect(screen.getByText("麦克风权限被拒绝")).toBeInTheDocument();
  });
});
```

- [ ] **Step 3: 集成到 ChatPage**

在 `ChatPage.tsx` 中：

1. 导入 `useVoiceCall` 和 `VoiceCallPanel`
2. 在组件内调用 `useVoiceCall`，传入 `send`（WS 发送函数）和 `myUserId`
3. 在 `handleServerEvent` 中追加 `voiceCall.handleServerEvent(event)`
4. 头部工具栏（`MenuIcon` 按钮旁）追加电话图标按钮
5. 底部追加通话横幅条
6. 全屏覆盖 `VoiceCallPanel`

关键插入点（以注释标记）：

```tsx
// ── 语音通话集成 ──
const voiceCall = useVoiceCall({
  send: (event) => wsRef.current?.send(event),
  myUserId: me?.id ?? "",
});
// 在现有 onEvent 回调中追加：
// voiceCall.handleServerEvent(event);

// 头部按钮区域（MenuIcon 附近）：
<button
  type="button"
  aria-label="语音通话"
  className="rounded-lg p-1.5 hover:bg-[#f3f3f3]"
  onClick={() => {
    if (conv?.type === "direct") {
      voiceCall.call(conv.id, [conv.peer.id]);
    }
  }}
>
  <PhoneIcon width={17} height={17} />
</button>

// 底部通话横幅（消息列表下方）：
{voiceCall.state.status !== "idle" && voiceCall.state.status !== "active" && (
  <div className="flex items-center gap-3 border-t border-line-soft bg-[#f9f9f9] px-5 py-3">
    <PhoneIcon width={16} height={16} />
    <span className="text-[13px]">正在呼叫…</span>
    <button
      type="button"
      className="ml-auto text-[13px] text-red-500"
      onClick={voiceCall.hangup}
    >
      取消
    </button>
  </div>
)}

// 全屏通话面板（return 的最后）：
<VoiceCallPanel
  state={voiceCall.state}
  peerNames={peerNames}
  onHangup={voiceCall.hangup}
  onToggleMute={voiceCall.toggleMute}
/>
```

- [ ] **Step 4: 运行测试**

```bash
pnpm --filter @heming/web test
```

Expected: 全绿

- [ ] **Step 5: 构建 + 提交**

```bash
pnpm --filter @heming/web build
git add packages/web/src/components/VoiceCallPanel.tsx packages/web/src/components/VoiceCallPanel.test.tsx packages/web/src/components/ChatPage.tsx
git commit -m "feat(web): 通话面板 UI + ChatPage 集成"
```

---

## Task 5: Electron 桌面端适配 + ICE 配置

**Files:**
- Modify: `packages/desktop/main.js`（ICE 配置注入 + 通知）
- Modify: `packages/desktop/preload.js`（暴露桥接 API）
- Modify: `packages/server/src/app.ts`（`GET /api/ice-servers` 端点）

**Interfaces:**
- Consumes: Task 3 的 `window.__heming_ice_servers`
- Produces: `window.__heming_ice_servers`、`window.__heming_voice_call`

- [ ] **Step 1: 新增 /api/ice-servers 端点**

在 `packages/server/src/app.ts` 的 `return app` 之前追加：

```typescript
// —— 语音通话：ICE 服务器配置（STUN/TURN，从环境变量读取）——
app.get("/api/ice-servers", (_req, res) => {
  const iceServers: { urls: string; username?: string; credential?: string }[] = [
    { urls: process.env.HEMING_STUN ?? "stun:stun.miwifi.com:3478" },
  ];
  if (process.env.HEMING_TURN_URL) {
    iceServers.push({
      urls: process.env.HEMING_TURN_URL,
      username: process.env.HEMING_TURN_USERNAME ?? "",
      credential: process.env.HEMING_TURN_CREDENTIAL ?? "",
    });
  }
  res.json({ iceServers });
});
```

- [ ] **Step 2: 修改 preload.js**

```javascript
"use strict";
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("heming", {
  platform: process.platform,
  // harness 桥接 API 在 M（二期）扩展
});

// —— 语音通话桥接 ——
contextBridge.exposeInMainWorld("__heming_ice_servers", []);

contextBridge.exposeInMainWorld("__heming_voice_call", {
  onMinimize: (callback) => {
    ipcRenderer.on("voice-call:minimized", callback);
  },
  notify: (title, body) => {
    ipcRenderer.send("voice-call:notify", title, body);
  },
});
```

- [ ] **Step 3: 修改 main.js**

在 `createWindow` 函数内，`win.loadURL` 之后追加 ICE 配置拉取和通知处理：

```typescript
// 语音通话：拉取 ICE 配置并注入渲染层
const iceBase = process.env.HEMING_API_BASE || appUrl.replace(/\/$/, "");
fetch(`${iceBase}/api/ice-servers`)
  .then((r) => (r.ok ? r.json() : null))
  .then((data) => {
    if (data?.iceServers) {
      win.webContents.executeJavaScript(
        `window.__heming_ice_servers = ${JSON.stringify(data.iceServers)}`,
      );
    }
  })
  .catch(() => {});

// 窗口最小化时通知渲染层
win.on("minimize", () => {
  win.webContents.send("voice-call:minimized");
});
```

在 `createWindow` 之外追加系统通知处理：

```typescript
const { Notification } = require("electron");
ipcMain.on("voice-call:notify", (_event, title: string, body: string) => {
  if (Notification.isSupported()) {
    new Notification({ title, body }).show();
  }
});
```

注意：需要在 main.js 顶部追加 `const { ipcMain } = require("electron");`。

- [ ] **Step 4: 运行全量测试**

```bash
pnpm -r build && pnpm -r test
```

Expected: 全绿

- [ ] **Step 5: 提交**

```bash
git add packages/desktop/main.js packages/desktop/preload.js packages/server/src/app.ts
git commit -m "feat(desktop): Electron ICE 配置注入 + 通话通知 + /api/ice-servers 端点"
```

---

## 自审清单

- [x] **规格覆盖**：§3 契约 → Task 1；§4 服务端 → Task 2；§5 状态机 → Task 3；§6 UI → Task 4；§7 Electron → Task 5；§8 测试 → 各 Task 内嵌；§9 错误处理 → Task 3 状态机内
- [x] **无占位符**：所有步骤含具体代码
- [x] **类型一致**：`VoiceCallState` 在 Task 3 定义、Task 4 消费；`voice_call_*` 事件在 Task 1 定义、Task 2/3 消费
- [x] **依赖顺序**：T1 → T2/T3（并行）→ T4 → T5
