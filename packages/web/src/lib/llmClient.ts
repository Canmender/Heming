import type { LlmProfile } from "../store/llm.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface BuildRequestOpts {
  stream: boolean;
  /** anthropic 的 max_tokens 覆盖（openai 分支忽略，保持最小 body） */
  maxTokens?: number;
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
            .map((m) => m.content)
            .join("\n") || undefined,
        messages: messages
          .filter((m) => m.role !== "system")
          .map((m) => ({ role: m.role, content: m.content })),
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
      messages,
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
  const req = buildRequest(profile, messages, { stream: true, maxTokens: opts.maxTokens });

  const toAbortError = () => new DOMException("AbortError", "AbortError");
  const toProviderError = (e: unknown) =>
    new Error(`provider_error: ${e instanceof Error ? e.message : String(e)}`);

  let res: Response;
  try {
    res = await fetch(req.url, {
      method: "POST",
      headers: req.headers,
      body: req.body,
      signal: opts.signal,
    });
  } catch (e) {
    if (opts.signal.aborted || (e as { name?: string })?.name === "AbortError") throw toAbortError();
    throw toProviderError(e);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`provider_error: HTTP ${res.status} ${text.slice(0, 300)}`);
  }

  const ctype = res.headers.get("content-type") ?? "";
  if (!ctype.includes("event-stream")) {
    // 非流式兼容：供应商未跟随 stream 开关（如本地代理），整段读出单次回调
    let json: {
      choices?: { message?: { content?: string } }[];
      content?: { text?: string }[];
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
    if (text) opts.onDelta(text);
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
        choices?: { delta?: { content?: string } }[];
        delta?: { text?: string };
      };
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
  } catch (e) {
    if (opts.signal.aborted || (e as { name?: string })?.name === "AbortError") throw toAbortError();
    throw toProviderError(e);
  }
  return acc;
}
