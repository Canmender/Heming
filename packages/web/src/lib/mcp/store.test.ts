import { describe, it, expect } from "vitest";
import { McpRegistry, MCP_SERVERS_KEY } from "./store.js";
import { SYSTEM_MCP_SERVERS, isSystemMcpServer, systemMcpServerId } from "./presets.js";

/**
 * 系统能力（d.147.4.93.11）：从「可删预置」反转为「始终存在的只读能力」。
 *
 * - 构造期（或 hydrate 后）`ensureSystemServers()` 幂等补齐两条；
 * - `remove()` 对系统能力返回 false、不改状态；
 * - `update()` 对系统能力抛「系统能力不可修改配置」；
 * - 旧的恢复 API 只作为兼容壳：`removedPresetIds()` 恒空、`restorePresets()` 恒 0。
 */

/** 内存存储，可预置初始内容以模拟「已经配过」。 */
function memStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    raw: map,
  };
}

const FIXED_NOW = () => "2026-11-07T00:00:00.000Z";
const SYSTEM_IDS = ["mcp-windows-desktop", "mcp-scrapling"];
const SYSTEM_ID_SET = new Set(SYSTEM_IDS);

describe("系统能力：常驻且只读", () => {
  it("空存储首次使用：自动补齐两条系统能力，启用且可按定义表顺序取到", () => {
    const registry = new McpRegistry(memStorage(), FIXED_NOW);
    const ids = registry.servers().map((s) => s.id);
    expect(ids).toEqual(SYSTEM_IDS);
    expect(registry.systemServers().map((s) => s.id)).toEqual(SYSTEM_IDS);
    for (const server of registry.systemServers()) {
      expect(server.enabled).toBe(true);
      expect(registry.isSystem(server.id)).toBe(true);
      expect(registry.isPreset(server.id)).toBe(true);
      expect(isSystemMcpServer(server.id)).toBe(true);
    }
    // Windows 桌面控制带可直接执行的 uvx 入口
    const win = registry.get(SYSTEM_IDS[0])!;
    expect(win.name).toBe("Windows 桌面控制");
    expect(win.command).toBe("uvx");
    expect(win.args).toEqual(["windows-mcp", "serve"]);
  });

  it("已存在系统能力时不重复插入（重开幂等，不再多出条目）", () => {
    const storage = memStorage();
    new McpRegistry(storage, FIXED_NOW);
    const reopened = new McpRegistry(storage, FIXED_NOW);
    expect(reopened.servers()).toHaveLength(SYSTEM_MCP_SERVERS.length);
    expect(reopened.servers().map((s) => s.id)).toEqual(SYSTEM_IDS);
  });

  it("用户已有私有服务：系统能力照样补齐，私有服务保持原样", () => {
    const storage = memStorage({
      [MCP_SERVERS_KEY]: JSON.stringify([
        {
          id: "mine",
          name: "我自己的服务",
          transport: "http",
          url: "https://mine.example.com/mcp",
          enabled: true,
          createdAt: FIXED_NOW(),
          updatedAt: FIXED_NOW(),
        },
      ]),
    });
    const registry = new McpRegistry(storage, FIXED_NOW);
    expect(registry.servers().map((s) => s.id).sort()).toEqual(["mcp-scrapling", "mcp-windows-desktop", "mine"]);
    const mine = registry.get("mine")!;
    expect(mine.url).toBe("https://mine.example.com/mcp");
    expect(registry.isSystem("mine")).toBe(false);
  });

  it("系统能力不可删除：remove() 返回 false 且列表/落盘都不变", () => {
    const storage = memStorage();
    const registry = new McpRegistry(storage, FIXED_NOW);
    const before = registry.servers().map((s) => s.id);
    expect(registry.remove(SYSTEM_IDS[0])).toBe(false);
    expect(registry.remove(SYSTEM_IDS[1])).toBe(false);
    expect(registry.servers().map((s) => s.id)).toEqual(before);
    const reopened = new McpRegistry(storage, FIXED_NOW);
    expect(reopened.servers().map((s) => s.id)).toEqual(before);
  });

  it("系统能力不可改配置：update() 抛「系统能力不可修改配置」，配置不变", () => {
    const registry = new McpRegistry(memStorage(), FIXED_NOW);
    expect(() => registry.update(SYSTEM_IDS[0], { url: "https://evil.example.com/mcp" })).toThrow(
      "系统能力不可修改配置",
    );
    expect(registry.get(SYSTEM_IDS[0])!.url).not.toBe("https://evil.example.com/mcp");
    expect(registry.get(SYSTEM_IDS[0])!.command).toBe("uvx");
  });

  it("无关 id 的 update() 仍抛「MCP 服务不存在」", () => {
    const registry = new McpRegistry(memStorage(), FIXED_NOW);
    expect(() => registry.update("nope", { url: "https://x/mcp" })).toThrow("MCP 服务不存在");
  });

  it("私有服务仍可增删改（系统能力反转不影响用户自己的服务）", () => {
    const registry = new McpRegistry(memStorage(), FIXED_NOW);
    const added = registry.add({ name: "私有", transport: "http", url: "https://x/mcp" });
    registry.update(added.id, { name: "私有改名" });
    expect(registry.get(added.id)!.name).toBe("私有改名");
    expect(registry.remove(added.id)).toBe(true);
    expect(registry.get(added.id)).toBeUndefined();
  });

  it("旧恢复 API 只是兼容壳：removedPresetIds 恒空、restorePresets 恒 0、restorePreset 只读现有项", () => {
    const registry = new McpRegistry(memStorage(), FIXED_NOW);
    expect(registry.removedPresetIds()).toEqual([]);
    expect(registry.restorePresets()).toBe(0);
    expect(registry.servers()).toHaveLength(SYSTEM_MCP_SERVERS.length);
    const existing = registry.restorePreset("windows-desktop");
    expect(existing?.id).toBe(SYSTEM_IDS[0]);
    expect(existing?.args).toEqual(["windows-mcp", "serve"]);
    // 返回拷贝：改不到内部状态
    existing!.args!.push("tampered");
    expect(registry.get(SYSTEM_IDS[0])!.args).toEqual(["windows-mcp", "serve"]);
    expect(registry.restorePreset("nope")).toBeNull();
    // 定义表外的 id 也不会被凭空补出来
    expect(registry.servers()).toHaveLength(SYSTEM_MCP_SERVERS.length);
  });

  it("升级校正：已被旧版本改过的系统能力按定义表校正，但保留用户 headers/timeoutMs", () => {
    const storage = memStorage({
      [MCP_SERVERS_KEY]: JSON.stringify([
        {
          id: systemMcpServerId("windows-desktop"),
          name: "旧名字",
          transport: "http",
          url: "https://old.example.com/mcp",
          enabled: false,
          origin: "manual",
          headers: { Authorization: "Bearer token" },
          timeoutMs: 12_000,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ]),
    });
    const registry = new McpRegistry(storage, FIXED_NOW);
    const win = registry.get(SYSTEM_IDS[0])!;
    expect(win.name).toBe("Windows 桌面控制");
    expect(win.transport).toBe("stdio");
    expect(win.url).toBeUndefined();
    expect(win.command).toBe("uvx");
    expect(win.enabled).toBe(true);
    expect(win.origin).toBe("preset");
    // 用户数据保留，不被升级覆盖
    expect(win.headers).toEqual({ Authorization: "Bearer token" });
    expect(win.timeoutMs).toBe(12_000);
    expect(win.createdAt).toBe("2026-01-01T00:00:00.000Z");
    // 另一条缺失的被补齐
    expect(registry.get(SYSTEM_IDS[1])).toBeTruthy();
  });

  it("系统能力不参与「可删」判定：删私有服务不影响系统能力与工具授权", () => {
    const registry = new McpRegistry(memStorage(), FIXED_NOW);
    const privateServer = registry.add({ name: "临时", transport: "http", url: "https://x/mcp" });
    registry.autoEnableSafeTools(SYSTEM_IDS[0], [{ name: "Screenshot" }]);
    registry.remove(privateServer.id);
    expect(registry.isToolEnabled(SYSTEM_IDS[0], "Screenshot")).toBe(true);
    expect(registry.servers().filter((s) => SYSTEM_ID_SET.has(s.id))).toHaveLength(SYSTEM_IDS.length);
  });
});

describe("单次请求超时（timeoutMs）", () => {
  it("存的时候夹到 [2s, 600s]，不给无效值", () => {
    const registry = new McpRegistry(memStorage(), () => "2026-01-01T00:00:00.000Z");
    expect(registry.add({ name: "a", transport: "http", url: "https://a/mcp", timeoutMs: 500 })).toMatchObject({
      timeoutMs: 2_000,
    });
    expect(registry.add({ name: "b", transport: "http", url: "https://b/mcp", timeoutMs: 9_999_999 })).toMatchObject({
      timeoutMs: 600_000,
    });
    const plain = registry.add({ name: "c", transport: "http", url: "https://c/mcp" });
    expect(plain).not.toHaveProperty("timeoutMs");
    const bad = registry.add({ name: "d", transport: "http", url: "https://d/mcp", timeoutMs: Number.NaN });
    expect(bad).not.toHaveProperty("timeoutMs");
  });

  it("能穿过存储往返（不是只在内存里改）", () => {
    const storage = memStorage();
    const first = new McpRegistry(storage, () => "2026-01-01T00:00:00.000Z");
    const saved = first.add({ name: "慢", transport: "stdio", command: "node", timeoutMs: 120_000 });
    const reopened = new McpRegistry(storage, () => "2026-01-01T00:00:00.000Z");
    expect(reopened.get(saved.id)?.timeoutMs).toBe(120_000);
  });
});
