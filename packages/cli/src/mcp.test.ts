/**
 * `mcp serve` 的协议契约（d.288）。
 *
 * 这些用例的价值在于「客户端不用 debug 我们就知道回什么」：协议字段名、错误码、
 * 通知不回包、闸门拒绝时不碰磁盘——每一条都是别的编辑器真的会踩的地方。
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { ToolBridge } from "../../../packages/web/src/lib/agentStream.js";
import {
  describeMcpTools,
  handleMcpLine,
  handleMcpRequest,
  MCP_DEFAULT_PROTOCOL_VERSION,
  MCP_ERROR,
  MCP_SERVER_NAME,
  negotiateProtocolVersion,
  serveMcp,
  type McpContext,
} from "./mcp.js";
import { createCliGate, createCliTooling, type ToolConfirmFn } from "./tooling.js";

const TMP_DIRS: string[] = [];

afterAll(async () => {
  await Promise.all(TMP_DIRS.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tmpDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "heming-mcp-"));
  TMP_DIRS.push(dir);
  return dir;
}

/** OpenAI 风格的一条工具声明。 */
function spec(name: string, description = `${name} 的说明`, parameters: Record<string, unknown> = {
  type: "object",
  properties: { path: { type: "string" } },
  required: ["path"],
}) {
  return { type: "function", function: { name, description, parameters } };
}

/** 只读闸门：任何调用都放行（形状由 createCliGate 保证，测试不自己拼 GateOutcome）。 */
function readOnlyGate(): ToolConfirmFn {
  return createCliGate({ roots: () => [], allowDanger: false, metaOf: () => ({ risk: "read" }) });
}

function readBridge(handler: (call: { name: string; arguments: string }) => Promise<{ text: string; ok: boolean }>) {
  const calls: { name: string; arguments: string }[] = [];
  const bridge: ToolBridge = {
    tools: [spec("file_read", "读一个文件"), spec("file_glob", "按 glob 找文件")],
    meta: (name) => (name === "file_read" || name === "file_glob" ? { risk: "read" } : undefined),
    async execute(call) {
      calls.push(call);
      return handler(call);
    },
  };
  return { bridge, calls };
}

function ctxOf(bridge: ToolBridge, overrides: Partial<McpContext> = {}): McpContext {
  return {
    tools: bridge,
    confirm: readOnlyGate(),
    version: "288.4.120",
    cwd: "D:/work",
    allowDanger: false,
    ...overrides,
  };
}

describe("协议版本协商（d.288）", () => {
  it("认识客户端要的版本就照抄，不认识就回我们最新的", () => {
    expect(negotiateProtocolVersion("2024-11-05")).toBe("2024-11-05");
    expect(negotiateProtocolVersion("2025-06-18")).toBe("2025-06-18");
    expect(negotiateProtocolVersion("1999-01-01")).toBe(MCP_DEFAULT_PROTOCOL_VERSION);
    expect(negotiateProtocolVersion(undefined)).toBe(MCP_DEFAULT_PROTOCOL_VERSION);
  });
});

describe("initialize / ping（d.288）", () => {
  it("回执带协议版本、tools 能力、serverInfo 与一段说明", async () => {
    const { bridge } = readBridge(async () => ({ text: "", ok: true }));
    const response = await handleMcpRequest(
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } },
      ctxOf(bridge),
    );
    expect(response).not.toBeNull();
    if (!response || !("result" in response)) throw new Error("期望成功响应");
    const result = response.result as {
      protocolVersion: string;
      capabilities: { tools?: unknown };
      serverInfo: { name: string; version: string };
      instructions: string;
    };
    expect(result.protocolVersion).toBe("2024-11-05");
    expect(result.capabilities.tools).toBeDefined();
    expect(result.serverInfo.name).toBe(MCP_SERVER_NAME);
    expect(result.serverInfo.version).toBe("288.4.120");
    // 说明里要写清「能写哪、不能写哪、有没有 run_command」——客户端会照它决定要不要先问用户。
    expect(result.instructions).toContain("D:/work");
    expect(result.instructions).toContain("没有 run_command");
    expect(result.instructions).toContain("file_read");
  });

  it("--allow-danger 时说明改为「命令会真的执行」", async () => {
    const { bridge } = readBridge(async () => ({ text: "", ok: true }));
    const response = await handleMcpRequest(
      { jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "2025-06-18" } },
      ctxOf(bridge, { allowDanger: true }),
    );
    if (!response || !("result" in response)) throw new Error("期望成功响应");
    const result = response.result as { instructions: string };
    expect(result.instructions).toContain("--allow-danger");
    expect(result.instructions).toContain("真的在本机执行命令");
  });

  it("ping 回空对象（客户端拿它探活）", async () => {
    const { bridge } = readBridge(async () => ({ text: "", ok: true }));
    const response = await handleMcpRequest({ jsonrpc: "2.0", id: "p1", method: "ping" }, ctxOf(bridge));
    expect(response).toEqual({ jsonrpc: "2.0", id: "p1", result: {} });
  });
});

describe("tools/list（d.288）", () => {
  it("把 OpenAI 的 parameters 原样当 inputSchema，并标只读提示", async () => {
    const { bridge } = readBridge(async () => ({ text: "", ok: true }));
    const response = await handleMcpRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" }, ctxOf(bridge));
    if (!response || !("result" in response)) throw new Error("期望成功响应");
    const tools = (response.result as { tools: Array<Record<string, unknown>> }).tools;
    expect(tools.map((tool) => tool.name)).toEqual(["file_read", "file_glob"]);
    const read = tools[0]!;
    expect(read.description).toBe("读一个文件");
    expect(read.inputSchema).toEqual({
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    });
    expect(read.annotations).toEqual({ readOnlyHint: true, destructiveHint: false });
  });

  it("桥没有声明 risk 时不硬塞 annotations（不替工具编造安全性）", () => {
    const bridge: ToolBridge = {
      tools: [spec("mystery")],
      async execute() {
        return { text: "", ok: true };
      },
    };
    const described = describeMcpTools(ctxOf(bridge));
    expect(described).toHaveLength(1);
    expect(described[0]!.annotations).toBeUndefined();
  });

  it("没有参数声明的工具给一个宽松 schema（客户端不必为空对象报错）", () => {
    const bridge: ToolBridge = {
      tools: [{ type: "function", function: { name: "noop", description: "" } }],
      async execute() {
        return { text: "", ok: true };
      },
    };
    const described = describeMcpTools(ctxOf(bridge));
    expect(described[0]!.inputSchema).toEqual({ type: "object", properties: {}, additionalProperties: true });
    // 描述为空时也要给一句，避免客户端显示成空白条目。
    expect(described[0]!.description).toContain("没有描述");
  });
});

describe("tools/call（d.288）", () => {
  it("把 arguments 原样交给桥，回 content 文本", async () => {
    const { bridge, calls } = readBridge(async () => ({ text: "文件内容", ok: true }));
    const response = await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: { name: "file_read", arguments: { path: "README.md" } },
      },
      ctxOf(bridge),
    );
    if (!response || !("result" in response)) throw new Error("期望成功响应");
    expect(response.result).toEqual({ content: [{ type: "text", text: "文件内容" }] });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.name).toBe("file_read");
    expect(JSON.parse(calls[0]!.arguments)).toEqual({ path: "README.md" });
  });

  it("工具自己失败（ok=false）时带 isError，但仍是合法的工具结果", async () => {
    const { bridge } = readBridge(async () => ({ text: "文件不存在", ok: false }));
    const response = await handleMcpRequest(
      { jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "file_read", arguments: { path: "nope.md" } } },
      ctxOf(bridge),
    );
    if (!response || !("result" in response)) throw new Error("期望成功响应");
    expect(response.result).toEqual({ content: [{ type: "text", text: "文件不存在" }], isError: true });
  });

  it("闸门拒绝时不执行工具，回「未执行」并带 isError", async () => {
    const execute = vi.fn(async (call: { name: string; arguments: string }) => ({ text: "不该跑到这里", ok: true, call }));
    const bridge: ToolBridge = {
      tools: [spec("file_write")],
      // 没声明 risk → 闸门 fail-closed。
      async execute(call) {
        return execute(call);
      },
    };
    const gate = createCliGate({
      roots: () => [],
      allowDanger: false,
      metaOf: () => undefined,
    });
    const response = await handleMcpRequest(
      { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "file_write", arguments: { path: "a.md" } } },
      ctxOf(bridge, { confirm: gate }),
    );
    if (!response || !("result" in response)) throw new Error("期望成功响应");
    const result = response.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("未执行：");
    expect(result.content[0]!.text).toContain("文件与系统状态未被修改");
    expect(execute).not.toHaveBeenCalled();
  });

  it("未知工具、缺名字、arguments 不是对象都回 -32602 并列出可用工具", async () => {
    const { bridge } = readBridge(async () => ({ text: "", ok: true }));
    const ctx = ctxOf(bridge);

    const unknown = await handleMcpRequest(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "file_nuke" } },
      ctx,
    );
    expect(unknown).toMatchObject({ error: { code: MCP_ERROR.invalidParams } });
    expect((unknown as { error: { message: string } }).error.message).toContain("file_nuke");
    expect((unknown as { error: { message: string } }).error.message).toContain("file_read");

    const noName = await handleMcpRequest({ jsonrpc: "2.0", id: 2, method: "tools/call", params: {} }, ctx);
    expect(noName).toMatchObject({ error: { code: MCP_ERROR.invalidParams } });

    const badArgs = await handleMcpRequest(
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "file_read", arguments: ["a"] } },
      ctx,
    );
    expect(badArgs).toMatchObject({ error: { code: MCP_ERROR.invalidParams } });
  });
});

describe("坏消息与通知（d.288）", () => {
  it("通知（没有 id）绝不回包——回了客户端会以为收到一条奇怪的响应", async () => {
    const { bridge } = readBridge(async () => ({ text: "", ok: true }));
    const response = await handleMcpRequest(
      { jsonrpc: "2.0", method: "notifications/initialized" },
      ctxOf(bridge),
    );
    expect(response).toBeNull();
    expect(await handleMcpLine('{"jsonrpc":"2.0","method":"notifications/initialized"}', ctxOf(bridge))).toBeNull();
  });

  it("解析失败回 -32700、id 为 null；空行不产生任何输出", async () => {
    const { bridge } = readBridge(async () => ({ text: "", ok: true }));
    const ctx = ctxOf(bridge);
    const broken = await handleMcpLine("{ 这不是 JSON", ctx);
    expect(broken).not.toBeNull();
    const parsed = JSON.parse(broken!) as { id: null; error: { code: number; message: string } };
    expect(parsed.id).toBeNull();
    expect(parsed.error.code).toBe(MCP_ERROR.parse);
    expect(parsed.error.message).toContain("解析失败");

    expect(await handleMcpLine("   ", ctx)).toBeNull();
  });

  it("不是对象 / id 类型非法 / 缺 method 分别回 -32600", async () => {
    const { bridge } = readBridge(async () => ({ text: "", ok: true }));
    const ctx = ctxOf(bridge);

    const array = await handleMcpLine("[1,2,3]", ctx);
    expect(JSON.parse(array!).error.code).toBe(MCP_ERROR.invalidRequest);

    const badId = await handleMcpLine('{"jsonrpc":"2.0","id":true,"method":"ping"}', ctx);
    expect(JSON.parse(badId!).error.code).toBe(MCP_ERROR.invalidRequest);

    const noMethod = await handleMcpLine('{"jsonrpc":"2.0","id":4}', ctx);
    expect(JSON.parse(noMethod!).error.code).toBe(MCP_ERROR.invalidRequest);
  });

  it("未知方法回 -32601，并点名支持哪些", async () => {
    const { bridge } = readBridge(async () => ({ text: "", ok: true }));
    const response = await handleMcpRequest({ jsonrpc: "2.0", id: 5, method: "resources/list" }, ctxOf(bridge));
    expect(response).toMatchObject({ error: { code: MCP_ERROR.methodNotFound } });
    expect((response as { error: { message: string } }).error.message).toContain("tools/call");
  });
});

describe("serveMcp（d.288）", () => {
  it("逐条读、逐条回；坏消息不断连；stdin 关闭后正常收工", async () => {
    const { bridge } = readBridge(async () => ({ text: "OK", ok: true }));
    const input = new PassThrough();
    const out: string[] = [];
    const errs: string[] = [];
    const done = serveMcp({
      input,
      output: { write: (chunk) => out.push(chunk) },
      error: (line) => errs.push(line),
      ctx: ctxOf(bridge),
    });

    input.write('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}\n');
    input.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    input.write("坏了的一行\n");
    input.write('{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"file_read","arguments":{"path":"a.md"}}}\n');
    input.end();

    await expect(done).resolves.toBe(0);
    // 三条响应（通知不占行）。
    expect(out).toHaveLength(3);
    const ids = out.map((line) => (JSON.parse(line) as { id: number | null }).id);
    expect(ids).toEqual([1, null, 2]);
    expect(errs.join("")).toContain("stdin 已关闭");
  });
});

describe("与真实工具装配一起跑（d.288）", () => {
  it("工作区内的写能落盘；工作区外的写被闸门拒绝且磁盘不变", async () => {
    const dir = await tmpDir();
    const tooling = createCliTooling({
      cwd: dir,
      allowDanger: false,
      conversationId: "mcp-test",
    });
    const ctx: McpContext = {
      tools: tooling.toolBridge,
      confirm: tooling.confirm,
      version: "288.4.120",
      cwd: dir.replace(/\\/g, "/"),
      allowDanger: false,
    };

    const insidePath = path.join(dir, "a.md").replace(/\\/g, "/");
    const written = await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "file_write", arguments: { path: insidePath, content: "hello" } },
      },
      ctx,
    );
    if (!written || !("result" in written)) throw new Error("期望成功响应");
    expect((written.result as { isError?: boolean }).isError).toBeUndefined();
    expect(await readFile(path.join(dir, "a.md"), "utf8")).toBe("hello");

    const outsidePath = path.join(await tmpDir(), "b.md").replace(/\\/g, "/");
    const denied = await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "file_write", arguments: { path: outsidePath, content: "nope" } },
      },
      ctx,
    );
    if (!denied || !("result" in denied)) throw new Error("期望成功响应");
    const result = denied.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBe(true);
    // 工作区外：改成 `../…` 后被闸门 fail-closed 拒绝（不写盘）。
    expect(result.content[0]!.text).toContain("未执行：");
    // 关键：拒绝时磁盘上不该出现文件。
    await expect(readFile(outsidePath, "utf8")).rejects.toThrow();
  });

  it("没有 --allow-danger 时工具清单里没有 run_command", async () => {
    const dir = await tmpDir();
    await writeFile(path.join(dir, "seed.txt"), "x");
    const safe = createCliTooling({ cwd: dir, allowDanger: false, conversationId: "mcp-safe" });
    const names = describeMcpTools({
      tools: safe.toolBridge,
      confirm: safe.confirm,
      version: "v",
      cwd: dir,
      allowDanger: false,
    }).map((tool) => tool.name);
    expect(names).toContain("file_read");
    expect(names).not.toContain("run_command");

    const danger = createCliTooling({ cwd: dir, allowDanger: true, conversationId: "mcp-danger" });
    const dangerNames = describeMcpTools({
      tools: danger.toolBridge,
      confirm: danger.confirm,
      version: "v",
      cwd: dir,
      allowDanger: true,
    }).map((tool) => tool.name);
    expect(dangerNames).toContain("run_command");
  });

  it("只读模式：tools/list 只报只读工具，写工具连名字都不出现（d.314）", async () => {
    const dir = await tmpDir();
    const tooling = createCliTooling({ cwd: dir, allowDanger: true, conversationId: "mcp-ro", readOnly: true });
    const ctx: McpContext = {
      tools: tooling.toolBridge,
      confirm: tooling.confirm,
      version: "v",
      cwd: dir.replace(/\\/g, "/"),
      allowDanger: true,
      readOnly: true,
    };
    const names = describeMcpTools(ctx).map((tool) => tool.name);
    expect(names).toContain("file_read");
    expect(names).toContain("file_grep");
    expect(names).not.toContain("file_write");
    expect(names).not.toContain("file_edit");
    // 即使给了 --allow-danger 也不给：只读赢。
    expect(names).not.toContain("run_command");
  });

  it("只读模式下即使客户端硬调写工具也拒，且磁盘不变（d.314）", async () => {
    const dir = await tmpDir();
    const tooling = createCliTooling({ cwd: dir, allowDanger: false, conversationId: "mcp-ro2", readOnly: true });
    const ctx: McpContext = {
      tools: tooling.toolBridge,
      confirm: tooling.confirm,
      version: "v",
      cwd: dir.replace(/\\/g, "/"),
      allowDanger: false,
      readOnly: true,
    };
    const target = path.join(dir, "ro.txt").replace(/\\/g, "/");
    const response = await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "file_write", arguments: { path: target, content: "不该落盘" } },
      },
      ctx,
    );
    // 只读模式下列表里本来就没有它：客户端硬调也只会得到「未知工具」，
    // 不会走到执行那一步（这比「列出再拒」更干净——它连写能力都没被承诺过）。
    const error = response as { error?: { code: number; message: string } };
    expect(error.error?.code).toBe(MCP_ERROR.invalidParams);
    expect(error.error?.message).toContain("未知工具：file_write");
    await expect(readFile(target, "utf8")).rejects.toThrow();
  });

  it("只读模式的说明文字讲清「只暴露读取类工具」（d.314）", async () => {
    const { bridge } = readBridge(async () => ({ text: "", ok: true }));
    const response = await handleMcpRequest(
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      ctxOf(bridge, { readOnly: true }),
    );
    if (!response || !("result" in response)) throw new Error("期望成功响应");
    const result = response.result as { instructions: string };
    expect(result.instructions).toContain("只读模式");
    expect(result.instructions).toContain("只暴露读取类工具");
  });
});
