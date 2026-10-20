/**
 * MCP（Model Context Protocol）客户端的类型定义。
 *
 * 只依赖浏览器可用的能力：**HTTP 传输**（Streamable HTTP，一次 POST 一次响应，
 * 响应可能是 JSON 也可能是 SSE 流）。stdio 传输需要拉起子进程，只有桌面端能做，
 * 由 Electron 主进程桥接（见 `packages/desktop/mcp-stdio.js`）。
 */

/** 传输方式：HTTP（浏览器/桌面都能用）或 stdio（仅桌面端）。 */
export type McpTransport = "http" | "stdio";

/** 用户配置的一台 MCP 服务。 */
export interface McpServerConfig {
  id: string;
  name: string;
  transport: McpTransport;
  /** transport=http 时必填，如 `https://example.com/mcp`。 */
  url?: string;
  /** transport=stdio 时必填，如 `npx`（仅桌面端可用）。 */
  command?: string;
  args?: string[];
  /** 额外请求头（如 Authorization），值原样发给该 MCP 服务。 */
  headers?: Record<string, string>;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

/** MCP 服务暴露的一个工具。 */
export interface McpTool {
  name: string;
  description?: string;
  /** JSON Schema（draft 2020-12 子集）。 */
  inputSchema?: {
    type?: string;
    properties?: Record<string, unknown>;
    required?: string[];
    [key: string]: unknown;
  };
}

/** 工具 + 它属于哪台服务（工具名在全局要加前缀，避免两台服务重名冲突）。 */
export interface McpToolRef {
  serverId: string;
  serverName: string;
  tool: McpTool;
}

/** 连接状态（只在前端展示，不落盘）。 */
export type McpConnState = "idle" | "connecting" | "ready" | "error";

/** `tools/call` 的结构化结果。 */
export interface McpCallResult {
  /** 供模型阅读的纯文本（把 content 数组拼平）。 */
  text: string;
  /** 服务端标记的错误（协议层成功但工具执行失败）。 */
  isError: boolean;
  /** 原始 content 数组，便于 UI 展示图片等非文本块。 */
  content: unknown[];
}
