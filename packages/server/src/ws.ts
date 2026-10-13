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
      if (!store.isMember(event.conversationId, userId)) {
        send(ws, { type: "error", code: "forbidden", message: "not a member" });
        return;
      }
      if (event.type === "send_message") {
        const message = store.addMessage(
          event.conversationId,
          "user",
          userId,
          { text: event.payload.text },
          event.replyTo ?? null,
        );
        broadcastToConversation(event.conversationId, { type: "message_new", message });
      } else {
        broadcastToConversation(event.conversationId, {
          type: "read_update",
          conversationId: event.conversationId,
          userId,
          at: new Date().toISOString(),
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
