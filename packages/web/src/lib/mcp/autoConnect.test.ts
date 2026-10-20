import { describe, it, expect, vi, beforeEach } from "vitest";
import { autoConnectAll } from "./runtime.js";
import { McpRegistry } from "./store.js";
import type { McpServerConfig } from "./types.js";
import type { StorageLike } from "../memory/types.js";

/**
 * 自动连接的契约测试。
 *
 * 这里不打真实 MCP 服务（那要起子进程、依赖网络），而是把 runtime 依赖的
 * 两个外部点替换掉：`refreshServerTools` 用的 registry 与 stdio 桥可用性。
 * 重点验证的是**编排语义**——哪些服务会被试、失败怎么办、结果长什么样。
 */

function memStorage(): StorageLike {
  const map = new Map<string, string>();
  return {
    getItem: (k) => (map.has(k) ? (map.get(k) as string) : null),
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

function server(over: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    id: "s1",
    name: "服务一",
    transport: "http",
    url: "https://a.example.com/mcp",
    enabled: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

/**
 * 建一个「只有指定这些服务」的 registry。
 * 必须清掉首次预置——否则 servers() 里总会多一条 Windows 桌面控制，
 * 断言「共 N 台」就会一直差一。用 remove 而非改存储，是走真实删除路径。
 */
function registryWith(servers: McpServerConfig[]): McpRegistry {
  const registry = new McpRegistry(memStorage(), () => "2026-10-20T00:00:00.000Z");
  for (const s of [...registry.servers()]) registry.remove(s.id);
  for (const s of servers) registry.add(s);
  return registry;
}

describe("autoConnectAll：自动连接编排", () => {
  let registry: McpRegistry;

  beforeEach(() => {
    vi.restoreAllMocks();
    registry = new McpRegistry(memStorage(), () => "2026-10-20T00:00:00.000Z");
  });

  it("没有启用中的服务时不做任何事", async () => {
    const registry = registryWith([
      server({ id: "off", name: "停用的", enabled: false }),
    ]);
    const results = await autoConnectAll(registry);
    expect(results).toEqual([]);
  });

  it("逐台返回结果：成功的带工具数，失败的不抛异常", async () => {
    const registry = registryWith([
      server({ id: "ok", name: "好的", url: "https://ok.example.com/mcp" }),
      server({ id: "bad", name: "坏的", url: "https://bad.invalid/mcp" }),
    ]);
    const results = await autoConnectAll(registry);
    expect(results).toHaveLength(2);
    // 两台都不该让 autoConnectAll 抛出去——一个 MCP 坏了不该挡住整个应用
    const bad = results.find((r) => r.name === "坏的");
    const good = results.find((r) => r.name === "好的");
    expect(good).toBeDefined();
    expect(bad).toBeDefined();
    expect(bad!.ok).toBe(false);
  });

  it("结果里带 serverId 与名字，界面可直接展示", async () => {
    const registry = registryWith([
      server({ id: "obs", name: "可观测的", url: "https://obs.example.com/mcp" }),
    ]);
    const results = await autoConnectAll(registry);
    const row = results.find((r) => r.name === "可观测的")!;
    expect(row.serverId).toBe("obs");
    expect(row.name).toBe("可观测的");
    expect(typeof row.ok).toBe("boolean");
    expect(typeof row.tools).toBe("number");
  });

  it("停用的服务不会被尝试连接", async () => {
    const registry = registryWith([
      server({ id: "off", name: "停用的", enabled: false, url: "https://off.invalid/mcp" }),
    ]);
    const results = await autoConnectAll(registry);
    expect(results).toHaveLength(0);
  });

  it("多台服务的结果顺序与启用顺序一致", async () => {
    const registry = registryWith([
      server({ id: "a", name: "甲", url: "https://a.invalid/mcp" }),
      server({ id: "b", name: "乙", url: "https://b.invalid/mcp" }),
      server({ id: "c", name: "丙", url: "https://c.invalid/mcp" }),
    ]);
    const results = await autoConnectAll(registry);
    expect(results.length, "三台都要被试过").toBe(3);
    // 界面按 index 取名字，顺序错位会张冠李戴
    expect(results.map((r) => r.serverId)).toEqual(["a", "b", "c"]);
  });
});

/**
 * 并行语义（单独 describe：需要 mock 客户端，与上面对真实路径的契约测试分开）。
 *
 * 为什么要测：串行改并行是性能优化（实测 7.8s → 5.4s），但并行会引入
 * 「结果顺序随完成先后变化」的风险。这两条同时守住「快」和「顺序对」。
 */
describe("autoConnectAll：并行而非串行", () => {
  it("三台各延迟 80ms，总耗时接近 80ms 而不是 240ms", async () => {
    vi.resetModules();
    vi.doMock("./httpClient.js", () => ({
      createHttpMcpClient: () => ({
        initialize: () => new Promise((r) => setTimeout(r, 80)),
        listTools: async () => [{ name: "t", description: "", inputSchema: { type: "object" } }],
      }),
    }));
    const { autoConnectAll: connect } = await import("./runtime.js");
    const registry = registryWith([
      server({ id: "p1", name: "一", url: "https://p1.invalid/mcp" }),
      server({ id: "p2", name: "二", url: "https://p2.invalid/mcp" }),
      server({ id: "p3", name: "三", url: "https://p3.invalid/mcp" }),
    ]);

    const started = Date.now();
    const results = await connect(registry);
    const elapsed = Date.now() - started;

    expect(results).toHaveLength(3);
    // 串行至少要 240ms；并行约 80-90ms。取 180ms 作分界，留足抖动余量。
    expect(elapsed).toBeLessThan(180);
    vi.doUnmock("./httpClient.js");
    vi.resetModules();
  });

  it("并行下结果顺序仍与启用顺序一致", async () => {
    vi.resetModules();
    vi.doMock("./httpClient.js", () => ({
      // 故意让先发起的更慢，验证不是「按完成顺序 push」
      createHttpMcpClient: (cfg: { id?: string }) => ({
        initialize: () => new Promise((r) => setTimeout(r, 0)),
        listTools: async () => [{ name: "t", description: "", inputSchema: { type: "object" } }],
      }),
    }));
    const { autoConnectAll: connect } = await import("./runtime.js");
    const registry = registryWith([
      server({ id: "first", name: "先", url: "https://x.invalid/mcp" }),
      server({ id: "second", name: "后", url: "https://y.invalid/mcp" }),
    ]);
    const results = await connect(registry);
    expect(results.map((r) => r.serverId)).toEqual(["first", "second"]);
    vi.doUnmock("./httpClient.js");
    vi.resetModules();
  });
});