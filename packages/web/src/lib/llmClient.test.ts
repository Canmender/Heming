import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LlmHttpError,
  buildRequest,
  carriedError,
  retryAfterMs,
  streamChat,
  testConnection,
  type ChatMessage,
} from "./llmClient.js";
import type { LlmProfile } from "../store/llm.js";

/**
 * 网关请求客户端（d.93：只剩 OpenAI 兼容协议）。
 *
 * 这里只钉「发出去的东西」与「读回来的东西」：URL/头/body 单一出处、流式与非流式解析、
 * 工具调用拼装、用量口径、错误分类。Anthropic 协议实现已删除（协议翻译在 magpie 里）。
 */

const openai: LlmProfile = {
  id: "mp:deepseek/deepseek-chat",
  label: "DeepSeek Chat",
  provider: "openai",
  baseUrl: "http://127.0.0.1:3425/v1",
  apiKey: "magpie-heming",
  model: "deepseek/deepseek-chat",
};

const msgs: ChatMessage[] = [{ role: "user", content: "hi" }];

function sse(lines: string[]): Response {
  return new Response(lines.map((line) => `data: ${line}\n`).join("\n"), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("buildRequest", () => {
  it("缺省 baseUrl → 官方端点；自定义地址去尾斜杠再拼 /chat/completions", () => {
    expect(buildRequest({ ...openai, baseUrl: undefined }, msgs, { stream: false }).url).toBe(
      "https://api.openai.com/v1/chat/completions",
    );
    expect(buildRequest(openai, msgs, { stream: false }).url).toBe(
      "http://127.0.0.1:3425/v1/chat/completions",
    );
    expect(
      buildRequest({ ...openai, baseUrl: "https://gw.example.com/v1/" }, msgs, { stream: false }).url,
    ).toBe("https://gw.example.com/v1/chat/completions");
  });

  it("Bearer 头 + messages 原样；流式默认带 stream_options，非流式不带", () => {
    const req = buildRequest(openai, msgs, { stream: true });
    expect(req.headers).toEqual({
      "content-type": "application/json",
      authorization: "Bearer magpie-heming",
    });
    expect(JSON.parse(req.body)).toMatchObject({
      model: "deepseek/deepseek-chat",
      stream: true,
      messages: [{ role: "user", content: "hi" }],
      stream_options: { include_usage: true },
    });
    expect(JSON.parse(buildRequest(openai, msgs, { stream: true, includeUsage: false }).body)).not.toHaveProperty(
      "stream_options",
    );
    expect(JSON.parse(buildRequest(openai, msgs, { stream: false }).body)).not.toHaveProperty("stream_options");
  });

  it("带 tools 时带 tools + tool_choice:auto；不带时不出现这两个字段", () => {
    const tools = [{ type: "function", function: { name: "t" } }];
    expect(JSON.parse(buildRequest(openai, msgs, { stream: false, tools }).body)).toMatchObject({
      tools,
      tool_choice: "auto",
    });
    expect(JSON.parse(buildRequest(openai, msgs, { stream: false }).body)).not.toHaveProperty("tools");
  });

  it("Key 红线：目标地址只随 profile.baseUrl；缺 scheme 直接抛", () => {
    expect(() => buildRequest({ ...openai, baseUrl: "api.deepseek.com" }, msgs, { stream: false })).toThrow(
      /baseUrl 必须以 http/,
    );
    const req = buildRequest({ ...openai, baseUrl: "http://127.0.0.1:9/v1" }, msgs, { stream: false });
    expect(req.url.startsWith("http://127.0.0.1:9/")).toBe(true);
    expect(req.headers.authorization).toBe("Bearer magpie-heming");
  });

  it("多模态：image_url + data URL，且不把 contentParts 漏进请求体", () => {
    const withImage: ChatMessage[] = [
      {
        role: "user",
        content: "看图",
        contentParts: [
          { type: "text", text: "看图" },
          { type: "image", mime: "image/png", data: "QUJD" },
        ],
      },
    ];
    const body = JSON.parse(buildRequest(openai, withImage, { stream: false }).body);
    expect(body.messages[0].content).toEqual([
      { type: "text", text: "看图" },
      { type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } },
    ]);
    expect(body.messages[0]).not.toHaveProperty("contentParts");
  });
});

describe("testConnection", () => {
  it("成功：POST /chat/completions 非流式", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(testConnection(openai)).resolves.toEqual({ ok: true });
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/chat\/completions$/);
    const init = fetchMock.mock.calls[0][1]!;
    expect(JSON.parse(String(init.body)).stream).toBe(false);
  });

  it("HTTP 错误 / 网络异常 / 缺 scheme 都返回 ok:false（不抛）", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: "bad" }, 401)));
    await expect(testConnection(openai)).resolves.toMatchObject({ ok: false });
    expect((await testConnection(openai)).error).toMatch(/HTTP 401/);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    await expect(testConnection(openai)).resolves.toMatchObject({ ok: false, error: "fetch failed" });

    await expect(testConnection({ ...openai, baseUrl: "no-scheme" })).resolves.toMatchObject({
      ok: false,
    });
  });
});

describe("streamChat", () => {
  function capture() {
    const deltas: string[] = [];
    const reasoning: string[] = [];
    const toolCalls: unknown[] = [];
    const usages: unknown[] = [];
    const finishes: string[] = [];
    return {
      deltas,
      reasoning,
      toolCalls,
      usages,
      finishes,
      opts: (signal = new AbortController().signal) => ({
        signal,
        onDelta: (d: string) => deltas.push(d),
        onReasoning: (t: string) => reasoning.push(t),
        onToolCalls: (c: unknown) => toolCalls.push(c),
        onUsage: (u: unknown) => usages.push(u),
        onFinish: (r: string) => finishes.push(r),
      }),
    };
  }

  it("SSE：choices[0].delta.content 逐段回调，返回全文；usage 尾包只回调一次", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sse([
          JSON.stringify({ choices: [{ delta: { content: "你" } }] }),
          JSON.stringify({ choices: [{ delta: { content: "好" } }] }),
          JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }),
          "[DONE]",
        ]),
      ),
    );
    const c = capture();
    const text = await streamChat(openai, msgs, c.opts());
    expect(text).toBe("你好");
    expect(c.deltas).toEqual(["你", "好"]);
    expect(c.usages).toEqual([{ inputTokens: 10, outputTokens: 2, totalTokens: 12 }]);
  });

  it("思考过程与工具调用分片拼装", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sse([
          JSON.stringify({ choices: [{ delta: { reasoning_content: "想" } }] }),
          JSON.stringify({
            choices: [
              { delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "echo", arguments: '{"a"' } }] } },
            ],
          }),
          JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ":1}" } }] } }] }),
          "[DONE]",
        ]),
      ),
    );
    const c = capture();
    await streamChat(openai, msgs, c.opts());
    expect(c.reasoning).toEqual(["想"]);
    expect(c.toolCalls).toEqual([
      [{ id: "c1", type: "function", function: { name: "echo", arguments: '{"a":1}' } }],
    ]);
  });

  it("工具名每片重发全名时不重复拼接（兼容网关）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sse([
          JSON.stringify({
            choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "read_file" } }] } }],
          }),
          JSON.stringify({
            choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "read_file" } }] } }],
          }),
          JSON.stringify({
            choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":"a"}' } }] } }],
          }),
          "[DONE]",
        ]),
      ),
    );
    const c = capture();
    await streamChat(openai, msgs, c.opts());
    expect(c.toolCalls).toEqual([
      [{ id: "c1", type: "function", function: { name: "read_file", arguments: '{"path":"a"}' } }],
    ]);
  });

  it("工具名累积式重发（ec → echo）也能拼对", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sse([
          JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "ec" } }] } }] }),
          JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "echo" } }] } }] }),
          JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "{}" } }] } }] }),
          "[DONE]",
        ]),
      ),
    );
    const c = capture();
    await streamChat(openai, msgs, c.opts());
    expect(c.toolCalls).toEqual([
      [{ id: "c1", type: "function", function: { name: "echo", arguments: "{}" } }],
    ]);
  });

  it("index 缺失的参数分片归到同一次调用（不新建坏调用）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sse([
          JSON.stringify({
            choices: [{ delta: { tool_calls: [{ id: "c1", function: { name: "echo", arguments: '{"a"' } }] } }],
          }),
          JSON.stringify({ choices: [{ delta: { tool_calls: [{ function: { arguments: ":1}" } }] } }] }),
          "[DONE]",
        ]),
      ),
    );
    const c = capture();
    await streamChat(openai, msgs, c.opts());
    expect(c.toolCalls).toEqual([
      [{ id: "c1", type: "function", function: { name: "echo", arguments: '{"a":1}' } }],
    ]);
  });

  it("参数累积式重发时取新值，不拼出非法 JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sse([
          JSON.stringify({
            choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "echo", arguments: '{"a"' } }] } }],
          }),
          JSON.stringify({
            choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"a":1}' } }] } }],
          }),
          "[DONE]",
        ]),
      ),
    );
    const c = capture();
    await streamChat(openai, msgs, c.opts());
    expect(c.toolCalls).toEqual([
      [{ id: "c1", type: "function", function: { name: "echo", arguments: '{"a":1}' } }],
    ]);
  });

  it("finish_reason=length 时丢掉半截参数的调用，并回报截断", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sse([
          JSON.stringify({
            choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "echo", arguments: '{"a":' } }] } }],
          }),
          JSON.stringify({ choices: [{ delta: {}, finish_reason: "length" }] }),
          "[DONE]",
        ]),
      ),
    );
    const c = capture();
    await streamChat(openai, msgs, c.opts());
    // 参数拼不成完整对象 → 不能交给执行层（否则只剩一条假的 Unexpected end of JSON input）
    expect(c.toolCalls).toEqual([]);
    expect(c.finishes).toEqual(["length"]);
  });

  it("finish_reason=length 但参数完整时，调用照常下发", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sse([
          JSON.stringify({
            choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "echo", arguments: '{"a":1}' } }] } }],
          }),
          JSON.stringify({ choices: [{ delta: {}, finish_reason: "length" }] }),
          "[DONE]",
        ]),
      ),
    );
    const c = capture();
    await streamChat(openai, msgs, c.opts());
    expect(c.toolCalls).toEqual([
      [{ id: "c1", type: "function", function: { name: "echo", arguments: '{"a":1}' } }],
    ]);
    expect(c.finishes).toEqual(["length"]);
  });

  it("非流式 json：整段回调；长文本切片 ≤3000", async () => {
    const long = "x".repeat(6500);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ choices: [{ message: { content: long } }], usage: { total_tokens: 5 } })),
    );
    const c = capture();
    const text = await streamChat(openai, msgs, c.opts());
    expect(text).toBe(long);
    expect(c.deltas.join("")).toBe(long);
    expect(c.deltas.every((d) => d.length <= 3000)).toBe(true);
    expect(c.usages).toEqual([{ totalTokens: 5 }]);
  });

  it("400 时关闭 stream_options 重试一次；其它状态不重试", async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      calls.push(String(init.body));
      if (calls.length === 1) return json({ error: "unknown field stream_options" }, 400);
      return sse([JSON.stringify({ choices: [{ delta: { content: "ok" } }] }), "[DONE]"]);
    });
    vi.stubGlobal("fetch", fetchMock);
    const c = capture();
    await expect(streamChat(openai, msgs, c.opts())).resolves.toBe("ok");
    expect(calls).toHaveLength(2);
    expect(JSON.parse(calls[0])).toHaveProperty("stream_options");
    expect(JSON.parse(calls[1])).not.toHaveProperty("stream_options");

    vi.stubGlobal("fetch", vi.fn(async () => json({ error: "rate" }, 429)));
    await expect(streamChat(openai, msgs, capture().opts())).rejects.toBeInstanceOf(LlmHttpError);
  });

  it("200 里携带的错误按它自己的状态失败", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sse([JSON.stringify({ error: { type: "rate_limit_exceeded", message: "slow down" } }), "[DONE]"]),
      ),
    );
    await expect(streamChat(openai, msgs, capture().opts())).rejects.toMatchObject({ status: 429 });
  });

  it("AbortSignal 中止抛 AbortError", async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        controller.abort();
        throw new DOMException("Aborted", "AbortError");
      }),
    );
    await expect(streamChat(openai, msgs, capture().opts(controller.signal))).rejects.toMatchObject({
      name: "AbortError",
    });
  });
});

describe("错误与工具函数", () => {
  it("retryAfterMs：秒数与 HTTP 日期", () => {
    expect(retryAfterMs("2")).toBe(2000);
    expect(retryAfterMs(null)).toBe(0);
    const at = new Date(Date.now() + 5000).toUTCString();
    expect(retryAfterMs(at)).toBeGreaterThan(3000);
  });

  it("carriedError：error 对象/type=error 视为 200 携带的错误，普通 200 返回 null", () => {
    expect(carriedError({ choices: [] })).toBeNull();
    expect(carriedError({ error: { message: "boom" } })).toBeInstanceOf(LlmHttpError);
    expect(carriedError({ type: "error", message: "boom" })?.status).toBeGreaterThanOrEqual(400);
  });
});

describe("buildRequest 的输出预算（max_tokens）", () => {
  it("请求体带 max_tokens：缺省取模型能力表的 maxOutput", () => {
    const body = JSON.parse(
      buildRequest({ ...openai, model: "gpt-4o" }, [{ role: "user", content: "hi" }], {
        stream: true,
      }).body,
    ) as { max_tokens?: number };
    expect(typeof body.max_tokens).toBe("number");
    expect(body.max_tokens).toBeGreaterThan(0);
  });

  it("档案手填的 maxTokens 优先于能力表", () => {
    const body = JSON.parse(
      buildRequest({ ...openai, model: "gpt-4o", maxTokens: 1234 }, [{ role: "user", content: "hi" }], {
        stream: true,
      }).body,
    ) as { max_tokens?: number };
    expect(body.max_tokens).toBe(1234);
  });

  it("未知模型也有兜底上限（不会漏成「由上游决定」）", () => {
    const body = JSON.parse(
      buildRequest({ ...openai, model: "some-unknown-model-xyz" }, [{ role: "user", content: "hi" }], {
        stream: false,
      }).body,
    ) as { max_tokens?: number };
    expect(body.max_tokens).toBeGreaterThan(0);
  });
});
