/**
 * 本机 HTTP 服务：REST API（`/api/*`）+ MCP（`/mcp`）+ 静态编辑器（`public/`）。
 *
 * 设计边界：
 * - 只绑定 127.0.0.1（由 main.ts 传 host），不对外网开放；
 * - CORS 按来源白名单（和鸣客户端/本机页面/无 Origin；陌生网页 403，见 1.0.1 自检修复）；
 * - 业务错误统一 `{ok:false,error}` 且永远不把请求头/请求体写进错误或日志；
 * - 执行查询先看 Runtime 的内存态（进行中）再看 Store（历史），UI 靠这个轮询；
 * - `/mcp` 的 JSON-RPC 细节全在 `mcp.ts`，本文件只负责传输（body/头部/状态码）。
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { listNodeTypes } from "../registry.js";
import { normalizeWorkflow, validateWorkflow } from "../model.js";
import { findWorkflowTemplate, WORKFLOW_TEMPLATES } from "../nodes/templates.js";
import type { Item, Workflow, WorkflowNode } from "../types.js";
import type { WorkflowConfig } from "./config.js";
import { CREDENTIAL_TYPES } from "./credentials.js";
import {
  beginExecution,
  createMcpHandler,
  executionSummary,
  exportWorkflow,
  importWorkflow,
  isPlainObject,
  listExecutionSummaries,
  listWorkflowSummaries,
  normalizeItems,
  publicSettings,
  resolveExecution,
  type McpCallInput,
  type McpCallOutput,
} from "./mcp.js";
import type { Runtime } from "./runtime.js";
import { discoverMcpTools, nodeTypeDetail, runWorkflowTest, searchWorkflows } from "./agentTools.js";
import { generateWorkflow } from "./aiBuilder.js";
import type { SettingsPatch, Store } from "./storage.js";

/** JSON 请求体上限：5MB（执行记录的输入数据也够用，超过基本是误用）。 */
export const MAX_JSON_BODY_BYTES = 5 * 1024 * 1024;

/** 静态文件 MIME 表（只列编辑器用得到的类型；未知按 octet-stream）。 */
const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

export interface HttpServerOptions {
  store: Store;
  runtime: Runtime;
  /**
   * 调度器（`createScheduler` 的返回值）。用 `unknown` 收口：
   * 调度器由 wf-engine 维护，健康检查只读它的 running 状态，
   * 这样两边接口微调时不会让整项目 typecheck 互相卡死。
   */
  scheduler?: unknown;
  config: WorkflowConfig;
  version?: string;
}

/** 路由层用来表示「带状态码的错误」。 */
class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

interface HandlerContext {
  store: Store;
  runtime: Runtime;
  scheduler?: unknown;
  config: WorkflowConfig;
  version: string;
  startedAt: number;
  mcp(input: McpCallInput): Promise<McpCallOutput>;
}

// ---------------------------------------------------------------------------
// 响应小工具
// ---------------------------------------------------------------------------

/**
 * 允许跨域访问的来源白名单（本机服务没有登录态，CORS 就是唯一闸门）。
 *
 * 为什么不能继续用 `*`：任何网页都能 fetch 到 `http://127.0.0.1:8777`；带上
 * `Access-Control-Allow-Origin: *` 就等于「你浏览的任意网站都能读你的工作流、
 * 改配置、触发带凭据的 HTTP 节点」。这里只放行：
 * - 和鸣桌面端渲染层（`app://heming`，自定义协议）；
 * - 本机 http(s) 的 localhost / 127.0.0.1 / [::1]（编辑器开发预览与 MCP 客户端）；
 * - 无 Origin 的请求（curl、MCP 服务到服务调用）。
 * 其余来源返回 403，且**不回** CORS 头。
 */
function isAllowedOrigin(origin: string): boolean {
  if (origin === "app://heming") return true;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const host = url.hostname;
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}

/** 挂 CORS 头；有 Origin 时回显它（配合 Vary: Origin），无 Origin 的客户端给 `*`。 */
function applyCors(res: ServerResponse, origin = ""): void {
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  } else {
    res.setHeader("Access-Control-Allow-Origin", "*");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "content-type, accept, mcp-session-id, mcp-protocol-version, authorization",
  );
  res.setHeader("Access-Control-Expose-Headers", "mcp-session-id, content-type");
  res.setHeader("Access-Control-Max-Age", "600");
  res.setHeader("X-Content-Type-Options", "nosniff");
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  if (res.writableEnded) return;
  const text = JSON.stringify(value ?? null);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Length", Buffer.byteLength(text));
  res.end(text);
}

function sendEmpty(res: ServerResponse, status: number): void {
  if (res.writableEnded) return;
  res.statusCode = status;
  res.setHeader("Content-Length", "0");
  res.end();
}

// ---------------------------------------------------------------------------
// 请求体读取
// ---------------------------------------------------------------------------

/** 读原始 body；超过上限直接 413（先声明长度时不必收完整个 body）。 */
function readRawBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolveBody, rejectBody) => {
    const declaredRaw = req.headers["content-length"];
    const declared = typeof declaredRaw === "string" ? Number(declaredRaw) : Number.NaN;
    if (Number.isFinite(declared) && declared > limit) {
      req.resume(); // 丢掉剩余数据，避免连接卡住
      rejectBody(new HttpError(413, `请求体超过 ${Math.round(limit / 1024 / 1024)}MB 上限`));
      return;
    }
    const chunks: Buffer[] = [];
    let total = 0;
    let failed = false;
    req.on("data", (chunk: Buffer) => {
      if (failed) return;
      total += chunk.length;
      if (total > limit) {
        failed = true;
        req.resume();
        rejectBody(new HttpError(413, `请求体超过 ${Math.round(limit / 1024 / 1024)}MB 上限`));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (failed) return;
      resolveBody(Buffer.concat(chunks));
    });
    req.on("error", (error) => {
      if (failed) return;
      failed = true;
      rejectBody(error);
    });
  });
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const buffer = await readRawBody(req, MAX_JSON_BODY_BYTES);
  if (buffer.length === 0) return undefined;
  let text: string;
  try {
    text = buffer.toString("utf8");
  } catch {
    throw new HttpError(400, "请求体不是合法的 UTF-8 文本");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new HttpError(400, "请求体不是合法 JSON");
  }
}

async function readJsonObject(req: IncomingMessage): Promise<Record<string, unknown>> {
  const parsed = await readJson(req);
  if (parsed === undefined) return {};
  if (!isPlainObject(parsed)) throw new HttpError(400, "请求体必须是 JSON 对象");
  return parsed;
}


// ---------------------------------------------------------------------------
// Webhook 触发
// ---------------------------------------------------------------------------

interface WebhookMatch {
  workflow: Workflow;
  node: WorkflowNode;
}

function webhookPathOf(node: WorkflowNode): string {
  const raw = node.parameters.path;
  const custom = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return custom || "";
}

/** 找到匹配路径 + 方法 + 启用状态的工作流触发器；同路径多条视为配置冲突。 */
function findWebhookWorkflows(store: Store, path: string): WebhookMatch[] {
  const matches: WebhookMatch[] = [];
  for (const workflow of store.listWorkflows()) {
    if (!workflow.active) continue;
    for (const node of workflow.nodes) {
      if (node.type !== "webhookTrigger" || node.disabled) continue;
      const effective = webhookPathOf(node) || workflow.id;
      if (effective === path) matches.push({ workflow, node });
    }
  }
  return matches;
}

function webhookMethodOf(node: WorkflowNode): string {
  const raw = node.parameters.method;
  return typeof raw === "string" && raw.trim() ? raw.trim().toUpperCase() : "POST";
}

/** 请求体 → items：数组按条展开，对象作为一条，空体给一条 {}。 */
function webhookItems(payload: unknown): Item[] {
  if (Array.isArray(payload)) {
    const items = payload
      .filter((entry): entry is Record<string, unknown> => isPlainObject(entry))
      .map((entry) => ({ json: entry }));
    return items.length > 0 ? items : [{ json: {} }];
  }
  if (isPlainObject(payload)) return [{ json: payload }];
  return [{ json: {} }];
}

async function handleWebhook(
  ctx: HandlerContext,
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  url: URL,
): Promise<void> {
  const prefix = "/webhook/";
  const path = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length).split("/")[0] : "";
  if (!path) throw new HttpError(404, "Webhook 路径为空");

  const matches = findWebhookWorkflows(ctx.store, decodeURIComponent(path));
  if (matches.length === 0) throw new HttpError(404, "Webhook 不存在或未启用");
  if (matches.length > 1) throw new HttpError(409, "Webhook 路径冲突：多条已启用工作流使用同一路径");

  const { workflow, node } = matches[0];
  const expectedMethod = webhookMethodOf(node);
  if (method !== expectedMethod) throw new HttpError(405, `该 Webhook 只接受 ${expectedMethod} 请求`);

  const token = typeof node.parameters.authToken === "string" ? node.parameters.authToken.trim() : "";
  if (token) {
    const headerToken = req.headers["x-webhook-token"];
    const provided =
      (Array.isArray(headerToken) ? headerToken[0] : headerToken) ?? url.searchParams.get("token") ?? "";
    // 长度一致 + 恒定时间比较，避免把令牌泄露给计时侧信道。
    if (provided.length !== token.length || !timingSafeEqual(Buffer.from(provided), Buffer.from(token))) {
      throw new HttpError(401, "Webhook 访问令牌不正确");
    }
  }

  const payload = method === "GET" ? Object.fromEntries(url.searchParams.entries()) : await readJson(req);
  const inputData = webhookItems(payload);
  if (ctx.runtime.isRunning(workflow.id)) {
    throw new HttpError(409, `工作流「${workflow.name}」正在运行，等它结束再试`);
  }
  try {
    const { executionId } = await beginExecution(ctx.store, ctx.runtime, workflow, {
      mode: "trigger",
      startNodeId: node.id,
      inputData,
    });
    sendJson(res, 202, { ok: true, executionId, workflowId: workflow.id });
  } catch (error) {
    throw new HttpError(409, errorMessage(error));
  }
}

// ---------------------------------------------------------------------------
// 路由小工具
// ---------------------------------------------------------------------------


function requireMethod(method: string, expected: string): void {
  if (method !== expected) throw new HttpError(405, `该接口只支持 ${expected} 请求`);
}

function getWorkflowOr404(store: Store, id: string): Workflow {
  const workflow = store.getWorkflow(id);
  if (!workflow) throw new HttpError(404, `工作流不存在：${id}`);
  return workflow;
}

function parseLimit(raw: string | null, fallback: number): number {
  if (raw === null || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(200, Math.max(1, Math.trunc(value)));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface SchedulerStatusLike {
  running?: unknown;
  status?: unknown;
  isRunning?: unknown;
}

/** 健康检查用：兼容 `scheduler.running` getter / `status().running` / `isRunning()` 三种形状。 */
function schedulerRunning(scheduler: unknown): boolean {
  if (!scheduler || typeof scheduler !== "object") return false;
  const candidate = scheduler as SchedulerStatusLike;
  if (typeof candidate.running === "boolean") return candidate.running;
  if (typeof candidate.status === "function") {
    try {
      const status = (candidate.status as () => unknown)();
      if (typeof status === "boolean") return status;
      if (isPlainObject(status) && typeof status.running === "boolean") return status.running;
    } catch {
      /* 调度器状态读不到就当未运行 */
    }
  }
  if (typeof candidate.isRunning === "function") {
    try {
      return Boolean((candidate.isRunning as () => unknown)());
    } catch {
      return false;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// API 处理
// ---------------------------------------------------------------------------

async function handleApi(
  ctx: HandlerContext,
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  pathname: string,
  searchParams: URLSearchParams,
): Promise<void> {
  const segments = pathname.split("/").filter(Boolean);
  const parts = segments.slice(1); // 去掉 "api"
  const resource = parts[0] ?? "";

  switch (resource) {
    case "health": {
      requireMethod(method, "GET");
      sendJson(res, 200, {
        ok: true,
        version: ctx.version,
        uptimeMs: Date.now() - ctx.startedAt,
        scheduler: { running: schedulerRunning(ctx.scheduler) },
      });
      return;
    }

    case "node-types": {
      requireMethod(method, "GET");
      // /api/node-types/:type 返回单个节点的完整参数 schema（供 UI / 智能体调参）
      const single = parts[1];
      if (single) {
        const detail = nodeTypeDetail(single);
        if (!detail) throw new HttpError(404, `未知节点类型：${single}`);
        sendJson(res, 200, detail);
        return;
      }
      sendJson(
        res,
        200,
        listNodeTypes().map((nodeType) => nodeType.description),
      );
      return;
    }

    case "ai": {
      // /api/ai/workflow：自然语言生成工作流（默认不保存）
      if (parts[1] === "workflow") {
        requireMethod(method, "POST");
        const body = await readJsonObject(req);
        if (typeof body.request !== "string" || !body.request.trim()) {
          throw new HttpError(400, "request 必须是字符串");
        }
        try {
          const generated = await generateWorkflow({
            request: body.request,
            ...(typeof body.name === "string" ? { name: body.name } : {}),
          });
          const errors = generated.issues.filter((issue) => issue.level === "error");
          if (body.save === true) {
            if (errors.length > 0) {
              sendJson(res, 400, { ok: false, error: "生成结果还有错误，不能保存", issues: generated.issues });
              return;
            }
            const saved = ctx.store.saveWorkflow(generated.workflow);
            sendJson(res, 200, { ...generated, saved: true, workflowId: saved.id });
            return;
          }
          sendJson(res, 200, { ...generated, saved: false });
        } catch (error) {
          throw new HttpError(400, errorMessage(error));
        }
        return;
      }
      throw new HttpError(404, `接口不存在：${pathFromParts(parts)}`);
    }

    case "mcp": {
      // /api/mcp/discover：给编辑器/脚本用同一个「发现外部 MCP 工具」能力
      if (parts[1] === "discover") {
        requireMethod(method, "POST");
        const body = await readJsonObject(req);
        if (typeof body.url !== "string" || !body.url.trim()) {
          throw new HttpError(400, "url 必须是字符串");
        }
        try {
          const result = await discoverMcpTools(body.url.trim(), body.timeoutMs);
          sendJson(res, 200, result);
        } catch (error) {
          // 工具层抛的是业务错误（地址不合法/连不上），REST 语义下是 400 而不是 500。
          throw new HttpError(400, errorMessage(error));
        }
        return;
      }
      throw new HttpError(404, `接口不存在：${pathFromParts(parts)}`);
    }

    case "templates": {
      requireMethod(method, "GET");
      sendJson(
        res,
        200,
        WORKFLOW_TEMPLATES.map((template) => ({
          id: template.id,
          name: template.name,
          description: template.description,
        })),
      );
      return;
    }

    case "workflows":
      await handleWorkflows(ctx, req, res, method, parts);
      return;

    case "executions":
      await handleExecutions(ctx, req, res, method, parts);
      return;

    case "credentials":
      await handleCredentials(ctx, req, res, method, parts);
      return;

    case "settings":
      await handleSettings(ctx, req, res, method, parts);
      return;

    case "notifications": {
      requireMethod(method, "GET");
      sendJson(res, 200, ctx.store.listNotifications(50));
      return;
    }

    default:
      throw new HttpError(404, `接口不存在：/api/${resource}`);
  }
}

// ---- 工作流 ----

async function handleWorkflows(
  ctx: HandlerContext,
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  parts: string[],
): Promise<void> {
  const idOrAction = parts[1];

  // /api/workflows
  if (!idOrAction) {
    if (method === "GET") {
      // 支持 /api/workflows?query=&tag=&active= 过滤；无参数保持旧行为（全量摘要）。
      const search = req.url ? new URL(req.url, "http://127.0.0.1").searchParams : null;
      const query = search?.get("query")?.trim() ?? "";
      const rawTags = [...(search?.getAll("tag") ?? []), ...(search?.get("tags")?.split(",") ?? [])]
        .map((tag) => tag.trim())
        .filter(Boolean);
      const activeRaw = search?.get("active");
      const active = activeRaw === "true" ? true : activeRaw === "false" ? false : undefined;
      if (query || rawTags.length > 0 || active !== undefined) {
        const limit = parseLimit(search?.get("limit") ?? null, 50);
        sendJson(res, 200, searchWorkflows(ctx.store, { query, tags: rawTags, active, limit }));
        return;
      }
      sendJson(res, 200, listWorkflowSummaries(ctx.store));
      return;
    }
    if (method === "POST") {
      const body = await readJsonObject(req);
      const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : undefined;

      if (body.fromTemplateId !== undefined) {
        if (typeof body.fromTemplateId !== "string" || !body.fromTemplateId.trim()) {
          throw new HttpError(400, "fromTemplateId 必须是字符串");
        }
        const template = findWorkflowTemplate(body.fromTemplateId.trim());
        if (!template) throw new HttpError(400, `模板不存在：${body.fromTemplateId}`);
        let workflow: Workflow;
        try {
          workflow = template.build();
        } catch (error) {
          throw new HttpError(400, `模板创建失败：${errorMessage(error)}`);
        }
        if (name) workflow.name = name;
        sendJson(res, 200, ctx.store.saveWorkflow(workflow));
        return;
      }

      if (body.json !== undefined && body.json !== null) {
        const imported = importWorkflow(body.json);
        const workflow = name ? { ...imported.workflow, name } : imported.workflow;
        sendJson(res, 200, ctx.store.saveWorkflow(workflow));
        return;
      }

      sendJson(res, 200, ctx.store.createWorkflow(name ? { name } : {}));
      return;
    }
    throw new HttpError(405, "该接口只支持 GET/POST 请求");
  }

  // /api/workflows/import
  if (idOrAction === "import" && parts.length === 2) {
    requireMethod(method, "POST");
    const body = await readJsonObject(req);
    const raw = body.json !== undefined ? body.json : body;
    const imported = importWorkflow(raw);
    const saved = ctx.store.saveWorkflow(imported.workflow);
    sendJson(res, 200, { ok: true, workflow: saved, warnings: imported.warnings });
    return;
  }

  const id = idOrAction;
  const workflow = getWorkflowOr404(ctx.store, id);

  // /api/workflows/:id
  if (parts.length === 2) {
    if (method === "GET") {
      sendJson(res, 200, workflow);
      return;
    }
    if (method === "PUT") {
      const body = await readJsonObject(req);
      const normalized = normalizeWorkflow({ ...body, id, createdAt: workflow.createdAt });
      if (!normalized) throw new HttpError(400, "工作流数据不完整，无法保存");
      const issues = validateWorkflow(normalized);
      const saved = ctx.store.saveWorkflow(normalized);
      sendJson(res, 200, { ok: true, workflow: saved, issues });
      return;
    }
    if (method === "DELETE") {
      if (!ctx.store.removeWorkflow(id)) throw new HttpError(404, `工作流不存在：${id}`);
      sendJson(res, 200, { ok: true });
      return;
    }
    throw new HttpError(405, "该接口只支持 GET/PUT/DELETE 请求");
  }

  // /api/workflows/:id/{active|duplicate|export|run|stop}
  if (parts.length === 3) {
    const action = parts[2];

    if (action === "versions") {
      requireMethod(method, "GET");
      const versions = ctx.store.listVersions(id);
      sendJson(res, 200, { workflowId: id, total: versions.length, versions });
      return;
    }

    if (action === "restore") {
      requireMethod(method, "POST");
      const body = await readJsonObject(req);
      const versionId = typeof body.versionId === "string" ? body.versionId.trim() : "";
      if (!versionId) throw new HttpError(400, "versionId 必须是字符串");
      const target = ctx.store.getVersion(id, versionId);
      if (!target) throw new HttpError(404, `历史版本不存在：${versionId}`);
      const issues = validateWorkflow(target).filter((issue) => issue.level === "error");
      if (issues.length > 0) {
        sendJson(res, 400, { ok: false, error: "该版本还有错误，不能恢复", issues });
        return;
      }
      const saved = ctx.store.saveWorkflow({ ...target, id });
      sendJson(res, 200, { ok: true, restoredVersionId: versionId, workflow: saved });
      return;
    }

    if (action === "active") {
      requireMethod(method, "POST");
      const body = await readJsonObject(req);
      if (typeof body.active !== "boolean") throw new HttpError(400, "active 必须是布尔值");
      const updated = ctx.store.setActive(id, body.active);
      if (!updated) throw new HttpError(404, `工作流不存在：${id}`);
      sendJson(res, 200, { ok: true, workflow: updated });
      return;
    }

    if (action === "duplicate") {
      requireMethod(method, "POST");
      const copy = ctx.store.createWorkflow({ from: workflow, name: `${workflow.name} 副本` });
      sendJson(res, 200, copy);
      return;
    }

    if (action === "export") {
      requireMethod(method, "GET");
      sendJson(res, 200, exportWorkflow(workflow));
      return;
    }

    if (action === "run") {
      requireMethod(method, "POST");
      const body = await readJsonObject(req);
      if (ctx.runtime.isRunning(id)) {
        throw new HttpError(409, `工作流「${workflow.name}」正在运行，等它结束再试`);
      }
      const startNodeId =
        typeof body.startNodeId === "string" && body.startNodeId.trim() ? body.startNodeId.trim() : undefined;
      const inputData = normalizeItems(body.inputData);
      try {
        const { executionId } = await beginExecution(ctx.store, ctx.runtime, workflow, {
          mode: "manual",
          ...(startNodeId ? { startNodeId } : {}),
          ...(inputData ? { inputData } : {}),
        });
        sendJson(res, 200, { ok: true, executionId });
      } catch (error) {
        throw new HttpError(409, errorMessage(error));
      }
      return;
    }

    if (action === "test") {
      requireMethod(method, "POST");
      const body = await readJsonObject(req);
      try {
        const result = await runWorkflowTest(ctx, workflow, {
          ...(body.pinData !== undefined ? { pinData: body.pinData } : {}),
          ...(body.startNodeId !== undefined ? { startNodeId: body.startNodeId } : {}),
          ...(body.timeoutMs !== undefined ? { timeoutMs: body.timeoutMs } : {}),
        });
        sendJson(res, 200, { ok: true, ...result });
      } catch (error) {
        throw new HttpError(400, errorMessage(error));
      }
      return;
    }

    if (action === "stop") {
      requireMethod(method, "POST");
      sendJson(res, 200, { ok: true, stopped: ctx.runtime.stop() });
      return;
    }
  }

  // /api/workflows/:id/versions/:versionId
  if (parts.length === 4 && parts[2] === "versions") {
    requireMethod(method, "GET");
    const versionId = parts[3];
    const version = ctx.store.getVersion(id, versionId);
    if (!version) throw new HttpError(404, `历史版本不存在：${versionId}`);
    sendJson(res, 200, { workflowId: id, versionId, workflow: version });
    return;
  }

  throw new HttpError(404, `接口不存在：${pathFromParts(parts)}`);
}

// ---- 执行记录 ----

async function handleExecutions(
  ctx: HandlerContext,
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  parts: string[],
): Promise<void> {
  if (!parts[1]) {
    requireMethod(method, "GET");
    const workflowId = req.url ? new URL(req.url, "http://127.0.0.1").searchParams.get("workflowId") ?? undefined : undefined;
    const limit = req.url
      ? parseLimit(new URL(req.url, "http://127.0.0.1").searchParams.get("limit"), 50)
      : 50;
    sendJson(res, 200, listExecutionSummaries(ctx.store, { ...(workflowId ? { workflowId } : {}), limit }));
    return;
  }

  const executionId = parts[1];

  if (parts.length === 2) {
    if (method === "GET") {
      const execution = resolveExecution(ctx.store, ctx.runtime, executionId);
      if (!execution) throw new HttpError(404, `执行记录不存在：${executionId}`);
      sendJson(res, 200, execution);
      return;
    }
    if (method === "DELETE") {
      if (!ctx.store.removeExecution(executionId)) throw new HttpError(404, `执行记录不存在：${executionId}`);
      sendJson(res, 200, { ok: true });
      return;
    }
    throw new HttpError(405, "该接口只支持 GET/DELETE 请求");
  }

  if (parts.length === 3 && parts[2] === "retry") {
    requireMethod(method, "POST");
    const execution = resolveExecution(ctx.store, ctx.runtime, executionId);
    if (!execution) throw new HttpError(404, `执行记录不存在：${executionId}`);
    const workflow = ctx.store.getWorkflow(execution.workflowId);
    if (!workflow) throw new HttpError(404, "工作流已删除，无法重跑");
    try {
      const { executionId: retriedId } = await beginExecution(ctx.store, ctx.runtime, workflow, {
        mode: "retry",
        ...(execution.triggerData ? { inputData: execution.triggerData } : {}),
      });
      sendJson(res, 200, { ok: true, executionId: retriedId });
    } catch (error) {
      throw new HttpError(409, errorMessage(error));
    }
    return;
  }

  throw new HttpError(404, `接口不存在：${pathFromParts(parts)}`);
}

// ---- 凭据 ----

async function handleCredentials(
  ctx: HandlerContext,
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  parts: string[],
): Promise<void> {
  if (!parts[1]) {
    if (method === "GET") {
      sendJson(res, 200, ctx.store.listCredentials());
      return;
    }
    if (method === "POST") {
      const body = await readJsonObject(req);
      const meta = saveCredentialOr400(ctx.store, body.name, body.type, body.data);
      sendJson(res, 200, meta);
      return;
    }
    throw new HttpError(405, "该接口只支持 GET/POST 请求");
  }

  const id = parts[1];
  const existing = ctx.store.listCredentials().find((item) => item.id === id);
  if (!existing) throw new HttpError(404, `凭据不存在：${id}`);

  if (parts.length === 2) {
    if (method === "PUT") {
      const body = await readJsonObject(req);
      // 不传 data 时沿用已有密钥值（列表接口不回密钥，编辑名字不能把密钥清空）。
      const data = body.data !== undefined
        ? body.data
        : (await ctx.store.getCredentialData(existing.type, existing.id)) ?? {};
      const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : existing.name;
      const meta = saveCredentialOr400(ctx.store, name, existing.type, data);
      // Store 以「名字」为主键：改名等于新建一条记录，旧记录要显式移除，
      // 否则列表里会同时出现新旧两条（密钥已在 data 里，重新加密保存不丢值）。
      if (name !== existing.name) ctx.store.removeCredential(existing.id);
      sendJson(res, 200, meta);
      return;
    }
    if (method === "DELETE") {
      if (!ctx.store.removeCredential(id)) throw new HttpError(404, `凭据不存在：${id}`);
      sendJson(res, 200, { ok: true });
      return;
    }
    throw new HttpError(405, "该接口只支持 PUT/DELETE 请求");
  }

  throw new HttpError(404, `接口不存在：${pathFromParts(parts)}`);
}

function saveCredentialOr400(store: Store, name: unknown, type: unknown, data: unknown): unknown {
  if (typeof name !== "string" || !name.trim()) throw new HttpError(400, "凭据名称不能为空");
  if (typeof type !== "string" || !type.trim()) throw new HttpError(400, "凭据类型不能为空");
  const payload = data === undefined ? {} : data;
  if (!isPlainObject(payload)) throw new HttpError(400, "凭据数据必须是 JSON 对象");
  try {
    return store.saveCredential({ name: name.trim(), type: type.trim(), data: payload });
  } catch (error) {
    throw new HttpError(400, errorMessage(error));
  }
}

// ---- 设置 ----

async function handleSettings(
  ctx: HandlerContext,
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  parts: string[],
): Promise<void> {
  if (parts.length !== 1) throw new HttpError(404, `接口不存在：${pathFromParts(parts)}`);

  if (method === "GET") {
    sendJson(res, 200, publicSettings(ctx.store.getSettings(), ctx.config));
    return;
  }

  if (method === "PUT") {
    const body = await readJsonObject(req);
    const patch: SettingsPatch = {};
    if (body.vars !== undefined) {
      if (!isPlainObject(body.vars)) throw new HttpError(400, "vars 必须是 JSON 对象");
      patch.vars = body.vars;
    }
    if (body.llm !== undefined) {
      if (body.llm === null) patch.llm = null;
      else if (isPlainObject(body.llm)) {
        const llm = body.llm;
        if (llm.baseUrl !== undefined && typeof llm.baseUrl !== "string") {
          throw new HttpError(400, "llm.baseUrl 必须是字符串");
        }
        if (llm.apiKey !== undefined && typeof llm.apiKey !== "string") {
          throw new HttpError(400, "llm.apiKey 必须是字符串");
        }
        if (llm.model !== undefined && typeof llm.model !== "string") {
          throw new HttpError(400, "llm.model 必须是字符串");
        }
        patch.llm = {
          ...(typeof llm.baseUrl === "string" ? { baseUrl: llm.baseUrl } : {}),
          ...(typeof llm.apiKey === "string" ? { apiKey: llm.apiKey } : {}),
          ...(typeof llm.model === "string" ? { model: llm.model } : {}),
        };
      } else {
        throw new HttpError(400, "llm 必须是对象或 null");
      }
    }
    const saved = ctx.store.saveSettings(patch);
    // 模型连接变更后同步到进程环境：LLM 节点/AI 生成器只读 env（不 import server store）。
    if (patch.llm !== undefined) {
      if (saved.llm) {
        process.env.WF_LLM_BASE_URL = saved.llm.baseUrl;
        process.env.WF_LLM_API_KEY = saved.llm.apiKey;
        process.env.WF_LLM_MODEL = saved.llm.model;
      } else {
        delete process.env.WF_LLM_BASE_URL;
        delete process.env.WF_LLM_API_KEY;
        delete process.env.WF_LLM_MODEL;
      }
    }
    sendJson(res, 200, publicSettings(saved, ctx.config));
    return;
  }

  throw new HttpError(405, "该接口只支持 GET/PUT 请求");
}

function pathFromParts(parts: string[]): string {
  return `/api/${parts.join("/")}`;
}

// ---------------------------------------------------------------------------
// MCP 传输
// ---------------------------------------------------------------------------

async function handleMcpRequest(
  ctx: HandlerContext,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const method = (req.method ?? "GET").toUpperCase();
  if (method !== "POST") {
    sendJson(res, 405, { ok: false, error: "MCP 接口只接受 POST 请求" });
    return;
  }

  let body: unknown;
  try {
    body = await readJson(req);
  } catch (error) {
    const message = errorMessage(error);
    if (error instanceof HttpError && error.status === 413) {
      sendJson(res, 413, { jsonrpc: "2.0", id: null, error: { code: -32600, message } });
      return;
    }
    sendJson(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: `解析错误：${message}` } });
    return;
  }

  const rawSession = req.headers["mcp-session-id"];
  const sessionId = typeof rawSession === "string" ? rawSession : Array.isArray(rawSession) ? rawSession[0] : undefined;

  let output: McpCallOutput;
  try {
    output = await ctx.mcp({ body, sessionId });
  } catch (error) {
    // mcp.ts 承诺不抛错；真抛了也只回通用内部错误，不带请求内容。
    sendJson(res, 500, { jsonrpc: "2.0", id: null, error: { code: -32603, message: `服务内部错误：${errorMessage(error)}` } });
    return;
  }

  if (output.headers) {
    for (const [key, value] of Object.entries(output.headers)) res.setHeader(key, value);
  }
  if (!output.body) {
    res.statusCode = output.status;
    res.setHeader("Content-Length", "0");
    res.end();
    return;
  }
  res.statusCode = output.status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Length", Buffer.byteLength(output.body));
  res.end(output.body);
}

// ---------------------------------------------------------------------------
// 静态文件（public/ + SPA 回落）
// ---------------------------------------------------------------------------

function isInsideDirectory(directory: string, target: string): boolean {
  return target === directory || target.startsWith(directory.endsWith(sep) ? directory : `${directory}${sep}`);
}

async function readFileIfExists(path: string): Promise<Buffer | null> {
  try {
    const info = await stat(path);
    if (!info.isFile()) return null;
    return await readFile(path);
  } catch {
    return null;
  }
}

function sendFile(
  req: IncomingMessage,
  res: ServerResponse,
  filePath: string,
  data: Buffer,
  status = 200,
): void {
  if (res.writableEnded) return;
  res.statusCode = status;
  res.setHeader("Content-Type", MIME_TYPES[extname(filePath).toLowerCase()] ?? "application/octet-stream");
  res.setHeader("Content-Length", data.byteLength);
  res.setHeader("Cache-Control", "no-store");
  res.end((req.method ?? "GET").toUpperCase() === "HEAD" ? undefined : data);
}

async function serveStatic(
  ctx: HandlerContext,
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  method: string,
): Promise<void> {
  if (method !== "GET" && method !== "HEAD") {
    throw new HttpError(405, "静态资源只支持 GET/HEAD 请求");
  }

  const publicDir = resolve(ctx.config.rootDir, "public");
  // `/static/x` 与 `/x` 都映射到 public 下；`/static/` 是页面里显式引用的资源路径。
  const isStaticPath = pathname.startsWith("/static/");
  const relative = isStaticPath ? pathname.slice("/static/".length) : pathname.replace(/^\/+/, "");
  const candidate = resolve(publicDir, relative || "index.html");

  // 路径穿越防护：解析后的绝对路径必须仍在 public/ 内。
  if (!isInsideDirectory(publicDir, candidate)) {
    sendJson(res, 404, { ok: false, error: "资源不存在" });
    return;
  }

  const direct = await readFileIfExists(candidate);
  if (direct) {
    sendFile(req, res, candidate, direct);
    return;
  }

  // /static/* 缺文件就是 404，不做 SPA 回落（否则 JS 404 会拿到 HTML，排查困难）。
  if (isStaticPath) {
    sendJson(res, 404, { ok: false, error: `静态资源不存在：${pathname}` });
    return;
  }

  // SPA 回落：其它 GET 路径交给 index.html，前端路由自己处理。
  const indexPath = join(publicDir, "index.html");
  const index = await readFileIfExists(indexPath);
  if (index) {
    sendFile(req, res, indexPath, index);
    return;
  }
  sendJson(res, 404, { ok: false, error: "页面尚未生成（缺少 public/index.html）" });
}

// ---------------------------------------------------------------------------
// 服务器
// ---------------------------------------------------------------------------

/**
 * 创建 HTTP 服务（不 listen；main.ts 负责绑定端口，测试可以 listen(0)）。
 */
export function createHttpServer(options: HttpServerOptions): Server {
  const startedAt = Date.now();
  const version = options.version ?? "0.1.0";
  const ctx: HandlerContext = {
    store: options.store,
    runtime: options.runtime,
    scheduler: options.scheduler,
    config: options.config,
    version,
    startedAt,
    mcp: createMcpHandler({
      store: options.store,
      runtime: options.runtime,
      config: options.config,
      version,
    }),
  };

  const server = createServer((req, res) => {
    const origin = typeof req.headers.origin === "string" ? req.headers.origin : "";
    if (origin && !isAllowedOrigin(origin)) {
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.statusCode = 403;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ ok: false, error: "来源不被允许：本机服务只接受和鸣客户端与本机页面的请求" }));
      return;
    }
    applyCors(res, origin);
    void handleRequest(ctx, req, res).catch((error: unknown) => {
      if (res.writableEnded) return;
      const status = error instanceof HttpError ? error.status : 500;
      const message = error instanceof HttpError ? error.message : `服务内部错误：${errorMessage(error)}`;
      sendJson(res, status, { ok: false, error: message });
    });
  });

  return server;
}

async function handleRequest(
  ctx: HandlerContext,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const method = (req.method ?? "GET").toUpperCase();

  let url: URL;
  let pathname: string;
  try {
    url = new URL(req.url ?? "/", "http://127.0.0.1");
    pathname = decodeURIComponent(url.pathname);
  } catch {
    throw new HttpError(400, "请求地址不合法");
  }

  if (method === "OPTIONS") {
    sendEmpty(res, 204);
    return;
  }

  if (pathname === "/webhook" || pathname.startsWith("/webhook/")) {
    await handleWebhook(ctx, req, res, method, url);
    return;
  }

  if (pathname === "/mcp") {
    await handleMcpRequest(ctx, req, res);
    return;
  }

  if (pathname === "/api" || pathname.startsWith("/api/")) {
    await handleApi(ctx, req, res, method, pathname, url.searchParams);
    return;
  }

  await serveStatic(ctx, req, res, pathname, method);
}

/** 供测试/文档引用：MCP 认证用不到密钥，但把电范围集中声明。 */
export const HTTP_SERVER_LIMITS = {
  maxJsonBodyBytes: MAX_JSON_BODY_BYTES,
  mcpPath: "/mcp",
  apiPrefix: "/api",
} as const;
