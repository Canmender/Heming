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
  type PublisherTrustStore,
  type SignatureCheck,
  PublisherTrustStore as PublisherTrustStoreClass,
  publicKeyFingerprint,
  verifyManifestSignature,
} from "../lib/plugins/index.js";
import { mcpRegistry, type McpRegistry } from "../lib/mcp/index.js";
import { skillPool, type SkillPool } from "../lib/skills/index.js";
import { useUiStore, type PageView } from "../store/ui.js";
import { PackageIcon, PlusIcon } from "./icons.js";
import { PageShell } from "./layout/PageShell.js";
import { PAGE_TABLIST, pageTabClass } from "../lib/ui/tabStyles.js";
import { InstallDialog } from "./plugins/InstallDialog.js";
import { PluginRepositoryPanel } from "./plugins/PluginRepositoryPanel.js";
import { PluginRepositoryDialog } from "./plugins/PluginRepositoryDialog.js";
import { downloadPluginManifest } from "../lib/plugins/catalogClient.js";
import { PluginCard } from "./plugins/PluginCard.js";
import { PluginDetailDialog } from "./plugins/PluginDetailDialog.js";
import { RemovePluginDialog } from "./plugins/RemovePluginDialog.js";
import { PluginStats } from "./plugins/PluginStats.js";
import { SystemPluginCard } from "./plugins/SystemPluginCard.js";
import { PluginToolPanel } from "./plugins/PluginToolPanel.js";
import { ModulesView } from "./plugins/ModulesView.js";
import { WidgetsView } from "./plugins/WidgetsView.js";
import { SkillsView } from "./SkillsPage.js";
import { InterfacesView } from "./InterfacesPage.js";
import {
  describeBlockedTools,
  describeCapabilityStats,
  filterPlugins,
  groupCatalogTools,
  groupToolPacks,
  installResultMessage,
  type PluginStatusFilter,
} from "./plugins/viewModel.js";
import { BTN_GHOST, ERROR_TEXT, HINT, OK_TEXT } from "./plugins/shared.js";

/**
 * 插件区 · 统一能力中枢（d.64 · T2；d.67 导航合并）。
 *
 * 插件 = 能力包：技能 / 工具 / MCP 服务 / 命令。本页把此前散在插件区、技能区、
 * 接口区的四份口径合并成四个 Tab，数据全部只读本机（插件存储、技能池、能力目录、MCP 注册表），
 * 不发起网络请求；安装/更新/停用/卸载语义与存储格式完全不变。
 *
 * d.67 起「技能」「MCP」两个 Tab 不再是只读摘要：分别内嵌完整的 `SkillsView` /
 * `InterfacesView`（原技能区页、接口区页的页面主体），页内所有「去技能区 / 去接口区」
 * 动作改为切 Tab，不再跨页 setPage——导航里也不再有这两个独立入口。
 */

type TabKey = "plugins" | "repo" | "widgets" | "modules" | "skills" | "tools" | "mcp";

const TABS: { key: TabKey; label: string }[] = [
  { key: "plugins", label: "插件" },
  // d.95：云端插件仓库（浏览/下载/安装）作为一等入口，不再只藏在安装弹窗里
  { key: "repo", label: "仓库" },
  // d.98：界面插件（原桌宠）与声明式插件分开展示——安装路径、信任模型、生命周期都不同
  { key: "widgets", label: "桌面小组件" },
  // d.70：内置能力模块（幕僚 / 信息中枢 / 自动化）与插件同区展示，可启用/停用
  { key: "modules", label: "模块" },
  { key: "skills", label: "技能" },
  { key: "tools", label: "工具" },
  { key: "mcp", label: "MCP 服务" },
];

/** 插件列表的状态筛选（d.77）：三档，默认「全部」。 */
const STATUS_FILTERS: { key: PluginStatusFilter; label: string }[] = [
  { key: "all", label: "全部" },
  { key: "enabled", label: "已启用" },
  { key: "disabled", label: "已停用" },
];

/**
 * 宿主页视图意图 → 本页 Tab（d.67）。
 *
 * 一次性意图由 `store/ui.ts` 的 `pageView` 投递：旧链接 `setPage("skills")` /
 * `setPage("interfaces")` 会被折叠成「插件区 + 对应视图」。本页读走即清，
 * 所以只是「这一次进入」落在哪个 Tab，不会把 Tab 长期钉在 store 里。
 */
const VIEW_TO_TAB: Partial<Record<PageView, TabKey>> = {
  skills: "skills",
  interfaces: "mcp",
  modules: "modules",
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

/** 插件区五个 Tab 的会话级记忆：刷新回到上次看的 Tab。 */
const PLUGINS_TAB_KEY = "heming.tab.plugins.v1";
const PLUGINS_TABS = ["plugins", "repo", "widgets", "modules", "skills", "tools", "mcp"] as const satisfies readonly TabKey[];

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
  const [tab, setTab] = useSessionTab<TabKey>(PLUGINS_TAB_KEY, "plugins", PLUGINS_TABS);
  const [installOpen, setInstallOpen] = useState(false);
  /** 仓库面板正在下载的包（id@version）：只禁那一张卡的按钮。 */
  const [repoLoadingKey, setRepoLoadingKey] = useState<string | null>(null);
  /** 「下载安装」弹窗：插件页主操作直达云端插件库，不必先找「仓库」Tab。 */
  const [repoDialogOpen, setRepoDialogOpen] = useState(false);
  const [text, setText] = useState("");
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [removeTarget, setRemoveTarget] = useState<InstalledPlugin | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  /** 插件列表筛选（d.77）：装到几十个后，按名字/技能/服务找得到；状态可只看已停用。 */
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<PluginStatusFilter>("all");

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
  const paletteIntent = useUiStore((s) => s.paletteIntent);
  const consumePaletteIntent = useUiStore((s) => s.consumePaletteIntent);
  const [highlightPluginId, setHighlightPluginId] = useState<string | null>(null);
  useEffect(() => {
    if (paletteIntent?.kind !== "open-plugin") return;
    const id = paletteIntent.data?.id;
    if (id) {
      setTab("plugins");
      setDetailId(id);
      setHighlightPluginId(id);
    }
    consumePaletteIntent();
  }, [paletteIntent, consumePaletteIntent]);

  useEffect(() => {
    if (!highlightPluginId) return;
    const el = document.querySelector(`[data-plugin-id="${highlightPluginId}"]`);
    el?.scrollIntoView?.({ block: "center" });
    const timer = window.setTimeout(() => setHighlightPluginId(null), 2000);
    return () => window.clearTimeout(timer);
  }, [highlightPluginId]);

  const bump = () => setTick((n) => n + 1);

  // 数据快照：tick 是「安装/启停后重算」的统一信号；catalog 传入时优先用注入值。
  const list = useMemo(() => plugins.list(), [plugins, tick]);
  /** 过滤后的已装插件（系统能力卡不在其中，它是应用内置的只读条目）。 */
  const visiblePlugins = useMemo(
    () => filterPlugins(list, { query, status: statusFilter }),
    [list, query, statusFilter],
  );
  const filterActive = query.trim().length > 0 || statusFilter !== "all";
  const clearFilters = () => {
    setQuery("");
    setStatusFilter("all");
  };
  const capabilityCatalog = useMemo(
    () => catalog ?? describeCapabilityCatalog({ plugins, mcp }),
    [catalog, plugins, mcp, tick],
  );
  const capabilities = useMemo(
    () => capabilitiesProp ?? describeCapabilities({ skills, mcp, plugins }),
    [capabilitiesProp, skills, mcp, plugins, tick],
  );
  const system = capabilities.system;
  const stats = useMemo(
    () => describeCapabilityStats({ plugins, capabilities }),
    [plugins, capabilities, tick],
  );
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
   * 从仓库载入清单（d.95）：下载原样 plugin.json（catalogClient 已校验 sha256），
   * 填进同一个安装弹窗——安装预览/信任确认/写入语义与手动粘贴完全一致。
   */
  const loadFromRepository = async (entry: PluginCatalogEntry) => {
    const key = `${entry.id}@${entry.version}`;
    setRepoLoadingKey(key);
    setMsg(null);
    try {
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
      // 安装/更新后回到插件 Tab 并高亮这张卡：从「技能 / 工具 / MCP」Tab 点安装时，
      // 装完还停在原 Tab 会让人以为没生效（高亮与滚动沿用命令面板的同一套机制）。
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
    try {
      plugins.setEnabled(plugin.manifest.id, next);
      bump();
      setMsg({
        kind: "ok",
        text: next
          ? `已启用插件「${plugin.manifest.name}」`
          : `已停用插件「${plugin.manifest.name}」，其技能不参与路由，MCP 服务也不再连接`,
      });
    } catch (err) {
      setMsg({ kind: "error", text: `切换失败：${err instanceof Error ? err.message : String(err)}` });
    }
  };

  const confirmRemove = () => {
    if (!removeTarget) return;
    const plugin = removeTarget;
    plugins.remove(plugin.manifest.id);
    setRemoveTarget(null);
    bump();
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
      title="插件区"
      subtitle="安装一次，带入技能、工具、MCP 服务和命令；全部在本机管理。"
      width="wide"
      actions={
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setRepoDialogOpen(true)}
            className="ui-btn ui-btn-sm ui-btn-primary"
          >
            下载安装
          </button>
          <button type="button" onClick={openInstall} className={`flex items-center gap-1 ${BTN_GHOST}`}>
            <PlusIcon width={12} height={12} aria-hidden="true" />
            手动安装
          </button>
        </div>
      }
    >
      <PluginStats stats={stats} />

      {msg && (
        <div role="status" className={`mb-4 ${msg.kind === "error" ? ERROR_TEXT : OK_TEXT}`}>
          {msg.text}
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
            ? `已启用 ${enabledCount}/${list.length} 个插件 · 同一 id 再次安装 = 覆盖更新`
            : tab === "repo"
              ? "云端同一份插件仓库：下载原样清单、校验指纹后走同一套安装预览"
              : tab === "widgets"
                ? "界面插件 · 含可执行代码，装后由宿主开独立窗口"
                : tab === "modules"
                  ? "内置模块 · 停用只收起入口与后台任务，不删除本机数据"
                  : ""}
        </span>
      </div>

      <div
        role="tabpanel"
        id={`plugins-${tab}-panel`}
        aria-labelledby={`plugins-${tab}-tab`}
        className="mt-4"
      >
        {tab === "repo" && (
          <PluginRepositoryPanel
            installed={list.map((plugin) => ({
              id: plugin.manifest.id,
              version: plugin.manifest.version,
            }))}
            loadingKey={repoLoadingKey}
            onLoad={loadFromRepository}
            onError={(message) => setMsg({ kind: "error", text: message })}
          />
        )}

        {tab === "plugins" && (
          <>
            {/* 列表筛选（d.77）：装到几十个后按名字/技能/服务找，状态可只看已停用。 */}
            {list.length > 0 && (
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <input
                  aria-label="搜索插件"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="按名称、id、作者、技能或服务搜索"
                  className="ui-input min-w-[200px] max-w-[320px] flex-1"
                />
                <div role="group" aria-label="插件状态筛选" className="flex items-center gap-1">
                  {STATUS_FILTERS.map((item) => (
                    <button
                      key={item.key}
                      type="button"
                      aria-pressed={statusFilter === item.key}
                      onClick={() => setStatusFilter(item.key)}
                      className={`ui-btn ui-btn-sm ${
                        statusFilter === item.key ? "ui-btn-primary" : "ui-btn-ghost text-muted"
                      }`}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
                <span className="ui-caption">
                  {filterActive
                    ? `匹配 ${visiblePlugins.length} / 共 ${list.length} 个`
                    : `共 ${list.length} 个插件`}
                </span>
              </div>
            )}
            <SystemPluginCard system={system} />
            {list.length === 0 ? (
              <section
                className="flex flex-col items-center gap-2 rounded-xl border border-line bg-white py-10 text-center shadow-card"
                aria-label="暂无插件"
              >
                <span className="text-muted" aria-hidden="true">
                  <PackageIcon width={28} height={28} />
                </span>
                <p className="ui-section-title">还没有安装插件</p>
                <p className="ui-caption">
                  一份插件清单可以一次带入一组技能、远程 MCP 服务与命令。
                </p>
                <div className="mt-1 flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setRepoDialogOpen(true)}
                    className="ui-btn ui-btn-md ui-btn-primary"
                  >
                    从云端安装
                  </button>
                  <button type="button" onClick={openInstall} className="ui-btn ui-btn-md ui-btn-ghost">
                    手动粘贴清单
                  </button>
                </div>
              </section>
            ) : visiblePlugins.length === 0 ? (
              <section
                className="flex flex-col items-center gap-2 rounded-xl border border-line bg-white py-10 text-center shadow-card"
                aria-label="筛选无结果"
              >
                <p className="ui-section-title">没有匹配的插件</p>
                <p className="ui-caption">换个关键词，或清除筛选看全部。</p>
                <button type="button" onClick={clearFilters} className="ui-btn ui-btn-md ui-btn-ghost mt-1">
                  清除筛选
                </button>
              </section>
            ) : (
              <div className="grid gap-4">
                {visiblePlugins.map((plugin) => (
                  <PluginCard
                    key={plugin.manifest.id}
                    plugin={plugin}
                    highlighted={highlightPluginId === plugin.manifest.id}
                    onDetail={() => setDetailId(plugin.manifest.id)}
                    onToggle={(next) => onToggle(plugin, next)}
                    onRemove={() => setRemoveTarget(plugin)}
                    onGoSkills={goSkills}
                    onGoInterfaces={goInterfaces}
                  />
                ))}
              </div>
            )}

            <p className={`mt-3 max-w-[680px] ${HINT}`}>
              这里安装的插件只声明技能、MCP 服务和命令，不含代码、不带密钥。安装不会运行程序，也不会联网；
              连接与工具启用仍由你手动确认。带可执行界面代码的插件（如桌宠）请在「桌面小组件」安装。
            </p>
          </>
        )}

        {/* 技能 Tab：完整技能视图（原技能区页主体）。
            onChanged：技能池变更后让本页统计/能力快照同帧刷新（自检：新建技能后统计不涨）。 */}
        {tab === "modules" && <ModulesView />}

        {/* d.94：界面插件（桌面小组件）——列表/启停/卸载/宿主动作/安装，数据来自主进程 IPC */}
        {tab === "widgets" && <WidgetsView />}

        {tab === "skills" && (
          <SkillsView
            skills={skills}
            plugins={plugins}
            onOpenPlugin={openPluginDetail}
            onChanged={bump}
          />
        )}

        {tab === "tools" && (
          <PluginToolPanel
            groups={toolGroups}
            blocked={blockedTools}
            toolPacks={toolPackGroups}
            onToggleTool={(serverId, toolName, enabled) => {
              mcp.setToolEnabled(serverId, toolName, enabled);
              bump();
            }}
          />
        )}

        {/* MCP Tab：完整接口视图（原接口区页主体）。 */}
        {tab === "mcp" && (
          <InterfacesView registry={mcp} plugins={plugins} onOpenPlugin={openPluginDetail} />
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
            plugins.setKindEnabled(detail.manifest.id, kind, enabled);
            bump();
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
