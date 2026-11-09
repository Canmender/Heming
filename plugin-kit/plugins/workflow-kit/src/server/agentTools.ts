/**
 * 智能体辅助工具（P0）：让智能体能「发现 → 试跑 → 启用 → 调试」自主闭环。
 *
 * 为什么单独一个文件：这五个工具是围绕「设计工作流」的辅助面，不是工作流 CRUD 本身；
 * 但工具定义形状与 `mcp.ts` 完全一致（同一个 `McpToolDefinition`），协议层只负责拼接。
 *
 * 依赖方向：本文件 → `mcp.ts` 只有**类型**依赖（type-only），错误类走 `toolErrors.ts`，
 * 因此不存在运行时循环依赖。
 *
 * 边界：这些都是**本机只读/受控写**能力——credential_list 不返回任何密钥值；
 * workflow_test 只在内存里给节点塞 pinData 后跑一次，**不会把 pinData 写回工作流**；
 * mcp_list_tools 只对用户给定的 http(s) 地址做 MCP 握手，不读取本地文件。
 */

import { getNodeType, listNodeTypes } from "../registry.js";
import { validateWorkflow, workflowSummary } from "../model.js";
import { sdkReference } from "./sdkReference.js";
import { generateWorkflow } from "./aiBuilder.js";
import { appVersion } from "../version.js";
import type { Item, Workflow, WorkflowExecution, WorkflowNode } from "../types.js";
import type { McpDeps, McpToolDefinition, McpToolInputSchema } from "./mcp.js";
import { RpcInvalidParams, ToolError } from "./toolErrors.js";

// ---------------------------------------------------------------------------
// 通用小工具
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireText(args: Record<string, unknown>, name: string, label: string): string {
  const value = args[name];
  if (typeof value !== "string" || !value.trim()) {
    throw new RpcInvalidParams(`缺少参数：${label}（${name}）`);
  }
  return value.trim();
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function optionalString(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function clipUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(text.slice(0, mid), "utf8") <= maxBytes) low = mid;
    else high = mid - 1;
  }
  return `${text.slice(0, Math.max(0, low))}…`;
}

/** 测试执行的最大时长：MCP 单次调用 20 秒上限，留出余量。 */
export const MAX_TEST_TIMEOUT_MS = 15_000;
export const DEFAULT_TEST_TIMEOUT_MS = 10_000;

function clampTestTimeout(value: unknown): number {
  const n = optionalNumber(value);
  if (n === undefined) return DEFAULT_TEST_TIMEOUT_MS;
  return Math.max(1_000, Math.min(MAX_TEST_TIMEOUT_MS, Math.trunc(n)));
}

// ---------------------------------------------------------------------------
// 1) 凭据发现
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 2) 节点完整 schema
// ---------------------------------------------------------------------------

/** 节点完整描述（含每个参数的 displayOptions/placeholder/options），供智能体精确填参。 */
export function nodeTypeDetail(type: string): Record<string, unknown> | null {
  const nodeType = getNodeType(type);
  if (!nodeType) return null;
  const description = nodeType.description;
  return {
    type: description.type,
    displayName: description.displayName,
    group: description.group,
    description: description.description,
    icon: description.icon,
    isTrigger: description.isTrigger === true,
    ...(description.trigger ? { trigger: description.trigger } : {}),
    inputs: description.inputs,
    outputs: description.outputs,
    ...(description.outputNames ? { outputNames: description.outputNames } : {}),
    dynamicOutputs: typeof nodeType.getOutputCount === "function",
    version: description.version,
    defaultName: description.defaultName ?? description.displayName,
    properties: description.properties.map((property) => ({
      name: property.name,
      displayName: property.displayName,
      type: property.type,
      required: property.required === true,
      ...(property.default !== undefined ? { default: property.default } : {}),
      ...(property.description ? { description: property.description } : {}),
      ...(property.placeholder ? { placeholder: property.placeholder } : {}),
      ...(property.rows !== undefined ? { rows: property.rows } : {}),
      ...(property.expression !== undefined ? { expression: property.expression } : {}),
      ...(property.options
        ? {
            options: property.options.map((option) => ({
              name: option.name,
              value: option.value,
              ...(option.description ? { description: option.description } : {}),
            })),
          }
        : {}),
      ...(property.displayOptions ? { displayOptions: property.displayOptions } : {}),
    })),
  };
}

// ---------------------------------------------------------------------------
// 3) 试跑（pinData，不写回工作流）
// ---------------------------------------------------------------------------

/** pinData 入参 → 节点 id → items（支持按 id 或节点名；未知节点直接报错，不静默丢）。 */
export function normalizePinData(
  workflow: Pick<Workflow, "nodes">,
  raw: unknown,
): Record<string, Item[]> {
  if (!isPlainObject(raw)) throw new RpcInvalidParams("pinData 必须是对象：{节点id或节点名: [数据项]}");
  const result: Record<string, Item[]> = {};
  const byId = new Map(workflow.nodes.map((node) => [node.id, node]));
  const byName = new Map(workflow.nodes.map((node) => [node.name, node]));
  for (const [key, value] of Object.entries(raw)) {
    const node = byId.get(key) ?? byName.get(key);
    if (!node) {
      throw new ToolError(`pinData 里的节点不存在：${key}（可用节点 id 或节点名；先调 workflow_get 查看）`);
    }
    const list = Array.isArray(value) ? value : [value];
    const items: Item[] = [];
    for (const entry of list.slice(0, 200)) {
      if (isPlainObject(entry) && isPlainObject(entry.json)) items.push({ json: entry.json });
      else if (isPlainObject(entry)) items.push({ json: entry });
    }
    result[node.id] = items;
  }
  return result;
}

/** 执行结果里的节点输出预览：最多 3 条、每条 ≤2KB，超出给截断标记。 */
function previewItems(items: Item[] | undefined): unknown[] {
  const maxBytes = 2_000;
  return (items ?? []).slice(0, 3).map((item) => {
    let text: string;
    try {
      text = JSON.stringify(item.json ?? {});
    } catch {
      return { __hemingTruncated: true, reason: "数据无法序列化" };
    }
    if (Buffer.byteLength(text, "utf8") <= maxBytes) return item.json;
    return { __hemingTruncated: true, preview: clipUtf8(text, maxBytes - 64) };
  });
}

export interface RunTestOptions {
  pinData?: unknown;
  timeoutMs?: unknown;
  startNodeId?: unknown;
}

/** 同步试跑一条工作流（pinData 只在内存副本里生效）。MCP 与 REST 共用。 */
export async function runWorkflowTest(
  deps: Pick<McpDeps, "store" | "runtime">,
  workflow: Workflow,
  options: RunTestOptions = {},
): Promise<Record<string, unknown>> {
  const validation = validateWorkflow(workflow);
  const errors = validation.filter((issue) => issue.level === "error");
  if (errors.length > 0) {
    throw new ToolError(`工作流还有错误，先修好再试跑：${errors.map((issue) => issue.message).join("；")}`);
  }
  if (deps.runtime.isRunning(workflow.id)) {
    throw new ToolError(`工作流「${workflow.name}」正在运行，等它结束再试跑`);
  }

  // 深拷贝：pinData 只活在这次测试里，绝不写回存储里的工作流。
  const target: Workflow = structuredClone(workflow);
  const pinned = normalizePinData(target, options.pinData ?? {});
  const pinnedIds: string[] = [];
  for (const node of target.nodes) {
    const items = pinned[node.id];
    if (!items) continue;
    node.pinData = items;
    pinnedIds.push(node.id);
  }

  const startNodeId = typeof options.startNodeId === "string" && options.startNodeId.trim()
    ? options.startNodeId.trim()
    : undefined;
  const timeoutMs = clampTestTimeout(options.timeoutMs);
  const startedAt = Date.now();
  let execution: WorkflowExecution;
  try {
    execution = await deps.runtime.runWorkflow(target, {
      mode: "manual",
      ...(startNodeId ? { startNodeId } : {}),
      timeoutMs,
    });
  } catch (error) {
    throw new ToolError(`试跑失败：${error instanceof Error ? error.message : String(error)}`);
  }

  const nodeById = new Map(target.nodes.map((node) => [node.id, node]));
  const nodes = Object.entries(execution.runData ?? {}).map(([nodeId, runs]) => {
    const last = runs[runs.length - 1];
    const definition = nodeById.get(nodeId);
    return {
      nodeId,
      nodeName: definition?.name ?? last?.error?.nodeName ?? nodeId,
      nodeType: definition?.type,
      runs: runs.length,
      status: last?.status,
      itemsTotal: last?.itemsTotal ?? 0,
      executionTime: last?.executionTime ?? 0,
      ...(last?.error
        ? {
            error: {
              message: last.error.message,
              ...(last.error.description ? { description: last.error.description } : {}),
              ...(last.error.httpCode ? { httpCode: last.error.httpCode } : {}),
            },
          }
        : {}),
      preview: previewItems(last?.data?.main?.[0]),
    };
  });

  const timedOut = execution.status === "canceled" && /超时/.test(execution.error?.message ?? "");
  return {
    executionId: execution.id,
    status: execution.status,
    ...(timedOut ? { timedOut: true } : {}),
    durationMs: Date.now() - startedAt,
    timeoutMs,
    pinnedNodeIds: pinnedIds,
    nodes,
    ...(execution.error
      ? { error: { message: execution.error.message, ...(execution.error.nodeName ? { nodeName: execution.error.nodeName } : {}) } }
      : {}),
    ...(execution.dataTruncated ? { dataTruncated: true } : {}),
  };
}

// ---------------------------------------------------------------------------
// 4) 启用 / 停用
// ---------------------------------------------------------------------------

function scheduleTriggerCount(workflow: Workflow): number {
  return workflow.nodes.filter((node) => {
    if (node.disabled) return false;
    const description = getNodeType(node.type)?.description;
    return description?.trigger === "schedule";
  }).length;
}

// ---------------------------------------------------------------------------
// 5) 外部 MCP 工具发现
// ---------------------------------------------------------------------------

interface McpHttpResult {
  payload: unknown;
  sessionId: string | null;
}

function mcpErrorText(payload: unknown): string | undefined {
  if (isPlainObject(payload) && isPlainObject(payload.error)) {
    const message = payload.error.message;
    return typeof message === "string" ? message : JSON.stringify(payload.error);
  }
  return undefined;
}

/** 一次 MCP HTTP POST：支持 JSON 与 SSE 两种响应，返回解析后的 JSON-RPC 包。 */
async function postMcp(
  url: string,
  body: unknown,
  sessionId: string | null,
  timeoutMs: number,
): Promise<McpHttpResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(sessionId ? { "mcp-session-id": sessionId } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) throw new ToolError(`MCP 服务返回 HTTP ${response.status}`);
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > 2 * 1024 * 1024) {
      throw new ToolError("MCP 服务响应超过 2MB 上限，已拒绝解析");
    }
    const contentType = response.headers.get("content-type") ?? "";
    let payload: unknown = null;
    if (contentType.includes("text/event-stream")) {
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        try {
          payload = JSON.parse(data) as unknown;
          break;
        } catch {
          /* 继续下一行 */
        }
      }
    } else {
      payload = text ? (JSON.parse(text) as unknown) : null;
    }
    return { payload, sessionId: response.headers.get("mcp-session-id") };
  } catch (error) {
    if (error instanceof ToolError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new ToolError(`连接 MCP 服务超时（${timeoutMs} 毫秒）`);
    }
    throw new ToolError(`连接 MCP 服务失败：${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timer);
  }
}

/** 连一个本机 MCP 服务，握手后返回 tools/list（含 inputSchema），供 mcpTool 节点填参。 */
export async function discoverMcpTools(
  rawUrl: string,
  timeoutValue?: unknown,
): Promise<Record<string, unknown>> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ToolError("MCP 地址不是合法 URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ToolError("MCP 地址只支持 http/https");
  }
  if (url.username || url.password) {
    throw new ToolError("MCP 地址里不要内嵌用户名/密码");
  }
  const timeoutMs = Math.max(1_000, Math.min(MAX_TEST_TIMEOUT_MS, Math.trunc(optionalNumber(timeoutValue) ?? 8_000)));

  const init = await postMcp(
    url.toString(),
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "heming-workflow-kit", version: appVersion() },
      },
    },
    null,
    timeoutMs,
  );
  const initError = mcpErrorText(init.payload);
  if (initError) throw new ToolError(`MCP 初始化失败：${initError}`);

  // 按协议补一条 initialized 通知；服务端忽略或失败都不影响后续 tools/list。
  await postMcp(
    url.toString(),
    { jsonrpc: "2.0", method: "notifications/initialized" },
    init.sessionId,
    timeoutMs,
  ).catch(() => undefined);

  const list = await postMcp(
    url.toString(),
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    init.sessionId,
    timeoutMs,
  );
  const listError = mcpErrorText(list.payload);
  if (listError) throw new ToolError(`MCP tools/list 失败：${listError}`);
  const result = isPlainObject(list.payload) && isPlainObject(list.payload.result) ? list.payload.result : {};
  const rawTools = Array.isArray(result.tools) ? result.tools : [];
  const tools = rawTools.slice(0, 200).map((entry) => {
    const tool = isPlainObject(entry) ? entry : {};
    return {
      name: typeof tool.name === "string" ? tool.name : "",
      description: typeof tool.description === "string" ? clipUtf8(tool.description, 600) : "",
      inputSchema: tool.inputSchema ?? null,
    };
  });
  const serverInfo = isPlainObject(init.payload) &&
    isPlainObject(init.payload.result) &&
    isPlainObject(init.payload.result.serverInfo)
    ? init.payload.result.serverInfo
    : null;
  return {
    url: url.toString(),
    timeoutMs,
    ...(serverInfo ? { serverInfo } : {}),
    total: tools.length,
    tools,
  };
}

// ---------------------------------------------------------------------------
// 工具定义
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// P1：搜索 / 执行详情 / 版本 / SDK 参考
// ---------------------------------------------------------------------------

export interface WorkflowSearchOptions {
  query?: unknown;
  tags?: unknown;
  active?: unknown;
  limit?: unknown;
}

export interface WorkflowSearchItem {
  id: string;
  name: string;
  tags: string[];
  active: boolean;
  nodeCount: number;
  triggerCount: number;
  updatedAt: number;
  lastRunAt?: number;
  lastStatus?: string;
}

/** 搜索工作流：名称/描述/标签模糊匹配 + 标签 AND + 启用状态过滤。 */
export function searchWorkflows(
  store: Pick<McpDeps["store"], "listWorkflows" | "lastExecutionOf">,
  options: WorkflowSearchOptions = {},
): { total: number; workflows: WorkflowSearchItem[]; availableTags: string[] } {
  const query = typeof options.query === "string" ? options.query.trim().toLowerCase() : "";
  const tags = Array.isArray(options.tags)
    ? options.tags
        .filter((tag): tag is string => typeof tag === "string" && tag.trim() !== "")
        .map((tag) => tag.trim())
    : [];
  const active = typeof options.active === "boolean" ? options.active : undefined;
  const limitRaw = optionalNumber(options.limit);
  const limit = Math.max(1, Math.min(200, Math.trunc(limitRaw ?? 50)));

  let list = store.listWorkflows();
  if (query) {
    list = list.filter(
      (workflow) =>
        workflow.name.toLowerCase().includes(query) ||
        (workflow.description ?? "").toLowerCase().includes(query) ||
        workflow.tags.some((tag) => tag.toLowerCase().includes(query)),
    );
  }
  if (tags.length > 0) list = list.filter((workflow) => tags.every((tag) => workflow.tags.includes(tag)));
  if (active !== undefined) list = list.filter((workflow) => workflow.active === active);

  const workflows = list.slice(0, limit).map((workflow) => {
    const summary = workflowSummary(workflow);
    const last = store.lastExecutionOf(workflow.id);
    return {
      id: workflow.id,
      name: workflow.name,
      tags: [...workflow.tags],
      active: workflow.active,
      nodeCount: summary.nodes,
      triggerCount: summary.triggers,
      updatedAt: workflow.updatedAt,
      ...(workflow.lastRunAt !== undefined ? { lastRunAt: workflow.lastRunAt } : {}),
      ...(last ? { lastStatus: last.status } : {}),
    };
  });
  const availableTags = [...new Set(store.listWorkflows().flatMap((workflow) => workflow.tags))].sort();
  return { total: list.length, workflows, availableTags };
}

const SECRET_KEY_PATTERN = /pass(word)?|secret|token|authorization|api[_-]?key|cookie|credential|private[_-]?key/i;

/** 递归脱敏：命中敏感键的值替换为 ***，字符串里的 Bearer / sk- 前缀也打码。 */
export function redactSecrets(value: unknown, depth = 0): unknown {
  if (depth > 8) return "…";
  if (typeof value === "string") {
    if (/^Bearer\s+\S+/i.test(value)) return "Bearer ***";
    if (/^sk-[A-Za-z0-9_-]{8,}/.test(value)) return "sk-***";
    return value;
  }
  if (Array.isArray(value)) return value.map((entry) => redactSecrets(entry, depth + 1));
  if (!isPlainObject(value)) return value;
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (SECRET_KEY_PATTERN.test(key) && entry !== null && entry !== undefined) {
      result[key] = "***";
      continue;
    }
    result[key] = redactSecrets(entry, depth + 1);
  }
  return result;
}

function boundItems(items: Item[] | undefined, maxItems: number): { items: unknown[]; truncated: boolean } {
  const list = items ?? [];
  const result: unknown[] = [];
  for (const item of list.slice(0, maxItems)) {
    let text: string;
    try {
      text = JSON.stringify(item.json ?? {});
    } catch {
      result.push({ __hemingTruncated: true, reason: "数据无法序列化" });
      continue;
    }
    result.push(
      Buffer.byteLength(text, "utf8") <= 4_096
        ? (item.json as Record<string, unknown>)
        : { __hemingTruncated: true, preview: clipUtf8(text, 4_000) },
    );
  }
  return { items: result, truncated: list.length > maxItems };
}

export interface ExecutionDetailOptions {
  nodeId?: unknown;
  includeData?: unknown;
  redactSecrets?: unknown;
  maxItems?: unknown;
}

/** 执行详情（默认脱敏 + 截断），给智能体看「哪条数据、哪个字段」错。 */
export function buildExecutionDetail(
  deps: Pick<McpDeps, "store" | "runtime">,
  executionId: string,
  options: ExecutionDetailOptions = {},
): Record<string, unknown> {
  const execution = deps.runtime.getLiveExecution(executionId) ?? deps.store.getExecution(executionId);
  if (!execution) throw new ToolError(`执行记录不存在：${executionId}`);
  const workflow = deps.store.getWorkflow(execution.workflowId);
  const includeData = options.includeData !== false;
  const redact = options.redactSecrets !== false;
  const nodeFilter = typeof options.nodeId === "string" && options.nodeId.trim() ? options.nodeId.trim() : undefined;
  const maxItems = Math.max(1, Math.min(50, Math.trunc(optionalNumber(options.maxItems) ?? 10)));
  const budget = 240 * 1024;
  let used = 0;
  let truncated = execution.dataTruncated === true;

  const nodes = Object.entries(execution.runData ?? {})
    .filter(([nodeId]) => !nodeFilter || nodeId === nodeFilter)
    .map(([nodeId, runs]) => {
      const definition = workflow?.nodes.find((node) => node.id === nodeId);
      const mappedRuns = runs.map((run) => {
        let data: { main: unknown[][] } | undefined;
        if (includeData && run.data) {
          const ports: unknown[][] = [];
          for (const port of run.data.main) {
            const bounded = boundItems(port, maxItems);
            if (bounded.truncated) truncated = true;
            const sanitized = redact ? bounded.items.map((item) => redactSecrets(item)) : bounded.items;
            const size = Buffer.byteLength(JSON.stringify(sanitized), "utf8");
            if (used + size > budget) {
              truncated = true;
              ports.push([]);
              continue;
            }
            used += size;
            ports.push(sanitized);
          }
          data = { main: ports };
        }
        return {
          executionIndex: run.executionIndex,
          status: run.status,
          startTime: run.startTime,
          executionTime: run.executionTime,
          itemsTotal: run.itemsTotal,
          ...(run.error
            ? {
                error: {
                  message: run.error.message,
                  ...(run.error.description ? { description: run.error.description } : {}),
                  ...(run.error.httpCode ? { httpCode: run.error.httpCode } : {}),
                  ...(run.error.nodeName ? { nodeName: run.error.nodeName } : {}),
                },
              }
            : {}),
          ...(data ? { data } : {}),
        };
      });
      return {
        nodeId,
        nodeName: definition?.name ?? nodeId,
        nodeType: definition?.type,
        runs: mappedRuns,
      };
    });

  return {
    execution: {
      id: execution.id,
      workflowId: execution.workflowId,
      workflowName: execution.workflowName,
      mode: execution.mode,
      status: execution.status,
      startedAt: execution.startedAt,
      ...(execution.finishedAt !== undefined ? { finishedAt: execution.finishedAt } : {}),
      ...(execution.durationMs !== undefined ? { durationMs: execution.durationMs } : {}),
      ...(execution.triggerNodeId ? { triggerNodeId: execution.triggerNodeId } : {}),
      ...(execution.error
        ? {
            error: {
              message: execution.error.message,
              ...(execution.error.nodeName ? { nodeName: execution.error.nodeName } : {}),
              ...(execution.error.httpCode ? { httpCode: execution.error.httpCode } : {}),
            },
          }
        : {}),
      ...(execution.parentExecutionId ? { parentExecutionId: execution.parentExecutionId } : {}),
    },
    redacted: redact,
    maxItems,
    ...(truncated ? { truncated: true } : {}),
    nodes,
  };
}

const emptySchema = (): McpToolInputSchema => ({ type: "object", properties: {}, required: [] });

export const AGENT_TOOLS: readonly McpToolDefinition[] = [
  {
    name: "credential_list",
    description:
      "列出本机已保存的凭据（id、名称、类型、更新时间；**不返回任何密钥值**）。HTTP/MCP 节点需要鉴权时，先用它查凭据 id，再写进节点参数 credentials。",
    inputSchema: emptySchema(),
    run: async (deps) => {
      const credentials = deps.store.listCredentials();
      return { total: credentials.length, credentials };
    },
  },
  {
    name: "node_type_detail",
    description:
      "取某个节点类型的完整参数 schema（含每个参数的 type/default/required/options/placeholder/displayOptions）。写节点参数前先调它，避免参数名或取值写错；可用类型见 node_types。",
    inputSchema: {
      type: "object",
      properties: { type: { type: "string", description: "节点类型 id，例如 httpRequest / code / if" } },
      required: ["type"],
    },
    run: async (_deps, args) => {
      const type = requireText(args, "type", "节点类型");
      const detail = nodeTypeDetail(type);
      if (!detail) {
        throw new ToolError(`未知节点类型：${type}（可用类型见 node_types）`);
      }
      return detail;
    },
  },
  {
    name: "workflow_test",
    description:
      "用 pinData 同步试跑一条工作流：给节点塞固定的模拟输出（不写回工作流、不产生外部副作用的前提是这些节点被 pin），返回逐节点状态与输出预览。适合在正式运行前验证逻辑；默认 10 秒、最长 15 秒（MCP 单次调用 20 秒上限）。",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "工作流 id" },
        pinData: {
          type: "object",
          description:
            "固定数据：{节点id或节点名: [数据项]}，数据项是普通对象或 {json:{...}}。被 pin 的节点不执行、直接输出这些数据（触发器/HTTP/通知等有副作用的节点先 pin 掉）。",
        },
        startNodeId: { type: "string", description: "可选：从这个节点开始（跳过上游）" },
        timeoutMs: { type: "integer", description: "可选：超时毫秒（1000–15000，默认 10000）" },
      },
      required: ["id"],
    },
    run: async (deps, args) => {
      const id = requireText(args, "id", "工作流 id");
      const workflow = deps.store.getWorkflow(id);
      if (!workflow) throw new ToolError(`工作流不存在：${id}`);
      return runWorkflowTest(deps, workflow, {
        ...(args.pinData !== undefined ? { pinData: args.pinData } : {}),
        ...(args.startNodeId !== undefined ? { startNodeId: args.startNodeId } : {}),
        ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
      });
    },
  },
  {
    name: "workflow_set_active",
    description:
      "启用/停用一条工作流（等价 n8n 的 publish/unpublish）：启用后定时触发器开始按计划运行，停用后不再自动运行；手动与子流程调用不受影响。启用前会先校验工作流，有错误会拒绝。",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "工作流 id" },
        active: { type: "boolean", description: "true 启用，false 停用" },
      },
      required: ["id", "active"],
    },
    run: async (deps, args) => {
      const id = requireText(args, "id", "工作流 id");
      const active = args.active;
      if (typeof active !== "boolean") throw new RpcInvalidParams("缺少参数：active（true / false）");
      const workflow = deps.store.getWorkflow(id);
      if (!workflow) throw new ToolError(`工作流不存在：${id}`);
      if (active) {
        const issues = validateWorkflow(workflow).filter((issue) => issue.level === "error");
        if (issues.length > 0) {
          throw new ToolError(`工作流还有错误，不能启用：${issues.map((issue) => issue.message).join("；")}`);
        }
      }
      const updated = deps.store.setActive(id, active);
      if (!updated) throw new ToolError(`工作流不存在：${id}`);
      const triggers = scheduleTriggerCount(updated);
      return {
        ok: true,
        active: updated.active,
        scheduleTriggers: triggers,
        workflow: deps.store
          .listWorkflows()
          .find((item) => item.id === id)
          ? { id: updated.id, name: updated.name, active: updated.active, nodeCount: updated.nodes.length }
          : { id: updated.id, name: updated.name, active: updated.active },
        note:
          active && triggers === 0
            ? "已启用，但这条工作流没有定时触发器，因此不会自动运行；手动运行/子流程调用仍可用。"
            : active
              ? `已启用；${triggers} 个定时触发器会在下一个计划时刻运行。`
              : "已停用；定时触发器不再自动运行。",
      };
    },
  },
  {
    name: "mcp_list_tools",
    description:
      "连接一个本机 HTTP MCP 服务并列出它的工具（name/description/inputSchema）。写 mcpTool 节点前先用它发现工具名与参数，不要凭猜。只支持 http/https，单次最长 15 秒。",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "MCP 服务地址，例如 http://127.0.0.1:8776/mcp" },
        timeoutMs: { type: "integer", description: "可选：超时毫秒（1000–15000，默认 8000）" },
      },
      required: ["url"],
    },
    run: async (_deps, args) => {
      const url = requireText(args, "url", "MCP 地址");
      return discoverMcpTools(url, args.timeoutMs);
    },
  },
  {
    name: "workflow_search",
    description:
      "按名称/描述/标签搜索工作流，可按标签（AND）与启用状态过滤，返回摘要与全部可用标签。工作流多了以后先用它定位，不要靠 workflow_list 猜。",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "关键词（名称/描述/标签模糊匹配）" },
        tags: { type: "array", items: { type: "string" }, description: "标签过滤（必须全部匹配）" },
        active: { type: "boolean", description: "只在启用/停用中筛选" },
        limit: { type: "integer", description: "返回条数（1–200，默认 50）" },
      },
      required: [],
    },
    run: async (deps, args) =>
      searchWorkflows(deps.store, {
        query: args.query,
        tags: args.tags,
        active: args.active,
        limit: args.limit,
      }),
  },
  {
    name: "workflow_execution_detail",
    description:
      "取一次执行的逐节点数据（默认脱敏：password/token/authorization/api key 等键值打码；默认每口最多 10 条、单条超 4KB 截断、总预算 240KB）。失败排查时用它看「哪条数据、哪个字段」错，而不是只看摘要。",
    inputSchema: {
      type: "object",
      properties: {
        executionId: { type: "string", description: "执行 id" },
        nodeId: { type: "string", description: "可选：只看某个节点" },
        includeData: { type: "boolean", description: "是否带节点数据（默认 true）" },
        redactSecrets: { type: "boolean", description: "是否脱敏（默认 true；看敏感数据时才关）" },
        maxItems: { type: "integer", description: "每个输出口最多几条（1–50，默认 10）" },
      },
      required: ["executionId"],
    },
    run: async (deps, args) =>
      buildExecutionDetail(deps, requireText(args, "executionId", "执行 id"), {
        nodeId: args.nodeId,
        includeData: args.includeData,
        redactSecrets: args.redactSecrets,
        maxItems: args.maxItems,
      }),
  },
  {
    name: "workflow_versions",
    description: "列出工作流的历史版本（每次保存自动留上一版；每工作流最多 10 版，最新在前）。用于对比/回滚。",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "工作流 id" } },
      required: ["id"],
    },
    run: async (deps, args) => {
      const id = requireText(args, "id", "工作流 id");
      if (!deps.store.getWorkflow(id)) throw new ToolError(`工作流不存在：${id}`);
      const versions = deps.store.listVersions(id);
      return { workflowId: id, total: versions.length, versions };
    },
  },
  {
    name: "workflow_version_get",
    description: "读取某个历史版本的完整工作流 JSON（不会改动当前版本）。",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "工作流 id" },
        versionId: { type: "string", description: "版本 id（来自 workflow_versions）" },
      },
      required: ["id", "versionId"],
    },
    run: async (deps, args) => {
      const id = requireText(args, "id", "工作流 id");
      const versionId = requireText(args, "versionId", "版本 id");
      const workflow = deps.store.getVersion(id, versionId);
      if (!workflow) throw new ToolError(`历史版本不存在：${id} / ${versionId}（先调 workflow_versions）`);
      return { workflowId: id, versionId, workflow };
    },
  },
  {
    name: "workflow_restore",
    description:
      "把某个历史版本恢复成当前版本（会先把当前版本留成新快照，可再回滚）。恢复前会校验，有错误拒绝。",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "工作流 id" },
        versionId: { type: "string", description: "要恢复的版本 id" },
      },
      required: ["id", "versionId"],
    },
    run: async (deps, args) => {
      const id = requireText(args, "id", "工作流 id");
      const versionId = requireText(args, "versionId", "版本 id");
      const workflow = deps.store.getVersion(id, versionId);
      if (!workflow) throw new ToolError(`历史版本不存在：${id} / ${versionId}（先调 workflow_versions）`);
      const issues = validateWorkflow(workflow).filter((issue) => issue.level === "error");
      if (issues.length > 0) {
        throw new ToolError(`该版本还有错误，不能恢复：${issues.map((issue) => issue.message).join("；")}`);
      }
      const saved = deps.store.saveWorkflow({ ...workflow, id });
      return {
        ok: true,
        restoredVersionId: versionId,
        workflow: { id: saved.id, name: saved.name, nodeCount: saved.nodes.length, versionId: saved.versionId },
        note: "已恢复；恢复前的版本已自动留成新快照，可用 workflow_versions 再回滚。",
      };
    },
  },
  {
    name: "workflow_generate",
    description:
      "用自然语言生成一条工作流（需要本机已配置 OpenAI 兼容模型连接）。默认只生成不保存，返回 workflow JSON、plan 与校验问题；确认后可用 workflow_create 保存或 workflow_test 先试跑。",
    inputSchema: {
      type: "object",
      properties: {
        request: { type: "string", description: "自然语言目标，例如「每天早上 9 点抓取某个接口，失败时发通知」" },
        name: { type: "string", description: "可选：指定工作流名称" },
        save: { type: "boolean", description: "可选：true 时校验通过后直接保存（默认 false）" },
      },
      required: ["request"],
    },
    run: async (deps, args) => {
      const request = requireText(args, "request", "目标描述");
      const generated = await generateWorkflow({
        request,
        ...(typeof args.name === "string" ? { name: args.name } : {}),
      });
      const errors = generated.issues.filter((issue) => issue.level === "error");
      if (args.save === true) {
        if (errors.length > 0) {
          throw new ToolError(`生成结果还有错误，不能保存：${errors.map((issue) => issue.message).join("；")}`);
        }
        const saved = deps.store.saveWorkflow(generated.workflow);
        return { ...generated, saved: true, workflowId: saved.id };
      }
      return { ...generated, saved: false };
    },
  },
  {
    name: "workflow_sdk_reference",
    description:
      "取工作流规范参考（JSON 结构/表达式/节点设置/试跑/常见链路/排错）。不确定 JSON 字段、表达式变量或试跑语义时先查它，避免凭记忆写错。",
    inputSchema: {
      type: "object",
      properties: {
        topic: {
          type: "string",
          description: "overview / workflow-json / expressions / node-settings / testing / patterns / troubleshooting",
        },
      },
      required: [],
    },
    run: async (_deps, args) => sdkReference(optionalString(args, "topic")),
  },
];

/** 供文档/测试引用：当前可用的节点类型 id。 */
export function listNodeTypeIds(): string[] {
  return listNodeTypes().map((nodeType) => nodeType.description.type);
}

/** 供测试：确认节点名/类型映射工具。 */
export function nodeNameOf(workflow: Pick<Workflow, "nodes">, nodeId: string): string | undefined {
  return workflow.nodes.find((node: WorkflowNode) => node.id === nodeId)?.name;
}
