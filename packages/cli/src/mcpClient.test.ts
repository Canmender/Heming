/**
 * CLI 作为 MCP 客户端（d.309）。
 *
 * 三块各自独立、分开钉：
 * - **配置**：`.heming/mcp.json` 怎么读、写坏了怎么拒；
 * - **协议**：真起一个子进程走 initialize / tools/list / tools/call（不是 mock 掉一半）；
 * - **装配**：接进工具桥之后工具名、风险等级、未授权时的文案、参数原样转发。
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createCliTooling } from "./tooling.js";
import {
  MCP_CLIENT_CONFIG_FILE,
  connectMcpServer,
  isHttpConfig,
  loadMcpServers,
  mcpToolName,
  normalizeTools,
  parseMcpConfig,
  parseMcpToolName,
  textOfContent,
  type McpConnection,
} from "./mcpClient.js";

const TMP: string[] = [];

function tmpDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "heming-mcp-client-"));
  TMP.push(dir);
  return dir;
}

function workspaceWith(text: string): string {
  const dir = tmpDir();
  mkdirSync(path.join(dir, ".heming"), { recursive: true });
  writeFileSync(path.join(dir, MCP_CLIENT_CONFIG_FILE), text, "utf8");
  return dir;
}

afterAll(() => {
  for (const dir of TMP) rmSync(dir, { recursive: true, force: true });
});

/** 一个最小的 MCP 服务端：只实现 initialize / tools/list / tools/call。 */
const SERVER_SOURCE = `
import readline from "node:readline";

const TOOLS = [
  {
    name: "echo",
    description: "把 text 原样回显",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: [] },
  },
];

function send(payload) {
  process.stdout.write(JSON.stringify(payload) + "\\n");
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
rl.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.id === undefined) return; // 通知不回包
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "0.0.1" } } });
    return;
  }
  if (message.method === "tools/list") {
    send({ jsonrpc: "2.0", id: message.id, result: { tools: TOOLS } });
    return;
  }
  if (message.method === "tools/call") {
    const args = message.params?.arguments ?? {};
    // 故意把参数回显出来：测试要确认 CLI 没有偷偷改写它。
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        content: [{ type: "text", text: "echo:" + JSON.stringify(args) }],
        isError: args.fail === true,
      },
    });
    return;
  }
  send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "no such method" } });
});
`;

function fakeServer(extra = ""): { dir: string; entry: { name: string; config: { command: string; args: string[] } } } {
  const dir = tmpDir();
  const script = path.join(dir, "server.mjs");
  writeFileSync(script, SERVER_SOURCE + extra, "utf8");
  return { dir, entry: { name: "fake", config: { command: process.execPath, args: [script] } } };
}

describe("loadMcpServers", () => {
  it("没有配置文件 = 没配（不是错误）", async () => {
    expect(await loadMcpServers(tmpDir())).toBeNull();
  });

  it("读到有效配置：名字排序、别名保留", async () => {
    const dir = workspaceWith(
      JSON.stringify({
        mcpServers: {
          zed: { command: "node", args: ["z.js"] },
          doctor: { command: "node", args: ["d.js"], env: { TOKEN: "t" }, cwd: "./sub" },
        },
      }),
    );
    const loaded = await loadMcpServers(dir);
    if (!loaded || !loaded.ok) throw new Error("应当加载成功");
    expect(loaded.servers.map((server) => server.name)).toEqual(["doctor", "zed"]);
    const doctor = loaded.servers[0]!.config;
    if (isHttpConfig(doctor)) throw new Error("这条声明不是 HTTP 的");
    expect(doctor.env).toEqual({ TOKEN: "t" });
    expect(doctor.cwd).toBe("./sub");
  });

  it("带 UTF-8 BOM 也能读（记事本写的）", async () => {
    const dir = workspaceWith(`\uFEFF${JSON.stringify({ mcpServers: { a: { command: "node" } } })}`);
    const loaded = await loadMcpServers(dir);
    expect(loaded && loaded.ok).toBe(true);
  });
});

describe("parseMcpConfig 的错误文案", () => {
  const bad = (value: unknown) => {
    const parsed = parseMcpConfig(value);
    if (!parsed || parsed.ok) throw new Error("应当失败");
    return parsed.error;
  };

  it("顶层不是对象 / 缺 mcpServers / 空表", () => {
    expect(bad([])).toContain("顶层必须是对象");
    expect(bad({})).toContain("缺少 mcpServers");
    expect(bad({ mcpServers: {} })).toContain("空的");
  });

  it("服务太多了要说清上限", () => {
    const servers: Record<string, unknown> = {};
    for (let i = 0; i < 9; i += 1) servers[`s${i}`] = { command: "node" };
    expect(bad({ mcpServers: servers })).toContain("太多");
  });

  it("缺 command / args 不是字符串数组 / env 值不是字符串 / cwd 是空串", () => {
    expect(bad({ mcpServers: { a: {} } })).toContain("需要 command");
    expect(bad({ mcpServers: { a: { command: "node", args: [1] } } })).toContain("args");
    expect(bad({ mcpServers: { a: { command: "node", env: { K: 1 } } } })).toContain("env.K");
    expect(bad({ mcpServers: { a: { command: "node", cwd: "  " } } })).toContain("cwd");
  });

  it("HTTP 声明：url 顶替 command，两种传输的字段不能混写（d.339）", () => {
    expect(bad({ mcpServers: { a: { command: "node", url: "https://x" } } })).toContain("不能同时写");
    expect(bad({ mcpServers: { a: { url: "ftp://x" } } })).toContain("必须是 http(s)");
    expect(bad({ mcpServers: { a: { url: "https://x", headers: [] } } })).toContain("headers 必须是对象");
    expect(bad({ mcpServers: { a: { url: "https://x", headers: { A: 1 } } } })).toContain("headers.A");
    expect(bad({ mcpServers: { a: { url: "https://x", args: [] } } })).toContain("不接 args");
    expect(bad({ mcpServers: { a: { url: "https://x", cwd: "." } } })).toContain("不接 cwd");
  });
});

describe("工具名", () => {
  it("前缀拼出来能反解回去", () => {
    const name = mcpToolName("my-server", "read_file");
    expect(name).toBe("mcp__my-server__read_file");
    expect(parseMcpToolName(name)).toEqual({ server: "my-server", tool: "read_file" });
  });

  it("名字里的怪字符换成下划线（工具表里只认这些）", () => {
    expect(mcpToolName("a.b", "c/d")).toBe("mcp__a_b__c_d");
  });

  it("不是 MCP 工具时返回 null", () => {
    expect(parseMcpToolName("file_read")).toBeNull();
    expect(parseMcpToolName("mcp__")).toBeNull();
    expect(parseMcpToolName("mcp__onlyserver")).toBeNull();
    expect(parseMcpToolName("mcp__server__")).toBeNull();
  });
});

describe("normalizeTools / textOfContent", () => {
  it("坏条目跳过、同名去重、没有 description 就留空", () => {
    const tools = normalizeTools([
      { name: "ok", description: " 说明了什么 " },
      { name: "" },
      null,
      { name: "ok" },
      { name: "no-schema" },
    ]);
    expect(tools.map((tool) => tool.name)).toEqual(["ok", "no-schema"]);
    expect(tools[0]?.description).toBe("说明了什么");
    expect(tools[1]?.description).toBeUndefined();
  });

  it("不是数组就当没有工具（不抛）", () => {
    expect(normalizeTools(undefined)).toEqual([]);
    expect(normalizeTools("x")).toEqual([]);
  });

  it("上限按去重后的工具数算：重名不占名额，后面的不同工具不会被挤掉", async () => {
    const { MAX_MCP_TOOLS_PER_SERVER } = await import("./mcpClient.js");
    const dupCount = Math.floor(MAX_MCP_TOOLS_PER_SERVER / 2);
    const raw: Array<{ name: string }> = [];
    for (let i = 0; i < dupCount; i += 1) {
      raw.push({ name: `dup${i}` }, { name: `dup${i}` }); // 每个名字重复两次
    }
    for (let i = 0; i < 6; i += 1) raw.push({ name: `uniq${i}` });
    const tools = normalizeTools(raw);
    // 若去重发生在截断之后：原始数组前 MAX 项全是 dup（dupCount×2 == MAX），
    // 去重后只剩 dupCount 个，6 个 uniq 全被丢掉。去重前置则全部保留。
    expect(tools).toHaveLength(dupCount + 6);
    expect(tools.filter((tool) => tool.name.startsWith("dup"))).toHaveLength(dupCount);
    expect(tools.filter((tool) => tool.name.startsWith("uniq"))).toHaveLength(6);
  });

  it("content 只取 text，图片与其它类型点名但不假装看懂", () => {
    expect(textOfContent([{ type: "text", text: "第一行" }, { type: "text", text: "第二行" }])).toBe("第一行\n第二行");
    expect(textOfContent([{ type: "image", data: "…" }])).toContain("图片");
    expect(textOfContent([{ type: "resource" }])).toContain("resource");
    expect(textOfContent("nope")).toBe("");
  });
});

describe("connectMcpServer（真起子进程）", () => {
  it("握手 → 列工具 → 调工具，参数原样传到对方", async () => {
    const { dir, entry } = fakeServer();
    const connected = await connectMcpServer(entry, { cwd: dir, version: "test" });
    if (!connected.ok) throw new Error(`应当连上：${connected.error}`);
    const connection = connected.connection;

    expect(connection.server).toBe("fake");
    expect(connection.tools.map((tool) => tool.name)).toEqual(["echo"]);

    const result = await connection.callTool("echo", { text: "你好", absolute: "D:/x/y.ts" });
    expect(result.isError).toBe(false);
    expect(result.text).toContain('"text":"你好"');
    // CLI 不改写 MCP 工具的参数：路径还是原样。
    expect(result.text).toContain("D:/x/y.ts");

    const failed = await connection.callTool("echo", { fail: true });
    expect(failed.isError).toBe(true);

    connection.close();
  });

  it("服务启动就退出：报错里带退出码与 stderr 尾巴", async () => {
    const dir = tmpDir();
    const script = path.join(dir, "boom.mjs");
    writeFileSync(script, 'process.stderr.write("起不来：缺配置\\n"); process.exit(3);', "utf8");
    const connected = await connectMcpServer(
      { name: "boom", config: { command: process.execPath, args: [script] } },
      { cwd: dir, version: "test" },
    );
    expect(connected.ok).toBe(false);
    if (connected.ok) throw new Error("应当失败");
    expect(connected.error).toContain("boom");
    expect(connected.error).toMatch(/退出|起不来/);
  });

  it("命令不存在：直接给失败，不抛", async () => {
    const connected = await connectMcpServer(
      { name: "ghost", config: { command: "definitely-not-a-real-command-xyz" } },
      { cwd: tmpDir(), version: "test" },
    );
    expect(connected.ok).toBe(false);
  });
});

/** 手搓一个连接：装配层要测的是「怎么用」，不是协议。 */
function fakeConnection(): { connection: McpConnection; calls: { tool: string; args: unknown }[] } {
  const calls: { tool: string; args: unknown }[] = [];
  const connection: McpConnection = {
    server: "svc",
    tools: [{ name: "echo", description: "回声" }],
    async callTool(tool, args) {
      calls.push({ tool, args });
      return { text: "对方说好", isError: false };
    },
    close() {
      // 不做事：装配层不该依赖 close 的副作用。
    },
  };
  return { connection, calls };
}

describe("工具桥里的 MCP 工具", () => {
  const cwd = path.resolve("D:/work/proj").replace(/\\/g, "/");

  it("工具表里带前缀，风险按 danger 报", () => {
    const { connection } = fakeConnection();
    const tooling = createCliTooling({ cwd, allowDanger: false, conversationId: "t1", mcp: [connection] });
    const names = (tooling.toolBridge.tools as { function: { name: string } }[]).map((tool) => tool.function.name);
    expect(names).toContain("mcp__svc__echo");
    expect(tooling.toolBridge.meta?.("mcp__svc__echo")?.risk).toBe("danger");
    expect(tooling.toolBridge.meta?.("mcp__svc__echo")?.displayName).toContain("svc/echo");
  });

  it("没有 --allow-danger：调用得到「未执行」，不碰对方进程", async () => {
    const { connection, calls } = fakeConnection();
    const tooling = createCliTooling({ cwd, allowDanger: false, conversationId: "t1", mcp: [connection] });
    const result = await tooling.toolBridge.execute({ name: "mcp__svc__echo", arguments: "{}" });
    expect(result.ok).toBe(false);
    expect(result.text).toContain("未执行");
    expect(calls).toHaveLength(0);
  });

  it("有 --allow-danger：参数原样转发，结果透出", async () => {
    const { connection, calls } = fakeConnection();
    const tooling = createCliTooling({ cwd, allowDanger: true, conversationId: "t1", mcp: [connection] });
    const result = await tooling.toolBridge.execute({
      name: "mcp__svc__echo",
      arguments: JSON.stringify({ path: "D:/work/proj/a.ts" }),
    });
    expect(result.ok).toBe(true);
    expect(result.text).toBe("对方说好");
    // 关键：没被 relativizeToolArgs 改写成 a.ts。
    expect(calls).toEqual([{ tool: "echo", args: { path: "D:/work/proj/a.ts" } }]);
  });

  it("参数不是合法 JSON：当场说清，不去调对方", async () => {
    const { connection, calls } = fakeConnection();
    const tooling = createCliTooling({ cwd, allowDanger: true, conversationId: "t1", mcp: [connection] });
    const result = await tooling.toolBridge.execute({ name: "mcp__svc__echo", arguments: "{坏的" });
    expect(result.ok).toBe(false);
    expect(result.text).toContain("不是合法 JSON");
    expect(calls).toHaveLength(0);
  });

  it("闸门放行 MCP 工具只在 --allow-danger 时（与桥同一条口径）", async () => {
    const { connection } = fakeConnection();
    const call = { id: "c1", function: { name: "mcp__svc__echo", arguments: "{}" } };

    const strict = createCliTooling({ cwd, allowDanger: false, conversationId: "t1", mcp: [connection] });
    const denied = await strict.confirm([call]);
    expect(denied[0]?.kind).toBe("deny");
    if (denied[0]?.kind === "deny") expect(denied[0].reason).toContain("--allow-danger");

    const allowed = createCliTooling({ cwd, allowDanger: true, conversationId: "t1", mcp: [connection] });
    expect((await allowed.confirm([call]))[0]?.kind).toBe("allow");
  });
});
