import { describe, it, expect } from "vitest";
import {
  SYSTEM_MCP_SERVERS,
  SYSTEM_WINDOWS_DESKTOP_ID,
  SYSTEM_SCRAPLING_ID,
  DEFAULT_PRESET_SERVERS,
  MCP_PRESETS,
  findSystemMcpServer,
  findMcpPreset,
  isSystemMcpServer,
  systemMcpServerId,
} from "./presets.js";
import { McpRegistry, MCP_SERVERS_KEY } from "./store.js";

/**
 * 系统能力定义表（d.147.4.93.11）。
 *
 * 旧名 `MCP_PRESETS` / `findMcpPreset` 仍作为 @deprecated 别名导出，
 * 新代码只用 `SYSTEM_MCP_SERVERS` / `findSystemMcpServer`。
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

const FIXED_NOW = () => "2026-10-20T00:00:00.000Z";

/** 一条用户自己配的服务（用于验证系统能力不干扰既有配置）。 */
function myOwnServer() {
  return {
    id: "mine",
    name: "我自己的服务",
    transport: "http",
    url: "https://x.com/mcp",
    enabled: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("MCP 系统能力定义表", () => {
  it("每条定义都有名称、传输方式、说明与可执行的入口", () => {
    expect(SYSTEM_MCP_SERVERS.length).toBeGreaterThan(0);
    for (const p of SYSTEM_MCP_SERVERS) {
      expect(p.name.length).toBeGreaterThan(0);
      expect(["http", "stdio"]).toContain(p.transport);
      expect(p.hint.length).toBeGreaterThan(10);
      if (p.transport === "http") expect(p.url).toBeTruthy();
      else expect(p.command).toBeTruthy();
    }
  });

  it("Windows 桌面控制给出可直接用的 uvx 命令", () => {
    const p = findSystemMcpServer("windows-desktop");
    expect(p).not.toBeNull();
    expect(p!.id).toBe("windows-desktop");
    expect(p!.transport).toBe("stdio");
    expect(p!.command).toBe("uvx");
    expect(p!.args).toEqual(["windows-mcp", "serve"]);
    // 该服务依赖 Windows UI Automation，必须在 Windows 侧跑
    expect(p!.verified).toBe(true);
  });

  it("两条定义各自的落盘 id 固定（升级后旧数据能对上）", () => {
    expect(systemMcpServerId("windows-desktop")).toBe(SYSTEM_WINDOWS_DESKTOP_ID);
    expect(systemMcpServerId("windows-desktop")).toBe("mcp-windows-desktop");
    expect(systemMcpServerId("scrapling")).toBe(SYSTEM_SCRAPLING_ID);
    expect(systemMcpServerId("scrapling")).toBe("mcp-scrapling");
    // 未知定义 id 也有稳定的兜底命名
    expect(systemMcpServerId("whatever")).toBe("mcp-whatever");
  });

  it("isSystemMcpServer 按落盘 id 判定，不依赖列表里是否存在", () => {
    expect(isSystemMcpServer(SYSTEM_WINDOWS_DESKTOP_ID)).toBe(true);
    expect(isSystemMcpServer(SYSTEM_SCRAPLING_ID)).toBe(true);
    expect(isSystemMcpServer("mine")).toBe(false);
    expect(isSystemMcpServer("windows-desktop")).toBe(false);
  });

  it("未知 id 返回 null（界面据此忽略点击，不崩）", () => {
    expect(findSystemMcpServer("查无此预设")).toBeNull();
  });

  it("旧的 @deprecated 别名指向同一份定义（不复制、不漂移）", () => {
    expect(MCP_PRESETS).toBe(SYSTEM_MCP_SERVERS);
    expect(DEFAULT_PRESET_SERVERS).toBe(SYSTEM_MCP_SERVERS);
    expect(findMcpPreset("windows-desktop")).toBe(findSystemMcpServer("windows-desktop"));
  });
});

describe("系统能力自动补齐", () => {
  it("存储为空时补齐两条，命令参数开箱可用并已落盘", () => {
    const storage = memStorage();
    const registry = new McpRegistry(storage, FIXED_NOW);
    const servers = registry.servers();
    expect(servers).toHaveLength(SYSTEM_MCP_SERVERS.length);
    const win = servers[0];
    expect(win.id).toBe(SYSTEM_WINDOWS_DESKTOP_ID);
    expect(win.name).toBe("Windows 桌面控制");
    expect(win.transport).toBe("stdio");
    expect(win.command).toBe("uvx");
    expect(win.args).toEqual(["windows-mcp", "serve"]);
    expect(win.enabled).toBe(true);
    expect(win.origin).toBe("preset");
    expect(registry.isSystem(win.id)).toBe(true);
    // 已落盘，刷新后仍在
    expect(storage.raw.has(MCP_SERVERS_KEY)).toBe(true);
  });

  it("两条系统能力：Windows 桌面控制与网页抓取；文件系统那条不再内置", () => {
    const registry = new McpRegistry(memStorage(), FIXED_NOW);
    const names = registry.servers().map((s) => s.name);
    expect(names).toEqual(["Windows 桌面控制", "网页抓取（Scrapling）"]);
    // 文件系统那条带 `D:/Heming` 这样的具体路径，对不同用户是错的，不内置
    expect(SYSTEM_MCP_SERVERS.some((p) => p.id === "filesystem")).toBe(false);
  });

  it("两条系统能力各有独立 id（共用一个会导致互相覆盖、工具授权串台）", () => {
    const registry = new McpRegistry(memStorage(), FIXED_NOW);
    const ids = registry.servers().map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain(SYSTEM_WINDOWS_DESKTOP_ID);
    expect(ids).toContain(SYSTEM_SCRAPLING_ID);
  });

  it("系统能力删不掉：remove 返回 false，重启后两条都在", () => {
    const storage = memStorage();
    const first = new McpRegistry(storage, FIXED_NOW);
    for (const s of [...first.servers()]) {
      expect(first.remove(s.id)).toBe(false);
    }
    expect(first.servers()).toHaveLength(SYSTEM_MCP_SERVERS.length);
    const second = new McpRegistry(storage, FIXED_NOW);
    expect(second.servers().map((s) => s.id)).toEqual(
      SYSTEM_MCP_SERVERS.map((p) => systemMcpServerId(p.id)),
    );
  });

  it("用户已有配置时也补系统能力，但不动用户的数据", () => {
    const storage = memStorage({ [MCP_SERVERS_KEY]: JSON.stringify([myOwnServer()]) });
    const registry = new McpRegistry(storage, FIXED_NOW);
    expect(registry.servers()).toHaveLength(1 + SYSTEM_MCP_SERVERS.length);
    const mine = registry.get("mine")!;
    expect(mine.name).toBe("我自己的服务");
    expect(mine.url).toBe("https://x.com/mcp");
  });

  it("Scrapling 只自动启用只读那批；browser_actions / browser_evaluate 不开", () => {
    const registry = new McpRegistry(memStorage(), FIXED_NOW);
    const id = SYSTEM_SCRAPLING_ID;
    const enabled = registry.autoEnableSafeTools(id, [
      { name: "make_request" }, // 纯 HTTP 读
      { name: "browser_fetch_once" }, // 隐身浏览器读页面
      { name: "browser_extract" }, // 读当前页内容
      { name: "browser_screenshot" }, // 截图
      { name: "browser_actions" }, // 能点击填表提交 → 不开
      { name: "browser_evaluate" }, // 能执行任意 JS → 不开
      { name: "browser_save_state" }, // 往本机磁盘写登录态 → 不开
      { name: "browser_load_state" }, // 读本机登录态文件 → 不开
    ]);
    expect(enabled.sort()).toEqual(
      ["browser_extract", "browser_fetch_once", "browser_screenshot", "make_request"].sort(),
    );
    expect(registry.isToolEnabled(id, "browser_actions")).toBe(false);
    expect(registry.isToolEnabled(id, "browser_evaluate")).toBe(false);
    expect(registry.isToolEnabled(id, "browser_save_state")).toBe(false);
  });

  it("两条系统能力的白名单互不串台（Windows-MCP 的 Screenshot 不该开在 Scrapling 上）", () => {
    const registry = new McpRegistry(memStorage(), FIXED_NOW);
    const scraplingId = SYSTEM_SCRAPLING_ID;
    const winId = SYSTEM_WINDOWS_DESKTOP_ID;
    // 在 Scrapling 上发现 Windows-MCP 的工具名 → 不该被自动启用
    registry.autoEnableSafeTools(scraplingId, [{ name: "Screenshot" }, { name: "Snapshot" }]);
    expect(registry.isToolEnabled(scraplingId, "Screenshot")).toBe(false);
    // 反之亦然
    registry.autoEnableSafeTools(winId, [{ name: "make_request" }]);
    expect(registry.isToolEnabled(winId, "make_request")).toBe(false);
  });

  it("只自动启用只读工具；PowerShell / Registry / Click 一律不开", () => {
    const registry = new McpRegistry(memStorage(), FIXED_NOW);
    const id = SYSTEM_WINDOWS_DESKTOP_ID;
    const enabled = registry.autoEnableSafeTools(id, [
      { name: "Screenshot" },
      { name: "Snapshot" },
      { name: "PowerShell" }, // 高危：能执行任意命令
      { name: "Registry" }, // 高危：能改系统注册表
      { name: "Click" }, // 会改桌面状态
      { name: "FileSystem" }, // 能删文件
      { name: "Process" }, // list 只读但 kill 是写操作，按工具名无法区分 → 不开
      { name: "Clipboard" }, // 同上（get 只读 / set 是写）
    ]);
    expect(enabled.sort()).toEqual(["Screenshot", "Snapshot"]);
    expect(registry.isToolEnabled(id, "Screenshot")).toBe(true);
    expect(registry.isToolEnabled(id, "Snapshot")).toBe(true);
    expect(registry.isToolEnabled(id, "PowerShell")).toBe(false);
    expect(registry.isToolEnabled(id, "Registry")).toBe(false);
    expect(registry.isToolEnabled(id, "Click")).toBe(false);
    expect(registry.isToolEnabled(id, "FileSystem")).toBe(false);
    expect(registry.isToolEnabled(id, "Process")).toBe(false);
    expect(registry.isToolEnabled(id, "Clipboard")).toBe(false);
  });

  it("用户手动关掉的只读工具，不会被再次自动打开", () => {
    const registry = new McpRegistry(memStorage(), FIXED_NOW);
    const id = SYSTEM_WINDOWS_DESKTOP_ID;
    const tools = [{ name: "Screenshot" }];
    registry.autoEnableSafeTools(id, tools);
    registry.setToolEnabled(id, "Screenshot", false); // 用户主动关掉
    expect(registry.autoEnableSafeTools(id, tools)).toEqual([]);
    expect(registry.isToolEnabled(id, "Screenshot")).toBe(false);
  });

  it("私有服务不会被自动启用任何工具", () => {
    const storage = memStorage({ [MCP_SERVERS_KEY]: JSON.stringify([myOwnServer()]) });
    const registry = new McpRegistry(storage, FIXED_NOW);
    expect(registry.autoEnableSafeTools("mine", [{ name: "Screenshot" }])).toEqual([]);
    expect(registry.isToolEnabled("mine", "Screenshot")).toBe(false);
  });

  it("【安全底线】白名单里不含任何写/执行类工具", () => {
    const forbidden = [
      "PowerShell",
      "Registry",
      "FileSystem",
      "Click",
      "Type",
      "Move",
      "Shortcut",
      "MultiEdit",
      "MultiSelect",
      "Scroll",
      "App",
      "Process",
      "Notification",
    ];
    for (const system of SYSTEM_MCP_SERVERS) {
      for (const name of system.safeTools ?? []) {
        expect(forbidden).not.toContain(name);
      }
    }
  });
});
