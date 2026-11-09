/**
 * MCP 协议层（JSON-RPC over POST /mcp），以及 REST 与 MCP 共用的工作流操作。
 *
 * 为什么把共用操作放在这里：导入/导出、执行启动、摘要这些逻辑 HTTP 与 MCP 都要用。
 * 只写一份、由 `http.ts` 单向依赖本文件，可以避免两份实现随时间漂移；
 * 本文件不依赖 HTTP 层（`http.ts` 才依赖它），因此没有循环依赖。
 *
 * MCP 契约（见 docs/CONTRACT.md §5）：
 * - `initialize` 返回 serverInfo/protocolVersion，并让传输层设置 `mcp-session-id` 响应头；
 * - 无 id 的 `notifications/initialized` 返回 202 空体；
 * - 支持 `ping` / `tools/list` / `tools/call`，未知方法 -32601，参数错误 -32602；
 * - `tools/call` 的业务失败（找不到工作流等）按 MCP 语义返回 `isError: true` 的文本结果，
 *   而不是 JSON-RPC 错误——这样智能体能读到中文原因并自行纠正；
 * - `workflow_run` 必须异步启动并立即返回 executionId（和鸣 MCP 客户端单次调用 20 秒超时）。
 */

import { randomUUID } from "node:crypto";
import { getNodeType, listNodeTypes } from "../registry.js";
import {
  createWorkflow,
  normalizeWorkflow,
  uniqueNodeName,
  validateWorkflow,
  workflowSummary,
} from "../model.js";
import { WORKFLOW_TEMPLATES } from "../nodes/templates.js";
import type {
  ExecutionMode,
  Item,
  Workflow,
  WorkflowConnection,
  WorkflowConnections,
  WorkflowExecution,
  WorkflowNode,
} from "../types.js";
import { CREDENTIAL_TYPES } from "./credentials.js";
import type { WorkflowConfig } from "./config.js";
import type { Runtime } from "./runtime.js";
import type { Settings, Store } from "./storage.js";
import { AGENT_TOOLS } from "./agentTools.js";
import { RpcInvalidParams, ToolError } from "./toolErrors.js";

// ---------------------------------------------------------------------------
// 通用小工具
// ---------------------------------------------------------------------------

/** 普通对象（排除 null 与数组）；所有外部输入都先过这里。 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function toFiniteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** 业务失败 / 参数错误：定义在 toolErrors.ts（工具实现与协议层共用，避免循环依赖）。 */
export { RpcInvalidParams, ToolError } from "./toolErrors.js";

// ---------------------------------------------------------------------------
// 工作流摘要（列表用）
// ---------------------------------------------------------------------------

export interface WorkflowListItem {
  id: string;
  name: string;
  active: boolean;
  nodeCount: number;
  triggerCount: number;
  updatedAt: number;
  lastRunAt?: number;
  lastStatus?: string;
}

export function summarizeWorkflow(store: Store, workflow: Workflow): WorkflowListItem {
  const summary = workflowSummary(workflow);
  const last = store.lastExecutionOf(workflow.id);
  return {
    id: workflow.id,
    name: workflow.name,
    active: workflow.active,
    nodeCount: summary.nodes,
    triggerCount: summary.triggers,
    updatedAt: workflow.updatedAt,
    ...(workflow.lastRunAt !== undefined ? { lastRunAt: workflow.lastRunAt } : {}),
    ...(last ? { lastStatus: last.status } : {}),
  };
}

export function listWorkflowSummaries(store: Store): WorkflowListItem[] {
  return store.listWorkflows().map((workflow) => summarizeWorkflow(store, workflow));
}

// ---------------------------------------------------------------------------
// 导出 / 导入（类 n8n 形状）
// ---------------------------------------------------------------------------

/** n8n 导出的节点 type 带包名前缀，导入时剥掉；未知类型保留但给警告。 */
const N8N_TYPE_PREFIXES = ["n8n-nodes-base.", "@n8n/n8n-nodes-langchain.", "@n8n/"] as const;

function stripNodeTypePrefix(type: string): string {
  for (const prefix of N8N_TYPE_PREFIXES) {
    if (type.startsWith(prefix)) return type.slice(prefix.length);
  }
  return type;
}

function normalizePinnedItems(raw: unknown): Item[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const items: Item[] = [];
  for (const entry of raw) {
    if (!isPlainObject(entry)) continue;
    if (isPlainObject(entry.json)) items.push({ json: entry.json as Item["json"] });
    else items.push({ json: entry as Item["json"] });
  }
  return items.length > 0 ? items : undefined;
}

/**
 * 导出成 n8n 兼容形状：连接按**节点名**做键（n8n 的公开导出格式），
 * 节点设置、pinData、settings 一并带出，便于用户在两个工具间迁移。
 */
export function exportWorkflow(workflow: Workflow): Record<string, unknown> {
  const nameById = new Map(workflow.nodes.map((node) => [node.id, node.name]));

  const connections: Record<string, { main: Array<Array<{ node: string; type: "main"; index: number }>> }> = {};
  for (const [sourceId, ports] of Object.entries(workflow.connections ?? {})) {
    const sourceName = nameById.get(sourceId) ?? sourceId;
    const main = (ports?.main ?? []).map((list) =>
      (list ?? []).flatMap((target: WorkflowConnection) => {
        const targetName = nameById.get(target.node);
        return targetName ? [{ node: targetName, type: "main" as const, index: target.index }] : [];
      }),
    );
    if (main.some((list) => list.length > 0)) connections[sourceName] = { main };
  }

  const nodes = workflow.nodes.map((node) => {
    const entry: Record<string, unknown> = {
      id: node.id,
      name: node.name,
      type: node.type,
      typeVersion: 1,
      position: { x: node.position.x, y: node.position.y },
      parameters: node.parameters ?? {},
    };
    if (node.disabled) entry.disabled = true;
    if (node.notes) entry.notes = node.notes;
    if (node.retryOnFail) {
      entry.retryOnFail = true;
      if (node.maxTries !== undefined) entry.maxTries = node.maxTries;
      if (node.waitBetweenTries !== undefined) entry.waitBetweenTries = node.waitBetweenTries;
    }
    if (node.onError) entry.onError = node.onError;
    if (node.alwaysOutputData) entry.alwaysOutputData = true;
    if (node.executeOnce) entry.executeOnce = true;
    if (node.credentials) entry.credentials = { ...node.credentials };
    return entry;
  });

  const pinData: Record<string, Item[]> = {};
  for (const node of workflow.nodes) {
    if (node.pinData && node.pinData.length > 0) pinData[node.name] = node.pinData;
  }

  return {
    id: workflow.id,
    name: workflow.name,
    ...(workflow.description ? { description: workflow.description } : {}),
    active: workflow.active,
    nodes,
    connections,
    ...(Object.keys(pinData).length > 0 ? { pinData } : {}),
    settings: { ...workflow.settings, executionOrder: "v1" },
    tags: [...workflow.tags],
    createdAt: workflow.createdAt,
    updatedAt: workflow.updatedAt,
    ...(workflow.lastRunAt !== undefined ? { lastRunAt: workflow.lastRunAt } : {}),
    meta: { source: "heming-workflow-plugin", version: "0.1.0" },
  };
}

export interface ImportResult {
  workflow: Workflow;
  warnings: string[];
}

/**
 * 从本仓导出或 n8n 导出导入一条**新**工作流：
 * - 支持 `{ nodes, connections }`、`{ workflow: { ... } }` 包装与 JSON 字符串；
 * - 连接键与目标既可以是节点名（n8n）也可以是节点 id（本仓）；
 * - 未知节点类型保留节点并给警告（用户可以先看画布再决定）；
 * - 一律分配新工作流 id，避免导入覆盖已有工作流；导入默认不启用。
 */
export function importWorkflow(rawInput: unknown): ImportResult {
  let raw: unknown = rawInput;
  if (typeof rawInput === "string") {
    try {
      raw = JSON.parse(rawInput) as unknown;
    } catch {
      throw new ToolError("导入内容不是合法 JSON");
    }
  }
  if (!isPlainObject(raw)) throw new ToolError("导入内容必须是对象或 JSON 字符串");
  const candidate = isPlainObject(raw.workflow) ? raw.workflow : raw;

  const rawNodes = Array.isArray(candidate.nodes) ? candidate.nodes : [];
  if (!Array.isArray(candidate.nodes)) throw new ToolError("导入内容缺少 nodes 数组");

  const warnings: string[] = [];
  const nodes: WorkflowNode[] = [];
  const nameToId = new Map<string, string>();
  const knownIds = new Set<string>();

  for (const rawNode of rawNodes.slice(0, 500)) {
    if (!isPlainObject(rawNode)) {
      warnings.push("忽略了一个格式不正确的节点");
      continue;
    }
    const rawType = asString(rawNode.type)?.trim();
    if (!rawType) {
      warnings.push("忽略了一个缺少 type 的节点");
      continue;
    }
    const type = stripNodeTypePrefix(rawType);

    const originalName =
      (asString(rawNode.name)?.trim() || type).slice(0, 40) || type;
    const name = uniqueNodeName({ nodes }, originalName);

    let id: string;
    const rawId = asString(rawNode.id)?.trim();
    if (rawId && !knownIds.has(rawId)) id = rawId.slice(0, 80);
    else {
      let generated = `wf-node-${randomUUID()}`;
      while (knownIds.has(generated)) generated = `wf-node-${randomUUID()}`;
      id = generated;
    }
    knownIds.add(id);

    const positionRaw = isPlainObject(rawNode.position) ? rawNode.position : {};
    const node: WorkflowNode = {
      id,
      name,
      type,
      position: {
        x: toFiniteNumber(positionRaw.x, 160),
        y: toFiniteNumber(positionRaw.y, 160),
      },
      parameters: isPlainObject(rawNode.parameters) ? rawNode.parameters : {},
    };
    if (rawNode.disabled === true) node.disabled = true;
    if (typeof rawNode.notes === "string" && rawNode.notes.trim()) node.notes = rawNode.notes.slice(0, 500);
    if (rawNode.retryOnFail === true) node.retryOnFail = true;
    if (typeof rawNode.maxTries === "number" && Number.isFinite(rawNode.maxTries)) node.maxTries = rawNode.maxTries;
    if (typeof rawNode.waitBetweenTries === "number" && Number.isFinite(rawNode.waitBetweenTries)) {
      node.waitBetweenTries = rawNode.waitBetweenTries;
    }
    if (
      rawNode.onError === "continueRegularOutput" ||
      rawNode.onError === "continueErrorOutput"
    ) {
      node.onError = rawNode.onError;
    }
    if (rawNode.alwaysOutputData === true) node.alwaysOutputData = true;
    if (rawNode.executeOnce === true) node.executeOnce = true;
    if (isPlainObject(rawNode.credentials)) {
      const credentials: Record<string, string> = {};
      for (const [key, value] of Object.entries(rawNode.credentials)) {
        if (typeof value === "string" && value) credentials[key] = value;
      }
      if (Object.keys(credentials).length > 0) node.credentials = credentials;
    }
    const pinned = normalizePinnedItems(rawNode.pinData);
    if (pinned) node.pinData = pinned;

    nodes.push(node);
    nameToId.set(originalName, id);
    if (typeof rawNode.name === "string") nameToId.set(rawNode.name, id);
    if (!getNodeType(type)) {
      warnings.push(`未知节点类型：${rawType}（节点会保留，但执行时会被跳过/报错，请先确认节点库）`);
    }
  }

  // 连接：n8n 用节点名做键，本仓用节点 id；两种都接受。
  const resolveRef = (key: string): string | undefined => {
    const byName = nameToId.get(key);
    if (byName) return byName;
    return knownIds.has(key) ? key : undefined;
  };

  const connections: WorkflowConnections = {};
  const rawConnections = isPlainObject(candidate.connections) ? candidate.connections : {};
  for (const [sourceKey, ports] of Object.entries(rawConnections)) {
    const sourceId = resolveRef(sourceKey);
    if (!sourceId) {
      warnings.push(`连接引用了不存在的节点：${sourceKey}`);
      continue;
    }
    const mainRaw = isPlainObject(ports) && Array.isArray(ports.main) ? ports.main : [];
    const main = mainRaw.map((outputList) => {
      if (!Array.isArray(outputList)) return [] as WorkflowConnection[];
      const targets: WorkflowConnection[] = [];
      for (const target of outputList) {
        if (!isPlainObject(target)) continue;
        const targetKey = asString(target.node);
        const targetId = targetKey ? resolveRef(targetKey) : undefined;
        if (!targetId) {
          warnings.push(`连接指向不存在的节点：${String(target?.node ?? "")}`);
          continue;
        }
        const index = typeof target.index === "number" && Number.isInteger(target.index) && target.index >= 0
          ? target.index
          : 0;
        targets.push({ node: targetId, type: "main", index });
      }
      return targets;
    });
    if (main.some((list) => list.length > 0)) connections[sourceId] = { main };
  }

  // pinData 也可能是顶层 `{ 节点名: items[] }` 的形式。
  if (isPlainObject(candidate.pinData)) {
    for (const [key, value] of Object.entries(candidate.pinData)) {
      const nodeId = resolveRef(key);
      const node = nodeId ? nodes.find((item) => item.id === nodeId) : undefined;
      const pinned = normalizePinnedItems(value);
      if (node && pinned) node.pinData = pinned;
    }
  }

  const tags = Array.isArray(candidate.tags)
    ? candidate.tags.filter((tag): tag is string => typeof tag === "string")
    : [];

  const normalized = normalizeWorkflow({
    name: asString(candidate.name)?.trim() || "导入的工作流",
    ...(asString(candidate.description) ? { description: candidate.description } : {}),
    tags,
    nodes,
    connections,
    settings: candidate.settings,
    // 导入默认不启用：避免一条带定时触发的工作流导入后立刻开跑。
    active: false,
  });
  if (!normalized) throw new ToolError("导入内容无法归一成工作流");

  return { workflow: normalized, warnings };
}

// ---------------------------------------------------------------------------
// 设置（对外脱敏）
// ---------------------------------------------------------------------------

export interface PublicLlmSettings {
  configured: boolean;
  baseUrl?: string;
  model?: string;
}

export function publicSettings(settings: Settings, config?: WorkflowConfig): {
  vars: Record<string, unknown>;
  llm: PublicLlmSettings;
} {
  const llmSource = settings.llm ?? config?.llm;
  const llm: PublicLlmSettings = llmSource
    ? { configured: true, baseUrl: llmSource.baseUrl, model: llmSource.model }
    : { configured: false };
  return { vars: { ...settings.vars }, llm };
}

// ---------------------------------------------------------------------------
// 执行：启动 / 查询 / 摘要
// ---------------------------------------------------------------------------

/** 启动超时：引擎一般在第一个事件就发出 executionStart，10 秒已经是兜底。 */
export const EXECUTION_START_TIMEOUT_MS = 10_000;

export interface StartRunOptions {
  mode?: ExecutionMode;
  startNodeId?: string;
  inputData?: Item[];
}

export interface StartedExecution {
  executionId: string;
  /** 执行完成（含落库）后的结果；HTTP/MCP 可以不等它。 */
  completion: Promise<WorkflowExecution>;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** 把外部传进来的 input 收敛成 items（数组/单个对象都接受）。 */
export function normalizeItems(input: unknown): Item[] | undefined {
  if (input === undefined || input === null) return undefined;
  const list = Array.isArray(input) ? input : [input];
  const items: Item[] = [];
  for (const entry of list) {
    if (!isPlainObject(entry)) continue;
    if (isPlainObject(entry.json)) items.push({ json: entry.json as Item["json"] });
    else if (Array.isArray(entry)) continue;
    else items.push({ json: entry as Item["json"] });
  }
  return items;
}

/**
 * 异步启动一次执行：等到引擎发出 `executionStart`（拿到 executionId）就返回，
 * 不等待整条工作流跑完——这正是 run 接口「立即返回 executionId」的实现方式。
 * 执行完成后在这里统一落库并更新 lastRunAt（真实 Runtime 也会落库，重复保存是幂等的）。
 */
export async function beginExecution(
  store: Store,
  runtime: Runtime,
  workflow: Workflow,
  options: StartRunOptions = {},
): Promise<StartedExecution> {
  const started = deferred<string>();
  let startedSettled = false;

  const settleId = (executionId: string): void => {
    if (startedSettled) return;
    startedSettled = true;
    started.resolve(executionId);
  };
  const settleError = (error: unknown): void => {
    if (startedSettled) return;
    startedSettled = true;
    started.reject(error instanceof Error ? error : new Error(String(error)));
  };

  const runPromise = runtime.runWorkflow(workflow, {
    mode: options.mode ?? "manual",
    ...(options.startNodeId ? { startNodeId: options.startNodeId } : {}),
    ...(options.inputData ? { inputData: options.inputData } : {}),
    onEvent: (event) => {
      if (event.type === "executionStart") settleId(event.execution.id);
    },
  });

  const completion: Promise<WorkflowExecution> = runPromise
    .then((execution) => {
      try {
        // Runtime 自己也会保存；这里再保存一次是幂等的（按 id 覆盖），
        // 让 HTTP/MCP 层不依赖 Runtime 的实现细节。注意：**不要**在这里
        // 写 lastRunAt——调度器用它计算下次触发时间，手动运行不能顺延定时计划。
        store.saveExecution(execution);
      } catch {
        /* 落库失败不影响执行结果；执行记录由 Runtime 自己也会尝试保存 */
      }
      settleId(execution.id);
      return execution;
    })
    .catch((error: unknown) => {
      settleError(error);
      throw error;
    });
  // 调用方可能不关心完成结果；这里挂一个兜底 handler，避免未处理拒绝。
  void completion.catch(() => {});

  const timer = setTimeout(() => {
    settleError(new Error(`执行启动超时（${EXECUTION_START_TIMEOUT_MS / 1000} 秒内没有收到执行开始事件）`));
  }, EXECUTION_START_TIMEOUT_MS);
  timer.unref?.();

  try {
    const executionId = await started.promise;
    return { executionId, completion };
  } finally {
    clearTimeout(timer);
  }
}

/** 执行详情：先看内存里的进行中执行，再看持久化记录（UI 轮询口径）。 */
export function resolveExecution(
  store: Store,
  runtime: Runtime,
  executionId: string,
): WorkflowExecution | undefined {
  return runtime.getLiveExecution(executionId) ?? store.getExecution(executionId);
}

function compactError(error: WorkflowExecution["error"]): Record<string, unknown> | undefined {
  if (!error) return undefined;
  return {
    message: error.message,
    ...(error.description ? { description: error.description } : {}),
    ...(error.nodeName ? { nodeName: error.nodeName } : {}),
    ...(error.httpCode ? { httpCode: error.httpCode } : {}),
  };
}

/**
 * 执行摘要（列表用）：不含 runData，避免把执行数据大对象塞进列表响应。
 * 显式的 `runData: undefined` / `data: undefined` 在 JSON 序列化时会被丢掉。
 */
export function executionSummary(execution: WorkflowExecution): Record<string, unknown> {
  return {
    id: execution.id,
    workflowId: execution.workflowId,
    workflowName: execution.workflowName,
    mode: execution.mode,
    status: execution.status,
    startedAt: execution.startedAt,
    ...(execution.finishedAt !== undefined ? { finishedAt: execution.finishedAt } : {}),
    ...(execution.durationMs !== undefined ? { durationMs: execution.durationMs } : {}),
    ...(execution.triggerNodeId ? { triggerNodeId: execution.triggerNodeId } : {}),
    ...(execution.parentExecutionId ? { parentExecutionId: execution.parentExecutionId } : {}),
    ...(execution.error ? { error: compactError(execution.error) } : {}),
    ...(execution.dataTruncated ? { dataTruncated: true } : {}),
    runData: undefined,
    data: undefined,
  };
}

export function listExecutionSummaries(
  store: Store,
  filter: { workflowId?: string; limit?: number } = {},
): Array<Record<string, unknown>> {
  return store.listExecutions(filter).map((execution) => executionSummary(execution));
}

/**
 * 执行状态 + 逐节点摘要（MCP workflow_run_status 用）。
 * 只回状态/条数/错误，不回节点输入输出数据——智能体轮询时不能把大对象拖回来。
 */
export function summarizeExecution(execution: WorkflowExecution, workflow?: Workflow): Record<string, unknown> {
  const nodeById = new Map((workflow?.nodes ?? []).map((node) => [node.id, node]));
  const nodes = Object.entries(execution.runData ?? {}).map(([nodeId, runs]) => {
    const last = runs[runs.length - 1];
    const definition = nodeById.get(nodeId);
    return {
      nodeId,
      nodeName: definition?.name ?? last?.error?.nodeName ?? nodeId,
      nodeType: definition?.type ?? last?.error?.nodeType,
      runs: runs.length,
      status: last?.status,
      itemsTotal: last?.itemsTotal ?? 0,
      executionTime: last?.executionTime ?? 0,
      startedAt: last?.startTime,
      ...(last?.error
        ? {
            error: {
              message: last.error.message,
              ...(last.error.description ? { description: last.error.description } : {}),
              ...(last.error.httpCode ? { httpCode: last.error.httpCode } : {}),
            },
          }
        : {}),
    };
  });
  return {
    id: execution.id,
    workflowId: execution.workflowId,
    workflowName: execution.workflowName,
    mode: execution.mode,
    status: execution.status,
    startedAt: execution.startedAt,
    ...(execution.finishedAt !== undefined ? { finishedAt: execution.finishedAt } : {}),
    ...(execution.durationMs !== undefined ? { durationMs: execution.durationMs } : {}),
    ...(execution.triggerNodeId ? { triggerNodeId: execution.triggerNodeId } : {}),
    ...(execution.error ? { error: compactError(execution.error) } : {}),
    ...(execution.dataTruncated ? { dataTruncated: true } : {}),
    nodes,
  };
}

/** 节点类型摘要（type/显示名/分组/参数 schema 摘要），供 MCP 智能体决定怎么填参数。 */
export function nodeTypeSummaries(): Array<Record<string, unknown>> {
  return listNodeTypes().map((nodeType) => {
    const description = nodeType.description;
    return {
      type: description.type,
      displayName: description.displayName,
      group: description.group,
      description: description.description,
      isTrigger: description.isTrigger === true,
      inputs: description.inputs,
      outputs: description.outputs,
      parameters: description.properties.map((property) => ({
        name: property.name,
        displayName: property.displayName,
        type: property.type,
        required: property.required === true,
        ...(property.default !== undefined ? { default: property.default } : {}),
        ...(property.options
          ? { options: property.options.map((option) => ({ name: option.name, value: option.value })) }
          : {}),
      })),
    };
  });
}

// ---------------------------------------------------------------------------
// MCP 工具清单
// ---------------------------------------------------------------------------

export interface McpToolInputSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
}

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: McpToolInputSchema;
  run(deps: McpDeps, args: Record<string, unknown>): Promise<unknown>;
}

export interface McpDeps {
  store: Store;
  runtime: Runtime;
  config?: WorkflowConfig;
  version?: string;
}

function emptySchema(): McpToolInputSchema {
  return { type: "object", properties: {}, required: [] };
}

function requireString(args: Record<string, unknown>, name: string, label: string): string {
  const value = args[name];
  if (typeof value !== "string" || !value.trim()) {
    throw new RpcInvalidParams(`缺少参数：${label}（${name}）`);
  }
  return value.trim();
}

function optionalString(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function requireJsonArg(args: Record<string, unknown>, name: string, label: string): unknown {
  if (!(name in args) || args[name] === undefined || args[name] === null) {
    throw new RpcInvalidParams(`缺少参数：${label}（${name}）`);
  }
  return args[name];
}

function getWorkflowOrThrow(store: Store, id: string): Workflow {
  const workflow = store.getWorkflow(id);
  if (!workflow) throw new ToolError(`工作流不存在：${id}`);
  return workflow;
}

function saveNewWorkflow(deps: McpDeps, workflow: Workflow): Workflow {
  return deps.store.saveWorkflow(workflow);
}

const jsonProperty = (description: string): Record<string, unknown> => ({
  type: ["object", "string"],
  description,
});

/** MCP 工具清单（名称/入参/行为对齐 docs/CONTRACT.md §5）。 */
const CORE_TOOLS: McpToolDefinition[] = [
  {
    name: "workflow_list",
    description: "列出所有工作流摘要（id、名称、节点数、是否启用、最近执行状态）。",
    inputSchema: emptySchema(),
    run: async (deps) => ({
      total: deps.store.listWorkflows().length,
      workflows: listWorkflowSummaries(deps.store),
    }),
  },
  {
    name: "workflow_get",
    description: "按 id 读取一条工作流的完整 JSON。",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "工作流 id" } },
      required: ["id"],
    },
    run: async (deps, args) => getWorkflowOrThrow(deps.store, requireString(args, "id", "工作流 id")),
  },
  {
    name: "workflow_create",
    description: "新建工作流；可选传名字或一份完整工作流 JSON（本仓/n8n 形状均可）。",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "工作流名称（可省略）" },
        json: jsonProperty("完整工作流 JSON（可省略；省略时创建空白工作流）"),
      },
      required: [],
    },
    run: async (deps, args) => {
      const name = optionalString(args, "name");
      if ("json" in args && args.json !== undefined && args.json !== null) {
        const { workflow, warnings } = importWorkflow(args.json);
        const saved = saveNewWorkflow(deps, workflow);
        return { ok: true, workflow: saved, warnings };
      }
      const created = deps.store.createWorkflow(name ? { name } : {});
      return { ok: true, workflow: created, warnings: [] };
    },
  },
  {
    name: "workflow_update",
    description: "用一份完整工作流 JSON 覆盖保存指定工作流，并返回校验问题。",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "工作流 id" },
        json: jsonProperty("完整工作流 JSON（本仓/n8n 形状均可）"),
      },
      required: ["id", "json"],
    },
    run: async (deps, args) => {
      const id = requireString(args, "id", "工作流 id");
      const existing = getWorkflowOrThrow(deps.store, id);
      const raw = requireJsonArg(args, "json", "工作流 JSON");
      const imported = importWorkflow(raw);
      const merged = normalizeWorkflow({
        ...imported.workflow,
        id,
        createdAt: existing.createdAt,
        active: existing.active,
      });
      if (!merged) throw new ToolError("工作流数据不完整，无法保存");
      const issues = validateWorkflow(merged);
      const saved = deps.store.saveWorkflow(merged);
      return { ok: true, workflow: saved, issues, warnings: imported.warnings };
    },
  },
  {
    name: "workflow_delete",
    description: "删除一条工作流（其执行记录会一起清理）。",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "工作流 id" } },
      required: ["id"],
    },
    run: async (deps, args) => {
      const id = requireString(args, "id", "工作流 id");
      getWorkflowOrThrow(deps.store, id);
      const removed = deps.store.removeWorkflow(id);
      if (!removed) throw new ToolError(`工作流不存在：${id}`);
      return { ok: true, id };
    },
  },
  {
    name: "workflow_validate",
    description: "只校验一份工作流 JSON，不入库；返回问题列表与导入警告。",
    inputSchema: {
      type: "object",
      properties: { json: jsonProperty("待校验的工作流 JSON") },
      required: ["json"],
    },
    run: async (_deps, args) => {
      const raw = requireJsonArg(args, "json", "工作流 JSON");
      const { workflow, warnings } = importWorkflow(raw);
      const issues = validateWorkflow(workflow);
      return { ok: issues.every((issue) => issue.level !== "error"), issues, warnings };
    },
  },
  {
    name: "workflow_templates",
    description: "列出起手模板（id、名称、说明与可直接创建的工作流 JSON）。",
    inputSchema: emptySchema(),
    run: async () => ({
      templates: WORKFLOW_TEMPLATES.map((template) => {
        try {
          return {
            id: template.id,
            name: template.name,
            description: template.description,
            workflow: template.build(),
          };
        } catch (error) {
          return {
            id: template.id,
            name: template.name,
            description: template.description,
            workflow: null,
            error: `模板暂时不可用：${error instanceof Error ? error.message : String(error)}`,
          };
        }
      }),
    }),
  },
  {
    name: "workflow_run",
    description: "异步启动一次执行并立即返回 executionId；用 workflow_run_status 轮询结果。",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "工作流 id" },
        startNodeId: { type: "string", description: "从哪个节点开始（可省略，默认从触发器开始）" },
        input: { description: "传给触发节点的数据：对象/对象数组/items 数组均可" },
      },
      required: ["id"],
    },
    run: async (deps, args) => {
      const id = requireString(args, "id", "工作流 id");
      const workflow = getWorkflowOrThrow(deps.store, id);
      if (deps.runtime.isRunning(id)) throw new ToolError(`工作流「${workflow.name}」正在运行，等它结束再试`);
      const { executionId } = await beginExecution(deps.store, deps.runtime, workflow, {
        mode: "manual",
        ...(optionalString(args, "startNodeId") ? { startNodeId: optionalString(args, "startNodeId") } : {}),
        ...(normalizeItems(args.input) ? { inputData: normalizeItems(args.input) } : {}),
      });
      return {
        executionId,
        workflowId: id,
        status: "running",
        hint: "执行已异步启动；请用 workflow_run_status 轮询，直到 status 为 success/error/canceled。",
      };
    },
  },
  {
    name: "workflow_run_status",
    description: "查询一次执行的状态与逐节点摘要（状态/条数/错误，不含大数据）。",
    inputSchema: {
      type: "object",
      properties: { executionId: { type: "string", description: "执行 id" } },
      required: ["executionId"],
    },
    run: async (deps, args) => {
      const executionId = requireString(args, "executionId", "执行 id");
      const execution = resolveExecution(deps.store, deps.runtime, executionId);
      if (!execution) throw new ToolError(`执行记录不存在：${executionId}`);
      return summarizeExecution(execution, deps.store.getWorkflow(execution.workflowId));
    },
  },
  {
    name: "workflow_runs",
    description: "最近执行摘要列表（可按工作流过滤，不含节点数据）。",
    inputSchema: {
      type: "object",
      properties: {
        workflowId: { type: "string", description: "按工作流 id 过滤（可省略）" },
        limit: { type: "number", description: "最多返回多少条（默认 20，最大 100）" },
      },
      required: [],
    },
    run: async (deps, args) => {
      const workflowId = optionalString(args, "workflowId");
      const rawLimit = args.limit;
      const limit = Math.min(100, Math.max(1, Math.trunc(typeof rawLimit === "number" && Number.isFinite(rawLimit) ? rawLimit : 20)));
      const executions = listExecutionSummaries(deps.store, {
        ...(workflowId ? { workflowId } : {}),
        limit,
      });
      return { total: executions.length, executions };
    },
  },
  {
    name: "node_types",
    description: "节点类型清单：type、显示名、分组与参数 schema 摘要。",
    inputSchema: emptySchema(),
    run: async () => ({ nodeTypes: nodeTypeSummaries() }),
  },
  {
    name: "credential_types",
    description: "支持的凭据类型与字段（值加密存放，列表不回密钥）。",
    inputSchema: emptySchema(),
    run: async () => ({ types: CREDENTIAL_TYPES }),
  },
  {
    name: "workflow_import",
    description: "从 n8n/本仓 JSON 导入一条新工作流（默认不启用）。",
    inputSchema: {
      type: "object",
      properties: { json: jsonProperty("要导入的工作流 JSON 或 JSON 字符串") },
      required: ["json"],
    },
    run: async (deps, args) => {
      const raw = requireJsonArg(args, "json", "工作流 JSON");
      const { workflow, warnings } = importWorkflow(raw);
      const saved = saveNewWorkflow(deps, workflow);
      return { ok: true, workflow: saved, warnings };
    },
  },
  {
    name: "workflow_export",
    description: "把一条工作流导出成类 n8n JSON（连接按节点名）。",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "工作流 id" } },
      required: ["id"],
    },
    run: async (deps, args) => exportWorkflow(getWorkflowOrThrow(deps.store, requireString(args, "id", "工作流 id"))),
  },
];

/**
 * 完整工具清单：核心 CRUD/运行工具 + 智能体自主设计需要的辅助工具
 * （凭据发现、节点完整 schema、试跑、启用/停用、外部 MCP 工具发现）。
 */
export const MCP_TOOLS: readonly McpToolDefinition[] = [...CORE_TOOLS, ...AGENT_TOOLS];

// ---------------------------------------------------------------------------
// JSON-RPC 处理
// ---------------------------------------------------------------------------

export const MCP_PROTOCOL_VERSION = "2025-03-26";
const SUPPORTED_PROTOCOL_VERSIONS = [MCP_PROTOCOL_VERSION, "2025-06-18", "2024-11-05"] as const;
const SERVER_NAME = "heming-workflow-plugin";

export interface McpCallInput {
  /** HTTP 层解析好的 JSON body；解析失败由 HTTP 层自己回 -32700。 */
  body: unknown;
  /** 请求头里的 mcp-session-id（可没有）。 */
  sessionId?: string | null;
}

export interface McpCallOutput {
  status: number;
  body: string;
  headers?: Record<string, string>;
}

interface RpcId {
  id: string | number | null;
}

function rpcResult(id: RpcId["id"], result: unknown): McpCallOutput {
  return { status: 200, body: JSON.stringify({ jsonrpc: "2.0", id, result }) };
}

function rpcError(status: number, id: RpcId["id"], code: number, message: string): McpCallOutput {
  return { status, body: JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) };
}

/** 读 JSON-RPC 的 id：字符串或数字才算有效 id；其它一律当通知/无效。 */
function parseId(value: unknown): string | number | null {
  return typeof value === "string" || typeof value === "number" ? value : null;
}

/**
 * 创建 MCP 处理器；HTTP 层只负责解析 body、设置响应头与状态码。
 * 返回的函数**永不抛错**（协议错误用 JSON-RPC error 表示）。
 */
export function createMcpHandler(deps: McpDeps): (input: McpCallInput) => Promise<McpCallOutput> {
  const serverVersion = deps.version ?? "0.1.0";

  return async function handleMcp(input: McpCallInput): Promise<McpCallOutput> {
    if (!isPlainObject(input.body)) {
      return rpcError(400, null, -32600, "无效请求：JSON-RPC 请求体必须是对象");
    }
    const request = input.body;
    const id = parseId(request.id);
    const isNotification = request.id === undefined || request.id === null;

    if (request.jsonrpc !== "2.0") {
      return rpcError(400, id, -32600, '无效请求：jsonrpc 字段必须是 "2.0"');
    }
    const method = typeof request.method === "string" ? request.method : "";
    if (!method) return rpcError(400, id, -32600, "无效请求：缺少 method");

    // 通知（无 id）按 JSON-RPC 语义不回响应体；和鸣客户端的 notifications/initialized 走这里。
    if (method === "notifications/initialized" || isNotification) {
      return { status: 202, body: "" };
    }

    try {
      const params = isPlainObject(request.params) ? request.params : {};

      if (method === "initialize") {
        const requested = asString(params.protocolVersion);
        const protocolVersion =
          requested && (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
            ? requested
            : MCP_PROTOCOL_VERSION;
        const sessionId =
          typeof input.sessionId === "string" && input.sessionId.trim() ? input.sessionId.trim() : randomUUID();
        return {
          status: 200,
          body: JSON.stringify({
            jsonrpc: "2.0",
            id,
            result: {
              protocolVersion,
              capabilities: { tools: { listChanged: false } },
              serverInfo: { name: SERVER_NAME, title: "和鸣工作流引擎", version: serverVersion },
            },
          }),
          headers: { "mcp-session-id": sessionId },
        };
      }

      if (method === "ping") return rpcResult(id, {});

      if (method === "tools/list") {
        return rpcResult(id, {
          tools: MCP_TOOLS.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
          })),
        });
      }

      if (method === "tools/call") {
        const toolName = asString(params.name);
        if (!toolName) return rpcError(200, id, -32602, "参数错误：tools/call 缺少 name");
        const tool = MCP_TOOLS.find((candidate) => candidate.name === toolName);
        if (!tool) return rpcError(200, id, -32602, `参数错误：未知工具 ${toolName}`);
        const args = isPlainObject(params.arguments) ? params.arguments : {};
        try {
          const result = await tool.run(deps, args);
          return rpcResult(id, {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          });
        } catch (error) {
          if (error instanceof RpcInvalidParams) {
            return rpcError(200, id, -32602, error.message);
          }
          const message = error instanceof Error ? error.message : String(error);
          // 业务失败（工作流不存在/正在运行等）给智能体可读文本，由它决定下一步。
          return rpcResult(id, {
            content: [{ type: "text", text: message }],
            isError: true,
          });
        }
      }

      return rpcError(200, id, -32601, `不支持的方法：${method}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return rpcError(500, id, -32603, `服务内部错误：${message}`);
    }
  };
}
