import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_GATEWAY,
  MagpieGatewayError,
  fetchGatewayCatalog,
  fetchGatewayImageModels,
  helloUrlOf,
  normalizeGatewayBaseUrl,
  parseGatewayModels,
} from "./magpieClient.js";

/**
 * magpie 网关客户端（d.89）：目录解析 + 探活 + 错误口径。
 *
 * 关键边界：只发 /api/hello 与 /v1/models 两个请求、只认 OpenAI 兼容形状、
 * 失败时说人话（401 要点名「网关 Key」），不在和鸣侧保存供应商凭据。
 */

describe("normalizeGatewayBaseUrl / helloUrlOf", () => {
  it("去尾部斜杠；/v1 从根上剥掉再拼 /api/hello", () => {
    expect(normalizeGatewayBaseUrl("http://127.0.0.1:3425/v1/")).toBe("http://127.0.0.1:3425/v1");
    expect(helloUrlOf({ baseUrl: "http://127.0.0.1:3425/v1", key: "k" })).toBe(
      "http://127.0.0.1:3425/api/hello",
    );
    expect(helloUrlOf({ baseUrl: "https://gw.example.com/", key: "k" })).toBe(
      "https://gw.example.com/api/hello",
    );
  });
});

describe("parseGatewayModels", () => {
  it("解析 OpenAI 形状 + magpie 扩展字段；重复 id 只留一个", () => {
    const models = parseGatewayModels({
      object: "list",
      data: [
        {
          id: "anthropic/claude-sonnet-5",
          display_name: "Claude Sonnet 5",
          owned_by: "anthropic",
          context_window: 200000,
          max_output_tokens: 8192,
          modalities: ["text", "image"],
          supported_reasoning_levels: [{ effort: "low" }, "high"],
        },
        { id: "anthropic/claude-sonnet-5", display_name: "重复" },
        { id: "group/main", display_name: "", owned_by: "" },
        { nope: true },
      ],
    });
    expect(models).toHaveLength(2);
    expect(models[0]).toMatchObject({
      id: "anthropic/claude-sonnet-5",
      name: "Claude Sonnet 5",
      ownedBy: "anthropic",
      contextWindow: 200000,
      maxOutputTokens: 8192,
      reasoningLevels: ["low", "high"],
      vision: true,
    });
    // 没有 display_name 时退回 id
    expect(models[1]).toMatchObject({ id: "group/main", name: "group/main", vision: false });
  });

  it("缺 data 数组直接报格式错误（不把空对象当没有模型）", () => {
    expect(() => parseGatewayModels({ nope: true })).toThrow(MagpieGatewayError);
    expect(() => parseGatewayModels(null)).toThrow(/缺少 data 数组/);
  });

  it("价格按 OpenRouter 的每 token 小数解析成每 100 万 token 的美元数", () => {
    const [model] = parseGatewayModels({
      data: [
        {
          id: "deepseek/deepseek-flash",
          pricing: {
            prompt: "0.00000015",
            completion: "0.0000006",
            input_cache_read: "0.000000003",
          },
        },
      ],
    });
    expect(model).toMatchObject({
      priceIn: 0.15,
      priceOut: 0.6,
      priceCacheRead: 0.003,
      // 目录没给缓存写：未知，不是 0
      priceCacheWrite: undefined,
    });
  });

  it("价格为 0 是「已知免费」，与缺这一项区分开", () => {
    const [model] = parseGatewayModels({
      data: [{ id: "local/qwen", pricing: { prompt: "0", completion: "0" } }],
    });
    expect(model.priceIn).toBe(0);
    expect(model.priceOut).toBe(0);
    expect(parseGatewayModels({ data: [{ id: "local/x" }] })[0]!.priceIn).toBeUndefined();
  });
});

describe("fetchGatewayImageModels", () => {
  it("问 ?kind=image 才列得出画图模型；非 200 就当没有", async () => {
    const urls: string[] = [];
    const fetchMock = vi.fn(async (input: string) => {
      urls.push(String(input));
      return new Response(JSON.stringify({ data: [{ id: "copilot/gpt-image-1", display_name: "GPT Image" }] }), {
        status: 200,
      });
    });
    const drawers = await fetchGatewayImageModels(DEFAULT_GATEWAY, { fetchImpl: fetchMock });
    expect(urls).toEqual(["http://127.0.0.1:3425/v1/models?kind=image"]);
    expect(drawers.map((model) => model.id)).toEqual(["copilot/gpt-image-1"]);

    const failing = await fetchGatewayImageModels(DEFAULT_GATEWAY, {
      fetchImpl: async () => new Response("nope", { status: 500 }),
    });
    expect(failing).toEqual([]);
  });
});

describe("fetchGatewayCatalog", () => {
  it("探活拿版本，再带网关 Key 读 /v1/models", async () => {
    const calls: { url: string; auth?: string }[] = [];
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      calls.push({ url, auth: headers.get("authorization") ?? undefined });
      if (url.endsWith("/api/hello")) {
        return new Response(JSON.stringify({ name: "magpie", version: "0.1.3246" }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: [{ id: "deepseek/deepseek-chat" }] }), {
        status: 200,
      });
    });

    const catalog = await fetchGatewayCatalog(DEFAULT_GATEWAY, { fetchImpl: fetchMock });
    expect(catalog.version).toBe("0.1.3246");
    expect(catalog.models.map((m) => m.id)).toEqual(["deepseek/deepseek-chat"]);
    expect(calls.map((c) => c.url)).toEqual([
      "http://127.0.0.1:3425/api/hello",
      "http://127.0.0.1:3425/v1/models",
    ]);
    expect(calls[1].auth).toBe(`Bearer ${DEFAULT_GATEWAY.key}`);
  });

  it("探活失败但 /v1/models 成功：仍算可用（有些部署只暴露 /v1）", async () => {
    const fetchMock = vi.fn(async (input: string) => {
      if (String(input).endsWith("/api/hello")) throw new Error("boom");
      return new Response(JSON.stringify({ data: [{ id: "a/b" }] }), { status: 200 });
    });
    const catalog = await fetchGatewayCatalog(DEFAULT_GATEWAY, { fetchImpl: fetchMock });
    expect(catalog.version).toBeUndefined();
    expect(catalog.models).toHaveLength(1);
  });

  it("401 点名网关 Key；连不上说清地址", async () => {
    await expect(
      fetchGatewayCatalog(DEFAULT_GATEWAY, {
        fetchImpl: async (input: string) => {
          if (String(input).endsWith("/api/hello")) return new Response("no", { status: 404 });
          return new Response("{}", { status: 401 });
        },
      }),
    ).rejects.toThrow(/网关拒绝了这个 Key/);

    await expect(
      fetchGatewayCatalog(DEFAULT_GATEWAY, {
        fetchImpl: async () => {
          throw new TypeError("fetch failed");
        },
      }),
    ).rejects.toThrow(/连不上 magpie 网关/);
  });

  it("地址不合法时直接拒绝（不猜协议）", async () => {
    await expect(
      fetchGatewayCatalog({ baseUrl: "127.0.0.1:3425/v1", key: "k" }),
    ).rejects.toThrow(/必须以 http:\/\/ 或 https:\/\/ 开头/);
    await expect(fetchGatewayCatalog({ baseUrl: "  ", key: "k" })).rejects.toThrow(
      /网关地址不能为空/,
    );
  });
});
