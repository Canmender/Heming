import { capabilityRegistry, type CapabilityProvider } from "../capability/index.js";
import type { McpRegistry } from "../mcp/index.js";
import { mcpRegistry } from "../mcp/index.js";
import type { SkillPool } from "../skills/index.js";
import { skillPool } from "../skills/index.js";
import { describeCapabilityCatalog } from "./catalog.js";
import { pluginIdFromServerId } from "./permissions.js";
import { pluginStore, type PluginStore } from "./store.js";
import {
  describeSystemPlugin,
  SYSTEM_PLUGIN_ID,
  SYSTEM_PLUGIN_NAME,
  type SystemPlugin,
} from "./system.js";

/**
 * 统一能力描述符（d.65）：把技能 / 工具 / MCP 服务 / 命令压平成**一张表**，
 * 每条都带「谁提供的」（系统能力 / 插件 / MCP 服务）。
 *
 * 为什么需要它：d.64 之前，插件页、技能区、接口区各写一套「来源」判定，
 * 同一个预置服务在接口区叫「预置」、在插件页叫「内置」，迟早对不上。
 * 现在三处页面只读 `describeCapabilities()`，来源口径只有这一份实现。
 *
 * **纯读**：不写存储、不改开关、不碰 HITL；`enabled` 只是既有事实的透出。
 */

export type CapabilityKind = "skill" | "tool" | "mcp" | "command";

/** 描述符口径的归属只有三档（能力目录里还有 `self`，见 catalog.ts）。 */
export type CapabilityOwnerKind = "system" | "plugin" | "mcp";

export interface CapabilityDescriptor {
  /** 跨类型唯一：`<kind>:<原始 id>`（技能 id / 工具名 / serverId / `plugin:<pid>:<cid>`）。 */
  id: string;
  kind: CapabilityKind;
  name: string;
  description: string;
  ownerKind: CapabilityOwnerKind;
  /** `heming.core` / 插件 id / serverId（自我修改工具记 `self`）。 */
  ownerId: string;
  /** 人读：系统能力 / 插件名 / 服务名（自我修改工具记「自我修改」）。 */
  ownerName: string;
  /** 插件归属（ownerKind 为 plugin 时填写）。 */
  pluginId?: string;
  /** MCP 服务归属（工具与服务条目填写）。 */
  serverId?: string;
  enabled: boolean;
  /** 仅 tool：与能力目录同源的展示风险（`danger` 已按 write 处理）。 */
  risk?: "read" | "write";
}

export interface CapabilitySnapshot {
  descriptors: CapabilityDescriptor[];
  counts: {
    total: number;
    enabled: number;
    byKind: Record<CapabilityKind, number>;
    byOwner: Record<CapabilityOwnerKind, number>;
    systemPlugin: { installed: 1; skills: number; tools: number; servers: number };
  };
  system: SystemPlugin;
}

export interface DescribeCapabilitiesOptions {
  skills?: Pick<SkillPool, "list">;
  mcp?: Pick<
    McpRegistry,
    "allTools" | "tools" | "servers" | "isToolEnabled" | "isPreset"
  >;
  plugins?: Pick<PluginStore, "list">;
  providers?: readonly CapabilityProvider[];
  /** 需要列「自我修改」工具的智能体 id（同能力目录口径）；为空时不列。 */
  selfAgents?: string[];
  /** 系统插件展示版本。 */
  systemVersion?: string;
}

/**
 * 归属矩阵（与规格 §4 一一对应，任何页面都不得再手写）：
 * - 技能：有 `pluginId` → 插件；否则 → 系统能力。
 * - 服务：`origin: "preset"` → 系统能力；`origin: "plugin"`（`plugin:` 前缀 id）→ 插件；
 *   其余（manual / registry）→ MCP 服务。
 * - 工具：直接用能力目录的归属；`self` 在描述符里归 `mcp`、名字记「自我修改」。
 * - 命令：只列启用中插件的命令 → 插件（系统插件不贡献命令）。
 */
export function describeCapabilities(
  options: DescribeCapabilitiesOptions = {},
): CapabilitySnapshot {
  const skillsSource: Pick<SkillPool, "list"> = options.skills ?? skillPool;
  const mcpSource: Pick<
    McpRegistry,
    "allTools" | "tools" | "servers" | "isToolEnabled" | "isPreset"
  > = options.mcp ?? mcpRegistry;
  const pluginsSource: Pick<PluginStore, "list"> = options.plugins ?? pluginStore;
  const providers = options.providers ?? capabilityRegistry.providers();

  const installed = new Map(pluginsSource.list().map((plugin) => [plugin.manifest.id, plugin]));
  const catalog = describeCapabilityCatalog({
    mcp: mcpSource,
    plugins: pluginsSource,
    providers,
    selfAgents: options.selfAgents ?? [],
  });
  const system = describeSystemPlugin({
    skills: skillsSource,
    mcp: mcpSource,
    providers,
    version: options.systemVersion,
  });

  const descriptors: CapabilityDescriptor[] = [];

  // 技能：插件技能 → 插件；内置/用户/沉淀 → 系统能力（只有内置是系统贡献，
  // 但来源口径按「有无 pluginId」判定，规格如此——用户自建技能也归系统能力展示）。
  for (const skill of skillsSource.list()) {
    const plugin = skill.pluginId ? installed.get(skill.pluginId) : undefined;
    descriptors.push({
      id: `skill:${skill.id}`,
      kind: "skill",
      name: skill.name,
      description: skill.description,
      ownerKind: plugin ? "plugin" : "system",
      ownerId: plugin ? plugin.manifest.id : SYSTEM_PLUGIN_ID,
      ownerName: plugin ? plugin.manifest.name : SYSTEM_PLUGIN_NAME,
      ...(plugin ? { pluginId: plugin.manifest.id } : {}),
      enabled: skill.enabled,
    });
  }

  // MCP 服务：preset → 系统；plugin: 前缀且能反解 → 插件；其余 → MCP 服务。
  for (const server of mcpSource.servers()) {
    const pluginId = server.origin === "plugin" ? pluginIdFromServerId(server.id) : null;
    const plugin = pluginId ? installed.get(pluginId) : undefined;
    const ownerKind: CapabilityOwnerKind =
      server.origin === "preset" ? "system" : pluginId ? "plugin" : "mcp";
    descriptors.push({
      id: `mcp:${server.id}`,
      kind: "mcp",
      name: server.name,
      description: server.url ?? "",
      ownerKind,
      ownerId:
        ownerKind === "system" ? SYSTEM_PLUGIN_ID : ownerKind === "plugin" ? pluginId ?? server.id : server.id,
      ownerName:
        ownerKind === "system"
          ? SYSTEM_PLUGIN_NAME
          : ownerKind === "plugin"
            ? (plugin?.manifest.name ?? pluginId ?? server.name)
            : server.name,
      ...(ownerKind === "plugin" && pluginId ? { pluginId } : {}),
      serverId: server.id,
      enabled: server.enabled,
    });
  }

  // 工具：目录归属即描述符归属（展示与执行同源）；self 归 mcp 档、名字「自我修改」。
  for (const tool of catalog.tools) {
    if (tool.ownerKind === "self") {
      descriptors.push({
        id: `tool:${tool.name}`,
        kind: "tool",
        name: tool.name,
        description: tool.description,
        ownerKind: "mcp",
        ownerId: "self",
        ownerName: "自我修改",
        enabled: tool.enabled,
        risk: tool.risk,
      });
      continue;
    }
    const ownerKind: CapabilityOwnerKind =
      tool.ownerKind === "system" ? "system" : tool.ownerKind === "plugin" ? "plugin" : "mcp";
    descriptors.push({
      id: `tool:${tool.name}`,
      kind: "tool",
      name: tool.name,
      description: tool.description,
      ownerKind,
      ownerId:
        ownerKind === "system"
          ? SYSTEM_PLUGIN_ID
          : ownerKind === "plugin"
            ? (tool.pluginId ?? tool.ownerId)
            : (tool.serverId ?? tool.ownerId),
      ownerName:
        ownerKind === "system"
          ? SYSTEM_PLUGIN_NAME
          : tool.ownerLabel,
      ...(ownerKind === "plugin" && tool.pluginId ? { pluginId: tool.pluginId } : {}),
      ...(tool.serverId ? { serverId: tool.serverId } : {}),
      enabled: tool.enabled,
      risk: tool.risk,
    });
  }

  // 命令：启用中插件的 contributions.commands（停用插件不出现，与命令面板同口径）。
  for (const plugin of installed.values()) {
    if (!plugin.enabled) continue;
    for (const command of plugin.manifest.contributions.commands) {
      descriptors.push({
        id: `command:plugin:${plugin.manifest.id}:${command.id}`,
        kind: "command",
        name: command.title,
        description: command.description,
        ownerKind: "plugin",
        ownerId: plugin.manifest.id,
        ownerName: plugin.manifest.name,
        pluginId: plugin.manifest.id,
        enabled: true,
      });
    }
  }

  const byKind: Record<CapabilityKind, number> = { skill: 0, tool: 0, mcp: 0, command: 0 };
  const byOwner: Record<CapabilityOwnerKind, number> = { system: 0, plugin: 0, mcp: 0 };
  for (const descriptor of descriptors) {
    byKind[descriptor.kind] += 1;
    byOwner[descriptor.ownerKind] += 1;
  }

  return {
    descriptors,
    counts: {
      total: descriptors.length,
      enabled: descriptors.filter((descriptor) => descriptor.enabled).length,
      byKind,
      byOwner,
      systemPlugin: {
        installed: 1,
        skills: system.counts.skills,
        tools: system.counts.tools,
        servers: system.counts.servers,
      },
    },
    system,
  };
}
