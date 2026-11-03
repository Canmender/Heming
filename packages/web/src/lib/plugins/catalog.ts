import type { ToolBridge } from "../agentStream.js";
import { capabilityRegistry, type CapabilityProvider } from "../capability/index.js";
import { riskOfName } from "../hitl/classify.js";
import type { RiskLevel } from "../hitl/types.js";
import type { McpRegistry, McpToolRef } from "../mcp/index.js";
import { mcpRegistry } from "../mcp/index.js";
import { pluginStore, type InstalledPlugin, type PluginStore } from "./store.js";
import { pluginIdFromServerId } from "./permissions.js";

/**
 * 统一能力目录（d.65 · 系统插件 + 工具束）。
 *
 * 插件页的「工具」Tab 与「这台机器一共能用哪些工具、谁提供的、会不会问人」
 * 都只读这份目录——展示与执行同源：
 * - 内置工具来自 `capabilityRegistry.providers()`（排除 mcp/self 后逐个 build），
 *   归属改为**系统能力**（d.65：内置能力 = 系统插件 `heming.core` 的贡献）；
 * - MCP 工具来自 `mcpRegistry.allTools()`，`plugin:` 前缀的服务归到插件名下；
 * - 风险口径与执行期完全一致：`meta.risk ?? riskOfName(name)`（复用 `lib/hitl/classify`）。
 *
 * 安全边界（只收紧、不放宽）：插件的 `permissions.tools` 是它 MCP 工具的**风险上限**，
 * 超过上限的工具不进入 `tools`，而是进 `blocked` 供 UI 说明「插件声明 read，未注入」。
 * 这是过滤，不是审批——HITL 判定链不变。
 *
 * 工具束（`contributions.toolPacks`）在本文件里**只做归属与分组**：
 * 把目录里已存在的工具标上「来自工具束 X」，缺的进 `unresolved`（服务没连上很正常，
 * 不报错、不猜测，更不会去打开任何工具开关）。
 */

export type CapabilityOwnerKind = "system" | "mcp" | "plugin" | "self";

/** 工具在目录里的风险只分两档（`danger` 按 write 处理：展示上更保守）。 */
type CatalogRisk = "read" | "write";

/** 工具束在目录里的归属标注（同一个工具可以被不同插件各声明一次吗？见下方校验：不允许跨束重复）。 */
export interface CatalogToolPackRef {
  id: string;
  name: string;
  pluginId: string;
}

export interface CapabilityToolEntry {
  /** 工具名（执行时用的键）。 */
  name: string;
  description: string;
  ownerKind: CapabilityOwnerKind;
  /** providerId 或 serverId。 */
  ownerId: string;
  /** 人读：系统能力 / MCP 服务名 / 插件名 / 自我修改。 */
  ownerLabel: string;
  /** 插件提供时必填。 */
  pluginId?: string;
  /** MCP 工具填写。 */
  serverId?: string;
  risk: CatalogRisk;
  /** MCP 工具 = 开关；系统工具 = true；self = 该智能体是否配置。 */
  enabled: boolean;
  /** 只有 MCP 工具可在目录里直接开关。 */
  editable: boolean;
  /** 声明了该工具的工具束（d.65；只做归属展示，不影响 enabled）。 */
  toolPacks?: CatalogToolPackRef[];
}

/** 插件声明的工具束在目录里的解析结果（matched = 目录里存在，unresolved = 尚未连接/提供）。 */
export interface CatalogToolPack {
  id: string;
  pluginId: string;
  pluginName: string;
  name: string;
  description: string;
  tools: string[];
  /** 目录里存在的工具名（保留声明顺序）。 */
  matched: string[];
  /** 声明了但目录里没有的工具名（服务未连接/未启用；不报错）。 */
  unresolved: string[];
  /** 插件是否启用（停用插件后其工具束归属仍在，但展示为未启用）。 */
  enabled: boolean;
}

export interface CapabilityCatalog {
  tools: CapabilityToolEntry[];
  counts: { system: number; mcp: number; plugin: number; self: number; enabled: number };
  /** 插件风险上限过滤掉的工具（展示用，说明「插件声明 read，写工具未注入」）。 */
  blocked: { name: string; ownerLabel: string; risk: CatalogRisk; pluginId: string }[];
  /** 按插件声明顺序展开的工具束（d.65）。 */
  toolPacks: CatalogToolPack[];
}

/** 目录的数据来源（全部可注入，单测不必碰真实 localStorage 与网络）。 */
export interface CapabilityCatalogSources {
  mcp?: Pick<McpRegistry, "allTools" | "tools" | "servers" | "isToolEnabled">;
  plugins?: Pick<PluginStore, "list">;
  providers?: readonly CapabilityProvider[];
  /** 需要列「自我修改」工具的智能体 id；为空时不列 self（它需要智能体上下文）。 */
  selfAgents?: string[];
}

/** OpenAI 格式的 tools 元素（只有取值需要的字段）。 */
interface RawToolEntry {
  function?: { name?: unknown; description?: unknown };
}

function toolName(tool: unknown): string | null {
  const entry = tool as RawToolEntry | null;
  const name = entry?.function?.name;
  return typeof name === "string" && name ? name : null;
}

function toolDescription(tool: unknown): string {
  const entry = tool as RawToolEntry | null;
  const description = entry?.function?.description;
  return typeof description === "string" ? description : "";
}

/** `danger` 在目录里按 write 展示：风险只会写得比实际更保守，不会更宽松。 */
function catalogRisk(level: RiskLevel): CatalogRisk {
  return level === "read" ? "read" : "write";
}

function bridgeTools(bridge: ToolBridge): { name: string; description: string }[] {
  const out: { name: string; description: string }[] = [];
  for (const tool of bridge.tools) {
    const name = toolName(tool);
    if (name) out.push({ name, description: toolDescription(tool) });
  }
  return out;
}

/**
 * 生成统一能力目录。
 *
 * 处理顺序按**执行优先级**：MCP → 内置提供者（注册表顺序）→ self。
 * 同一工具名只保留首个（与 `mergeToolBridges` 的「前者胜出」一致），
 * 保证目录里标记的归属就是执行时真正会用到的那个实现。
 */
export function describeCapabilityCatalog(
  options: CapabilityCatalogSources = {},
): CapabilityCatalog {
  const mcp: Pick<McpRegistry, "allTools" | "tools" | "servers" | "isToolEnabled"> =
    options.mcp ?? mcpRegistry;
  const plugins: Pick<PluginStore, "list"> = options.plugins ?? pluginStore;
  const providers = options.providers ?? capabilityRegistry.providers();
  const selfAgents = options.selfAgents ?? [];

  const installed = new Map<string, InstalledPlugin>();
  const pluginOrder: InstalledPlugin[] = [];
  for (const plugin of plugins.list()) {
    installed.set(plugin.manifest.id, plugin);
    pluginOrder.push(plugin);
  }

  const tools: CapabilityToolEntry[] = [];
  const blocked: CapabilityCatalog["blocked"] = [];
  const seen = new Set<string>();

  const push = (entry: CapabilityToolEntry): void => {
    if (seen.has(entry.name)) return; // 同名只留首个（执行期前者胜出）
    seen.add(entry.name);
    tools.push(entry);
  };

  // 1) MCP 工具（含插件随包登记的服务）
  for (const ref of mcp.allTools()) {
    const name = ref.tool.name;
    if (!name || seen.has(name)) continue;
    const risk = catalogRisk(riskOfName(name));
    const pluginId = pluginIdFromServerId(ref.serverId);
    if (pluginId) {
      const plugin = installed.get(pluginId);
      const ceiling = plugin?.manifest.permissions.tools ?? "none";
      const ownerLabel = plugin?.manifest.name ?? pluginId;
      if (ceiling === "none" || (ceiling === "read" && risk === "write")) {
        blocked.push({ name, ownerLabel, risk, pluginId });
        continue;
      }
      push({
        name,
        description: descriptionOf(ref, mcp),
        ownerKind: "plugin",
        ownerId: ref.serverId,
        ownerLabel,
        pluginId,
        serverId: ref.serverId,
        risk,
        enabled: mcp.isToolEnabled(ref.serverId, name),
        editable: true,
      });
      continue;
    }
    push({
      name,
      description: descriptionOf(ref, mcp),
      ownerKind: "mcp",
      ownerId: ref.serverId,
      ownerLabel: ref.serverName || "MCP 服务",
      serverId: ref.serverId,
      risk,
      enabled: mcp.isToolEnabled(ref.serverId, name),
      editable: true,
    });
  }

  // 2) 内置提供者（mcp 已在上面展开；self 需要智能体上下文，单独处理）
  for (const provider of providers) {
    if (provider.id === "mcp" || provider.id === "self") continue;
    let bridge: ToolBridge | null = null;
    try {
      bridge = provider.build({ agentId: "__catalog__", conversationId: "__catalog__" });
    } catch {
      // 单个提供者构建失败不能拖垮整页（目录是只读展示）
      continue;
    }
    if (!bridge) continue;
    for (const tool of bridgeTools(bridge)) {
      const riskLevel = bridge.meta?.(tool.name)?.risk ?? riskOfName(tool.name);
      push({
        name: tool.name,
        description: tool.description,
        ownerKind: "system",
        ownerId: provider.id,
        ownerLabel: "系统能力",
        risk: catalogRisk(riskLevel),
        enabled: true,
        editable: false,
      });
    }
  }

  // 3) self 工具：只有给出智能体上下文时才列；能构建出来即该智能体已配置
  if (selfAgents.length > 0) {
    const selfProvider = providers.find((provider) => provider.id === "self");
    if (selfProvider) {
      for (const agentId of selfAgents) {
        let bridge: ToolBridge | null = null;
        try {
          bridge = selfProvider.build({ agentId, conversationId: "__catalog__" });
        } catch {
          continue;
        }
        if (!bridge) continue;
        for (const tool of bridgeTools(bridge)) {
          const riskLevel = bridge.meta?.(tool.name)?.risk ?? riskOfName(tool.name);
          push({
            name: tool.name,
            description: tool.description,
            ownerKind: "self",
            ownerId: "self",
            ownerLabel: "自我修改",
            risk: catalogRisk(riskLevel),
            enabled: true,
            editable: false,
          });
        }
      }
    }
  }

  // 4) 工具束：在已收集的目录上做**归属标注**。
  //    同名工具在目录里唯一定义，所以按名字精确匹配即可；缺的进 unresolved 不报错。
  const toolsByName = new Map(tools.map((tool) => [tool.name, tool]));
  const toolPacks: CatalogToolPack[] = [];
  for (const plugin of pluginOrder) {
    for (const pack of plugin.manifest.contributions.toolPacks) {
      const matched: string[] = [];
      const unresolved: string[] = [];
      for (const name of pack.tools) {
        const tool = toolsByName.get(name);
        if (!tool) {
          unresolved.push(name);
          continue;
        }
        matched.push(name);
        const refs = tool.toolPacks ?? [];
        if (!refs.some((ref) => ref.id === pack.id && ref.pluginId === plugin.manifest.id)) {
          refs.push({ id: pack.id, name: pack.name, pluginId: plugin.manifest.id });
        }
        tool.toolPacks = refs;
      }
      toolPacks.push({
        id: pack.id,
        pluginId: plugin.manifest.id,
        pluginName: plugin.manifest.name,
        name: pack.name,
        description: pack.description,
        tools: [...pack.tools],
        matched,
        unresolved,
        enabled: plugin.enabled,
      });
    }
  }

  const counts = {
    system: tools.filter((tool) => tool.ownerKind === "system").length,
    mcp: tools.filter((tool) => tool.ownerKind === "mcp").length,
    plugin: tools.filter((tool) => tool.ownerKind === "plugin").length,
    self: tools.filter((tool) => tool.ownerKind === "self").length,
    enabled: tools.filter((tool) => tool.enabled).length,
  };

  return { tools, counts, blocked, toolPacks };
}

/** MCP 工具描述缺失时用缓存的工具清单补一次（`allTools` 正常已带描述）。 */
function descriptionOf(
  ref: McpToolRef,
  mcp: Pick<McpRegistry, "tools">,
): string {
  if (ref.tool.description) return ref.tool.description;
  try {
    return mcp.tools(ref.serverId).find((tool) => tool.name === ref.tool.name)?.description ?? "";
  } catch {
    return "";
  }
}
