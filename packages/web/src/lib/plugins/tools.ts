import {
  hasCompatibleUpdate,
  pickInstallVersion,
  type MarketIndex,
  type MarketPlugin,
  type MarketVersion,
} from "@heming/shared";
import type { ToolBridge } from "../agentStream.js";
import type { RiskLevel } from "../hitl/types.js";
import { downloadPluginManifest } from "./catalogClient.js";
import {
  fetchMarketIndex,
  findMarketPlugin,
  indexToCatalogEntry,
  pickDeclarativeVersion,
} from "./marketClient.js";
import { currentAppVersion } from "./manifest.js";
import { pluginStore, type InstallPlan, type PluginStore } from "./store.js";

/**
 * 插件市场的**只读**智能体工具（d.108，规格 §9「Agent 工具分级」）。
 *
 * 分级口径（照 DSH 的保守边界）：
 * - `plugin_market_search` / `plugin_install_preview` 都**免批**：它们只读索引与清单，
 *   不写任何存储、不碰主进程安装器，所以不需要打断用户；
 * - `plugin_install`（写）留给 HITL：本轮不在这里提供——安装的确认卡复用 UI 的
 *   安装预览（`store.planInstall` → 用户确认 → `store.applyPlan`），工具侧不另造一条写入路径。
 *
 * 边界：这里刻意**不 apply**。`preview` 与 UI 弹窗走同一个 `pluginStore.planInstall`
 * 纯函数，因此「工具里看到的权限/冲突/体积」与用户点确认时看到的是同一份口径；
 * 一旦工具自行落盘，就会出现「模型说装了、用户没确认」的越权路径。
 *
 * 市场读取复用 `marketClient`（与市场页同一条 `?hostVersion=` 过滤 + 双保险口径），
 * 下载复用 `downloadPluginManifest`（同一条 sha256 校验纪律），本文件只做「映射成模型友好形状」。
 */

/** 搜索默认/上限（规格：≤20 条，默认 10）。 */
export const PLUGIN_SEARCH_DEFAULT = 10;
export const PLUGIN_SEARCH_MAX = 20;

/** 索引不可用时的统一降级形状：不抛错，让模型能改口或让用户手动开插件页。 */
export interface MarketUnavailable {
  unavailable: true;
  reason: string;
}

/** 搜索结果的单条（紧凑；字段名即规格里的契约）。 */
export interface MarketSearchItem {
  id: string;
  title: string;
  description: string;
  author: string;
  /** 可安装的推荐版本（稳定版优先、按宿主版本过滤；无版本时 null）。 */
  latest: string | null;
  /** 能走声明式安装（manifest 分发）、未下架，且预览路径可用。 */
  installable: boolean;
  /** 存在与当前宿主兼容的版本（含只能去插件页安装的界面插件包）。 */
  compatible: boolean;
  status: "active" | "deprecated" | "removed";
  tags: string[];
}

/** 预览结果：全部来自 `planInstall` 的纯函数产物，只读。 */
export interface PluginInstallPreviewResult {
  id: string;
  version: string;
  name: string;
  mode: "install" | "update";
  engines: InstallPlan["engines"];
  permissions: InstallPlan["v5"]["permissions"];
  contributions: {
    skills: string[];
    mcpServers: string[];
    commands: string[];
    toolPacks: string[];
    desktopWidgets: string[];
  };
  diff: {
    skills: { added: string[]; changed: string[]; removed: string[] };
    servers: {
      added: { key: string; name: string }[];
      changed: { key: string; name: string }[];
      removed: { key: string; name: string }[];
    };
    hosts: string[];
  };
  conflicts: InstallPlan["conflicts"];
  sizeEstimate: InstallPlan["size"];
  permissionUpgrade: InstallPlan["permissionUpgrade"];
  warnings: string[];
  /** 非空 = 这个计划会被硬规则挡住（engines/冲突/降级/超体积），此时 apply 必失败。 */
  blocked: InstallPlan["blocked"];
  installedVersion: string | null;
  updatable: boolean;
}

/** 预览的失败形状：市场/网络/清单问题都走这里，绝不抛到编排层。 */
export interface PreviewFailure {
  id?: string;
  version?: string;
  error: string;
}

export interface PluginToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  riskHint: RiskLevel;
}

/** 依赖注入面：测试不碰真实网络/真实存储。 */
export interface PluginToolsDeps {
  /** 原生 fetch（缺省全局 fetch）；市场索引与清单下载共用。 */
  fetchImpl?: typeof fetch;
  sha256Hex?: (bytes: Uint8Array) => Promise<string>;
  /** 全局单例可覆盖，测试用内存 `PluginStore`。 */
  store?: PluginStore;
  /** 当前和鸣版本；缺省读构建期 `__APP_VERSION__`，测试可注入。 */
  hostVersion?: string;
}

const str = (description: string) => ({ type: "string" as const, description });

const READONLY_NOTE = "这是只读操作：不会安装、不会写入任何存储，也不会替用户做决定。";

export const PLUGIN_TOOLS: PluginToolSpec[] = [
  {
    name: "plugin_market_search",
    riskHint: "read",
    description:
      `${READONLY_NOTE}搜索云端插件市场索引，用于在回答「有哪些插件/能不能装」之前先看市场有什么。` +
      `返回至多 ${PLUGIN_SEARCH_MAX} 条（默认 ${PLUGIN_SEARCH_DEFAULT}）紧凑条目：` +
      "id / title / description / author / latest / installable / compatible / status / tags。" +
      "installable=false 通常表示没有与当前和鸣版本兼容的版本，或该版本是界面插件包（bundle），" +
      "此时应改用插件页安装而不是让用户照命令行操作。索引不可用时返回 { unavailable: true, reason }。" +
      "要装某个插件前，先调用 plugin_install_preview 看权限、冲突与体积。",
    parameters: {
      type: "object",
      properties: {
        query: str("关键词：匹配 id/标题/描述/作者/分类/标签。留空 = 列出全部（受 limit 限制）。"),
        category: str("分类 id（精确匹配；来自索引的 categories 声明）。"),
        tags: {
          type: "array",
          items: { type: "string" },
          description: "要求同时具备的标签 id（AND 语义）。",
        },
        limit: {
          type: "number",
          description: `返回条数（默认 ${PLUGIN_SEARCH_DEFAULT}，上限 ${PLUGIN_SEARCH_MAX}）。`,
        },
      },
      required: [],
    },
  },
  {
    name: "plugin_install_preview",
    riskHint: "read",
    description:
      `${READONLY_NOTE}预览「如果真的安装/更新这个插件」会发生什么：` +
      "engines 兼容性、permissions（网络/工具/文件/渲染）、contributions（技能/MCP/命令/工具束/小组件）、" +
      "与已装内容的差异、MCP 服务 id 冲突、体积估算、权限扩张与警告；blocked 非空表示该版本装不上。" +
      "这只是预览：真正安装必须由用户在插件页确认（HITL），你不要、也不能在这里替用户安装。" +
      "没有传 version 时自动选一个与当前和鸣兼容的推荐版本；已安装时额外返回 installedVersion 与 updatable。",
    parameters: {
      type: "object",
      properties: {
        id: str("插件 id（来自 plugin_market_search 的结果）。"),
        version: str("精确版本号（可选；缺省自动选推荐版本）。"),
      },
      required: ["id"],
    },
  },
];

function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function optStr(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** `limit`：非数字/越界都收敛到合法区间，绝不因为模型乱写就报错。 */
export function normalizeSearchLimit(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return PLUGIN_SEARCH_DEFAULT;
  return Math.min(PLUGIN_SEARCH_MAX, Math.max(1, Math.floor(n)));
}

/** 关键词 AND 匹配：id/标题/描述/作者/分类/标签/关键词/旧 id 都进候选文本。 */
export function matchesMarketQuery(plugin: MarketPlugin, query: string): boolean {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return true;
  const hay = [
    plugin.id,
    plugin.title ?? "",
    plugin.description ?? "",
    plugin.author ?? "",
    plugin.metadata?.category ?? "",
    ...(plugin.metadata?.tags ?? []),
    ...(plugin.metadata?.keywords ?? []),
    ...(plugin.renames ?? []),
  ]
    .join(" ")
    .toLowerCase();
  return tokens.every((token) => hay.includes(token));
}

/** 标签 AND 匹配（大小写不敏感）。 */
export function matchesTags(plugin: MarketPlugin, tags: readonly string[]): boolean {
  if (tags.length === 0) return true;
  const own = new Set((plugin.metadata?.tags ?? []).map((tag) => tag.toLowerCase()));
  return tags.every((tag) => own.has(tag.toLowerCase()));
}

/** 搜索结果的单条映射：选版本 → 兼容/可安装/状态。 */
export function toSearchItem(plugin: MarketPlugin, hostVersion: string): MarketSearchItem {
  const anyVersion = pickInstallVersion(plugin, hostVersion ? { hostVersion } : {});
  // 「可预览/可声明式安装」只认 manifest 分发；界面插件包要走主进程安装器。
  const declarative = pickDeclarativeVersion(plugin, hostVersion || undefined);
  return {
    id: plugin.id,
    title: plugin.title ?? plugin.id,
    description: plugin.description ?? "",
    author: plugin.author ?? "",
    latest: (declarative ?? anyVersion)?.version ?? null,
    installable: declarative !== null && plugin.status !== "removed",
    compatible: anyVersion !== null,
    status: plugin.status ?? "active",
    tags: plugin.metadata?.tags ?? [],
  };
}

/**
 * 选预览版本：显式 version 优先（允许预览不兼容版本，好让模型解释「为什么装不上」），
 * 否则只自动选**可声明式安装**的版本（bundle 由预览明确拒绝，而不是静默挑一个）。
 */
export function pickPreviewVersion(
  plugin: MarketPlugin,
  version: string | undefined,
  hostVersion: string,
): MarketVersion | null {
  if (version) {
    const exact = plugin.versions.find((candidate) => candidate.version === version);
    if (!exact || exact.status === "deleted") return null;
    return exact;
  }
  return pickDeclarativeVersion(plugin, hostVersion || undefined);
}

/** `planInstall` 的纯函数产物 → 工具输出（字段名按规格；不泄漏 manifest 原文）。 */
export function toPreviewResult(
  plan: InstallPlan,
  plugin: MarketPlugin | null,
  hostVersion: string,
  installedVersion: string | null,
): PluginInstallPreviewResult {
  const v5 = plan.v5;
  return {
    id: plan.manifest.id,
    version: plan.manifest.version,
    name: plan.manifest.name,
    mode: plan.mode,
    engines: plan.engines,
    permissions: v5.permissions,
    contributions: {
      skills: v5.contributions.skills.map((skill) => skill.name),
      mcpServers: v5.contributions.mcpServers.map((server) => server.key),
      commands: v5.contributions.commands.map((command) => command.id),
      toolPacks: v5.contributions.toolPacks.map((pack) => pack.id),
      desktopWidgets: v5.contributions.desktopWidgets.map((widget) => widget.id),
    },
    diff: {
      skills: {
        added: plan.diff.skills.added,
        changed: plan.diff.skills.changed,
        removed: plan.diff.skills.removed,
      },
      servers: {
        added: plan.diff.servers.added,
        changed: plan.diff.servers.changed,
        removed: plan.diff.servers.removed,
      },
      hosts: plan.diff.hosts,
    },
    conflicts: plan.conflicts,
    sizeEstimate: plan.size,
    permissionUpgrade: plan.permissionUpgrade,
    warnings: plan.warnings,
    blocked: plan.blocked,
    installedVersion,
    updatable:
      plugin !== null && installedVersion !== null && hostVersion !== ""
        ? hasCompatibleUpdate(plugin, installedVersion, hostVersion)
        : false,
  };
}

/** 工具执行入口（可注入依赖；生产用全局 `pluginStore` 与真实网络）。 */
export function buildPluginToolBridge(deps: PluginToolsDeps = {}): ToolBridge {
  const store = deps.store ?? pluginStore;
  const hostVersion = deps.hostVersion ?? currentAppVersion();

  const loadIndex = async (options: { filtered: boolean }): Promise<MarketIndex> => {
    const result = await fetchMarketIndex({
      fetchImpl: deps.fetchImpl,
      ...(options.filtered && hostVersion ? { hostVersion } : {}),
    });
    return result.index;
  };

  const search = async (
    args: Record<string, unknown>,
  ): Promise<MarketSearchItem[] | MarketUnavailable> => {
    let index: MarketIndex;
    try {
      index = await loadIndex({ filtered: true });
    } catch (err) {
      return { unavailable: true, reason: reasonOf(err) };
    }
    const query = optStr(args, "query") ?? "";
    const category = optStr(args, "category");
    const rawTags = args.tags;
    const tags = Array.isArray(rawTags)
      ? rawTags.filter((tag): tag is string => typeof tag === "string" && tag.trim() !== "")
      : [];
    const limit = normalizeSearchLimit(args.limit);

    return index.plugins
      .filter((plugin) => matchesMarketQuery(plugin, query))
      .filter((plugin) => !category || plugin.metadata?.category === category)
      .filter((plugin) => matchesTags(plugin, tags))
      .slice(0, limit)
      .map((plugin) => toSearchItem(plugin, hostVersion));
  };

  const preview = async (
    args: Record<string, unknown>,
  ): Promise<PluginInstallPreviewResult | PreviewFailure | MarketUnavailable> => {
    const id = optStr(args, "id");
    if (!id) return { error: "id 不能为空：先用 plugin_market_search 找到插件 id。" };
    const version = optStr(args, "version");

    let index: MarketIndex;
    try {
      // 预览故意取**未按宿主过滤**的索引：显式指定旧/不兼容版本时也要能拿到清单，
      // 好让 `planInstall` 用 engines 规则如实拦截并解释原因（搜索才做宿主过滤）。
      index = await loadIndex({ filtered: false });
    } catch (err) {
      return { unavailable: true, reason: reasonOf(err) };
    }
    const plugin = findMarketPlugin(index, id) ?? null;
    if (!plugin) return { id, version, error: `市场索引里没有插件 ${id}` };
    if (plugin.status === "removed") {
      return {
        id,
        version,
        error: `插件 ${id} 已下架${plugin.alternativeId ? `，建议改用 ${plugin.alternativeId}` : ""}`,
      };
    }

    const selected = pickPreviewVersion(plugin, version, hostVersion);
    if (!selected) {
      if (version) {
        return { id, version, error: `市场里没有 ${id}@${version} 这个可安装版本（可能已删除）` };
      }
      const anyVersion = pickInstallVersion(plugin, hostVersion ? { hostVersion } : {});
      if (anyVersion && anyVersion.distribution !== "manifest") {
        return {
          id,
          error: "该版本是界面插件包（bundle），只能在插件页由用户安装，不能走清单预览",
        };
      }
      return {
        id,
        error: `插件 ${id} 没有与当前和鸣版本（${hostVersion || "未知"}）兼容的版本`,
      };
    }
    if (selected.distribution !== "manifest") {
      return {
        id,
        version: selected.version,
        error: "该版本是界面插件包（bundle），只能在插件页由用户安装，不能走清单预览",
      };
    }

    let text: string;
    try {
      // 与市场页/安装弹窗同一条下载纪律：按索引里的 sha256 校验后才交给 planInstall。
      text = await downloadPluginManifest(indexToCatalogEntry(plugin, selected), {
        fetchImpl: deps.fetchImpl,
        sha256Hex: deps.sha256Hex,
      });
    } catch (err) {
      return { id, version: selected.version, error: reasonOf(err) };
    }

    const installed = store.get(id) ?? null;
    const plan = store.planInstall(text, hostVersion ? { appVersion: hostVersion } : {});
    return toPreviewResult(plan, plugin, hostVersion, installed?.manifest.version ?? null);
  };

  return {
    tools: PLUGIN_TOOLS.map((spec) => ({
      type: "function" as const,
      function: {
        name: spec.name,
        description: spec.description,
        parameters: spec.parameters,
      },
    })),
    meta: (name) => {
      const spec = PLUGIN_TOOLS.find((candidate) => candidate.name === name);
      return spec ? { risk: spec.riskHint } : undefined;
    },
    execute: async (call, opts) => {
      if (opts?.signal?.aborted) {
        return { text: "用户已中断，插件市场查询未执行。", ok: false };
      }
      const args = parseArgs(call.arguments);
      try {
        switch (call.name) {
          case "plugin_market_search": {
            const result = await search(args);
            return { text: JSON.stringify(result), ok: true };
          }
          case "plugin_install_preview": {
            const result = await preview(args);
            return { text: JSON.stringify(result), ok: true };
          }
          default:
            return { text: `未知工具 ${call.name}`, ok: false };
        }
      } catch (err) {
        // 只读工具也不该把整轮打挂：失败信息回给模型，让它可以改口或让用户去插件页。
        return { text: `插件市场工具执行失败：${reasonOf(err)}`, ok: false };
      }
    },
  };
}
