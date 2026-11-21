import { describe, expect, it, vi } from "vitest";
import { createHttpMcpClient } from "./httpClient.js";
import type { McpServerConfig } from "./types.js";

const SERVER: McpServerConfig = {
  id: "s1",
  name: "s1",
  transport: "http",
  url: "http://localhost/mcp",
  enabled: true,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

/** 造一个永不关闭、先吐一条 data: 响应再挂着的 SSE Response。 */
function neverClosingSse(bodyLine: string): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(`data: ${bodyLine}\n\n`));
      // 故意不 close()：模拟服务端发完响应后保持流打开。
    },
    cancel() {
      /* 客户端 cancel 时释放 */
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

describe("HTTP MCP 客户端", () => {
  it("SSE 响应到手即返回，不等流关闭（服务端保持 SSE 打开）", async () => {
    const initResponse = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: { protocolVersion: "2024-11-05", serverInfo: { name: "demo" } },
    });
    const fetchMock = vi.fn(async () => neverClosingSse(initResponse)) as unknown as typeof fetch;
    const client = createHttpMcpClient(SERVER, fetchMock);

    // 旧实现 await res.text() 读到 EOF，这里会一直挂到测试超时；新实现拿到 id=1 就返回。
    const result = await Promise.race([
      client.initialize().then((r) => ({ ok: true as const, r })),
      new Promise<{ ok: false }>((resolve) => setTimeout(() => resolve({ ok: false }), 800)),
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.r.serverName).toBe("demo");
  });
});
