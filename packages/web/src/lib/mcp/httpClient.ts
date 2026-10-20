import {
  formatRpcError,
  parseSseMessages,
  pickResponse,
  rpcNotification,
  rpcRequest,
  type JsonRpcResponse,
} from "./jsonrpc.js";
import type { McpCallResult, McpServerConfig, McpTool } from "./types.js";

/** MCP 协议版本（客户端声明；服务端可回落到它自己支持的版本）。 */
export const MCP_PROTOCOL_VERSION = "2024-11-05";

/** 单次 HTTP 请求的超时（毫秒）：MCP 服务挂了不能把整轮对话卡死。 */
export const MCP_HTTP_TIMEOUT_MS = 20_000;

export interface HttpMcpClient {
  /** `initialize` 之后服务端返回的会话 id（Streamable HTTP 用它维持会话）。 */
  readonly sessionId: string | null;
  initialize(): Promise<{ serverName?: string; protocolVersion?: string }>;
  listTools(): Promise<McpTool[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult>;
}

interface RpcEnvelope<T> {
  result: T;
}

/**
 * 创建一个 HTTP 传输的 MCP 客户端。
 *
 * 协议细节：
 * - 每个请求都是一次 POST（JSON-RPC 2.0），`Accept` 同时声明 json 与 sse；
 * - `initialize` 之后发 `notifications/initialized`（无 id，按协议必须发）；
 * - 会话 id 从响应头 `Mcp-Session-Id` 读取，后续请求带上；
 * - 响应可能是 JSON，也可能是 SSE（逐行 `data:`），两种都解析。
 *
 * `fetchImpl` 可注入，便于单测（不依赖真实网络）。
 */
export function createHttpMcpClient(
  server: McpServerConfig,
  fetchImpl: typeof fetch = fetch,
): HttpMcpClient {
  if (!server.url) throw new Error("该 MCP 服务缺少 URL");
  let sessionId: string | null = null;
  let nextId = 1;

  const post = async (body: string): Promise<{ messages: JsonRpcResponse[] }> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), MCP_HTTP_TIMEOUT_MS);
    try {
      const res = await fetchImpl(server.url as string, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...(sessionId ? { "mcp-session-id": sessionId } : {}),
          ...(server.headers ?? {}),
        },
        body,
        signal: controller.signal,
      });
      const sid = res.headers.get("mcp-session-id");
      if (sid) sessionId = sid;
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`MCP 服务返回 HTTP ${res.status}：${text.slice(0, 200)}`);
      }
      const ctype = res.headers.get("content-type") ?? "";
      if (ctype.includes("text/event-stream")) {
        const text = await res.text();
        return { messages: parseSseMessages(text) };
      }
      const json = (await res.json()) as JsonRpcResponse | JsonRpcResponse[];
      return { messages: Array.isArray(json) ? json : [json] };
    } catch (err) {
      if ((err as { name?: string })?.name === "AbortError") {
        throw new Error(`MCP 服务超时（${MCP_HTTP_TIMEOUT_MS / 1000}s 未响应）`);
      }
      throw err instanceof Error ? err : new Error(String(err));
    } finally {
      clearTimeout(timer);
    }
  };

  const call = async <T>(method: string, params?: unknown): Promise<T> => {
    const id = nextId++;
    const { messages } = await post(rpcRequest(id, method, params));
    const found = pickResponse<T>(messages, id);
    if (!found) throw new Error(`MCP 服务的响应里没有 ${method} 的结果`);
    if (found.error) throw new Error(formatRpcError(found.error));
    return (found.result ?? ({} as T)) as T;
  };

  return {
    get sessionId() {
      return sessionId;
    },

    async initialize() {
      const result = await call<RpcEnvelope<never>>("initialize", {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "heming", version: "1.0.0" },
      });
      // 按协议必须回一条 initialized 通知；失败不阻塞（部分服务端会忽略）
      try {
        await post(rpcNotification("notifications/initialized"));
      } catch {
        /* 通知失败不影响后续 tools/* 调用 */
      }
      const info = result as unknown as {
        protocolVersion?: string;
        serverInfo?: { name?: string };
      };
      return { serverName: info.serverInfo?.name, protocolVersion: info.protocolVersion };
    },

    async listTools() {
      const result = await call<{ tools?: McpTool[] }>("tools/list", {});
      return (result.tools ?? []).map((t) => ({ ...t }));
    },

    async callTool(name, args) {
      const result = await call<{
        content?: unknown[];
        isError?: boolean;
      }>("tools/call", { name, arguments: args });
      const content = result.content ?? [];
      return { text: stringifyContent(content), isError: result.isError === true, content };
    },
  };
}

/**
 * 把 MCP 的 content 数组拼成人/模型都能读的纯文本。
 * 文本块直出；图片/资源块退化为占位说明（不把 base64 塞进提示词）。
 */
export function stringifyContent(content: unknown[]): string {
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      parts.push(String(block));
      continue;
    }
    const b = block as { type?: string; text?: string; mimeType?: string; uri?: string; resource?: { text?: string } };
    if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
    else if (b.type === "resource" && typeof b.resource?.text === "string") parts.push(b.resource.text);
    else if (b.type === "image") parts.push(`[图片 ${b.mimeType ?? ""}]`.trim());
    else if (b.type === "resource_link") parts.push(`[资源 ${b.uri ?? ""}]`.trim());
    else parts.push(`[${b.type ?? "未知内容块"}]`);
  }
  return parts.join("\n").trim();
}
