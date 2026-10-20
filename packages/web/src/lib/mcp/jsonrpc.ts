/**
 * JSON-RPC 2.0 的最小实现与 SSE 帧解析（纯函数，便于单测）。
 *
 * MCP 的 HTTP 传输规定：请求体是一个 JSON-RPC 消息；响应可能是
 * - `application/json`：直接一个 JSON-RPC 响应；
 * - `text/event-stream`：多行 `data: {...}`，每行一个 JSON-RPC 消息（可能夹心跳/通知）。
 */

export interface JsonRpcErrorShape {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcResponse<T = unknown> {
  jsonrpc: "2.0";
  id?: number | string | null;
  result?: T;
  error?: JsonRpcErrorShape;
}

/** 构造一条 JSON-RPC 请求（id 由调用方递增，便于把响应配对回来）。 */
export function rpcRequest(id: number, method: string, params?: unknown): string {
  const body: Record<string, unknown> = { jsonrpc: "2.0", id, method };
  if (params !== undefined) body.params = params;
  return JSON.stringify(body);
}

/** 构造一条 JSON-RPC 通知（无 id、无响应）。 */
export function rpcNotification(method: string, params?: unknown): string {
  const body: Record<string, unknown> = { jsonrpc: "2.0", method };
  if (params !== undefined) body.params = params;
  return JSON.stringify(body);
}

/**
 * 从 SSE 文本里抽出所有 JSON-RPC 消息（忽略心跳、注释与不合法行）。
 * 输入允许是**不完整**的文本（流式读取时逐段喂入），只解析完整的 `data:` 行。
 */
export function parseSseMessages(text: string): JsonRpcResponse[] {
  const out: JsonRpcResponse[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    try {
      const parsed = JSON.parse(data) as JsonRpcResponse;
      // 响应与通知都收（通知用于日志/调试），调用方按 id 取自己那条
      if (parsed && typeof parsed === "object" && ("result" in parsed || "error" in parsed || "method" in parsed)) {
        out.push(parsed);
      }
    } catch {
      /* 心跳/非 JSON 行忽略 */
    }
  }
  return out;
}

/** 取出与请求 id 配对的那条响应；找不到返回 null。 */
export function pickResponse<T>(
  messages: readonly JsonRpcResponse<unknown>[],
  id: number,
): JsonRpcResponse<T> | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].id === id) return messages[i] as JsonRpcResponse<T>;
  }
  return null;
}

/** 把 JSON-RPC 错误转成人话（协议层错误统一收在这里，调用方不必重复判断）。 */
export function formatRpcError(err: JsonRpcErrorShape | undefined): string {
  if (!err) return "MCP 服务返回了空错误";
  return `${err.message}（code ${err.code}）`;
}
