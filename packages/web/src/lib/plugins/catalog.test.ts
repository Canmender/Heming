import { describe, it, expect } from "vitest";
import type { CapabilityProvider } from "../capability/index.js";
import type { ToolBridge } from "../agentStream.js";
import type { McpRegistry, McpToolRef } from "../mcp/index.js";
import type { RiskLevel } from "../hitl/types.js";
import { describeCapabilityCatalog } from "./catalog.js";
import { parsePluginManifest } from "./manifest.js";
import { contentFingerprint } from "./integrity.js";
import { pluginServerId, type InstalledPlugin, type PluginStore } from "./store.js";

type FakeTool = { name: string; description?: string; risk?: RiskLevel };

function bridge(tools: FakeTool[]): ToolBridge {
  return {
    tools: tools.map((tool) => ({
      type: "function",
      function: { name: tool.name, description: tool.description ?? "" },
    })),
    execute: async () => ({ text: "", ok: true }),
    meta: (name) => {
      const found = tools.find((tool) => tool.name === name);
      return found?.risk ? { risk: found.risk } : undefined;
    },
  };
}

function provider(id: string, build: CapabilityProvider["build"]): CapabilityProvider {
  return { id, origin: "builtin", build };
}

type FakeMcp = Pick<McpRegistry, "allTools" | "tools" | "servers" | "isToolEnabled">;

function fakeMcp(
  refs: McpToolRef[],
  enabled: Record<string, boolean> = {},
): FakeMcp {
  return {
    allTools: () => refs,
    tools: (serverId) => refs.filter((ref) => ref.serverId === serverId).map((ref) => ref.tool),
    servers: () => [],
    // 默认全部开启；显式关掉的工具放进 enabled 表
    isToolEnabled: (serverId, name) => enabled[`${serverId}::${name}`] !== false,
  };
}

function ref(serverId: string, serverName: string, tool: FakeTool): McpToolRef {
  return { serverId, serverName, tool };
}

type FakePlugins = Pick<PluginStore, "list">;

function installed(
  id: string,
  name: string,
  tools: "none" | "read" | "write",
  servers: { key: string; name: string; url: string }[],
  toolPacks: { id: string; name: string; description?: string; tools: string[] }[] = [],
  enabled = true,
): InstalledPlugin {
  const manifest = parsePluginManifest({
    schemaVersion: 3,
    id,
    name,
    version: "1.0.0",
    permissions: {
      network: servers.map((server) => new URL(server.url).host),
      tools,
    },
    contributions: { mcpServers: servers, toolPacks },
  });
  return {
    manifest,
    enabled,
    skillIds: [],
    fingerprint: contentFingerprint(manifest),
    serverIds: servers.map((server) => pluginServerId(id, server.key)),
    installedAt: "2026-11-03T00:00:00.000Z",
    updatedAt: "2026-11-03T00:00:00.000Z",
  };
}

function fakePlugins(plugins: InstalledPlugin[]): FakePlugins {
  return { list: () => plugins };
}

describe("describeCapabilityCatalog · MCP 工具归属", () => {
  it("plugin: 前缀的服务归到插件，其余归到 MCP 服务名", () => {
    const finance = installed("acme.finance", "财务包", "read", [
      { key: "report", name: "报告服务", url: "https://mcp.acme.com/mcp" },
    ]);
    const mcp = fakeMcp([
      ref("plugin:acme.finance:report", "报告服务", {
        name: "search_docs",
        description: "检索报告",
      }),
      ref("manual-1", "手工服务", { name: "list_items" }),
    ]);

    const catalog = describeCapabilityCatalog({
      mcp,
      plugins: fakePlugins([finance]),
      providers: [],
    });

    expect(catalog.tools).toHaveLength(2);
    expect(catalog.tools[0]).toMatchObject({
      name: "search_docs",
      description: "检索报告",
      ownerKind: "plugin",
      ownerId: "plugin:acme.finance:report",
      ownerLabel: "财务包",
      pluginId: "acme.finance",
      serverId: "plugin:acme.finance:report",
      risk: "read",
      enabled: true,
      editable: true,
    });
    expect(catalog.tools[1]).toMatchObject({
      name: "list_items",
      ownerKind: "mcp",
      ownerLabel: "手工服务",
      serverId: "manual-1",
      risk: "read",
      editable: true,
    });
    expect(catalog.tools[1].pluginId).toBeUndefined();
    expect(catalog.counts).toEqual({ system: 0, mcp: 1, plugin: 1, self: 0, enabled: 2 });
    expect(catalog.blocked).toEqual([]);
  });

  it("工具开关反映到 enabled，并计入 counts.enabled", () => {
    const mcp = fakeMcp([ref("manual-1", "手工服务", { name: "list_items" })], {
      "manual-1::list_items": false,
    });
    const catalog = describeCapabilityCatalog({ mcp, plugins: fakePlugins([]), providers: [] });

    expect(catalog.tools[0].enabled).toBe(false);
    expect(catalog.counts.enabled).toBe(0);
  });

  it("MCP 工具描述缺失时用 tools(serverId) 补", () => {
    const mcp = fakeMcp([ref("manual-1", "手工服务", { name: "list_items" })]);
    const withDescription: FakeMcp = {
      ...mcp,
      tools: (serverId) =>
        serverId === "manual-1" ? [{ name: "list_items", description: "补来的描述" }] : [],
    };
    const catalog = describeCapabilityCatalog({
      mcp: withDescription,
      plugins: fakePlugins([]),
      providers: [],
    });
    expect(catalog.tools[0].description).toBe("补来的描述");
  });
});

describe("describeCapabilityCatalog · 插件风险上限过滤", () => {
  it("声明 read 的插件，写工具进 blocked 而不是 tools", () => {
    const finance = installed("acme.finance", "财务包", "read", [
      { key: "report", name: "报告服务", url: "https://mcp.acme.com/mcp" },
    ]);
    const mcp = fakeMcp([
      ref("plugin:acme.finance:report", "报告服务", { name: "search_docs" }),
      ref("plugin:acme.finance:report", "报告服务", { name: "write_report" }),
    ]);

    const catalog = describeCapabilityCatalog({
      mcp,
      plugins: fakePlugins([finance]),
      providers: [],
    });

    expect(catalog.tools.map((tool) => tool.name)).toEqual(["search_docs"]);
    expect(catalog.blocked).toEqual([
      { name: "write_report", ownerLabel: "财务包", risk: "write", pluginId: "acme.finance" },
    ]);
    expect(catalog.counts.plugin).toBe(1);
    // 被拦下的工具不参与计数
    expect(catalog.counts.enabled).toBe(1);
  });

  it("声明 none 的插件连只读工具也不注入", () => {
    const locked = installed("acme.locked", "只读插件", "none", [
      { key: "data", name: "数据服务", url: "https://data.acme.com/mcp" },
    ]);
    const mcp = fakeMcp([ref("plugin:acme.locked:data", "数据服务", { name: "get_data" })]);

    const catalog = describeCapabilityCatalog({
      mcp,
      plugins: fakePlugins([locked]),
      providers: [],
    });

    expect(catalog.tools).toEqual([]);
    expect(catalog.blocked).toEqual([
      { name: "get_data", ownerLabel: "只读插件", risk: "read", pluginId: "acme.locked" },
    ]);
  });

  it("声明 write 的插件放行写工具（仍由 HITL 判定）", () => {
    const writer = installed("acme.writer", "写入插件", "write", [
      { key: "report", name: "报告服务", url: "https://mcp.acme.com/mcp" },
    ]);
    const mcp = fakeMcp([
      ref("plugin:acme.writer:report", "报告服务", { name: "write_report" }),
    ]);

    const catalog = describeCapabilityCatalog({
      mcp,
      plugins: fakePlugins([writer]),
      providers: [],
    });

    expect(catalog.tools[0]).toMatchObject({ name: "write_report", risk: "write" });
    expect(catalog.blocked).toEqual([]);
  });
});

describe("describeCapabilityCatalog · 内置与自我修改工具", () => {
  it("meta.risk 覆盖名字启发，抛错/返回 null 的提供者跳过", () => {
    const providers = [
      provider("charts", () => bridge([{ name: "chart_types" }, { name: "chart_render" }])),
      // 名字启发是 read（tone_ 前缀），但桥显式声明 write → 以桥为准
      provider("tone", () => bridge([{ name: "tone_detect", risk: "write" }])),
      provider("boom", () => {
        throw new Error("构建失败");
      }),
      provider("empty", () => null),
      // MCP 与 self 必须排除：MCP 单独按 server 展开，self 需要智能体上下文
      provider("mcp", () => bridge([{ name: "should_not_appear" }])),
      provider("self", () => bridge([{ name: "also_not_appear" }])),
    ];

    const catalog = describeCapabilityCatalog({
      mcp: fakeMcp([]),
      plugins: fakePlugins([]),
      providers,
    });

    expect(catalog.tools.map((tool) => tool.name)).toEqual([
      "chart_types",
      "chart_render",
      "tone_detect",
    ]);
    expect(catalog.tools[0]).toMatchObject({ ownerKind: "system", ownerLabel: "系统能力", risk: "read" });
    expect(catalog.tools[2].risk).toBe("write");
    expect(catalog.counts.system).toBe(3);
  });

  it("危险级工具按 write 展示（不会出现 danger 档）", () => {
    const providers = [provider("files", () => bridge([{ name: "self_mcp_remove_server" }]))];
    const catalog = describeCapabilityCatalog({
      mcp: fakeMcp([]),
      plugins: fakePlugins([]),
      providers,
    });
    // self_mcp_remove_server 在 classify 里是 danger，目录口径映射为 write
    expect(catalog.tools[0].risk).toBe("write");
  });

  it("同名工具只留首个：MCP（执行期在前）胜过内置", () => {
    const providers = [
      provider("files", () => bridge([{ name: "search_docs", description: "内置版" }])),
    ];
    const mcp = fakeMcp([ref("manual-1", "手工服务", { name: "search_docs", description: "MCP 版" })]);

    const catalog = describeCapabilityCatalog({
      mcp,
      plugins: fakePlugins([]),
      providers,
    });

    expect(catalog.tools).toHaveLength(1);
    expect(catalog.tools[0]).toMatchObject({ ownerKind: "mcp", description: "MCP 版" });
    expect(catalog.counts).toEqual({ system: 0, mcp: 1, plugin: 0, self: 0, enabled: 1 });
  });

  it("selfAgents 为空时不列 self；给出后按智能体构建并去重", () => {
    const selfProvider = provider("self", (ctx) =>
      ctx.agentId === "agent-1" || ctx.agentId === "agent-2"
        ? bridge([{ name: "self_memory_list" }])
        : null,
    );

    const without = describeCapabilityCatalog({
      mcp: fakeMcp([]),
      plugins: fakePlugins([]),
      providers: [selfProvider],
    });
    expect(without.tools).toEqual([]);
    expect(without.counts.self).toBe(0);

    const withAgents = describeCapabilityCatalog({
      mcp: fakeMcp([]),
      plugins: fakePlugins([]),
      providers: [selfProvider],
      selfAgents: ["agent-1", "agent-2"],
    });
    expect(withAgents.tools).toHaveLength(1);
    expect(withAgents.tools[0]).toMatchObject({
      name: "self_memory_list",
      ownerKind: "self",
      ownerLabel: "自我修改",
      editable: false,
      enabled: true,
    });
    expect(withAgents.counts.self).toBe(1);
  });
});

describe("describeCapabilityCatalog · 工具束归属", () => {
  const server = { key: "report", name: "报告服务", url: "https://mcp.acme.com/mcp" };

  it("匹配目录里的工具、缺的进 unresolved，并给工具标注来源工具束", () => {
    const finance = installed(
      "acme.finance",
      "财务包",
      "read",
      [server],
      [
        {
          id: "report-tools",
          name: "报告工具",
          description: "周报要用到的查询工具",
          tools: ["search_docs", "not_connected_yet"],
        },
      ],
    );
    const mcp = fakeMcp([ref("plugin:acme.finance:report", "报告服务", { name: "search_docs" })]);

    const catalog = describeCapabilityCatalog({
      mcp,
      plugins: fakePlugins([finance]),
      providers: [],
    });

    expect(catalog.toolPacks).toEqual([
      {
        id: "report-tools",
        pluginId: "acme.finance",
        pluginName: "财务包",
        name: "报告工具",
        description: "周报要用到的查询工具",
        tools: ["search_docs", "not_connected_yet"],
        matched: ["search_docs"],
        unresolved: ["not_connected_yet"],
        // entries 与 tools 同序：匹配到带 serverId/开关/风险，未匹配的只有名字
        entries: [
          {
            tool: "search_docs",
            serverId: "plugin:acme.finance:report",
            enabled: true,
            risk: "read",
          },
          { tool: "not_connected_yet", enabled: false, risk: "write" },
        ],
        enabled: true,
      },
    ]);
    expect(catalog.tools[0].toolPacks).toEqual([
      { id: "report-tools", name: "报告工具", pluginId: "acme.finance" },
    ]);
    // 工具束只是归属声明：不改变工具开关与计数
    expect(catalog.tools[0].enabled).toBe(true);
    expect(catalog.counts).toEqual({ system: 0, mcp: 0, plugin: 1, self: 0, enabled: 1 });
  });

  it("工具束不打开任何开关：MCP 工具仍按用户开关展示", () => {
    const finance = installed(
      "acme.finance",
      "财务包",
      "read",
      [server],
      [{ id: "tools", name: "工具束", tools: ["search_docs"] }],
    );
    const mcp = fakeMcp([ref("plugin:acme.finance:report", "报告服务", { name: "search_docs" })], {
      "plugin:acme.finance:report::search_docs": false,
    });

    const catalog = describeCapabilityCatalog({
      mcp,
      plugins: fakePlugins([finance]),
      providers: [],
    });

    expect(catalog.toolPacks[0].matched).toEqual(["search_docs"]);
    expect(catalog.tools[0].enabled).toBe(false);
    expect(catalog.counts.enabled).toBe(0);
  });

  it("插件停用时工具束标记为未启用，但归属仍可展示", () => {
    const finance = installed(
      "acme.finance",
      "财务包",
      "read",
      [server],
      [{ id: "report-tools", name: "报告工具", tools: ["search_docs"] }],
      false,
    );
    const mcp = fakeMcp([ref("plugin:acme.finance:report", "报告服务", { name: "search_docs" })]);

    const catalog = describeCapabilityCatalog({
      mcp,
      plugins: fakePlugins([finance]),
      providers: [],
    });
    expect(catalog.toolPacks[0]).toMatchObject({ enabled: false, matched: ["search_docs"] });
  });

  it("没有工具束的老插件（含 v1/v2 归一化）不产生工具束，工具也不带归属", () => {
    const legacy = installed("acme.legacy", "旧包", "read", [server]);
    const mcp = fakeMcp([ref("plugin:acme.legacy:report", "报告服务", { name: "search_docs" })]);

    const catalog = describeCapabilityCatalog({
      mcp,
      plugins: fakePlugins([legacy]),
      providers: [],
    });
    expect(catalog.toolPacks).toEqual([]);
    expect(catalog.tools[0].toolPacks).toBeUndefined();
  });

  it("全部工具都未连接时 matched 为空、unresolved 全量列出，不报错", () => {
    const finance = installed(
      "acme.finance",
      "财务包",
      "read",
      [server],
      [{ id: "report-tools", name: "报告工具", tools: ["a_tool", "b_tool"] }],
    );
    const catalog = describeCapabilityCatalog({
      mcp: fakeMcp([]),
      plugins: fakePlugins([finance]),
      providers: [],
    });
    expect(catalog.toolPacks[0].matched).toEqual([]);
    expect(catalog.toolPacks[0].unresolved).toEqual(["a_tool", "b_tool"]);
    expect(catalog.tools).toEqual([]);
    expect(catalog.toolPacks[0].entries).toEqual([
      { tool: "a_tool", enabled: false, risk: "write" },
      { tool: "b_tool", enabled: false, risk: "write" },
    ]);
  });

  it("entries 透出每个工具的 serverId、开关与风险，供详情页逐个授权", () => {
    const finance = installed(
      "acme.finance",
      "财务包",
      // 声明 write 上限：export_report 的风险是 write，否则会被上限过滤进 blocked，
      // 这里要测的是「已注入但被用户关掉」的工具，所以放宽上限。
      "write",
      [server],
      [
        {
          id: "report-tools",
          name: "报告工具",
          tools: ["search_docs", "export_report", "ghost_tool"],
        },
      ],
    );
    // search_docs 开启、export_report 被用户关掉；ghost_tool 服务未提供
    const mcp = fakeMcp(
      [
        ref("plugin:acme.finance:report", "报告服务", { name: "search_docs" }),
        ref("plugin:acme.finance:report", "报告服务", { name: "export_report" }),
      ],
      { "plugin:acme.finance:report::export_report": false },
    );

    const catalog = describeCapabilityCatalog({
      mcp,
      plugins: fakePlugins([finance]),
      providers: [],
    });

    expect(catalog.toolPacks[0].entries).toEqual([
      {
        tool: "search_docs",
        serverId: "plugin:acme.finance:report",
        enabled: true,
        risk: "read",
      },
      {
        tool: "export_report",
        serverId: "plugin:acme.finance:report",
        enabled: false,
        risk: "write",
      },
      // 未匹配：没有 serverId，开关恒关，风险按名字启发兜底
      { tool: "ghost_tool", enabled: false, risk: "write" },
    ]);
    // entries 顺序与声明顺序一致；老字段仍在（兼容）
    expect(catalog.toolPacks[0].entries.map((entry) => entry.tool)).toEqual(
      catalog.toolPacks[0].tools,
    );
    expect(catalog.toolPacks[0].matched).toEqual(["search_docs", "export_report"]);
    expect(catalog.toolPacks[0].unresolved).toEqual(["ghost_tool"]);
  });
});
