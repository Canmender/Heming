import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { WsServerEvent } from "@heming/shared";
import { connectWs, resolveWsUrl } from "./ws.js";
import { setToken } from "./api.js";

describe("resolveWsUrl（ws 地址派生）", () => {
  it("API_BASE http → ws:// 绝对地址", () => {
    expect(resolveWsUrl("http://47.92.39.184")).toBe("ws://47.92.39.184");
  });

  it("API_BASE https → wss://", () => {
    expect(resolveWsUrl("https://h.example.com")).toBe("wss://h.example.com");
  });

  it("无 API_BASE：按页面协议/域名派生（https→wss，其余 ws）", () => {
    expect(resolveWsUrl("", { protocol: "https:", host: "app.local" })).toBe("wss://app.local");
    expect(resolveWsUrl("", { protocol: "http:", host: "localhost:5173" })).toBe(
      "ws://localhost:5173",
    );
  });

  it("无 API_BASE 且页面 host 为空（file:// 桌面页）→ 抛「未配置 VITE_API_BASE」", () => {
    expect(() => resolveWsUrl("", { protocol: "file:", host: "" })).toThrow(
      /未配置 VITE_API_BASE/,
    );
  });

  it("API_BASE 缺 http(s) 协议（如 localhost:5173 伪协议）→ 抛统一「VITE_API_BASE 配置无效」", () => {
    expect(() => resolveWsUrl("localhost:5173", { protocol: "http:", host: "x" })).toThrow(
      /VITE_API_BASE 配置无效，需形如 http:\/\/host/,
    );
  });

  it("API_BASE 为垃圾值 → 抛统一「VITE_API_BASE 配置无效」", () => {
    expect(() => resolveWsUrl("not a url", { protocol: "http:", host: "x" })).toThrow(
      /VITE_API_BASE 配置无效，需形如 http:\/\/host/,
    );
  });
});

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static OPEN = 1;
  url: string;
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
  /** 模拟服务端接受连接 */
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  /** 模拟连接被断开 */
  drop() {
    this.readyState = 3;
    this.onclose?.();
  }
}

describe("connectWs", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeWebSocket);
    setToken("t1");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    setToken(null);
  });

  it("URL 不带 token：token 走首帧，不进 query（query 会进 nginx access_log）", () => {
    connectWs({ onEvent: () => {} });
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(FakeWebSocket.instances[0].url).toContain("/api/ws");
    expect(FakeWebSocket.instances[0].url).not.toContain("token=");
  });

  it("带 token 建连；未连接时 send 入队，onopen 后**先发 auth 帧**再冲刷业务帧", () => {
    const handle = connectWs({ onEvent: () => {} });
    expect(FakeWebSocket.instances).toHaveLength(1);

    handle.send({ type: "mark_read", conversationId: "c1" });
    expect(FakeWebSocket.instances[0].sent).toHaveLength(0);

    FakeWebSocket.instances[0].open();
    expect(FakeWebSocket.instances[0].sent).toHaveLength(2);
    // 第一帧必须是 auth：服务端在收到它之前不登记 socket，业务帧先到会被当成未鉴权事件拒掉
    expect(JSON.parse(FakeWebSocket.instances[0].sent[0])).toEqual({
      type: "auth",
      token: "t1",
    });
    // 业务帧在 auth 之后冲刷
    expect(JSON.parse(FakeWebSocket.instances[0].sent[1])).toEqual({
      type: "mark_read",
      conversationId: "c1",
    });
    handle.close();
  });

  it("已连接时 send 直发（不入队）", () => {
    const handle = connectWs({ onEvent: () => {} });
    FakeWebSocket.instances[0].open();
    handle.send({ type: "send_message", conversationId: "c1", payload: { text: "hi" } });
    // 1 帧 auth + 1 帧业务
    expect(FakeWebSocket.instances[0].sent).toHaveLength(2);
    expect(JSON.parse(FakeWebSocket.instances[0].sent[1])).toMatchObject({
      type: "send_message",
      conversationId: "c1",
    });
    handle.close();
  });

  it("断线后指数退避重连 1s→2s→4s…上限 30s，成功连上后 attempt 归零", () => {
    connectWs({ onEvent: () => {} });
    FakeWebSocket.instances[0].open();

    // 连续失败：不 open 新连接，退避逐次翻倍并封顶 30s
    const expectDelay = (delay: number) => {
      const before = FakeWebSocket.instances.length;
      FakeWebSocket.instances[FakeWebSocket.instances.length - 1].drop();
      vi.advanceTimersByTime(delay - 1);
      expect(FakeWebSocket.instances).toHaveLength(before);
      vi.advanceTimersByTime(1);
      expect(FakeWebSocket.instances).toHaveLength(before + 1);
    };

    for (const delay of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
      expectDelay(delay);
    }

    // 成功 open 后断线，退避回到 1s
    FakeWebSocket.instances[FakeWebSocket.instances.length - 1].open();
    expectDelay(1000);
  });

  it("close() 停止重连并触发 onClose", () => {
    const onClose = vi.fn();
    const onOpen = vi.fn();
    const handle = connectWs({ onEvent: () => {}, onOpen, onClose });
    FakeWebSocket.instances[0].open();
    expect(onOpen).toHaveBeenCalledTimes(1);

    FakeWebSocket.instances[0].drop();
    expect(onClose).toHaveBeenCalledTimes(1);
    handle.close();
    vi.advanceTimersByTime(120_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(onClose).toHaveBeenCalledTimes(2); // close() 再次触发
  });

  it("onmessage 解析 JSON 分发，无法解析的帧忽略", () => {
    const events: WsServerEvent[] = [];
    connectWs({ onEvent: (e) => events.push(e) });
    const ws = FakeWebSocket.instances[0];
    ws.open();
    const err: WsServerEvent = { type: "error", code: "x", message: "y" };
    ws.onmessage?.({ data: JSON.stringify(err) });
    ws.onmessage?.({ data: "{{{" });
    expect(events).toEqual([err]);
  });

  // ── d.30 · P1-8：无 token 不挂死 + 离线队列上限 ──

  it("无 token 时不建连；send 直接报错并**不入队**（排队等于假装它还在路上）", () => {
    setToken(null);
    const onSendError = vi.fn();
    const handle = connectWs({ onEvent: () => {}, onSendError });
    expect(FakeWebSocket.instances).toHaveLength(0);

    handle.send({ type: "mark_read", conversationId: "c1" });
    expect(onSendError).toHaveBeenCalledTimes(1);
    expect(String(onSendError.mock.calls[0][0])).toMatch(/未登录|未发送/);

    // 之后补上 token 并连上：队列里**不该**有那一帧（它压根没入队）
    setToken("t1");
    vi.advanceTimersByTime(1000);
    expect(FakeWebSocket.instances.length).toBeGreaterThan(0);
    const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
    ws.open();
    // 只有 auth 帧，没有 mark_read
    expect(ws.sent).toHaveLength(1);
    expect(JSON.parse(ws.sent[0])).toEqual({ type: "auth", token: "t1" });
    handle.close();
  });

  it("无 token 时安排退避重试：token 后来到位就会自动连上", () => {
    setToken(null);
    const handle = connectWs({ onEvent: () => {} });
    expect(FakeWebSocket.instances).toHaveLength(0);

    // 没有退避定时器的话，推进时间也不会有任何动作
    vi.advanceTimersByTime(1000);
    expect(FakeWebSocket.instances).toHaveLength(0); // 仍无 token ⇒ 不建连

    // token 到位后，下一次退避到期即建连（证明重试定时器一直在跑）
    setToken("t1");
    vi.advanceTimersByTime(2000);
    expect(FakeWebSocket.instances.length).toBeGreaterThan(0);
    handle.close();
  });

  it("队列超过 100 帧 → 触发 onSendError，队列长度有界（丢最旧的帧）", () => {
    const onSendError = vi.fn();
    const handle = connectWs({ onEvent: () => {}, onSendError });

    for (let i = 0; i < 101; i++) {
      handle.send({ type: "mark_read", conversationId: `c${i}` });
    }
    expect(onSendError).toHaveBeenCalledTimes(1);
    expect(String(onSendError.mock.calls[0][0])).toMatch(/队列已满|丢弃/);

    const ws = FakeWebSocket.instances[0];
    ws.open();
    // 1 帧 auth + 最多 100 帧业务
    expect(ws.sent).toHaveLength(101);
    // 丢的是**最旧**的那帧（c0），保留最新的一帧
    const business = ws.sent.slice(1).map((f) => JSON.parse(f));
    expect(business).toHaveLength(100);
    expect(business[0].conversationId).toBe("c1");
    expect(business[99].conversationId).toBe("c100");
    handle.close();
  });

  it("队列字节上限：帧总字节超 4MB 时旧帧被丢弃并报错（字节口径先到者为准）", () => {
    const onSendError = vi.fn();
    const handle = connectWs({ onEvent: () => {}, onSendError });

    // 每帧 ~1.2MB ⇒ 第 4 帧触发字节上限（累计 > 4MB）
    const big = "x".repeat(1_200_000);
    for (let i = 0; i < 4; i++) {
      handle.send({ type: "send_message", conversationId: "c1", payload: { text: big } });
    }
    expect(onSendError).toHaveBeenCalled();
    const ws = FakeWebSocket.instances[0];
    ws.open();
    expect(ws.sent.length).toBeLessThanOrEqual(4); // auth + 少量业务帧
    handle.close();
  });
});
