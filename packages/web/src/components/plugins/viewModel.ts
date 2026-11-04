import type {
  CapabilityCatalog,
  CapabilityToolEntry,
  InstalledPlugin,
  PluginManifest,
  PluginStore,
} from "../../lib/plugins/index.js";
import {
  evaluatePluginPermissions,
  type CapabilitySnapshot,
  type CatalogToolPack,
  type PluginContributionKind,
  type PluginTrustPreview,
  type SignatureStatus,
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

/* ------------------------------------------------------------ 贡献与权限 */

export interface PluginContributionCountsView {
  skills: number;
  servers: number;
  commands: number;
  /** 工具束数量（d.65；旧清单缺省 0）。 */
  toolPacks: number;
  /** 全部工具束声明的工具名总数（按声明计，不代表已连接）。 */
  packTools: number;
}

/**
 * 插件卡「贡献」行：技能 / 服务 / 命令。
 *
 * 兜底口径：以清单声明为准，同时与物化 id 数量取较大值——
 * 旧版本应用留下的记录可能清单为空但 id 已物化（或反之），两边都算「已贡献」，
 * 不会因为某一边缺字段就显示成 0；停用插件也照常显示声明贡献（停用不等于没装）。
 */
export function contributionCountsOf(plugin: InstalledPlugin): PluginContributionCountsView {
  return manifestContributionCounts(plugin.manifest, plugin.skillIds.length, plugin.serverIds.length);
}

/**
 * 清单层面的贡献计数（安装预览用：还没装、拿不到物化 id 数量）。
 *
 * 与插件卡同一份口径；工具束部分按声明计（`tools` 里可能有服务未连接的工具，
 * 那是 `unresolved`，仍属于「这个插件声明了这些工具」）。
 */
export function manifestContributionCounts(
  manifest: PluginManifest,
  materializedSkills = 0,
  materializedServers = 0,
): PluginContributionCountsView {
  const declared = manifest.contributions;
  return {
    skills: Math.max(declared.skills.length, materializedSkills),
    servers: Math.max(declared.mcpServers.length, materializedServers),
    commands: declared.commands.length,
    toolPacks: declared.toolPacks.length,
    packTools: declared.toolPacks.reduce((sum, pack) => sum + pack.tools.length, 0),
  };
}

/**
 * 贡献行的可读文案：`技能 2 · 服务 1 · 命令 0 · 工具束 1 · 工具 3`。
 *
 * 工具束是 d.65 增补：0 个时也照常显示，让「这个插件有没有声明工具」一眼可见；
 * 老清单显示 `工具束 0 · 工具 0`，不是缺字段。
 */
export function contributionText(counts: PluginContributionCountsView): string {
  return `技能 ${counts.skills} · 服务 ${counts.servers} · 命令 ${counts.commands} · 工具束 ${counts.toolPacks} · 工具 ${counts.packTools}`;
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
  if (view.legacy) return "旧格式清单：未声明权限";
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

/* ---------------------------------------------------------------- 工具页 */

export type ToolGroupKind = "system" | "mcp" | "plugin" | "self";

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
  system: "系统能力",
  mcp: "MCP 服务",
  plugin: "插件工具",
  self: "自我修改",
};

/**
 * 目录按归属分组：固定顺序（系统能力 → MCP 服务 → 插件工具 → 自我修改），空组不出现。
 *
 * d.65 起内置工具归属为 `system`（系统插件 `heming.core`），不再是 `builtin`；
 * 分组标签也统一叫「系统能力」——页面里不再出现「内置」这个第二套说法。
 */
export function groupCatalogTools(catalog: CapabilityCatalog): CapabilityToolGroup[] {
  const order: ToolGroupKind[] = ["system", "mcp", "plugin", "self"];
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

/** 工具束分组：同一个插件的多个工具束归到一个折叠组（按插件名排序，稳定输出）。 */
export interface ToolPackGroup {
  pluginId: string;
  pluginName: string;
  enabled: boolean;
  packs: CatalogToolPack[];
}

/**
 * 把目录里的工具束按插件分组。
 *
 * 为什么按插件分组而不是平铺：工具束是「插件声明我用哪些工具」，
 * 用户排查时关心的是「哪个插件声明了哪些、哪些还没连接」——按插件归组才读得出来。
 * 停用插件仍展示（`enabled: false`），只标注「插件已停用」，不隐藏归属。
 */
export function groupToolPacks(catalog: CapabilityCatalog): ToolPackGroup[] {
  const groups = new Map<string, ToolPackGroup>();
  for (const pack of catalog.toolPacks) {
    const group = groups.get(pack.pluginId);
    if (group) {
      group.packs.push(pack);
      group.enabled = group.enabled && pack.enabled;
      continue;
    }
    groups.set(pack.pluginId, {
      pluginId: pack.pluginId,
      pluginName: pack.pluginName,
      enabled: pack.enabled,
      packs: [pack],
    });
  }
  return [...groups.values()];
}

/* ------------------------------------------------------------ 安装信任（d.66） */

/** 指纹展示：`fnv1a64:0123456789abcdef` → `fnv1a64:01234567…`（完整值放 title）。 */
export function shortFingerprint(fingerprint: string): string {
  const text = String(fingerprint ?? "");
  const colon = text.indexOf(":");
  if (colon < 0) return text.length > 12 ? `${text.slice(0, 12)}…` : text;
  const prefix = text.slice(0, colon + 1);
  const digest = text.slice(colon + 1);
  return digest.length > 8 ? `${prefix}${digest.slice(0, 8)}…` : text;
}

/**
 * 信任行的状态文案（三种）：首次安装 / 与上次相同 / 与上次不同。
 *
 * 「与上次相同」对应用户心里的问题「这次更新到底改没改内容」——
 * 只比版本号会漏掉「同版本内容被替换」，所以用指纹比。
 */
export function trustStatusText(trust: PluginTrustPreview): string {
  if (!trust.previousFingerprint) return "首次安装";
  return trust.previousFingerprint === trust.fingerprint ? "与上次相同" : "与上次不同";
}

/** 作者变化文案；未变化返回 null（不显示空提示）。新作者来自本次清单。 */
export function authorChangeText(trust: PluginTrustPreview, nextAuthor: string): string | null {
  if (!trust.authorChanged) return null;
  return `作者：${trust.previousAuthor || "（未署名）"} → ${nextAuthor || "（未署名）"}`;
}

/**
 * 本插件自己登记的服务提供的工具：`plugin:<pluginId>:<key>` 开头。
 * 只有这类工具能在插件详情里直接开关（其它工具去接口区）。
 */
export function isOwnPluginTool(serverId: string | undefined, pluginId: string): boolean {
  if (!serverId) return false;
  return serverId.startsWith(`plugin:${pluginId}:`);
}

/* ------------------------------------------------------ 签名与贡献级停用（d.67） */

/** 验签状态中文（四态）；「环境不支持」必须明说，不能让人以为验过了。 */
export function signatureStatusLabel(status: SignatureStatus): string {
  switch (status) {
    case "valid":
      return "有效";
    case "invalid":
      return "无效";
    case "unsupported":
      return "环境不支持";
    default:
      return "未签名";
  }
}

export const CONTRIBUTION_KIND_LABELS: Record<PluginContributionKind, string> = {
  skills: "技能",
  mcpServers: "服务",
  commands: "命令",
  toolPacks: "工具束",
};

export interface ContributionKindRow {
  kind: PluginContributionKind;
  label: string;
  count: number;
  /** 该类是否被单独停用（贡献级开关当前值）。 */
  enabled: boolean;
}

/**
 * 详情「贡献」段四类各一行：技能 / 服务 / 命令 / 工具束。
 *
 * 计数来自清单声明（与卡片的贡献行同源）；启停只影响这一类，主开关仍是总闸。
 */
export function contributionKindRows(plugin: InstalledPlugin): ContributionKindRow[] {
  const c = plugin.manifest.contributions;
  const counts: Record<PluginContributionKind, number> = {
    skills: c.skills.length,
    mcpServers: c.mcpServers.length,
    commands: c.commands.length,
    toolPacks: c.toolPacks.length,
  };
  return (Object.keys(CONTRIBUTION_KIND_LABELS) as PluginContributionKind[]).map((kind) => ({
    kind,
    label: CONTRIBUTION_KIND_LABELS[kind],
    count: counts[kind],
    enabled: !plugin.disabledKinds.includes(kind),
  }));
}

/** 插件卡「部分停用」判定：主开关仍开、但至少一类贡献被单独关掉。 */
export function isPartiallyDisabled(plugin: InstalledPlugin): boolean {
  return plugin.enabled && plugin.disabledKinds.length > 0;
}

/** 「部分停用」徽标的 title：把被停用的类别列出来。 */
export function partialDisabledTitle(plugin: InstalledPlugin): string {
  const labels = plugin.disabledKinds.map((kind) => CONTRIBUTION_KIND_LABELS[kind]);
  return labels.length > 0 ? `已停用：${labels.join("、")}` : "";
}

/* ---------------------------------------------------------------- 统计卡 */

export interface CapabilityStats {
  /** 系统插件恒为 1（d.65：内置能力也是一个插件，置顶只读）。 */
  system: number;
  plugins: number;
  skills: number;
  tools: number;
  mcpServers: number;
}

/**
 * 头部四个统计卡：插件（系统 1 + 已装 N）/ 技能 / 工具 / MCP 服务。
 *
 * 口径固定：除「已装」来自插件存储外，技能/工具/MCP 一律取 `describeCapabilities()`
 * 的 counts（页面不再自己数目录或技能池），避免同一页出现两套数。
 */
export function describeCapabilityStats(input: {
  plugins: Pick<PluginStore, "list">;
  capabilities: CapabilitySnapshot;
}): CapabilityStats {
  return {
    system: 1,
    plugins: input.plugins.list().length,
    skills: input.capabilities.counts.byKind.skill,
    tools: input.capabilities.counts.byKind.tool,
    mcpServers: input.capabilities.counts.byKind.mcp,
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
