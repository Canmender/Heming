import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, describe, expect, it } from "vitest";

import { connectMcpServer, type McpHttpConfig, type McpServerEntry } from "./mcpClient.js";

const SERVERS: Server[] = [];

afterAll(async () => {
  await Promise.all(SERVERS.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

interface Recorded {
  method: string;
  session: string | null;
  authorization: string | null;
}

/** 起一个最小的 MCP HTTP 端点：把收到的每条 JSON-RPC 交给 handler 决定怎么回。 */
async function serve(
  handler: (message: { id?: number; method?: string; params?: unknown }, response: ServerResponse) => void,
): Promise<{ url: string; recorded: Recorded[] }> {
  const recorded: Recorded[] = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let raw = "";
    request.on("data", (chunk) => (raw += chunk));
    request.on("end", () => {
      const message = JSON.parse(raw) as { id?: number; method?: string; params?: unknown };
      recorded.push({
        method: String(message.method),
        session: (request.headers["mcp-session-id"] as string | undefined) ?? null,
        authorization: (request.headers.authorization as string | undefined) ?? null,
      });
      handler(message, response);
    });
  });
  SERVERS.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${address.port}/mcp`, recorded };
}

function entryOf(url: string, headers?: Record<string, string>): McpServerEntry {
  const config: McpHttpConfig = { url, ...(headers ? { headers } : {}) };
  return { name: "remote", config };
}

function json(response: ServerResponse, body: unknown, status = 200, headers: Record<string, string> = {}): void {
  response.writeHead(status, { "content-type": "application/json", ...headers });
  response.end(JSON.stringify(body));
}

/** 一套能跑通握手 + 列工具 + 调工具的最小实现。 */
function minimal(message: { id?: number; method?: string; params?: unknown }, response: ServerResponse): void {
  if (message.method === "initialize") {
    json(response, { jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18" } }, 200, {
      "mcp-session-id": "sess-1",
    });
    return;
  }
  if (message.method === "notifications/initialized") {
    response.writeHead(202);
    response.end();
    return;
  }
  if (message.method === "tools/list") {
    json(response, {
      jsonrpc: "2.0",
      id: message.id,
      result: { tools: [{ name: "echo", description: "回显", inputSchema: { type: "object" } }] },
    });
    return;
  }
  if (message.method === "tools/call") {
    const params = message.params as { arguments?: { text?: string; fail?: boolean } };
    json(response, {
      jsonrpc: "2.0",
      id: message.id,
      result: { content: [{ type: "text", text: `echo:${params.arguments?.text ?? ""}` }], isError: params.arguments?.fail === true },
    });
    return;
  }
  json(response, { jsonrpc: "2.0", id: message.id, error: { message: "unknown method" } }, 200);
}

describe("MCP 客户端 · HTTP 传输（d.339）", () => {
  it("JSON 回应：握手、列工具、调工具，并把 session 与自定义头带回去", async () => {
    const { url, recorded } = await serve(minimal);
    const connected = await connectMcpServer(entryOf(url, { authorization: "Bearer t" }), { version: "338.4.121" });
    if (!connected.ok) throw new Error(connected.error);

    expect(connected.connection.tools.map((tool) => tool.name)).toEqual(["echo"]);
    const called = await connected.connection.callTool("echo", { text: "hi" });
    expect(called).toEqual({ text: "echo:hi", isError: false });

    expect(recorded.map((item) => item.method)).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/list",
      "tools/call",
    ]);
    // initialize 那一次还没有 session，之后每一次都要带上服务端下发的那一个。
    expect(recorded[0]?.session).toBeNull();
    expect(recorded.slice(1).every((item) => item.session === "sess-1")).toBe(true);
    expect(recorded.every((item) => item.authorization === "Bearer t")).toBe(true);
  });

  it("SSE 回应：只取 id 对得上的那一条，忽略通知", async () => {
    let url = "";
    const started = await serve((message, response) => {
      if (message.method === "tools/list") {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(`data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/message", params: {} })}\n\n`);
        response.write(
          `data: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "echo" }] } })}\n\n`,
        );
        response.end();
        return;
      }
      minimal(message, response);
    });
    url = started.url;

    const connected = await connectMcpServer(entryOf(url), { version: "338.4.121" });
    if (!connected.ok) throw new Error(connected.error);
    expect(connected.connection.tools.map((tool) => tool.name)).toEqual(["echo"]);
  });

  it("工具报错时原样透传 isError", async () => {
    const { url } = await serve(minimal);
    const connected = await connectMcpServer(entryOf(url), { version: "338.4.121" });
    if (!connected.ok) throw new Error(connected.error);
    const result = await connected.connection.callTool("echo", { text: "x", fail: true });
    expect(result).toEqual({ text: "echo:x", isError: true });
  });

  it("HTTP 非 2xx：连不上就说清状态码与对方的话", async () => {
    const { url } = await serve((_message, response) => {
      response.writeHead(503, { "content-type": "text/plain" });
      response.end("维护中");
    });
    const connected = await connectMcpServer(entryOf(url), { version: "338.4.121" });
    expect(connected.ok).toBe(false);
    if (connected.ok) return;
    expect(connected.error).toContain("HTTP 503");
    expect(connected.error).toContain("维护中");
  });

  it("超时：说清是多少毫秒没有回应，而不是一直挂着", async () => {
    const { url } = await serve(() => {
      // 什么都不回，让客户端自己超时。
    });
    const connected = await connectMcpServer(entryOf(url), { version: "338.4.121", timeoutMs: 60 });
    expect(connected.ok).toBe(false);
    if (connected.ok) return;
    expect(connected.error).toContain("60ms");
    expect(connected.error).toContain("initialize");
  });

  it("回应不是 JSON 也不像 SSE：报「看不懂」并带上开头几个字", async () => {
    const { url } = await serve((_message, response) => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<html>不是这里</html>");
    });
    const connected = await connectMcpServer(entryOf(url), { version: "338.4.121" });
    expect(connected.ok).toBe(false);
    if (connected.ok) return;
    expect(connected.error).toContain("看不懂");
    expect(connected.error).toContain("<html>");
  });

  it("close 之后再调用直接说已关闭，不再发请求", async () => {
    const { url, recorded } = await serve(minimal);
    const connected = await connectMcpServer(entryOf(url), { version: "338.4.121" });
    if (!connected.ok) throw new Error(connected.error);
    connected.connection.close();
    const before = recorded.length;
    await expect(connected.connection.callTool("echo", { text: "x" })).rejects.toThrow(/已关闭/);
    expect(recorded.length).toBe(before);
  });
});