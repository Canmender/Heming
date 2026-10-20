import { describe, it, expect, afterEach, vi, type Mock } from "vitest";
import { createStdioMcpClient, hasStdioBridge } from "./stdioClient.js";
import type { McpServerConfig } from "./types.js";

const SERVER: McpServerConfig = {
  id: "s1",
  name: "本地服务",
  transport: "stdio",
  command: "node",
  args: ["server.js"],
  enabled: true,
  createdAt: "2026-10-19T00:00:00.000Z",
  updatedAt: "2026-10-19T00:00:00.000Z",
};

type Bridge = {
  request: Mock;
  stop: Mock;
};

function installBridge(impl?: (method: string, params?: unknown) => unknown): Bridge {
  const bridge: Bridge = {
    request: vi.fn(async (_id: string, _cfg: unknown, method: string, params?: unknown) =>
      impl ? impl(method, params) : {},
    ),
    stop: vi.fn(async () => true),
  };
  (window as unknown as { __mcp_stdio?: Bridge }).__mcp_stdio = bridge;
  return bridge;
}

afterEach(() => {
  delete (window as unknown as { __mcp_stdio?: Bridge }).__mcp_stdio;
  vi.restoreAllMocks();
});

describe("stdio 客户端", () => {
  it("没有桌面桥时：hasStdioBridge=false 且创建客户端抛错", () => {
    delete (window as unknown as { __mcp_stdio?: Bridge }).__mcp_stdio;
    expect(hasStdioBridge()).toBe(false);
    expect(() => createStdioMcpClient(SERVER)).toThrow(/桌面端/);
  });

  it("initialize 带上协议版本，并把会话标为已建立", async () => {
    const bridge = installBridge((method) => {
      if (method === "initialize") return { protocolVersion: "2024-11-05", serverInfo: { name: "local" } };
      return {};
    });
    const client = createStdioMcpClient(SERVER);
    expect(client.sessionId).toBeNull();

    const info = await client.initialize();
    expect(info.serverName).toBe("local");
    expect(client.sessionId).toBe("stdio");

    const [serverId, config, method, params] = bridge.request.mock.calls[0];
    expect(serverId).toBe("s1");
    expect(config).toEqual({ command: "node", args: ["server.js"] });
    expect(method).toBe("initialize");
    expect((params as { protocolVersion: string }).protocolVersion).toBe("2024-11-05");
  });

  it("listTools / callTool 走同一条桥，content 拼平", async () => {
    installBridge((method) => {
      if (method === "tools/list") return { tools: [{ name: "echo", description: "回声" }] };
      if (method === "tools/call")
        return { content: [{ type: "text", text: "hi" }, { type: "image", mimeType: "image/png" }] };
      return {};
    });
    const client = createStdioMcpClient(SERVER);
    await expect(client.listTools()).resolves.toEqual([{ name: "echo", description: "回声" }]);
    const result = await client.callTool("echo", { text: "x" });
    expect(result.isError).toBe(false);
    expect(result.text).toBe("hi\n[图片 image/png]");
  });

  it("服务端 isError 透传", async () => {
    installBridge(() => ({ content: [{ type: "text", text: "失败了" }], isError: true }));
    const client = createStdioMcpClient(SERVER);
    const result = await client.callTool("boom", {});
    expect(result.isError).toBe(true);
    expect(result.text).toBe("失败了");
  });

  it("缺命令直接抛错（不把空命令交给主进程）", () => {
    installBridge();
    expect(() => createStdioMcpClient({ ...SERVER, command: "" })).toThrow(/启动命令/);
  });
});
