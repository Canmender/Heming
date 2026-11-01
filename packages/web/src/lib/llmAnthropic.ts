/**
 * OpenAI 形状的内部消息 → Anthropic Messages 协议体。
 *
 * ★ 为什么单独一个文件：和鸣的智能体主循环、HITL、审计、上下文摘要全都按 OpenAI
 * 形状工作（`role:"tool"` 一行一个结果、`tool_calls` 挂在 assistant 上）。把 IR 换成
 * content blocks 要动四条链路，代价远大于在边缘转换一次。借鉴 hermes-agent
 * （MIT © 2025 Nous Research）`agent/anthropic_message_convert.py` 的判据。
 *
 * ★ 这里的每一条规则都对应一个真实失败，不是风格：
 *   - 空 text block → 硬 400（`text content blocks must be non-empty`）
 *   - `role:"tool"` 直发 → 400（Anthropic 没有这个角色，tool_result 属于 user 消息）
 *   - 孤立的 tool_use / 找不到出处的 tool_result → 400，且**每次重放都 400**
 *   - 供应商不接受的图片格式一旦进历史，同样每次重放都 400
 * 所以这里的容错方向一律是「丢掉这条不可发的内容」而不是「让整轮失败」。
 */
import type { ChatMessage, ContentPart, MessageContent } from "./llmClient.js";

/** 空内容占位：Anthropic 不吃空 text block（Hermes 同此）。 */
export const ANTHROPIC_EMPTY_TEXT = "(empty)";

/** Claude 接受的图片 media_type；其余必须退成文本，否则整段历史每次重放都 400。 */
const IMAGE_MEDIA_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

/** Anthropic 的 id 字符集（`tool_use_id` 要与 `tool_use.id` 逐字相等，故清洗后必须复用同一函数）。 */
const TOOL_ID_INVALID = /[^a-zA-Z0-9_-]/g;

/** Anthropic 的模型 id 不接受空格与控制字符（第三方网关常塞进来）。 */
export function sanitizeToolId(id: string | undefined): string {
  const cleaned = (id ?? "").replace(TOOL_ID_INVALID, "_");
  return cleaned || "tool_0";
}

/** cache_control 标记形状（`ttl` 省略 = 供应商缺省 5m）。 */
export interface CacheMarker {
  type: "ephemeral";
  ttl?: string;
}

export interface TextBlock {
  type: "text";
  text: string;
  cache_control?: CacheMarker;
}

export interface ImageBlock {
  type: "image";
  source: { type: "base64"; media_type: string; data: string };
  cache_control?: CacheMarker;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
  cache_control?: CacheMarker;
}

export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
  cache_control?: CacheMarker;
}

export type AnthropicBlock = TextBlock | ImageBlock | ToolUseBlock | ToolResultBlock;

export interface AnthropicMessage {
  role: "user" | "assistant";
  content: AnthropicBlock[];
}

export interface AnthropicTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  cache_control?: CacheMarker;
}

/** 一条已完成 tool_use → tool_result 事务（供缓存断点选点）。 */
export interface TransactionEnd {
  /** 在 `toAnthropicMessages` 产出数组里的下标。 */
  index: number;
  /** 该条消息里最后一个 block 的下标。 */
  blockIndex: number;
}

const EMPTY_JSON_SCHEMA = { type: "object", properties: {} } as const;

/**
 * 工具参数：OpenAI 侧是 JSON **字符串**，Anthropic 侧要**对象**。
 * 解析失败退回 `{}`——半个 JSON 当参数发出去只会让模型收到一份看不懂的报错。
 */
export function parseToolInput(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "string" || raw.trim() === "") return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * JSON Schema 归一，交给 Anthropic 的校验器（借 `_normalize_tool_input_schema`）：
 * - 顶层 `oneOf`/`allOf`/`anyOf` 被拒（generic 400）⇒ 删掉并补 `type:"object"`
 * - MCP/Pydantic 的可空并集 `[{...},{type:"null"}]` 折成非空分支（可选性已由 `required` 表达）
 * - `type:"object"` 缺 `properties` ⇒ 补 `{}`
 * - 顶层 `$schema`（常是 URI 字符串）删掉
 */
export function normalizeInputSchema(schema: unknown): Record<string, unknown> {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return { ...EMPTY_JSON_SCHEMA };
  }
  const out = collapseNullable({ ...(schema as Record<string, unknown>) }) as Record<string, unknown>;
  const banned = ["oneOf", "allOf", "anyOf", "$schema"];
  if (banned.some((k) => k in out)) {
    for (const k of banned) delete out[k];
    out.type = "object";
    if (!out.properties || typeof out.properties !== "object") out.properties = {};
  }
  if (out.type === "object" && (!out.properties || typeof out.properties !== "object")) {
    out.properties = {};
  }
  return out;
}

/** 递归把「可空并集」折成非空分支；只在分支恰好两条且一条是 null 时动手，别的一律原样。 */
function collapseNullable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(collapseNullable);
  if (!value || typeof value !== "object") return value;
  const node = { ...(value as Record<string, unknown>) };
  for (const key of ["anyOf", "oneOf"]) {
    const list = node[key];
    if (!Array.isArray(list) || list.length !== 2) continue;
    const isNull = (v: unknown) =>
      !!v && typeof v === "object" && (v as { type?: unknown }).type === "null";
    const nonNull = list.filter((v) => !isNull(v));
    if (nonNull.length === 1) {
      delete node[key];
      Object.assign(node, nonNull[0] as Record<string, unknown>);
    }
  }
  for (const [k, v] of Object.entries(node)) node[k] = collapseNullable(v);
  return node;
}

/**
 * OpenAI 形状的 `tools` → Anthropic `tools`。
 * 重名硬 400 ⇒ 去重（注册表已是 first-declared-wins，这里是边缘自保，不信任上游）。
 */
export function toAnthropicTools(tools: unknown[] | undefined): AnthropicTool[] {
  const out: AnthropicTool[] = [];
  const seen = new Set<string>();
  for (const raw of tools ?? []) {
    if (!raw || typeof raw !== "object") continue;
    const fn = (raw as { function?: unknown }).function as
      | { name?: unknown; description?: unknown; parameters?: unknown }
      | undefined;
    const name = typeof fn?.name === "string" ? fn.name : "";
    if (!name) continue;
    if (seen.has(name)) {
      console.warn(`Anthropic 工具名重复，已丢弃后一个：${name}`);
      continue;
    }
    seen.add(name);
    out.push({
      name,
      description: typeof fn?.description === "string" ? fn.description : "",
      input_schema: normalizeInputSchema(fn?.parameters) as Record<string, unknown>,
    });
  }
  return out;
}

/** 内容片 → block 数组；不支持的图片退成文本占位。 */
function blocksFromContent(content: MessageContent): AnthropicBlock[] {
  const parts: ContentPart[] =
    typeof content === "string" ? [{ type: "text", text: content }] : content;
  const blocks: AnthropicBlock[] = [];
  for (const part of parts) {
    if (part.type === "text") {
      if (part.text) blocks.push({ type: "text", text: part.text });
      continue;
    }
    if (IMAGE_MEDIA_TYPES.has(part.mime)) {
      blocks.push({
        type: "image",
        source: { type: "base64", media_type: part.mime, data: part.data },
      });
    } else {
      blocks.push({ type: "text", text: `[不支持的图片格式: ${part.mime}]` });
    }
  }
  return blocks;
}

/** `system` 字符串形态（关闭缓存时的缺省）：与 d.48 的 body 逐字一致。 */
export function toAnthropicSystemText(messages: ChatMessage[]): string | undefined {
  const joined = messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .filter((t) => t !== "")
    .join("\n");
  return joined || undefined;
}

/** `system` block 数组形态（挂 cache_control 必须是数组）。 */
export function toAnthropicSystemBlocks(messages: ChatMessage[]): TextBlock[] {
  const rows = messages.filter((m) => m.role === "system" && m.content !== "");
  if (rows.length === 0) return [];
  if (rows.length === 1) return [{ type: "text", text: rows[0].content }];
  // 多条 system（系统提示词 + 上下文摘要）合并成一块：分块数会影响缓存前缀的稳定性
  return [{ type: "text", text: rows.map((m) => m.content).join("\n") }];
}

/**
 * IR → Anthropic 消息数组。
 *
 * 顺序处理，一次遍历同时完成三件事：
 * 1. `assistant.tool_calls` → `tool_use` block，并按「是否有人回答它」决定去留；
 * 2. 连续的 `role:"tool"` 行 → 合并成**一条 user 消息**的 `tool_result` 数组
 *    （Anthropic 要求同一事务的结果在同一条消息里）；
 * 3. 相邻同角色消息合并，避免「连续两条 user」这类形状问题。
 */
export function toAnthropicMessages(
  messages: ChatMessage[],
): { messages: AnthropicMessage[]; transactionEnds: TransactionEnd[] } {
  const nonSystem = messages.filter((m) => m.role !== "system");
  // 事务完整性双向判定：有结果的调用 id / 有出处的结果 id
  const answeredIds = new Set<string>();
  const declaredIds = new Set<string>();
  for (const m of nonSystem) {
    if (m.role === "tool" && m.tool_call_id) answeredIds.add(sanitizeToolId(m.tool_call_id));
    for (const call of m.tool_calls ?? []) declaredIds.add(sanitizeToolId(call.id));
  }

  const out: AnthropicMessage[] = [];
  let pendingResults: ToolResultBlock[] = [];

  const flushResults = () => {
    if (!pendingResults.length) return;
    pushMessage(out, "user", pendingResults);
    pendingResults = [];
  };

  for (const m of nonSystem) {
    if (m.role === "tool") {
      const id = sanitizeToolId(m.tool_call_id);
      // 找不到出处的 tool_result 会让整段历史每次重放都 400 ⇒ 丢，不报错
      if (!declaredIds.has(id)) {
        console.warn(`丢弃无对应 tool_use 的工具结果：${id}`);
        continue;
      }
      pendingResults.push({
        type: "tool_result",
        tool_use_id: id,
        content: m.content || ANTHROPIC_EMPTY_TEXT,
        ...(m.toolError ? { is_error: true } : {}),
      });
      continue;
    }
    flushResults();

    if (m.role === "assistant" && m.tool_calls?.length) {
      const blocks: AnthropicBlock[] = [];
      const text = m.content || "";
      const calls = m.tool_calls.filter((call) => answeredIds.has(sanitizeToolId(call.id)));
      const dropped = m.tool_calls.length - calls.length;
      if (dropped > 0) {
        console.warn(`丢弃 ${dropped} 个没有结果的 tool_use（中止或窗口裁剪留下的一半事务）`);
      }
      if (text) blocks.push({ type: "text", text });
      for (const call of calls) {
        blocks.push({
          type: "tool_use",
          id: sanitizeToolId(call.id),
          name: call.function?.name ?? "",
          input: parseToolInput(call.function?.arguments),
        });
      }
      if (blocks.length === 0) blocks.push({ type: "text", text: ANTHROPIC_EMPTY_TEXT });
      pushMessage(out, "assistant", blocks);
      continue;
    }

    const blocks = blocksFromContent(m.contentParts ?? m.content);
    pushMessage(out, m.role === "assistant" ? "assistant" : "user", blocks.length ? blocks : [{ type: "text", text: ANTHROPIC_EMPTY_TEXT }]);
  }
  flushResults();

  // 事务末尾：一条「全部是 tool_result」的 user 消息，其工具轮已经完整
  const transactionEnds: TransactionEnd[] = [];
  out.forEach((msg, index) => {
    if (msg.content.length > 0 && msg.content.every((b) => b.type === "tool_result")) {
      transactionEnds.push({ index, blockIndex: msg.content.length - 1 });
    }
  });
  return { messages: out, transactionEnds };
}

/** 相邻同角色合并（Anthropic 的形状假设是 user/assistant 交替）。 */
function pushMessage(list: AnthropicMessage[], role: "user" | "assistant", blocks: AnthropicBlock[]): void {
  const last = list[list.length - 1];
  if (last && last.role === role) last.content.push(...blocks);
  else list.push({ role, content: [...blocks] });
}

/** 非流式响应 → IR 可用的 `{ text, toolCalls }`（`content` 可能混着 thinking/text/tool_use）。 */
export function readAnthropicContent(content: unknown): { text: string; calls: unknown[] } {
  const blocks = Array.isArray(content) ? content : [];
  let text = "";
  const calls: unknown[] = [];
  for (const raw of blocks) {
    if (!raw || typeof raw !== "object") continue;
    const b = raw as { type?: unknown; text?: unknown; id?: unknown; name?: unknown; input?: unknown };
    if (b.type === "text" && typeof b.text === "string") text += b.text;
    if (b.type === "tool_use") {
      calls.push({
        id: typeof b.id === "string" ? b.id : sanitizeToolId(""),
        type: "function",
        function: {
          name: typeof b.name === "string" ? b.name : "",
          arguments: JSON.stringify(b.input ?? {}),
        },
      });
    }
  }
  return { text, calls };
}
