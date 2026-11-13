import type { ToolBridge } from "../agentStream.js";
import { buildToolCatalog, executeToolCall, toOpenAiTools } from "./bridge.js";
import { createHttpMcpClient, type HttpMcpClient } from "./httpClient.js";
import { createStdioMcpClient, hasStdioBridge, stdioBridge } from "./stdioClient.js";
import { mcpRegistry, type McpRegistry } from "./store.js";
import type { McpServerConfig, McpTool, McpToolRef } from "./types.js";

/**
 * MCP 运行时：把注册表（配置 + 启用开关）、HTTP 客户端与工具桥接串起来。
 *
 * 客户端按 serverId 缓存，保证多轮对话复用同一个 MCP 会话（session id 在客户端里）。
 */
const clients = new Map<string, HttpMcpClient>();

export function clientFor(server: McpServerConfig): HttpMcpClient {
  const cached = clients.get(server.id);
  if (cached) return cached;
  const client =
    server.transport === "stdio" ? createStdioMcpClient(server) : createHttpMcpClient(server);
  clients.set(server.id, client);
  return client;
}

/** 重建客户端（改了 URL/请求头之后必须重建，否则还连着旧地址）。 */
export function resetClient(serverId: string): void {
  clients.delete(serverId);
}

/**
 * 回收某台 stdio 服务在本机的子进程（删除服务时必调）。
 *
 * ★ 为什么不能只靠 `resetClient`：客户端对象在渲染层，子进程活在**主进程**里，
 * 按 serverId 复用。删了配置不 stop 进程，就会出现「界面已经删除、进程还在读写本机」——
 * 而且下次同 id 的服务还会复用那个旧进程。
 *
 * 只在删除路径调用，不放 `resetClient` 里：`refreshServerTools` 每次都 resetClient，
 * 一并 kill 会让「重连一次」变成「重启一次进程」（实测 Windows-MCP 冷启动 5.4s）。
 *
 * **永不抛**：进程可能已经自己退出，删除动作不该被回收失败阻断。
 */
export async function stopStdioServer(serverId: string): Promise<void> {
  const bridge = stdioBridge();
  if (!bridge) return;
  try {
    await bridge.stop(serverId);
  } catch {
    /* 已经退出或主进程侧异常：配置已删，没有可恢复的动作 */
  }
}

/**
 * 连接一台服务并刷新它的工具清单。
 * 返回工具列表；失败抛出（调用方在 UI 上展示错误，不吞掉）。
 */
export async function refreshServerTools(
  serverId: string,
  registry: McpRegistry = mcpRegistry,
): Promise<McpTool[]> {
  const server = registry.get(serverId);
  if (!server) throw new Error("MCP 服务不存在");
  try {
    if (server.transport === "stdio" && !hasStdioBridge()) {
      throw new Error("stdio 传输需要桌面端运行（浏览器无法拉起本地进程）");
    }
    resetClient(serverId);
    const client = clientFor(server);
    await client.initialize();
    const tools = await client.listTools();
    registry.setTools(serverId, tools);
    // 预置服务：把只读那批工具自动打开（PowerShell/Registry 这类写操作的绝不在内）。
    // 用户手动关掉的不会被再打开——autoEnableSafeTools 内部查 userDisabled。
    if (registry.isPreset(serverId)) registry.autoEnableSafeTools(serverId, tools);
    registry.setStatus(serverId, { state: "connected", tools: tools.length });
    return tools;
  } catch (err) {
    /*
     * 失败必须留痕（MCP 审计 D3）：以前这里只把错误抛给调用方，界面却按
     * 「有没有落盘的工具快照」显示「已连接」——服务早就死了，用户看到的是绿点，
     * 模型拿到的是指向死进程的目录。现在记录最近一次尝试的结果，界面据此显示
     * 「连接失败（工具清单已过期）」。
     */
    const message = err instanceof Error ? err.message : String(err);
    registry.setStatus(serverId, {
      state: registry.hasDiscovered(serverId) ? "stale" : "error",
      error: message,
    });
    throw err;
  }
}

/** 一台服务的连接结果（自动连接用；失败不抛，交给调用方决定要不要提示）。 */
export interface AutoConnectResult {
  serverId: string;
  name: string;
  ok: boolean;
  tools: number;
  /** 失败原因（ok=false 时有值，如「stdio 需要桌面端」）。 */
  error?: string;
  /** 跳过（不是错误）：浏览器端遇 stdio、或服务本身已停用。 */
  skipped?: boolean;
}

/**
 * 自动连接所有「已启用」的服务并刷新工具清单 —— 应用启动时调一次。
 *
 * 用户要求「不要每次手动点」。这里做三件事的自动化：
 * 1. 连接每台启用中的服务；
 * 2. 发现工具（`tools/list`）；
 * 3. 预置服务自动启用只读工具。
 *
 * **失败绝不打断应用**：stdio 在浏览器端、命令不存在、服务没起来⋯⋯都只记结果，
 * 由调用方决定是否在界面上提示。用户不该因为一个 MCP 服务坏了就用不了整个应用。
 *
 * **并行而非串行**：早先这里刻意串行，理由是「stdio 会拉起子进程，并行拉起几个容易
 * 互相抢 CPU/网络」。那个理由建立在**首次使用要联网下载依赖**（一两分钟）之上。
 * 现在运行时已全内置（见 `packages/desktop/bundled-runtime.js`），启动只剩本地进程
 * 拉起 + 握手，实测 Windows-MCP 5.4s、Scrapling 2.4s 且互不抢资源——
 * 串行是 7.8s，并行是 5.4s。用户等到工具可用的时间差整整 2.4 秒，值得并。
 *
 * 保留串行语义的只有「结果顺序」：返回值按下标与 candidates 一一对应，
 * 调用方不必关心哪个先完成。
 */
export async function autoConnectAll(
  registry: McpRegistry = mcpRegistry,
): Promise<AutoConnectResult[]> {
  const candidates = registry.servers().filter((s) => s.enabled);
  if (candidates.length === 0) return [];

  // 浏览器端没有 stdio 桥：先整体跳过一次，避免每台都走一遍失败路径
  const stdioAvailable = hasStdioBridge();

  const connectOne = async (server: (typeof candidates)[number]): Promise<AutoConnectResult> => {
    if (server.transport === "stdio" && !stdioAvailable) {
      return {
        serverId: server.id,
        name: server.name,
        ok: false,
        tools: 0,
        skipped: true,
        error: "stdio 需要桌面端运行（当前是浏览器环境）",
      };
    }
    try {
      const tools = await refreshServerTools(server.id, registry);
      return { serverId: server.id, name: server.name, ok: true, tools: tools.length };
    } catch (err) {
      return {
        serverId: server.id,
        name: server.name,
        ok: false,
        tools: 0,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  };

  // 并行发起，但结果按原顺序返回——调用方拿到的顺序不该因为谁先连上而变化。
  // 单台失败已在 connectOne 内转成结果对象，不会让 Promise.all 整体 reject。
  return Promise.all(candidates.map((server) => connectOne(server)));
}

/**
 * 为一次对话构造工具桥：只包含「服务启用 + 工具启用」的那部分。
 * 没有可用工具时返回 null（编排层据此走原路径，零行为变化）。
 *
 * ★ **本桥不提供 `meta.risk`**。
 *
 * MCP 的 `annotations`（`readOnlyHint` / `destructiveHint`）在规范里明言是
 * **untrusted hint**：「Clients should never make tool use decisions based on
 * ToolAnnotations received from untrusted servers」。
 * 拿 `readOnlyHint: true` 当「只读免问」的依据 = 把安全边界交给服务端自述——
 * 恶意服务器只要把标注设成 true，它的 `delete_file` 就会静默执行。
 *
 * 所以 MCP 工具的风险**一律按名字启发判定**（未知 → write，必问），
 * `annotations` 只用于界面上的「该服务器自述为只读工具（未经核实）」这类标注。
 */
export interface BuildToolBridgeOptions {
  /**
   * 逐工具过滤（d.77）：插件声明的 `permissions.tools` 是**风险上限**，
   * 但过滤只能发生在注入点——仅靠能力目录把它们标成「未注入」是展示，
   * 不是约束。调用方（能力提供者）传入插件侧的上限判定；缺省不过滤。
   */
  toolAllowed?: (ref: McpToolRef) => boolean;
}

/**
 * 这条错误是不是「连接层坏了」而不是「工具自己报错」。
 *
 * 为什么分：工具返回错误（参数不对、目标不存在）只该让模型换个做法；
 * 而进程退出/超时/连不上说明这台服务已经不可用，界面还显示「已连接」就会一直骗人，
 * 下一轮也不会自动重连（`mcpNeedsConnect` 看的是连接状态）。这类错误要落状态。
 */
const TRANSPORT_FAILURE_RE =
  /MCP 进程已退出|MCP 进程启动失败|MCP 服务超时|MCP 服务返回 HTTP 5\d\d|fetch failed|ECONNREFUSED|ECONNRESET|EPIPE|请求 id 冲突/;

export function isTransportFailure(message: string): boolean {
  return TRANSPORT_FAILURE_RE.test(String(message ?? ""));
}

export function buildToolBridge(
  registry: McpRegistry = mcpRegistry,
  options: BuildToolBridgeOptions = {},
): ToolBridge | null {
  const enabled = registry.enabledTools();
  const refs = options.toolAllowed ? enabled.filter((ref) => options.toolAllowed!(ref)) : enabled;
  if (refs.length === 0) return null;
  const catalog = buildToolCatalog(refs);
  const tools = toOpenAiTools(catalog);
  return {
    tools,
    execute: async (call, opts) => {
      const result = await executeToolCall(
        call,
        catalog,
        {
          clientFor: (serverId) => {
            const server = registry.get(serverId);
            if (!server) throw new Error("MCP 服务已被删除");
            return clientFor(server);
          },
        },
        // 中断信号一路透传到 callTool：HTTP 立刻 abort，stdio 至少不再等。
        opts,
      );
      if (!result.ok) {
        const serverId = catalog.byName.get(call.name)?.ref.serverId;
        /*
         * 连接层坏了就把状态改成 stale/error：界面不再挂绿点，下一轮发送时
         * `mcpNeedsConnect` 也会据此重连——否则进程死了以后每次调用都失败，
         * 但界面一直显示「已连接」，只能重启应用才恢复。
         */
        if (serverId && isTransportFailure(result.text)) {
          registry.setStatus(serverId, {
            state: registry.hasDiscovered(serverId) ? "stale" : "error",
            error: result.text.replace(/^工具调用失败：/, ""),
          });
        }
      }
      return result;
    },
  };
}
