import type { LlmProfile } from "../store/llm.js";
import { carriedStatus } from "./llmFailure.js";
import {
  readAnthropicContent,
  toAnthropicMessages,
  toAnthropicSystemBlocks,
  toAnthropicSystemText,
  toAnthropicTools,
  type TextBlock,
} from "./llmAnthropic.js";
import { planCache } from "./promptCache.js";
import { maskMessages } from "./llmMask.js";

/** 模型发起的一次工具调用（OpenAI 兼容格式）。 */
export interface ToolCall {
  id: string;
  type?: "function";
  function: { name: string; arguments: string };
}

/**
 * 多模态消息的一段内容。图片统一存 base64（不带 `data:` 前缀），
 * 由两个供应商分支各自组装成对方要的形状——`data:` URL 只属于 OpenAI。
 */
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image"; mime: string; data: string };

export type MessageContent = string | ContentPart[];

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /**
   * 多模态内容片（图片等）。存在时**覆盖** `content` 作为发给供应商的内容，
   * `content` 仍保留纯文本——上下文预算、摘要、日志都按字符串处理，
   * 不必为了图片把整条链路改成联合类型。
   */
  contentParts?: ContentPart[];
  /** assistant 消息里带的工具调用（回灌历史时原样带回，模型才知道自己调过什么）。 */
  tool_calls?: ToolCall[];
  /** role=tool 时对应哪次调用。 */
  tool_call_id?: string;
  /** role=tool 时的工具名（部分供应商要求）。 */
  name?: string;
  /**
   * role=tool 时标记这次调用**没有成功**（含 HITL 拒绝）。
   * 只给 Anthropic 用：那边映射成 `tool_result.is_error`，OpenAI 分支不读它——
   * 拒绝/失败的语义因此不必靠文案去猜。
   */
  toolError?: boolean;
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
  /** anthropic 的 max_tokens 覆盖（openai 分支忽略，保持最小 body） */
  maxTokens?: number;
  /**
   * 工具声明（OpenAI 格式的 `{type:"function",...}` 数组）。
   * anthropic 分支由 `lib/llmAnthropic` 转成 Anthropic 的 `tools` + content blocks
   * （字段名 `input_schema`，形状不同）；为空/未传时请求体与旧版完全一致。
   */
  tools?: unknown[];
  /**
   * OpenAI 流式请求是否带 `stream_options: {include_usage:true}`（尾包才会回 usage）。
   * 缺省带；显式 false 不带——部分第三方兼容网关不认这个参数会 400，
   * streamChat 据此在 400 时关掉它重试一次。Anthropic 分支始终不加（它本来就带 usage）。
   */
  includeUsage?: boolean;
  /**
   * anthropic 前缀缓存：`"auto"` 才打 `cache_control` 断点；缺省/`"off"` 时请求体
   * 与不打标记逐字一致——所以 `testConnection` 这类单次冒烟不开它，回滚也只需要
   * 这一个开关（真正的对话路径由 streamChat 缺省为 `"auto"`）。OpenAI 分支不读它。
   */
  promptCache?: "off" | "auto";
  /** 内部用（400 降级）：这一次尝试**不发** tools。 */
  omitTools?: boolean;
}

/** 一次请求里供应商上报的用量（拿不到字段就留 undefined，绝不补 0）。 */
export interface UsageTotals {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  /**
   * 前缀缓存**命中读取**的 token（Anthropic 的 `cache_read_input_tokens`）。
   * 必须单独留着：低于模型的最低可缓存长度时供应商**静默不缓存、不报错**，
   * 只能靠这个数字是 0 还是有值来分辨「省了钱」和「根本没生效」。
   */
  cacheReadTokens?: number;
  /** 写入缓存的 token（Anthropic 的 `cache_creation_input_tokens`，按 1.25× 计费）。 */
  cacheWriteTokens?: number;
}

/**
 * 带状态码的供应商错误。
 *
 * 存在的理由：路由层要按「为什么失败」决定换不换候选、冷却多久（见 lib/llmFailure.ts），
 * 而 `Error.message` 里的 `HTTP 429` 只能靠正则捞——那不是判据，是猜。
 * 消息文本与旧版逐字相同（`provider_error: HTTP <status> <body>`），
 * 所以既有调用方与断言不受影响；status=0 表示传输层就没通（网络/DNS/被拦）。
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
  /** 失败时的分类（lib/llmFailure）。 */
  kind?: string;
  /** 失败时供应商状态码；0 = 传输层失败。 */
  status?: number;
  /** 该候选被冷却了多久（毫秒），未冷却为 0。 */
  restedMs?: number;
  /** 错误摘要（界面与 console 用）。 */
  error?: string;
  /** 第几跳（0 起）。 */
  hop: number;
  /**
   * 成功时**这一次调用**上报的用量（工具循环会有多条，各自独立）。
   * 供应商没上报就留 undefined——「没上报」与「上报了 0」是两件事。
   */
  usage?: UsageTotals;
}

/** 解析 Retry-After：秒数或 HTTP 日期（magpie `retryAfter`，gw-routing.go:1857）。 */
export function retryAfterMs(header: string | null, now = Date.now()): number {
  if (!header) return 0;
  const secs = Number(header);
  if (Number.isFinite(secs) && header.trim() !== "") return Math.max(0, secs * 1000);
  const at = Date.parse(header);
  return Number.isNaN(at) ? 0 : Math.max(0, at - now);
}

/**
 * 由 profile 构造供应商请求——URL/头/body 的单一出处（testConnection 与
 * Task 5 的 streamChat 共用）。红线：目标域名只来自 profile.baseUrl
 * （缺省=官方端点），绝不拼向和鸣自有服务端；Key 只进此请求头。
 */
export function buildRequest(
  profile: LlmProfile,
  messages: ChatMessage[],
  opts: BuildRequestOpts,
): { url: string; headers: Record<string, string>; body: string } {
  // Key 红线守卫：baseUrl 缺 scheme 会拼出相对路径，浏览器将带 Key 的请求发往自有域
  if (profile.baseUrl && !/^https?:\/\//.test(profile.baseUrl)) {
    throw new Error("baseUrl 必须以 http:// 或 https:// 开头");
  }
  if (profile.provider === "anthropic") {
    const base = profile.baseUrl || "https://api.anthropic.com";
    const tools = opts.omitTools ? [] : toAnthropicTools(opts.tools);
    const { messages: blocks, transactionEnds } = toAnthropicMessages(messages);
    const systemText = toAnthropicSystemText(messages);
    let system: string | TextBlock[] | undefined = systemText;
    if (opts.promptCache === "auto") {
      // 只有存在「会被重用的前缀」时才打标记：单次请求打标记等于白付 1.25× 写入费
      const systemBlocks = toAnthropicSystemBlocks(messages);
      if (systemBlocks.length > 0 || tools.length > 0 || transactionEnds.length > 0) {
        planCache({ systemBlocks, messages: blocks, tools, transactionEnds });
      }
      // cache_control 必须挂在 block 上，字符串形态无法携带 ⇒ 缓存开时转数组
      system = systemBlocks.length > 0 ? systemBlocks : systemText;
    }
    return {
      url: `${base.replace(/\/$/, "")}/v1/messages`,
      headers: {
        "content-type": "application/json",
        "x-api-key": profile.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: profile.model,
        // 带工具时抬到 2048：`input_json_delta` 也计入输出，1024 会把长参数截成半个 JSON
        max_tokens: opts.maxTokens ?? (tools.length > 0 ? 2048 : 1024),
        stream: opts.stream,
        temperature: profile.temperature,
        system,
        messages: blocks,
        // 不发 tool_choice：Anthropic 的缺省就是 auto，多一个字段只是多一个兼容面
        ...(tools.length > 0 ? { tools } : {}),
      }),
    };
  }
  const base = profile.baseUrl || "https://api.openai.com/v1";
  return {
    url: `${base.replace(/\/$/, "")}/chat/completions`,
    headers: { "content-type": "application/json", authorization: `Bearer ${profile.apiKey}` },
    body: JSON.stringify({
      model: profile.model,
      stream: opts.stream,
      temperature: profile.temperature,
      // 字符串内容原样保留（老路径逐字不变）；只有多模态内容片才转成 image_url 片。
      messages: messages.map(({ contentParts, ...m }) => ({
        ...m,
        content: contentParts ? toOpenAiContent(contentParts) : m.content,
      })),
      // 工具调用只对 OpenAI 兼容协议开放（anthropic 的消息结构不同，另行适配）
      ...(opts.tools?.length ? { tools: opts.tools, tool_choice: "auto" } : {}),
      // 流式默认要 usage（尾包才给）；includeUsage=false 时整段不出现——
      // 某些兼容网关不认这个参数会直接 400，缺省值因此必须是「带」而不是「不带」。
      ...(opts.stream && opts.includeUsage !== false
        ? { stream_options: { include_usage: true } }
        : {}),
    }),
  };
}

/**
 * 200 里携带的错误（magpie `carriedStatus`，gw-routing.go:455-468）。
 *
 * 为什么必须读它：不少网关把过载、限流、额度耗尽写成 `{"error":{…}}` 配 HTTP 200 发出。
 * 按 200 读，OpenAI 的 "Rate limit reached" 就成了成功，流安静地结束、
 * 回复少半截而无人知道（Heming 此前的行为正是如此）。认不出状态的一律按 502 失败
 * （magpie 的 `didNotStream`/`errEndedShort` 同此）。
 */
export function carriedError(raw: unknown): LlmHttpError | null {
  if (!raw || typeof raw !== "object") return null;
  const body = raw as { error?: unknown; type?: string };
  if (body.error == null && body.type !== "error") return null;
  const text = JSON.stringify(body.error ?? body).slice(0, 300);
  const code = (body.error as { code?: unknown; status?: unknown } | undefined)?.code ??
    (body.error as { status?: unknown } | undefined)?.status;
  const fromCode = typeof code === "number" && code >= 400 ? code : 0;
  const fromWords = carriedStatus(200, text);
  return new LlmHttpError(fromCode || (fromWords >= 400 ? fromWords : 502), text);
}

/** 非流式 1-token 冒烟：anthropic max_tokens:1，openai 走最小 body。永不抛出。 */
export async function testConnection(
  profile: LlmProfile,
): Promise<{ ok: boolean; error?: string }> {
  let req: { url: string; headers: Record<string, string>; body: string };
  try {
    req = buildRequest(profile, [{ role: "user", content: "ping" }], {
      stream: false,
      maxTokens: 1,
    });
  } catch (e) {
    return { ok: false, error: (e as Error).message }; // 如缺 scheme 的 baseUrl 守卫
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

/** streamChat 的 opts：中止信号 + 逐段回调（调用方据 signal 中止转 finish-partial）。 */
export interface StreamChatOpts {
  signal: AbortSignal;
  onDelta: (text: string) => void;
  /** anthropic max_tokens 覆盖（openai 分支忽略） */
  maxTokens?: number;
  /** 工具声明（OpenAI 格式）；为空则请求体与旧版一致。 */
  tools?: unknown[];
  /**
   * 本轮结束时的工具调用（OpenAI 的 delta.tool_calls 逐片拼装后回调整）。
   * 不传 = 不需要工具能力，行为与旧版完全一致。
   */
  onToolCalls?: (calls: ToolCall[]) => void;
  /**
   * 思考过程增量（reasoning/thinking）：DeepSeek 的 `reasoning_content`、
   * 部分网关的 `reasoning`、Anthropic 的 `thinking_delta`。不支持时不会回调。
   */
  onReasoning?: (text: string) => void;
  /**
   * 本轮供应商上报的用量：流内多处下发时（Anthropic 的 message_start/message_delta）
   * 先合并，结束时**恰好回调一次**。拿不到就**不回调**（不回调 0——0 是「真的用了 0」，
   * 与「没上报」是两件事，界面必须能区分）。
   */
  onUsage?: (u: UsageTotals) => void;
  /**
   * 逐候选留痕（见 lib/llmRoute.ts）：**只有 `streamChatRouted` 会读它**，
   * `streamChat` 本身从不回调，所以单候选路径与旧版逐字等价。
   */
  onAttempt?: (a: RouteAttempt) => void;
  /** anthropic 前缀缓存开关（缺省 `"auto"`）；openai 分支不读。 */
  promptCache?: "off" | "auto";
}

/**
 * 双协议 SSE 流式对话：URL/头/body 仍出自 buildRequest（Key 红线不旁路）。
 * - openai：`data:` 行 choices[0].delta.content，`[DONE]` 结束；
 * - anthropic：`data:` 行 delta.text（event 行仅作前缀，按 provider 取字段）；
 * - 非流式（content-type 不含 event-stream）：整段 json 单次 onDelta；
 * - AbortSignal 中止 → DOMException("AbortError")；网络/HTTP 错 → Error("provider_error: ...")。
 * 返回值 = 全文累积。
 */
export async function streamChat(
  profile: LlmProfile,
  messages: ChatMessage[],
  opts: StreamChatOpts,
): Promise<string> {
  // 同步抛出（如缺 scheme 的 baseUrl 守卫）自然向上传播，不转 provider_error
  /**
   * 出站脱敏（d.48）：换的只是**发出去的那份副本**——调用方手里的 messages 仍是原文
   * （本机历史、E2E 明文、上下文预算都靠它）。没开就是同一个引用，零开销。
   */
  const outbound = profile.mask ? maskMessages(messages).messages : messages;
  /** 一次尝试的请求变体（降级用；缺省=完整形状）。 */
  interface Attempt {
    includeUsage?: boolean;
    cache?: boolean;
    withTools?: boolean;
  }
  const build = (a: Attempt = {}) =>
    buildRequest(profile, outbound, {
      stream: true,
      maxTokens: opts.maxTokens,
      tools: opts.tools,
      includeUsage: a.includeUsage !== false,
      promptCache: a.cache === false ? "off" : (opts.promptCache ?? "auto"),
      omitTools: a.withTools === false,
    });
  /**
   * 400 降级链（方案 §2.1 的扩展）：**每一步只重试一次**，最后一步仍失败就抛它——
   * 不掩盖真实问题、不无限重试。
   * - openai：关 `stream_options`（部分第三方兼容网关不认这个参数）
   * - anthropic：先剥 `cache_control`，再去掉 `tools`（兼容端点常不认这两个）
   */
  const hasTools = !!opts.tools?.length;
  const attempts: Attempt[] =
    profile.provider === "anthropic"
      ? [
          {},
          ...(opts.promptCache !== "off" ? [{ cache: false as const }] : []),
          ...(hasTools ? [{ cache: false as const, withTools: false as const }] : []),
        ]
      : [{}, { includeUsage: false as const }];
  let req = build();

  const toAbortError = () => new DOMException("AbortError", "AbortError");
  const toProviderError = (e: unknown) =>
    e instanceof LlmHttpError ? e : new LlmHttpError(0, e instanceof Error ? e.message : String(e));

  /**
   * 供应商 usage → 统一口径（OpenAI 的 prompt/completion、Anthropic 的 input/output）。
   * 只认数字字段：全空返回 null（= 这个包没上报），绝不用 0 冒充。
   */
  const readUsage = (raw: unknown): UsageTotals | null => {
    if (!raw || typeof raw !== "object") return null;
    const r = raw as {
      prompt_tokens?: unknown;
      completion_tokens?: unknown;
      total_tokens?: unknown;
      input_tokens?: unknown;
      output_tokens?: unknown;
      cache_read_input_tokens?: unknown;
      cache_creation_input_tokens?: unknown;
    };
    const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
    const u: UsageTotals = {
      inputTokens: num(r.prompt_tokens) ?? num(r.input_tokens),
      outputTokens: num(r.completion_tokens) ?? num(r.output_tokens),
      totalTokens: num(r.total_tokens),
      cacheReadTokens: num(r.cache_read_input_tokens),
      cacheWriteTokens: num(r.cache_creation_input_tokens),
    };
    return u.inputTokens !== undefined ||
      u.outputTokens !== undefined ||
      u.totalTokens !== undefined ||
      u.cacheReadTokens !== undefined ||
      u.cacheWriteTokens !== undefined
      ? u
      : null;
  };
  /** 流内多处 usage 合并（Anthropic 的 output_tokens 是累计值 ⇒ 后到的覆盖先到的）。 */
  const usage: UsageTotals = {};
  const mergeUsage = (raw: unknown): void => {
    const u = readUsage(raw);
    if (!u) return;
    if (u.inputTokens !== undefined) usage.inputTokens = u.inputTokens;
    if (u.outputTokens !== undefined) usage.outputTokens = u.outputTokens;
    if (u.totalTokens !== undefined) usage.totalTokens = u.totalTokens;
    if (u.cacheReadTokens !== undefined) usage.cacheReadTokens = u.cacheReadTokens;
    if (u.cacheWriteTokens !== undefined) usage.cacheWriteTokens = u.cacheWriteTokens;
  };
  /** 本轮是否拿到过 usage；结束时恰好回调一次（Anthropic 两个事件合并后）。 */
  const emitUsage = (): void => {
    if (opts.onUsage && Object.keys(usage).length > 0) opts.onUsage({ ...usage });
  };

  /** 工具调用累加：OpenAI 按 index 分片下发（id/name 只在首片，arguments 分多片）。 */
  const toolCalls = new Map<number, { id: string; name: string; args: string }>();
  const collectToolCalls = (list: unknown) => {
    if (!Array.isArray(list)) return;
    for (const raw of list) {
      if (!raw || typeof raw !== "object") continue;
      const c = raw as {
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      };
      const index = typeof c.index === "number" ? c.index : toolCalls.size;
      const cur = toolCalls.get(index) ?? { id: "", name: "", args: "" };
      if (typeof c.id === "string" && c.id) cur.id = c.id;
      if (typeof c.function?.name === "string" && c.function.name) cur.name += c.function.name;
      if (typeof c.function?.arguments === "string") cur.args += c.function.arguments;
      toolCalls.set(index, cur);
    }
  };
  const flushToolCalls = () => {
    if (!toolCalls.size) return;
    const calls: ToolCall[] = [...toolCalls.entries()]
      .sort((a, b) => a[0] - b[0])
      .filter(([, v]) => v.name)
      .map(([, v]) => ({
        id: v.id || `call_${Math.random().toString(36).slice(2, 10)}`,
        type: "function" as const,
        function: { name: v.name, arguments: v.args },
      }));
    if (calls.length) opts.onToolCalls?.(calls);
  };

  /**
   * Anthropic 的工具调用按 block 下发：`content_block_start`（type=tool_use）给 id 与 name，
   * 一串 `content_block_delta`（type=input_json_delta）给 `partial_json`，`content_block_stop` 收尾。
   *
   * ★ 复用同一个 `toolCalls` 槽位表（按 index 分槽）：一次响应只会是一种协议形状，
   * 两者不会同时来；复用意味着 `flushToolCalls` 的「恰好一次」与排序口径一字未动。
   */
  const collectAnthropicBlock = (parsed: {
    type?: string;
    index?: number;
    content_block?: { type?: string; id?: string; name?: string };
    delta?: { type?: string; partial_json?: string };
  }) => {
    if (typeof parsed.index !== "number") return;
    if (parsed.type === "content_block_start" && parsed.content_block?.type === "tool_use") {
      toolCalls.set(parsed.index, {
        id: parsed.content_block.id ?? "",
        name: parsed.content_block.name ?? "",
        args: "",
      });
      return;
    }
    if (parsed.type === "content_block_delta" && parsed.delta?.type === "input_json_delta") {
      const cur = toolCalls.get(parsed.index) ?? { id: "", name: "", args: "" };
      cur.args += parsed.delta.partial_json ?? "";
      toolCalls.set(parsed.index, cur);
    }
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
  // 只在 400 上降级：其余状态（429/5xx/401）交给路由层判断，换 body 没有意义。
  for (let i = 1; i < attempts.length && !res.ok && res.status === 400; i++) {
    const attempt = attempts[i]!;
    const next = build(attempt);
    // 降级档与上一次请求逐字相同（这个请求本来就没带 cache_control / tools）⇒ 不发：
    // 重复请求只会让人以为「重试过」，实际什么都没变。
    if (next.body === req.body) continue;
    // 丢掉 tools 是「智能体突然不会查资料」级别的行为变化，必须留痕；剥标记只是省钱手段。
    if (attempt.withTools === false) console.warn("供应商拒绝 tools 请求，本次已降级为不带工具调用");
    req = next;
    res = await doFetch(req);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    // 状态码与 Retry-After 随错误一起走：路由层据此决定换不换、冷却多久
    throw new LlmHttpError(
      res.status,
      text.slice(0, 300),
      retryAfterMs(res.headers.get("retry-after")),
    );
  }

  const ctype = res.headers.get("content-type") ?? "";
  if (!ctype.includes("event-stream")) {
    // 非流式兼容：供应商未跟随 stream 开关（如本地代理），整段读出单次回调
    let json: {
      choices?: {
        message?: { content?: string; tool_calls?: unknown; reasoning_content?: string; reasoning?: string };
      }[];
      /** Anthropic 的 content 是 block 数组（text / tool_use / thinking 混着），不是单段文本 */
      content?: unknown;
      usage?: unknown;
    };
    try {
      json = (await res.json()) as typeof json;
    } catch (e) {
      if (opts.signal.aborted) throw toAbortError();
      throw toProviderError(e);
    }
    // 200 携带的错误先于「读不到内容」判定：它带着自己的真实状态
    const carried = carriedError(json);
    if (carried) throw carried;
    const anth = profile.provider === "anthropic" ? readAnthropicContent(json.content) : null;
    // Anthropic 的正文可能分散在多个 text block（还混着 thinking/tool_use），必须全量取
    const text = anth ? anth.text : (json.choices?.[0]?.message?.content ?? "");
    collectToolCalls(json.choices?.[0]?.message?.tool_calls);
    if (anth && anth.calls.length) collectToolCalls(anth.calls);
    flushToolCalls();
    const reasoning = json.choices?.[0]?.message?.reasoning_content ?? json.choices?.[0]?.message?.reasoning;
    if (reasoning) opts.onReasoning?.(reasoning);
    if (text) {
      // 非流式兼容：整段可能远超 agent_chunk 单帧上限（shared max(4000)）——
      // 按 ≤3000 字符切片循环回调，既保证每帧合法、也不至于每片都顶格
      for (let i = 0; i < text.length; i += 3000) opts.onDelta(text.slice(i, i + 3000));
    }
    // 非流式兼容分支：usage 直接在整段 json 上
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
          delta?: { content?: string; tool_calls?: unknown; reasoning_content?: string; reasoning?: string };
        }[];
        delta?: { text?: string; thinking?: string; type?: string; partial_json?: string };
        /** Anthropic 事件类型与块序号（content_block_start / content_block_delta / message_delta…） */
        type?: string;
        index?: number;
        content_block?: { type?: string; id?: string; name?: string };
        /** OpenAI 尾包（choices 可能为空）的 usage */
        usage?: unknown;
        /** Anthropic message_start 的 message.usage（input_tokens 在这里） */
        message?: { usage?: unknown };
        /** 200 里携带的错误（Anthropic 的 error 事件、网关的 {"error":{…}}） */
        error?: unknown;
      };
      // usage 可能分多处下发（Anthropic message_start 给 input、message_delta 给 output）
      mergeUsage(parsed.usage ?? parsed.message?.usage);
      carried = carriedError(parsed);
      collectToolCalls(parsed.choices?.[0]?.delta?.tool_calls);
      collectAnthropicBlock(parsed);
      // 思考过程：不同供应商字段不同，统一喂给 onReasoning（不参与正文累积）
      const reasoningDelta =
        parsed.choices?.[0]?.delta?.reasoning_content ??
        parsed.choices?.[0]?.delta?.reasoning ??
        (parsed.delta?.type === "thinking_delta" ? parsed.delta.thinking : undefined);
      if (reasoningDelta) opts.onReasoning?.(reasoningDelta);
      delta =
        profile.provider === "anthropic"
          ? // 只排除明确非文本的增量；不带 type 的老式兼容响应照旧当正文读
            (parsed.delta?.type === "input_json_delta" || parsed.delta?.type === "thinking_delta"
              ? ""
              : (parsed.delta?.text ?? ""))
          : (parsed.choices?.[0]?.delta?.content ?? "");
    } catch {
      /* 非 JSON 心跳行忽略 */
    }
    // 携带错误的包按它自己的状态失败（此前会被当成「流里没有正文」静默结束）
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
    // 整条流读完才回调：Anthropic 的 usage 分散在多个事件里，合并后只报一次。
    // 中止/网络错的路径走上面的 catch 抛出，不回调（没跑完的用量口径不清）。
    emitUsage();
  } catch (e) {
    if (opts.signal.aborted || (e as { name?: string })?.name === "AbortError") throw toAbortError();
    throw toProviderError(e);
  }
  return acc;
}
