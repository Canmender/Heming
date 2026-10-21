import type { Server as HttpServer, IncomingMessage } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { WsClientEventSchema, type WsServerEvent } from "@heming/shared";
import type { Store } from "./store.js";
import { userIdFromToken } from "./auth.js";

/** ringing 超时兜底（规格 §4.5）：30s 未接听的通话自动收尾，防 activeCalls 无界增长。 */
export const RING_TIMEOUT_MS = 30_000;
const RING_SWEEP_INTERVAL_MS = 5_000;

export interface AttachWsOptions {
  /** 自定义超时阈值（测试注入用，默认 RING_TIMEOUT_MS）。 */
  ringTimeoutMs?: number;
  /** 自定义扫描间隔（测试注入用，默认 RING_SWEEP_INTERVAL_MS）。 */
  ringSweepIntervalMs?: number;
}

export function attachWs(
  server: HttpServer,
  store: Store,
  opts: AttachWsOptions = {},
): WebSocketServer {
  const ringTimeoutMs = opts.ringTimeoutMs ?? RING_TIMEOUT_MS;
  const ringSweepIntervalMs = opts.ringSweepIntervalMs ?? RING_SWEEP_INTERVAL_MS;
  const wss = new WebSocketServer({ noServer: true });
  const socketsByUser = new Map<string, Set<WebSocket>>();

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/api/ws") {
      socket.destroy();
      return;
    }
    const userId = userIdFromToken(url.searchParams.get("token") ?? "");
    if (!userId) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req, userId);
    });
  });

  function send(ws: WebSocket, event: WsServerEvent): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(event));
  }

  function broadcastToConversation(conversationId: string, event: WsServerEvent): void {
    for (const [userId, sockets] of socketsByUser) {
      if (!store.isMember(conversationId, userId)) continue;
      for (const ws of sockets) send(ws, event);
    }
  }

  function sendToUser(userId: string, event: WsServerEvent): void {
    const sockets = socketsByUser.get(userId);
    if (!sockets) return;
    for (const ws of sockets) send(ws, event);
  }

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

  // ringing 超时兜底（C3）：超过 RING_TIMEOUT_MS 仍在 ringing 的通话 → 向所有参与者
  // 补发 voice_call_reject(timeout) 并移除状态。避免被叫离线/未接听时对端永久卡在
  // 「正在呼叫…」。定时器 .unref() 不阻塞进程退出；wss close 时清除（兜底）。
  const ringTimeoutTimer = setInterval(() => {
    const now = Date.now();
    for (const [callId, call] of activeCalls) {
      if (call.state === "ringing" && now - call.startedAt > ringTimeoutMs) {
        // 通知发起方被叫超时
        sendToUser(call.initiatorId, {
          type: "voice_call_reject",
          conversationId: call.conversationId,
          callId,
          reason: "timeout",
        });
        // 通知被叫方通话已取消
        for (const peerId of call.peerIds) {
          sendToUser(peerId, {
            type: "voice_call_hangup",
            conversationId: call.conversationId,
            callId,
          });
        }
        activeCalls.delete(callId);
      }
    }
  }, ringSweepIntervalMs);
  if (typeof ringTimeoutTimer.unref === "function") ringTimeoutTimer.unref();

  // 注：@types/ws 的 "connection" 特化重载只声明 2 参（websocket, request），
  // 本实现经 wss.emit("connection", ws, req, userId) 传入第三参 userId，
  // 会落到 EventEmitter 的泛型重载，_req 需显式注解以通过 strict 检查（零运行时影响）。
  wss.on("connection", (ws: WebSocket, _req: IncomingMessage, userId: string) => {
    let sockets = socketsByUser.get(userId);
    if (!sockets) {
      sockets = new Set();
      socketsByUser.set(userId, sockets);
    }
    sockets.add(ws);

    ws.on("message", (raw) => {
      let json: unknown;
      try {
        json = JSON.parse(raw.toString());
      } catch {
        send(ws, { type: "error", code: "bad_event", message: "invalid json" });
        return;
      }
      const parsed = WsClientEventSchema.safeParse(json);
      if (!parsed.success) {
        send(ws, { type: "error", code: "bad_event", message: "invalid event" });
        return;
      }
      const event = parsed.data;
      // 语音通话信令（Task 2 + d.25 重连）：invite/accept/reject/hangup/ice/reconnect
      // 六种事件定向投递，不走广播、不入库；通话状态仅在内存 activeCalls，
      // 断开连接时 cleanupCallsForUser 向其他参与者补发 hangup。成员校验口径与下方通用分支一致。
      if (
        event.type === "voice_call_invite" ||
        event.type === "voice_call_accept" ||
        event.type === "voice_call_reject" ||
        event.type === "voice_call_hangup" ||
        event.type === "voice_call_ice" ||
        event.type === "voice_call_reconnect"
      ) {
        if (!store.isMember(event.conversationId, userId)) {
          send(ws, { type: "error", code: "forbidden", message: "not a member" });
          return;
        }
        const call = activeCalls.get(event.callId);
        if (event.type === "voice_call_invite") {
          // 同 callId 重复 invite 覆盖旧状态（发起方重拨语义）
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
              fromUserId: userId,
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
            fromUserId: userId,
          });
        } else if (event.type === "voice_call_reject") {
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
              type: "voice_call_reject",
              conversationId: event.conversationId,
              callId: event.callId,
              reason: event.reason,
            });
          }
        } else if (event.type === "voice_call_hangup") {
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
              type: "voice_call_hangup",
              conversationId: event.conversationId,
              callId: event.callId,
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
              fromUserId: userId,
            });
          }
        } else if (event.type === "voice_call_reconnect") {
          // ICE 重启的重新协商：只转发 SDP，不动 activeCalls 状态（通话早已 active，
          // 重连是链路层面的事，振铃超时兜底与 hangup 语义都不该被它重置）。
          if (!call || (call.initiatorId !== userId && !call.peerIds.includes(userId))) {
            send(ws, { type: "error", code: "forbidden", message: "not in call" });
            return;
          }
          const otherParticipants = [call.initiatorId, ...call.peerIds].filter(
            (id) => id !== userId,
          );
          for (const otherId of otherParticipants) {
            sendToUser(otherId, {
              type: "voice_call_reconnect",
              conversationId: event.conversationId,
              callId: event.callId,
              sdp: event.sdp,
              sdpType: event.sdpType,
              fromUserId: userId,
            });
          }
        }
        return;
      }
      // 流式三事件（chunk/finish/error）统一在此截获，排在下方通用 isMember 与
      // send_message/mark_read 二分之前：否则 chunk/finish 会落入 else 被误当
      // mark_read 广播 read_update（Task 1 handoff），非成员收到的也会是通用
      // error(forbidden) 而非契约要求的 agent_error(forbidden)。
      if (event.type === "agent_chunk" || event.type === "agent_error") {
        if (!store.isMember(event.conversationId, userId)) {
          send(ws, {
            type: "agent_error",
            conversationId: event.conversationId,
            agentId: event.agentId,
            streamId: event.streamId,
            code: "forbidden",
            message: "not a member",
          });
          return;
        }
        if (event.type === "agent_chunk") {
          broadcastToConversation(event.conversationId, {
            type: "agent_chunk",
            conversationId: event.conversationId,
            agentId: event.agentId,
            streamId: event.streamId,
            text: event.text,
            // E2E 流式信封（Task 4，设计 §5.3）：密文 chunk 原样透传——服务端不读内容，
            // 收端按 cipher/chainKid/n/index 开信封（明文 legacy chunk 无这些字段）。
            ...(event.cipher !== undefined
              ? {
                  cipher: event.cipher,
                  ...(event.chainKid !== undefined ? { chainKid: event.chainKid } : {}),
                  ...(event.n !== undefined ? { n: event.n } : {}),
                  ...(event.index !== undefined ? { index: event.index } : {}),
                }
              : {}),
          });
        } else {
          // agent_error：校验成员后广播原事件，不入库。
          broadcastToConversation(event.conversationId, event);
        }
        return;
      }
      if (event.type === "agent_finish") {
        // F2：shared 的 finish text 保持宽松入站（无 min），服务端拒收 trim 空串——
        // 密文 finish（Task 4）text 恒为空、全文在 cipher 里，跳过该拒收（schema 层已
        // 保证 cipher 非空且夹带明文会被拒，服务端对信封只存不读）。
        if (event.text.trim() === "" && event.cipher === undefined) {
          send(ws, {
            type: "agent_error",
            conversationId: event.conversationId,
            agentId: event.agentId,
            streamId: event.streamId,
            code: "bad_event",
            message: "empty text",
          });
          return;
        }
        const member = store.isMember(event.conversationId, userId);
        // isMember 对不存在会话返回 false；listMembers 会抛错——仅在确认是成员
        // （会话必存在）后才调用，try/catch 兜底按 forbidden 处理。
        let inGroup = false;
        if (member) {
          try {
            inGroup = store
              .listMembers(event.conversationId)
              .some((m) => m.kind === "agent" && m.id === event.agentId);
          } catch {
            inGroup = false;
          }
        }
        if (!member || !inGroup) {
          send(ws, {
            type: "agent_error",
            conversationId: event.conversationId,
            agentId: event.agentId,
            streamId: event.streamId,
            code: "forbidden",
            message: member ? "agent not in group" : "not a member",
          });
          return;
        }
        // 密文 finish 按信封入库（内容在 cipher，payload 落 {text:""} 占位、replyTo 置空——
        // 与 send_message e2e 路径同口径，服务端不见内容）；明文 finish 保持原样。
        const message =
          event.cipher !== undefined
            ? store.addMessage(
                event.conversationId,
                "agent",
                event.agentId,
                { text: "" },
                null,
                {
                  enc: "e2e",
                  cipher: event.cipher,
                  ...(event.chainKid !== undefined ? { chainKid: event.chainKid } : {}),
                  ...(event.n !== undefined ? { n: event.n } : {}),
                },
              )
            : store.addMessage(
                event.conversationId,
                "agent",
                event.agentId,
                { text: event.text },
                event.replyTo ?? null,
              );
        broadcastToConversation(event.conversationId, { type: "message_new", message, streamId: event.streamId });
        return;
      }
      if (!store.isMember(event.conversationId, userId)) {
        send(ws, { type: "error", code: "forbidden", message: "not a member" });
        return;
      }
      // recall 独立成支（成员校验已在上方统一做过）；mark_read 保持 else 兜底——
      // 只有「非 send、非 recall」的剩余事件（= mark_read；agent_* 已在上方 return，
      // react_message 已从 shared 契约移除→上面 parse 即 bad_event）会走到，
      // 防撤回/发送被误当已读广播 read_update。
      if (event.type === "recall_message") {
        const m = store.recallMessage(event.conversationId, event.messageId, userId);
        if (!m) {
          // store 口径：非本人发送 / 消息不存在 → null（非成员已在上方拦下）
          send(ws, { type: "error", code: "forbidden", message: "not the sender" });
          return;
        }
        broadcastToConversation(event.conversationId, {
          type: "message_recalled",
          conversationId: event.conversationId,
          messageId: event.messageId,
          at: m.recalledAt!,
        });
      } else if (event.type === "send_message") {
        if (event.enc === "e2e") {
          // E2E 信封路径（设计 §4）：服务端只见信封——不读 payload 内容、不落 replyTo
          // （正文/回复指向都在密文里），直接入库并广播 message_new。schema 层已保证
          // cipher 必带非空（superRefine），此处只搬信封字段。
          const message = store.addMessage(
            event.conversationId,
            "user",
            userId,
            { text: "" }, // 占位 payload：内容不落库
            null,
            {
              enc: "e2e",
              cipher: event.cipher!,
              ...(event.chainKid !== undefined ? { chainKid: event.chainKid } : {}),
              ...(event.n !== undefined ? { n: event.n } : {}),
            },
          );
          broadcastToConversation(event.conversationId, { type: "message_new", message });
        } else {
          // 明文路径保持现校验（schema 形状 + mentions/file/forward 原样透传）
          const message = store.addMessage(
            event.conversationId,
            "user",
            userId,
            {
              text: event.payload.text,
              ...(event.payload.mentions ? { mentions: event.payload.mentions } : {}),
              ...(event.payload.file ? { file: event.payload.file } : {}),
              ...(event.payload.forward ? { forward: event.payload.forward } : {}),
            },
            event.replyTo ?? null,
          );
          broadcastToConversation(event.conversationId, { type: "message_new", message });
        }
      } else {
        const at = new Date().toISOString();
        store.markRead(event.conversationId, userId);
        broadcastToConversation(event.conversationId, {
          type: "read_update",
          conversationId: event.conversationId,
          userId,
          at,
        });
      }
    });

    ws.on("close", () => {
      sockets!.delete(ws);
      // 仅在用户最后一个连接断开时才清理通话：多设备/多标签页在线时，
      // 单个连接断开不应误断正在进行通话（T2 评审遗留项）。
      if (sockets!.size === 0) {
        socketsByUser.delete(userId);
        cleanupCallsForUser(userId);
      }
    });

    ws.on("error", () => { /* 连接级错误忽略，避免未捕获异常崩溃进程 */ });
  });

  // wss 关闭时清除 ringing 超时扫描（unref 已保证不阻塞退出，此处为显式兜底）。
  wss.on("close", () => {
    clearInterval(ringTimeoutTimer);
  });

  return wss;
}
