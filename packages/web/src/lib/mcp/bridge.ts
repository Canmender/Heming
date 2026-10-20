import type { HttpMcpClient } from "./httpClient.js";
import type { McpToolRef } from "./types.js";

/**
 * 把 MCP 工具桥接成模型能看懂的「函数调用」。
 *
 * 关键点：**工具名必须全局唯一且合法**（OpenAI 要求 `^[a-zA-Z0-9_-]{1,64}$`），
 * 所以用 `服务名__工具名` 做命名空间；模型返回的调用名再映射回 (serverId, toolName)。
 */
export const TOOL_NAME_SEP = "__";
export const TOOL_NAME_MAX = 64;

/** 把任意显示名压成合法片段（保留中文会破坏 OpenAI 校验，故非 ASCII 一律转成短哈希）。 */
export function slugPart(input: string): string {
  const ascii = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (ascii) return ascii.slice(0, 24);
  // 纯中文等：用稳定短哈希，保证同一名字每次都得到同一片段
  let h = 0;
  for (let i = 0; i < input.length; i++) h = (h * 31 + input.charCodeAt(i)) >>> 0;
  return `t${h.toString(36)}`;
}

export interface ToolCatalogEntry {
  /** 暴露给模型的名字（全局唯一）。 */
  openAiName: string;
  ref: McpToolRef;
}

export interface ToolCatalog {
  entries: ToolCatalogEntry[];
  byName: Map<string, ToolCatalogEntry>;
}

/** 构造工具目录（含重名去重：同名时追加 -2、-3）。 */
export function buildToolCatalog(refs: McpToolRef[]): ToolCatalog {
  const entries: ToolCatalogEntry[] = [];
  const byName = new Map<string, ToolCatalogEntry>();
  for (const ref of refs) {
    const base = `${slugPart(ref.serverName)}${TOOL_NAME_SEP}${slugPart(ref.tool.name)}`.slice(
      0,
      TOOL_NAME_MAX,
    );
    let name = base;
    let n = 2;
    while (byName.has(name)) {
      const suffix = `-${n++}`;
      name = base.slice(0, TOOL_NAME_MAX - suffix.length) + suffix;
    }
    const entry = { openAiName: name, ref };
    entries.push(entry);
    byName.set(name, entry);
  }
  return { entries, byName };
}

/** OpenAI 兼容的 tools 数组（`tools` 字段直接塞进请求体）。 */
export function toOpenAiTools(catalog: ToolCatalog): unknown[] {
  return catalog.entries.map((e) => ({
    type: "function",
    function: {
      name: e.openAiName,
      description: e.ref.tool.description ?? `${e.ref.serverName} 提供的工具 ${e.ref.tool.name}`,
      parameters: e.ref.tool.inputSchema ?? { type: "object", properties: {} },
    },
  }));
}

/** Anthropic 的 tools 数组（字段名是 input_schema）。 */
export function toAnthropicTools(catalog: ToolCatalog): unknown[] {
  return catalog.entries.map((e) => ({
    name: e.openAiName,
    description: e.ref.tool.description ?? `${e.ref.serverName} 提供的工具 ${e.ref.tool.name}`,
    input_schema: e.ref.tool.inputSchema ?? { type: "object", properties: {} },
  }));
}

/** 工具调用结果：`ok=false` 时 `text` 是给用户/模型看的失败原因。 */
export interface ToolExecutionResult {
  text: string;
  ok: boolean;
}

export interface ToolExecutionDeps {
  /** 按服务 id 拿客户端（同一次对话里应复用，保持 MCP 会话）。 */
  clientFor: (serverId: string) => HttpMcpClient;
}

/**
 * 执行一次模型发起的工具调用。
 *
 * 永不抛出：失败信息作为工具结果回给模型（模型可据此换策略），这也符合
 * 「工具失败不应该让整轮对话崩掉」的常识。
 */
export async function executeToolCall(
  call: { name: string; arguments: string },
  catalog: ToolCatalog,
  deps: ToolExecutionDeps,
): Promise<ToolExecutionResult> {
  const entry = catalog.byName.get(call.name);
  if (!entry) return { text: `工具调用失败：未知工具 ${call.name}`, ok: false };

  let args: Record<string, unknown> = {};
  const raw = call.arguments?.trim();
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        args = parsed as Record<string, unknown>;
      } else {
        return { text: "工具调用失败：参数必须是 JSON 对象", ok: false };
      }
    } catch {
      return { text: `工具调用失败：参数不是合法 JSON（${raw.slice(0, 120)}）`, ok: false };
    }
  }

  try {
    const client = deps.clientFor(entry.ref.serverId);
    const result = await client.callTool(entry.ref.tool.name, args);
    if (result.isError) return { text: `工具返回错误：${result.text || "（无详情）"}`, ok: false };
    return { text: result.text || "（工具没有返回文本内容）", ok: true };
  } catch (err) {
    return { text: `工具调用失败：${err instanceof Error ? err.message : String(err)}`, ok: false };
  }
}
