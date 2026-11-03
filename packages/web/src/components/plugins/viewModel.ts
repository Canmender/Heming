import type { McpServerConfig, ServerOrigin } from "../../lib/mcp/types.js";
import type { SkillDefinition } from "../../lib/skills/types.js";
import type {
  CapabilityCatalog,
  CapabilityToolEntry,
  InstalledPlugin,
  PluginManifest,
  PluginStore,
} from "../../lib/plugins/index.js";
import {
  evaluatePluginPermissions,
  type InstallResult,
  type PluginInstallPreview,
} from "../../lib/plugins/index.js";

/**
 * 插件页（统一能力中枢）的**纯适配层**（d.64 · T2）。
 *
 * 为什么单独一层：
 * - 夹具数据（插件 / 技能池 / MCP 注册表 / 能力目录）形状不同，页面只消费统一 view-model；
 * - 统计、来源标签、权限摘要都是纯函数，可以在单测里直接断言，不必渲染整页；
 * - 解析与权限逻辑**只在 `lib/plugins`**（清单校验、`evaluatePluginPermissions`），这里只做展示适配，
 *   绝不在组件里重复实现一遍——否则两套口径迟早漂移。
 */

/** 页面需要的最小技能池接口（真实 `SkillPool` 天然满足）。 */
export interface SkillPoolPort {
  list(): SkillDefinition[];
  assigned(agentId: string): string[];
  setEnabled(id: string, enabled: boolean): void;
}

/** 页面需要的最小 MCP 注册表接口（真实 `mcpRegistry` 天然满足）。 */
export interface McpRegistryPort {
  servers(): McpServerConfig[];
  allTools(): { serverId: string; serverName: string; tool: { name: string; description?: string } }[];
  tools(serverId: string): { name: string; description?: string }[];
  isToolEnabled(serverId: string, toolName: string): boolean;
  hasDiscovered(serverId: string): boolean;
  setToolEnabled(serverId: string, toolName: string, enabled: boolean): void;
  update(id: string, patch: { enabled?: boolean }): unknown;
}

/** 智能体名册（只需要 id/name，避免页面依赖整个 chat store 类型）。 */
export interface AgentLite {
  id: string;
  name: string;
}

/* ------------------------------------------------------------ 贡献与权限 */

export interface PluginContributionCountsView {
  skills: number;
  servers: number;
  commands: number;
}

/**
 * 插件卡「贡献」行：技能 / 服务 / 命令。
 *
 * 兜底口径：以清单声明为准，同时与物化 id 数量取较大值——
 * 旧版本应用留下的记录可能清单为空但 id 已物化（或反之），两边都算「已贡献」，
 * 不会因为某一边缺字段就显示成 0；停用插件也照常显示声明贡献（停用不等于没装）。
 */
export function contributionCountsOf(plugin: InstalledPlugin): PluginContributionCountsView {
  const declared = plugin.manifest.contributions;
  return {
    skills: Math.max(declared.skills.length, plugin.skillIds.length),
    servers: Math.max(declared.mcpServers.length, plugin.serverIds.length),
    commands: declared.commands.length,
  };
}

/** 贡献行的可读文案：`技能 2 · 服务 1 · 命令 0`。 */
export function contributionText(counts: PluginContributionCountsView): string {
  return `技能 ${counts.skills} · 服务 ${counts.servers} · 命令 ${counts.commands}`;
}

export interface PluginPermissionView {
  /** 声明的主机数（安装时确认的完整白名单）。 */
  hostCount: number;
  /** 声明的主机白名单（展示用；与 hosts 的差集为 undeclared）。 */
  network: string[];
  /** 实际会访问的主机（由服务 URL 推导，与声明应一致）。 */
  hosts: string[];
  /** 声明总条数（主机白名单长度）。 */
  networkTotal: number;
  /** 风险上限档位。 */
  ceiling: "none" | "read" | "write";
  ceilingLabel: string;
  files: string[];
  /** 声明是否覆盖全部实际访问主机（解析期已拒绝未覆盖的清单，这里是兜底）。 */
  accepted: boolean;
  /** v1/v2 旧包：归一化时补的权限，界面要明说「未声明」。 */
  legacy: boolean;
}

const CEILING_LABEL: Record<PluginPermissionView["ceiling"], string> = {
  none: "不提供工具",
  read: "只读",
  write: "读写",
};

/**
 * 权限摘要（插件卡一行 + 安装弹窗 + 详情两段共用）。
 *
 * 主机与覆盖校验复用 `evaluatePluginPermissions`（与运行时同一口径），
 * 这里只补「人读标签」与旧版标记。
 */
export function permissionViewOf(manifest: PluginManifest): PluginPermissionView {
  const report = evaluatePluginPermissions(manifest);
  return {
    hostCount: report.hosts.length,
    network: report.network,
    hosts: report.hosts,
    networkTotal: report.network.length,
    ceiling: report.tools,
    ceilingLabel: CEILING_LABEL[report.tools],
    files: report.files,
    accepted: report.accepted,
    legacy: manifest.schemaVersion < 3,
  };
}

/** 权限一行摘要：`主机 1 · 风险上限 只读`。 */
export function permissionText(view: PluginPermissionView): string {
  if (view.legacy) return "旧版清单：未声明权限";
  return `主机 ${view.hostCount} · 风险上限 ${view.ceilingLabel}`;
}

/** 网络主机预览：最多 3 行，其余折成「共 N 项」。 */
export function hostPreview(view: PluginPermissionView, max = 3): {
  shown: string[];
  more: number;
  total: number;
} {
  // 展示「声明的白名单」：安装时用户确认的是这份清单；
  // 实际访问主机（hosts）只用于覆盖校验，两者在合法清单里一致。
  const all = view.network.length > 0 ? view.network : view.hosts;
  return {
    shown: all.slice(0, max),
    more: Math.max(0, all.length - max),
    total: all.length,
  };
}

/* ---------------------------------------------------------------- 技能页 */

export type SkillSourceKind = "builtin" | "imported" | "plugin" | "custom" | "distilled";

export interface CapabilitySkillRow {
  id: string;
  name: string;
  description: string;
  source: SkillSourceKind;
  sourceLabel: string;
  pluginId?: string;
  pluginName?: string;
  triggerCount: number;
  enabled: boolean;
  /** 被几个智能体分配使用（按名册逐个 `assigned()` 判定）。 */
  agentCount: number;
}

const SOURCE_LABEL: Record<SkillSourceKind, string> = {
  builtin: "内置",
  imported: "导入",
  plugin: "插件",
  custom: "自定义",
  distilled: "沉淀",
};

/**
 * 技能 Tab 的统一行。
 *
 * 来源判定优先看 `pluginId`：插件贡献物化进技能池时 `source` 可能是 `imported`，
 * 只按 source 展示会把插件技能说成「导入」，用户找不回是哪个插件带的。
 */
export function describeSkillRows(
  pool: SkillPoolPort,
  plugins: Pick<PluginStore, "list">,
  agents: readonly AgentLite[],
): CapabilitySkillRow[] {
  const pluginNames = new Map(plugins.list().map((p) => [p.manifest.id, p.manifest.name]));
  return pool.list().map((skill) => {
    const pluginId = skill.pluginId;
    const source: SkillSourceKind = pluginId
      ? "plugin"
      : skill.source === "builtin"
        ? "builtin"
        : skill.source === "distilled"
          ? "distilled"
          : skill.source === "user"
            ? "custom"
            : "imported";
    const agentCount = agents.filter((agent) => pool.assigned(agent.id).includes(skill.id)).length;
    return {
      id: skill.id,
      name: skill.name,
      description: skill.description,
      source,
      sourceLabel: SOURCE_LABEL[source],
      pluginId,
      pluginName: pluginId ? pluginNames.get(pluginId) : undefined,
      triggerCount: skill.triggers.length,
      enabled: skill.enabled,
      agentCount,
    };
  });
}

/* ---------------------------------------------------------------- 工具页 */

export type ToolGroupKind = "builtin" | "mcp" | "plugin" | "self";

export interface CapabilityToolGroup {
  kind: ToolGroupKind;
  label: string;
  tools: CapabilityToolEntry[];
}

export interface BlockedToolRow {
  name: string;
  ownerLabel: string;
  risk: "read" | "write";
  pluginId: string;
  reason: string;
}

const OWNER_LABEL: Record<ToolGroupKind, string> = {
  builtin: "内置工具",
  mcp: "MCP 服务",
  plugin: "插件工具",
  self: "自我修改",
};

/** 目录按归属分组：固定顺序（内置 → MCP → 插件 → 自我修改），空组不出现。 */
export function groupCatalogTools(catalog: CapabilityCatalog): CapabilityToolGroup[] {
  const order: ToolGroupKind[] = ["builtin", "mcp", "plugin", "self"];
  return order
    .map((kind) => ({
      kind,
      label: OWNER_LABEL[kind],
      tools: catalog.tools.filter((tool) => tool.ownerKind === kind),
    }))
    .filter((group) => group.tools.length > 0);
}

/**
 * 被插件风险上限拦下的工具（只读展示）。
 *
 * 文案解释「为什么目录里没有它」：声明 read 的插件不注入写工具——
 * 这是收紧而非审批，用户需要知道被拦的是谁、什么风险。
 */
export function describeBlockedTools(
  catalog: CapabilityCatalog,
  plugins: Pick<PluginStore, "list">,
): BlockedToolRow[] {
  const ceilings = new Map(
    plugins.list().map((plugin) => [plugin.manifest.id, plugin.manifest.permissions.tools]),
  );
  return catalog.blocked.map((item) => {
    const ceiling = ceilings.get(item.pluginId) ?? "read";
    return {
      name: item.name,
      ownerLabel: item.ownerLabel,
      risk: item.risk,
      pluginId: item.pluginId,
      reason: `插件声明 ${ceiling}，未注入`,
    };
  });
}

/* ------------------------------------------------------------- MCP 服务页 */

export type McpSourceKind = ServerOrigin;

export interface CapabilityMcpRow {
  id: string;
  name: string;
  url: string;
  origin: McpSourceKind;
  originLabel: string;
  pluginId?: string;
  pluginName?: string;
  toolCount: number;
  enabled: boolean;
  /** 已发现过工具视为已连接（连接状态只在前端，不落盘）。 */
  connected: boolean;
}

const ORIGIN_LABEL: Record<McpSourceKind, string> = {
  preset: "预置",
  manual: "手工",
  registry: "Registry",
  plugin: "插件",
};

/** MCP Tab 统一行；`plugin:` 前缀的服务补插件名（来自已装清单，不猜）。 */
export function describeMcpRows(
  mcp: McpRegistryPort,
  plugins: Pick<PluginStore, "list">,
  pluginIdFromServerId: (serverId: string) => string | null,
): CapabilityMcpRow[] {
  const names = new Map(plugins.list().map((p) => [p.manifest.id, p.manifest.name]));
  return mcp.servers().map((server) => {
    const pluginId = pluginIdFromServerId(server.id) ?? undefined;
    const origin: McpSourceKind = server.origin ?? "manual";
    let toolCount = 0;
    try {
      toolCount = mcp.tools(server.id).length;
    } catch {
      toolCount = 0;
    }
    return {
      id: server.id,
      name: server.name,
      url: server.url ?? "",
      origin,
      originLabel: ORIGIN_LABEL[origin],
      pluginId,
      pluginName: pluginId ? names.get(pluginId) : undefined,
      toolCount,
      enabled: server.enabled,
      connected: mcp.hasDiscovered(server.id),
    };
  });
}

/* ---------------------------------------------------------------- 统计卡 */

export interface CapabilityStats {
  plugins: number;
  skills: number;
  tools: number;
  mcpServers: number;
}

/**
 * 头部四个统计卡：已装插件 / 技能 / 工具 / MCP 服务。
 *
 * 口径固定：数值只能来自这四处数据源（插件存储、技能池、能力目录、MCP 注册表），
 * 不在这里做任何过滤——过滤会让四个数互相矛盾（例如「工具 12」但目录只列 9 个）。
 */
export function describeCapabilityStats(input: {
  plugins: Pick<PluginStore, "list">;
  skills: Pick<SkillPoolPort, "list">;
  catalog: CapabilityCatalog;
  mcp: Pick<McpRegistryPort, "servers">;
}): CapabilityStats {
  return {
    plugins: input.plugins.list().length,
    skills: input.skills.list().length,
    tools: input.catalog.tools.length,
    mcpServers: input.mcp.servers().length,
  };
}

/** 工具风险的中文标签（目录行与 blocked 行共用）。 */
export function toolRiskLabel(risk: "read" | "write"): string {
  return risk === "read" ? "只读" : "写入";
}

/* --------------------------------------------------------- 安装结果文案 */

/**
 * 安装/更新完成后的一条中文提示。
 *
 * 单独抽出来：这串文案要精确描述「技能 +a/改b/删c，服务 +d/改e/删f」的口径，
 * 放在页面里既长又容易与预览计数不同步；用同一个 before(preview) 与 result 生成，
 * 保证「预览怎么说、装完就怎么报」。
 */
export function installResultMessage(
  result: InstallResult,
  before: PluginInstallPreview,
): string {
  const name = result.plugin.manifest.name;
  if (result.created) {
    return `已安装插件「${name}」：新增 ${result.added} 个技能、${result.serversAdded} 台 MCP 服务`;
  }
  const changed =
    before.skills.added.length +
    before.skills.changed.length +
    before.skills.removed.length +
    before.servers.added.length +
    before.servers.changed.length +
    before.servers.removed.length;
  if (changed === 0) {
    return `已更新插件「${name}」：清单与已装内容一致，仅刷新更新时间`;
  }
  return `已更新插件「${name}」：技能 +${before.skills.added.length}/改${before.skills.changed.length}/删${before.skills.removed.length}，服务 +${before.servers.added.length}/改${before.servers.changed.length}/删${before.servers.removed.length}`;
}
