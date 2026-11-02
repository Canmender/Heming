import { describe, expect, it, vi } from "vitest";
import {
  MAX_TOOL_RESULT_CHARS,
  buildToolCatalog,
  executeToolCall,
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
