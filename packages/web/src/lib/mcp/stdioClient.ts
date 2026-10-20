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
    config: { command: string; args?: string[] },
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
  const config = { command, args: server.args ?? [] };
  let sessionId: string | null = null;

  const call = async <T>(method: string, params?: unknown): Promise<T> => {
    const result = await bridge.request(server.id, config, method, params);
    return (result ?? {}) as T;
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
    async callTool(name, args) {
      const result = await call<{ content?: unknown[]; isError?: boolean }>("tools/call", {
        name,
        arguments: args,
      });
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
