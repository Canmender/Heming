// @vitest-environment node
/**
 * 协议层集成测试（d.209）：真 HTTP + 真 SSE。
 *
 * 为什么另开一个文件：现有 `agentStream` / `llmClient` 的单元测试全都把
 * 网络这一层换成假函数（`streamChat` 直接注入），于是「我们自己发出去的请求体长什么样」
 * 与「我们怎么把字节流拼回文本/工具调用」这两件事**从来没有被真实字节验证过**。
 * 历史上 d.165 的「工具 spec 没包 OpenAI 外壳」正是这类接缝的 bug，而它只能靠真请求才暴露。
 *
 * 这里起一个本地假网关（`http.createServer`），让 `streamChat` 走真实 `fetch`：
 * - 请求体/请求头：model、stream、stream_options、tools 外壳、Authorization；
 * - SSE 解析：内容增量、跨帧拆分的 tool_calls 拼装、finish_reason、usage；
 * - 400 降级链：去掉 `stream_options` 重发；
 * - 非流式兼容路径（供应商没跟随 stream 开关）；
 * - 中途 abort → AbortError。
 */
import http from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import type { LlmProfile } from "../store/llm.js";
import { streamChat } from "./llmClient.js";

interface CapturedRequest {
  url: string;
  method: string;
  headers: http.IncomingHttpHeaders;
  body: Record<string, unknown>;
}

interface Gateway {
  baseUrl: string;
  calls: CapturedRequest[];
  close: () => Promise<void>;
}

type Handler = (
  call: CapturedRequest,
  index: number,
  res: http.ServerResponse,
) => void | Promise<void>;

const gateways: Gateway[] = [];

/** 起一个本地假网关：把每次请求记下来，交给 handler 决定怎么回。 */
async function startGateway(handler: Handler): Promise<Gateway> {
  const calls: CapturedRequest[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        body = { __unparsable: raw };
      }
      const call: CapturedRequest = {
        url: req.url ?? "",
        method: req.method ?? "",
        headers: req.headers,
        body,
      };
      calls.push(call);
      void Promise.resolve(handler(call, calls.length - 1, res)).catch(() => {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const gateway: Gateway = {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    calls,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
  gateways.push(gateway);
  return gateway;
}

afterEach(async () => {
  const open = gateways.splice(0, gateways.length);
  await Promise.all(open.map((gateway) => gateway.close()));
});

function profileOf(baseUrl: string, overrides: Partial<LlmProfile> = {}): LlmProfile {
  return {
    id: "mp:test-model",
    label: "测试模型",
    provider: "openai",
    baseUrl,
    apiKey: "test-key",
    model: "test-model",
    ...overrides,
  };
}

/** 按 SSE 规格写一帧（`data: <json>\n\n`）。 */
function writeFrame(res: http.ServerResponse, payload: unknown): void {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function deltaFrame(delta: Record<string, unknown>, finishReason?: string): unknown {
  return {
    choices: [{ index: 0, delta, finish_reason: finishReason ?? null }],
  };
}

describe("streamChat 协议层（真 HTTP + 真 SSE）", () => {
  it("发出去的请求体：tools 保持 OpenAI 外壳、流式开关与用量开关都在", async () => {
    const gateway = await startGateway((_call, _index, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      writeFrame(res, deltaFrame({ role: "assistant", content: "好" }, "stop"));
      writeFrame(res, { choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
      res.write("data: [DONE]\n\n");
      res.end();
    });

    const tools = [
      {
        type: "function",
        function: {
          name: "file_read",
          description: "读文件",
          parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
        },
      },
    ];

    const text = await streamChat(
      profileOf(gateway.baseUrl, { temperature: 0.3, maxTokens: 1234 }),
      [{ role: "user", content: "你好" }],
      { signal: new AbortController().signal, onDelta: () => {}, tools },
    );

    expect(text).toBe("好");
    expect(gateway.calls).toHaveLength(1);
    const [call] = gateway.calls;
    expect(call?.url).toBe("/v1/chat/completions");
    expect(call?.method).toBe("POST");
    expect(call?.headers.authorization).toBe("Bearer test-key");
    expect(call?.headers["content-type"]).toContain("application/json");

    const body = call?.body ?? {};
    expect(body.model).toBe("test-model");
    expect(body.stream).toBe(true);
    expect(body.temperature).toBe(0.3);
    expect(body.max_tokens).toBe(1234);
    // 用量开关：部分网关不认它，但默认必须带（否则拿不到缓存命中统计）。
    expect(body.stream_options).toEqual({ include_usage: true });
    // 红线：工具的 OpenAI 外壳不能被剥掉（d.165 的老 bug 就是这一层）。
    expect(body.tools).toEqual(tools);
    expect(body.tool_choice).toBe("auto");
    expect(body.messages).toEqual([{ role: "user", content: "你好" }]);
  });

  it("跨帧拆开的 tool_calls 能拼回一次完整调用（同一个 index 多片参数）", async () => {
    const frames: unknown[] = [
      deltaFrame({ role: "assistant", content: "我" }),
      deltaFrame({ content: "先看" }),
      deltaFrame({
        tool_calls: [
          { index: 0, id: "call_1", type: "function", function: { name: "file_read", arguments: "" } },
        ],
      }),
      deltaFrame({ tool_calls: [{ index: 0, function: { arguments: '{"pa' } }] }),
      deltaFrame({ tool_calls: [{ index: 0, function: { arguments: 'th":"a.md"}' } }] }),
      deltaFrame({}, "tool_calls"),
      { choices: [], usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } },
    ];

    const gateway = await startGateway((_call, _index, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const frame of frames) writeFrame(res, frame);
      res.write("data: [DONE]\n\n");
      res.end();
    });

    const deltas: string[] = [];
    const toolCalls: { name?: string; arguments?: string }[] = [];
    const finishes: string[] = [];
    let usageTotal: number | undefined;

    const text = await streamChat(profileOf(gateway.baseUrl), [{ role: "user", content: "读 a.md" }], {
      signal: new AbortController().signal,
      onDelta: (chunk) => deltas.push(chunk),
      onToolCalls: (calls) => {
        for (const call of calls) {
          toolCalls.push({ name: call.function.name, arguments: call.function.arguments });
        }
      },
      onFinish: (reason) => finishes.push(reason),
      onUsage: (u) => {
        usageTotal = u.totalTokens;
      },
    });

    expect(text).toBe("我先看");
    expect(deltas.join("")).toBe("我先看");
    expect(toolCalls).toEqual([{ name: "file_read", arguments: '{"path":"a.md"}' }]);
    expect(finishes).toEqual(["tool_calls"]);
    expect(usageTotal).toBe(18);
  });

  it("首个请求被 400 拒绝时去掉 stream_options 重发（兼容不认这个参数的网关）", async () => {
    const gateway = await startGateway((_call, index, res) => {
      if (index === 0) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "unknown field stream_options" } }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      writeFrame(res, deltaFrame({ content: "降级后成功" }, "stop"));
      res.write("data: [DONE]\n\n");
      res.end();
    });

    const text = await streamChat(profileOf(gateway.baseUrl), [{ role: "user", content: "hi" }], {
      signal: new AbortController().signal,
      onDelta: () => {},
    });

    expect(text).toBe("降级后成功");
    expect(gateway.calls).toHaveLength(2);
    expect(gateway.calls[0]?.body.stream_options).toEqual({ include_usage: true });
    expect(gateway.calls[1]?.body.stream_options).toBeUndefined();
    // 重发必须仍然带工具外壳与同样的消息（降级只该动 include_usage）。
    expect(gateway.calls[1]?.body.messages).toEqual(gateway.calls[0]?.body.messages);
  });

  it("供应商没跟随 stream 开关：整段 JSON 也按一次增量交出来", async () => {
    const gateway = await startGateway((_call, _index, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [{ index: 0, message: { role: "assistant", content: "整段回答" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
        }),
      );
    });

    const deltas: string[] = [];
    const finishes: string[] = [];
    const text = await streamChat(profileOf(gateway.baseUrl), [{ role: "user", content: "hi" }], {
      signal: new AbortController().signal,
      onDelta: (chunk) => deltas.push(chunk),
      onFinish: (reason) => finishes.push(reason),
    });

    expect(text).toBe("整段回答");
    expect(deltas).toEqual(["整段回答"]);
    expect(finishes).toEqual(["stop"]);
  });

  it("中途 abort 抛 AbortError（不是当成供应商错误）", async () => {
    const controller = new AbortController();
    const gateway = await startGateway((_call, _index, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      writeFrame(res, deltaFrame({ content: "半" }));
      // 故意不收尾：把连接留在流式中间，等客户端 abort。
    });

    const seen: string[] = [];
    const pending = streamChat(profileOf(gateway.baseUrl), [{ role: "user", content: "hi" }], {
      signal: controller.signal,
      onDelta: (chunk) => {
        seen.push(chunk);
        controller.abort();
      },
    });

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(seen).toEqual(["半"]);
  });

  it("流卡住（不回数据也不关连接）→ 空闲超时抛 StreamIdleTimeoutError，已收到的内容不丢（d.211）", async () => {
    const gateway = await startGateway((_call, _index, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      writeFrame(res, deltaFrame({ content: "先说半句" }));
      // 关键：既不写 [DONE] 也不结束响应——真实网关卡住时就是这样。
    });

    const deltas: string[] = [];
    const started = Date.now();
    const pending = streamChat(profileOf(gateway.baseUrl), [{ role: "user", content: "hi" }], {
      signal: new AbortController().signal,
      onDelta: (chunk) => deltas.push(chunk),
      idleTimeoutMs: 120,
    });

    // 幂等断言：错误类型、可重试的分类依据（status 408）、文案说清「没有新数据」
    await expect(pending).rejects.toMatchObject({
      name: "StreamIdleTimeoutError",
      status: 408,
      body: expect.stringContaining("没有新数据"),
    });
    // 已经吐出来的半句必须保留：用户看到的不是空白，也不是「整轮凭空失败」
    expect(deltas).toEqual(["先说半句"]);
    // 不能只在 120ms 时假装失败却把连接留着：耗时应当接近超时值而不是卡死
    expect(Date.now() - started).toBeLessThan(3000);
    expect(gateway.calls).toHaveLength(1);
  });
  it("连响应头都等不到 → 等响应头超时抛 UpstreamTimeoutError（d.213）", async () => {
    const gateway = await startGateway(() => {
      // 关键：连接建立后什么都不回——既不写状态行也不关连接，真实网关半死时就是这样。
    });

    const started = Date.now();
    const pending = streamChat(profileOf(gateway.baseUrl), [{ role: "user", content: "hi" }], {
      signal: new AbortController().signal,
      onDelta: () => {},
      connectTimeoutMs: 120,
    });

    // status 408 → 仍落进可重试分类；phase 让界面能说清「压根没开始」而不是「说到一半停了」
    await expect(pending).rejects.toMatchObject({
      name: "UpstreamTimeoutError",
      status: 408,
      phase: "connect",
      body: expect.stringContaining("没有开始响应"),
    });
    expect(Date.now() - started).toBeLessThan(3000);
    expect(gateway.calls).toHaveLength(1);
  });

  it("非流式响应给了头但 body 永远不结束 → 空闲超时（d.213）", async () => {
    const gateway = await startGateway((_call, _index, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      // 故意只写半个 JSON 也不 end：res.json() 内部那一次读没有超时，会一直挂着。
      res.write('{"choices":[');
    });

    const started = Date.now();
    const pending = streamChat(profileOf(gateway.baseUrl), [{ role: "user", content: "hi" }], {
      signal: new AbortController().signal,
      onDelta: () => {},
      idleTimeoutMs: 120,
    });

    await expect(pending).rejects.toMatchObject({
      name: "StreamIdleTimeoutError",
      status: 408,
      phase: "stream",
      body: expect.stringContaining("没有新数据"),
    });
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("响应头到手后，等响应头的定时器不再掐连接（d.213）", async () => {
    const gateway = await startGateway((_call, _index, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(": hello\n\n");
      // 首帧之后故意晚 300ms 才开始吐内容：比 connectTimeoutMs 长，但响应头早到了。
      setTimeout(() => {
        writeFrame(res, deltaFrame({ content: "晚到的回答" }));
        res.write("data: [DONE]\n\n");
        res.end();
      }, 300);
    });

    const deltas: string[] = [];
    const text = await streamChat(profileOf(gateway.baseUrl), [{ role: "user", content: "hi" }], {
      signal: new AbortController().signal,
      onDelta: (chunk) => deltas.push(chunk),
      connectTimeoutMs: 120,
    });

    expect(text).toBe("晚到的回答");
    expect(deltas).toEqual(["晚到的回答"]);
  });

});
