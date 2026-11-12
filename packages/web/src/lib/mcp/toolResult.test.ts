import { describe, expect, it, vi } from "vitest";
import {
  MAX_TOOL_IMAGES,
  MAX_TOOL_RESULT_CHARS,
  buildToolCatalog,
  executeToolCall,
  imagesFromContent,
  sanitizeSchema,
  toOpenAiTools,
  truncateToolResult,
} from "./bridge.js";
import type { HttpMcpClient } from "./httpClient.js";

/** 一台假客户端：只实现 callTool，其余方法给最小实现（测试不碰网络）。 */
function fakeClient(callTool: HttpMcpClient["callTool"]): HttpMcpClient {
  return {
    sessionId: "s",
    initialize: async () => ({}),
    listTools: async () => [],
    callTool,
  };
}

const catalog = buildToolCatalog([
  {
    serverId: "s1",
    serverName: "srv",
    tool: { name: "echo", description: "回声", inputSchema: { type: "object" } },
  },
]);

const echoName = catalog.entries[0]?.openAiName as string;

describe("truncateToolResult", () => {
  it("未超上限时逐字返回（不做任何加工）", () => {
    const text = "短结果";
    expect(truncateToolResult(text)).toBe(text);
  });

  it("超上限时保留头 2/3 与尾 1/3，并写明省略了多少字符", () => {
    const head = "A".repeat(6000);
    const middle = "M".repeat(2000);
    const tail = "Z".repeat(2000);
    const out = truncateToolResult(head + middle + tail, 3000);

    expect(out.startsWith(head.slice(0, 2000))).toBe(true);
    expect(out.endsWith(tail.slice(-1000))).toBe(true);
    expect(out).toContain("省略");
    // 标记里的数字 = 原长 - 上限，模型据此判断要不要缩参数重查
    expect(out).toContain(String(10000 - 3000));
    // 中间那段必须真的被省略（否则等于没截断）
    expect(out).not.toContain("MMMM");
  });

  it("默认上限是公开常量（8000 字符量级）", () => {
    expect(MAX_TOOL_RESULT_CHARS).toBe(8000);
    expect(truncateToolResult("x".repeat(8000))).toHaveLength(8000);
    expect(truncateToolResult("x".repeat(8001))).toContain("省略");
  });
});

describe("executeToolCall", () => {
  it("把中断信号透传给客户端（用户点中断时在途请求要能收手）", async () => {
    const seen: (AbortSignal | undefined)[] = [];
    const callTool = vi.fn(async (_n: string, _a: Record<string, unknown>, opts?: { signal?: AbortSignal }) => {
      seen.push(opts?.signal);
      return { text: "ok", isError: false, content: [] };
    });
    const controller = new AbortController();
    const result = await executeToolCall(
      { name: echoName, arguments: "{}" },
      catalog,
      { clientFor: () => fakeClient(callTool as HttpMcpClient["callTool"]) },
      { signal: controller.signal },
    );

    expect(result.ok).toBe(true);
    expect(seen[0]).toBe(controller.signal);
  });

  it("调用前已被中断 → 不再发请求（副作用不该在中断后发生）", async () => {
    const callTool = vi.fn(async () => ({ text: "ok", isError: false, content: [] }));
    const controller = new AbortController();
    controller.abort();

    const result = await executeToolCall(
      { name: echoName, arguments: "{}" },
      catalog,
      { clientFor: () => fakeClient(callTool as HttpMcpClient["callTool"]) },
      { signal: controller.signal },
    );

    expect(callTool).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.text).toContain("已中断");
  });

  it("工具报错也走截断（错误详情可能很长）", async () => {
    const callTool = vi.fn(async () => ({
      text: "E".repeat(20000),
      isError: true,
      content: [],
    }));
    const result = await executeToolCall(
      { name: echoName, arguments: "{}" },
      catalog,
      { clientFor: () => fakeClient(callTool as HttpMcpClient["callTool"]) },
    );
    expect(result.ok).toBe(false);
    expect(result.text.startsWith("工具返回错误：")).toBe(true);
    expect(result.text).toContain("省略");
  });

  it("正常结果超长时被截断，调用方拿不到无限大的字符串", async () => {
    const callTool = vi.fn(async () => ({
      text: "R".repeat(50000),
      isError: false,
      content: [],
    }));
    const result = await executeToolCall(
      { name: echoName, arguments: "{}" },
      catalog,
      { clientFor: () => fakeClient(callTool as HttpMcpClient["callTool"]) },
    );
    expect(result.ok).toBe(true);
    expect(result.text.length).toBeLessThan(MAX_TOOL_RESULT_CHARS + 200);
  });
});

describe("图片结构化（MCP 审计 D1）", () => {
  const png = "iVBORw0KGgoAAAANSUhEUg==";

  it("从 content 里取出 image 块，不再压成占位符", async () => {
    const client = fakeClient(async () => ({
      text: "已截图 1280x720",
      isError: false,
      content: [
        { type: "text", text: "已截图 1280x720" },
        { type: "image", data: png, mimeType: "image/png" },
      ],
    }));
    const result = await executeToolCall(
      { name: echoName, arguments: "{}" },
      catalog,
      { clientFor: () => client },
    );
    expect(result.ok).toBe(true);
    expect(result.images).toEqual([{ mimeType: "image/png", data: png }]);
    expect(result.text).toContain("已截图 1280x720");
    expect(result.text).toContain("已在下面单独附上");
  });

  it("没有图片时 images 字段不出现（不改变既有形状）", async () => {
    const client = fakeClient(async () => ({ text: "纯文本", isError: false, content: [{ type: "text", text: "纯文本" }] }));
    const result = await executeToolCall({ name: echoName, arguments: "{}" }, catalog, {
      clientFor: () => client,
    });
    expect(result.images).toBeUndefined();
  });

  it("图片数量有上限，超出的丢弃（防止一次吃穿预算）", () => {
    const content = Array.from({ length: MAX_TOOL_IMAGES + 3 }, () => ({
      type: "image",
      data: png,
      mimeType: "image/png",
    }));
    expect(imagesFromContent(content)).toHaveLength(MAX_TOOL_IMAGES);
  });

  it("超大图片（>4MB base64）直接丢弃", () => {
    expect(imagesFromContent([{ type: "image", data: "x".repeat(4_000_001), mimeType: "image/png" }])).toEqual([]);
  });
});

describe("inputSchema 清洗（MCP 审计 D5）", () => {
  it("缺 type/properties 的 schema 被补成合法 object", () => {
    expect(sanitizeSchema(undefined)).toEqual({ type: "object", properties: {} });
    expect(sanitizeSchema({})).toEqual({ type: "object", properties: {} });
    expect(sanitizeSchema({ type: "string" })).toEqual({ type: "object", properties: {} });
  });

  it("required 指向不存在的属性时会被剔除（否则供应商 400）", () => {
    const out = sanitizeSchema({
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path", "ghost"],
    });
    expect(out.required).toEqual(["path"]);
  });

  it("非法 properties 项被丢掉，additionalProperties 非布尔值时被丢弃", () => {
    const out = sanitizeSchema({
      properties: { ok: { type: "string" }, bad: "not-an-object", worse: [1] },
      additionalProperties: "no",
    });
    expect(Object.keys(out.properties as object)).toEqual(["ok"]);
    expect(out.additionalProperties).toBeUndefined();
  });

  it("toOpenAiTools 走同一套清洗（模型看到的就是校验后的声明）", () => {
    const c = buildToolCatalog([
      {
        serverId: "s1",
        serverName: "srv",
        tool: { name: "t", description: "d", inputSchema: { properties: {}, required: ["nope"] } },
      },
    ]);
    const tools = toOpenAiTools(c) as { function: { parameters: Record<string, unknown> } }[];
    expect(tools[0]?.function.parameters.type).toBe("object");
    expect(tools[0]?.function.parameters.required).toBeUndefined();
  });
});
