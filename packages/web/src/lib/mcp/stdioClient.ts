import { MCP_PROTOCOL_VERSION } from "./httpClient.js";
import type { HttpMcpClient } from "./httpClient.js";
import type { McpServerConfig, McpTool } from "./types.js";

/**
 * stdio 传输的渲染层客户端（仅桌面端可用）。
 *
 * 渲染进程没有 child_process，所有请求都经 preload 暴露的 `window.__mcp_stdio`
 * 转给主进程；主进程按 serverId 复用同一个子进程，并在首次调用时完成握手。
 * 这里保持与 HTTP 客户端**完全相同的接口**，运行时按 transport 选择实现。
 */
export interface McpStdioBridgeApi {
  request: (
    serverId: string,
    config: { command: string; args?: string[]; timeoutMs?: number },
    method: string,
    params?: unknown,
  ) => Promise<unknown>;
  stop: (serverId: string) => Promise<boolean>;
}

/** 取桥（浏览器里没有 → undefined）。 */
export function stdioBridge(): McpStdioBridgeApi | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { __mcp_stdio?: McpStdioBridgeApi }).__mcp_stdio;
}

/** 当前环境能不能用 stdio 传输。 */
export function hasStdioBridge(): boolean {
  return typeof stdioBridge() === "object";
}

export function createStdioMcpClient(server: McpServerConfig): HttpMcpClient {
  const bridge = stdioBridge();
  if (!bridge) throw new Error("stdio 传输需要桌面端运行（浏览器不支持拉起本地进程）");
  const command = server.command?.trim();
  if (!command) throw new Error("stdio 服务缺少启动命令");
  // 超时随配置一并发给主进程：stdio 侧的超时在主进程计时（见 mcp-stdio.js）。
  const config = {
    command,
    args: server.args ?? [],
    ...(typeof server.timeoutMs === "number" ? { timeoutMs: server.timeoutMs } : {}),
  };
  let sessionId: string | null = null;

  const call = async <T>(method: string, params?: unknown, signal?: AbortSignal): Promise<T> => {
    const request = bridge.request(server.id, config, method, params);
    if (!signal) return ((await request) ?? {}) as T;
    if (signal.aborted) throw new Error("工具调用已中断");
    /**
     * stdio 侧的中断只能「**我方不再等**」：IPC 没有取消语义，主进程里的子进程
     * 仍会把这次调用跑完。所以文案必须说清「子进程可能仍在运行」——
     * 否则用户以为已经停了，实际副作用照旧发生。
     */
    return await new Promise<T>((resolve, reject) => {
      const onAbort = () => {
        signal.removeEventListener("abort", onAbort);
        reject(new Error("工具调用已中断（子进程可能仍在运行）"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      request.then(
        (value) => {
          signal.removeEventListener("abort", onAbort);
          resolve((value ?? {}) as T);
        },
        (err) => {
          signal.removeEventListener("abort", onAbort);
          reject(err);
        },
      );
    });
  };

  return {
    get sessionId() {
      return sessionId;
    },
    async initialize() {
      const info = await call<{ protocolVersion?: string; serverInfo?: { name?: string } }>(
        "initialize",
        {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "heming", version: "1.0.0" },
        },
      );
      // 主进程会在 initialize 之后补发 notifications/initialized；这里只记录会话状态
      sessionId = "stdio";
      return { serverName: info.serverInfo?.name, protocolVersion: info.protocolVersion };
    },
    async listTools() {
      const result = await call<{ tools?: McpTool[] }>("tools/list", {});
      return (result.tools ?? []).map((t) => ({ ...t }));
    },
    async callTool(name, args, opts) {
      const result = await call<{ content?: unknown[]; isError?: boolean }>(
        "tools/call",
        { name, arguments: args },
        opts?.signal,
      );
      const content = result.content ?? [];
      return { text: stringify(content), isError: result.isError === true, content };
    },
  };
}

/** 与 HTTP 客户端一致的文本拼平逻辑（stdio 与 http 共用同一套展示约定）。 */
function stringify(content: unknown[]): string {
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
