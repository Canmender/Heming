import { describe, it, expect, beforeAll, afterAll } from "vitest";
import net from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import type { Store } from "./store.js";
import { startServer } from "./index.js";
import { issueToken } from "./auth.js";
import type { WsServerEvent } from "@heming/shared";

let ctx: Awaited<ReturnType<typeof startServer>>;
let store: Store;
let aliceId: string;
let bobId: string;
let convId: string;
let agentId: string;
let dbDir: string;
let aliceToken: string;
let bobToken: string;

function connect(token: string, port?: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port ?? ctx.port}/api/ws?token=${token}`);
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

function connectWithoutToken(port?: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port ?? ctx.port}/api/ws`);
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

function waitClose(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) {
      resolve();
      return;
    }
    ws.once("close", () => resolve());
  });
}

function nextEvent(ws: WebSocket): Promise<WsServerEvent> {
  return new Promise((resolve, reject) => {
    ws.once("message", (data) => resolve(JSON.parse(data.toString())));
    ws.once("error", reject);
  });
}

/** 等服务端关闭连接前把已到的 error 帧取回来（鉴权失败路径）。 */
async function nextEventBeforeClose(ws: WebSocket): Promise<WsServerEvent> {
  return new Promise((resolve, reject) => {
    ws.once("message", (data) => resolve(JSON.parse(data.toString())));
    ws.once("error", reject);
  });
}

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
  aliceToken = issueToken(store, aliceId);
  bobToken = issueToken(store, bobId);
  const agent = store.createAgent(aliceId, { name: "助手", description: "" });
  agentId = agent.id;
  convId = store.createAgentConversation(aliceId, agent.id).id;
});

afterAll(async () => {
  await ctx.close();
  rmSync(dbDir, { recursive: true, force: true });
});

describe("ws 基础与人类 IM 删除", () => {
  it("query token 连接可用（旧客户端路径）", async () => {
    const ws = await connect(aliceToken);
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  it("发送消息广播给本人并持久化", async () => {
    const ws = await connect(aliceToken);
    const ev = nextEvent(ws);
    ws.send(
      JSON.stringify({
        type: "send_message",
        conversationId: convId,
        payload: { text: "你好" },
      }),
    );
    const msg = await ev;
    expect(msg.type).toBe("message_new");
    if (msg.type === "message_new") expect(msg.message.payload.text).toBe("你好");
    expect(store.listMessages(convId).at(-1)?.payload.text).toBe("你好");
    ws.close();
  });

  it("非成员发送被拒且不入库", async () => {
    const ws = await connect(bobToken);
    const ev = nextEvent(ws);
    ws.send(JSON.stringify({ type: "send_message", conversationId: convId, payload: { text: "混进来" } }));
    const res = await ev;
    expect(res).toMatchObject({ type: "error", code: "forbidden" });
    expect(store.listMessages(convId).every((m) => m.payload.text !== "混进来")).toBe(true);
    ws.close();
  });

  it("mark_read / typing / recall_message / 语音等已删除事件一律拒收且不广播", async () => {
    const ws = await connect(aliceToken);
    for (const event of [
      { type: "mark_read", conversationId: convId },
      { type: "typing", conversationId: convId },
      { type: "recall_message", conversationId: convId, messageId: "m" },
      { type: "voice_call_invite", conversationId: convId, callId: "c", sdp: "s" },
    ]) {
      const ev = nextEvent(ws);
      ws.send(JSON.stringify(event));
      const res = await ev;
      expect(res).toMatchObject({ type: "error", code: "bad_event" });
    }
    ws.close();
  });

  it("e2e send_message：只见信封直接入库并广播（payload 占位）", async () => {
    const ws = await connect(aliceToken);
    const ev = nextEvent(ws);
    ws.send(
      JSON.stringify({
        type: "send_message",
        conversationId: convId,
        payload: { text: "" },
        enc: "e2e",
        cipher: "Q2lwaGVy",
        chainKid: "kid1",
        n: 7,
      }),
    );
    const res = await ev;
    expect(res.type).toBe("message_new");
    if (res.type === "message_new") {
      expect(res.message).toMatchObject({ enc: "e2e", cipher: "Q2lwaGVy", chainKid: "kid1", n: 7 });
      expect(res.message.payload).toEqual({ text: "" });
    }
    ws.close();
  });

  it("e2e 缺 cipher / plain 夹带 cipher 均拒（bad_event）", async () => {
    const ws = await connect(aliceToken);
    let ev = nextEvent(ws);
    ws.send(JSON.stringify({ type: "send_message", conversationId: convId, payload: { text: "" }, enc: "e2e" }));
    expect(await ev).toMatchObject({ type: "error", code: "bad_event" });
    ev = nextEvent(ws);
    ws.send(
      JSON.stringify({
        type: "send_message",
        conversationId: convId,
        payload: { text: "x" },
        enc: "plain",
        cipher: "Q2lwaGVy",
      }),
    );
    expect(await ev).toMatchObject({ type: "error", code: "bad_event" });
    ws.close();
  });

  it("附件随明文消息原样入库并广播", async () => {
    const ws = await connect(aliceToken);
    const ev = nextEvent(ws);
    const file = { id: "f1", name: "a.txt", mime: "text/plain", size: 2 };
    ws.send(JSON.stringify({ type: "send_message", conversationId: convId, payload: { text: "", file } }));
    const res = await ev;
    expect(res.type).toBe("message_new");
    if (res.type === "message_new") expect(res.message.payload.file).toEqual(file);
    ws.close();
  });
});

describe("agent 流式", () => {
  it("chunk 广播不入库；finish 入库并带 streamId", async () => {
    const ws = await connect(aliceToken);
    const chunkEv = nextEvent(ws);
    ws.send(
      JSON.stringify({
        type: "agent_chunk",
        conversationId: convId,
        agentId,
        streamId: "s1",
        text: "半句",
      }),
    );
    expect(await chunkEv).toEqual({
      type: "agent_chunk",
      conversationId: convId,
      agentId,
      streamId: "s1",
      text: "半句",
    });
    expect(store.listMessages(convId).every((m) => m.payload.text !== "半句")).toBe(true);

    const finishEv = nextEvent(ws);
    ws.send(
      JSON.stringify({
        type: "agent_finish",
        conversationId: convId,
        agentId,
        streamId: "s1",
        text: "完整回复",
      }),
    );
    const fin = await finishEv;
    expect(fin).toMatchObject({ type: "message_new", streamId: "s1" });
    if (fin.type === "message_new") expect(fin.message.payload.text).toBe("完整回复");
    ws.close();
  });

  it("agentId 与会话助手不符时 finish 被拒且不入库", async () => {
    const ws = await connect(aliceToken);
    const ev = nextEvent(ws);
    ws.send(
      JSON.stringify({
        type: "agent_finish",
        conversationId: convId,
        agentId: "other-agent",
        streamId: "s2",
        text: "冒名",
      }),
    );
    expect(await ev).toMatchObject({ type: "agent_error", code: "forbidden" });
    expect(store.listMessages(convId).every((m) => m.payload.text !== "冒名")).toBe(true);
    ws.close();
  });

  it("非成员 chunk 被拒；空 finish 被拒", async () => {
    const stranger = await connect(bobToken);
    let ev = nextEvent(stranger);
    stranger.send(
      JSON.stringify({ type: "agent_chunk", conversationId: convId, agentId, streamId: "s3", text: "x" }),
    );
    expect(await ev).toMatchObject({ type: "agent_error", code: "forbidden" });
    stranger.close();

    const ws = await connect(aliceToken);
    ev = nextEvent(ws);
    ws.send(
      JSON.stringify({ type: "agent_finish", conversationId: convId, agentId, streamId: "s4", text: "   " }),
    );
    expect(await ev).toMatchObject({ type: "agent_error", code: "bad_event" });
    ws.close();
  });

  it("密文 chunk 透传 cipher/chainKid/n/index，不入库", async () => {
    const ws = await connect(aliceToken);
    const ev = nextEvent(ws);
    ws.send(
      JSON.stringify({
        type: "agent_chunk",
        conversationId: convId,
        agentId,
        streamId: "s5",
        text: "",
        cipher: "Q2h1bms=",
        chainKid: "kid1",
        n: 1,
        index: 0,
      }),
    );
    expect(await ev).toMatchObject({
      type: "agent_chunk",
      cipher: "Q2h1bms=",
      chainKid: "kid1",
      n: 1,
      index: 0,
      text: "",
    });
    ws.close();
  });
});

describe("WS 鉴权", () => {
  it("首帧 auth 成功后业务事件正常", async () => {
    const ws = await connectWithoutToken();
    ws.send(JSON.stringify({ type: "auth", token: aliceToken }));
    // 鉴权成功本身不回执；发一条业务事件确认已登记
    const ev = nextEvent(ws);
    ws.send(JSON.stringify({ type: "send_message", conversationId: convId, payload: { text: "鉴权后" } }));
    expect((await ev).type).toBe("message_new");
    ws.close();
  });

  it("auth 失败 → error(unauthorized) 且连接关闭", async () => {
    const ws = await connectWithoutToken();
    const ev = nextEventBeforeClose(ws);
    ws.send(JSON.stringify({ type: "auth", token: "bad-token" }));
    expect(await ev).toMatchObject({ type: "error", code: "unauthorized" });
    await waitClose(ws);
  });

  it("未鉴权发业务事件 → 连接被关闭且不广播", async () => {
    const ws = await connectWithoutToken();
    const ev = nextEventBeforeClose(ws);
    ws.send(JSON.stringify({ type: "send_message", conversationId: convId, payload: { text: "未鉴权" } }));
    expect(await ev).toMatchObject({ type: "error", code: "unauthorized" });
    await waitClose(ws);
    expect(store.listMessages(convId).every((m) => m.payload.text !== "未鉴权")).toBe(true);
  });

  it("协议错误帧不崩溃 server，后续连接仍可用", async () => {
    const socket = await rawUpgrade(ctx.port, aliceToken);
    socket.write("this is not a websocket frame");
    socket.destroy();
    const ws = await connect(aliceToken);
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });
});

describe("团队在线状态", () => {
  it("WS 连接登记在线，最后一个连接断开后下线", async () => {
    // 独立用户：其他用例的 socket 关闭是异步的，混用 alice 会让在线计数不确定。
    const carol = store.createUser("carol", "h", "卡萝");
    const carolToken = issueToken(store, carol.id);
    const readTeam = async () => {
      const res = await fetch(`http://127.0.0.1:${ctx.port}/api/team`, {
        headers: { Authorization: `Bearer ${carolToken}` },
      });
      return (await res.json()) as { members: { user: { id: string }; online: boolean }[]; onlineCount: number };
    };
    const ws1 = await connect(carolToken);
    const ws2 = await connect(carolToken);
    let team = await readTeam();
    expect(team.members.find((m) => m.user.id === carol.id)?.online).toBe(true);

    ws1.close();
    await waitClose(ws1);
    team = await readTeam();
    expect(team.members.find((m) => m.user.id === carol.id)?.online).toBe(true); // 还有一条连接
    ws2.close();
    await waitClose(ws2);
    // close 事件在服务端异步处理，轮询等待
    for (let i = 0; i < 40; i++) {
      team = await readTeam();
      if (!team.members.find((m) => m.user.id === carol.id)?.online) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(team.members.find((m) => m.user.id === carol.id)?.online).toBe(false);
  });
});
