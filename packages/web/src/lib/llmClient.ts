import type { LlmProfile } from "../store/llm.js";
import { carriedStatus } from "./llmFailure.js";
import { maskMessages } from "./llmMask.js";
import { resolveCapability } from "./modelCaps.js";

/**
 * 模型请求客户端（d.93：只剩 OpenAI 兼容协议）。
 *
 * 和鸣的模型能力统一由本机 magpie 网关提供（d.90），网关对上游做协议翻译，
 * 所以客户端只需要一种形状：OpenAI Chat Completions。已被删除的 Anthropic 协议
 * 实现（`llmAnthropic.ts`、前缀缓存标记、cache_* token 口径）不再保留——
 * 那些几何全部下沉到了 magpie 里，和鸣这边多留一份只会制造两套口径。
 */

/** 模型发起的一次工具调用（OpenAI 兼容格式）。 */
export interface ToolCall {
  id: string;
  type?: "function";
  function: { name: string; arguments: string };
}

/** 多模态消息的一段内容；图片统一存 base64（不带 `data:` 前缀）。 */
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image"; mime: string; data: string };

export type MessageContent = string | ContentPart[];

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** 多模态内容片（图片等）：存在时覆盖 `content` 发给供应商，`content` 仍保留纯文本。 */
  contentParts?: ContentPart[];
  /** assistant 消息里带的工具调用（回灌历史时原样带回，模型才知道自己调过什么）。 */
  tool_calls?: ToolCall[];
  /** role=tool 时对应哪次调用。 */
  tool_call_id?: string;
  /** role=tool 时的工具名（部分供应商要求）。 */
  name?: string;
}

/** 取消息实际要发的纯文本（无内容片时）。 */
export function messageText(message: ChatMessage): string {
  return message.content;
}

/** OpenAI 兼容：图片走 `image_url` + data URL。 */
function toOpenAiContent(content: MessageContent): unknown {
  if (typeof content === "string") return content;
  return content.map((part) =>
    part.type === "text"
      ? { type: "text", text: part.text }
      : { type: "image_url", image_url: { url: `data:${part.mime};base64,${part.data}` } },
  );
}

export interface BuildRequestOpts {
  stream: boolean;
  /** 工具声明（OpenAI 格式的 `{type:"function",...}` 数组）；为空/未传时请求体与旧版一致。 */
  tools?: unknown[];
  /**
   * 流式请求是否带 `stream_options: {include_usage:true}`（尾包才会回 usage）。
   * 缺省带；显式 false 不带——部分第三方兼容网关不认这个参数会 400，
   * streamChat 据此在 400 时关掉它重试一次。
   */
  includeUsage?: boolean;
}

/** 一次请求里供应商上报的用量（拿不到字段就留 undefined，绝不补 0）。 */
export interface UsageTotals {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

/**
 * 带状态码的供应商错误。
 *
 * 存在理由：路由层按「为什么失败」决定换不换候选、冷却多久（见 lib/llmFailure.ts），
 * 而 `Error.message` 里的 `HTTP 429` 只能靠正则捞——那不是判据，是猜。
 */
export class LlmHttpError extends Error {
  readonly status: number;
  readonly body: string;
  /** 供应商 Retry-After（毫秒）；没有则 0。 */
  readonly retryAfterMs: number;

  constructor(status: number, body: string, retryAfterMs = 0) {
    super(status > 0 ? `provider_error: HTTP ${status} ${body}` : `provider_error: ${body}`);
    this.name = "LlmHttpError";
    this.status = status;
    this.body = body;
    this.retryAfterMs = retryAfterMs;
  }
}

/** 路由层尝试一个候选后的留痕（成功/失败/为什么换走）。由 streamChatRouted 发出。 */
export interface RouteAttempt {
  profileId: string;
  profileLabel: string;
  model: string;
  ok: boolean;
  kind?: string;
  status?: number;
  restedMs?: number;
  error?: string;
  hop: number;
  usage?: UsageTotals;
}

/** 解析 Retry-After：秒数或 HTTP 日期。 */
export function retryAfterMs(header: string | null, now = Date.now()): number {
  if (!header) return 0;
  const secs = Number(header);
  if (Number.isFinite(secs) && header.trim() !== "") return Math.max(0, secs * 1000);
  const at = Date.parse(header);
  return Number.isNaN(at) ? 0 : Math.max(0, at - now);
}

/**
 * 由 profile 构造网关请求——URL/头/body 的单一出处。
 * 红线：目标地址只来自 profile.baseUrl（现在恒为 magpie 网关/反代），Key 只进此请求头。
 */
export function buildRequest(
  profile: LlmProfile,
  messages: ChatMessage[],
  opts: BuildRequestOpts,
): { url: string; headers: Record<string, string>; body: string } {
  // Key 红线守卫：baseUrl 缺 scheme 会拼出相对路径，浏览器会把带 Key 的请求发往自有域
  if (profile.baseUrl && !/^https?:\/\//.test(profile.baseUrl)) {
    throw new Error("baseUrl 必须以 http:// 或 https:// 开头");
  }
  const base = profile.baseUrl || "https://api.openai.com/v1";
  return {
    url: `${base.replace(/\/$/, "")}/chat/completions`,
    headers: { "content-type": "application/json", authorization: `Bearer ${profile.apiKey}` },
    body: JSON.stringify({
      model: profile.model,
      stream: opts.stream,
      temperature: profile.temperature,
      // 显式给 max_tokens：不给的话由网关/上游按自己的默认值决定，历史预算
      // （agentContext/budget.ts）就无从计算——「历史 6000 token + 输出未知」等于没有预算。
      // 优先级：档案手填 > 模型能力表的 maxOutput（未知模型回落 DEFAULT_CAPABILITY）。
      ...(() => {
        const maxTokens = profile.maxTokens ?? resolveCapability(profile).maxOutput;
        return maxTokens > 0 ? { max_tokens: maxTokens } : {};
      })(),
      messages: messages.map(({ contentParts, ...m }) => ({
        ...m,
        content: contentParts ? toOpenAiContent(contentParts) : m.content,
      })),
      ...(opts.tools?.length ? { tools: opts.tools, tool_choice: "auto" } : {}),
      ...(opts.stream && opts.includeUsage !== false
        ? { stream_options: { include_usage: true } }
        : {}),
    }),
  };
}

/**
 * 200 里携带的错误（magpie `carriedStatus`）：不少网关把过载/限流/额度耗尽写成
 * `{"error":{…}}` 配 HTTP 200 发出。认不出状态的一律按 502 失败。
 */
export function carriedError(raw: unknown): LlmHttpError | null {
  if (!raw || typeof raw !== "object") return null;
  const body = raw as { error?: unknown; type?: string };
  if (body.error == null && body.type !== "error") return null;
  const text = JSON.stringify(body.error ?? body).slice(0, 300);
  const code =
    (body.error as { code?: unknown; status?: unknown } | undefined)?.code ??
    (body.error as { status?: unknown } | undefined)?.status;
  const fromCode = typeof code === "number" && code >= 400 ? code : 0;
  const fromWords = carriedStatus(200, text);
  return new LlmHttpError(fromCode || (fromWords >= 400 ? fromWords : 502), text);
}

/** 非流式 1-token 冒烟（连接/网关自检用）。永不抛出。 */
export async function testConnection(
  profile: LlmProfile,
): Promise<{ ok: boolean; error?: string }> {
  let req: { url: string; headers: Record<string, string>; body: string };
  try {
    req = buildRequest(profile, [{ role: "user", content: "ping" }], { stream: false });
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  try {
    const res = await fetch(req.url, { method: "POST", headers: req.headers, body: req.body });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, error: `HTTP ${res.status} ${text.slice(0, 200)}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** streamChat 的 opts。 */
export interface StreamChatOpts {
  signal: AbortSignal;
  onDelta: (text: string) => void;
  /** 工具声明（OpenAI 格式）；为空则请求体与旧版一致。 */
  tools?: unknown[];
  /** 本轮结束时的工具调用（delta.tool_calls 逐片拼装后回调）。 */
  onToolCalls?: (calls: ToolCall[]) => void;
  /** 思考过程增量（`reasoning_content` / `reasoning`）。不支持时不会回调。 */
  onReasoning?: (text: string) => void;
  /** 本轮供应商上报的用量：结束时恰好回调一次；拿不到就不回调。 */
  onUsage?: (u: UsageTotals) => void;
  /** 本轮 `finish_reason`（stop / length / tool_calls …）：结束时回调一次；拿不到就不回调。 */
  onFinish?: (reason: string) => void;
  /** 逐候选留痕：只有 `streamChatRouted` 会读它。 */
  onAttempt?: (a: RouteAttempt) => void;
}

/**
 * 流式对话：URL/头/body 出自 buildRequest（Key 红线不旁路）。
 * - 流式：`data:` 行 choices[0].delta；`[DONE]` 结束；
 * - 非流式（content-type 不含 event-stream）：整段 json 单次 onDelta；
 * - AbortSignal 中止 → DOMException("AbortError")；网络/HTTP 错 → LlmHttpError。
 * 返回值 = 全文累积。
 */
export async function streamChat(
  profile: LlmProfile,
  messages: ChatMessage[],
  opts: StreamChatOpts,
): Promise<string> {
  /** 出站脱敏（d.48）：换的只是发出去的那份副本。 */
  const outbound = profile.mask ? maskMessages(messages).messages : messages;

  /** 400 降级链：关 `stream_options` 重试一次（部分兼容网关不认这个参数）。 */
  const attempts: { includeUsage?: boolean }[] = [{}, { includeUsage: false }];
  const build = (attempt: { includeUsage?: boolean } = {}) =>
    buildRequest(profile, outbound, {
      stream: true,
      tools: opts.tools,
      includeUsage: attempt.includeUsage !== false,
    });
  let req = build();

  const toAbortError = () => new DOMException("AbortError", "AbortError");
  const toProviderError = (e: unknown) =>
    e instanceof LlmHttpError ? e : new LlmHttpError(0, e instanceof Error ? e.message : String(e));

  const readUsage = (raw: unknown): UsageTotals | null => {
    if (!raw || typeof raw !== "object") return null;
    const r = raw as {
      prompt_tokens?: unknown;
      completion_tokens?: unknown;
      total_tokens?: unknown;
    };
    const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
    const u: UsageTotals = {
      inputTokens: num(r.prompt_tokens),
      outputTokens: num(r.completion_tokens),
      totalTokens: num(r.total_tokens),
    };
    return u.inputTokens !== undefined || u.outputTokens !== undefined || u.totalTokens !== undefined
      ? u
      : null;
  };
  const usage: UsageTotals = {};
  const mergeUsage = (raw: unknown): void => {
    const u = readUsage(raw);
    if (!u) return;
    if (u.inputTokens !== undefined) usage.inputTokens = u.inputTokens;
    if (u.outputTokens !== undefined) usage.outputTokens = u.outputTokens;
    if (u.totalTokens !== undefined) usage.totalTokens = u.totalTokens;
  };
  const emitUsage = (): void => {
    if (opts.onUsage && Object.keys(usage).length > 0) opts.onUsage({ ...usage });
  };

  const toolCalls = new Map<number, { id: string; name: string; args: string }>();
  /**
   * 本轮的 `finish_reason`（OpenAI 兼容：stop / length / tool_calls …）。
   *
   * 为什么要记：`length` 表示输出被 max_tokens 截断，此时流里拼出来的工具参数可能是
   * 半截 JSON。以前没人读这个字段，于是「参数被截断」会一路走到执行层，变成一条
   * 「工具调用失败：Unexpected end of JSON input」——用户只看到工具乱报错，
   * 不知道其实是输出预算不够。现在按它把不可执行的调用丢掉并回报截断。
   */
  let finishReason: string | null = null;
  /**
   * 拼接一个逐片下发的字段（函数名）。
   *
   * OpenAI 的规范是「名字只在首片出现、后续片只带 arguments」，但兼容网关的实现五花八门：
   * 有的每片都重发**全名**，有的发**累积值**（"ec" → "echo"），有的只发真分片（"ec"+"ho"）。
   * 单纯的 `+=` 在「每片重发全名」的供应商上会把名字拼成 `echoecho`——工具名对不上，
   * 整轮工具调用直接失败（模型说「我查一下」，用户什么也看不到）。
   */
  const joinName = (base: string, piece: string): string => {
    if (!piece) return base;
    if (!base) return piece;
    if (piece === base || base.startsWith(piece) || base.endsWith(piece)) return base;
    if (piece.startsWith(base)) return piece; // 累积式重发
    return base + piece; // 真·分片
  };
  /**
   * 拼接参数分片：兼容「累积式重发」（每片带完整 JSON 前缀）。
   *
   * 正常分片 `{"a"` + `:1}` 走追加；`{"a":1}` 这种「前一版是当前版前缀」的，
   * 说明供应商重发了完整参数，取新的那份，否则会拼出非法 JSON。
   */
  const joinArgs = (base: string, piece: string): string => {
    if (!piece) return base;
    if (!base) return piece;
    if (piece.startsWith(base)) return piece;
    return base + piece;
  };
  const collectToolCalls = (list: unknown) => {
    if (!Array.isArray(list)) return;
    for (const raw of list) {
      if (!raw || typeof raw !== "object") continue;
      const c = raw as {
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      };
      const id = typeof c.id === "string" ? c.id : "";
      /**
       * index 缺失时的归属（OpenAI 规范要求 index，但部分网关不发）：
       * - 带着**新 id** → 新的一次调用（新下标）；
       * - 没有 id（纯参数分片）→ 归到当前最后一调用，否则分片会各建一条坏调用。
       */
      let index: number;
      if (typeof c.index === "number") {
        index = c.index;
      } else if (id && ![...toolCalls.values()].some((v) => v.id === id)) {
        index = toolCalls.size ? Math.max(...toolCalls.keys()) + 1 : 0;
      } else {
        index = toolCalls.size ? Math.max(...toolCalls.keys()) : 0;
      }
      const cur = toolCalls.get(index) ?? { id: "", name: "", args: "" };
      if (id) cur.id = id;
      cur.name = joinName(cur.name, c.function?.name ?? "");
      cur.args = joinArgs(cur.args, c.function?.arguments ?? "");
      toolCalls.set(index, cur);
    }
  };
  /**
   * 参数是否是一个完整的 JSON 对象。
   *
   * 只在 `finish_reason === "length"`（输出被截断）时用来挡掉半截参数；正常结束时
   * 不查——部分兼容网关会发非 JSON 的参数（例如 "null"），交给执行层报错更诚实。
   */
  const isCompleteArgs = (args: string): boolean => {
    if (!args.trim()) return true;
    try {
      const parsed: unknown = JSON.parse(args);
      return typeof parsed === "object" && parsed !== null;
    } catch {
      return false;
    }
  };
  const flushToolCalls = () => {
    if (!toolCalls.size) return;
    const truncated = finishReason === "length";
    const calls: ToolCall[] = [...toolCalls.entries()]
      .sort((a, b) => a[0] - b[0])
      .filter(([, v]) => v.name)
      // 被截断时，参数拼不成完整对象的调用不能交给执行层：它只会变成一条
      // 「Unexpected end of JSON input」的假失败，掩盖真正的原因（输出预算不够）。
      .filter(([, v]) => !truncated || isCompleteArgs(v.args))
      .map(([, v]) => ({
        id: v.id || `call_${Math.random().toString(36).slice(2, 10)}`,
        type: "function" as const,
        function: { name: v.name, arguments: v.args },
      }));
    if (calls.length) opts.onToolCalls?.(calls);
  };

  const doFetch = async (r: typeof req): Promise<Response> => {
    try {
      return await fetch(r.url, {
        method: "POST",
        headers: r.headers,
        body: r.body,
        signal: opts.signal,
      });
    } catch (e) {
      if (opts.signal.aborted || (e as { name?: string })?.name === "AbortError") throw toAbortError();
      throw toProviderError(e);
    }
  };

  let res = await doFetch(req);
  for (let i = 1; i < attempts.length && !res.ok && res.status === 400; i++) {
    const next = build(attempts[i]!);
    // 降级档与上一次请求逐字相同（本来就没带 stream_options）⇒ 不发，免得假装重试过。
    if (next.body === req.body) continue;
    req = next;
    res = await doFetch(req);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new LlmHttpError(res.status, text.slice(0, 300), retryAfterMs(res.headers.get("retry-after")));
  }

  const ctype = res.headers.get("content-type") ?? "";
  if (!ctype.includes("event-stream")) {
    // 非流式兼容：供应商未跟随 stream 开关（如本地代理），整段读出单次回调
    let json: {
      choices?: {
        message?: {
          content?: string;
          tool_calls?: unknown;
          reasoning_content?: string;
          reasoning?: string;
        };
        finish_reason?: string;
      }[];
      usage?: unknown;
    };
    try {
      json = (await res.json()) as typeof json;
    } catch (e) {
      if (opts.signal.aborted) throw toAbortError();
      throw toProviderError(e);
    }
    const carried = carriedError(json);
    if (carried) throw carried;
    const finish = json.choices?.[0]?.finish_reason;
    if (typeof finish === "string" && finish) finishReason = finish;
    const text = json.choices?.[0]?.message?.content ?? "";
    collectToolCalls(json.choices?.[0]?.message?.tool_calls);
    flushToolCalls();
    if (finishReason) opts.onFinish?.(finishReason);
    const reasoning = json.choices?.[0]?.message?.reasoning_content ?? json.choices?.[0]?.message?.reasoning;
    if (reasoning) opts.onReasoning?.(reasoning);
    if (text) {
      // 整段可能远超单帧上限：按 ≤3000 字符切片回调，保证每帧合法
      for (let i = 0; i < text.length; i += 3000) opts.onDelta(text.slice(i, i + 3000));
    }
    mergeUsage(json.usage);
    emitUsage();
    return text;
  }

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let acc = "";
  const handleLine = (line: string) => {
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trim();
    if (data === "[DONE]") return;
    let delta = "";
    let carried: LlmHttpError | null = null;
    try {
      const parsed = JSON.parse(data) as {
        choices?: {
          delta?: {
            content?: string;
            tool_calls?: unknown;
            reasoning_content?: string;
            reasoning?: string;
          };
          finish_reason?: string;
        }[];
        usage?: unknown;
        error?: unknown;
      };
      mergeUsage(parsed.usage);
      carried = carriedError(parsed);
      const finish = parsed.choices?.[0]?.finish_reason;
      if (typeof finish === "string" && finish) finishReason = finish;
      collectToolCalls(parsed.choices?.[0]?.delta?.tool_calls);
      const reasoningDelta =
        parsed.choices?.[0]?.delta?.reasoning_content ?? parsed.choices?.[0]?.delta?.reasoning;
      if (reasoningDelta) opts.onReasoning?.(reasoningDelta);
      delta = parsed.choices?.[0]?.delta?.content ?? "";
    } catch {
      /* 非 JSON 心跳行忽略 */
    }
    if (carried) throw carried;
    if (delta) {
      acc += delta;
      opts.onDelta(delta);
    }
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim() === "") continue;
        handleLine(line);
      }
    }
    if (buffer.trim()) handleLine(buffer.trim());
    flushToolCalls();
    if (finishReason) opts.onFinish?.(finishReason);
    emitUsage();
  } catch (e) {
    if (opts.signal.aborted || (e as { name?: string })?.name === "AbortError") throw toAbortError();
    throw toProviderError(e);
  }
  return acc;
}
