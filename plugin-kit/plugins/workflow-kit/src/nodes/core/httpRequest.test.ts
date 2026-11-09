import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearNodeRegistry, requireNodeType } from "../../registry.js";
import type { HttpResponse, NodeExecuteResult, NodeHelpers, NodeOutputData } from "../../types.js";
import { toOutputData } from "../../types.js";
import { createFakeContext, type FakeContextOptions } from "./fakeContext.js";
import { registerCoreNodes } from "./index.js";

/**
 * HTTP 节点只依赖注入的 helpers.httpRequest：测试用一个假实现截获请求参数，
 * 钉住「URL 编码、请求体类型、非 2xx 报错带 httpCode、协议白名单」这些语义。
 * 节点自己不发网络请求，所以这些用例不碰网络、不受环境网络状态影响。
 */

beforeEach(() => {
  clearNodeRegistry();
  registerCoreNodes();
});

interface Harness {
  output: NodeOutputData;
  request: ReturnType<typeof vi.fn>;
}

function response(overrides: Partial<HttpResponse> = {}): HttpResponse {
  return {
    statusCode: 200,
    headers: { "content-type": "application/json" },
    body: { ok: true },
    ...overrides,
  };
}

async function call(
  parameters: Record<string, unknown>,
  reply: HttpResponse | Error,
  options: FakeContextOptions = {},
): Promise<Harness> {
  const request = vi.fn(async () => {
    if (reply instanceof Error) throw reply;
    return reply;
  });
  const context = createFakeContext({
    parameters,
    helpers: { httpRequest: request as unknown as NodeHelpers["httpRequest"] },
    ...options,
  });
  const result: NodeExecuteResult = await requireNodeType("httpRequest").execute(context);
  return { output: toOutputData(result), request };
}

describe("HTTP 请求 · 请求构造", () => {
  it("GET：查询参数编码进 URL，请求头字符串化，不带请求体", async () => {
    const { request } = await call(
      {
        method: "GET",
        url: "https://api.example.com/items",
        headers: { "X-Trace": 123 },
        query: { q: "和鸣 workflow", page: 2 },
        bodyType: "json",
        jsonBody: { ignored: true },
      },
      response(),
    );
    const options = request.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(options.method).toBe("GET");
    expect(options.url).toBe(
      `https://api.example.com/items?q=${encodeURIComponent("和鸣 workflow")}&page=2`,
    );
    expect(options.headers).toEqual({ "X-Trace": "123" });
    expect(options.bodyType).toBe("none");
    expect(options.body).toBeUndefined();
    expect(options.responseType).toBe("json");
  });

  it("POST：JSON 请求体原样传给桥接层", async () => {
    const { request } = await call(
      { method: "POST", url: "https://api.example.com/items", bodyType: "json", jsonBody: { name: "和鸣" } },
      response(),
    );
    const options = request.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(options.method).toBe("POST");
    expect(options.bodyType).toBe("json");
    expect(options.body).toEqual({ name: "和鸣" });
  });

  it("文本与表单请求体", async () => {
    const text = await call(
      { method: "PUT", url: "https://api.example.com/text", bodyType: "text", textBody: "纯文本" },
      response(),
    );
    expect((text.request.mock.calls[0]?.[0] as Record<string, unknown>).body).toBe("纯文本");

    const form = await call(
      { method: "POST", url: "https://api.example.com/form", bodyType: "form", formBody: { a: 1 } },
      response(),
    );
    const options = form.request.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(options.bodyType).toBe("form");
    expect(options.body).toEqual({ a: 1 });
  });

  it("超时夹紧到 1–120000 毫秒", async () => {
    const tooLarge = await call(
      { method: "GET", url: "https://api.example.com/", timeoutMs: 999_999 },
      response(),
    );
    expect((tooLarge.request.mock.calls[0]?.[0] as Record<string, unknown>).timeoutMs).toBe(120_000);

    const tooSmall = await call({ method: "GET", url: "https://api.example.com/", timeoutMs: 0 }, response());
    expect((tooSmall.request.mock.calls[0]?.[0] as Record<string, unknown>).timeoutMs).toBe(1);
  });
});

describe("HTTP 请求 · 响应归一", () => {
  it("对象响应 ⇒ 一条 item", async () => {
    const { output } = await call({ method: "GET", url: "https://api.example.com/" }, response());
    expect(output.main[0]).toEqual([{ json: { ok: true } }]);
  });

  it("数组响应 ⇒ 一个元素一条 item", async () => {
    const { output } = await call(
      { method: "GET", url: "https://api.example.com/" },
      response({ body: [{ id: 1 }, { id: 2 }] }),
    );
    expect(output.main[0]?.map((item) => item.json)).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it("文本/标量响应放进 data 字段", async () => {
    const { output } = await call(
      { method: "GET", url: "https://api.example.com/", responseFormat: "text" },
      response({ body: "hello", headers: {} }),
    );
    expect(output.main[0]).toEqual([{ json: { data: "hello" } }]);
  });

  it("空响应（HEAD/204）产出一条空 item", async () => {
    const { output } = await call(
      { method: "HEAD", url: "https://api.example.com/" },
      response({ statusCode: 204, body: null }),
    );
    expect(output.main[0]).toEqual([{ json: {} }]);
  });
});

describe("HTTP 请求 · 错误路径", () => {
  it("4xx/5xx 默认失败，错误带 httpCode 与响应片段", async () => {
    const error = await call(
      { method: "GET", url: "https://api.example.com/missing" },
      response({ statusCode: 404, body: { message: "not found" } }),
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("HTTP 请求失败：404");
    expect((error as { httpCode?: string }).httpCode).toBe("404");
    expect((error as { description?: string }).description).toContain("not found");
  });

  it("开启「非 2xx 也继续」时把响应交给下游", async () => {
    const { output } = await call(
      { method: "GET", url: "https://api.example.com/missing", neverError: true },
      response({ statusCode: 500, body: { message: "boom" } }),
    );
    expect(output.main[0]).toEqual([{ json: { message: "boom" } }]);
  });

  it("桥接层抛错时包成可读错误（保留状态码）", async () => {
    const bridgeError = Object.assign(new Error("连接超时"), { statusCode: 504 });
    const error = await call(
      { method: "GET", url: "https://api.example.com/" },
      bridgeError,
    ).catch((caught: unknown) => caught);
    expect((error as Error).message).toContain("HTTP 请求失败：连接超时");
    expect((error as { httpCode?: string }).httpCode).toBe("504");
  });

  it("协议白名单：只允许 http/https", async () => {
    await expect(call({ method: "GET", url: "file:///etc/passwd" }, response())).rejects.toThrow(
      /只允许 http/,
    );
    await expect(call({ method: "GET", url: "data:text/plain,hi" }, response())).rejects.toThrow(
      /只允许 http/,
    );
    await expect(call({ method: "GET", url: "" }, response())).rejects.toThrow(/缺少 URL/);
  });
});

describe("HTTP 请求 · 描述", () => {
  it("方法白名单齐全、参数有默认值", () => {
    const { description } = requireNodeType("httpRequest");
    const method = description.properties.find((property) => property.name === "method");
    expect(method?.options?.map((option) => option.value)).toEqual([
      "GET",
      "POST",
      "PUT",
      "PATCH",
      "DELETE",
      "HEAD",
    ]);
    expect(description.inputs).toBe(1);
    expect(description.outputs).toBe(1);
  });
});
