import { capabilityRegistry, type CapabilityProvider } from "../capability/index.js";
import type { McpRegistry } from "../mcp/index.js";
import { mcpRegistry } from "../mcp/index.js";
import type { SkillPool } from "../skills/index.js";
import { skillPool } from "../skills/index.js";
import { describeCapabilityCatalog } from "./catalog.js";

/**
 * 系统插件（d.65）：把应用内置的技能 / 预置 MCP 服务 / 内置工具收进插件模型。
 *
 * 它不是一个真实的安装包，也不写 `heming.plugins.v1`：
 * - **置顶只读**：界面固定在插件列表最上方，没有停用/卸载开关；
 * - **不计入 `MAX_PLUGINS`**：装多少个插件都不影响它；
 * - 只做**归属展示**：让「所有能力都在插件模型里」这句话在页面上成立，
 *   不改变技能路由、MCP 连接与工具开关的任何行为。
 */

export const SYSTEM_PLUGIN_ID = "heming.core";
export const SYSTEM_PLUGIN_NAME = "系统能力";

/** 系统插件里的一项技能（内置技能被用户删除后自然不出现）。 */
export interface SystemPluginSkill {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
}

/** 系统插件里的一台预置 MCP 服务。 */
export interface SystemPluginServer {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  /** 恒为 true（只有预置服务才进系统插件；保留字段给统一展示形状）。 */
  preset: boolean;
}

/** 系统插件里的一个内置工具（风险口径与能力目录一致）。 */
export interface SystemPluginTool {
  name: string;
  description: string;
  risk: "read" | "write";
}

export interface SystemPlugin {
  id: typeof SYSTEM_PLUGIN_ID;
  name: string;
  /** 内置版本，仅展示用。 */
  version: string;
  description: string;
  /** 置顶。 */
  pinned: true;
  /** 不可卸载/停用（界面不给开关）。 */
  uninstallable: false;
  enabled: true;
  contributions: {
    skills: SystemPluginSkill[];
    servers: SystemPluginServer[];
    tools: SystemPluginTool[];
    /** 系统插件不贡献命令（保留字段给统一形状）。 */
    commands: never[];
  };
  counts: { skills: number; servers: number; tools: number; commands: number };
}

export interface SystemPluginOptions {
  skills?: Pick<SkillPool, "list">;
  mcp?: Pick<McpRegistry, "servers" | "isPreset">;
  providers?: readonly CapabilityProvider[];
  version?: string;
}

/**
 * 生成只读的系统插件描述。
 *
 * 工具来源固定为「能力目录里 ownerKind === 'system' 的内置工具」：
 * 目录是展示与执行的同一口径，这里不再自己遍历 provider，避免两套实现漂移。
 */
export function describeSystemPlugin(options: SystemPluginOptions = {}): SystemPlugin {
  const skillsSource: Pick<SkillPool, "list"> = options.skills ?? skillPool;
  const mcpSource: Pick<McpRegistry, "servers" | "isPreset"> = options.mcp ?? mcpRegistry;
  const providers = options.providers ?? capabilityRegistry.providers();

  const skills: SystemPluginSkill[] = skillsSource
    .list()
    .filter((skill) => skill.source === "builtin")
    .map((skill) => ({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      enabled: skill.enabled,
    }));

  const servers: SystemPluginServer[] = mcpSource
    .servers()
    .filter((server) => mcpSource.isPreset(server.id))
    .map((server) => ({
      id: server.id,
      name: server.name,
      url: server.url ?? "",
      enabled: server.enabled,
      preset: true,
    }));

  // 只为拿 system 工具：MCP 面传空（系统工具 = 内置提供者，不掺插件/手工服务），
  // 插件面也传空——系统插件与已装插件是两件事。
  const catalog = describeCapabilityCatalog({
    mcp: {
      allTools: () => [],
      tools: () => [],
      servers: () => mcpSource.servers(),
      isToolEnabled: () => false,
    },
    plugins: { list: () => [] },
    providers,
  });
  const tools: SystemPluginTool[] = catalog.tools
    .filter((tool) => tool.ownerKind === "system")
    .map((tool) => ({
      name: tool.name,
      description: tool.description,
      risk: tool.risk,
    }));

  return {
    id: SYSTEM_PLUGIN_ID,
    name: SYSTEM_PLUGIN_NAME,
    version: options.version ?? "1.0.0",
    description: "随应用内置的技能、MCP 服务与工具；置顶只读，不可停用或卸载。",
    pinned: true,
    uninstallable: false,
    enabled: true,
    contributions: { skills, servers, tools, commands: [] },
    counts: {
      skills: skills.length,
      servers: servers.length,
      tools: tools.length,
      commands: 0,
    },
  };
}
