import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
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

function connect(token: string, port?: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port ?? ctx.port}/api/ws?token=${token}`);
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

  it("recall_message：非发送者被拒（无广播），本人撤回广播 message_recalled", async () => {
    const a = store.createUser(`rl-a-${Date.now()}`, "h", "甲");
    const b = store.createUser(`rl-b-${Date.now()}`, "h", "乙");
    store.acceptFriendRequest(store.createFriendRequest(a.id, b.username).id, b.id);
    const conv = store.createDirectConversation(a.id, b.id);
    const m = store.addMessage(conv.id, "user", a.id, { text: "撤我" }, null);
    const wsA = await connect(issueToken(a.id));
    const wsB = await connect(issueToken(b.id));

    // b 撤 a 的消息 → 错误帧回给发起者 b（forbidden），且不落库、不广播
    const aSilent = nextEvent(wsA).then(() => "got" as const);
    const bErr = nextEvent(wsB);
    wsB.send(JSON.stringify({ type: "recall_message", conversationId: conv.id, messageId: m.id }));
    const errEv = await bErr;
    expect(errEv.type).toBe("error");
    if (errEv.type === "error") expect(errEv.code).toBe("forbidden");
    expect(store.listMessages(conv.id)[0].recalledAt).toBeNull(); // 未持久化
    // a 未收到任何广播帧（message_recalled 不出现）
    const raced = await Promise.race([
      aSilent,
      new Promise((r) => setTimeout(() => r("none" as const), 100)),
    ]);
    expect(raced).toBe("none");

    // a 撤回自己的消息 → b 收到 message_recalled（messageId/会话匹配）
    const bWait = nextEvent(wsB);
    wsA.send(JSON.stringify({ type: "recall_message", conversationId: conv.id, messageId: m.id }));
    const ev = await bWait;
    expect(ev.type).toBe("message_recalled");
    if (ev.type === "message_recalled") {
      expect(ev.conversationId).toBe(conv.id);
      expect(ev.messageId).toBe(m.id);
      expect(ev.at).toBeTruthy();
    }
    expect(store.listMessages(conv.id)[0].recalledAt).not.toBeNull();
    wsA.close();
    wsB.close();
  });

  it("react_message 已废（E2E Task 2）：事件拒收 bad_event，不入库、不广播、不误触 mark_read", async () => {
    // 设计 §4：表情回应改为 kind=reaction 的 e2e 信封消息（按普通 send_message 入库），
    // react_message 客户端事件从 shared 契约移除 → parse 失败回 bad_event。
    const a = store.createUser(`rx-a-${Date.now()}`, "h", "甲");
    const b = store.createUser(`rx-b-${Date.now()}`, "h", "乙");
    store.acceptFriendRequest(store.createFriendRequest(a.id, b.username).id, b.id);
    const conv = store.createDirectConversation(a.id, b.id);
    const m = store.addMessage(conv.id, "user", a.id, { text: "求回应" }, null);
    const wsA = await connect(issueToken(a.id));
    const wsB = await connect(issueToken(b.id));

    const aErr = nextEvent(wsA);
    // 用**真实**消息 id：若服务端仍按旧 toggle 处理会改 payload 并广播——以下断言即红
    wsA.send(JSON.stringify({ type: "react_message", conversationId: conv.id, messageId: m.id, emoji: "👍" }));
    const ev = await aErr;
    expect(ev.type).toBe("error");
    if (ev.type === "error") expect(ev.code).toBe("bad_event");
    // 不入库（reactions 无落点）
    expect(store.listMessages(conv.id)[0].payload.reactions).toBeUndefined();
    // 对端静默：既无任何广播，也未落入 mark_read 兜底广播 read_update
    const raced = await Promise.race([
      nextEvent(wsB).then(() => "got" as const),
      new Promise((r) => setTimeout(() => r("none" as const), 100)),
    ]);
    expect(raced).toBe("none");
    expect(store.listReads(conv.id)).toHaveLength(0); // mark_read 未被误执行

    wsA.close();
    wsB.close();
  });

  it("enc=e2e send_message：跳过内容校验直接信封入库并广播（服务端不落 payload/replyTo）", async () => {
    const a = store.createUser(`e2-a-${Date.now()}`, "h", "甲");
    const b = store.createUser(`e2-b-${Date.now()}`, "h", "乙");
    store.acceptFriendRequest(store.createFriendRequest(a.id, b.username).id, b.id);
    const conv = store.createDirectConversation(a.id, b.id).id;
    const wsA = await connect(issueToken(a.id));
    const wsB = await connect(issueToken(b.id));

    const wait = nextEvent(wsB);
    wsA.send(
      JSON.stringify({
        type: "send_message",
        conversationId: conv,
        // 明文字段故意带内容与 replyTo：e2e 路径不读不落（内容与回复指向只进密文）
        payload: { text: "服务端不该存我" },
        replyTo: "reply-target-should-stay-in-cipher",
        enc: "e2e",
        cipher: "Q2lwaGVyZGF0YQ==",
        chainKid: "kid1",
        n: 3,
      }),
    );
    const ev = await wait;
    expect(ev.type).toBe("message_new");
    if (ev.type === "message_new") {
      expect(ev.message.enc).toBe("e2e");
      expect(ev.message.cipher).toBe("Q2lwaGVyZGF0YQ==");
      expect(ev.message.chainKid).toBe("kid1");
      expect(ev.message.n).toBe(3);
      expect(ev.message.payload.text).toBe(""); // 服务端只见信封
      expect(ev.message.replyTo).toBeNull();
      expect(ev.message.senderId).toBe(a.id);
    }
    const stored = store.listMessages(conv);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      enc: "e2e",
      cipher: "Q2lwaGVyZGF0YQ==",
      chainKid: "kid1",
      n: 3,
      replyTo: null,
    });
    expect(stored[0].payload.text).toBe("");
    wsA.close();
    wsB.close();
  });

  it("e2e 缺 cipher / 空 cipher 与 plain 夹带 cipher 均拒（bad_event）不入库", async () => {
    const a = store.createUser(`e2-c-${Date.now()}`, "h", "甲");
    const conv = store.createGroup(a.id, "信封校验群", []).id;
    const wsA = await connect(issueToken(a.id));
    const cases: Array<Record<string, unknown>> = [
      { enc: "e2e" }, // 缺 cipher
      { enc: "e2e", cipher: "" }, // 空 cipher
      { cipher: "Q2lwaGVy" }, // 缺 enc 默认 plain + 夹 cipher
      { enc: "plain", cipher: "Q2lwaGVy" }, // 显式 plain + cipher
    ];
    for (const extra of cases) {
      const wait = nextEvent(wsA);
      wsA.send(JSON.stringify({ type: "send_message", conversationId: conv, payload: { text: "x" }, ...extra }));
      const ev = await wait;
      expect(ev.type).toBe("error");
      if (ev.type === "error") expect(ev.code).toBe("bad_event");
    }
    expect(store.listMessages(conv)).toHaveLength(0);
    wsA.close();
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

  // —— 语音通话信令（Task 2）——

  it("voice_call_invite 定向投递给 peer（非全群广播）", async () => {
    const a = await connect(issueToken(aliceId));
    const b = await connect(issueToken(bobId));
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
    a.close();
    b.close();
  });

  it("voice_call_accept 定向投递给 initiator", async () => {
    const a = await connect(issueToken(aliceId));
    const b = await connect(issueToken(bobId));
    // 先 invite 建立通话状态
    const bInviteWait = nextEvent(b);
    a.send(JSON.stringify({
      type: "voice_call_invite",
      conversationId: convId,
      callId: "call-test-3",
      sdp: "v=0\r\no=- 1 2 IN IP4 0.0.0.0",
    }));
    await bInviteWait;
    // b accept → a 收到 accept
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
    // 先 invite 建立通话状态
    const bInviteWait = nextEvent(b);
    a.send(JSON.stringify({
      type: "voice_call_invite",
      conversationId: convId,
      callId: "call-test-4",
      sdp: "v=0\r\no=- 1 2 IN IP4 0.0.0.0",
    }));
    await bInviteWait;
    // a hangup → b 收到 hangup
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
    // 先 invite 建立通话状态
    const bInviteWait = nextEvent(b);
    a.send(JSON.stringify({
      type: "voice_call_invite",
      conversationId: convId,
      callId: "call-test-5",
      sdp: "v=0\r\no=- 1 2 IN IP4 0.0.0.0",
    }));
    await bInviteWait;
    // a ice → b 收到 ice
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

  it("voice_call_reconnect 定向转发给其他参与者并补 fromUserId，call 状态不受影响", async () => {
    const a = await connect(issueToken(aliceId));
    const b = await connect(issueToken(bobId));
    const bInviteWait = nextEvent(b);
    a.send(JSON.stringify({
      type: "voice_call_invite",
      conversationId: convId,
      callId: "call-test-reconnect",
      sdp: "v=0\r\no=- 1 2 IN IP4 0.0.0.0",
    }));
    await bInviteWait;
    // b 的 ICE 断了 → 重启后把新 offer 转给 a
    const aWait = nextEvent(a);
    b.send(JSON.stringify({
      type: "voice_call_reconnect",
      conversationId: convId,
      callId: "call-test-reconnect",
      sdp: "v=0 restart-offer",
      sdpType: "offer",
    }));
    const event = await aWait;
    expect(event.type).toBe("voice_call_reconnect");
    if (event.type === "voice_call_reconnect") {
      expect(event.callId).toBe("call-test-reconnect");
      expect(event.sdp).toBe("v=0 restart-offer");
      expect(event.sdpType).toBe("offer");
      expect(event.fromUserId).toBe(bobId);
    }
    // a 回 answer 给 b
    const bWait = nextEvent(b);
    a.send(JSON.stringify({
      type: "voice_call_reconnect",
      conversationId: convId,
      callId: "call-test-reconnect",
      sdp: "v=0 restart-answer",
      sdpType: "answer",
    }));
    const back = await bWait;
    expect(back.type).toBe("voice_call_reconnect");
    if (back.type === "voice_call_reconnect") {
      expect(back.sdpType).toBe("answer");
      expect(back.fromUserId).toBe(aliceId);
    }
    // 重连后照常 hangup 说明服务端 call 还在（重连不该把通话状态清掉）
    const hangWait = nextEvent(b);
    a.send(JSON.stringify({
      type: "voice_call_hangup",
      conversationId: convId,
      callId: "call-test-reconnect",
    }));
    expect((await hangWait).type).toBe("voice_call_hangup");
    a.close();
    b.close();
  });

  it("未知 callId 的 voice_call_reconnect 回 forbidden（不给陌生通话搭车）", async () => {
    const a = await connect(issueToken(aliceId));
    const wait = nextEvent(a);
    a.send(JSON.stringify({
      type: "voice_call_reconnect",
      conversationId: convId,
      callId: "call-nope",
      sdp: "v=0",
      sdpType: "offer",
    }));
    const event = await wait;
    expect(event.type).toBe("error");
    if (event.type === "error") expect(event.code).toBe("forbidden");
    a.close();
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

  it("voice_call_invite 定向投递带 fromUserId=发起方（Mesh 对端路由）", async () => {
    const a = await connect(issueToken(aliceId));
    const b = await connect(issueToken(bobId));
    const bWait = nextEvent(b);
    a.send(JSON.stringify({
      type: "voice_call_invite",
      conversationId: convId,
      callId: "call-from-1",
      sdp: "v=0\r\no=- 1 2 IN IP4 0.0.0.0",
    }));
    const event = await bWait;
    expect(event.type).toBe("voice_call_invite");
    if (event.type === "voice_call_invite") {
      expect(event.fromUserId).toBe(aliceId);
    }
    a.close();
    b.close();
  });

  it("voice_call_accept 定向投递带 fromUserId=接收方", async () => {
    const a = await connect(issueToken(aliceId));
    const b = await connect(issueToken(bobId));
    const bInviteWait = nextEvent(b);
    a.send(JSON.stringify({
      type: "voice_call_invite",
      conversationId: convId,
      callId: "call-from-2",
      sdp: "v=0",
    }));
    await bInviteWait;
    const aWait = nextEvent(a);
    b.send(JSON.stringify({
      type: "voice_call_accept",
      conversationId: convId,
      callId: "call-from-2",
      sdp: "v=0",
    }));
    const event = await aWait;
    expect(event.type).toBe("voice_call_accept");
    if (event.type === "voice_call_accept") {
      expect(event.fromUserId).toBe(bobId);
    }
    a.close();
    b.close();
  });

  it("voice_call_ice 定向投递带 fromUserId=发送方", async () => {
    const a = await connect(issueToken(aliceId));
    const b = await connect(issueToken(bobId));
    const bInviteWait = nextEvent(b);
    a.send(JSON.stringify({
      type: "voice_call_invite",
      conversationId: convId,
      callId: "call-from-3",
      sdp: "v=0",
    }));
    await bInviteWait;
    const bWait = nextEvent(b);
    a.send(JSON.stringify({
      type: "voice_call_ice",
      conversationId: convId,
      callId: "call-from-3",
      candidate: "candidate:1 1 udp 2130706431 1.2.3.4 9999 typ host",
    }));
    const event = await bWait;
    expect(event.type).toBe("voice_call_ice");
    if (event.type === "voice_call_ice") {
      expect(event.fromUserId).toBe(aliceId);
    }
    a.close();
    b.close();
  });

  it("群聊 voice_call_invite 投递给所有其他成员（非发起方），各带 fromUserId", async () => {
    // groupId：alice（发起方）+ bob。alice 发 invite → bob 收到且 fromUserId=alice。
    const a = await connect(issueToken(aliceId));
    const b = await connect(issueToken(bobId));
    const bWait = nextEvent(b);
    a.send(JSON.stringify({
      type: "voice_call_invite",
      conversationId: groupId,
      callId: "call-group-1",
      sdp: "v=0",
    }));
    const event = await bWait;
    expect(event.type).toBe("voice_call_invite");
    if (event.type === "voice_call_invite") {
      expect(event.conversationId).toBe(groupId);
      expect(event.fromUserId).toBe(aliceId);
    }
    a.close();
    b.close();
  });

  it("群聊 voice_call_ice 投递给其他参与者（非发起方）", async () => {
    const a = await connect(issueToken(aliceId));
    const b = await connect(issueToken(bobId));
    const bInviteWait = nextEvent(b);
    a.send(JSON.stringify({
      type: "voice_call_invite",
      conversationId: groupId,
      callId: "call-group-2",
      sdp: "v=0",
    }));
    await bInviteWait;
    const bWait = nextEvent(b);
    a.send(JSON.stringify({
      type: "voice_call_ice",
      conversationId: groupId,
      callId: "call-group-2",
      candidate: "candidate:1 1 udp 2130706431 1.2.3.4 9999 typ host",
    }));
    const event = await bWait;
    expect(event.type).toBe("voice_call_ice");
    if (event.type === "voice_call_ice") {
      expect(event.conversationId).toBe(groupId);
      expect(event.fromUserId).toBe(aliceId);
    }
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

  it("send_message 携带 forward 落库并随 message_new 广播", async () => {
    // 二期 IM Task 4：payload.forward 往返契约（同 mentions/file 透传断言模式）。
    const a = store.createUser(`ao-${Date.now()}`, "h", "A");
    const b = store.createUser(`ap-${Date.now()}`, "h", "B");
    store.acceptFriendRequest(store.createFriendRequest(a.id, b.username).id, b.id);
    const conv = store.createDirectConversation(a.id, b.id).id;
    const wsA = await connect(issueToken(a.id));
    const wsB = await connect(issueToken(b.id));
    const wait = nextEvent(wsB);
    wsA.send(JSON.stringify({
      type: "send_message",
      conversationId: conv,
      payload: {
        text: "转发的正文",
        mentions: [{ agentId: "system-assistant", name: "和小鸣" }],
        file: { id: "f1", name: "a.png", mime: "image/png", size: 3 },
        forward: { from: "爱丽丝", source: "评审组" },
      },
    }));
    const ev = await wait;
    expect(ev.type).toBe("message_new");
    if (ev.type === "message_new") {
      expect(ev.message.payload.forward).toEqual({ from: "爱丽丝", source: "评审组" });
      expect(ev.message.payload.text).toBe("转发的正文");
      expect(ev.message.payload.file).toEqual({ id: "f1", name: "a.png", mime: "image/png", size: 3 });
    }
    const msgs = store.listMessages(conv);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].payload.forward).toEqual({ from: "爱丽丝", source: "评审组" });
    wsA.close();
    wsB.close();
  });

  // —— E2E Task 4：agent 流式信封（chunk 广播透传 / finish 按信封入库）——

  it("密文 agent_chunk：广播透传 cipher/chainKid/n/index（text 空串），不入库", async () => {
    const a = store.createUser(`ch-${Date.now()}`, "h", "A");
    const b = store.createUser(`ci-${Date.now()}`, "h", "B");
    seedPreset(store); // 只为登记 system-assistant 名册元数据（预设群不复用——其消息序列跨用例污染断言）
    store.acceptFriendRequest(store.createFriendRequest(a.id, b.username).id, b.id);
    const g = store.createGroup(a.id, "密文chunk群", [b.id]);
    store.attachAgentToGroup(g.id, "system-assistant");
    const wsA = await connect(issueToken(a.id));
    const wsB = await connect(issueToken(b.id));

    const wait = nextEvent(wsB);
    wsA.send(
      JSON.stringify({
        type: "agent_chunk",
        conversationId: g.id,
        agentId: "system-assistant",
        streamId: "sc1",
        text: "",
        cipher: "Q2lwaGVyZGF0YQ==",
        chainKid: "k1",
        n: 7,
        index: 0,
      }),
    );
    const ev = await wait;
    expect(ev.type).toBe("agent_chunk");
    if (ev.type === "agent_chunk") {
      expect(ev.text).toBe("");
      expect(ev.cipher).toBe("Q2lwaGVyZGF0YQ==");
      expect(ev.chainKid).toBe("k1");
      expect(ev.n).toBe(7);
      expect(ev.index).toBe(0);
    }
    expect(store.listMessages(g.id)).toHaveLength(0); // chunk 不入库（同明文路径）
    wsA.close();
    wsB.close();
  });

  it("密文 agent_finish：text 空串过 F2 拒收，按 e2e 信封入库并广播 message_new", async () => {
    const a = store.createUser(`cj-${Date.now()}`, "h", "A");
    const b = store.createUser(`ck-${Date.now()}`, "h", "B");
    seedPreset(store);
    store.acceptFriendRequest(store.createFriendRequest(a.id, b.username).id, b.id);
    const g = store.createGroup(a.id, "密文finish群", [b.id]);
    store.attachAgentToGroup(g.id, "system-assistant");
    const wsA = await connect(issueToken(a.id));
    const wsB = await connect(issueToken(b.id));

    const wait = nextEvent(wsB);
    wsA.send(
      JSON.stringify({
        type: "agent_finish",
        conversationId: g.id,
        agentId: "system-assistant",
        streamId: "sf1",
        text: "",
        cipher: "ZmluaXNoLWNpcGhlcg==",
        chainKid: "k1",
        n: 8,
      }),
    );
    const ev = await wait;
    expect(ev.type).toBe("message_new");
    if (ev.type === "message_new") {
      expect(ev.message.enc).toBe("e2e");
      expect(ev.message.cipher).toBe("ZmluaXNoLWNpcGhlcg==");
      expect(ev.message.chainKid).toBe("k1");
      expect(ev.message.n).toBe(8);
      expect(ev.message.payload.text).toBe(""); // 服务端只见信封
      expect(ev.message.senderType).toBe("agent");
      expect(ev.streamId).toBe("sf1");
    }
    const msgs = store.listMessages(g.id);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ enc: "e2e", cipher: "ZmluaXNoLWNpcGhlcg==", payload: { text: "" } });
    wsA.close();
    wsB.close();
  });

  it("密文 agent_finish 缺 chainKid/n 与夹明文 text 均拒（bad_event）不入库", async () => {
    const a = store.createUser(`cl-${Date.now()}`, "h", "A");
    seedPreset(store);
    const g = store.createGroup(a.id, "密文finish拒收群", []);
    store.attachAgentToGroup(g.id, "system-assistant");
    const wsA = await connect(issueToken(a.id));
    const cases: Array<Record<string, unknown>> = [
      { text: "", cipher: "Qw==" }, // 缺 chainKid/n
      { text: "", cipher: "Qw==", chainKid: "k1" }, // 缺 n
      { text: "", cipher: "Qw==", n: 0 }, // 缺 chainKid
      { text: "明文", cipher: "Qw==", chainKid: "k1", n: 0 }, // 夹明文
      { text: "", cipher: "", chainKid: "k1", n: 0 }, // 空 cipher
    ];
    for (const extra of cases) {
      const wait = nextEvent(wsA);
      wsA.send(
        JSON.stringify({
          type: "agent_finish",
          conversationId: g.id,
          agentId: "system-assistant",
          streamId: "sf2",
          ...extra,
        }),
      );
      const ev = await wait;
      expect(ev.type).toBe("error");
      if (ev.type === "error") expect(ev.code).toBe("bad_event");
    }
    expect(store.listMessages(g.id)).toHaveLength(0);
    wsA.close();
  });
  it("密文 agent_error：广播透传 cipher/chainKid/n（message 空串），不入库", async () => {
    const a = store.createUser(`cm-${Date.now()}`, "h", "A");
    const b = store.createUser(`cn-${Date.now()}`, "h", "B");
    seedPreset(store);
    store.acceptFriendRequest(store.createFriendRequest(a.id, b.username).id, b.id);
    const g = store.createGroup(a.id, "密文error群", [b.id]);
    store.attachAgentToGroup(g.id, "system-assistant");
    const wsA = await connect(issueToken(a.id));
    const wsB = await connect(issueToken(b.id));

    const wait = nextEvent(wsB);
    wsA.send(
      JSON.stringify({
        type: "agent_error",
        conversationId: g.id,
        agentId: "system-assistant",
        streamId: "se1",
        code: "provider_error",
        message: "",
        cipher: "ZXJyb3ItY2lwaGVy",
        chainKid: "k1",
        n: 3,
      }),
    );
    const ev = await wait;
    expect(ev.type).toBe("agent_error");
    if (ev.type === "agent_error") {
      expect(ev.message).toBe("");
      expect(ev.cipher).toBe("ZXJyb3ItY2lwaGVy");
      expect(ev.chainKid).toBe("k1");
      expect(ev.n).toBe(3);
      expect(ev.code).toBe("provider_error"); // code 非敏感，明文保留（收端降级文案拼接用）
    }
    expect(store.listMessages(g.id)).toHaveLength(0);
    wsA.close();
    wsB.close();
  });
});


describe("voice_call 多连接清理（T2 评审修复）", () => {
  it("用户仍有其他连接时断开一个连接，不误断进行中的通话", async () => {
    // 同一用户开两条连接（多设备/多标签页）：invite 建立通话后关掉其中一条，
    // 对端不应收到 hangup（旧实现无条件 cleanupCallsForUser 会误断）。
    // 用收集器而非 nextEvent 竞态：连接关闭后可能有其他事件，只断言窗口内
    // 没有 voice_call_hangup 即可。
    const a1 = await connect(issueToken(aliceId));
    const a2 = await connect(issueToken(aliceId));
    const b = await connect(issueToken(bobId));
    const bEvents: WsServerEvent[] = [];
    b.on("message", (d) => bEvents.push(JSON.parse(d.toString())));

    const bInvite = nextEvent(b);
    a1.send(
      JSON.stringify({
        type: "voice_call_invite",
        conversationId: convId,
        callId: "call-multiconn-1",
        sdp: "v=0",
      }),
    );
    await bInvite;

    // 关掉 a1，但 a2 仍在线
    a1.close();
    await new Promise((r) => setTimeout(r, 200));

    expect(bEvents.some((e) => e.type === "voice_call_hangup")).toBe(false);
    // 通话仍在：a2 发 ice 应正常投递
    bEvents.length = 0;
    const bIce = nextEvent(b);
    a2.send(
      JSON.stringify({
        type: "voice_call_ice",
        conversationId: convId,
        callId: "call-multiconn-1",
        candidate: "candidate:1 1 udp 2130706431 1.2.3.4 9999 typ host",
      }),
    );
    expect((await bIce).type).toBe("voice_call_ice");

    a2.close();
    b.close();
  });

  it("最后一个连接断开时才补发 hangup", async () => {
    const a1 = await connect(issueToken(aliceId));
    const a2 = await connect(issueToken(aliceId));
    const b = await connect(issueToken(bobId));

    const bInvite = nextEvent(b);
    a1.send(
      JSON.stringify({
        type: "voice_call_invite",
        conversationId: convId,
        callId: "call-multiconn-2",
        sdp: "v=0",
      }),
    );
    await bInvite;

    a1.close();
    a2.close();

    // 两条都断开后，b 应收到补发的 hangup
    const bHangup = nextEvent(b);
    const event = await bHangup;
    expect(event.type).toBe("voice_call_hangup");
    if (event.type === "voice_call_hangup") {
      expect(event.callId).toBe("call-multiconn-2");
    }

    b.close();
  });
});

describe("ringing 超时兜底（C3）", () => {
  it("超时未接听的通话自动向双方补发 reject(timeout) 并清理 activeCalls", async () => {
    // 用独立 server 实例注入短超时（200ms）+ 短扫描间隔（50ms），避免 fake timers 破坏 WS 连接
    const { createServer } = await import("node:http");
    const { attachWs } = await import("./ws.js");
    const httpServer = createServer();
    attachWs(httpServer, store, { ringTimeoutMs: 200, ringSweepIntervalMs: 50 });
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const address = httpServer.address();
    const port = typeof address === "object" && address ? address.port : 0;

    const a = await connect(issueToken(aliceId), port);
    const b = await connect(issueToken(bobId), port);

    const aReject = nextEvent(a);
    const bInvite = nextEvent(b);
    a.send(
      JSON.stringify({
        type: "voice_call_invite",
        conversationId: convId,
        callId: "call-timeout-1",
        sdp: "v=0",
      }),
    );
    // 被叫先收到 invite（不清，模拟无人接听）
    await bInvite;

    // 超时后：发起方收到 reject(timeout)，被叫收到 hangup
    const bHangup = nextEvent(b);
    const aEvent = await aReject;
    expect(aEvent.type).toBe("voice_call_reject");
    if (aEvent.type === "voice_call_reject") {
      expect(aEvent.callId).toBe("call-timeout-1");
      expect(aEvent.reason).toBe("timeout");
    }
    const bEvent = await bHangup;
    expect(bEvent.type).toBe("voice_call_hangup");
    if (bEvent.type === "voice_call_hangup") {
      expect(bEvent.callId).toBe("call-timeout-1");
    }

    a.close();
    b.close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });
});
