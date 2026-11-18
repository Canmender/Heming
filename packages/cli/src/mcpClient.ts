/**
 * CLI 作为 **MCP 客户端**：把工作区里声明的 MCP 服务接成一个工具来源（d.309）。
 *
 * 背景：`heming mcp serve` 让我们**被**别的编辑器调用（d.289）；可反过来——
 * 让 `heming run` 用上别人写好的 MCP 工具——一直没有。桌面端早就有 MCP 客户端
 * （`packages/desktop/mcp-stdio.js`），CLI 的 `--help` 却明写「不接 MCP」。
 * 结果同一台机器上，窗口里能用的工具，终端里用不了。
 *
 * 三条刻意的保守设定：
 * - **要显式 `--mcp` 才连**：`.heming/mcp.json` 里的 `command` 是「启动一个进程」，
 *   克隆一个陌生仓库就自动执行它，等于把仓库当安装包跑。必须由用户点名授权。
 * - **MCP 工具一律按 danger 处理**：它们不归我们的闸门管（真正的操作发生在对方进程里），
 *   只能靠「要不要放行 danger」这一道总闸，所以还需要 `--allow-danger` 才真的跑。
 * - **不替对方改写参数**：`relativizeToolArgs` 只服务我们自己的文件工具；MCP 工具的
 *   参数语义由对方定义，凭空把 `D:/x` 改成相对路径只会把它弄坏。
 *
 * 只实现 `tools` 能力（与 `mcp serve` 对称）：初始化、列工具、调工具，够 `run` 用。
 */

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import readline from "node:readline";

/** 工作区里声明 MCP 服务的文件（与桌面端同名的约定）。 */
export const MCP_CLIENT_CONFIG_FILE = ".heming/mcp.json";

/** 一次运行最多连几个服务：工具清单要进提示词，连太多只会把上下文吃光。 */
export const MAX_MCP_SERVERS = 8;

/** 单个服务暴露的工具上限（超出的部分不挂，避免一个服务把工具表撑爆）。 */
export const MAX_MCP_TOOLS_PER_SERVER = 64;

/** 一次 JSON-RPC 请求的默认超时。 */
export const MCP_CLIENT_TIMEOUT_MS = 10_000;

/** 工具名前缀：`mcp__<服务>__<工具>`，与其它工具在同一张表里不冲突。 */
export const MCP_TOOL_PREFIX = "mcp__";

/** 本地进程形式（stdio）：我们 spawn 一个子进程，用它的 stdin/stdout 说 JSON-RPC。 */
export interface McpStdioConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

/**
 * 远端服务形式（HTTP）：直接 POST JSON-RPC，回应可以是 `application/json`，
 * 也可以是 `text/event-stream`（流式那份只取 id 对得上的那一条）。
 *
 * 与 stdio 的区别只在传输：工具清单、调用结果的形状完全一样，所以上层不用区分。
 */
export interface McpHttpConfig {
  url: string;
  headers?: Record<string, string>;
}

/** 服务声明（`.heming/mcp.json` 的 `mcpServers.<名字>`）。 */
export type McpServerConfig = McpStdioConfig | McpHttpConfig;

/** 这条声明是 HTTP 还是 stdio（两者只能写一个）。 */
export function isHttpConfig(config: McpServerConfig): config is McpHttpConfig {
  return typeof (config as McpHttpConfig).url === "string";
}

/** 一个已声明的服务。 */
export interface McpServerEntry {
  name: string;
  config: McpServerConfig;
}

/** 配置加载结果：`null` = 没有这个文件（常态），`ok:false` = 有文件但写坏了。 */
export type McpConfigLoad =
  | { ok: true; servers: McpServerEntry[]; source: string }
  | { ok: false; error: string; source: string }
  | null;

/** 服务声明的工具。 */
export interface McpToolInfo {
  name: string;
  description?: string;
  /** 对方给的 JSON Schema；缺省时我们给一个宽松的 object。 */
  inputSchema?: unknown;
}

/** 一次工具调用结果。 */
export interface McpCallResult {
  text: string;
  isError: boolean;
}

/** 连上的服务。 */
export interface McpConnection {
  server: string;
  tools: McpToolInfo[];
  callTool(tool: string, args: unknown, timeoutMs?: number): Promise<McpCallResult>;
  close(): void;
}

/** 连接结果。 */
export type McpConnectResult =
  | { ok: true; connection: McpConnection }
  | { ok: false; error: string };

/** 读 `.heming/mcp.json`。语义与权限规则一致：没有当「没配」，坏了要调用方拒绝启动。 */
export async function loadMcpServers(cwd: string): Promise<McpConfigLoad> {
  const file = path.join(cwd, MCP_CLIENT_CONFIG_FILE);
  const source = MCP_CLIENT_CONFIG_FILE;

  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return { ok: false, error: `读不到 MCP 配置：${messageOf(error)}`, source };
  }

  // 与权限规则同理：记事本/PS5 会写 BOM，手写 JSON 不该因此失效。
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.replace(/^\uFEFF/, ""));
  } catch (error) {
    return { ok: false, error: `MCP 配置不是合法 JSON：${messageOf(error)}`, source };
  }
  return parseMcpConfig(parsed, source);
}

/** 把解析后的 JSON 校验成服务清单（单独导出便于测试）。 */
export function parseMcpConfig(value: unknown, source = MCP_CLIENT_CONFIG_FILE): McpConfigLoad {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "MCP 配置的顶层必须是对象", source };
  }
  const table = (value as { mcpServers?: unknown }).mcpServers;
  if (table === undefined) return { ok: false, error: "MCP 配置缺少 mcpServers", source };
  if (!table || typeof table !== "object" || Array.isArray(table)) {
    return { ok: false, error: "mcpServers 必须是对象（名字 → 声明）", source };
  }

  const entries = Object.entries(table as Record<string, unknown>);
  if (entries.length === 0) return { ok: false, error: "mcpServers 是空的：要么删掉这个文件，要么写上服务", source };
  if (entries.length > MAX_MCP_SERVERS) {
    return { ok: false, error: `MCP 服务太多（${entries.length} 个 > ${MAX_MCP_SERVERS} 个上限）`, source };
  }

  const servers: McpServerEntry[] = [];
  for (const [name, decl] of entries) {
    if (!name.trim()) return { ok: false, error: "MCP 服务名不能是空串", source };
    const checked = checkServerDecl(name, decl);
    if (!checked.ok) return { ok: false, error: checked.error, source };
    servers.push({ name, config: checked.config });
  }
  // 名字排序：连的顺序与工具在提示词里的顺序都稳定，测试也好写。
  servers.sort((a, b) => a.name.localeCompare(b.name));
  return { ok: true, servers, source };
}

function checkServerDecl(
  name: string,
  decl: unknown,
): { ok: true; config: McpServerConfig } | { ok: false; error: string } {
  if (!decl || typeof decl !== "object" || Array.isArray(decl)) {
    return { ok: false, error: `MCP 服务 ${name} 的声明必须是对象` };
  }
  const record = decl as Record<string, unknown>;
  const command = record.command;
  const url = record.url;
  if (url !== undefined) {
    if (command !== undefined) return { ok: false, error: `MCP 服务 ${name} 不能同时写 command 与 url（一个走本地进程、一个走 HTTP）` };
    if (typeof url !== "string" || !/^https?:\/\//i.test(url.trim())) {
      return { ok: false, error: `MCP 服务 ${name} 的 url 必须是 http(s) 地址` };
    }
    const config: McpHttpConfig = { url: url.trim() };
    if (record.headers !== undefined) {
      const headers = record.headers;
      if (!headers || typeof headers !== "object" || Array.isArray(headers)) {
        return { ok: false, error: `MCP 服务 ${name} 的 headers 必须是对象` };
      }
      const map: Record<string, string> = {};
      for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
        if (typeof value !== "string") return { ok: false, error: `MCP 服务 ${name} 的 headers.${key} 必须是字符串` };
        map[key] = value;
      }
      config.headers = map;
    }
    for (const key of ["args", "env", "cwd"] as const) {
      if (record[key] !== undefined) {
        return { ok: false, error: `MCP 服务 ${name} 走 HTTP 时不接 ${key}（那是本地进程才有的）` };
      }
    }
    return { ok: true, config };
  }
  if (typeof command !== "string" || !command.trim()) {
    return { ok: false, error: `MCP 服务 ${name} 需要 command（要启动什么）或 url（远端地址）` };
  }
  const config: McpStdioConfig = { command };

  if (record.args !== undefined) {
    if (!Array.isArray(record.args) || record.args.some((arg) => typeof arg !== "string")) {
      return { ok: false, error: `MCP 服务 ${name} 的 args 必须是字符串数组` };
    }
    config.args = record.args as string[];
  }
  if (record.env !== undefined) {
    const env = record.env;
    if (!env || typeof env !== "object" || Array.isArray(env)) {
      return { ok: false, error: `MCP 服务 ${name} 的 env 必须是对象` };
    }
    const map: Record<string, string> = {};
    for (const [key, value] of Object.entries(env as Record<string, unknown>)) {
      if (typeof value !== "string") return { ok: false, error: `MCP 服务 ${name} 的 env.${key} 必须是字符串` };
      map[key] = value;
    }
    config.env = map;
  }
  if (record.cwd !== undefined) {
    if (typeof record.cwd !== "string" || !record.cwd.trim()) {
      return { ok: false, error: `MCP 服务 ${name} 的 cwd 必须是非空字符串` };
    }
    config.cwd = record.cwd;
  }
  return { ok: true, config };
}

/** 工具在统一表里的名字：`mcp__<服务>__<工具>`（非法字符换成下划线）。 */
export function mcpToolName(server: string, tool: string): string {
  return `${MCP_TOOL_PREFIX}${sanitizePiece(server)}__${sanitizePiece(tool)}`;
}

/** 从统一表里的名字反解出服务与工具；不是 MCP 工具时返回 null。 */
export function parseMcpToolName(name: string): { server: string; tool: string } | null {
  if (!name.startsWith(MCP_TOOL_PREFIX)) return null;
  const rest = name.slice(MCP_TOOL_PREFIX.length);
  const split = rest.indexOf("__");
  if (split <= 0 || split === rest.length - 2) return null;
  const server = rest.slice(0, split);
  const tool = rest.slice(split + 2);
  if (!server || !tool) return null;
  return { server, tool };
}

function sanitizePiece(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 48);
}

/** 连一个服务：本地进程走 stdio，声明了 url 的走 HTTP；之后都是 initialize → tools/list。 */
export async function connectMcpServer(
  entry: McpServerEntry,
  options: { cwd?: string; version: string; timeoutMs?: number; env?: NodeJS.ProcessEnv },
): Promise<McpConnectResult> {
  if (isHttpConfig(entry.config)) return connectHttpMcpServer(entry, entry.config, options);

  const timeoutMs = options.timeoutMs ?? MCP_CLIENT_TIMEOUT_MS;
  const { command, args = [], env = {}, cwd } = entry.config;
  const baseCwd = options.cwd ?? process.cwd();

  let child;
  try {
    child = spawn(command, args, {
      cwd: cwd ? path.resolve(baseCwd, cwd) : baseCwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...(options.env ?? process.env), ...env },
      windowsHide: true,
    });
  } catch (error) {
    return { ok: false, error: `启动失败：${messageOf(error)}` };
  }

  const stderrChunks: string[] = [];
  child.stderr?.on("data", (chunk: Buffer) => {
    stderrChunks.push(chunk.toString("utf8"));
    // 只留最后一段：出问题时够定位，不把整个日志吞进内存。
    if (stderrChunks.length > 50) stderrChunks.splice(0, stderrChunks.length - 50);
  });

  let closed = false;
  let nextId = 1;
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();

  const failAll = (error: Error) => {
    for (const [id, entryPending] of pending) {
      clearTimeout(entryPending.timer);
      entryPending.reject(error);
      pending.delete(id);
    }
  };

  const lines = readline.createInterface({ input: child.stdout!, crlfDelay: Infinity, terminal: false });
  lines.on("line", (line) => {
    const text = line.trim();
    if (!text) return;
    let message: { id?: unknown; result?: unknown; error?: { message?: string } };
    try {
      message = JSON.parse(text) as typeof message;
    } catch {
      return; // 对方往 stdout 打了调试信息：忽略，不要因此整条连接失败。
    }
    const id = typeof message.id === "number" ? message.id : null;
    if (id === null) return; // 通知（服务端 → 客户端）我们暂时不消费。
    const waiter = pending.get(id);
    if (!waiter) return;
    pending.delete(id);
    clearTimeout(waiter.timer);
    if (message.error) waiter.reject(new Error(message.error.message ?? "MCP 调用失败"));
    else waiter.resolve(message.result);
  });

  const stderrTail = () => stderrChunks.join("").trim().split(/\r?\n/).slice(-3).join(" | ");

  const exited = new Promise<never>((_, reject) => {
    child.on("exit", (code, signal) => {
      closed = true;
      const how = signal ? `信号 ${signal}` : `退出码 ${code ?? "?"}`;
      const tail = stderrTail();
      failAll(new Error(`MCP 服务 ${entry.name} 已退出（${how}）${tail ? `：${tail}` : ""}`));
      reject(new Error(`MCP 服务 ${entry.name} 已退出（${how}）${tail ? `：${tail}` : ""}`));
    });
    child.on("error", (error) => {
      closed = true;
      failAll(error);
      reject(error);
    });
  });
  // 没人 await 这个 Promise 时不要让 Node 报未处理拒绝。
  exited.catch(() => undefined);

  const request = (method: string, params: unknown, waitMs = timeoutMs): Promise<unknown> => {
    if (closed) return Promise.reject(new Error(`MCP 服务 ${entry.name} 已退出`));
    const id = nextId++;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`MCP 服务 ${entry.name} 在 ${waitMs}ms 内没有回应 ${method}`));
      }, waitMs);
      pending.set(id, { resolve, reject, timer });
      child.stdin?.write(`${payload}\n`, (error) => {
        if (!error) return;
        const waiter = pending.get(id);
        if (!waiter) return;
        pending.delete(id);
        clearTimeout(timer);
        waiter.reject(error);
      });
    });
  };

  const notify = (method: string, params: unknown) => {
    if (closed) return;
    child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  };

  let tools: McpToolInfo[] = [];
  try {
    const init = (await request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "heming-cli", version: options.version },
    })) as { protocolVersion?: string } | undefined;
    notify("notifications/initialized", {});
    const listed = (await request("tools/list", {})) as { tools?: unknown } | undefined;
    tools = normalizeTools(listed?.tools);
  } catch (error) {
    try {
      child.kill();
    } catch {
      // 进程可能已经没了：忽略。
    }
    return { ok: false, error: messageOf(error) };
  }

  const connection: McpConnection = {
    server: entry.name,
    tools,
    async callTool(tool, args, waitMs) {
      const result = (await request(
        "tools/call",
        { name: tool, arguments: args ?? {} },
        waitMs ?? timeoutMs,
      )) as { content?: unknown; isError?: boolean } | undefined;
      const text = textOfContent(result?.content);
      return { text: text || "（对方没有返回内容）", isError: result?.isError === true };
    },
    close() {
      closed = true;
      failAll(new Error(`MCP 服务 ${entry.name} 已关闭`));
      lines.close();
      try {
        child.kill();
      } catch {
        // 已经退出时 kill 会抛：忽略。
      }
    },
  };

  return { ok: true, connection };
}

/** 从一段 SSE 文本里挑出 id 对得上的那条 JSON-RPC 回应（其它的跳过，包括通知）。 */
function pickSseMessage(text: string, wantId: number): { result?: unknown; error?: { message?: string } } | null {
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("\n");
    if (!data) continue;
    let message: unknown;
    try {
      message = JSON.parse(data);
    } catch {
      continue; // 非 JSON 的心跳/注释行：忽略。
    }
    if (!message || typeof message !== "object") continue;
    const record = message as { id?: unknown; result?: unknown; error?: { message?: string } };
    if (record.id === wantId) return record;
  }
  return null;
}

/**
 * HTTP 形式的连接（d.339）。
 *
 * 与 stdio 的差别只在传输：每次都 POST 一条 JSON-RPC，回应可能是 JSON，也可能是一段 SSE。
 * 没有长连接，所以 `close()` 只是打个标记——没有进程要收、也没有 socket 要留。
 */
async function connectHttpMcpServer(
  entry: McpServerEntry,
  config: McpHttpConfig,
  options: { version: string; timeoutMs?: number },
): Promise<McpConnectResult> {
  const timeoutMs = options.timeoutMs ?? MCP_CLIENT_TIMEOUT_MS;
  let sessionId: string | null = null;
  let closed = false;
  let nextId = 1;

  const headersOf = (): Record<string, string> => ({
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...(config.headers ?? {}),
    ...(sessionId ? { "mcp-session-id": sessionId } : {}),
  });

  const send = async (body: unknown, waitMs: number, what: string): Promise<unknown> => {
    if (closed) throw new Error(`MCP 服务 ${entry.name} 已关闭`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), waitMs);
    try {
      let response: Response;
      try {
        response = await fetch(config.url, {
          method: "POST",
          headers: headersOf(),
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (error) {
        if ((error as { name?: string }).name === "AbortError") {
          throw new Error(`MCP 服务 ${entry.name} 在 ${waitMs}ms 内没有回应 ${what}`);
        }
        throw new Error(`连不上 MCP 服务 ${entry.name}（${config.url}）：${messageOf(error)}`);
      }
      const nextSession = response.headers.get("mcp-session-id");
      if (nextSession) sessionId = nextSession;
      if (!response.ok) {
        const detail = (await response.text().catch(() => "")).trim().slice(0, 200);
        throw new Error(`MCP 服务 ${entry.name} 返回 HTTP ${response.status}${detail ? `：${detail}` : ""}`);
      }
      let text: string;
      try {
        text = await response.text();
      } catch (error) {
        if ((error as { name?: string }).name === "AbortError") {
          throw new Error(`MCP 服务 ${entry.name} 在 ${waitMs}ms 内没有把 ${what} 的回应读完`);
        }
        throw error;
      }
      const type = (response.headers.get("content-type") ?? "").toLowerCase();
      let message: { result?: unknown; error?: { message?: string } } | null;
      if (type.includes("text/event-stream")) {
        message = pickSseMessage(text, (body as { id?: number }).id ?? -1);
      } else {
        try {
          message = JSON.parse(text) as typeof message;
        } catch {
          message = null;
        }
      }
      if (!message) {
        throw new Error(`MCP 服务 ${entry.name} 的回应看不懂（${what}）：${text.trim().slice(0, 200)}`);
      }
      if (message.error) throw new Error(message.error.message ?? "MCP 调用失败");
      return message.result;
    } finally {
      clearTimeout(timer);
    }
  };

  const request = (method: string, params: unknown, waitMs = timeoutMs): Promise<unknown> =>
    send({ jsonrpc: "2.0", id: nextId++, method, params }, waitMs, method);

  const notify = async (method: string, params: unknown): Promise<void> => {
    try {
      await fetch(config.url, {
        method: "POST",
        headers: headersOf(),
        body: JSON.stringify({ jsonrpc: "2.0", method, params }),
      });
    } catch {
      // 通知发不出去不影响后面：对方最多是少收一条 initialized。
    }
  };

  let tools: McpToolInfo[] = [];
  try {
    await request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "heming-cli", version: options.version },
    });
    await notify("notifications/initialized", {});
    const listed = (await request("tools/list", {})) as { tools?: unknown } | undefined;
    tools = normalizeTools(listed?.tools);
  } catch (error) {
    return { ok: false, error: messageOf(error) };
  }

  const connection: McpConnection = {
    server: entry.name,
    tools,
    async callTool(tool, args, waitMs) {
      const result = (await request(
        "tools/call",
        { name: tool, arguments: args ?? {} },
        waitMs ?? timeoutMs,
      )) as { content?: unknown; isError?: boolean } | undefined;
      const text = textOfContent(result?.content);
      return { text: text || "（对方没有返回内容）", isError: result?.isError === true };
    },
    close() {
      closed = true;
    },
  };

  return { ok: true, connection };
}

/** 把对方的工具清单裁成我们要的形状（坏条目跳过，不因一条坏数据整体失败）。 */
export function normalizeTools(value: unknown): McpToolInfo[] {
  if (!Array.isArray(value)) return [];
  const tools: McpToolInfo[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const name = record.name;
    if (typeof name !== "string" || !name.trim()) continue;
    const tool: McpToolInfo = { name };
    if (typeof record.description === "string" && record.description.trim()) {
      tool.description = record.description.trim();
    }
    if (record.inputSchema && typeof record.inputSchema === "object") {
      tool.inputSchema = record.inputSchema;
    }
    tools.push(tool);
    if (tools.length >= MAX_MCP_TOOLS_PER_SERVER) break;
  }
  // 同一服务内重复名字取第一个（跨服务的同名工具由前缀区分）。
  const seen = new Set<string>();
  return tools.filter((tool) => {
    if (seen.has(tool.name)) return false;
    seen.add(tool.name);
    return true;
  });
}

/** MCP 的 `content` 数组 → 纯文本（只取 text 块，其它类型点名而不假装看懂）。 */
export function textOfContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const record = block as Record<string, unknown>;
    if (record.type === "text" && typeof record.text === "string") parts.push(record.text);
    else if (record.type === "image") parts.push("[图片内容：CLI 不显示图片]");
    else if (typeof record.type === "string") parts.push(`[${record.type} 内容未展开]`);
  }
  return parts.join("\n").trim();
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
