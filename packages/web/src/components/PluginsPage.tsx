import { useEffect, useMemo, useState } from "react";
import type { PluginCatalogEntry } from "@heming/shared";
import { useSessionTab } from "../lib/sessionState.js";
import {
  describeCapabilities,
  describeCapabilityCatalog,
  pluginStore,
  type CapabilityCatalog,
  type CapabilitySnapshot,
  type InstalledPlugin,
  type PluginInstallOptions,
  type PluginInstallPreview,
  type PluginManifest,
  type PluginStore,
  type PluginHealth,
  type PublisherTrustStore,
  type SignatureCheck,
  PublisherTrustStore as PublisherTrustStoreClass,
  publicKeyFingerprint,
  verifyManifestSignature,
} from "../lib/plugins/index.js";
import { mcpRegistry, type McpRegistry } from "../lib/mcp/index.js";
import { skillPool, type SkillPool } from "../lib/skills/index.js";
import { useUiStore, type PageView } from "../store/ui.js";
import {
  AlertIcon,
  CheckIcon,
  DownloadIcon,
  FileIcon,
  PackageIcon,
  PlugIcon,
  XIcon,
} from "./icons.js";
import { PageShell } from "./layout/PageShell.js";
import { PAGE_TABLIST, pageTabClass } from "../lib/ui/tabStyles.js";
import { InstallDialog } from "./plugins/InstallDialog.js";

import { PluginRepositoryDialog } from "./plugins/PluginRepositoryDialog.js";
import { downloadPluginManifest } from "../lib/plugins/catalogClient.js";
import { installBundleFromMarket } from "../lib/widgets/marketInstall.js";
import { PluginCard } from "./plugins/PluginCard.js";
import { PluginDetailDialog } from "./plugins/PluginDetailDialog.js";
import { RemovePluginDialog } from "./plugins/RemovePluginDialog.js";
import { PluginStats } from "./plugins/PluginStats.js";
import { SystemPluginCard } from "./plugins/SystemPluginCard.js";
import { PluginToolPanel } from "./plugins/PluginToolPanel.js";
import { ModulePluginCard } from "./plugins/ModulePluginCard.js";
import { CloudModulesDialog } from "./plugins/CloudModulesDialog.js";
import { WidgetsView } from "./plugins/WidgetsView.js";
import { SkillsView } from "./SkillsPage.js";
import { InterfacesView } from "./InterfacesPage.js";
import {
  describeBlockedTools,
  describeCapabilityStats,
  groupCatalogTools,
  groupToolPacks,
  installResultMessage,
} from "./plugins/viewModel.js";
import { BTN_GHOST_SM, ERROR_TEXT, HINT, OK_TEXT } from "./plugins/shared.js";
import { BUILTIN_MODULES, MODULE_BY_ID, type ModuleId } from "../lib/modules/registry.js";
import { useModuleStore } from "../lib/modules/store.js";
import { refreshWidgets, useWidgetsStore, widgetsAvailable } from "../lib/widgets/store.js";
import { pluginPageEntries } from "../lib/pages/registry.js";
import {
  buildUnitStatuses,
  refreshUnits,
} from "../lib/units/registry.js";
import { detectUnitOrphans } from "../lib/units/projection.js";
import { UnitListView } from "./plugins/UnitListView.js";
import { UnitDiagnostics } from "./plugins/UnitDiagnostics.js";

/**
 * 插件区 · 统一能力中枢。
 *
 * 插件 = 能力包：技能 / 工具 / MCP 服务 / 命令，外加随应用发布的**可安装内置模块**
 * （幕僚 / 信息中枢 / 自动化）。本页把此前散在插件区、技能区、接口区的口径合并成
 * 三个 Tab（插件 / 技能 / MCP），数据全部只读本机（插件存储、技能池、能力目录、MCP 注册表），不发起网络请求。
 *
 * 市场页与模块页已删除：市场只保留「仓库」一条安装路径（同一份云端清单），
 * 官方页面插件、声明式插件与界面插件统一放在「插件」Tab（可安装/删除/启停/打开页面），全部由我们的服务器仓库分发。
 * 「技能」「MCP」两个 Tab 是完整的 `SkillsView` / `InterfacesView`，页内动作只切 Tab、不跨页。
 */

type TabKey = "plugins" | "skills" | "mcp";

/**
 * 能力只有三类（d.123 用户口径）：
 * - **插件**：可安装的包（声明式插件 / 官方页面插件 / 界面插件），全部由我们的服务器仓库分发；
 * - **技能**：和鸣自带 + 社区（论坛）安装，嵌完整的技能视图；
 * - **MCP**：和鸣自带/预置 + 注册表社区安装；工具授权也在这一页（工具只是 MCP 的明细）。
 */
const TABS: { key: TabKey; label: string }[] = [
  { key: "plugins", label: "插件" },
  { key: "skills", label: "技能" },
  { key: "mcp", label: "MCP" },
];

/**
 * 宿主页视图意图 → 本页 Tab。
 *
 * 一次性意图由 `store/ui.ts` 的 `pageView` 投递：旧链接 `setPage("skills")` /
 * `setPage("interfaces")` 会被折叠成「插件 + 对应视图」；旧的 `modules` 意图
 * （模块页删除前）落到插件 Tab——模块卡就在那里。
 */
const VIEW_TO_TAB: Partial<Record<PageView, TabKey>> = {
  skills: "skills",
  interfaces: "mcp",
  modules: "plugins",
  plugins: "plugins",
};

export interface PluginsPageProps {
  plugins?: PluginStore;
  /** 技能池（默认全局 skillPool；测试注入独立实例）。技能 Tab 的完整技能视图用它。 */
  skills?: SkillPool;
  /** MCP 注册表（默认全局 mcpRegistry）。MCP Tab 的完整接口视图用它。 */
  mcp?: McpRegistry;
  /** 能力目录（默认现场 `describeCapabilityCatalog()`；测试可注入固定目录）。 */
  catalog?: CapabilityCatalog;
  /** 统一能力快照（默认现场 `describeCapabilities()`；测试可注入固定快照）。 */
  capabilities?: CapabilitySnapshot;
  /** 发布者信任表（默认与插件存储共用介质；测试可注入内存实现）。 */
  publishers?: PublisherTrustStore;
  /** 验签实现（测试注入；默认 WebCrypto）。 */
  verify?: (manifest: PluginManifest) => Promise<SignatureCheck>;
  /** 公钥指纹实现（测试注入；默认 SHA-256）。 */
  fingerprintOf?: (publicKey: string) => Promise<string>;
}

/** 主机名（含端口）；清单已校验合法，这里只用于展示。 */
function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

/** 插件区三个 Tab 的会话级记忆：刷新回到上次看的 Tab。 */
const PLUGINS_TAB_KEY = "heming.tab.plugins.v1";
const PLUGINS_TABS = ["plugins", "skills", "mcp"] as const satisfies readonly TabKey[];

export function PluginsPage({
  plugins = pluginStore,
  skills = skillPool,
  mcp = mcpRegistry,
  catalog,
  capabilities: capabilitiesProp,
  publishers: publishersProp,
  verify = verifyManifestSignature,
  fingerprintOf = publicKeyFingerprint,
}: PluginsPageProps = {}) {
  const [tick, setTick] = useState(0);
  const setPage = useUiStore((s) => s.setPage);
  const [tab, setTab] = useSessionTab<TabKey>(PLUGINS_TAB_KEY, "plugins", PLUGINS_TABS);
  const [installOpen, setInstallOpen] = useState(false);
  /** 仓库面板正在下载的包（id@version）：只禁那一张卡的按钮。 */
  const [repoLoadingKey, setRepoLoadingKey] = useState<string | null>(null);
  /** 「下载安装」弹窗：插件页主操作直达云端插件库，不必先找「仓库」Tab。 */
  const [repoDialogOpen, setRepoDialogOpen] = useState(false);
  const [text, setText] = useState("");
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  /** d.113：正在「修复记录」的插件 id（按钮禁用并显示「修复中…」）。 */
  const [repairingId, setRepairingId] = useState<string | null>(null);
  const [removeTarget, setRemoveTarget] = useState<InstalledPlugin | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);

  /**
   * 一次性视图意图（d.67）：旧「技能区 / 接口区」链接、命令面板与桌宠气泡
   * 都会落到「插件区 + pageView」；这里消费一次并切到对应 Tab。
   */
  const pageView = useUiStore((s) => s.pageView);
  useEffect(() => {
    if (!pageView) return;
    const view = useUiStore.getState().consumePageView();
    const next = view ? VIEW_TO_TAB[view] : undefined;
    if (next) setTab(next);
  }, [pageView]);

  // 命令面板「插件」结果跳转：打开该插件详情并短暂高亮卡片（d.61 起的既有行为）。
  // d.108：`open-plugin` 意图也被 target=unit 复用（id 是单元 id）；声明式插件仍开详情，
  // 其它来源（系统 / 内置模块 / 界面插件）没有插件详情，改为在统一单元列表里定位。
  const paletteIntent = useUiStore((s) => s.paletteIntent);
  const consumePaletteIntent = useUiStore((s) => s.consumePaletteIntent);
  const [highlightPluginId, setHighlightPluginId] = useState<string | null>(null);
  /** 统一单元列表的外部定位请求（seq 用意图 token：连点同一条命令也能重新定位）。 */
  const [focusUnit, setFocusUnit] = useState<{ id: string; seq: number } | null>(null);
  useEffect(() => {
    if (paletteIntent?.kind !== "open-plugin") return;
    const id = paletteIntent.data?.id;
    if (id) {
      setTab("plugins");
      if (plugins.get(id)) {
        setDetailId(id);
        setHighlightPluginId(id);
      } else {
        setFocusUnit({ id, seq: paletteIntent.token });
      }
    }
    consumePaletteIntent();
  }, [paletteIntent, consumePaletteIntent, plugins]);

  useEffect(() => {
    if (!highlightPluginId) return;
    const el = document.querySelector(`[data-plugin-id="${highlightPluginId}"]`);
    el?.scrollIntoView?.({ block: "center" });
    const timer = window.setTimeout(() => setHighlightPluginId(null), 2000);
    return () => window.clearTimeout(timer);
  }, [highlightPluginId]);

  /**
   * d.105：界面插件列表由主进程持有，进入插件区时拉一次，保证「已安装」统一列表
   * 能列出 bundle 来源。浏览器没有 `__heming_widgets` 桥时 refreshWidgets 是 no-op。
   */
  useEffect(() => {
    void refreshWidgets();
  }, []);

  /**
   * 安装/启停/卸载后：本页重算 + 统一单元投影失效（pluginStore 没有订阅 API，
   * d.105 的投影快照需要显式刷新，否则「诊断/源徽标」会落后一拍）。
   */
  const bump = () => {
    setTick((n) => n + 1);
    refreshUnits();
  };

  // 数据快照：tick 是「安装/启停后重算」的统一信号；catalog 传入时优先用注入值。
  const list = useMemo(() => plugins.list(), [plugins, tick]);
  const capabilityCatalog = useMemo(
    () => catalog ?? describeCapabilityCatalog({ plugins, mcp }),
    [catalog, plugins, mcp, tick],
  );
  const capabilities = useMemo(
    () => capabilitiesProp ?? describeCapabilities({ skills, mcp, plugins }),
    [capabilitiesProp, skills, mcp, plugins, tick],
  );
  const system = capabilities.system;

  /**
   * d.105 统一能力单元：系统 / 内置模块 / 声明式插件 / 界面插件。
   *
   * 数据源全部来自本页实际使用的 store（注入 props 优先），所以测试夹具与宿主一致的；
   * 模块/界面插件用 zustand selector 订阅，任一变化都会触发下面的投影重算。
   */
  const moduleEnabled = useModuleStore((s) => s.enabled);
  const moduleInstalled = useModuleStore((s) => s.installed);
  const installModule = useModuleStore((s) => s.install);
  /** 只有「已安装」的模块才进统一列表；未安装的模块不渲染（原生应用不携带模块）。 */
  const installedModules = useMemo(
    () => BUILTIN_MODULES.filter((mod) => moduleInstalled[mod.id]),
    [moduleInstalled],
  );
  const [cloudModulesOpen, setCloudModulesOpen] = useState(false);
  const widgetsRecords = useWidgetsStore((s) => s.records);
  /**
   * d.124：插件页面入口（与导航轨、App 路由、设置区导航说明读**同一份注册表投影**）。
   *
   * 卡片只是入口：点「打开页面」跳 `plugin:<id>`，能不能进由注册表判定
   * （插件停用/记录损坏时 `available=false`，按钮不渲染），避免页面里再写一套可用性规则。
   */
  const pluginPages = useMemo(
    () =>
      pluginPageEntries({
        plugins: list,
        widgets: widgetsRecords,
        desktop: widgetsAvailable(),
      }),
    [list, widgetsRecords],
  );
  const pageEntryOf = (pluginId: string) => pluginPages.find((entry) => entry.pluginId === pluginId);
  const unitStatuses = useMemo(
    () =>
      buildUnitStatuses({
        system,
        modules: installedModules,
        moduleEnabled,
        moduleInstalled,
        plugins: list,
        widgets: widgetsRecords,
      }),
    [system, installedModules, moduleEnabled, moduleInstalled, list, widgetsRecords],
  );

  const stats = useMemo(
    () => describeCapabilityStats({ plugins, capabilities }),
    [plugins, capabilities, tick],
  );

  /**
   * d.113：声明式插件的健康度（每个单元一个徽标；broken 单元给「修复记录」）。
   *
   * 走 `plugins.health()` 而不是在页面里直接拼引用数组：健康判定要读**该 store 自己**
   * 的技能池/MCP 端口（测试里插件 store 可能与 `mcp` prop 不是同一个实例）。
   */
  const healthByUnitId = useMemo(() => {
    const out: Record<string, PluginHealth> = {};
    for (const plugin of list) {
      const health = plugins.health(plugin.manifest.id);
      if (health) out[plugin.manifest.id] = health;
    }
    return out;
  }, [plugins, list]);

  /** d.113：修复记录（只修记录，不删技能/服务）；结果进顶部消息条。 */
  const onRepair = (pluginId: string) => {
    setRepairingId(pluginId);
    try {
      const result = plugins.repairPlugin(pluginId);
      bump();
      const name = plugins.get(pluginId)?.manifest.name ?? pluginId;
      if (!result.ok) {
        setMsg({
          kind: "error",
          text: `修复失败${result.rollback?.ok ? "，已恢复到修复前状态" : "，回滚未能完全恢复"}：${
            result.error ?? "写入本机存储失败"
          }`,
        });
        return;
      }
      const actions: Record<string, string> = {
        manifest: "清单",
        skillIds: "技能引用",
        serverIds: "服务引用",
        fingerprint: "内容指纹",
      };
      const parts: string[] = [];
      if (result.repaired.length > 0) {
        parts.push(`已修复 ${result.repaired.map((code) => actions[code] ?? code).join("、")}`);
      }
      if (result.dropped.length > 0) {
        parts.push(`摘掉 ${result.dropped.length} 条悬空引用`);
      }
      if (result.remainingIssues.length > 0) {
        setMsg({
          kind: "error",
          text: `「${name}」${parts.length > 0 ? `${parts.join("；")}；` : ""}仍有 ${
            result.remainingIssues.length
          } 个问题：${result.remainingIssues[0].message}`,
        });
        return;
      }
      setMsg({
        kind: "ok",
        text: `「${name}」${parts.join("；") || "记录已是最新"}`,
      });
    } finally {
      setRepairingId(null);
    }
  };
  /**
   * d.110 孤儿记录：插件记录丢失后仍留在技能池 / MCP 注册表里的物化实体。
   * 只读检测 + 提示，不自动删除（避免误删用户资产）。
   */
  const orphans = useMemo(
    () =>
      detectUnitOrphans({
        plugins: list,
        skills: skills.list(),
        servers: mcp.servers(),
      }),
    [list, skills, mcp, tick],
  );
  const orphanTotal = orphans.skills.length + orphans.servers.length;
  const toolGroups = useMemo(() => groupCatalogTools(capabilityCatalog), [capabilityCatalog]);
  const toolPackGroups = useMemo(() => groupToolPacks(capabilityCatalog), [capabilityCatalog]);
  /** serverId → 服务名（详情里「所属服务」列；缺失时退回 id）。 */
  const serverNameOf = useMemo(() => {
    const names = new Map(mcp.servers().map((server) => [server.id, server.name]));
    return (serverId: string) => names.get(serverId) ?? serverId;
  }, [mcp, tick]);
  const blockedTools = useMemo(
    () => describeBlockedTools(capabilityCatalog, plugins),
    [capabilityCatalog, plugins],
  );

  const previewState = useMemo((): {
    data: PluginInstallPreview | null;
    error: string | null;
  } => {
    if (!text.trim()) return { data: null, error: null };
    try {
      return { data: plugins.preview(text), error: null };
    } catch (err) {
      return { data: null, error: err instanceof Error ? err.message : String(err) };
    }
  }, [plugins, text, tick]);

  const preview = previewState.data;
  const detail = detailId ? plugins.get(detailId) : undefined;
  /** 详情里的「打开页面」：同样只认注册表判为可用的入口。 */
  const detailPageEntry = detail ? pageEntryOf(detail.manifest.id) : undefined;
  const detailSkills = useMemo(
    () => (detailId ? plugins.skillsOf(detailId) : []),
    [plugins, detailId, tick],
  );
  const detailServers = useMemo(
    () => (detailId ? plugins.serversOf(detailId) : []),
    [plugins, detailId, tick],
  );

  const openInstall = () => {
    setText("");
    setMsg(null);
    setInstallOpen(true);
  };

  /**
   * 从仓库载入清单（d.95/d.108）：下载原样 plugin.json（catalogClient 已校验
   * sha256），填进同一个安装弹窗——安装预览/信任确认/写入语义完全一致。
   *
   * d.109：界面插件（bundle）是另一条管线——下载 tgz（再验一次 sha256）交给主进程
   * `widgets:install`（首方验签/解包/落盘），这里只负责结果三态与提示。
   * 市场页删除后这里只剩「仓库」一个来源（d.115）。
   */
  const loadFromRepository = async (entry: PluginCatalogEntry) => {
    const key = `${entry.id}@${entry.version}`;
    setRepoLoadingKey(key);
    setMsg(null);
    try {
      if (entry.distribution === "bundle") {
        const outcome = await installBundleFromMarket(entry);
        if (!outcome.ok) {
          setMsg({ kind: "error", text: `安装失败：${outcome.error ?? "未知原因"}` });
          return;
        }
        const name = outcome.record?.name ?? entry.name;
        const version = outcome.record?.version ?? entry.version;
        setTab("plugins");
        bump();
        setMsg({
          kind: "ok",
          text: `已${outcome.updated ? "更新" : "安装"}界面插件「${name}」${version}，可在「设置 → 外观 → 桌面小组件」启停`,
        });
        return;
      }
      const manifest = await downloadPluginManifest(entry);
      setText(manifest);
      setRepoDialogOpen(false);
      setInstallOpen(true);
    } catch (err) {
      setMsg({
        kind: "error",
        text: err instanceof Error ? err.message : "从仓库下载插件失败",
      });
    } finally {
      setRepoLoadingKey(null);
    }
  };

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      setText(await file.text());
      setMsg(null);
    } catch {
      setMsg({ kind: "error", text: "读取文件失败：无法读取所选文件" });
    }
  };

  const onInstall = (options: PluginInstallOptions = {}) => {
    if (!preview) return;
    const before = preview;
    try {
      const result = plugins.install(text, options);
      bump();
      setText("");
      setInstallOpen(false);
      // 安装/更新后回插件 Tab 并高亮这张卡（沿用命令面板的同一套机制）。
      setTab("plugins");
      setHighlightPluginId(result.plugin.manifest.id);
      setMsg({ kind: "ok", text: installResultMessage(result, before) });
    } catch (err) {
      setMsg({
        kind: "error",
        text: `安装失败：${err instanceof Error ? err.message : String(err)}`,
      });
    }
  };

  const onToggle = (plugin: InstalledPlugin, next: boolean) => {
    // P1-3（d.110）：启停写失败必须可见——此前 store 吞异常，界面显示已停用、
    // 重载后回弹。现在 store 返回结构化结果，失败时保持界面不变并提示。
    const result = plugins.setEnabled(plugin.manifest.id, next);
    bump();
    if (!result.ok) {
      setMsg({
        kind: "error",
        text: `保存失败：${result.error ?? "写入本机存储失败"}${
          result.rollback && !result.rollback.ok ? "（回滚未完全成功）" : ""
        }`,
      });
      return;
    }
    setMsg({
      kind: "ok",
      text: next
        ? `已启用插件「${plugin.manifest.name}」`
        : `已停用插件「${plugin.manifest.name}」，其技能不参与路由，MCP 服务也不再连接`,
    });
  };

  const confirmRemove = () => {
    if (!removeTarget) return;
    const plugin = removeTarget;
    // P0-2（d.110）：卸载是事务操作；失败时记录/技能已回滚，必须如实提示而不是报「已卸载」。
    const result = plugins.remove(plugin.manifest.id);
    setRemoveTarget(null);
    bump();
    if (!result.ok) {
      setMsg({
        kind: "error",
        text: `卸载失败${result.rollback?.ok ? "，已恢复到卸载前状态" : "，回滚未能完全恢复"}：${
          result.error ?? "写入本机存储失败"
        }`,
      });
      return;
    }
    setMsg({
      kind: "ok",
      text: `已卸载插件「${plugin.manifest.name}」，其 ${plugin.skillIds.length} 个技能与 ${plugin.serverIds.length} 台 MCP 服务一并删除`,
    });
  };

  // 页内所有「去技能区 / 去接口区」的入口都收敛成切 Tab（d.67：两页已不存在）。
  const goSkills = () => setTab("skills");
  const goInterfaces = () => setTab("mcp");
  /** 打开某插件详情并高亮卡片：内嵌视图里点「插件：<名>」徽标走这里，不跨页。 */
  const openPluginDetail = (pluginId: string) => {
    setTab("plugins");
    setDetailId(pluginId);
    setHighlightPluginId(pluginId);
  };

  const publishers = useMemo<PublisherTrustStore>(
    () => publishersProp ?? new PublisherTrustStoreClass(),
    [publishersProp],
  );
  const enabledCount = list.filter((plugin) => plugin.enabled).length;

  return (
    <PageShell
      title="插件"
      subtitle="安装一次，带入技能、工具、MCP 服务和命令；全部在本机管理。"
      width="wide"
    >
      <PluginStats stats={stats} />

      {msg && (
        <div
          role="status"
          className={`plugin-rise mb-4 flex items-start gap-2.5 rounded-xl border px-3 py-2.5 ${
            msg.kind === "error"
              ? "border-[var(--danger-line)] bg-[var(--danger-soft)]"
              : "border-line-soft bg-[var(--subtle-2)]"
          }`}
        >
          <span
            aria-hidden="true"
            className={`mt-0.5 shrink-0 ${
              msg.kind === "error" ? "text-[var(--danger)]" : "text-[var(--success)]"
            }`}
          >
            {msg.kind === "error" ? <AlertIcon width={14} height={14} /> : <CheckIcon width={14} height={14} />}
          </span>
          <p className={`min-w-0 flex-1 ${msg.kind === "error" ? ERROR_TEXT : OK_TEXT}`}>
            {msg.text}
          </p>
          <button
            type="button"
            aria-label="关闭提示"
            onClick={() => setMsg(null)}
            className="shrink-0 rounded-sm p-0.5 text-muted transition-colors hover:bg-[var(--subtle-3)] hover:text-ink"
          >
            <XIcon width={13} height={13} />
          </button>
        </div>
      )}

      {/* Tab 栏：复用技能区的角色与下划线样式 */}
      <div className={`${PAGE_TABLIST} border-b border-line-soft`} role="tablist" aria-label="能力分区">
        {TABS.map((item) => {
          const active = tab === item.key;
          return (
            <button
              key={item.key}
              type="button"
              role="tab"
              id={`plugins-${item.key}-tab`}
              aria-controls={`plugins-${item.key}-panel`}
              aria-selected={active}
              onClick={() => setTab(item.key)}
              className={pageTabClass(active)}
            >
              {item.label}
            </button>
          );
        })}
        <span className="ml-auto self-center ui-caption">
          {tab === "plugins"
            ? `已启用 ${enabledCount}/${list.length} 个插件 · 全部由我们的服务器仓库分发`
            : tab === "skills"
              ? "和鸣自带 + 社区（论坛）快捷安装"
              : "和鸣自带/预置 + 注册表社区安装 · 工具授权也在本页"}
        </span>
      </div>

      <div
        role="tabpanel"
        id={`plugins-${tab}-panel`}
        aria-labelledby={`plugins-${tab}-tab`}
        className="mt-4"
      >
        {tab === "plugins" && (
          <>
            {/* 安装入口放在列表上方：插件包与官方页面插件都来自我们自己的服务器仓库。 */}
            <div className="mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-line-soft bg-[var(--surface)] p-2.5">
              <button
                type="button"
                onClick={() => setRepoDialogOpen(true)}
                className="ui-btn ui-btn-sm ui-btn-primary"
              >
                <DownloadIcon width={13} height={13} aria-hidden="true" />
                从插件仓库安装
              </button>
              <button type="button" onClick={openInstall} className="ui-btn ui-btn-sm ui-btn-ghost">
                <FileIcon width={13} height={13} aria-hidden="true" />
                手动粘贴清单
              </button>
              <button
                type="button"
                onClick={() => setCloudModulesOpen(true)}
                className="ui-btn ui-btn-sm ui-btn-ghost"
              >
                <PlugIcon width={13} height={13} aria-hidden="true" />
                安装官方插件
              </button>
              <span className="ml-auto hidden ui-micro sm:inline">
                安装只写本机清单，不运行代码
              </span>
            </div>

            {orphanTotal > 0 && (
              <div
                role="status"
                className="mb-3 rounded-lg border border-[#f3d2ce] bg-[#fffafa] p-3"
                aria-label="孤儿记录提示"
              >
                <p className="ui-body-sm">
                  发现 {orphans.skills.length} 个无主技能 / {orphans.servers.length} 个无主服务
                  （插件记录已丢失），可到技能区/接口区清理。
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <button
                    type="button"
                    className={BTN_GHOST_SM}
                    aria-label="去技能区清理无主技能"
                    onClick={goSkills}
                  >
                    去技能区
                  </button>
                  <button
                    type="button"
                    className={BTN_GHOST_SM}
                    aria-label="去接口区清理无主服务"
                    onClick={goInterfaces}
                  >
                    去接口区
                  </button>
                </div>
              </div>
            )}
            {/* d.105：四类来源（系统 / 内置模块 / 声明式插件 / 界面插件）统一读投影。
                系统卡与插件卡沿用既有组件，详情/启停/卸载入口不变；其余来源用默认行。 */}
            <UnitListView
              statuses={unitStatuses}
              focusUnit={focusUnit}
              healthByUnitId={healthByUnitId}
              onRepair={onRepair}
              repairingPluginId={repairingId}
              renderUnit={(status) => {
                const unit = status.unit;
                if (unit.source === "system") return <SystemPluginCard system={system} />;
                // 内置模块（幕僚 / 信息中枢 / 自动化）：可安装 / 删除 / 启停，投影里已按顺序排好。
                if (unit.source === "builtin") {
                  const mod = MODULE_BY_ID[unit.id as ModuleId];
                  return mod ? <ModulePluginCard mod={mod} /> : null;
                }
                if (unit.source !== "package") return null;
                const plugin = plugins.get(unit.id);
                if (!plugin) return null;
                // d.124：只有注册表判定可用的页面才给「打开页面」；停用插件保留贡献行但不给入口。
                const pageEntry = pageEntryOf(plugin.manifest.id);
                return (
                  <PluginCard
                    plugin={plugin}
                    highlighted={highlightPluginId === plugin.manifest.id}
                    onDetail={() => setDetailId(plugin.manifest.id)}
                    onToggle={(next) => onToggle(plugin, next)}
                    onRemove={() => setRemoveTarget(plugin)}
                    onGoSkills={goSkills}
                    onGoInterfaces={goInterfaces}
                    onOpenPage={
                      pageEntry?.available ? () => setPage(pageEntry.pageId) : undefined
                    }
                  />
                );
              }}
            />

            {/* 声明式插件为空时的入口保持原样（统一列表里仍有系统/内置单元，所以不能复用空列表态） */}
            {list.length === 0 && (
              <section
                className="mt-3 flex flex-col items-center gap-2 rounded-xl border border-line-soft bg-[var(--surface)] py-10 text-center shadow-card"
                aria-label="暂无插件"
              >
                <span className="plugin-icon-tile mb-1 h-11 w-11" aria-hidden="true">
                  <PackageIcon width={20} height={20} />
                </span>
                <p className="ui-section-title">还没有安装插件</p>
                <p className="ui-caption">
                  一份插件清单可以一次带入一组技能、远程 MCP 服务与命令；用上方的「从插件仓库安装」或
                  「手动粘贴清单」开始。
                </p>
              </section>
            )}

            <UnitDiagnostics
              statuses={unitStatuses}
              healthByUnitId={healthByUnitId}
              onRepair={onRepair}
              repairingPluginId={repairingId}
            />

            <p className={`mt-3 max-w-[680px] ${HINT}`}>
              这里安装的插件只声明技能、MCP 服务和命令，不含代码、不带密钥。安装不会运行程序，也不会联网；
              连接与工具启用仍由你手动确认。
            </p>

            {/* 界面插件（原「桌面小组件」Tab）并入插件列表末尾：它也是插件，只是带可执行界面。 */}
            <section aria-label="界面插件" className="mt-6 border-t border-line-soft pt-4">
              <div className="mb-2 flex flex-wrap items-baseline gap-2">
                <h2 className="ui-section-title">界面插件</h2>
                <span className="ui-micro text-muted">
                  含可执行界面代码（首方签名）；装后由宿主开独立窗口
                </span>
              </div>
              <WidgetsView />
            </section>
          </>
        )}

        {/* 技能 Tab：完整技能视图（原技能区页主体）。
            onChanged：技能池变更后让本页统计/能力快照同帧刷新（自检：新建技能后统计不涨）。 */}
        {tab === "skills" && (
          <SkillsView
            skills={skills}
            plugins={plugins}
            onOpenPlugin={openPluginDetail}
            onChanged={bump}
          />
        )}

        {/* MCP Tab：注册表 / 预置服务 + 工具授权（工具只是 MCP 的明细，不再单独成 Tab）。 */}
        {tab === "mcp" && (
          <>
            <InterfacesView registry={mcp} plugins={plugins} onOpenPlugin={openPluginDetail} />
            <section aria-label="工具授权" className="mt-6 border-t border-line-soft pt-4">
              <div className="mb-2 flex flex-wrap items-baseline gap-2">
                <h2 className="ui-section-title">工具授权</h2>
                <span className="ui-micro text-muted">
                  按服务逐个开启；写操作仍逐次人工确认，插件声明的风险上限在这里执行
                </span>
              </div>
              <PluginToolPanel
                groups={toolGroups}
                blocked={blockedTools}
                toolPacks={toolPackGroups}
                onToggleTool={(serverId, toolName, enabled) => {
                  mcp.setToolEnabled(serverId, toolName, enabled);
                  bump();
                }}
              />
            </section>
          </>
        )}
      </div>

      {repoDialogOpen && (
        <PluginRepositoryDialog
          installed={list.map((plugin) => ({
            id: plugin.manifest.id,
            version: plugin.manifest.version,
          }))}
          loadingKey={repoLoadingKey}
          onLoad={loadFromRepository}
          onClose={() => setRepoDialogOpen(false)}
          onError={(message) => setMsg({ kind: "error", text: message })}
        />
      )}

      {cloudModulesOpen && (
        <CloudModulesDialog
          installed={moduleInstalled}
          onInstall={(id) => {
            installModule(id);
            bump();
          }}
          onClose={() => setCloudModulesOpen(false)}
        />
      )}

      {installOpen && (
        <InstallDialog
          text={text}
          previewState={previewState}
          onTextChange={setText}
          onFile={(e) => void onFile(e)}
          onInstall={onInstall}
          onClose={() => setInstallOpen(false)}
          publishers={publishers}
          installed={list.map((plugin) => ({ id: plugin.manifest.id, version: plugin.manifest.version }))}
          verify={verify}
          fingerprintOf={fingerprintOf}
        />
      )}

      {detail && (
        <PluginDetailDialog
          plugin={detail}
          skills={detailSkills}
          servers={detailServers}
          toolPacks={
            toolPackGroups.find((group) => group.pluginId === detail.manifest.id)?.packs ?? []
          }
          mcp={mcp}
          serverNameOf={serverNameOf}
          hostOf={hostOf}
          onKindToggle={(kind, enabled) => {
            // P1-3：贡献级停用同样走事务；失败时保持开关不变并提示「保存失败」。
            const result = plugins.setKindEnabled(detail.manifest.id, kind, enabled);
            bump();
            if (!result.ok) {
              setMsg({
                kind: "error",
                text: `保存失败：${result.error ?? "写入本机存储失败"}${
                  result.rollback && !result.rollback.ok ? "（回滚未完全成功）" : ""
                }`,
              });
            }
          }}
          onClose={() => setDetailId(null)}
          onRemove={() => {
            const target = detail;
            setDetailId(null);
            setRemoveTarget(target);
          }}
          onGoSkills={() => {
            setDetailId(null);
            goSkills();
          }}
          onGoInterfaces={() => {
            setDetailId(null);
            goInterfaces();
          }}
          onOpenPage={
            detailPageEntry?.available
              ? () => {
                  setDetailId(null);
                  setPage(detailPageEntry.pageId);
                }
              : undefined
          }
        />
      )}

      {removeTarget && (
        <RemovePluginDialog
          plugin={removeTarget}
          onCancel={() => setRemoveTarget(null)}
          onConfirm={confirmRemove}
        />
      )}
    </PageShell>
  );
}
