import { useEffect, useMemo, useState } from "react";
import {
  describeCapabilities,
  describeCapabilityCatalog,
  pluginIdFromServerId,
  pluginStore,
  type CapabilityCatalog,
  type CapabilitySnapshot,
  type InstalledPlugin,
  type PluginInstallPreview,
  type PluginStore,
} from "../lib/plugins/index.js";
import { mcpRegistry } from "../lib/mcp/index.js";
import { skillPool } from "../lib/skills/index.js";
import { useChatStore } from "../store/chat.js";
import { useUiStore } from "../store/ui.js";
import { PackageIcon, PlusIcon } from "./icons.js";
import { PageShell } from "./layout/PageShell.js";
import { InstallDialog } from "./plugins/InstallDialog.js";
import { PluginCard } from "./plugins/PluginCard.js";
import { PluginDetailDialog } from "./plugins/PluginDetailDialog.js";
import { PluginMcpPanel } from "./plugins/PluginMcpPanel.js";
import { PluginSkillPanel } from "./plugins/PluginSkillPanel.js";
import { RemovePluginDialog } from "./plugins/RemovePluginDialog.js";
import { PluginStats } from "./plugins/PluginStats.js";
import { SystemPluginCard } from "./plugins/SystemPluginCard.js";
import { PluginToolPanel } from "./plugins/PluginToolPanel.js";
import {
  describeBlockedTools,
  describeCapabilityStats,
  describeMcpRows,
  describeSkillRows,
  groupCatalogTools,
  groupToolPacks,
  installResultMessage,
  type AgentLite,
  type McpRegistryPort,
  type SkillPoolPort,
} from "./plugins/viewModel.js";
import { BTN_GHOST, ERROR_TEXT, HINT, OK_TEXT } from "./plugins/shared.js";

/**
 * 插件区 · 统一能力中枢（d.64 · T2）。
 *
 * 插件 = 能力包：技能 / 工具 / MCP 服务 / 命令。本页把此前散在插件区、技能区、
 * 接口区的四份口径合并成四个 Tab，数据全部只读本机（插件存储、技能池、能力目录、MCP 注册表），
 * 不发起网络请求；安装/更新/停用/卸载语义与存储格式完全不变。
 */

type TabKey = "plugins" | "skills" | "tools" | "mcp";

const TABS: { key: TabKey; label: string }[] = [
  { key: "plugins", label: "插件" },
  { key: "skills", label: "技能" },
  { key: "tools", label: "工具" },
  { key: "mcp", label: "MCP 服务" },
];

export interface PluginsPageProps {
  plugins?: PluginStore;
  /** 技能池（默认全局 skillPool；测试注入独立实例）。 */
  skills?: SkillPoolPort;
  /** MCP 注册表（默认全局 mcpRegistry）。 */
  mcp?: McpRegistryPort;
  /** 能力目录（默认现场 `describeCapabilityCatalog()`；测试可注入固定目录）。 */
  catalog?: CapabilityCatalog;
  /** 统一能力快照（默认现场 `describeCapabilities()`；测试可注入固定快照）。 */
  capabilities?: CapabilitySnapshot;
  /** 智能体名册（技能 Tab 的「被几个智能体使用」需要）。 */
  agents?: readonly AgentLite[];
}

/** 主机名（含端口）；清单已校验合法，这里只用于展示。 */
function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

export function PluginsPage({
  plugins = pluginStore,
  skills = skillPool,
  mcp = mcpRegistry,
  catalog,
  capabilities: capabilitiesProp,
  agents,
}: PluginsPageProps = {}) {
  // 技能 Tab 的「被几个智能体使用」需要名册：订阅 chat store，未注入时懒加载一次。
  const roster = useChatStore((s) => s.agentsRoster);
  const loadAgentsRoster = useChatStore((s) => s.loadAgentsRoster);
  const [tick, setTick] = useState(0);
  const [tab, setTab] = useState<TabKey>("plugins");
  const [installOpen, setInstallOpen] = useState(false);
  const [text, setText] = useState("");
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [removeTarget, setRemoveTarget] = useState<InstalledPlugin | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);

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

  const resolvedAgents = useMemo<readonly AgentLite[]>(
    () => agents ?? roster.map((agent) => ({ id: agent.id, name: agent.name })),
    [agents, roster],
  );

  useEffect(() => {
    if (agents) return;
    if (roster.length > 0) return;
    void loadAgentsRoster().catch(() => {
      // 名册加载失败不影响本页：技能行只是少一个「使用智能体」计数
    });
  }, [agents, roster.length, loadAgentsRoster]);

  const bump = () => setTick((n) => n + 1);

  // 数据快照：tick 是「安装/启停后重算」的统一信号；catalog 传入时优先用注入值。
  const list = useMemo(() => plugins.list(), [plugins, tick]);
  const skillRows = useMemo(
    () => describeSkillRows(skills, plugins, resolvedAgents),
    [skills, plugins, resolvedAgents, tick],
  );
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
  const blockedTools = useMemo(
    () => describeBlockedTools(capabilityCatalog, plugins),
    [capabilityCatalog, plugins],
  );
  const mcpRows = useMemo(
    () => describeMcpRows(mcp, plugins, pluginIdFromServerId),
    [mcp, plugins, tick],
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

  const onInstall = () => {
    if (!preview) return;
    const before = preview;
    try {
      const result = plugins.install(text);
      bump();
      setText("");
      setInstallOpen(false);
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

  const goSkills = () => useUiStore.getState().setPage("skills");
  const goInterfaces = () => useUiStore.getState().setPage("interfaces");

  const enabledCount = list.filter((plugin) => plugin.enabled).length;

  return (
    <PageShell
      title="插件区"
      subtitle="插件 = 能力包：技能 / 工具 / MCP 服务 / 命令，全部本机。安装后技能进入技能池、服务登记到接口区；启用状态与删除范围按插件统一管理。"
      width="wide"
      actions={
        <button type="button" onClick={openInstall} className={`flex items-center gap-1 ${BTN_GHOST}`}>
          <PlusIcon width={12} height={12} aria-hidden="true" />
          安装插件
        </button>
      }
    >
      <PluginStats stats={stats} />

      {msg && (
        <div role="status" className={`mb-4 ${msg.kind === "error" ? ERROR_TEXT : OK_TEXT}`}>
          {msg.text}
        </div>
      )}

      {/* Tab 栏：复用技能区的角色与下划线样式 */}
      <div className="flex gap-1 border-b border-line-soft" role="tablist" aria-label="能力分区">
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
              className={`-mb-px border-b-2 px-3.5 py-2 text-[13px] transition-colors ${
                active
                  ? "border-b-ink font-semibold text-ink"
                  : "border-b-transparent text-muted hover:text-ink"
              }`}
            >
              {item.label}
            </button>
          );
        })}
        <span className="ml-auto self-center ui-caption">
          已启用 {enabledCount}/{list.length} 个插件 · 同一 id 再次安装 = 覆盖更新
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
                  一个 plugin.json 可以一次带入一组技能、远程 MCP 服务与命令。点右上角「安装插件」粘贴清单或选择文件。
                </p>
              </section>
            ) : (
              <div className="grid gap-4">
                {list.map((plugin) => (
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

            <p className={`mt-3 ${HINT}`}>
              插件只声明技能、远程 MCP 服务与命令，不含可执行代码、不携带密钥；安装不会启动进程，
              也不会主动联网——服务连接与工具启用由你在接口区发起，工具调用仍走人工确认。
            </p>
          </>
        )}

        {tab === "skills" && (
          <PluginSkillPanel
            rows={skillRows}
            onToggle={(id, enabled) => {
              skills.setEnabled(id, enabled);
              bump();
            }}
            onManage={goSkills}
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

        {tab === "mcp" && (
          <PluginMcpPanel
            rows={mcpRows}
            onToggle={(serverId, enabled) => {
              mcp.update(serverId, { enabled });
              bump();
            }}
            onManage={goInterfaces}
            onOpenPlugin={(pluginId) => {
              setTab("plugins");
              setDetailId(pluginId);
              setHighlightPluginId(pluginId);
            }}
          />
        )}
      </div>

      {installOpen && (
        <InstallDialog
          text={text}
          previewState={previewState}
          onTextChange={setText}
          onFile={(e) => void onFile(e)}
          onInstall={onInstall}
          onClose={() => setInstallOpen(false)}
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
          hostOf={hostOf}
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
