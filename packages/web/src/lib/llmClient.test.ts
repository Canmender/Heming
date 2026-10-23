import { describe, it, expect, beforeEach, vi } from "vitest";
import { buildRequest, testConnection, streamChat, type ChatMessage } from "./llmClient.js";
import type { LlmProfile } from "../store/llm.js";

const openai: LlmProfile = { id: "p1", label: "o", provider: "openai", apiKey: "sk-o", model: "gpt-x" };
const anthropic: LlmProfile = { id: "p2", label: "a", provider: "anthropic", apiKey: "sk-ant-x", model: "claude-x" };
const msgs: ChatMessage[] = [
  { role: "system", content: "sys" },
  { role: "user", content: "hi" },
];

describe("buildRequest", () => {
  it("openai 缺省 baseUrl → 官方端点，Bearer 头与 messages 原样", () => {
    const r = buildRequest(openai, msgs, { stream: false });
    expect(r.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(r.headers.authorization).toBe("Bearer sk-o");
    const body = JSON.parse(r.body);
    expect(body.messages).toEqual(msgs);
    expect(body.stream).toBe(false);
    expect(body.model).toBe("gpt-x");
    expect(body.temperature).toBeUndefined(); // 未设置不进 body
  });

  it("自定义 baseUrl 去尾斜杠再拼路径", () => {
    const r = buildRequest({ ...openai, baseUrl: "https://my.proxy/v1/" }, msgs, { stream: true });
    expect(r.url).toBe("https://my.proxy/v1/chat/completions");
    expect(JSON.parse(r.body).stream).toBe(true);
  });

  it("anthropic：/v1/messages、x-api-key、system 拆分、maxTokens 覆盖", () => {
    const r = buildRequest(anthropic, msgs, { stream: false, maxTokens: 1 });
    expect(r.url).toBe("https://api.anthropic.com/v1/messages");
    expect(r.headers["x-api-key"]).toBe("sk-ant-x");
    expect(r.headers["anthropic-version"]).toBe("2023-06-01");
    const body = JSON.parse(r.body);
    expect(body.max_tokens).toBe(1);
    expect(body.system).toBe("sys");
    expect(body.messages).toEqual([{ role: "user", content: "hi" }]);
    expect(body.stream).toBe(false);
  });

  it("缺省 maxTokens → anthropic 默认 1024", () => {
    const body = JSON.parse(buildRequest(anthropic, msgs, { stream: false }).body);
    expect(body.max_tokens).toBe(1024);
  });

  it("Key 红线：目标域名只随 profile.baseUrl，绝不指向和鸣自有服务端", () => {
    const urls = [
      buildRequest(openai, msgs, { stream: false }).url,
      buildRequest(anthropic, msgs, { stream: false }).url,
      buildRequest({ ...openai, baseUrl: "https://llm.example.com/v1" }, msgs, { stream: false }).url,
      buildRequest({ ...anthropic, baseUrl: "http://127.0.0.1:11434" }, msgs, { stream: false }).url,
    ];
    for (const url of urls) {
      expect(url).toMatch(/^https?:\/\//); // 绝对地址，非相对路径（相对路径会被浏览器发往自有域）
      expect(url).not.toContain("47.92.39.184"); // 部署机 IP（自有服务端）锁死不出现
    }
    // 配套 F1：缺 scheme 的 baseUrl 拼出的正是相对路径——守卫直接拒绝，而非产出上面这种 URL
    expect(() =>
      buildRequest({ ...openai, baseUrl: "api.deepseek.com/v1" }, msgs, { stream: false }),
    ).toThrow("baseUrl 必须以 http:// 或 https:// 开头");
    expect(() =>
      buildRequest({ ...anthropic, baseUrl: "api.deepseek.com" }, msgs, { stream: false }),
    ).toThrow("baseUrl 必须以 http:// 或 https:// 开头");
  });
});

describe("buildRequest：多模态内容片", () => {
  const withImage: ChatMessage[] = [
    {
      role: "user",
      content: "看图",
      contentParts: [
        { type: "text", text: "看图" },
        { type: "image", mime: "image/png", data: "aW1n" },
      ],
    },
  ];

  it("openai：image_url + data URL，且不把 contentParts 漏进请求体", () => {
    const body = JSON.parse(buildRequest(openai, withImage, { stream: true }).body);
    expect(body.messages[0].content).toEqual([
      { type: "text", text: "看图" },
      { type: "image_url", image_url: { url: "data:image/png;base64,aW1n" } },
    ]);
    expect(body.messages[0]).not.toHaveProperty("contentParts");
  });

  it("anthropic：base64 source（不是 data URL）", () => {
    const body = JSON.parse(buildRequest(anthropic, withImage, { stream: false }).body);
    expect(body.messages[0].content).toEqual([
      { type: "text", text: "看图" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "aW1n" } },
    ]);
  });

  it("纯文本消息逐字不变（无内容片时走老路径）", () => {
    const body = JSON.parse(buildRequest(openai, msgs, { stream: false }).body);
    expect(body.messages).toEqual(msgs);
  });
});

describe("testConnection", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("HTTP 错误 → ok:false + 状态与响应片段", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("bad key", { status: 401 }));
    const r = await testConnection(openai);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("HTTP 401");
    expect(r.error).toContain("bad key");
  });

  it("网络异常 → ok:false + error message", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("fetch failed"));
    const r = await testConnection(openai);
    expect(r).toEqual({ ok: false, error: "fetch failed" });
  });

  it("缺 scheme baseUrl → ok:false（守卫经 testConnection 转错误，不抛出且不发请求）", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const r = await testConnection({ ...openai, baseUrl: "api.deepseek.com/v1" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/https?:\/\//);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("成功：POST 官方端点，非流式 + anthropic max_tokens:1", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 200 }));
    const r = await testConnection(anthropic);
    expect(r).toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(init.method).toBe("POST");
    const body = JSON.parse(String(init.body));
    expect(body.stream).toBe(false);
    expect(body.max_tokens).toBe(1);
    // 红线：请求目标不是部署机
    expect(String(url)).not.toContain("47.92.39.184");
  });
});

describe("streamChat", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  const openaiProfile: LlmProfile = { id: "p", label: "l", provider: "openai", apiKey: "k", model: "m" };
  const anthropicProfile: LlmProfile = { id: "p2", label: "l2", provider: "anthropic", apiKey: "k", model: "m" };
  const userMsg: ChatMessage[] = [{ role: "user", content: "hi" }];

  function sseResponse(chunks: string[]): Response {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder();
        for (const c of chunks) controller.enqueue(enc.encode(c));
        controller.close();
      },
    });
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
  }

  it("openai SSE 逐段回调并返回全文", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      sseResponse([
        'data: {"choices":[{"delta":{"content":"你"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"好"}}]}\n\n',
        "data: [DONE]\n\n",
      ]),
    );
    const deltas: string[] = [];
    const text = await streamChat(openaiProfile, userMsg, {
      signal: new AbortController().signal,
      onDelta: (t) => deltas.push(t),
    });
    expect(deltas).toEqual(["你", "好"]);
    expect(text).toBe("你好");
  });

  it("anthropic SSE content_block_delta", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      sseResponse([
        'event: content_block_delta\ndata: {"delta":{"text":"和"}}\n\n',
        "event: message_stop\ndata: {}\n\n",
      ]),
    );
    const deltas: string[] = [];
    const text = await streamChat(anthropicProfile, userMsg, {
      signal: new AbortController().signal,
      onDelta: (t) => deltas.push(t),
    });
    expect(deltas).toEqual(["和"]);
    expect(text).toBe("和");
  });

  it("非流式 json 响应单次回调", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: "整段" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const deltas: string[] = [];
    const text = await streamChat(openaiProfile, userMsg, {
      signal: new AbortController().signal,
      onDelta: (t) => deltas.push(t),
    });
    expect(text).toBe("整段");
    expect(deltas).toEqual(["整段"]);
  });

  it("I5：非流式长文本切片回调——每片 ≤4000、累积等于全文", async () => {
    const long = "汉".repeat(7500); // > 两倍 agent_chunk 单帧上限
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: long } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const deltas: string[] = [];
    const text = await streamChat(openaiProfile, userMsg, {
      signal: new AbortController().signal,
      onDelta: (t) => deltas.push(t),
    });
    expect(text).toBe(long);
    expect(deltas.length).toBe(3); // 3000 + 3000 + 1500
    for (const d of deltas) expect(d.length).toBeLessThanOrEqual(4000);
    expect(deltas.every((d) => d.length <= 3000)).toBe(true);
    expect(deltas.join("")).toBe(long);
  });

  it("HTTP 错误抛 provider_error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "bad key" } }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    );
    await expect(
      streamChat(openaiProfile, [{ role: "user", content: "x" }], {
        signal: new AbortController().signal,
        onDelta: () => {},
      }),
    ).rejects.toThrow(/provider_error/);
  });

  it("AbortSignal 中止抛 AbortError", async () => {
    const ac = new AbortController();
    vi.spyOn(globalThis, "fetch").mockImplementation((_url, init) => {
      void init;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"a"}}]}\n\n'));
          ac.abort(); // 中止发生在首个 chunk 已入队之后
          setTimeout(() => controller.error(new DOMException("aborted", "AbortError")), 0);
        },
      });
      return Promise.resolve(new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } }));
    });
    await expect(
      streamChat(openaiProfile, [{ role: "user", content: "x" }], {
        signal: ac.signal,
        onDelta: () => {},
      }),
    ).rejects.toThrow(/AbortError|aborted/i);
  });

  describe("stream_options 与 usage（d.32）", () => {
    type Usage = { inputTokens?: number; outputTokens?: number; totalTokens?: number };

    it("buildRequest：OpenAI 流式默认带 stream_options，includeUsage=false 或非流式不带，anthropic 不带", () => {
      const streamBody = JSON.parse(
        buildRequest(openaiProfile, userMsg, { stream: true }).body,
      );
      expect(streamBody.stream_options).toEqual({ include_usage: true });

      const offBody = JSON.parse(
        buildRequest(openaiProfile, userMsg, { stream: true, includeUsage: false }).body,
      );
      expect(offBody).not.toHaveProperty("stream_options");

      const nonStream = JSON.parse(buildRequest(openaiProfile, userMsg, { stream: false }).body);
      expect(nonStream).not.toHaveProperty("stream_options");

      // Anthropic 本来就带 usage，不需要也不认 stream_options
      const anthropicBody = JSON.parse(
        buildRequest(anthropicProfile, userMsg, { stream: true }).body,
      );
      expect(anthropicBody).not.toHaveProperty("stream_options");
    });

    it("OpenAI 流式尾包 usage → onUsage 回调一次且数值正确", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        sseResponse([
          'data: {"choices":[{"delta":{"content":"好"}}]}\n\n',
          'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":7,"total_tokens":12}}\n\n',
          "data: [DONE]\n\n",
        ]),
      );
      const usages: Usage[] = [];
      const text = await streamChat(openaiProfile, userMsg, {
        signal: new AbortController().signal,
        onDelta: () => {},
        onUsage: (u) => usages.push(u),
      });
      expect(text).toBe("好");
      expect(usages).toEqual([{ inputTokens: 5, outputTokens: 7, totalTokens: 12 }]);
    });

    it("Anthropic message_start + message_delta 合并后只回调一次", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        sseResponse([
          'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":12,"output_tokens":1}}}\n\n',
          'event: content_block_delta\ndata: {"delta":{"text":"和"}}\n\n',
          'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":34}}\n\n',
          "event: message_stop\ndata: {}\n\n",
        ]),
      );
      const usages: Usage[] = [];
      const text = await streamChat(anthropicProfile, userMsg, {
        signal: new AbortController().signal,
        onDelta: () => {},
        onUsage: (u) => usages.push(u),
      });
      expect(text).toBe("和");
      // output_tokens 是累计值：message_delta 的 34 覆盖 message_start 的 1
      expect(usages).toEqual([{ inputTokens: 12, outputTokens: 34 }]);
    });

    it("带 stream_options 的请求 400 → 去掉该参数重试一次并成功", async () => {
      const fetchMock = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(new Response("unknown field: stream_options", { status: 400 }))
        .mockResolvedValueOnce(
          sseResponse([
            'data: {"choices":[{"delta":{"content":"好"}}]}\n\n',
            "data: [DONE]\n\n",
          ]),
        );
      const text = await streamChat(openaiProfile, userMsg, {
        signal: new AbortController().signal,
        onDelta: () => {},
      });
      expect(text).toBe("好");
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const firstBody = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));
      expect(firstBody.stream_options).toEqual({ include_usage: true });
      const secondBody = JSON.parse(String((fetchMock.mock.calls[1][1] as RequestInit).body));
      expect(secondBody).not.toHaveProperty("stream_options");
      expect(secondBody.stream).toBe(true); // 除该参数外其余请求不变
    });

    it("两次都 400 → 抛第二个错误，且只重试一次（共两次 fetch）", async () => {
      const fetchMock = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(new Response("unknown field: stream_options", { status: 400 }))
        .mockResolvedValueOnce(new Response("还是不行", { status: 400 }));
      await expect(
        streamChat(openaiProfile, userMsg, {
          signal: new AbortController().signal,
          onDelta: () => {},
        }),
      ).rejects.toThrow(/HTTP 400 还是不行/);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("非流式 json.usage 直接读", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "整段" } }],
            usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
      const usages: Usage[] = [];
      await streamChat(openaiProfile, userMsg, {
        signal: new AbortController().signal,
        onDelta: () => {},
        onUsage: (u) => usages.push(u),
      });
      expect(usages).toEqual([{ inputTokens: 3, outputTokens: 4, totalTokens: 7 }]);
    });

    it("没有 usage → 不回调（不回调 0）", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        sseResponse([
          'data: {"choices":[{"delta":{"content":"好"}}]}\n\n',
          "data: [DONE]\n\n",
        ]),
      );
      const onUsage = vi.fn();
      await streamChat(openaiProfile, userMsg, {
        signal: new AbortController().signal,
        onDelta: () => {},
        onUsage,
      });
      expect(onUsage).not.toHaveBeenCalled();
    });

    it("Anthropic 400 不做降级重试（它本来就没带 stream_options）", async () => {
      const fetchMock = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response("bad request", { status: 400 }));
      await expect(
        streamChat(anthropicProfile, userMsg, {
          signal: new AbortController().signal,
          onDelta: () => {},
        }),
      ).rejects.toThrow(/HTTP 400/);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });
});
