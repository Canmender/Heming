import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  NO_MODEL_MESSAGE,
  humanizeGatewayError,
  resetGatewayModelCache,
  resolveGatewayModel,
  streamGatewayChat,
} from "./gatewayChat.js";
import type { ChatConfig } from "./widgetBridge.js";

/**
 * 网关对话的纯逻辑：模型目录选择 + SSE 增量解析 + 错误翻译。
 * 不联网：fetch 全部注入（`opts.fetchImpl` / `resolveGatewayModel` 的入参）。
 */
const CONFIG: ChatConfig = {
  gateway: { baseUrl: "http://127.0.0.1:3425/v1", key: "magpie-heming" },
  agents: [],
  binding: { agentId: null },
};

function jsonResponse(body: unknown, init: { status?: number } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json" },
  });
}

function sseResponse(chunks: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

beforeEach(() => {
  resetGatewayModelCache();
});

describe("模型选择", () => {
  it("缺省时读网关 /v1/models 取第一个可用模型，且按 base 缓存", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ data: [{ id: "gpt-4o-mini" }, { id: "other" }] }),
    ) as unknown as typeof fetch;

    expect(await resolveGatewayModel(CONFIG, { fetchImpl })).toBe("gpt-4o-mini");
    expect(await resolveGatewayModel(CONFIG, { fetchImpl })).toBe("gpt-4o-mini");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(fetchImpl).mock.calls[0][0])).toBe("http://127.0.0.1:3425/v1/models");
  });

  it("宿主给 model 时优先用它（不读目录）", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    expect(await resolveGatewayModel({ ...CONFIG, model: "bound-model" }, { fetchImpl })).toBe(
      "bound-model",
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("目录为空 → 明确报「没有可用模型」", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ data: [] }),
    ) as unknown as typeof fetch;
    await expect(resolveGatewayModel(CONFIG, { fetchImpl })).rejects.toThrow(NO_MODEL_MESSAGE);
  });
});

describe("流式对话", () => {
  it("SSE：逐段回调 onDelta，返回全文", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/models")) return jsonResponse({ data: [{ id: "m1" }] });
      return sseResponse([
        'data: {"choices":[{"delta":{"content":"你"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"好"}}]}\n\n',
        "data: [DONE]\n\n",
      ]);
    }) as unknown as typeof fetch;

    const deltas: string[] = [];
    const full = await streamGatewayChat(CONFIG, [{ role: "user", content: "hi" }], {
      fetchImpl,
      onDelta: (d) => deltas.push(d),
    });

    expect(full).toBe("你好");
    expect(deltas).toEqual(["你", "好"]);
    // 请求体：模型来自目录、消息原样、stream: true、带网关 Key
    const init = vi.mocked(fetchImpl).mock.calls[1][1] as RequestInit;
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe("m1");
    expect(body.stream).toBe(true);
    expect(body.messages).toEqual([{ role: "user", content: "hi" }]);
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer magpie-heming");
  });

  it("非流式端点：整段 JSON 一次回调", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/models")) return jsonResponse({ data: [{ id: "m1" }] });
      return jsonResponse({ choices: [{ message: { content: "整段回复" } }] });
    }) as unknown as typeof fetch;

    const deltas: string[] = [];
    const full = await streamGatewayChat(CONFIG, [], { fetchImpl, onDelta: (d) => deltas.push(d) });
    expect(full).toBe("整段回复");
    expect(deltas).toEqual(["整段回复"]);
  });

  it("流里带 error（网关 200 携带错误）→ 抛 provider_error", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/models")) return jsonResponse({ data: [{ id: "m1" }] });
      return sseResponse(['data: {"error":{"message":"额度不足"}}\n\n']);
    }) as unknown as typeof fetch;

    await expect(streamGatewayChat(CONFIG, [], { fetchImpl })).rejects.toThrow(/provider_error/);
  });

  it("HTTP 错误保留状态码原文（由 humanizeGatewayError 翻译）", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/models")) return jsonResponse({ data: [{ id: "m1" }] });
      return new Response("unauthorized", { status: 401 });
    }) as unknown as typeof fetch;

    await expect(streamGatewayChat(CONFIG, [], { fetchImpl })).rejects.toThrow(
      /provider_error: HTTP 401/,
    );
  });

  it("没有配置网关地址 → 直接报未配置", async () => {
    await expect(
      streamGatewayChat(
        { gateway: { baseUrl: "", key: "" }, agents: [], binding: { agentId: null } },
        [],
      ),
    ).rejects.toThrow("还没有可用的模型连接");
  });
});

describe("错误翻译", () => {
  it("鉴权 / 404 / 429 / 5xx / 连不上 / 没有模型", () => {
    expect(humanizeGatewayError("provider_error: HTTP 401 x")).toContain("网关鉴权失败");
    expect(humanizeGatewayError("provider_error: HTTP 404 x")).toContain("接口地址找不到");
    expect(humanizeGatewayError("provider_error: HTTP 429 x")).toContain("频繁");
    expect(humanizeGatewayError("provider_error: HTTP 502 x")).toContain("magpie");
    expect(humanizeGatewayError("provider_error: 无法连接本机网关（ECONNREFUSED）")).toContain(
      "magpie",
    );
    expect(humanizeGatewayError(NO_MODEL_MESSAGE)).toBe(NO_MODEL_MESSAGE);
    expect(humanizeGatewayError("")).toBe("生成失败，请重试。");
  });
});
