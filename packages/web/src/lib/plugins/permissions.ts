import type { PluginManifest, PluginToolRisk } from "./manifest.js";

/**
 * 插件权限模型（d.64 · 统一插件模型 T1）。
 *
 * 权限是**显式声明 + 运行时只能收紧**：
 * 1. 安装前：详情/安装弹窗展示 `permissions`（网络主机 / 工具风险上限 / 预留文件根）
 *    与贡献计数——用户点「安装」等于确认这份清单；
 * 2. 装配期：`plugin:` 服务提供的工具若风险高于插件声明的上限，**不注入**给模型
 *    （见 `riskAllowed`；被过滤项由能力目录的 `blocked` 展示）；
 * 3. 停用/卸载沿用既有级联；HITL 判定链完全不变——过滤只减少可调用工具，
 *    不会让任何写工具绕过确认。
 *
 * v1/v2 旧包没有权限声明：`parsePluginManifest` 归一化时补成
 * `network = 其服务 host 全集、tools = "read"`（等于安装时已确认的既有事实），
 * 本模块对它们不做额外拦截。
 */

export type { PluginToolRisk };

/** 解析权限报告时用到的、来自清单的服务地址。 */
export interface PluginPermissionReport {
  network: string[];
  files: string[];
  tools: PluginToolRisk;
  /** 由 `mcpServers` 推导、实际会访问的主机（host 或 host:port）。 */
  hosts: string[];
  /** `hosts - network`；解析期已经拒绝，这里是运行时兜底（正常应为空）。 */
  undeclared: string[];
  /** 声明是否覆盖了全部实际访问主机。 */
  accepted: boolean;
}

/**
 * 从 URL 取「实际会访问的主机」：`host`（含非默认端口），小写。
 *
 * 为什么用 `host` 而不是 `hostname`：`http://localhost:3000` 与
 * `http://localhost:4000` 是两台不同的服务，权限白名单必须能区分；
 * 默认端口（https 的 443）会被 URL 规范化掉，不会造成多余配置。
 */
export function hostOfUrl(url: string): string {
  try {
    return new URL(String(url ?? "")).host.toLowerCase();
  } catch {
    return "";
  }
}

/**
 * 从插件登记的服务 id 反解插件 id：`plugin:<插件 id>:<服务 key>` → `<插件 id>`。
 * 不是插件服务（或格式不合法）返回 null——调用方据此区分「插件归属」与「普通 MCP 服务」。
 */
export function pluginIdFromServerId(serverId: string): string | null {
  if (typeof serverId !== "string" || !serverId.startsWith("plugin:")) return null;
  const rest = serverId.slice("plugin:".length);
  const sep = rest.indexOf(":");
  if (sep <= 0) return null;
  const pluginId = rest.slice(0, sep);
  // 与插件 id 的校验口径一致：小写字母/数字开头，允许点、下划线、连字符，≤64
  return /^[a-z0-9][a-z0-9._-]{0,63}$/.test(pluginId) ? pluginId : null;
}

/**
 * 工具风险是否在插件声明的上限之内。
 *
 * - `none`：不提供任何 MCP 工具（装了也不注入）；
 * - `read`：只提供只读工具（写工具会被过滤）；
 * - `write`：按 HITL 正常判定（写工具仍需用户确认，权限上限不放宽审批）。
 */
export function riskAllowed(risk: "read" | "write", ceiling: PluginToolRisk): boolean {
  if (ceiling === "none") return false;
  if (ceiling === "read") return risk === "read";
  return true;
}

/**
 * 规范化「权限声明里的主机」：小写，并去掉 http/https 的默认端口（80/443）。
 *
 * 为什么需要：URL 解析会把 `https://api.acme.com:443/mcp` 的 host 规范成
 * `api.acme.com`，而作者按「实际访问地址」写的 `api.acme.com:443` 若原样参与比对，
 * 就会被判成「未声明主机」——提示他补的正是刚写的那个值（d.77 修复）。
 * 非默认端口（:8787 / :8443）照旧保留：不同端口是不同服务。
 */
export function normalizeNetworkHost(value: string): string {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) return "";
  try {
    const url = new URL(`http://${raw}`);
    const port = url.port === "80" || url.port === "443" ? "" : url.port;
    return `${url.hostname}${port ? `:${port}` : ""}`;
  } catch {
    return raw;
  }
}

/**
 * 生成一份权限报告（安装弹窗与运行时兜底共用同一口径）。
 *
 * 主机覆盖判定是**精确匹配**（case-insensitive）：声明 `api.acme.com` 不会顺带
 * 放行 `api.acme.com:8443`——「声明即约束」，宁可多列一行也不静默放宽。
 */
export function evaluatePluginPermissions(manifest: PluginManifest): PluginPermissionReport {
  const network = [...manifest.permissions.network];
  const files = [...manifest.permissions.files];
  const tools = manifest.permissions.tools;
  const hosts: string[] = [];
  for (const server of manifest.contributions.mcpServers) {
    const host = hostOfUrl(server.url);
    if (host && !hosts.includes(host)) hosts.push(host);
  }
  const declared = new Set(network.map(normalizeNetworkHost));
  const undeclared = hosts.filter((host) => !declared.has(host));
  return {
    network,
    files,
    tools,
    hosts,
    undeclared,
    accepted: undeclared.length === 0,
  };
}
