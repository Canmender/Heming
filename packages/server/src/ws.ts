import type { Server as HttpServer, IncomingMessage } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { WsClientEventSchema, type WsServerEvent } from "@heming/shared";
import type { Store } from "./store.js";
import { userIdFromToken } from "./auth.js";
import { presence } from "./presence.js";

/** 首帧鉴权超时（d.30 · P0-3）：连上后 10s 内没等到 auth 帧 → 服务端主动断开。 */
export const AUTH_TIMEOUT_MS = 10_000;

export interface AttachWsOptions {
  /** 自定义鉴权超时阈值（测试注入用，默认 AUTH_TIMEOUT_MS）。 */
  authTimeoutMs?: number;
}

export function attachWs(
  server: HttpServer,
  store: Store,
  opts: AttachWsOptions = {},
): WebSocketServer {
  const authTimeoutMs = opts.authTimeoutMs ?? AUTH_TIMEOUT_MS;
  const wss = new WebSocketServer({ noServer: true });
  const socketsByUser = new Map<string, Set<WebSocket>>();

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/api/ws") {
      socket.destroy();
      return;
    }
    // 首帧鉴权（d.30 · P0-3）：token 只认连接建立后的第一帧 {type:"auth", token}。
    //
    // ★ query token 兼容路径已在「全面升级」轮删除：旧客户端曾把 token 拼在 query 上，
    //   而 query 会进 nginx access_log 与任何中间代理日志。d.54 起人类 IM 已删除，
    //   在网旧包（d.35.1.8.0）本就无法与本服务端配套使用，保留这条路径只剩暴露面。
    //   现在 query 里即使带了 token 也不会被读取——连接照常建立，但保持未鉴权，
    //   等首帧 auth；10s 内没有合法 auth 帧即断开。
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
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

  // 注：@types/ws 的 "connection" 特化重载只声明 2 参（websocket, request），
  // 本实现经 wss.emit("connection", ws, req) 触发；_req 显式注解以通过 strict 检查。
  wss.on("connection", (ws: WebSocket, _req: IncomingMessage) => {
    // —— 首帧鉴权（d.30 · P0-3）——
    // 连接建立时一律未鉴权：只有收到合法 auth 帧才会登记进 socketsByUser。
    let userId = "";
    let authed = false;
    /** 本连接登记进 socketsByUser 的那个 Set；未鉴权时为 undefined（从未登记）。 */
    let registered: Set<WebSocket> | undefined;

    function register(uid: string): void {
      let set = socketsByUser.get(uid);
      if (!set) {
        set = new Set();
        socketsByUser.set(uid, set);
      }
      set.add(ws);
      registered = set;
      // d.54：在线登记 + 最近活跃。多设备/多标签页按 socket 计数。
      presence.online(uid);
      store.touchUser(uid);
    }

    if (authed) register(userId);

    // 鉴权超时：连上后 authTimeoutMs 内没等到 auth 帧 → 服务端主动断开。
    // 定时器 .unref() 不阻塞进程退出（与 ringTimeoutTimer 同模式）。
    let authTimer: NodeJS.Timeout | undefined;
    if (!authed) {
      authTimer = setTimeout(() => {
        if (authed) return;
        send(ws, { type: "error", code: "unauthorized", message: "auth timeout" });
        ws.close();
      }, authTimeoutMs);
      if (typeof authTimer.unref === "function") authTimer.unref();
    }

    ws.on("message", (raw) => {
      let json: unknown;
      try {
        json = JSON.parse(raw.toString());
      } catch {
        // 未鉴权连接发来的不是合法 auth 帧 → 按未授权处理并断开
        if (!authed) {
          send(ws, { type: "error", code: "unauthorized", message: "auth required" });
          ws.close();
          return;
        }
        send(ws, { type: "error", code: "bad_event", message: "invalid json" });
        return;
      }
      const parsed = WsClientEventSchema.safeParse(json);
      if (!parsed.success) {
        if (!authed) {
          send(ws, { type: "error", code: "unauthorized", message: "auth required" });
          ws.close();
          return;
        }
        send(ws, { type: "error", code: "bad_event", message: "invalid event" });
        return;
      }
      const event = parsed.data;

      // —— auth 帧：未鉴权状态下唯一允许发送的事件（d.30 · P0-3）——
      if (event.type === "auth") {
        // 已鉴权（走的是 query 兼容路径）时忽略重复的 auth 帧，不做身份切换。
        if (authed) return;
        const uid = userIdFromToken(store, event.token);
        if (!uid) {
          send(ws, { type: "error", code: "unauthorized", message: "invalid token" });
          ws.close();
          return;
        }
        userId = uid;
        authed = true;
        if (authTimer) {
          clearTimeout(authTimer);
          authTimer = undefined;
        }
        register(userId);
        return;
      }

      // 未鉴权时收到任何其它事件 → 回 error(unauthorized) 并断开。
      // 注：「未鉴权的连接收不到任何业务事件」是**结构性**保证，不靠这里的 if：
      // 未鉴权的 socket 从未登记进 socketsByUser，而广播路径
      // （broadcastToConversation / sendToUser）只遍历 socketsByUser。
      if (!authed) {
        send(ws, { type: "error", code: "unauthorized", message: "auth required" });
        ws.close();
        return;
      }
      // d.54：语音/视频信令已随人类 IM 删除；旧客户端发来会落到下方的
      // 「不支持的事件」分支，回 error(unsupported)。
      // 流式三事件（chunk/finish/error）统一在此截获，排在下方通用 isMember 与
      // send_message 之前：否则 chunk/finish 会落入后续分支被误判。
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
        // d.54：会话只剩一对一，成员身份之外还要确认 agentId 就是这条会话的助手，
        // 否则任何人都能把回复写进别人的助手会话。
        const convAgentId = store.conversationAgentId(event.conversationId);
        if (!member || convAgentId !== event.agentId) {
          send(ws, {
            type: "agent_error",
            conversationId: event.conversationId,
            agentId: event.agentId,
            streamId: event.streamId,
            code: "forbidden",
            message: member ? "agent mismatch" : "not a member",
          });
          return;
        }
        // 密文 finish 按信封入库（内容在 cipher，payload 落 {text:""} 占位——
        // 与 send_message e2e 路径同口径，服务端不见内容）；明文 finish 保持原样。
        const message =
          event.cipher !== undefined
            ? store.addMessage(
                event.conversationId,
                "agent",
                event.agentId,
                { text: "" },
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
              );
        broadcastToConversation(event.conversationId, { type: "message_new", message, streamId: event.streamId });
        return;
      }
      if (!store.isMember(event.conversationId, userId)) {
        send(ws, { type: "error", code: "forbidden", message: "not a member" });
        return;
      }
      // d.54：会话只剩 AI 一对一。typing / recall / mark_read / 语音等事件已删除，
      // 旧客户端发来统一回 unsupported，不再静默当成已读或广播。
      if (event.type !== "send_message") {
        send(ws, { type: "error", code: "unsupported", message: "event removed" });
        return;
      }
      if (event.enc === "e2e") {
        // E2E 信封路径（设计 §4）：服务端只见信封——不读 payload 内容
        // （正文都在密文里），直接入库并广播 message_new。schema 层已保证
        // cipher 必带非空（superRefine），此处只搬信封字段。
        const message = store.addMessage(
          event.conversationId,
          "user",
          userId,
          { text: "" }, // 占位 payload：内容不落库
          {
            enc: "e2e",
            cipher: event.cipher!,
            ...(event.chainKid !== undefined ? { chainKid: event.chainKid } : {}),
            ...(event.n !== undefined ? { n: event.n } : {}),
          },
        );
        broadcastToConversation(event.conversationId, { type: "message_new", message });
      } else {
        // 明文路径：schema 形状校验后原样透传（附件随行）。
        const message = store.addMessage(
          event.conversationId,
          "user",
          userId,
          {
            text: event.payload.text,
            ...(event.payload.file ? { file: event.payload.file } : {}),
          },
        );
        broadcastToConversation(event.conversationId, { type: "message_new", message });
      }
    });

    ws.on("close", () => {
      // 未鉴权就断开的 socket 从未登记进 socketsByUser —— 安全跳过，别抛。
      if (!registered) {
        if (authTimer) clearTimeout(authTimer);
        return;
      }
      registered.delete(ws);
      // presence 按 socket 计数，每个连接断开都要 -1；活动时间也按连接刷新。
      presence.offline(userId);
      store.touchUser(userId);
      // 最后一个连接断开时清掉登记表，避免保留空 Set。
      if (registered.size === 0) socketsByUser.delete(userId);
    });

    ws.on("error", () => { /* 连接级错误忽略，避免未捕获异常崩溃进程 */ });
  });

  return wss;
}
