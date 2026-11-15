import { useEffect, useMemo, useState } from "react";
import {
  MCP_PROTOCOL_VERSION,
  buildToolCatalog,
  clientFor,
  mcpRegistry,
  refreshServerTools,
  hasStdioBridge,
  resetClient,
  stopStdioServer,
  type McpConnState,
  type McpRegistry,
  type McpServerConfig,
} from "../lib/mcp/index.js";
import { PlusIcon, TrashIcon } from "./icons.js";
import { ConfirmDialog } from "./ConfirmDialog.js";
import { RegistryPage } from "./RegistryPage.js";
import { PageShell } from "./layout/PageShell.js";
import { pluginStore, type PluginStore } from "../lib/plugins/index.js";
import { useUiStore } from "../store/ui.js";
import { Button } from "../components/ui/Button.js";

/**
 * 从 `plugin:<插件 id>:<服务 key>` 形态的服务 id 里取出插件 id。
 *
 * 为什么不从 manifest 反查：T1 的 v3 清单尚在落地中，这里只依赖既有 id 约定
 * （插件 id 的字符白名单不含冒号，所以第二个冒号之前一定是插件 id）。
 */
function pluginIdFromServerId(serverId: string): string | null {
  const prefix = "plugin:";
  if (!serverId.startsWith(prefix)) return null;
  const rest = serverId.slice(prefix.length);
  const cut = rest.indexOf(":");
  const id = cut > 0 ? rest.slice(0, cut) : rest;
  return id || null;
}

/**
 * 接口区：MCP 服务与工具调用。
 *
 * 三件事：
 * 1. 登记 MCP 服务（HTTP 传输；stdio 需要桌面端进程能力，本期先提示）；
 * 2. 连接并拉取工具清单（`initialize` + `tools/list`）；
 * 3. 逐个工具开关「是否交给模型」+ 手动测试调用（`tools/call`）。
 *
 * 安全默认：**工具默认不启用**，必须显式打开才会进入模型提示词。
 * 唯一例外是系统能力（Windows 桌面控制 / 网页抓取）的只读白名单——
 * 它们是应用自身能力，发现工具后自动启用；写操作仍需逐个授权。
 */
/**
 * 可嵌入的接口（MCP）视图（d.67 导航合并）。
 *
 * 布局分两段（d.93）：
 * - **系统能力**：随应用内置的两条服务，只读展示（不可删除、不可改配置），
 *   登录后由 `autoConnectAll()` 自动连接；工具仍可逐个开关；
 * - **私有服务**：用户手动添加或从 Registry 安装，增删改与原来一致。
 *
 * 为什么把系统能力单独分区而不是混在列表里：混排时用户会以为自己也能删掉
 * 「Windows 桌面控制」，删完才发现应用少了能力；分区后「可操作 / 只读」一眼可分。
 */
export interface InterfacesViewProps {
  registry?: McpRegistry;
  /** 插件 store（取「插件：<名>」来源徽标要用的显示名；测试可注入）。 */
  plugins?: PluginStore;
  /**
   * 「插件：<名>」徽标被点时做什么。
   * 嵌入插件区时由宿主打开插件详情（同页弹窗）；不传则退回旧行为（投意图 + 切插件区）。
   */
  onOpenPlugin?: (pluginId: string) => void;
  /** 额外容器类（宿主控制高度/内边距用；视图本身不自带 PageShell）。 */
  className?: string;
}

export type InterfacesPageProps = InterfacesViewProps;

export function InterfacesView({
  registry = mcpRegistry,
  plugins = pluginStore,
  onOpenPlugin,
  className = "",
}: InterfacesViewProps = {}) {
  /** 插件 id → 显示名；来源徽标与 aria-label 共用。 */
  const pluginNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const item of plugins.list()) map.set(item.manifest.id, item.manifest.name);
    return map;
  }, [plugins]);

  /**
   * 「插件：<名>」徽标的动作：
   * - 嵌入式（宿主传 onOpenPlugin）→ 宿主打开插件详情，留在插件区内；
   * - 独立渲染（旧外壳/旧用例）→ 仍投既有 open-plugin 内存意图再切插件区。
   */
  const openPlugin =
    onOpenPlugin ??
    ((pluginId: string) => {
      useUiStore.getState().setPaletteIntent("open-plugin", { id: pluginId });
      useUiStore.getState().setPage("plugins");
    });
  const [tick, setTick] = useState(0);
  const [discover, setDiscover] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<McpServerConfig | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [name, setName] = useState("");
  const [transport, setTransport] = useState<"http" | "stdio">("http");
  const [url, setUrl] = useState("");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [headersText, setHeadersText] = useState("");
  /** 单次请求超时（秒，可选）：空＝缺省（HTTP 20s / stdio 30s）。 */
  const [timeoutSec, setTimeoutSec] = useState("");
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  /**
   * 连接状态的**真实来源**是「有没有缓存到工具清单」，本页 state 只是过程态。
   *
   * 为什么：应用启动时 App 已在后台自动连过（autoConnectAll），结果存在 registry 里、
   * 不在本组件 state 里。若界面只看 state，用户进到接口区会看到一排「未连接」，
   * 与实际可用性矛盾——于是又得点一次，自动连接就白做了。故渲染时按工具清单回填。
   */
  const [conn, setConn] = useState<Record<string, McpConnState>>({});
  const [connError, setConnError] = useState<Record<string, string>>({});
  const [testFor, setTestFor] = useState<string | null>(null);
  const [testArgs, setTestArgs] = useState("{}");
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);
  /** 正在执行的手动调用（`serverId::toolName`）；进行中禁用按钮，防重复执行。 */
  const [testRunning, setTestRunning] = useState<string | null>(null);

  const bump = () => setTick((n) => n + 1);
  /** stdio 需要桌面端：浏览器里只能登记配置，连接会失败。 */
  const stdioReady = hasStdioBridge();
  const servers = useMemo(() => registry.servers(), [registry, tick]);
  /** 系统能力：顺序按定义表（不跟随落盘顺序），只读展示。 */
  const systemServers = useMemo(() => registry.systemServers(), [registry, tick]);
  /** 私有服务：系统能力之外的全部服务（手填 / Registry / 插件）。 */
  const userServers = useMemo(
    () => servers.filter((server) => !registry.isSystem(server.id)),
    [registry, servers, tick],
  );
  const toolsByServer = useMemo(
    () => Object.fromEntries(servers.map((s) => [s.id, registry.tools(s.id)])),
    [registry, servers, tick],
  );
  const enabledCount = useMemo(
    () => servers.reduce((n, s) => n + toolsByServer[s.id].filter((t) => registry.isToolEnabled(s.id, t.name)).length, 0),
    [registry, servers, toolsByServer, tick],
  );

  // 组件卸载时刷新不设置状态
  useEffect(() => () => setConn({}), []);

  const resetForm = () => {
    setName("");
    setTransport("http");
    setUrl("");
    setCommand("");
    setArgs("");
    setHeadersText("");
    setTimeoutSec("");
  };

  const parseHeaders = (): Record<string, string> | undefined => {
    const text = headersText.trim();
    if (!text) return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error("请求头必须是 JSON 对象，例如 {\"Authorization\":\"Bearer xxx\"}");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("请求头必须是 JSON 对象");
    }
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "string") out[k] = v;
    }
    return Object.keys(out).length ? out : undefined;
  };

  /**
   * 秒 → 毫秒。留空＝用缺省值；填了就必须是正数（不合法直接抛给用户看，
   * 而不是静默丢掉——静默丢掉的话用户会以为设置生效了）。
   */
  const parseTimeoutMs = (text: string): number | undefined => {
    const raw = text.trim();
    if (!raw) return undefined;
    const seconds = Number(raw);
    if (!Number.isFinite(seconds) || seconds <= 0) {
      throw new Error("单次超时请填正数（秒），留空表示用缺省值");
    }
    return Math.round(seconds * 1000);
  };

  const addServer = () => {
    try {
      const created = registry.add({
        name,
        transport,
        url: transport === "http" ? url : undefined,
        command: transport === "stdio" ? command : undefined,
        args: transport === "stdio" ? args.split(/\s+/).filter(Boolean) : undefined,
        headers: parseHeaders(),
        timeoutMs: parseTimeoutMs(timeoutSec),
        enabled: true,
      });
      resetForm();
      setFormOpen(false);
      bump();
      // 新增后立刻自动连一次：用户不想再点「连接」才能用。
      // 失败不阻断添加动作——服务已经存下来了，用户可在列表里看到错误并重试。
      void connect(created);
    } catch (err) {
      setMsg({ kind: "error", text: err instanceof Error ? err.message : String(err) });
    }
  };

  const connect = async (server: McpServerConfig) => {
    setConn((c) => ({ ...c, [server.id]: "connecting" }));
    setConnError((e) => ({ ...e, [server.id]: "" }));
    try {
      const tools = await refreshServerTools(server.id, registry);
      setConn((c) => ({ ...c, [server.id]: "ready" }));
      bump();
      setMsg({ kind: "ok", text: `${server.name}：已连接，发现 ${tools.length} 个工具` });
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      setConn((c) => ({ ...c, [server.id]: "error" }));
      setConnError((e) => ({ ...e, [server.id]: text }));
      setMsg({ kind: "error", text: `${server.name}：${text}` });
    }
  };

  const removeServer = (server: McpServerConfig) => {
    setRemoveTarget(server);
  };

  const confirmRemoveServer = () => {
    if (!removeTarget) return;
    const server = removeTarget;
    registry.remove(server.id);
    resetClient(server.id);
    // stdio 的子进程活在主进程里、按 serverId 复用：不显式回收就会出现
    // 「界面上已删除、进程还在读写本机」。stopStdioServer 永不抛，不阻断删除。
    if (server.transport === "stdio") void stopStdioServer(server.id);
    setRemoveTarget(null);
    bump();
    setMsg({ kind: "ok", text: `已删除 MCP 服务：${server.name}` });
  };

  const runTest = async (server: McpServerConfig, toolName: string) => {
    const key = `${server.id}::${toolName}`;
    if (testRunning) return;
    setTestRunning(key);
    setTestResult(null);
    try {
      const parsed: unknown = testArgs.trim() ? JSON.parse(testArgs) : {};
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("参数必须是 JSON 对象");
      }
      const client = clientFor(server);
      // 尚未 initialize 过时先握手（用户可能没点「连接」就直接测试）
      if (!client.sessionId) await client.initialize();
      const result = await client.callTool(toolName, parsed as Record<string, unknown>);
      setTestResult({ ok: !result.isError, text: result.text || "（工具没有返回文本）" });
    } catch (err) {
      setTestResult({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setTestRunning(null);
    }
  };

  /**
   * 渲染一台 MCP 服务卡片。
   *
   * 系统能力与私有服务共用同一张卡片：工具清单、测试面板、连接/错误展示完全一致；
   * 差别只在头部——系统能力没有「参与对话」开关与删除按钮，状态旁给一个重试连接。
   * `system` 不看 `origin` 而看 `registry.isSystem(id)`：旧数据里 origin 可能是
   * manual，但固定 id 就是系统能力，不能因此把它当用户服务处理。
   */
  const renderServerCard = (server: McpServerConfig, system: boolean) => {
    const tools = toolsByServer[server.id] ?? [];
    // 本页 state 里没有记录时，按「是否已发现过工具」判断：
    // 已发现 = App 启动时已自动连过（清单会落盘），显示「已连接」；
    // 未发现 = 还没连过或连失败，显示各自状态。
    // 用 hasDiscovered 而不是「清单长度>0」——零工具的服务也算连上过。
    // 优先看本页刚发起的连接；没有就看**最近一次连接尝试**的结果，
    // 只有「从没连过但有旧快照」才退回「已连接」——其余情况一律如实标错。
    const live = registry.status(server.id);
    const state: McpConnState =
      conn[server.id] ??
      (live
        ? live.state === "connected"
          ? "ready"
          : live.state
        : registry.hasDiscovered(server.id)
          ? // 有快照但本进程还没连过：显示已连接（沿用历史语义），
            // 真正的「坏了」由 setStatus 记录后覆盖成 stale
            "ready"
          : "idle");
    return (
      <section
        key={server.id}
        aria-label={`MCP 服务 ${server.name}`}
        data-system-mcp={system ? "true" : undefined}
        className="ui-card p-4"
      >
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-ui-md font-semibold">{server.name}</span>
          {system && (
            <span className="ui-chip" title="随应用内置，不可删除、不可修改配置">
              随应用内置
            </span>
          )}
          <span className="ui-chip">
            {server.transport === "http" ? "HTTP" : "stdio"}
          </span>
          {/* 从 Registry 装的本地包：把「哪类包、钉的哪个版本」摊出来。
              界面据此能看出本机跑的是钉死版本，不是上游最新版。 */}
          {server.origin === "registry" && (
            <span className="ui-chip">
              {`Registry${server.registryType ? ` · ${server.registryType}` : ""}${
                server.registryVersion ? ` · v${server.registryVersion}` : ""
              }`}
            </span>
          )}
          {server.origin === "plugin" && (() => {
            const pluginId = pluginIdFromServerId(server.id);
            const pluginName = pluginId ? pluginNames.get(pluginId) : undefined;
            return (
              <button
                type="button"
                aria-label={`打开插件 ${pluginName ?? pluginId ?? "（未知插件）"}`}
                title="随插件安装；停用或卸载插件时同步"
                onClick={() => {
                  if (pluginId) openPlugin(pluginId);
                }}
                className="ui-chip hover:text-ink"
              >
                <span>插件</span>
                <span>：{pluginName ?? "未知插件"}</span>
              </button>
            );
          })()}
          <span
            className={`rounded-full px-2 py-0.5 text-ui-xs ${
              state === "ready"
                ? "bg-success-soft text-success"
                : state === "error"
                  ? "bg-danger-soft text-danger"
                  : state === "stale"
                    ? "bg-warn-soft text-warn"
                    : state === "connecting"
                      ? "bg-warn-soft text-warn"
                      : "bg-subtle-2 text-muted"
            }`}
            title={state === "stale" ? registry.status(server.id)?.error ?? "最近一次连接失败" : undefined}
          >
            {state === "ready"
              ? "已连接"
              : state === "error"
                ? "连接失败"
                : state === "stale"
                  ? "已断开（清单过期）"
                  : state === "connecting"
                    ? "连接中…"
                    : "未连接"}
          </span>
          <span className="text-ui-xs text-muted">
            {tools.length ? `${tools.length} 个工具` : "未获取工具"}
          </span>
          <div className="ml-auto flex items-center gap-2">
            {system ? (
              // 系统能力始终参与对话：没有「停用」入口（停用后模型能力会静默缺失）。
              <span className="text-ui-xs text-muted">始终参与对话</span>
            ) : (
              <label className="flex items-center gap-1 text-ui-xs text-muted">
                <input
                  type="checkbox"
                  aria-label={`启用服务 ${server.name}`}
                  checked={server.enabled}
                  onChange={(e) => {
                    registry.update(server.id, { enabled: e.target.checked });
                    bump();
                  }}
                />
                参与对话
              </label>
            )}
            <Button
              type="button"
              aria-label={`连接 ${server.name}`}
              title={system ? "重新连接系统能力" : undefined}
              onClick={() => void connect(server)}
              disabled={state === "connecting"}
              size="sm" variant="ghost"
            >
              {state === "connecting"
                ? "连接中…"
                : tools.length
                  ? "刷新工具"
                  : system
                    ? "重新连接"
                    : "连接"}
            </Button>
            {!system && (
              <Button
                type="button"
                aria-label={`删除 ${server.name}`}
                onClick={() => removeServer(server)}
                size="sm" variant="ghost" className="text-danger"
              >
                <TrashIcon width={12} height={12} />
              </Button>
            )}
          </div>
        </div>

        {server.transport === "stdio" && !stdioReady && (
          <p className="mt-2 text-ui-sm text-warn">
            stdio 服务只能在桌面端连接；当前是浏览器环境。
          </p>
        )}

        {connError[server.id] && (
          <p role="alert" className="mt-2 text-ui-sm text-danger">
            {connError[server.id]}
          </p>
        )}

        {/* 命令行片段：12px 等宽（命令不是正文，但 11px 在这类等宽串上会糊） */}
        <p className="mt-1 truncate font-mono ui-caption">
          {server.transport === "http" ? server.url : `${server.command} ${(server.args ?? []).join(" ")}`}
        </p>

        {tools.length === 0 ? (
          <p className="mt-3 text-ui-sm text-muted">
            {system
              ? "正在连接或尚未发现工具；点「重新连接」重试。连接成功后可逐个开关工具。"
              : "点「连接」拉取工具清单。连接成功后可逐个授权给模型调用。"}
          </p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="ui-table min-w-[560px]">
              <thead>
                <tr>
                  <th>工具</th>
                  <th>描述</th>
                  <th>交给模型</th>
                  <th className="text-right">操作</th>
                </tr>
              </thead>
              <tbody>
                {tools.map((tool) => {
                  const enabled = registry.isToolEnabled(server.id, tool.name);
                  const key = `${server.id}::${tool.name}`;
                  return (
                    <tr key={tool.name}>
                      <td className="font-mono">{tool.name}</td>
                      <td className="max-w-[320px] truncate text-muted">
                        {tool.description || "—"}
                      </td>
                      <td>
                        <input
                          type="checkbox"
                          aria-label={`启用工具 ${tool.name}`}
                          checked={enabled}
                          onChange={(e) => {
                            registry.setToolEnabled(server.id, tool.name, e.target.checked);
                            bump();
                          }}
                        />
                      </td>
                      <td className="text-right">
                        <Button
                          type="button"
                          aria-label={`测试 ${tool.name}`}
                          onClick={() => {
                            setTestFor(testFor === key ? null : key);
                            setTestArgs("{}");
                            setTestResult(null);
                          }}
                          size="sm" variant="ghost"
                        >
                          测试
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>

            {testFor && testFor.startsWith(`${server.id}::`) && (
              <div className="mt-3 rounded-lg border border-line bg-subtle-2 p-3">
                <div className="ui-section-title">
                  测试 {testFor.split("::")[1]}
                </div>
                <textarea
                  aria-label="测试参数"
                  value={testArgs}
                  onChange={(e) => setTestArgs(e.target.value)}
                  className="mt-1 block min-h-[70px] w-full rounded-lg border border-line-strong bg-surface px-2 py-1.5 font-mono text-ui-xs outline-hidden focus:border-ink"
                />
                <div className="mt-2 flex items-center gap-2">
                  <Button
                    type="button"
                    onClick={() => void runTest(server, testFor.split("::")[1])}
                    disabled={testRunning === testFor}
                    size="sm" variant="primary"
                  >
                    {testRunning === testFor ? "执行中…" : "执行"}
                  </Button>
                  <span className="ui-caption">按每个工具的说明填写参数（JSON 对象）</span>
                </div>
                {testResult && (
                  <pre
                    role="status"
                    className={`mt-2 max-h-[160px] overflow-auto whitespace-pre-wrap break-words rounded-sm border px-2 py-1.5 ui-caption ${
                      testResult.ok
                        ? "border-success-line bg-success-soft text-success"
                        : "border-danger-line bg-danger-soft text-danger"
                    }`}
                  >
                    {testResult.text}
                  </pre>
                )}
              </div>
            )}
          </div>
        )}
      </section>
    );
  };

  if (discover) {
    // 发现页是接口区的二级面板：嵌入后没有「整页可换」，改用覆盖层承载。
    // 这样既保住「返回接口区」这条退路，也不会在 Tab 内叠出第二个页面页头。
    return (
      <div className="fixed inset-0 z-40 overflow-y-auto bg-surface">
        <RegistryPage
          onBack={() => {
            setDiscover(false);
            // 安装/删除都可能改过服务列表，回列表时重新读一次。
            bump();
          }}
          onInstalled={bump}
        />
      </div>
    );
  }

  return (
    <div className={className}>
      {/* 页头动作原先挂在 PageShell.actions，嵌入后收进视图顶部工具条；
          协议版本也放这一行——去掉页头后它需要一个固定的落点。 */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Button
          type="button"
          onClick={() => {
            setDiscover(true);
            setMsg(null);
          }}
          size="md" variant="ghost"
        >
          从 Registry 发现
        </Button>
        <Button
          type="button"
          onClick={() => {
            setFormOpen((v) => !v);
            setMsg(null);
          }}
          size="md" variant="ghost"
        >
          <PlusIcon width={14} height={14} />
          添加 MCP 服务
        </Button>
        <span className="ml-auto ui-caption">
          MCP 协议 {MCP_PROTOCOL_VERSION} · 只读工具默认启用，其余逐个授权
        </span>
      </div>
      {msg && (
        <div
          role="status"
          className={`mb-4 rounded-lg border px-3 py-2 text-ui-sm ${
            msg.kind === "error"
              ? "border-danger-line bg-danger-soft text-danger"
              : "border-success-line bg-success-soft text-success"
          }`}
        >
          {msg.text}
        </div>
      )}

      {/* 系统能力：只读分区，永远排在最上面。不可删除、不可改配置，
          但工具开关可用（写操作仍需逐个授权）。 */}
      <section aria-label="系统能力" data-testid="mcp-system-servers" className="mb-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="ui-section-title">系统能力</span>
          <span className="ui-chip">随应用内置</span>
        </div>
        <p className="mt-1 text-ui-sm text-muted">
          Windows 桌面控制与网页抓取随应用内置，登录后自动连接；不可删除、不可修改配置。
          只读工具默认启用，写操作仍需逐个授权。
        </p>
        <div className="mt-3 flex flex-col gap-3">
          {systemServers.length > 0 ? (
            systemServers.map((server) => renderServerCard(server, true))
          ) : (
            // 密文读不出时 ensureSystemServers 会跳过补齐（避免覆盖用户配置），
            // 这一轮就看不到系统能力；换回原系统账户/Credential Manager 记录后可恢复。
            <p className="rounded-lg border border-dashed border-line bg-surface p-3 text-ui-sm text-muted">
              系统能力暂不可用（本机服务配置读取失败）；恢复系统账户的凭据后重启应用即可。
            </p>
          )}
        </div>
      </section>

      {formOpen && (
        <section className="ui-card mb-4 p-4">
          <div className="grid gap-4 md:grid-cols-2">
            <label className="ui-caption">
              服务名称
              <input
                aria-label="服务名称"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="例如 本地工具服务"
                className="mt-1 block w-full ui-input"
              />
            </label>
            <label className="ui-caption">
              传输方式
              <select
                aria-label="传输方式"
                value={transport}
                onChange={(e) => setTransport(e.target.value as "http" | "stdio")}
                className="mt-1 block w-full ui-input"
              >
                <option value="http">HTTP（浏览器/桌面通用）</option>
                <option value="stdio">stdio（桌面端，本机进程）</option>
              </select>
            </label>
            {transport === "http" ? (
              <label className="ui-caption md:col-span-2">
                服务地址
                <input
                  aria-label="服务地址"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://example.com/mcp"
                  className="mt-1 block w-full ui-input"
                />
              </label>
            ) : (
              <>
                <label className="ui-caption">
                  启动命令
                  <input
                    aria-label="启动命令"
                    value={command}
                    onChange={(e) => setCommand(e.target.value)}
                    placeholder="npx"
                    className="mt-1 block w-full ui-input"
                  />
                </label>
                <label className="ui-caption">
                  参数（空格分隔）
                  <input
                    aria-label="启动参数"
                    value={args}
                    onChange={(e) => setArgs(e.target.value)}
                    placeholder="-y @modelcontextprotocol/server-filesystem /tmp"
                    className="mt-1 block w-full ui-input"
                  />
                </label>
              </>
            )}
            <label className="ui-caption">
              单次超时（秒，可选）
              <input
                aria-label="单次超时"
                inputMode="numeric"
                value={timeoutSec}
                onChange={(e) => setTimeoutSec(e.target.value)}
                placeholder={transport === "http" ? "20" : "30"}
                className="mt-1 block w-full ui-input"
              />
            </label>
            <label className="ui-caption md:col-span-2">
              请求头（可选，JSON）
              <input
                aria-label="请求头"
                value={headersText}
                onChange={(e) => setHeadersText(e.target.value)}
                placeholder={'{"Authorization":"Bearer xxx"}'}
                className="mt-1 block w-full ui-input font-mono"
              />
            </label>
          </div>
          <div className="mt-3 flex items-center gap-2">
            <Button
              type="button"
              onClick={addServer}
              size="md" variant="primary"
            >
              保存服务
            </Button>
            <Button
              type="button"
              onClick={() => {
                setFormOpen(false);
                resetForm();
              }}
              size="md" variant="ghost" className="text-muted"
            >
              取消
            </Button>
            {transport === "stdio" && (
              <span className="text-ui-sm text-warn">
                {stdioReady
                  ? "会在本机启动这条命令，请确认来源可信"
                  : "当前环境不支持 stdio（需桌面端）；配置可先保存"}
              </span>
            )}
          </div>
        </section>
      )}

      {/* 私有服务：用户手填 / 从 Registry 安装 / 插件声明；增删改与原来一致。 */}
      <section aria-label="私有 MCP 服务" className="mt-6">
        <div className="flex flex-wrap items-center gap-2">
          <span className="ui-section-title">私有服务</span>
          <span className="ui-caption">手动添加，或从 Registry 安装</span>
        </div>
        {userServers.length === 0 ? (
          <div className="mt-3 rounded-xl border border-dashed border-line bg-surface p-6 text-center text-ui-sm text-muted">
            还没有私有 MCP 服务
          </div>
        ) : (
          <div className="mt-3 flex flex-col gap-3">
            {userServers.map((server) => renderServerCard(server, false))}
          </div>
        )}
      </section>

      {enabledCount > 0 && <p className="mt-4 ui-caption">已授权 {enabledCount} 个工具给模型调用。</p>}
      <p className="mt-2 ui-caption">
        工具在本机执行，不经过云端。
      </p>

      {removeTarget && (
        <ConfirmDialog
          title="删除 MCP 服务"
          onCancel={() => setRemoveTarget(null)}
          footer={
            <>
              <Button
                type="button"
                onClick={() => setRemoveTarget(null)}
                size="md" variant="ghost" className="text-muted"
              >
                取消
              </Button>
              <Button
                type="button"
                onClick={confirmRemoveServer}
                size="md" variant="danger"
              >
                删除
              </Button>
            </>
          }
        >
          <p className="text-ui-sm leading-6">
            删除 MCP 服务「{removeTarget.name}」？这条配置、缓存的工具清单与逐个工具的授权开关都会被移除；
            需要时得重新添加或从发现页安装。删除不会卸载本机的第三方包。
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
}

/**
 * 旧独立入口的过渡外壳（d.67 导航合并）。
 *
 * `interfaces` 路由已不存在——旧链接会被 `store/ui.ts` 折叠成「插件区 + MCP 视图」；
 * App 侧已不再引用本组件。保留一个带 PageShell 的导出，只是让旧引用/旧用例
 * 在这段时间里不会把构建打挂；新代码请用 `InterfacesView`。
 */
export function InterfacesPage({ registry, plugins }: InterfacesPageProps = {}) {
  return (
    <PageShell
      title="接口区"
      subtitle={`MCP 服务与工具已并入插件区的「MCP」视图；此独立入口仅作旧链接兼容（协议 ${MCP_PROTOCOL_VERSION}）。`}
      width="wide"
    >
      <InterfacesView registry={registry} plugins={plugins} />
    </PageShell>
  );
}

/** 供测试使用：当前会注入给模型的工具名（便于断言命名空间）。 */
export function describeExposedTools(registry: McpRegistry = mcpRegistry): string[] {
  const catalog = buildToolCatalog(registry.enabledTools());
  return catalog.entries.map((e) => e.openAiName);
}
