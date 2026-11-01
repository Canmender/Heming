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
  /**
   * 来源。**缺省视为 `manual`**（兼容旧数据）。
   *
   * 为什么需要显式字段而不是靠 id 前缀判断：id 是可以被人手填撞上的，
   * 而 `origin` 是声明式的。界面据此区分「内置预置 / 用户手填 / 从 Registry 装的」。
   */
  origin?: ServerOrigin;
  /** 从 Registry 装时，Registry 里的 `server.name`（反向域名）。**用于判「是否已安装」。** */
  registryName?: string;
  /**
   * 从 Registry 装的本地包类型（`npm` / `pypi`）。
   *
   * ★ 这是**台账字段**，不参与任何执行决策——真正跑什么由 `command`/`args` 决定，
   * 而本机运行时缺不缺由桌面端探测（`lib/registry/runtime.ts`）。
   * 存它的理由：界面上要说清「这条 stdio 服务是 Registry 装来的 npm 包」，
   * 而不是用户手填的一行命令。
   */
  registryType?: string;
  /**
   * 安装时**钉住**的包版本（如 `0.6.2`）。
   *
   * 为什么重要：`args` 里钉的是 `<包>@<版本>`，上游发新版不影响本机跑的这份；
   * 没有这个字段，界面上就看不出台账里这台服务对应哪个版本，
   * 「该升级了」与「已被人改过配置」都无从判断。
   */
  registryVersion?: string;
}

/**
 * MCP 服务的来源。
 *
 * - `preset`：内置预置（界面标「默认接入」，行为上不可完全删除）；
 * - `manual`：用户在接口区手填；
 * - `registry`：从官方 Registry 一键安装（2026-10 新增）；
 * - `plugin`：随插件包安装（d.43），启停/卸载跟随插件。
 */
export type ServerOrigin = "preset" | "manual" | "registry" | "plugin";

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
  /**
   * MCP 规范的行为标注（可选，很多服务端不提供）。
   *
   * ★ **不参与风险判定**，只用于界面上的说明性标注。
   *
   * 规范原文（`schema/2025-06-18/schema.json` 的 `ToolAnnotations.description`）：
   * > "NOTE: all properties in ToolAnnotations are **hints**.
   * >  **Clients should never make tool use decisions based on ToolAnnotations
   * >  received from untrusted servers.**"
   *
   * 2025-12-11 版更明确：`MUST consider tool annotations to be untrusted`。
   * 实测真实服务器（Windows-MCP）**20/20 个工具都带 annotations**——
   * 所以这不是理论风险：恶意服务器只要把 `readOnlyHint` 设成 `true`，
   * 它的 `delete_file` / `run_command` 就会静默执行。
   *
   * → 判定只依据**工具名与描述**（`lib/hitl/classify.ts` 的 `riskOfName`）。
   * → 界面上展示时要标明「该服务器**自述**为只读工具（未经核实）」。
   */
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
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
