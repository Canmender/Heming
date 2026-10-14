import { describe, it, expect, beforeAll, afterAll } from "vitest";
import net from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
let groupId: string;
// 独占临时库：默认 ./data/heming.db 会跨文件并行锁冲突、跨次运行 alice 撞 UNIQUE（"username taken"）。
let dbDir: string;

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

/** 用裸 TCP 完成合法 WS 升级握手（绕过 ws 客户端，以便随后发送非法协议帧）。 */
function rawUpgrade(port: number, token: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => {
      socket.write(
        [
          `GET /api/ws?token=${token} HTTP/1.1`,
          `Host: 127.0.0.1:${port}`,
          "Upgrade: websocket",
          "Connection: Upgrade",
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
          "Sec-WebSocket-Version: 13",
          "",
          "",
        ].join("\r\n"),
      );
    });
    let buf = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      const headerEnd = buf.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      socket.off("data", onData);
      if (buf.subarray(0, headerEnd).toString().startsWith("HTTP/1.1 101")) {
        resolve(socket);
      } else {
        socket.destroy();
        reject(new Error("upgrade rejected"));
      }
    };
    socket.on("data", onData);
    // 握手失败时 reject；握手成功后服务端按协议关闭导致的 RST 等也一并吞掉，避免测试进程未处理 error。
    socket.on("error", () => {
      reject(new Error("socket error during handshake"));
    });
  });
}

beforeAll(async () => {
  dbDir = mkdtempSync(join(tmpdir(), "heming-ws-"));
  ctx = await startServer(0, undefined, join(dbDir, "t.db"));
  store = ctx.store;
  const alice = store.createUser("alice", "h", "爱丽丝");
  const bob = store.createUser("bob", "h", "鲍勃");
  aliceId = alice.id;
  bobId = bob.id;
  store.acceptFriendRequest(store.createFriendRequest(aliceId, "bob").id, bobId);
  convId = store.createDirectConversation(aliceId, bobId).id;
  groupId = store.createGroup(aliceId, "评审组", [bobId]).id;
});

afterAll(async () => {
  await ctx.close();
  rmSync(dbDir, { recursive: true, force: true });
});

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

  it("群聊：成员发送广播给其他成员并持久化", async () => {
    const a = await connect(issueToken(aliceId));
    const b = await connect(issueToken(bobId));
    const bWait = nextEvent(b);
    a.send(JSON.stringify({ type: "send_message", conversationId: groupId, payload: { text: "群消息" } }));
    const event = await bWait;
    expect(event.type).toBe("message_new");
    if (event.type === "message_new") {
      expect(event.message.conversationId).toBe(groupId);
      expect(event.message.payload.text).toBe("群消息");
      expect(event.message.senderId).toBe(aliceId);
    }
    expect(store.listMessages(groupId)).toHaveLength(1);
    a.close();
    b.close();
  });

  it("群聊：非成员发送收 forbidden 且不入库", async () => {
    const stranger = store.createUser("carol", "h", "卡罗尔");
    const s = await connect(issueToken(stranger.id));
    const wait = nextEvent(s);
    s.send(JSON.stringify({ type: "send_message", conversationId: groupId, payload: { text: "x" } }));
    const event = await wait;
    expect(event.type).toBe("error");
    if (event.type === "error") expect(event.code).toBe("forbidden");
    s.close();
    expect(store.listMessages(groupId)).toHaveLength(1);
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

  it("协议错误帧不崩溃 server，后续连接仍可用", async () => {
    const raw = await rawUpgrade(ctx.port, issueToken(aliceId));
    // 0xC1 0x00 = FIN + RSV1 + opcode text、无 mask：无 permessage-deflate 协商时
    // 服务端 receiver 抛 ProtocolError → WebSocket 'error'（无监听器则进程级未捕获异常）。
    raw.write(Buffer.from([0xc1, 0x00]));
    raw.destroy();
    // 断言 server 未崩溃：正常客户端仍可完成一轮广播回环。
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
