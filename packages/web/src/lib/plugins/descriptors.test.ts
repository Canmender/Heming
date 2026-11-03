import { describe, it, expect } from "vitest";
import type { CapabilityProvider } from "../capability/index.js";
import type { ToolBridge } from "../agentStream.js";
import type { McpRegistry, McpServerConfig, McpToolRef } from "../mcp/index.js";
import type { SkillDefinition } from "../skills/index.js";
import type { InstalledPlugin, PluginStore } from "./store.js";
import { contentFingerprint, parsePluginManifest, pluginServerId } from "./index.js";
import { describeCapabilities } from "./descriptors.js";
import { SYSTEM_PLUGIN_ID, SYSTEM_PLUGIN_NAME } from "./system.js";

function skill(overrides: Partial<SkillDefinition> = {}): SkillDefinition {
  return {
    id: "builtin-1",
    name: "内置技能",
    description: "内置说明",
    instructions: "做点什么。",
    triggers: [],
    tags: [],
    enabled: true,
    builtin: true,
    version: "1.0.0",
    source: "builtin",
    createdAt: "2026-11-03T00:00:00.000Z",
    updatedAt: "2026-11-03T00:00:00.000Z",
    ...overrides,
  };
}

function serverConfig(overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    id: "preset-1",
    name: "预置服务",
    transport: "http",
    url: "https://mcp.example.com/mcp",
    enabled: true,
    createdAt: "2026-11-03T00:00:00.000Z",
    updatedAt: "2026-11-03T00:00:00.000Z",
    origin: "preset",
    ...overrides,
  };
}

function toolRef(serverId: string, serverName: string, name: string, description = ""): McpToolRef {
  return { serverId, serverName, tool: { name, description } };
}

type FakeMcp = Pick<McpRegistry, "allTools" | "tools" | "servers" | "isToolEnabled" | "isPreset">;

function fakeMcp(
  servers: McpServerConfig[],
  refs: McpToolRef[],
  presetIds: Set<string>,
  enabled: Record<string, boolean> = {},
): FakeMcp {
  return {
    allTools: () => refs,
    tools: (serverId) => refs.filter((ref) => ref.serverId === serverId).map((ref) => ref.tool),
    servers: () => servers,
    isToolEnabled: (serverId, name) => enabled[`${serverId}::${name}`] !== false,
    isPreset: (id) => presetIds.has(id),
  };
}

function bridge(tools: { name: string; description?: string; risk?: "read" | "write" | "danger" }[]): ToolBridge {
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

type FakePlugins = Pick<PluginStore, "list">;

function installed(
  id: string,
  name: string,
  commands: { id: string; title: string; target: Record<string, unknown> }[],
  enabled = true,
): InstalledPlugin {
  const manifest = parsePluginManifest({
    schemaVersion: 3,
    id,
    name,
    version: "1.0.0",
    contributions: { commands: commands.map((command) => ({ ...command, target: command.target })) },
  });
  return {
    manifest,
    enabled,
    skillIds: [],
    fingerprint: contentFingerprint(manifest),
    serverIds: [],
    installedAt: "2026-11-03T00:00:00.000Z",
    updatedAt: "2026-11-03T00:00:00.000Z",
  };
}

function setup(): {
  skills: { list: () => SkillDefinition[] };
  mcp: FakeMcp;
  plugins: FakePlugins;
  providers: CapabilityProvider[];
} {
  const finance = installed("acme.finance", "财务包", [
    { id: "open-home", title: "打开主页", target: { kind: "page", page: "home" } },
  ]);
  const disabled = installed(
    "acme.off",
    "停用包",
    [{ id: "hidden", title: "不该出现", target: { kind: "plugin" } }],
    false,
  );

  return {
    skills: {
      list: () => [
        skill({ id: "builtin-1", name: "内置技能" }),
        skill({ id: "user-1", name: "用户技能", source: "user", builtin: false }),
        skill({
          id: "plugin-skill",
          name: "插件技能",
          source: "imported",
          builtin: false,
          pluginId: "acme.finance",
        }),
        skill({ id: "off-1", name: "禁用的内置技能", enabled: false }),
      ],
    },
    mcp: fakeMcp(
      [
        serverConfig({ id: "preset-1", name: "预置服务" }),
        serverConfig({
          id: pluginServerId("acme.finance", "report"),
          name: "报告服务",
          url: "https://mcp.acme.com/mcp",
          origin: "plugin",
        }),
        serverConfig({ id: "manual-1", name: "手工服务", url: "https://manual.example.com/mcp", origin: "manual" }),
        serverConfig({ id: "registry-1", name: "Registry 服务", url: "https://registry.example.com/mcp", origin: "registry" }),
      ],
      [
        toolRef("preset-1", "预置服务", "preset_tool"),
        toolRef(pluginServerId("acme.finance", "report"), "报告服务", "search_docs"),
        toolRef("manual-1", "手工服务", "list_items"),
      ],
      new Set(["preset-1"]),
      { "manual-1::list_items": false },
    ),
    plugins: { list: () => [finance, disabled] },
    providers: [
      provider("charts", () => bridge([{ name: "chart_render", description: "生成图表", risk: "write" }])),
      // self 工具：只有给出 selfAgents 才出现
      provider("self", (ctx) =>
        ctx.agentId === "agent-1" ? bridge([{ name: "self_memory_list" }]) : null,
      ),
    ],
  };
}

const SELF_AGENTS = ["agent-1"];

describe("describeCapabilities · 归属矩阵", () => {
  it("技能：有 pluginId → 插件，否则 → 系统能力", () => {
    const snapshot = describeCapabilities({ ...setup(), selfAgents: SELF_AGENTS });
    const skills = snapshot.descriptors.filter((descriptor) => descriptor.kind === "skill");

    expect(skills.map((descriptor) => [descriptor.name, descriptor.ownerKind, descriptor.ownerName])).toEqual([
      ["内置技能", "system", SYSTEM_PLUGIN_NAME],
      ["用户技能", "system", SYSTEM_PLUGIN_NAME],
      ["插件技能", "plugin", "财务包"],
      ["禁用的内置技能", "system", SYSTEM_PLUGIN_NAME],
    ]);
    expect(skills[0]).toMatchObject({
      id: "skill:builtin-1",
      ownerId: SYSTEM_PLUGIN_ID,
      enabled: true,
      description: "内置说明",
    });
    expect(skills[2]).toMatchObject({ pluginId: "acme.finance", enabled: true });
    expect(skills[3].enabled).toBe(false);
    expect(skills[0].risk).toBeUndefined();
  });

  it("服务：preset → 系统、plugin 前缀 → 插件、manual/registry → MCP 服务", () => {
    const snapshot = describeCapabilities({ ...setup(), selfAgents: SELF_AGENTS });
    const servers = snapshot.descriptors.filter((descriptor) => descriptor.kind === "mcp");

    expect(
      servers.map((descriptor) => [descriptor.name, descriptor.ownerKind, descriptor.ownerName]),
    ).toEqual([
      ["预置服务", "system", SYSTEM_PLUGIN_NAME],
      ["报告服务", "plugin", "财务包"],
      ["手工服务", "mcp", "手工服务"],
      ["Registry 服务", "mcp", "Registry 服务"],
    ]);
    expect(servers[0]).toMatchObject({
      id: "mcp:preset-1",
      ownerId: SYSTEM_PLUGIN_ID,
      serverId: "preset-1",
      description: "https://mcp.example.com/mcp",
      enabled: true,
    });
    expect(servers[1]).toMatchObject({
      ownerId: "acme.finance",
      pluginId: "acme.finance",
      serverId: "plugin:acme.finance:report",
    });
    expect(servers[0].pluginId).toBeUndefined();
  });

  it("工具：按目录归属；self 归 mcp 档、名字记「自我修改」；风险只在工具上", () => {
    const snapshot = describeCapabilities({ ...setup(), selfAgents: SELF_AGENTS });
    const tools = snapshot.descriptors.filter((descriptor) => descriptor.kind === "tool");

    expect(tools.map((descriptor) => [descriptor.name, descriptor.ownerKind, descriptor.ownerName])).toEqual([
      ["preset_tool", "mcp", "预置服务"],
      ["search_docs", "plugin", "财务包"],
      ["list_items", "mcp", "手工服务"],
      ["chart_render", "system", SYSTEM_PLUGIN_NAME],
      ["self_memory_list", "mcp", "自我修改"],
    ]);
    // 名字里没有读意图词、也没有显式标注 → 按 write 兜底（宁可多问一次）
    expect(tools[0]).toMatchObject({ id: "tool:preset_tool", ownerId: "preset-1", risk: "write" });
    expect(tools[1]).toMatchObject({ pluginId: "acme.finance", serverId: "plugin:acme.finance:report" });
    // 手工服务的工具被用户关掉 → enabled=false，但不含 MCP 服务本身的启用位
    expect(tools[2].enabled).toBe(false);
    expect(tools[3]).toMatchObject({ ownerId: SYSTEM_PLUGIN_ID, risk: "write" });
    expect(tools[4]).toMatchObject({ ownerId: "self", enabled: true, risk: "read" });
  });

  it("命令：只列启用中插件的命令", () => {
    const snapshot = describeCapabilities({ ...setup(), selfAgents: SELF_AGENTS });
    const commands = snapshot.descriptors.filter((descriptor) => descriptor.kind === "command");

    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      id: "command:plugin:acme.finance:open-home",
      kind: "command",
      name: "打开主页",
      ownerKind: "plugin",
      ownerId: "acme.finance",
      ownerName: "财务包",
      pluginId: "acme.finance",
      enabled: true,
    });
  });
});

describe("describeCapabilities · counts", () => {
  it("total/enabled/byKind/byOwner 与描述符一致", () => {
    const snapshot = describeCapabilities({ ...setup(), selfAgents: SELF_AGENTS });
    const { descriptors, counts } = snapshot;

    expect(counts.total).toBe(descriptors.length);
    expect(counts.enabled).toBe(descriptors.filter((descriptor) => descriptor.enabled).length);
    expect(counts.byKind).toEqual({
      skill: 4,
      tool: 5,
      mcp: 4,
      command: 1,
    });
    expect(counts.byOwner).toEqual({
      system: 3 + 1 + 1, // 技能 3（内置 + 用户 + 禁用的内置） + 预置服务 1 + 系统工具 1
      plugin: 1 + 1 + 1 + 1, // 插件技能 + 插件服务 + 插件工具 + 命令
      mcp: 2 + 2 + 1, // 手工/Registry 服务 + 手工/self 工具
    });
    expect(counts.total).toBe(14);
  });

  it("系统插件计数取自 describeSystemPlugin（技能只算内置，installed 恒为 1）", () => {
    const snapshot = describeCapabilities({ ...setup(), selfAgents: SELF_AGENTS });

    expect(snapshot.counts.systemPlugin).toEqual({
      installed: 1,
      skills: 2,
      tools: 1,
      servers: 1,
    });
    expect(snapshot.system.id).toBe(SYSTEM_PLUGIN_ID);
    expect(snapshot.system.contributions.skills.map((item) => item.name)).toEqual([
      "内置技能",
      "禁用的内置技能",
    ]);
  });

  it("selfAgents 为空时不列 self 工具，byOwner.mcp 相应减少", () => {
    const snapshot = describeCapabilities({ ...setup() });
    expect(snapshot.descriptors.some((descriptor) => descriptor.name === "self_memory_list")).toBe(false);
    expect(snapshot.counts.byOwner.mcp).toBe(4);
    expect(snapshot.counts.total).toBe(13);
  });
});
