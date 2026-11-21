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
import { createCliGate, createCliTooling, type ToolConfirmFn } from "./tooling.js"
import { MCP_RESOURCE_PREFIX, MCP_RESOURCE_TEMPLATE_URI } from "./mcpCatalog.js";

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
    // d.325 起 resources/list 已是真方法，这里换一个确实不存在的方法名。
    const response = await handleMcpRequest({ jsonrpc: "2.0", id: 5, method: "tools/whatever" }, ctxOf(bridge));
    expect(response).toMatchObject({ error: { code: MCP_ERROR.methodNotFound } });
    const message = (response as { error: { message: string } }).error.message;
    expect(message).toContain("tools/call");
    expect(message).toContain("resources/read");
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


describe("prompts / resources（d.325）", () => {
  /** 一份固定的工作区内容：一条命令、一份约定文件。 */
  const catalog = {
    prompts: [
      {
        name: "review",
        title: "安全审查",
        description: "只挑能被利用的问题",
        text: "按威胁模型逐条过入口。",
        source: ".heming/commands/review.md",
      },
    ],
    resources: [
      {
        uri: "heming://workspace/.heming/commands/review.md",
        name: "review.md",
        description: "工作区里的 .heming/commands/review.md",
        mimeType: "text/markdown",
        text: "# 安全审查\n按威胁模型逐条过入口。",
        rel: ".heming/commands/review.md",
      },
      {
        uri: "heming://workspace/AGENTS.md",
        name: "AGENTS.md",
        description: "工作区里的 AGENTS.md",
        mimeType: "text/markdown",
        text: "改完要跑 pnpm test。",
        rel: "AGENTS.md",
      },
    ],
  };

  it("有工作区内容时 initialize 声明 prompts 与 resources 能力，并把统计写进说明", async () => {
    const { bridge } = readBridge(async () => ({ text: "", ok: true }));
    const response = await handleMcpRequest(
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      ctxOf(bridge, { catalog: async () => catalog }),
    );
    if (!response || !("result" in response)) throw new Error("期望成功响应");
    const result = response.result as {
      capabilities: { tools?: unknown; prompts?: unknown; resources?: unknown };
      instructions: string;
    };
    expect(result.capabilities.tools).toBeDefined();
    expect(result.capabilities.prompts).toEqual({ listChanged: false });
    expect(result.capabilities.resources).toEqual({ listChanged: false, subscribe: false });
    expect(result.instructions).toContain("1 条提示词（review）");
    expect(result.instructions).toContain("2 份资源");
  });

  it("没有工作区内容时不声明这两类能力（客户端就不会去问）", async () => {
    const { bridge } = readBridge(async () => ({ text: "", ok: true }));
    const response = await handleMcpRequest(
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      ctxOf(bridge),
    );
    if (!response || !("result" in response)) throw new Error("期望成功响应");
    const result = response.result as { capabilities: Record<string, unknown>; instructions: string };
    expect(result.capabilities.prompts).toBeUndefined();
    expect(result.capabilities.resources).toBeUndefined();
    expect(result.instructions).not.toContain("提示词");
  });

  it("prompts/list 只给名字、标题与说明，不把正文塞进清单", async () => {
    const { bridge } = readBridge(async () => ({ text: "", ok: true }));
    const response = await handleMcpRequest(
      { jsonrpc: "2.0", id: 2, method: "prompts/list" },
      ctxOf(bridge, { catalog: async () => catalog }),
    );
    if (!response || !("result" in response)) throw new Error("期望成功响应");
    const result = response.result as { prompts: Record<string, unknown>[] };
    expect(result.prompts).toEqual([
      { name: "review", title: "安全审查", description: "只挑能被利用的问题" },
    ]);
  });

  it("prompts/get 返回一条 user 消息，名字大小写不敏感", async () => {
    const { bridge } = readBridge(async () => ({ text: "", ok: true }));
    const response = await handleMcpRequest(
      { jsonrpc: "2.0", id: 3, method: "prompts/get", params: { name: " REVIEW " } },
      ctxOf(bridge, { catalog: async () => catalog }),
    );
    if (!response || !("result" in response)) throw new Error("期望成功响应");
    const result = response.result as {
      description: string;
      messages: { role: string; content: { type: string; text: string } }[];
    };
    expect(result.description).toBe("只挑能被利用的问题");
    expect(result.messages).toEqual([
      { role: "user", content: { type: "text", text: "按威胁模型逐条过入口。" } },
    ]);
  });

  it("prompts/get 认不出名字时回 -32602 并列出可用的", async () => {
    const { bridge } = readBridge(async () => ({ text: "", ok: true }));
    const response = await handleMcpRequest(
      { jsonrpc: "2.0", id: 4, method: "prompts/get", params: { name: "nope" } },
      ctxOf(bridge, { catalog: async () => catalog }),
    );
    if (!response || !("error" in response)) throw new Error("期望错误响应");
    expect(response.error.code).toBe(MCP_ERROR.invalidParams);
    expect(response.error.message).toContain("未知提示词：nope");
    expect(response.error.message).toContain("review");
  });

  it("resources/list 带上 uri / 名字 / MIME", async () => {
    const { bridge } = readBridge(async () => ({ text: "", ok: true }));
    const response = await handleMcpRequest(
      { jsonrpc: "2.0", id: 5, method: "resources/list" },
      ctxOf(bridge, { catalog: async () => catalog }),
    );
    if (!response || !("result" in response)) throw new Error("期望成功响应");
    const result = response.result as { resources: Record<string, unknown>[] };
    expect(result.resources.map((r) => r.uri)).toEqual([
      "heming://workspace/.heming/commands/review.md",
      "heming://workspace/AGENTS.md",
    ]);
    expect(result.resources[1]).toMatchObject({ name: "AGENTS.md", mimeType: "text/markdown" });
  });

  it("resources/read 按 URI 取正文；不认识的 URI（含 ..）一律 -32602", async () => {
    const { bridge } = readBridge(async () => ({ text: "", ok: true }));
    const ctx = ctxOf(bridge, { catalog: async () => catalog });
    const ok = await handleMcpRequest(
      { jsonrpc: "2.0", id: 6, method: "resources/read", params: { uri: "heming://workspace/AGENTS.md" } },
      ctx,
    );
    if (!ok || !("result" in ok)) throw new Error("期望成功响应");
    const result = ok.result as { contents: { uri: string; mimeType: string; text: string }[] };
    expect(result.contents).toEqual([
      { uri: "heming://workspace/AGENTS.md", mimeType: "text/markdown", text: "改完要跑 pnpm test。" },
    ]);

    // 名单里没有的 URI：不拼路径、不读盘，直接拒绝。
    const bad = await handleMcpRequest(
      { jsonrpc: "2.0", id: 7, method: "resources/read", params: { uri: "heming://workspace/../secrets.md" } },
      ctx,
    );
    if (!bad || !("error" in bad)) throw new Error("期望错误响应");
    expect(bad.error.code).toBe(MCP_ERROR.invalidParams);
    expect(bad.error.message).toContain("未知资源");
  });

  it("没有配置 catalog 时这两组方法回 -32601，并说清为什么", async () => {
    const { bridge } = readBridge(async () => ({ text: "", ok: true }));
    const prompts = await handleMcpRequest(
      { jsonrpc: "2.0", id: 8, method: "prompts/list" },
      ctxOf(bridge),
    );
    if (!prompts || !("error" in prompts)) throw new Error("期望错误响应");
    expect(prompts.error.code).toBe(MCP_ERROR.methodNotFound);
    expect(prompts.error.message).toContain(".heming/commands/*.md");

    const resources = await handleMcpRequest(
      { jsonrpc: "2.0", id: 9, method: "resources/read", params: { uri: "heming://workspace/AGENTS.md" } },
      ctxOf(bridge),
    );
    if (!resources || !("error" in resources)) throw new Error("期望错误响应");
    expect(resources.error.code).toBe(MCP_ERROR.methodNotFound);
  });

  it("采集抛错不影响 initialize（当没有这两类能力）", async () => {
    const { bridge } = readBridge(async () => ({ text: "", ok: true }));
    const response = await handleMcpRequest(
      { jsonrpc: "2.0", id: 10, method: "initialize", params: {} },
      ctxOf(bridge, {
        catalog: async () => {
          throw new Error("盘读不了");
        },
      }),
    );
    if (!response || !("result" in response)) throw new Error("期望成功响应");
    const result = response.result as { capabilities: Record<string, unknown> };
    expect(result.capabilities.prompts).toBeUndefined();
  });
});
describe("资源订阅（d.327）", () => {
  const catalog = {
    prompts: [],
    resources: [
      {
        uri: "heming://workspace/AGENTS.md",
        name: "AGENTS.md",
        description: "工作区里的 AGENTS.md",
        mimeType: "text/markdown",
        text: "改完要跑 pnpm test。",
        rel: "AGENTS.md",
      },
    ],
  };

  function watchStub() {
    const calls: string[] = [];
    return {
      calls,
      watch: {
        subscribe: (uri: string) => calls.push(`sub:${uri}`),
        unsubscribe: (uri: string) => calls.push(`unsub:${uri}`),
      },
    };
  }

  it("能推送时 initialize 声明 listChanged 与 subscribe（不推就不声明）", async () => {
    const { bridge } = readBridge(async () => ({ text: "", ok: true }));
    const { watch } = watchStub();
    const pushed: string[] = [];
    const response = await handleMcpRequest(
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      ctxOf(bridge, {
        catalog: async () => catalog,
        subscriptions: watch,
        notify: (message) => pushed.push(message.method),
      }),
    );
    if (!response || !("result" in response)) throw new Error("期望成功响应");
    const result = response.result as {
      capabilities: { prompts?: unknown; resources?: unknown };
      instructions: string;
    };
    expect(result.capabilities.resources).toEqual({ listChanged: true, subscribe: true });
    expect(result.capabilities.prompts).toEqual({ listChanged: true });
    expect(result.instructions).toContain("资源可以订阅");
    expect(pushed).toEqual([]);
  });

  it("resources/subscribe 收下名单里的 uri", async () => {
    const { bridge } = readBridge(async () => ({ text: "", ok: true }));
    const { calls, watch } = watchStub();
    const response = await handleMcpRequest(
      { jsonrpc: "2.0", id: 2, method: "resources/subscribe", params: { uri: "heming://workspace/AGENTS.md" } },
      ctxOf(bridge, { catalog: async () => catalog, subscriptions: watch }),
    );
    if (!response || !("result" in response)) throw new Error("期望成功响应");
    expect(response.result).toEqual({});
    expect(calls).toEqual(["sub:heming://workspace/AGENTS.md"]);
  });

  it("资源模板 uri（能读、watcher 会跟）也能订阅，不再读得到却订不上", async () => {
    const { bridge } = readBridge(async () => ({ text: "", ok: true }));
    const { calls, watch } = watchStub();
    const response = await handleMcpRequest(
      { jsonrpc: "2.0", id: 10, method: "resources/subscribe", params: { uri: "heming://workspace/src/a.ts" } },
      ctxOf(bridge, {
        catalog: async () => catalog,
        subscriptions: watch,
        readResource: async (uri) => ({ ok: true as const, uri, mimeType: "text/plain", text: "export const a = 1;" }),
      }),
    );
    if (!response || !("result" in response)) throw new Error("期望成功响应：模板 uri 应可订阅");
    expect(response.result).toEqual({});
    expect(calls).toEqual(["sub:heming://workspace/src/a.ts"]);
  });

  it("名单外的 uri 订阅不了，并列出这个工作区有哪些", async () => {
    const { bridge } = readBridge(async () => ({ text: "", ok: true }));
    const { calls, watch } = watchStub();
    const response = await handleMcpRequest(
      { jsonrpc: "2.0", id: 3, method: "resources/subscribe", params: { uri: "heming://workspace/../x.md" } },
      ctxOf(bridge, { catalog: async () => catalog, subscriptions: watch }),
    );
    if (!response || !("error" in response)) throw new Error("期望错误响应");
    expect(response.error.code).toBe(MCP_ERROR.invalidParams);
    expect(response.error.message).toContain("未知资源");
    expect(response.error.message).toContain("heming://workspace/AGENTS.md");
    expect(calls).toEqual([]);
  });

  it("没有订阅能力时两种方法都回 -32601，说清为什么", async () => {
    const { bridge } = readBridge(async () => ({ text: "", ok: true }));
    const ctx = ctxOf(bridge, { catalog: async () => catalog });
    const sub = await handleMcpRequest(
      { jsonrpc: "2.0", id: 4, method: "resources/subscribe", params: { uri: "heming://workspace/AGENTS.md" } },
      ctx,
    );
    if (!sub || !("error" in sub)) throw new Error("期望错误响应");
    expect(sub.error.code).toBe(MCP_ERROR.methodNotFound);
    expect(sub.error.message).toContain("没有跟踪资源变化");

    const unsub = await handleMcpRequest(
      { jsonrpc: "2.0", id: 5, method: "resources/unsubscribe", params: { uri: "heming://workspace/AGENTS.md" } },
      ctx,
    );
    if (!unsub || !("error" in unsub)) throw new Error("期望错误响应");
    expect(unsub.error.code).toBe(MCP_ERROR.methodNotFound);
  });

  it("取消订阅是幂等的（没订过也回成功）", async () => {
    const { bridge } = readBridge(async () => ({ text: "", ok: true }));
    const { calls, watch } = watchStub();
    const response = await handleMcpRequest(
      { jsonrpc: "2.0", id: 6, method: "resources/unsubscribe", params: { uri: "heming://workspace/AGENTS.md" } },
      ctxOf(bridge, { catalog: async () => catalog, subscriptions: watch }),
    );
    if (!response || !("result" in response)) throw new Error("期望成功响应");
    expect(response.result).toEqual({});
    expect(calls).toEqual(["unsub:heming://workspace/AGENTS.md"]);
  });

  it("缺 uri 时回 -32602", async () => {
    const { bridge } = readBridge(async () => ({ text: "", ok: true }));
    const { watch } = watchStub();
    const response = await handleMcpRequest(
      { jsonrpc: "2.0", id: 7, method: "resources/subscribe", params: {} },
      ctxOf(bridge, { catalog: async () => catalog, subscriptions: watch }),
    );
    if (!response || !("error" in response)) throw new Error("期望错误响应");
    expect(response.error.code).toBe(MCP_ERROR.invalidParams);
    expect(response.error.message).toContain("需要 uri");
  });
});
describe("资源模板（d.342）", () => {
  /** 一个有模板能力的 ctx：files 是「相对路径 → 正文」，读不到就按真实实现的文案回。 */
  function templateCtx(files: Record<string, string>) {
    const { bridge } = readBridge(async () => ({ text: "", ok: true }));
    const asked: string[] = [];
    const ctx = ctxOf(bridge, {
      readResource: async (uri) => {
        asked.push(uri);
        const rel = uri.slice(MCP_RESOURCE_PREFIX.length);
        const text = files[rel];
        if (text === undefined) return { ok: false as const, reason: `工作区里没有这份文件：${rel}` };
        return { ok: true as const, uri, mimeType: "text/plain", text };
      },
    });
    return { ctx, asked };
  }

  it("initialize 声明 resources 能力，并在 instructions 里说明模板怎么用", async () => {
    const { ctx } = templateCtx({});
    const response = await handleMcpRequest({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, ctx);
    if (!response || !("result" in response)) throw new Error("期望成功响应");
    const result = response.result as {
      capabilities: Record<string, unknown>;
      instructions: string;
    };
    // 没有固定名单（没配 catalog）时也要声明 resources：否则客户端不会去问模板。
    expect(result.capabilities.resources).toEqual({ listChanged: false });
    expect(result.capabilities.prompts).toBeUndefined();
    expect(result.instructions).toContain(MCP_RESOURCE_TEMPLATE_URI);
  });

  it("resources/templates/list 回那一条模板；没有模板能力时回空表而不是报错", async () => {
    const { ctx } = templateCtx({});
    const response = await handleMcpRequest({ jsonrpc: "2.0", id: 2, method: "resources/templates/list" }, ctx);
    if (!response || !("result" in response)) throw new Error("期望成功响应");
    const result = response.result as { resourceTemplates: { uriTemplate: string; name: string }[] };
    expect(result.resourceTemplates).toHaveLength(1);
    expect(result.resourceTemplates[0]!.uriTemplate).toBe(MCP_RESOURCE_TEMPLATE_URI);

    const { bridge } = readBridge(async () => ({ text: "", ok: true }));
    const plain = await handleMcpRequest(
      { jsonrpc: "2.0", id: 3, method: "resources/templates/list" },
      ctxOf(bridge),
    );
    if (!plain || !("result" in plain)) throw new Error("期望成功响应");
    expect((plain.result as { resourceTemplates: unknown[] }).resourceTemplates).toEqual([]);
  });

  it("resources/read 用模板读普通文件；没开模板能力时读到的是 -32601", async () => {
    const { ctx, asked } = templateCtx({ "src/a.ts": "export const a = 1;\n" });
    const response = await handleMcpRequest(
      { jsonrpc: "2.0", id: 4, method: "resources/read", params: { uri: `${MCP_RESOURCE_PREFIX}src/a.ts` } },
      ctx,
    );
    if (!response || !("result" in response)) throw new Error("期望成功响应");
    const contents = (response.result as { contents: { uri: string; mimeType: string; text: string }[] })
      .contents;
    expect(contents[0]!.uri).toBe(`${MCP_RESOURCE_PREFIX}src/a.ts`);
    expect(contents[0]!.text).toBe("export const a = 1;\n");
    expect(asked).toEqual([`${MCP_RESOURCE_PREFIX}src/a.ts`]);

    const { bridge } = readBridge(async () => ({ text: "", ok: true }));
    const plain = await handleMcpRequest(
      { jsonrpc: "2.0", id: 5, method: "resources/read", params: { uri: `${MCP_RESOURCE_PREFIX}src/a.ts` } },
      ctxOf(bridge),
    );
    if (!plain || !("error" in plain)) throw new Error("期望错误响应");
    expect(plain.error.code).toBe(MCP_ERROR.methodNotFound);
  });

  it("固定名单优先：名单里有的 URI 不会再走一次模板读盘", async () => {
    const catalog = {
      prompts: [],
      resources: [
        {
          uri: `${MCP_RESOURCE_PREFIX}AGENTS.md`,
          name: "AGENTS.md",
          mimeType: "text/markdown",
          text: "约定正文",
          rel: "AGENTS.md",
        },
      ],
    };
    const { bridge } = readBridge(async () => ({ text: "", ok: true }));
    const asked: string[] = [];
    const ctx = ctxOf(bridge, {
      catalog: async () => catalog,
      readResource: async (uri) => {
        asked.push(uri);
        return { ok: true as const, uri, mimeType: "text/plain", text: "不该走到这里" };
      },
    });
    const response = await handleMcpRequest(
      { jsonrpc: "2.0", id: 6, method: "resources/read", params: { uri: `${MCP_RESOURCE_PREFIX}AGENTS.md` } },
      ctx,
    );
    if (!response || !("result" in response)) throw new Error("期望成功响应");
    const contents = (response.result as { contents: { text: string }[] }).contents;
    expect(contents[0]!.text).toBe("约定正文");
    expect(asked).toEqual([]);
  });

  it("模板读不到时回 -32602，文案里点明原因与模板用法", async () => {
    const { ctx } = templateCtx({});
    const response = await handleMcpRequest(
      { jsonrpc: "2.0", id: 7, method: "resources/read", params: { uri: `${MCP_RESOURCE_PREFIX}nope.ts` } },
      ctx,
    );
    if (!response || !("error" in response)) throw new Error("期望错误响应");
    expect(response.error.code).toBe(MCP_ERROR.invalidParams);
    expect(response.error.message).toContain("没有这份文件");
    expect(response.error.message).toContain("resources/templates/list");
  });
});
