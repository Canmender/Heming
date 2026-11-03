import { describe, it, expect, vi } from "vitest";
import type { CapabilityProvider } from "../capability/index.js";
import type { ToolBridge } from "../agentStream.js";
import type { McpRegistry, McpServerConfig } from "../mcp/index.js";
import type { SkillDefinition } from "../skills/index.js";
import { describeSystemPlugin, SYSTEM_PLUGIN_ID, SYSTEM_PLUGIN_NAME } from "./system.js";
import { PLUGINS_KEY } from "./store.js";

function skill(overrides: Partial<SkillDefinition> = {}): SkillDefinition {
  return {
    id: "s1",
    name: "内置技能",
    description: "",
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

function fakeSkills(items: SkillDefinition[]): { list: () => SkillDefinition[] } {
  return { list: () => items };
}

function fakeMcp(
  servers: McpServerConfig[],
  presetIds: Set<string>,
): Pick<McpRegistry, "servers" | "isPreset"> {
  return { servers: () => servers, isPreset: (id) => presetIds.has(id) };
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

describe("describeSystemPlugin · 只读系统插件", () => {
  it("恒定形状：置顶、不可卸载/停用、无命令", () => {
    const plugin = describeSystemPlugin({ skills: fakeSkills([]), mcp: fakeMcp([], new Set()), providers: [] });

    expect(plugin.id).toBe(SYSTEM_PLUGIN_ID);
    expect(plugin.id).toBe("heming.core");
    expect(plugin.name).toBe(SYSTEM_PLUGIN_NAME);
    expect(plugin.name).toBe("系统能力");
    expect(plugin.version).toBe("1.0.0");
    expect(plugin.pinned).toBe(true);
    expect(plugin.uninstallable).toBe(false);
    expect(plugin.enabled).toBe(true);
    expect(plugin.contributions.commands).toEqual([]);
    expect(plugin.counts).toEqual({ skills: 0, servers: 0, tools: 0, commands: 0 });
  });

  it("技能只收 source=builtin，透出启用位", () => {
    const plugin = describeSystemPlugin({
      skills: fakeSkills([
        skill({ id: "b1", name: "内置甲", enabled: true }),
        skill({ id: "b2", name: "内置乙", enabled: false }),
        skill({ id: "u1", name: "用户技能", source: "user", builtin: false }),
        skill({ id: "p1", name: "插件技能", source: "imported", builtin: false, pluginId: "acme.x" }),
      ]),
      mcp: fakeMcp([], new Set()),
      providers: [],
    });

    expect(plugin.contributions.skills).toEqual([
      { id: "b1", name: "内置甲", description: "", enabled: true },
      { id: "b2", name: "内置乙", description: "", enabled: false },
    ]);
    expect(plugin.counts.skills).toBe(2);
  });

  it("服务只收预置（isPreset），url 缺省为空、preset 恒 true", () => {
    const plugin = describeSystemPlugin({
      skills: fakeSkills([]),
      mcp: fakeMcp(
        [
          serverConfig({ id: "preset-1", name: "预置甲" }),
          serverConfig({ id: "manual-1", name: "手工", url: "https://manual.example.com/mcp", origin: "manual" }),
          serverConfig({ id: "cwd", name: "无地址", url: undefined, origin: "preset", enabled: false }),
        ],
        new Set(["preset-1", "cwd"]),
      ),
      providers: [],
    });

    expect(plugin.contributions.servers).toEqual([
      { id: "preset-1", name: "预置甲", url: "https://mcp.example.com/mcp", enabled: true, preset: true },
      { id: "cwd", name: "无地址", url: "", enabled: false, preset: true },
    ]);
    expect(plugin.counts.servers).toBe(2);
  });

  it("工具只收能力目录里 ownerKind=system 的内置工具，风险按目录口径", () => {
    const plugin = describeSystemPlugin({
      skills: fakeSkills([]),
      mcp: fakeMcp([], new Set()),
      providers: [
        provider("charts", () => bridge([{ name: "chart_render", description: "生成图表" }])),
        // 名字启发是 read（tone_ 前缀），桥显式声明 danger → 目录按 write 展示
        provider("tone", () => bridge([{ name: "tone_detect", risk: "danger" }])),
        provider("boom", () => {
          throw new Error("构建失败");
        }),
      ],
    });

    expect(plugin.contributions.tools).toEqual([
      { name: "chart_render", description: "生成图表", risk: "read" },
      { name: "tone_detect", description: "", risk: "write" },
    ]);
    expect(plugin.counts.tools).toBe(2);
  });

  it("不写 heming.plugins.v1（系统插件不进已装列表）", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    describeSystemPlugin({ skills: fakeSkills([skill()]), mcp: fakeMcp([], new Set()), providers: [] });
    expect(setItem.mock.calls.some(([key]) => key === PLUGINS_KEY)).toBe(false);
    setItem.mockRestore();
  });
});
