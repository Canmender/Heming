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

/** 非流式 1-token 冒烟：anthropic max_tokens:1，openai 走最小 body。 */
export async function testConnection(
  profile: LlmProfile,
): Promise<{ ok: boolean; error?: string }> {
  const req = buildRequest(profile, [{ role: "user", content: "ping" }], {
    stream: false,
    maxTokens: 1,
  });
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
