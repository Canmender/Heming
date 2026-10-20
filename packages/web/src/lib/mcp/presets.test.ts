import { describe, it, expect } from "vitest";
import { MCP_PRESETS, DEFAULT_PRESET_SERVERS, findMcpPreset } from "./presets.js";
import { McpRegistry, MCP_SERVERS_KEY } from "./store.js";

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

/** 一条用户自己配的服务（用于验证预置不干扰既有配置）。 */
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

describe("MCP 服务预设", () => {
  it("每条预设都有名称、传输方式、说明与可执行的入口", () => {
    expect(MCP_PRESETS.length).toBeGreaterThan(0);
    for (const p of MCP_PRESETS) {
      expect(p.name.length).toBeGreaterThan(0);
      expect(["http", "stdio"]).toContain(p.transport);
      expect(p.hint.length).toBeGreaterThan(10);
      if (p.transport === "http") expect(p.url).toBeTruthy();
      else expect(p.command).toBeTruthy();
    }
  });

  it("Windows 桌面控制预设给出可直接用的 uvx 命令", () => {
    const p = findMcpPreset("windows-desktop");
    expect(p).not.toBeNull();
    expect(p!.transport).toBe("stdio");
    expect(p!.command).toBe("uvx");
    expect(p!.args).toEqual(["windows-mcp", "serve"]);
    // 该服务依赖 Windows UI Automation，必须在 Windows 侧跑
    expect(p!.verified).toBe(true);
  });

  it("未知 id 返回 null（界面据此忽略点击，不崩）", () => {
    expect(findMcpPreset("查无此预设")).toBeNull();
  });

  it("预设能直接喂给 registry.add —— 验证不会撞上参数校验", () => {
    // 用「已有配置」绕开首次预置，让 add 的结果可单独核对
    const storage = memStorage({ [MCP_SERVERS_KEY]: JSON.stringify([myOwnServer()]) });
    const registry = new McpRegistry(storage, FIXED_NOW);
    for (const p of MCP_PRESETS) {
      const saved = registry.add({
        name: p.name,
        transport: p.transport,
        url: p.url,
        command: p.command,
        args: p.args,
      });
      expect(saved.id).toBeTruthy();
    }
    // 1 条自有 + 2 条预设
    expect(registry.servers()).toHaveLength(1 + MCP_PRESETS.length);
  });
});

describe("默认接入（首次预置 Windows 桌面控制）", () => {
  it("存储为空时自动预置，命令参数开箱可用", () => {
    const storage = memStorage();
    const registry = new McpRegistry(storage, FIXED_NOW);
    const servers = registry.servers();
    expect(servers).toHaveLength(DEFAULT_PRESET_SERVERS.length);
    const win = servers[0];
    expect(win.name).toBe("Windows 桌面控制");
    expect(win.transport).toBe("stdio");
    expect(win.command).toBe("uvx");
    expect(win.args).toEqual(["windows-mcp", "serve"]);
    expect(win.enabled).toBe(true);
    expect(registry.isPreset(win.id)).toBe(true);
    // 已落盘，刷新后仍在
    expect(storage.raw.has(MCP_SERVERS_KEY)).toBe(true);
  });

  it("预置两条：Windows 桌面控制与网页抓取；文件系统那条不预置（带具体路径）", () => {
    const registry = new McpRegistry(memStorage(), FIXED_NOW);
    const names = registry.servers().map((s) => s.name);
    expect(names).toEqual(["Windows 桌面控制", "网页抓取（Scrapling）"]);
    // 文件系统那条带 `D:/Heming` 这样的具体路径，对不同用户是错的，不预置
    expect(DEFAULT_PRESET_SERVERS.some((p) => p.id === "filesystem")).toBe(false);
  });

  it("两条预置各有独立 id（共用一个会导致互相覆盖、删除记录串台）", () => {
    const registry = new McpRegistry(memStorage(), FIXED_NOW);
    const ids = registry.servers().map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("mcp-windows-desktop");
    expect(ids).toContain("mcp-scrapling");
  });

  it("删掉一条预置，另一条不受影响（也不会被塞回来）", () => {
    const storage = memStorage();
    const first = new McpRegistry(storage, FIXED_NOW);
    const scrapling = first.servers().find((s) => s.id === "mcp-scrapling");
    expect(scrapling).toBeDefined();
    first.remove(scrapling!.id);
    // 删掉的那条不再回来，另一条仍在
    const second = new McpRegistry(storage, FIXED_NOW);
    const ids = second.servers().map((s) => s.id);
    expect(ids).not.toContain("mcp-scrapling");
    expect(ids).toContain("mcp-windows-desktop");
  });

  it("Scrapling 只自动启用只读那批；browser_actions / browser_evaluate 不开", () => {
    const registry = new McpRegistry(memStorage(), FIXED_NOW);
    const id = registry.servers().find((s) => s.id === "mcp-scrapling")!.id;
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

  it("两条预置的白名单互不串台（Windows-MCP 的 Screenshot 不该开在 Scrapling 上）", () => {
    const registry = new McpRegistry(memStorage(), FIXED_NOW);
    const scraplingId = registry.servers().find((s) => s.id === "mcp-scrapling")!.id;
    const winId = registry.servers().find((s) => s.id === "mcp-windows-desktop")!.id;
    // 在 Scrapling 上发现 Windows-MCP 的工具名 → 不该被自动启用
    registry.autoEnableSafeTools(scraplingId, [{ name: "Screenshot" }, { name: "Snapshot" }]);
    expect(registry.isToolEnabled(scraplingId, "Screenshot")).toBe(false);
    // 反之亦然
    registry.autoEnableSafeTools(winId, [{ name: "make_request" }]);
    expect(registry.isToolEnabled(winId, "make_request")).toBe(false);
  });

  it("用户已有配置时不动他的数据（不塞预置进去）", () => {
    const storage = memStorage({ [MCP_SERVERS_KEY]: JSON.stringify([myOwnServer()]) });
    const registry = new McpRegistry(storage, FIXED_NOW);
    expect(registry.servers()).toHaveLength(1);
    expect(registry.servers()[0].name).toBe("我自己的服务");
  });

  it("用户把预置全删完后不会被再塞回来", () => {
    const storage = memStorage();
    const first = new McpRegistry(storage, FIXED_NOW);
    for (const s of [...first.servers()]) first.remove(s.id);
    expect(first.servers()).toHaveLength(0);
    // 再开一次应用：存储里已是空数组，但仍视为「用户主动删过」，不再预置
    const second = new McpRegistry(storage, FIXED_NOW);
    expect(second.servers()).toHaveLength(0);
  });

  it("只自动启用只读工具；PowerShell / Registry / Click 一律不开", () => {
    const registry = new McpRegistry(memStorage(), FIXED_NOW);
    const id = registry.servers()[0].id;
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
    const id = registry.servers()[0].id;
    const tools = [{ name: "Screenshot" }];
    registry.autoEnableSafeTools(id, tools);
    registry.setToolEnabled(id, "Screenshot", false); // 用户主动关掉
    expect(registry.autoEnableSafeTools(id, tools)).toEqual([]);
    expect(registry.isToolEnabled(id, "Screenshot")).toBe(false);
  });

  it("非预置服务不会被自动启用任何工具", () => {
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
    const safe = findMcpPreset("windows-desktop")!.safeTools ?? [];
    for (const name of safe) {
      expect(forbidden).not.toContain(name);
    }
  });
});