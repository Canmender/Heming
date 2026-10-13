import { describe, it, expect, beforeAll, afterAll } from "vitest";
import WebSocket from "ws";
import { createMemoryStore, Store } from "./store.js";
import { startServer } from "./index.js";
import { issueToken } from "./auth.js";
import type { WsServerEvent } from "@heming/shared";

let ctx: Awaited<ReturnType<typeof startServer>>;
let store: Store;
let aliceId: string;
let bobId: string;
let convId: string;

function connect(token: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${ctx.port}/api/ws?token=${token}`);
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

function nextEvent(ws: WebSocket): Promise<WsServerEvent> {
  return new Promise((resolve, reject) => {
    ws.once("message", (data) => resolve(JSON.parse(data.toString())));
    ws.once("error", reject);
  });
}

beforeAll(async () => {
  ctx = await startServer(0);
  store = ctx.store;
  const alice = store.createUser("alice", "h", "爱丽丝");
  const bob = store.createUser("bob", "h", "鲍勃");
  aliceId = alice.id;
  bobId = bob.id;
  store.acceptFriendRequest(store.createFriendRequest(aliceId, "bob").id, bobId);
  convId = store.createDirectConversation(aliceId, bobId).id;
});

afterAll(() => ctx.close());

describe("ws", () => {
  it("非法 token 拒绝连接", async () => {
    await expect(connect("bad-token")).rejects.toThrow();
  });

  it("发送消息广播给会话成员并持久化", async () => {
    const a = await connect(issueToken(aliceId));
    const b = await connect(issueToken(bobId));
    const bWait = nextEvent(b);
    a.send(JSON.stringify({ type: "send_message", conversationId: convId, payload: { text: "你好 bob" } }));
    const event = await bWait;
    expect(event.type).toBe("message_new");
    if (event.type === "message_new") {
      expect(event.message.payload.text).toBe("你好 bob");
      expect(event.message.senderId).toBe(aliceId);
    }
    expect(store.listMessages(convId)).toHaveLength(1);
    a.close();
    b.close();
  });

  it("非成员发送被拒且不入库", async () => {
    const stranger = store.createUser("eve", "h", "夏娃");
    const s = await connect(issueToken(stranger.id));
    const wait = nextEvent(s);
    s.send(JSON.stringify({ type: "send_message", conversationId: convId, payload: { text: "x" } }));
    const event = await wait;
    expect(event.type).toBe("error");
    s.close();
    expect(store.listMessages(convId)).toHaveLength(1);
  });

  it("非法事件回 error", async () => {
    const a = await connect(issueToken(aliceId));
    const wait = nextEvent(a);
    a.send(JSON.stringify({ type: "boom" }));
    const event = await wait;
    expect(event.type).toBe("error");
    if (event.type === "error") expect(event.code).toBe("bad_event");
    a.close();
  });

  it("mark_read 广播 read_update", async () => {
    const a = await connect(issueToken(aliceId));
    const b = await connect(issueToken(bobId));
    const bWait = nextEvent(b);
    a.send(JSON.stringify({ type: "mark_read", conversationId: convId }));
    const event = await bWait;
    expect(event.type).toBe("read_update");
    a.close();
    b.close();
  });
});
