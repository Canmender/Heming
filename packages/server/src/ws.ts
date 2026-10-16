import type { Server as HttpServer, IncomingMessage } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { WsClientEventSchema, type WsServerEvent } from "@heming/shared";
import type { Store } from "./store.js";
import { userIdFromToken } from "./auth.js";

export function attachWs(server: HttpServer, store: Store): WebSocketServer {
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
          });
        } else {
          // agent_error：校验成员后广播原事件，不入库。
          broadcastToConversation(event.conversationId, event);
        }
        return;
      }
      if (event.type === "agent_finish") {
        // F2：shared 的 finish text 保持宽松入站（无 min），服务端拒收 trim 空串。
        if (event.text.trim() === "") {
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
        const message = store.addMessage(
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
      if (event.type === "send_message") {
        const message = store.addMessage(
          event.conversationId,
          "user",
          userId,
          // mentions / file 原样透传入库（内存存引用、sqlite JSON.stringify——两实现均无 shape 校验）。
          {
            text: event.payload.text,
            ...(event.payload.mentions ? { mentions: event.payload.mentions } : {}),
            ...(event.payload.file ? { file: event.payload.file } : {}),
          },
          event.replyTo ?? null,
        );
        broadcastToConversation(event.conversationId, { type: "message_new", message });
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
      if (sockets!.size === 0) socketsByUser.delete(userId);
    });

    ws.on("error", () => { /* 连接级错误忽略，避免未捕获异常崩溃进程 */ });
  });

  return wss;
}
