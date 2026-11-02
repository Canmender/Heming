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

/**
 * 单次工具结果回灌给模型的字符上限。
 *
 * 为什么必须封顶：工具结果会被**原样塞进下一轮请求**，而上下文预算只有几千 token。
 * 一个返回 200KB JSON 的工具足以把预算一次占满，随后触发压缩→再超→重试的循环，
 * 用户看到的是「回答突然变慢变傻」。8000 字符约等于 2–3k token（中文更贵），
 * 在「够模型判断」与「不挤掉对话」之间取值。
 */
export const MAX_TOOL_RESULT_CHARS = 8000;

/** 截断时头部的占比：头部通常是结构/表头，尾部通常是结论/报错，两头都要留。 */
const TRUNCATE_HEAD_RATIO = 2 / 3;

/**
 * 按字符上限截断工具结果：保留头部 2/3 + 尾部 1/3，中间插入明确的截断标记。
 *
 * ★ 标记必须让模型看得见「这里被截断了」——否则它会基于残文下结论，
 * 而我们拿到的是一个自信的错误答案。标记里带被省略的字符数，模型据此判断要不要换策略。
 */
export function truncateToolResult(text: string, maxChars: number = MAX_TOOL_RESULT_CHARS): string {
  const raw = String(text ?? "");
  if (raw.length <= maxChars) return raw;
  const head = Math.floor(maxChars * TRUNCATE_HEAD_RATIO);
  const tail = maxChars - head;
  const dropped = raw.length - maxChars;
  return `${raw.slice(0, head)}\n\n…（工具结果过长，中间省略 ${dropped} 字符；如需完整内容，请缩小参数范围或到对应服务里查看）…\n\n${raw.slice(-tail)}`;
}

/** 执行一次工具调用的可选控制项。 */
export interface ToolCallOptions {
  /**
   * 中断信号：用户按「中断」或整轮放弃时透传进来，让在途的工具调用尽快收手。
   *
   * 没有它的时候，用户已经点了中断，MCP 那边还在跑——结果没人收，副作用却已经发生。
   */
  signal?: AbortSignal;
}

export interface ToolExecutionDeps {
  /** 按服务 id 拿客户端（同一次对话里应复用，保持 MCP 会话）。 */
  clientFor: (serverId: string) => HttpMcpClient;
}

/**
 * 执行一次模型发起的工具调用。
 *
 * 永不抛出：失败信息作为工具结果回给模型（模型可据此换策略），这也符合
 * 「工具失败不应该让整轮对话崩掉」的常识。返回文本一律经 `truncateToolResult` 封顶。
 */
export async function executeToolCall(
  call: { name: string; arguments: string },
  catalog: ToolCatalog,
  deps: ToolExecutionDeps,
  opts?: ToolCallOptions,
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

  // 调用前就已被中断：不必再发请求（stdio 侧会把副作用留在子进程里）
  if (opts?.signal?.aborted) return { text: "工具调用失败：本轮已中断，未执行", ok: false };

  try {
    const client = deps.clientFor(entry.ref.serverId);
    const result = await client.callTool(entry.ref.tool.name, args, { signal: opts?.signal });
    if (result.isError) {
      return { text: truncateToolResult(`工具返回错误：${result.text || "（无详情）"}`), ok: false };
    }
    return { text: truncateToolResult(result.text || "（工具没有返回文本内容）"), ok: true };
  } catch (err) {
    return { text: truncateToolResult(`工具调用失败：${err instanceof Error ? err.message : String(err)}`), ok: false };
  }
}
