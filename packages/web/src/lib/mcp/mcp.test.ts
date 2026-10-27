import { describe, it, expect, vi } from "vitest";
import {
  buildToolCatalog,
  createHttpMcpClient,
  executeToolCall,
  formatRpcError,
  MCP_SERVERS_KEY,
  MCP_TOOLS_KEY,
  McpRegistry,
  parseSseMessages,
  pickResponse,
  rpcNotification,
  rpcRequest,
  slugPart,
  stringifyContent,
  toOpenAiTools,
  type McpServerConfig,
} from "./index.js";
import type { StorageLike } from "../memory/types.js";
import { resetSecureStorageState, secureStorageFor } from "../secureStorage.js";

/** 内存存储（用例之间零污染）。 */
function memStorage(): StorageLike & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => (map.has(k) ? (map.get(k) as string) : null),
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

const SERVER: McpServerConfig = {
  id: "s1",
  name: "Demo 服务",
  transport: "http",
  url: "https://mcp.example.com/mcp",
  enabled: true,
  createdAt: "2026-10-19T00:00:00.000Z",
  updatedAt: "2026-10-19T00:00:00.000Z",
};

function jsonResponse(payload: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("JSON-RPC 基础件", () => {
  it("请求带 id/method/params，通知不带 id", () => {
    expect(JSON.parse(rpcRequest(3, "tools/list", { a: 1 }))).toEqual({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/list",
      params: { a: 1 },
    });
    expect(JSON.parse(rpcNotification("notifications/initialized"))).toEqual({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
  });

  it("解析 SSE：忽略心跳/注释/DONE，只留 JSON-RPC 消息", () => {
    const text = [
      ": keep-alive",
      "",
      'data: {"jsonrpc":"2.0","id":1,"result":{"tools":[]}}',
      "event: message",
      'data: {"jsonrpc":"2.0","method":"notifications/progress"}',
      "data: [DONE]",
      "data: not-json",
    ].join("\n");
    const msgs = parseSseMessages(text);
    expect(msgs).toHaveLength(2);
    expect(msgs[0].id).toBe(1);
    expect(pickResponse(msgs, 1)?.result).toEqual({ tools: [] });
    expect(pickResponse(msgs, 99)).toBeNull();
  });

  it("错误格式化带上 code", () => {
    expect(formatRpcError({ code: -32601, message: "Method not found" })).toContain("-32601");
    expect(formatRpcError(undefined)).toContain("空错误");
  });
});

describe("HTTP 传输客户端", () => {
  it("initialize → initialized 通知 → tools/list，并记住 session id", async () => {
    const calls: { url: string; body: string; headers: Record<string, string> }[] = [];
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      const body = String(init.body);
      calls.push({ url, body: JSON.parse(body) ? body : body, headers: init.headers as Record<string, string> });
      const parsed = JSON.parse(body) as { id?: number; method: string };
      if (parsed.method === "initialize") {
        return jsonResponse(
          { jsonrpc: "2.0", id: parsed.id, result: { protocolVersion: "2024-11-05", serverInfo: { name: "demo" } } },
          { "mcp-session-id": "sess-1" },
        );
      }
      if (parsed.method === "notifications/initialized") {
        return new Response("", { status: 202 });
      }
      if (parsed.method === "tools/list") {
        return jsonResponse({
          jsonrpc: "2.0",
          id: parsed.id,
          result: {
            tools: [
              { name: "echo", description: "回声", inputSchema: { type: "object", properties: {} } },
            ],
          },
        });
      }
      throw new Error(`unexpected method ${parsed.method}`);
    });

    const client = createHttpMcpClient(SERVER, fetchMock as unknown as typeof fetch);
    const info = await client.initialize();
    expect(info.serverName).toBe("demo");
    expect(client.sessionId).toBe("sess-1");

    const tools = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["echo"]);
    // 后续请求带上会话 id
    const listCall = calls.find((c) => c.body.includes("tools/list"));
    expect(listCall?.headers["mcp-session-id"]).toBe("sess-1");
  });

  it("SSE 响应也能解析（tools/call）", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const parsed = JSON.parse(String(init.body)) as { id?: number; method: string };
      if (parsed.method === "initialize") {
        return jsonResponse({ jsonrpc: "2.0", id: parsed.id, result: { protocolVersion: "x" } });
      }
      if (parsed.method === "notifications/initialized") return new Response("", { status: 202 });
      const frame = [
        'data: {"jsonrpc":"2.0","method":"notifications/progress"}',
        `data: {"jsonrpc":"2.0","id":${parsed.id},"result":{"content":[{"type":"text","text":"你好"},{"type":"image","mimeType":"image/png"}]}}`,
      ].join("\n\n");
      return new Response(frame, { status: 200, headers: { "content-type": "text/event-stream" } });
    });

    const client = createHttpMcpClient(SERVER, fetchMock as unknown as typeof fetch);
    await client.initialize();
    const result = await client.callTool("greet", { name: "和鸣" });
    expect(result.isError).toBe(false);
    expect(result.text).toContain("你好");
    expect(result.text).toContain("[图片 image/png]");
  });

  it("JSON-RPC error → 抛可读错误；HTTP 500 → 抛出带状态码", async () => {
    const errFetch = vi.fn(async (_u: string, init: RequestInit) => {
      const parsed = JSON.parse(String(init.body)) as { id?: number };
      return jsonResponse({ jsonrpc: "2.0", id: parsed.id, error: { code: -32601, message: "没有这个方法" } });
    });
    const c1 = createHttpMcpClient(SERVER, errFetch as unknown as typeof fetch);
    await expect(c1.listTools()).rejects.toThrow(/没有这个方法/);

    const http500 = vi.fn(async () => new Response("boom", { status: 500 }));
    const c2 = createHttpMcpClient(SERVER, http500 as unknown as typeof fetch);
    await expect(c2.listTools()).rejects.toThrow(/HTTP 500/);
  });

  it("内容块拼平：文本直出、图片与资源给占位", () => {
    expect(
      stringifyContent([
        { type: "text", text: "a" },
        { type: "resource", resource: { text: "b" } },
        { type: "resource_link", uri: "file:///x" },
      ]),
    ).toBe("a\nb\n[资源 file:///x]");
  });
});

describe("注册表（服务 + 工具 + 启用开关）", () => {
  it("新增校验：名称必填、HTTP 必须 http(s)、stdio 必须命令", () => {
    const reg = new McpRegistry(memStorage());
    expect(() => reg.add({ name: "", transport: "http", url: "https://x" })).toThrow(/名称/);
    expect(() => reg.add({ name: "a", transport: "http", url: "ftp://x" })).toThrow(/http/);
    expect(() => reg.add({ name: "a", transport: "stdio", command: "" })).toThrow(/命令/);
  });

  it("增删改查 + 工具缓存 + 删除服务时清掉其工具与开关", () => {
    const storage = memStorage();
    const reg = new McpRegistry(storage);
    const s = reg.add({ name: "Demo", transport: "http", url: "https://x/mcp" });
    reg.setTools(s.id, [{ name: "echo", description: "e" }]);
    expect(reg.tools(s.id)).toHaveLength(1);
    reg.setToolEnabled(s.id, "echo", true);
    expect(reg.isToolEnabled(s.id, "echo")).toBe(true);

    // 重水合。首次使用会预置一条「Windows 桌面控制」，所以这里断言的是
    // 「刚加的 Demo 还在、工具与开关都还原」，而不是「总共只有 1 条」。
    const again = new McpRegistry(storage);
    expect(again.servers().map((x) => x.id)).toContain(s.id);
    expect(again.tools(s.id)[0].name).toBe("echo");
    expect(again.isToolEnabled(s.id, "echo")).toBe(true);

    again.remove(s.id);
    expect(again.servers().map((x) => x.id)).not.toContain(s.id);
    expect(again.tools(s.id)).toHaveLength(0);
    expect(again.isToolEnabled(s.id, "echo")).toBe(false);
  });

  it("工具默认不启用；enabledTools 同时要求服务启用", () => {
    const reg = new McpRegistry(memStorage());
    const s = reg.add({ name: "Demo", transport: "http", url: "https://x/mcp" });
    reg.setTools(s.id, [{ name: "echo" }, { name: "sum" }]);
    expect(reg.enabledTools()).toHaveLength(0);

    reg.setToolEnabled(s.id, "echo", true);
    expect(reg.enabledTools().map((r) => r.tool.name)).toEqual(["echo"]);

    reg.update(s.id, { enabled: false });
    expect(reg.enabledTools()).toHaveLength(0);
  });

  it("★ Registry 本地包台账能穿过存储往返（丢了就看不出装的是什么）", () => {
    const storage = memStorage();
    const reg = new McpRegistry(storage);
    const s = reg.add({
      name: "fetch",
      transport: "stdio",
      command: "uvx",
      args: ["mcp-server-fetch==0.6.2"],
      origin: "registry",
      registryName: "io.github.a/fetch",
      registryType: "pypi",
      registryVersion: "0.6.2",
    });

    const again = new McpRegistry(storage);
    const saved = again.get(s.id);
    expect(saved?.origin).toBe("registry");
    expect(saved?.registryName).toBe("io.github.a/fetch");
    expect(saved?.registryType).toBe("pypi");
    expect(saved?.registryVersion).toBe("0.6.2");
    // 台账只是账本，改别的（开关）不该把它洗掉
    again.update(s.id, { enabled: false });
    expect(again.get(s.id)?.registryVersion).toBe("0.6.2");
  });

  it("手填服务不会凭空长出 Registry 台账", () => {
    const reg = new McpRegistry(memStorage());
    const s = reg.add({ name: "Demo", transport: "http", url: "https://x/mcp" });
    expect(s.origin).toBe("manual");
    expect(s.registryType).toBeUndefined();
    expect(s.registryVersion).toBeUndefined();
  });

  it("服务配置走 secure 层：servers 键是信封、tools 键是普通 JSON，重开能解回请求头", () => {
    (window as unknown as { __heming_secrets?: unknown }).__heming_secrets = {
      available: true,
      encrypt: (plain: string) => `enc:${Buffer.from(plain, "utf8").toString("base64")}`,
      decrypt: (data: string) =>
        data.startsWith("enc:") ? Buffer.from(data.slice(4), "base64").toString("utf8") : null,
    };
    resetSecureStorageState();
    try {
      const base = memStorage();
      const reg = new McpRegistry(secureStorageFor(MCP_SERVERS_KEY, base));
      const server = reg.add({
        name: "带鉴权的服务",
        transport: "http",
        url: "https://example.test/mcp",
        headers: { Authorization: "Bearer top-secret" },
      });

      const rawServers = base.map.get(MCP_SERVERS_KEY)!;
      expect(JSON.parse(rawServers).__hemingEnc).toBe("v1");
      expect(rawServers).not.toContain("top-secret");
      // tools 键必须真的被写过，否则「不是信封」的断言恒真
      reg.setTools(server.id, [{ name: "echo" }]);
      expect(base.map.get(MCP_TOOLS_KEY)).toBeTruthy();
      expect(base.map.get(MCP_TOOLS_KEY)!).toContain("echo");
      expect(base.map.get(MCP_TOOLS_KEY) ?? "").not.toContain("__hemingEnc");

      const again = new McpRegistry(secureStorageFor(MCP_SERVERS_KEY, base));
      expect(again.get(server.id)?.headers?.Authorization).toBe("Bearer top-secret");
    } finally {
      delete (window as unknown as { __heming_secrets?: unknown }).__heming_secrets;
      resetSecureStorageState();
    }
  });

  it("解不开的服务配置不会被启动预置覆盖", () => {
    (window as unknown as { __heming_secrets?: unknown }).__heming_secrets = {
      available: true,
      encrypt: (plain: string) => `enc:${Buffer.from(plain, "utf8").toString("base64")}`,
      decrypt: () => null,
    };
    resetSecureStorageState();
    try {
      const base = memStorage();
      const cipher = JSON.stringify({ __hemingEnc: "v1", data: "garbage" });
      base.map.set(MCP_SERVERS_KEY, cipher);

      const reg = new McpRegistry(secureStorageFor(MCP_SERVERS_KEY, base));

      // 读不出来就当空表展示，但绝不能把磁盘上的密文换成预置的明文。
      expect(reg.servers()).toEqual([]);
      expect(base.map.get(MCP_SERVERS_KEY)).toBe(cipher);
    } finally {
      delete (window as unknown as { __heming_secrets?: unknown }).__heming_secrets;
      resetSecureStorageState();
    }
  });

  it("用户改动覆盖解不开的服务配置前先备份旧密文", () => {
    const base = memStorage();
    const original = JSON.stringify({ __hemingEnc: "v1", data: "garbage" });
    base.map.set(MCP_SERVERS_KEY, original);
    (window as unknown as { __heming_secrets?: unknown }).__heming_secrets = {
      available: true,
      encrypt: (plain: string) => `enc:${Buffer.from(plain, "utf8").toString("base64")}`,
      decrypt: (data: string) =>
        data.startsWith("enc:") ? Buffer.from(data.slice(4), "base64").toString("utf8") : null,
    };
    resetSecureStorageState();
    try {
      const reg = new McpRegistry(secureStorageFor(MCP_SERVERS_KEY, base));
      expect(reg.servers()).toEqual([]); // 解不开
      reg.add({ name: "新服务", transport: "http", url: "https://example.test" });
      expect(base.map.get(MCP_SERVERS_KEY + ".__heming_undecryptable")).toBe(original);
      expect(JSON.parse(base.map.get(MCP_SERVERS_KEY)!).__hemingEnc).toBe("v1");
    } finally {
      delete (window as unknown as { __heming_secrets?: unknown }).__heming_secrets;
      resetSecureStorageState();
    }
  });

  it("默认存储：服务器配置写 localStorage 时走信封，工具清单仍是普通 JSON", () => {
    (window as unknown as { __heming_secrets?: unknown }).__heming_secrets = {
      available: true,
      encrypt: (plain: string) => `enc:${Buffer.from(plain, "utf8").toString("base64")}`,
      decrypt: (data: string) =>
        data.startsWith("enc:") ? Buffer.from(data.slice(4), "base64").toString("utf8") : null,
    };
    resetSecureStorageState();
    try {
      const reg = new McpRegistry(); // 走 defaultStorage()
      const server = reg.add({
        name: "默认存储的鉴权服务",
        transport: "http",
        url: "https://example.test/default",
        headers: { Authorization: "Bearer default-secret" },
      });
      reg.setTools(server.id, [{ name: "echo" }]);

      const rawServers = localStorage.getItem(MCP_SERVERS_KEY)!;
      expect(JSON.parse(rawServers).__hemingEnc).toBe("v1");
      expect(rawServers).not.toContain("default-secret");
      expect(localStorage.getItem(MCP_TOOLS_KEY) ?? "").not.toContain("__hemingEnc");

      const again = new McpRegistry();
      expect(again.get(server.id)?.headers?.Authorization).toBe("Bearer default-secret");
    } finally {
      localStorage.removeItem(MCP_SERVERS_KEY);
      localStorage.removeItem(MCP_TOOLS_KEY);
      delete (window as unknown as { __heming_secrets?: unknown }).__heming_secrets;
      resetSecureStorageState();
    }
  });
});

describe("工具桥接（命名空间 + 执行）", () => {
  it("中文服务名也能得到合法且稳定的工具名", () => {
    const a = slugPart("和鸣助手");
    const b = slugPart("和鸣助手");
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-z0-9_-]+$/);
  });

  it("同名工具自动去重加后缀", () => {
    const catalog = buildToolCatalog([
      { serverId: "s1", serverName: "demo", tool: { name: "echo" } },
      { serverId: "s1", serverName: "demo", tool: { name: "echo" } },
    ]);
    const names = catalog.entries.map((e) => e.openAiName);
    expect(new Set(names).size).toBe(2);
    expect(names[1]).toBe(`${names[0]}-2`);
  });

  it("OpenAI tools 形状：type/function/parameters", () => {
    const catalog = buildToolCatalog([
      {
        serverId: "s1",
        serverName: "demo",
        tool: { name: "echo", description: "回声", inputSchema: { type: "object", properties: {} } },
      },
    ]);
    const tools = toOpenAiTools(catalog) as {
      type: string;
      function: { name: string; description: string; parameters: unknown };
    }[];
    expect(tools[0].type).toBe("function");
    expect(tools[0].function.name).toMatch(/^demo__echo/);
    expect(tools[0].function.parameters).toEqual({ type: "object", properties: {} });
  });

  it("执行：未知工具 / 非法 JSON / 服务端错误都返回文字而不抛", async () => {
    const catalog = buildToolCatalog([{ serverId: "s1", serverName: "demo", tool: { name: "echo" } }]);
    const name = catalog.entries[0].openAiName;
    const deps = {
      clientFor: () => ({
        sessionId: null,
        initialize: async () => ({}),
        listTools: async () => [],
        callTool: async (_n: string, args: Record<string, unknown>) => ({
          text: `echo:${JSON.stringify(args)}`,
          isError: false,
          content: [],
        }),
      }),
    };

    await expect(executeToolCall({ name: "nope", arguments: "{}" }, catalog, deps)).resolves.toMatchObject({
      ok: false,
      text: expect.stringContaining("未知工具"),
    });
    await expect(executeToolCall({ name, arguments: "not json" }, catalog, deps)).resolves.toMatchObject({
      ok: false,
      text: expect.stringContaining("不是合法 JSON"),
    });
    await expect(executeToolCall({ name, arguments: '{"q":1}' }, catalog, deps)).resolves.toEqual({
      ok: true,
      text: 'echo:{"q":1}',
    });

    const failing = {
      clientFor: () => ({
        sessionId: null,
        initialize: async () => ({}),
        listTools: async () => [],
        callTool: async () => {
          throw new Error("连接断了");
        },
      }),
    };
    await expect(executeToolCall({ name, arguments: "{}" }, catalog, failing)).resolves.toMatchObject({
      ok: false,
      text: expect.stringContaining("连接断了"),
    });
  });
});
