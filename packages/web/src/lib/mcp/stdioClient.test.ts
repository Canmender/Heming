import { describe, it, expect, afterEach, vi, type Mock } from "vitest";
import { createStdioMcpClient, hasStdioBridge } from "./stdioClient.js";
import { resetClient, stopStdioServer } from "./runtime.js";
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

  it("超时可配：把服务上的 timeoutMs 一并发给主进程", async () => {
    const bridge = installBridge(() => ({ tools: [] }));
    const client = createStdioMcpClient({ ...SERVER, timeoutMs: 120_000 });
    await client.listTools();
    const [, config] = bridge.request.mock.calls[0];
    expect(config).toMatchObject({ command: "node", args: ["server.js"], timeoutMs: 120_000 });
  });

  it("没有配 timeoutMs 时不发这个字段（主进程用缺省 30s）", async () => {
    const bridge = installBridge(() => ({ tools: [] }));
    const client = createStdioMcpClient(SERVER);
    await client.listTools();
    const [, config] = bridge.request.mock.calls[0];
    expect(config).not.toHaveProperty("timeoutMs");
  });

  it("用户中断：带着 requestId 调桥的 cancel，并立刻以「已中断」拒绝", async () => {
    const bridge = installBridge();
    (bridge as unknown as { cancel: Mock }).cancel = vi.fn(async () => true);
    // 永不 resolve：模拟服务端在跑长任务
    bridge.request.mockImplementation(() => new Promise(() => undefined));
    const client = createStdioMcpClient(SERVER);
    const controller = new AbortController();
    const pending = client.callTool("slow", {}, { signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const requestId = bridge.request.mock.calls[0][4] as number;
    expect(typeof requestId).toBe("number");
    controller.abort();
    await expect(pending).rejects.toThrow(/已通知服务端中止/);
    expect((bridge as unknown as { cancel: Mock }).cancel).toHaveBeenCalledWith("s1", requestId);
  });

  it("老版本桌面端没有 cancel：中断仍然收口，但文案说明子进程可能还在跑", async () => {
    const bridge = installBridge();
    bridge.request.mockImplementation(() => new Promise(() => undefined));
    const client = createStdioMcpClient(SERVER);
    const controller = new AbortController();
    const pending = client.callTool("slow", {}, { signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 0));

    controller.abort();
    await expect(pending).rejects.toThrow(/子进程可能仍在运行/);
  });

  it("两个客户端实例的 requestId 不重叠（重载后不会撞上主进程里的在途 id）", async () => {
    const bridge = installBridge();
    const first = createStdioMcpClient(SERVER);
    const second = createStdioMcpClient(SERVER);

    await first.initialize();
    await second.initialize();

    const idOf = (index: number) => bridge.request.mock.calls[index][4] as number;
    expect(typeof idOf(0)).toBe("number");
    expect(typeof idOf(1)).toBe("number");
    // 起点随机化：两个实例从同一批号段开始就会把响应错配给对方
    expect(idOf(0)).not.toBe(idOf(1));
    expect(idOf(1)).toBeGreaterThanOrEqual(1_000_000);
  });

  it("缺命令直接抛错（不把空命令交给主进程）", () => {
    installBridge();
    expect(() => createStdioMcpClient({ ...SERVER, command: "" })).toThrow(/启动命令/);
  });
});

describe("stdio 子进程回收（删除服务时）", () => {
  it("★ 删除路径调 stop，并把 serverId 传给主进程", async () => {
    const bridge = installBridge();
    await expect(stopStdioServer("s1")).resolves.toBeUndefined();
    expect(bridge.stop).toHaveBeenCalledWith("s1");
  });

  it("★ 重连（resetClient）不碰进程：否则「刷新一次」= 重启一次（冷启动实测 5.4s）", () => {
    const bridge = installBridge();
    resetClient(SERVER.id);
    expect(bridge.stop).not.toHaveBeenCalled();
  });

  it("浏览器里没有桥 → 空转不抛", async () => {
    delete (window as unknown as { __mcp_stdio?: Bridge }).__mcp_stdio;
    await expect(stopStdioServer("s1")).resolves.toBeUndefined();
  });

  it("★ 进程已经自己退出（桥抛错）也不抛：删除不该被回收失败阻断", async () => {
    const bridge = installBridge();
    bridge.stop.mockRejectedValueOnce(new Error("no such process"));
    await expect(stopStdioServer("s1")).resolves.toBeUndefined();
  });
});
