import type { ToolBridge } from "../agentStream.js";
import { buildToolCatalog, executeToolCall, toOpenAiTools } from "./bridge.js";
import { createHttpMcpClient, type HttpMcpClient } from "./httpClient.js";
import { createStdioMcpClient, hasStdioBridge } from "./stdioClient.js";
import { mcpRegistry, type McpRegistry } from "./store.js";
import type { McpServerConfig, McpTool } from "./types.js";

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
 * 连接一台服务并刷新它的工具清单。
 * 返回工具列表；失败抛出（调用方在 UI 上展示错误，不吞掉）。
 */
export async function refreshServerTools(
  serverId: string,
  registry: McpRegistry = mcpRegistry,
): Promise<McpTool[]> {
  const server = registry.get(serverId);
  if (!server) throw new Error("MCP 服务不存在");
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
  return tools;
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
 */
export function buildToolBridge(registry: McpRegistry = mcpRegistry): ToolBridge | null {
  const refs = registry.enabledTools();
  if (refs.length === 0) return null;
  const catalog = buildToolCatalog(refs);
  const tools = toOpenAiTools(catalog);
  return {
    tools,
    execute: (call) =>
      executeToolCall(call, catalog, {
        clientFor: (serverId) => {
          const server = registry.get(serverId);
          if (!server) throw new Error("MCP 服务已被删除");
          return clientFor(server);
        },
      }),
  };
}
