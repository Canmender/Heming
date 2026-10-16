import { describe, it, expect, beforeAll, afterAll } from "vitest";
import net from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { createMemoryStore, Store } from "./store.js";
import { startServer } from "./index.js";
import { issueToken } from "./auth.js";
import { seedPreset } from "./preset.js";
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
    // F5（L3 内容契约）：read_update 携带会话与读用户
    if (event.type === "read_update") {
      expect(event.conversationId).toBe(convId);
      expect(event.userId).toBe(aliceId);
    }
    a.close();
    b.close();
  });

  it("mark_read 持久化：广播后 REST reads 可见", async () => {
    const a = store.createUser(`alice-${Date.now()}`, "h", "A");
    const b = store.createUser(`bob-${Date.now()}`, "h", "B");
    store.acceptFriendRequest(store.createFriendRequest(a.id, b.username).id, b.id);
    const conv = store.createDirectConversation(a.id, b.id);
    const wsA = await connect(issueToken(a.id));
    const wsB = await connect(issueToken(b.id));
    const wait = nextEvent(wsB);
    wsA.send(JSON.stringify({ type: "mark_read", conversationId: conv.id }));
    const ev = await wait;
    expect(ev.type).toBe("read_update");
    // F5（L3 内容契约）：read_update 携带会话与读用户
    if (ev.type === "read_update") {
      expect(ev.conversationId).toBe(conv.id);
      expect(ev.userId).toBe(a.id);
    }
    expect(store.listReads(conv.id).some((r) => r.userId === a.id)).toBe(true);
    wsA.close();
    wsB.close();
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

describe("agent streaming", () => {
  it("chunk 转发不入库；finish 入库并带 streamId 的 message_new", async () => {
    // 修正版首用例（brief）：先建两个用户再 seedPreset，使其自动入预设群（system-assistant 已挂）。
    const a = store.createUser(`aa-${Date.now()}`, "h", "A");
    const b = store.createUser(`bb-${Date.now()}`, "h", "B");
    const seed = seedPreset(store);
    if (!seed) throw new Error("seed failed");
    const g = { id: seed.groupId };
    const wsA = await connect(issueToken(a.id));
    const wsB = await connect(issueToken(b.id));

    const chunkWait = nextEvent(wsB);
    wsA.send(JSON.stringify({ type: "agent_chunk", conversationId: g.id, agentId: "system-assistant", streamId: "s1", text: "你" }));
    const chunkEv = await chunkWait;
    expect(chunkEv.type).toBe("agent_chunk");
    expect(store.listMessages(g.id)).toHaveLength(0);

    const finishWait = nextEvent(wsB);
    wsA.send(JSON.stringify({ type: "agent_finish", conversationId: g.id, agentId: "system-assistant", streamId: "s1", text: "你好，我是和小鸣" }));
    const finishEv = await finishWait;
    expect(finishEv.type).toBe("message_new");
    if (finishEv.type === "message_new") {
      expect(finishEv.streamId).toBe("s1");
      expect(finishEv.message.senderType).toBe("agent");
      expect(finishEv.message.senderId).toBe("system-assistant");
    }
    const msgs = store.listMessages(g.id);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].payload.text).toBe("你好，我是和小鸣");
    wsA.close(); wsB.close();
  });

  it("agent 不在群内时 finish 被拒且不入库", async () => {
    const a = store.createUser(`ac-${Date.now()}`, "h", "A");
    const g2 = store.createGroup(a.id, "孤群", []);
    const wsA = await connect(issueToken(a.id));
    const wait = nextEvent(wsA);
    wsA.send(JSON.stringify({ type: "agent_finish", conversationId: g2.id, agentId: "not-in-group-agent", streamId: "s2", text: "x" }));
    const ev = await wait;
    expect(ev.type).toBe("agent_error");
    if (ev.type === "agent_error") expect(ev.code).toBe("forbidden");
    expect(store.listMessages(g2.id)).toHaveLength(0);
    wsA.close();
  });

  it("非成员 chunk 被拒", async () => {
    const a = store.createUser(`ad-${Date.now()}`, "h", "A");
    const c = store.createUser(`ae-${Date.now()}`, "h", "C");
    const g3 = store.createGroup(a.id, "外群", []);
    const wsC = await connect(issueToken(c.id));
    const wait = nextEvent(wsC);
    wsC.send(JSON.stringify({ type: "agent_chunk", conversationId: g3.id, agentId: "system-assistant", streamId: "s3", text: "x" }));
    const ev = await wait;
    expect(ev.type).toBe("agent_error");
    wsC.close();
  });

  it("agent_error 成员广播不入库；非成员被拒回 forbidden", async () => {
    // 设计 §3「双向广播」：触发端流失败时把 agent_error 广播给会话全员（不入库）。
    // shared 的 WsClientEventSchema 暂未含该客户端类型（Task 1 遗漏），服务端按
    // 服务端同形状 schema 直通校验——此用例锁广播与非成员拒绝行为。
    const a = store.createUser(`af-${Date.now()}`, "h", "A");
    const g4 = store.createGroup(a.id, "错群", []);
    const wsA = await connect(issueToken(a.id));
    const wait = nextEvent(wsA);
    wsA.send(JSON.stringify({ type: "agent_error", conversationId: g4.id, agentId: "system-assistant", streamId: "s4", code: "provider_error", message: "401" }));
    const ev = await wait;
    expect(ev.type).toBe("agent_error");
    if (ev.type === "agent_error") {
      expect(ev.code).toBe("provider_error");
      expect(ev.streamId).toBe("s4");
    }
    expect(store.listMessages(g4.id)).toHaveLength(0);
    wsA.close();

    const c = store.createUser(`ag-${Date.now()}`, "h", "C");
    const wsC = await connect(issueToken(c.id));
    const wait2 = nextEvent(wsC);
    wsC.send(JSON.stringify({ type: "agent_error", conversationId: g4.id, agentId: "system-assistant", streamId: "s5", code: "aborted", message: "x" }));
    const ev2 = await wait2;
    expect(ev2.type).toBe("agent_error");
    if (ev2.type === "agent_error") expect(ev2.code).toBe("forbidden");
    expect(store.listMessages(g4.id)).toHaveLength(0);
    wsC.close();
  });

  it("agent_finish 空文本被拒（bad_event）不入库", async () => {
    // F2：shared 的 finish text 保持宽松入站（无 min），服务端对 trim 空串拒收。
    const a = store.createUser(`aj-${Date.now()}`, "h", "A");
    const g5 = store.createGroup(a.id, "空群", []);
    const wsA = await connect(issueToken(a.id));
    const wait = nextEvent(wsA);
    wsA.send(JSON.stringify({ type: "agent_finish", conversationId: g5.id, agentId: "system-assistant", streamId: "s6", text: "   " }));
    const ev = await wait;
    expect(ev.type).toBe("agent_error");
    if (ev.type === "agent_error") {
      expect(ev.code).toBe("bad_event");
      expect(ev.message).toBe("empty text");
    }
    expect(store.listMessages(g5.id)).toHaveLength(0);
    wsA.close();
  });

  it("agent_finish 文本超 20000 被 shared schema 拒（bad_event）不入库", async () => {
    // I4：finish.text 上限与 MessagePayloadSchema.text 对齐（防「schema 过了、入库即违规」）
    const a = store.createUser(`ak-${Date.now()}`, "h", "A");
    const g6 = store.createGroup(a.id, "超长群", []);
    const wsA = await connect(issueToken(a.id));
    const wait = nextEvent(wsA);
    wsA.send(JSON.stringify({
      type: "agent_finish",
      conversationId: g6.id,
      agentId: "system-assistant",
      streamId: "s7",
      text: "x".repeat(20001),
    }));
    const ev = await wait;
    expect(ev.type).toBe("error");
    if (ev.type === "error") expect(ev.code).toBe("bad_event");
    expect(store.listMessages(g6.id)).toHaveLength(0);
    wsA.close();
  });

  it("send_message 携带 mentions 落库并随 message_new 广播（无 streamId）", async () => {
    // Task 1 concern#2/#3：payload.mentions 往返契约 + send_message 广播不带 streamId。
    const a = store.createUser(`ah-${Date.now()}`, "h", "A");
    const b = store.createUser(`ai-${Date.now()}`, "h", "B");
    store.acceptFriendRequest(store.createFriendRequest(a.id, b.username).id, b.id);
    const conv = store.createDirectConversation(a.id, b.id).id;
    const wsA = await connect(issueToken(a.id));
    const wsB = await connect(issueToken(b.id));
    const wait = nextEvent(wsB);
    wsA.send(JSON.stringify({
      type: "send_message",
      conversationId: conv,
      payload: { text: "@和小鸣 看下", mentions: [{ agentId: "system-assistant", name: "和小鸣" }] },
    }));
    const ev = await wait;
    expect(ev.type).toBe("message_new");
    if (ev.type === "message_new") {
      expect(ev.message.payload.mentions).toEqual([{ agentId: "system-assistant", name: "和小鸣" }]);
      expect(ev.streamId).toBeUndefined();
    }
    const msgs = store.listMessages(conv);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].payload.mentions).toEqual([{ agentId: "system-assistant", name: "和小鸣" }]);
    wsA.close();
    wsB.close();
  });

  it("send_message 携带 file 原样入库并广播（text 空串纯附件）", async () => {
    // UI 完善 Task 1：payload.file 往返契约，text 为空串（纯附件消息）也能过 shared schema 并落库。
    const a = store.createUser(`am-${Date.now()}`, "h", "A");
    const b = store.createUser(`an-${Date.now()}`, "h", "B");
    store.acceptFriendRequest(store.createFriendRequest(a.id, b.username).id, b.id);
    const conv = store.createDirectConversation(a.id, b.id).id;
    const wsA = await connect(issueToken(a.id));
    const wsB = await connect(issueToken(b.id));
    const wait = nextEvent(wsB);
    wsA.send(JSON.stringify({
      type: "send_message",
      conversationId: conv,
      payload: { text: "", file: { id: "f1", name: "a.png", mime: "image/png", size: 3 } },
    }));
    const ev = await wait;
    expect(ev.type).toBe("message_new");
    if (ev.type === "message_new") {
      expect(ev.message.payload.text).toBe("");
      expect(ev.message.payload.file).toEqual({ id: "f1", name: "a.png", mime: "image/png", size: 3 });
    }
    const msgs = store.listMessages(conv);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].payload.text).toBe("");
    expect(msgs[0].payload.file).toEqual({ id: "f1", name: "a.png", mime: "image/png", size: 3 });
    wsA.close();
    wsB.close();
  });
});
