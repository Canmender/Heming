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
import { MCP_PRESETS } from "../lib/mcp/presets.js";
import { PageShell } from "./layout/PageShell.js";
import { describeSystemPlugin, pluginStore, type PluginStore } from "../lib/plugins/index.js";
import { useUiStore } from "../store/ui.js";

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
 * 「内置：<系统能力名>」来源徽标（d.65 T3）。
 *
 * 前缀用「内置」而非「系统」：系统插件名就是「系统能力」，避免「系统：系统能力」重复。
 *
 * 与插件徽标一样用 .ui-chip，但**不是按钮**——预置服务随应用内置，没有插件详情页可跳。
 * 名字取自 describeSystemPlugin().name，页面里不硬编码。
 */
function SystemSourceChip({ systemName }: { systemName: string }) {
  return (
    <span className="ui-chip" title="随应用内置；不可停用或卸载">
      <span>内置</span>
      <span>：{systemName}</span>
    </span>
  );
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
 */
export function InterfacesPage({
  registry = mcpRegistry,
  plugins = pluginStore,
}: {
  registry?: McpRegistry;
  /** 插件 store（取「插件：<名>」来源徽标要用的显示名；测试可注入）。 */
  plugins?: PluginStore;
}) {
  /** 插件 id → 显示名；来源徽标与 aria-label 共用。 */
  const pluginNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const item of plugins.list()) map.set(item.manifest.id, item.manifest.name);
    return map;
  }, [plugins]);

  /** 系统插件的显示名（预置服务来源徽标用；不硬编码文案）。 */
  const systemName = useMemo(() => describeSystemPlugin({ mcp: registry }).name, [registry]);

  /** 跳插件区并打开该插件详情：复用 d.60 的 open-plugin 内存意图，不新增 IPC。 */
  const openPlugin = (pluginId: string) => {
    useUiStore.getState().setPaletteIntent("open-plugin", { id: pluginId });
    useUiStore.getState().setPage("plugins");
  };
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
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  /** 当前选中的预设说明（点预设后显示，方便看前置条件与风险提示）。 */
  const [presetHint, setPresetHint] = useState("");
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

  const addServer = () => {
    try {
      const created = registry.add({
        name,
        transport,
        url: transport === "http" ? url : undefined,
        command: transport === "stdio" ? command : undefined,
        args: transport === "stdio" ? args.split(/\s+/).filter(Boolean) : undefined,
        headers: parseHeaders(),
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

  if (discover) {
    return (
      <RegistryPage
        onBack={() => {
          setDiscover(false);
          // 安装/删除都可能改过服务列表，回列表时重新读一次。
          bump();
        }}
        onInstalled={bump}
      />
    );
  }

  return (
    <PageShell
      title="接口区"
      subtitle={`MCP 服务与工具：连接后把工具开关打开，智能体在会话里就能调用（协议 ${MCP_PROTOCOL_VERSION}）。工具默认关闭，需要逐个授权。`}
      width="wide"
      actions={
        <>
          <button
            type="button"
            onClick={() => {
              setDiscover(true);
              setMsg(null);
            }}
            className="ui-btn ui-btn-md ui-btn-ghost"
          >
            从 Registry 发现
          </button>
          <button
            type="button"
            onClick={() => {
              setFormOpen((v) => !v);
              setMsg(null);
            }}
            className="ui-btn ui-btn-md ui-btn-ghost"
          >
            <PlusIcon width={13} height={13} />
            添加 MCP 服务
          </button>
        </>
      }
    >
      {msg && (
        <div
          role="status"
          className={`mb-4 rounded-lg border px-3 py-2 text-[12px] ${
            msg.kind === "error"
              ? "border-[#f3d2ce] bg-[#fef3f2] text-[#b42318]"
              : "border-[#d7e9dc] bg-[#f2faf5] text-[#1d6b3a]"
          }`}
        >
          {msg.text}
        </div>
      )}

      {formOpen && (
        <section className="mb-4 rounded-xl border border-line bg-white p-4 shadow-card">
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
            {/* 常用服务预设：一次填好传输/命令/参数。stdio 参数拼错时不会报错，
                只表现为「连上了但没有工具」，很难排查——所以值得一键填。 */}
            <div className="md:col-span-2">
              <span className="ui-caption">常用预设</span>
              <div className="mt-1 flex flex-wrap items-center gap-2">
                {MCP_PRESETS.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    aria-label={`套用预设 ${p.name}`}
                    title={p.hint}
                    onClick={() => {
                      setName(p.name);
                      setTransport(p.transport);
                      setUrl(p.url ?? "");
                      setCommand(p.command ?? "");
                      setArgs((p.args ?? []).join(" "));
                      setPresetHint(p.hint);
                      setMsg({ kind: "ok", text: `已填好「${p.name}」，确认后点保存` });
                    }}
                    className="ui-btn ui-btn-sm ui-btn-ghost"
                  >
                    {p.name}
                    {p.verified && <span className="ml-1 text-[10px] text-[#15803d]">已实测</span>}
                  </button>
                ))}
                {presetHint && <span className="text-[11px] text-muted">{presetHint}</span>}
              </div>
            </div>
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
            <button
              type="button"
              onClick={addServer}
              className="ui-btn ui-btn-md ui-btn-primary"
            >
              保存服务
            </button>
            <button
              type="button"
              onClick={() => {
                setFormOpen(false);
                resetForm();
              }}
              className="ui-btn ui-btn-md ui-btn-ghost text-muted"
            >
              取消
            </button>
            {transport === "stdio" && (
              <span className="text-[11px] text-[#b45309]">
                {stdioReady
                  ? "将在本机拉起该命令进程，请确认命令与参数可信"
                  : "当前环境不支持 stdio（需桌面端）；配置可先保存"}
              </span>
            )}
          </div>
        </section>
      )}

      {servers.length === 0 ? (
        <div className="mt-6 rounded-xl border border-dashed border-line bg-white p-8 text-center text-[13px] text-muted">
          还没有 MCP 服务。点右上角「添加 MCP 服务」，填入一个 Streamable HTTP 地址即可接工具。
        </div>
      ) : (
        <div className="mt-4 flex flex-col gap-3">
          {servers.map((server) => {
            const tools = toolsByServer[server.id] ?? [];
            // 本页 state 里没有记录时，按「是否已发现过工具」判断：
            // 已发现 = App 启动时已自动连过（清单会落盘），显示「已连接」；
            // 未发现 = 还没连过或连失败，显示各自状态。
            // 用 hasDiscovered 而不是「清单长度>0」——零工具的服务也算连上过。
            const state =
              conn[server.id] ?? (registry.hasDiscovered(server.id) ? "ready" : "idle");
            return (
              <section
                key={server.id}
                aria-label={`MCP 服务 ${server.name}`}
                className="rounded-xl border border-line bg-white p-4 shadow-card"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[13px] font-bold">{server.name}</span>
                  {(server.origin === "preset" || registry.isPreset(server.id)) && (
                    <SystemSourceChip systemName={systemName} />
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
                    className={`rounded-full px-2 py-0.5 text-[10px] ${
                      state === "ready"
                        ? "bg-[#f2faf5] text-[#1d6b3a]"
                        : state === "error"
                          ? "bg-[#fef3f2] text-[#b42318]"
                          : state === "connecting"
                            ? "bg-[#fff8e6] text-[#8a5a00]"
                            : "bg-[#f5f5f5] text-muted"
                    }`}
                  >
                    {state === "ready" ? "已连接" : state === "error" ? "连接失败" : state === "connecting" ? "连接中…" : "未连接"}
                  </span>
                  <span className="text-[11px] text-muted">
                    {tools.length ? `${tools.length} 个工具` : "未获取工具"}
                  </span>
                  <div className="ml-auto flex items-center gap-2">
                    <label className="flex items-center gap-1 text-[11px] text-muted">
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
                    <button
                      type="button"
                      aria-label={`连接 ${server.name}`}
                      onClick={() => void connect(server)}
                      disabled={state === "connecting"}
                      className="ui-btn ui-btn-sm ui-btn-ghost"
                    >
                      {state === "connecting"
                        ? "连接中…"
                        : tools.length
                          ? "刷新工具"
                          : "连接"}
                    </button>
                    <button
                      type="button"
                      aria-label={`删除 ${server.name}`}
                      onClick={() => removeServer(server)}
                      className="ui-btn ui-btn-sm ui-btn-ghost text-[#b42318]"
                    >
                      <TrashIcon width={12} height={12} />
                    </button>
                  </div>
                </div>

                {server.transport === "stdio" && !stdioReady && (
                  <p className="mt-2 text-[11px] text-[#b45309]">
                    stdio 服务只能在桌面端连接；当前是浏览器环境。
                  </p>
                )}

                {connError[server.id] && (
                  <p role="alert" className="mt-2 text-[11px] text-[#b42318]">
                    {connError[server.id]}
                  </p>
                )}

                <p className="mt-1 truncate font-mono text-[10px] text-muted">
                  {server.transport === "http" ? server.url : `${server.command} ${(server.args ?? []).join(" ")}`}
                </p>

                {tools.length === 0 ? (
                  <p className="mt-3 text-[12px] text-muted">
                    点「连接」拉取工具清单。连接成功后可逐个授权给模型调用。
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
                                <button
                                  type="button"
                                  aria-label={`测试 ${tool.name}`}
                                  onClick={() => {
                                    setTestFor(testFor === key ? null : key);
                                    setTestArgs("{}");
                                    setTestResult(null);
                                  }}
                                  className="ui-btn ui-btn-sm ui-btn-ghost"
                                >
                                  测试
                                </button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>

                    {testFor && testFor.startsWith(`${server.id}::`) && (
                      <div className="mt-3 rounded-lg border border-line bg-[#fafafa] p-3">
                        <div className="ui-section-title">
                          测试 {testFor.split("::")[1]}
                        </div>
                        <textarea
                          aria-label="测试参数"
                          value={testArgs}
                          onChange={(e) => setTestArgs(e.target.value)}
                          className="mt-1 block min-h-[70px] w-full rounded-lg border border-line-strong bg-white px-2 py-1.5 font-mono text-[11px] outline-hidden focus:border-ink"
                        />
                        <div className="mt-2 flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => void runTest(server, testFor.split("::")[1])}
                            disabled={testRunning === testFor}
                            className="ui-btn ui-btn-sm ui-btn-primary"
                          >
                            {testRunning === testFor ? "执行中…" : "执行"}
                          </button>
                          <span className="text-[11px] text-muted">参数按工具 inputSchema 填 JSON 对象</span>
                        </div>
                        {testResult && (
                          <pre
                            role="status"
                            className={`mt-2 max-h-[160px] overflow-auto whitespace-pre-wrap break-words rounded-sm border px-2 py-1.5 text-[11px] ${
                              testResult.ok
                                ? "border-[#d7e9dc] bg-[#f2faf5] text-[#1d6b3a]"
                                : "border-[#f3d2ce] bg-[#fef3f2] text-[#b42318]"
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
          })}
        </div>
      )}

      {enabledCount > 0 && <p className="mt-4 text-[11px] text-muted">已授权 {enabledCount} 个工具给模型调用。</p>}
      <p className="mt-2 text-[11px] text-muted">
        工具调用在本地执行：模型返回调用意图 → 本机调用 MCP 服务 → 结果回灌模型，全程不经过云端。
      </p>

      {removeTarget && (
        <ConfirmDialog
          title="删除 MCP 服务"
          onCancel={() => setRemoveTarget(null)}
          footer={
            <>
              <button
                type="button"
                onClick={() => setRemoveTarget(null)}
                className="rounded-lg border border-line px-3 py-1.5 text-[12px] text-muted hover:bg-[#f7f7f7]"
              >
                取消
              </button>
              <button
                type="button"
                onClick={confirmRemoveServer}
                className="rounded-lg bg-[#b42318] px-3 py-1.5 text-[12px] font-medium text-white"
              >
                删除
              </button>
            </>
          }
        >
          <p className="text-[12px] leading-6">
            删除 MCP 服务「{removeTarget.name}」？这条配置、缓存的工具清单与逐个工具的授权开关都会被移除；
            需要时得重新添加或从发现页安装。删除不会卸载本机的第三方包。
          </p>
        </ConfirmDialog>
      )}
    </PageShell>
  );
}

/** 供测试使用：当前会注入给模型的工具名（便于断言命名空间）。 */
export function describeExposedTools(registry: McpRegistry = mcpRegistry): string[] {
  const catalog = buildToolCatalog(registry.enabledTools());
  return catalog.entries.map((e) => e.openAiName);
}
