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

  it("带 token 建连；未连接时 send 入队，onopen 后冲刷", () => {
    const handle = connectWs({ onEvent: () => {} });
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(FakeWebSocket.instances[0].url).toContain("/api/ws?token=t1");

    handle.send({ type: "mark_read", conversationId: "c1" });
    expect(FakeWebSocket.instances[0].sent).toHaveLength(0);

    FakeWebSocket.instances[0].open();
    expect(FakeWebSocket.instances[0].sent).toHaveLength(1);
    expect(JSON.parse(FakeWebSocket.instances[0].sent[0])).toEqual({
      type: "mark_read",
      conversationId: "c1",
    });
    handle.close();
  });

  it("已连接时 send 直发（不入队）", () => {
    const handle = connectWs({ onEvent: () => {} });
    FakeWebSocket.instances[0].open();
    handle.send({ type: "send_message", conversationId: "c1", payload: { text: "hi" } });
    expect(FakeWebSocket.instances[0].sent).toHaveLength(1);
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

  it("无 token 时不建连，send 保留在队列", () => {
    setToken(null);
    const handle = connectWs({ onEvent: () => {} });
    expect(FakeWebSocket.instances).toHaveLength(0);
    handle.send({ type: "mark_read", conversationId: "c1" });
    expect(FakeWebSocket.instances).toHaveLength(0);
    handle.close();
  });
});
