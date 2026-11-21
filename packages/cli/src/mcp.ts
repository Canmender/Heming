/**
 * `heming mcp serve`：把和鸣的文件工具按 MCP（Model Context Protocol）暴露给别的编辑器。
 *
 * 为什么要有这一半：d.237 的 `heming exec` 让**我们**能无头跑；但用户的主场常常是
 * Cursor / Claude Code / 别的 MCP 客户端——它们想读这个仓库时，缺的是一个「标准协议入口」。
 * Codex CLI 有 `codex mcp serve`，这里对齐同一件事：stdio + JSON-RPC 2.0，一行一条消息。
 *
 * 三条刻意选择（都不是随手决定）：
 *
 * 1. **复用 `tooling.ts` 的同一套桥与闸门**。MCP 客户端和人一样没有额外的信任等级：
 *    根外写、危险命令、认不出风险的工具，在这里同样拒绝。两个入口各写一份安全规则，
 *    迟早出现「CLI 拒绝、MCP 放行」的缝。
 * 2. **stdout 只放协议消息**。任何一行裸文本（进度、警告）都会让客户端解析失败并断连；
 *    所以诊断信息一律写 stderr，协议错误也只以 JSON-RPC error 的形式出现。
 * 3. **工具清单就是桥声明的那些**，不额外加 `file_undo` 之类「我们内部用」的入口：
 *    对外暴露得越少，能误伤的范围越小。`run_command` 只在 `--allow-danger` 时出现。
 *
 * 协议版本：客户端请求的版本在支持列表里就照抄，否则回我们支持的最新版本（MCP 规定
 * 由服务端选一个它支持的版本）。2024-11-05 起 `tools/list` 的形状一直没变，所以三个版本
 * 共用同一份实现。
 *
 * d.325 起除了工具还暴露两类**只读**内容：`prompts/list` + `prompts/get`（工作区
 * `.heming/commands/*.md`，用户能直接在编辑器里选用），`resources/list` + `resources/read`
 * （命令文件、AGENTS.md 一族、`.heming` 三份配置）。采集在 `mcpCatalog.ts`，这里只做协议翻译。
 */

import type { ToolBridge } from "../../../packages/web/src/lib/agentStream.js";
import type { ToolConfirmFn } from "./tooling.js";
import {
  MCP_RESOURCE_PREFIX,
  MCP_RESOURCE_TEMPLATE_URI,
  describeCliMcpCatalog,
  describeResourceTemplates,
  relOfResourceUri,
  type McpCatalog,
  type McpResourceTemplate,
  type WorkspaceResourceRead,
} from "./mcpCatalog.js";

/** 报错文案里点名的命令目录（与桌面端同一份口径）。 */
const CUSTOM_COMMANDS_HINT = ".heming/commands/*.md";

/** serverInfo.name：客户端日志里会显示它，用包名而不是「和鸣」，便于排查。 */
export const MCP_SERVER_NAME = "heming";

/** 支持协商的协议版本（新 → 旧）。 */
export const MCP_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;

/** 客户端要的版本我们不认识时回这个。 */
export const MCP_DEFAULT_PROTOCOL_VERSION: string = "2025-06-18";

/** JSON-RPC 2.0 的标准错误码（只用到这五个）。 */
export const MCP_ERROR = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
} as const;

/** 一条请求里我们真正会读的字段（其余忽略）。 */
export interface McpRequest {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

export interface McpErrorBody {
  code: number;
  message: string;
  data?: unknown;
}

/** JSON-RPC 响应：`id` 原样回传（字符串/数字都行；通知没有响应）。 */
export type McpResponse =
  | { jsonrpc: "2.0"; id: string | number | null; result: unknown }
  | { jsonrpc: "2.0"; id: string | number | null; error: McpErrorBody };

/** 一个工具在 MCP 里的描述（`inputSchema` 直接复用 OpenAI 的 parameters）。 */
export interface McpToolDescriptor {
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    /** 会碰网络/外部系统的工具（本机文件工具都是 false，命令工具是 true）。 */
    openWorldHint?: boolean;
  };
}

/** 处理一条消息需要的全部依赖（没有进程全局状态，测试可注入）。 */
export interface McpContext {
  tools: ToolBridge;
  confirm: ToolConfirmFn;
  /** `@heming/cli` 的版本，报给客户端的 serverInfo。 */
  version: string;
  /** 工作区（也是唯一可写根），写进 instructions 与工具描述。 */
  cwd: string;
  allowDanger: boolean;
  /**
   * 只读模式：`tools/list` 只报自报只读的工具。
   *
   * 为什么不「照常列出、调用时再拒」：编辑器会把这些工具直接摆进它的工具面板，
   * 列出来就等于承诺「这个能写」。只读模式是给「让我看看它想干什么」用的，
   * 那就不该把写能力挂在别人机器上的菜单里。
   */
  readOnly?: boolean;
  /**
   * 工作区里的提示词与资源（`.heming/commands/*.md`、AGENTS.md 一族、三份配置）。
   *
   * 是个函数而不是一份快照：`mcp serve` 是长驻进程，用户中途改了命令文件，
   * 下一次 `prompts/list` 就该看到新版本。缺省（`undefined`）= 不暴露这两类能力，
   * `initialize` 里也就不会声明它们。
   */
  catalog?: () => Promise<McpCatalog>;
  /**
   * 资源模板的读取入口（d.342）。
   *
   * 固定名单之外，这个服务还提供一条模板 `heming://workspace/{path}`：客户端把 `path`
   * 换成本工作区里的相对路径，就要求读那份文件。真正的读盘在 `mcpCatalog.ts` 的
   * `readWorkspaceResource`，这里只留一个函数位，好处是协议层仍然不认识文件系统。
   *
   * 缺省（`undefined`）= 不暴露模板：`resources/templates/list` 回空表，
   * 读模板 URI 会得到「未知资源」而不是静默失败。
   */
  readResource?: (uri: string) => Promise<WorkspaceResourceRead>;
  /**
   * 资源的订阅登记（d.327）：客户端 `resources/subscribe` 之后，文件一变就该收到
   * `notifications/resources/updated`。缺省 = 不跟踪变化，`resources/subscribe`
   * 会明确回「这个服务没有跟踪资源变化」，而不是收下就装作答应了。
   */
  subscriptions?: McpResourceSubscriptions;
  /**
   * 主动推送一条 JSON-RPC 通知（没有 id，客户端不回包）。
   *
   * 只有 stdio 主循环知道自己往哪儿写，所以由它注入；纯协议层只负责组装消息。
   */
  notify?: (message: McpNotification) => void;
}

/** 一条服务端主动通知：`notifications/resources/updated` 之类。 */
export interface McpNotification {
  method: string;
  params: Record<string, unknown>;
}

/** 订阅登记的最小接口（真正的 watcher 在 `mcpWatch.ts`，这里只认这两个动作）。 */
export interface McpResourceSubscriptions {
  subscribe(uri: string): void;
  unsubscribe(uri: string): void;
}

/** 从 OpenAI 风格的 tools 数组里取出 `{type:"function", function:{...}}` 的 name/描述/参数。 */
function toDescriptor(spec: unknown, meta?: { risk?: string; displayName?: string }): McpToolDescriptor | null {
  if (!spec || typeof spec !== "object") return null;
  const fn = (spec as { function?: unknown }).function;
  if (!fn || typeof fn !== "object") return null;
  const { name, description, parameters } = fn as {
    name?: unknown;
    description?: unknown;
    parameters?: unknown;
  };
  if (typeof name !== "string" || !name) return null;
  const schema =
    parameters && typeof parameters === "object" && !Array.isArray(parameters)
      ? (parameters as Record<string, unknown>)
      : { type: "object", properties: {}, additionalProperties: true };
  const risk = meta?.risk;
  return {
    name,
    ...(typeof meta?.displayName === "string" && meta.displayName ? { title: meta.displayName } : {}),
    description:
      typeof description === "string" && description.trim() ? description : `${name}（没有描述）`,
    inputSchema: schema,
    // 先由桥自己声明的风险定性：read=只读、danger=能碰外部系统、其余（写）=有破坏性。
    ...(risk === "read"
      ? { annotations: { readOnlyHint: true, destructiveHint: false } }
      : risk === "danger"
        ? { annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true } }
        : {}),
  };
}

/** 当前可用的工具清单（每次 `tools/list` 现算：桥的工具是静态的，这里不做缓存以便测试替换）。 */
export function describeMcpTools(ctx: McpContext): McpToolDescriptor[] {
  const out: McpToolDescriptor[] = [];
  for (const spec of ctx.tools.tools) {
    const name = (spec as { function?: { name?: unknown } })?.function?.name;
    const meta = typeof name === "string" ? ctx.tools.meta?.(name) : undefined;
    // 只读模式：只报自报只读的工具。没声明风险的工具同样不报——宁缺勿滥。
    if (ctx.readOnly === true && meta?.risk !== "read") continue;
    const descriptor = toDescriptor(spec, meta);
    if (descriptor) out.push(descriptor);
  }
  return out;
}

/** 初始化回执里给客户端的一段说明：它决定客户端会不会「先问我再动手」。 */
function instructionsText(ctx: McpContext, catalogLine = ""): string {
  const tools = describeMcpTools(ctx).map((tool) => tool.name);
  return [
    `这是和鸣（heming）的本地工具服务：工具直接操作 ${ctx.cwd} 下的文件。`,
    `可写范围只有这个工作区（写根外一律拒绝），删除、改可执行文件这类高风险写也会被拒绝。`,
    ctx.readOnly === true
      ? "这次是只读模式（--read-only）：只暴露读取类工具，写与命令都没有开放，调用它们会失败且不会改动任何文件。"
      : ctx.allowDanger
        ? "已用 --allow-danger 启动：run_command 会真的在本机执行命令。"
        : "没有 run_command：要跑命令必须由用户用 --allow-danger 重新启动，这不是重试能解决的问题。",
    `当前工具：${tools.join("、") || "（无）"}。`,
    ...(catalogLine ? [catalogLine] : []),
    ...(ctx.readResource
      ? [
          `资源模板：resources/templates/list 里有 ${MCP_RESOURCE_TEMPLATE_URI}，把 {path} 换成本工作区内的相对路径就能读任意文本文件（只读，不是文本会说明原因）。`,
        ]
      : []),
    ...(ctx.subscriptions
      ? ["资源可以订阅：resources/subscribe 之后，工作区里的文件一变就会收到 notifications/resources/updated，不必轮询，也不必重启客户端。"]
      : []),
  ].join("\n");
}

/** 取一次工作区目录；取不到（没配、或读盘出错）就当没有，绝不因此让 initialize 失败。 */
async function catalogOf(ctx: McpContext): Promise<McpCatalog | null> {
  if (!ctx.catalog) return null;
  try {
    return await ctx.catalog();
  } catch {
    return null;
  }
}

/** 协议版本协商：认识就用客户端的，不认识就回我们最新的那个。 */
export function negotiateProtocolVersion(requested: unknown): string {
  return typeof requested === "string" && (MCP_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
    ? requested
    : MCP_DEFAULT_PROTOCOL_VERSION;
}

function errorResponse(id: string | number | null, code: number, message: string, data?: unknown): McpResponse {
  return { jsonrpc: "2.0", id, error: { code, message, ...(data !== undefined ? { data } : {}) } };
}

function okResponse(id: string | number | null, result: unknown): McpResponse {
  return { jsonrpc: "2.0", id, result };
}

/** 把 `id` 归一成 JSON-RPC 允许的形状；对象/数组/布尔一律当非法。 */
function normalizeId(value: unknown): string | number | null | undefined {
  if (typeof value === "string" || typeof value === "number") return value;
  if (value === null) return null;
  return undefined;
}

/** 执行一次 `tools/call` 的结果：要么给客户端一段文本，要么说明「请求本身写错了」。 */
type ToolCallOutcome =
  | { kind: "result"; text: string; isError: boolean }
  | { kind: "badParams"; message: string };

/**
 * 执行一次 `tools/call`。
 *
 * 顺序是「先闸门、再执行」——与 CLI 的模式完全一致：闸门拒绝时**不碰磁盘**，
 * 返回的是一句「未执行」而不是半截异常，客户端才能把它当工具结果展示给用户。
 */
async function callTool(ctx: McpContext, params: unknown): Promise<ToolCallOutcome> {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return { kind: "badParams", message: "tools/call 需要 params：{ name, arguments }" };
  }
  const { name, arguments: rawArgs } = params as { name?: unknown; arguments?: unknown };
  if (typeof name !== "string" || !name.trim()) {
    return { kind: "badParams", message: "tools/call 缺少工具名 name" };
  }
  const toolName = name.trim();
  const available = describeMcpTools(ctx).map((tool) => tool.name);
  if (!available.includes(toolName)) {
    return {
      kind: "badParams",
      message: `未知工具：${toolName}（本机只提供：${available.join("、") || "无"}）`,
    };
  }

  let argObject: Record<string, unknown> = {};
  if (rawArgs !== undefined && rawArgs !== null) {
    if (typeof rawArgs !== "object" || Array.isArray(rawArgs)) {
      return { kind: "badParams", message: "tools/call 的 arguments 必须是对象" };
    }
    argObject = rawArgs as Record<string, unknown>;
  }
  const argsJson = JSON.stringify(argObject);

  const call = {
    id: `mcp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    function: { name: toolName, arguments: argsJson },
  };
  const outcomes = await ctx.confirm([call]);
  const outcome = outcomes[0];
  if (!outcome) {
    return { kind: "result", text: "未执行：闸门没有给出结论（内部错误）", isError: true };
  }
  if (outcome.kind === "deny") {
    return {
      kind: "result",
      text: `未执行：${outcome.reason}\n【该操作未执行，文件与系统状态未被修改】`,
      isError: true,
    };
  }

  const result = await ctx.tools.execute({ name: toolName, arguments: argsJson });
  return { kind: "result", text: result.text, isError: result.ok !== true };
}

/** 把一条请求派发成响应（`null` = 通知，不回任何东西）。 */
export async function handleMcpRequest(request: McpRequest, ctx: McpContext): Promise<McpResponse | null> {
  const hasId = Object.prototype.hasOwnProperty.call(request, "id");
  const normalizedId = normalizeId(request.id);
  if (hasId && normalizedId === undefined) {
    return errorResponse(null, MCP_ERROR.invalidRequest, "id 必须是字符串、数字或 null");
  }
  // 走到这里 id 一定合法（undefined 只可能来自非法 id，已在上面挡掉）。
  const id: string | number | null = normalizedId ?? null;
  const method = request.method;
  if (typeof method !== "string" || !method) {
    return hasId ? errorResponse(id, MCP_ERROR.invalidRequest, "缺少 method") : null;
  }

  // 通知：没有 id，按协议绝不回包（回了会让客户端以为收到一条奇怪的响应）。
  if (!hasId) return null;

  switch (method) {
    case "initialize": {
      const params = (request.params ?? {}) as { protocolVersion?: unknown; clientInfo?: unknown };
      const catalog = await catalogOf(ctx);
      const capabilities: Record<string, unknown> = { tools: { listChanged: false } };
      if (catalog) {
        // listChanged 只在真会推送时才声明：答应了却不推，客户端会一直等。
        const canPush = typeof ctx.notify === "function";
        capabilities.prompts = { listChanged: canPush };
        capabilities.resources = { listChanged: canPush, subscribe: ctx.subscriptions !== undefined };
      } else if (ctx.readResource) {
        /*
         * 没有固定名单、但有模板时，resources 这一项仍然要声明：MCP 客户端只有看到
         * `resources` 能力才会去问 `resources/templates/list`。模板本身不推送，所以
         * listChanged 是 false；不跟踪文件变化，因此不给 subscribe。
         */
        capabilities.resources = { listChanged: false };
      }
      return okResponse(id, {
        protocolVersion: negotiateProtocolVersion(params.protocolVersion),
        capabilities,
        serverInfo: { name: MCP_SERVER_NAME, title: "和鸣", version: ctx.version },
        instructions: instructionsText(ctx, catalog ? describeCliMcpCatalog(catalog) : ""),
      });
    }
    case "ping":
      return okResponse(id, {});
    case "tools/list":
      return okResponse(id, { tools: describeMcpTools(ctx) });
    case "tools/call": {
      const outcome = await callTool(ctx, request.params);
      if (outcome.kind === "badParams") {
        return errorResponse(id, MCP_ERROR.invalidParams, outcome.message);
      }
      return okResponse(id, {
        content: [{ type: "text", text: outcome.text }],
        ...(outcome.isError ? { isError: true } : {}),
      });
    }
    case "prompts/list": {
      const catalog = await catalogOf(ctx);
      if (!catalog) return noCatalog(id, "prompts");
      return okResponse(id, {
        prompts: catalog.prompts.map((prompt) => ({
          name: prompt.name,
          ...(prompt.title ? { title: prompt.title } : {}),
          ...(prompt.description ? { description: prompt.description } : {}),
        })),
      });
    }
    case "prompts/get": {
      const catalog = await catalogOf(ctx);
      if (!catalog) return noCatalog(id, "prompts");
      const params = (request.params ?? {}) as { name?: unknown };
      const name = typeof params.name === "string" ? params.name.trim().toLowerCase() : "";
      if (!name) return errorResponse(id, MCP_ERROR.invalidParams, "prompts/get 需要 name（提示词名）");
      const prompt = catalog.prompts.find((entry) => entry.name === name);
      if (!prompt) {
        const available = catalog.prompts.map((entry) => entry.name).join("、") || "无";
        return errorResponse(
          id,
          MCP_ERROR.invalidParams,
          `未知提示词：${name}（这个工作区只有：${available}；它们来自 ${CUSTOM_COMMANDS_HINT}）`,
        );
      }
      return okResponse(id, {
        ...(prompt.description ? { description: prompt.description } : {}),
        messages: [{ role: "user", content: { type: "text", text: prompt.text } }],
      });
    }
    case "resources/templates/list": {
      /*
       * 模板与固定名单是两套：名单是「这个仓库里那几份规矩」，模板是「把任意文件当资源读」。
       * 没有开放模板时回空表而不是报错——客户端问「有哪些模板」是正常动作，空表就是答案。
       */
      const templates: McpResourceTemplate[] = ctx.readResource ? describeResourceTemplates() : [];
      return okResponse(id, { resourceTemplates: templates });
    }
    case "resources/list": {
      const catalog = await catalogOf(ctx);
      if (!catalog) return noCatalog(id, "resources");
      return okResponse(id, {
        resources: catalog.resources.map((resource) => ({
          uri: resource.uri,
          name: resource.name,
          ...(resource.title ? { title: resource.title } : {}),
          ...(resource.description ? { description: resource.description } : {}),
          mimeType: resource.mimeType,
        })),
      });
    }
    case "resources/read": {
      const catalog = await catalogOf(ctx);
      const params = (request.params ?? {}) as { uri?: unknown };
      const uri = typeof params.uri === "string" ? params.uri.trim() : "";
      if (!uri) return errorResponse(id, MCP_ERROR.invalidParams, "resources/read 需要 uri");
      /*
       * 先查固定名单：那几份文件的内容已经在采集时读好了，直接回。
       * 名单里没有、但客户端填的是模板 URI 时，再走一次真正的读盘（d.342）。
       */
      const resource = catalog?.resources.find((entry) => entry.uri === uri);
      if (resource) {
        return okResponse(id, {
          contents: [{ uri: resource.uri, mimeType: resource.mimeType, text: resource.text }],
        });
      }
      if (ctx.readResource && uri.startsWith(MCP_RESOURCE_PREFIX)) {
        const read = await ctx.readResource(uri);
        if (read.ok) {
          return okResponse(id, {
            contents: [{ uri: read.uri, mimeType: read.mimeType, text: read.text }],
          });
        }
        return errorResponse(
          id,
          MCP_ERROR.invalidParams,
          `${read.reason}（模板用法见 resources/templates/list；只能读这个工作区里的文本文件）`,
        );
      }
      if (!catalog) return noCatalog(id, "resources");
      return errorResponse(
        id,
        MCP_ERROR.invalidParams,
        `未知资源：${uri}（先 resources/list 看看这个工作区有哪些；只暴露命令文件、AGENTS.md 一族与三份 .heming 配置，` +
          "任意文本文件请按资源模板 heming://workspace/{path} 来读）",
      );
    }
    /*
     * 订阅：客户端说「这个资源变了告诉我」。收下之前必须确认它真在名单里，
     * 否则等于答应了一件不会发生的事（名单外的 URI 永远不会被推送）。
     */
    case "resources/subscribe": {
      const catalog = await catalogOf(ctx);
      if (!catalog) return noCatalog(id, "resources");
      if (!ctx.subscriptions) {
        return errorResponse(
          id,
          MCP_ERROR.methodNotFound,
          "这个服务没有跟踪资源变化（没有开启订阅），resources/subscribe 收不了；请改用 resources/read 主动读",
        );
      }
      const params = (request.params ?? {}) as { uri?: unknown };
      const uri = typeof params.uri === "string" ? params.uri.trim() : "";
      if (!uri) return errorResponse(id, MCP_ERROR.invalidParams, "resources/subscribe 需要 uri");
      const known = catalog.resources.find((entry) => entry.uri === uri);
      // 资源模板 heming://workspace/{path} 也是本服务声明、能读、且 watcher 真会跟踪的 URI
      // （见 mcpWatch.ts 的 relOfResourceUri）：客户端刚读成功的文件就该能订上变更。
      // 用与 watcher 同一个判定，避免"读得到却订不上"；仍不认识的 URI 照旧拒绝。
      const isTemplate = Boolean(ctx.readResource && relOfResourceUri(uri) !== null);
      if (!known && !isTemplate) {
        const available = catalog.resources.map((entry) => entry.uri).join("、") || "无";
        return errorResponse(
          id,
          MCP_ERROR.invalidParams,
          `未知资源：${uri}（只能订阅 resources/list 里有的；这个工作区有：${available}）`,
        );
      }
      ctx.subscriptions.subscribe(uri);
      return okResponse(id, {});
    }
    case "resources/unsubscribe": {
      if (!ctx.subscriptions) {
        return errorResponse(id, MCP_ERROR.methodNotFound, "这个服务没有跟踪资源变化，没有什么可取消的");
      }
      const params = (request.params ?? {}) as { uri?: unknown };
      const uri = typeof params.uri === "string" ? params.uri.trim() : "";
      if (!uri) return errorResponse(id, MCP_ERROR.invalidParams, "resources/unsubscribe 需要 uri");
      // 取消订阅是幂等的：本来没订也回成功，客户端断线重连时不必先查一遍。
      ctx.subscriptions.unsubscribe(uri);
      return okResponse(id, {});
    }
    default:
      return errorResponse(
        id,
        MCP_ERROR.methodNotFound,
        `未知方法：${method}（本服务支持 initialize / ping / tools/list / tools/call / prompts/list / prompts/get / resources/list / resources/templates/list / resources/read / resources/subscribe / resources/unsubscribe）`,
      );
  }
}

/** 没有暴露这类能力时的统一回执：说清「为什么没有」，而不是一句冷冰冰的 methodNotFound。 */
function noCatalog(id: string | number | null, kind: "prompts" | "resources"): McpResponse {
  const hint =
    kind === "prompts"
      ? `没有可用的提示词：工作区里没有 ${CUSTOM_COMMANDS_HINT}`
      : "没有可用的资源：工作区里没有命令文件、AGENTS.md 一族或 .heming 配置";
  return errorResponse(id, MCP_ERROR.methodNotFound, `${hint}（这个服务没有暴露 ${kind}）`);
}

/**
 * 处理一行（stdin 的一条消息）。返回要写回的行（含换行）或 `null`。
 *
 * 解析失败也**不抛**：CLI 是长驻进程，一条坏消息不该让整个会话断掉；按规范回 -32700，
 * 客户端会自己决定要不要重试。
 */
export async function handleMcpLine(line: string, ctx: McpContext): Promise<string | null> {
  const trimmed = line.trim();
  if (!trimmed) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    const body = errorResponse(
      null,
      MCP_ERROR.parse,
      `解析失败：${error instanceof Error ? error.message : String(error)}`,
    );
    return `${JSON.stringify(body)}\n`;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return `${JSON.stringify(errorResponse(null, MCP_ERROR.invalidRequest, "消息必须是一个 JSON 对象"))}\n`;
  }

  const request = parsed as McpRequest;
  try {
    const response = await handleMcpRequest(request, ctx);
    return response ? `${JSON.stringify(response)}\n` : null;
  } catch (error) {
    const id = normalizeId(request.id) ?? null;
    const body = errorResponse(
      id,
      MCP_ERROR.internal,
      `内部错误：${error instanceof Error ? error.message : String(error)}`,
    );
    return `${JSON.stringify(body)}\n`;
  }
}

export interface McpServeOptions {
  /** 消息只能来自 stdin：MCP 的 stdio 传输就是这么定义的。 */
  input: NodeJS.ReadableStream;
  output: { write: (chunk: string) => unknown };
  /** 诊断（启动提示、错误）走这里，绝不混进 stdout。 */
  error: (line: string) => void;
  ctx: McpContext;
}

/**
 * stdio 主循环：逐条读、逐条处理、逐条写回。
 *
 * 串行而不是并发：stdio 上并发回包会让「谁先到」依赖时序，客户端调试困难；
 * 单机工具调用本来也没有并发收益（写同一个文件还可能互相打架）。
 *
 * 正常结束只有一种：stdin 关了（客户端退出/断连）。返回 0 不是「成功干完了什么」，
 * 而是「按协议正常收工」——MCP 客户端看的是有没有回包，不是退出码。
 */
export async function serveMcp(options: McpServeOptions): Promise<number> {
  const readline = await import("node:readline");
  const rl = readline.createInterface({ input: options.input, crlfDelay: Infinity, terminal: false });

  for await (const line of rl) {
    const text = typeof line === "string" ? line : String(line);
    const response = await handleMcpLine(text, options.ctx);
    if (response) options.output.write(response);
  }
  rl.close();
  options.error("[heming] mcp serve 结束（stdin 已关闭）。\n");
  return 0;
}
