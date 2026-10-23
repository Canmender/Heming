import type { LlmProfile } from "../store/llm.js";

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

/** Anthropic：图片走 base64 source，不是 data URL。 */
function toAnthropicContent(content: MessageContent): unknown {
  if (typeof content === "string") return content;
  return content.map((part) =>
    part.type === "text"
      ? { type: "text", text: part.text }
      : {
          type: "image",
          source: { type: "base64", media_type: part.mime, data: part.data },
        },
  );
}

export interface BuildRequestOpts {
  stream: boolean;
  /** anthropic 的 max_tokens 覆盖（openai 分支忽略，保持最小 body） */
  maxTokens?: number;
  /**
   * 工具声明（OpenAI 格式的 `{type:"function",...}` 数组）。
   * 仅 OpenAI 兼容供应商注入；为空/未传时请求体与旧版完全一致。
   */
  tools?: unknown[];
  /**
   * OpenAI 流式请求是否带 `stream_options: {include_usage:true}`（尾包才会回 usage）。
   * 缺省带；显式 false 不带——部分第三方兼容网关不认这个参数会 400，
   * streamChat 据此在 400 时关掉它重试一次。Anthropic 分支始终不加（它本来就带 usage）。
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
    return {
      url: `${base.replace(/\/$/, "")}/v1/messages`,
      headers: {
        "content-type": "application/json",
        "x-api-key": profile.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: profile.model,
        max_tokens: opts.maxTokens ?? 1024,
        stream: opts.stream,
        temperature: profile.temperature,
        system:
          messages
            .filter((m) => m.role === "system")
            .map((m) => messageText(m))
            .join("\n") || undefined,
        messages: messages
          .filter((m) => m.role !== "system")
          .map((m) => ({
            role: m.role,
            content: toAnthropicContent(m.contentParts ?? m.content),
          })),
        ...(opts.tools?.length ? { tools: opts.tools } : {}),
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
  const build = (includeUsage: boolean) =>
    buildRequest(profile, messages, {
      stream: true,
      maxTokens: opts.maxTokens,
      tools: opts.tools,
      includeUsage,
    });
  // 首次带 stream_options；400 时用 build(false) 重建（buildRequest 是纯函数，不复制 body）
  let req = build(true);

  const toAbortError = () => new DOMException("AbortError", "AbortError");
  const toProviderError = (e: unknown) =>
    new Error(`provider_error: ${e instanceof Error ? e.message : String(e)}`);

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
    };
    const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
    const u: UsageTotals = {
      inputTokens: num(r.prompt_tokens) ?? num(r.input_tokens),
      outputTokens: num(r.completion_tokens) ?? num(r.output_tokens),
      totalTokens: num(r.total_tokens),
    };
    return u.inputTokens !== undefined || u.outputTokens !== undefined || u.totalTokens !== undefined
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
  // stream_options 自动降级（方案 §2.1）：部分第三方兼容网关不认该参数，直接 400。
  // 只重试一次（第二次不带该参数）；第二次仍失败就抛第二个错误——不掩盖真实问题、不无限重试。
  if (!res.ok && res.status === 400 && profile.provider !== "anthropic") {
    req = build(false);
    res = await doFetch(req);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`provider_error: HTTP ${res.status} ${text.slice(0, 300)}`);
  }

  const ctype = res.headers.get("content-type") ?? "";
  if (!ctype.includes("event-stream")) {
    // 非流式兼容：供应商未跟随 stream 开关（如本地代理），整段读出单次回调
    let json: {
      choices?: {
        message?: { content?: string; tool_calls?: unknown; reasoning_content?: string; reasoning?: string };
      }[];
      content?: { text?: string }[];
      usage?: unknown;
    };
    try {
      json = (await res.json()) as typeof json;
    } catch (e) {
      if (opts.signal.aborted) throw toAbortError();
      throw toProviderError(e);
    }
    const text =
      profile.provider === "anthropic"
        ? (json.content?.[0]?.text ?? "")
        : (json.choices?.[0]?.message?.content ?? "");
    collectToolCalls(json.choices?.[0]?.message?.tool_calls);
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
    try {
      const parsed = JSON.parse(data) as {
        choices?: {
          delta?: { content?: string; tool_calls?: unknown; reasoning_content?: string; reasoning?: string };
        }[];
        delta?: { text?: string; thinking?: string; type?: string };
        /** OpenAI 尾包（choices 可能为空）的 usage */
        usage?: unknown;
        /** Anthropic message_start 的 message.usage（input_tokens 在这里） */
        message?: { usage?: unknown };
      };
      // usage 可能分多处下发（Anthropic message_start 给 input、message_delta 给 output）
      mergeUsage(parsed.usage ?? parsed.message?.usage);
      collectToolCalls(parsed.choices?.[0]?.delta?.tool_calls);
      // 思考过程：不同供应商字段不同，统一喂给 onReasoning（不参与正文累积）
      const reasoningDelta =
        parsed.choices?.[0]?.delta?.reasoning_content ??
        parsed.choices?.[0]?.delta?.reasoning ??
        (parsed.delta?.type === "thinking_delta" ? parsed.delta.thinking : undefined);
      if (reasoningDelta) opts.onReasoning?.(reasoningDelta);
      delta =
        profile.provider === "anthropic"
          ? (parsed.delta?.text ?? "")
          : (parsed.choices?.[0]?.delta?.content ?? "");
    } catch {
      /* 非 JSON 心跳行忽略 */
    }
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
