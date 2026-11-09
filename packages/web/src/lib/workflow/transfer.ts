/**
 * 导入/导出：本仓 Workflow ↔ 类 n8n 的 JSON。
 *
 * 为什么导出要贴着 n8n 的形状：工作流是「可以被带走的本机资产」，用户可能想把它
 * 交给 n8n 生态的工具链（或从那边搬一份过来）。这里只按官方文档公开的**数据形状**
 * 做映射——没有使用 n8n 的源码或 npm 包（许可红线见 CONTRACT §2）。
 *
 * 两条关键约定：
 * 1. 导出的连接以**节点名字**为键（n8n 的形状），导入时再按名字→id 重映射；
 *    本仓内部始终用 id 做键，重命名节点不会丢边。
 * 2. 导入永不抛：坏 JSON、未知节点类型、坏连接都收敛成中文 `errors` / `warnings`，
 *    UI 直接展示。能救的救（丢一个节点继续导），不能救的明确失败。
 */

import { createWorkflow, defaultWorkflowSettings, newId, normalizeWorkflow } from "./model.js";
import {
  WORKFLOW_LIMITS,
  type Item,
  type Workflow,
  type WorkflowConnection,
  type WorkflowConnections,
  type WorkflowNode,
  type WorkflowSettings,
} from "./types.js";
import { getNodeType } from "./registry.js";

/** n8n 导出里节点类型的公共前缀。 */
const N8N_TYPE_PREFIX = "n8n-nodes-base.";
/** 本仓专有节点导出时用的是这个前缀（n8n 不认识，但本仓能原样导回来）。 */
const HEMING_TYPE_PREFIX = "heming.";

/** 本仓全部节点类型 id（与 CONTRACT §6 一致；用于判断「是不是我们的类型」）。 */
const HEMING_NODE_TYPES = new Set<string>([
  "manualTrigger",
  "scheduleTrigger",
  "errorTrigger",
  "executeWorkflowTrigger",
  "httpRequest",
  "code",
  "set",
  "if",
  "switch",
  "merge",
  "splitInBatches",
  "splitOut",
  "filter",
  "sort",
  "limit",
  "removeDuplicates",
  "aggregate",
  "itemLists",
  "wait",
  "noOperation",
  "stopAndError",
  "executeWorkflow",
  "dateTime",
  "crypto",
  "xml",
  "llm",
  "infohubSearch",
  "infohubAgenda",
  "infohubSync",
  "notification",
]);

/** 本仓没有、但 n8n 常见的类型 → 本仓最接近的节点（救不回来的话导入会很挫败）。 */
const N8N_ALIASES: Readonly<Record<string, string>> = {
  noOp: "noOperation",
  start: "manualTrigger",
  cron: "scheduleTrigger",
  function: "code",
  functionItem: "code",
};

/** 本仓类型 → n8n 认识的类型（不在表里的用 `heming.` 前缀原样带走）。 */
const N8N_EXPORT_TYPES: Readonly<Record<string, string>> = {
  manualTrigger: "manualTrigger",
  scheduleTrigger: "scheduleTrigger",
  errorTrigger: "errorTrigger",
  executeWorkflowTrigger: "executeWorkflowTrigger",
  httpRequest: "httpRequest",
  code: "code",
  set: "set",
  if: "if",
  switch: "switch",
  merge: "merge",
  splitInBatches: "splitInBatches",
  splitOut: "splitOut",
  filter: "filter",
  sort: "sort",
  limit: "limit",
  removeDuplicates: "removeDuplicates",
  aggregate: "aggregate",
  itemLists: "itemLists",
  wait: "wait",
  noOperation: "noOp",
  stopAndError: "stopAndError",
  executeWorkflow: "executeWorkflow",
  dateTime: "dateTime",
  crypto: "crypto",
  xml: "xml",
};

/** 导出的一条节点（字段接近 n8n，但只覆盖本仓用得到的）。 */
export interface N8nNodeExport {
  name: string;
  type: string;
  typeVersion: number;
  position: [number, number];
  parameters: Record<string, unknown>;
  disabled?: boolean;
  notes?: string;
  retryOnFail?: boolean;
  maxTries?: number;
  waitBetweenTries?: number;
  onError?: string;
  executeOnce?: boolean;
  alwaysOutputData?: boolean;
  credentials?: Record<string, { id: string; name: string }>;
}

/** 一次导出（`exportWorkflow` 的返回值；UI 直接 JSON.stringify）。 */
export interface N8nWorkflowExport {
  name: string;
  nodes: N8nNodeExport[];
  connections: Record<string, { main: Array<Array<{ node: string; type: "main"; index: number }>> }>;
  pinData: Record<string, Item[]>;
  settings: WorkflowSettings;
  active: boolean;
  tags: string[];
}

/** 本仓类型 → 导出类型。 */
export function toExportType(type: string): string {
  const mapped = N8N_EXPORT_TYPES[type];
  if (mapped) return `${N8N_TYPE_PREFIX}${mapped}`;
  return `${HEMING_TYPE_PREFIX}${type}`;
}

/**
 * 导入类型 → 本仓类型；认不出来返回 null。
 *
 * 顺序很重要：先剥命名空间，再查别名（noOp/start/cron），最后才按「是否本仓类型」判断。
 * 注册表里已注册的类型也认（节点库后续新增的类型不必回来改这张表）。
 */
export function resolveImportType(rawType: string): string | null {
  const raw = rawType.trim();
  if (!raw) return null;
  let suffix = raw;
  if (raw.startsWith(HEMING_TYPE_PREFIX)) suffix = raw.slice(HEMING_TYPE_PREFIX.length);
  else if (raw.startsWith(N8N_TYPE_PREFIX)) suffix = raw.slice(N8N_TYPE_PREFIX.length);
  else if (raw.startsWith("@n8n/") || raw.includes(".")) suffix = raw.slice(raw.lastIndexOf(".") + 1);
  const alias = N8N_ALIASES[suffix];
  if (alias) return alias;
  if (HEMING_NODE_TYPES.has(suffix)) return suffix;
  if (getNodeType(suffix)) return suffix;
  return null;
}

type UnknownNodeMode = "drop" | "error";

export interface WorkflowImportOptions {
  /** 导入时间（测试注入；节点 id 也用它生成）。 */
  now?: number;
  /** 未知节点类型：丢弃（默认）还是整体失败。 */
  onUnknownNode?: UnknownNodeMode;
}

/**
 * 导入结果。`ok` 为 true 时 `workflow` 一定存在；失败时只有错误清单。
 * `warnings` 是非致命问题（例如丢了一个未知节点），UI 建议黄条展示。
 */
export type WorkflowImportResult =
  | { ok: true; workflow: Workflow; errors: string[]; warnings: string[] }
  | { ok: false; workflow?: undefined; errors: string[]; warnings: string[] };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return isPlainObject(value) ? value : {};
}

function parsePosition(raw: unknown, index: number): { x: number; y: number } {
  if (Array.isArray(raw) && raw.length >= 2 && isFiniteNumber(raw[0]) && isFiniteNumber(raw[1])) {
    return { x: raw[0], y: raw[1] };
  }
  if (isPlainObject(raw) && isFiniteNumber(raw.x) && isFiniteNumber(raw.y)) {
    return { x: raw.x, y: raw.y };
  }
  // 没有位置信息（例如手写的 JSON）时按列排开，至少不会全叠在原点。
  return { x: 200 + (index % 6) * 260, y: 200 + Math.floor(index / 6) * 180 };
}

function normalizePinItem(raw: unknown): Item | null {
  if (!isPlainObject(raw)) return null;
  if (isPlainObject(raw.json)) return { json: raw.json };
  return { json: raw };
}

function parsePinList(raw: unknown): Item[] {
  if (!Array.isArray(raw)) return [];
  const items: Item[] = [];
  for (const entry of raw) {
    const item = normalizePinItem(entry);
    if (item) items.push(item);
    if (items.length >= WORKFLOW_LIMITS.maxItemsPerNodeRun) break;
  }
  return items;
}

function parseCredentials(raw: unknown): Record<string, string> | undefined {
  if (!isPlainObject(raw)) return undefined;
  const credentials: Record<string, string> = {};
  for (const [type, value] of Object.entries(raw)) {
    if (typeof value === "string" && value) credentials[type] = value;
    else if (isPlainObject(value) && typeof value.id === "string" && value.id) {
      credentials[type] = value.id;
    }
  }
  return Object.keys(credentials).length > 0 ? credentials : undefined;
}

function parseTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const tags: string[] = [];
  for (const entry of raw) {
    const name =
      typeof entry === "string"
        ? entry
        : isPlainObject(entry) && typeof entry.name === "string"
          ? entry.name
          : "";
    const trimmed = name.trim();
    if (trimmed && !tags.includes(trimmed)) tags.push(trimmed);
  }
  return tags.slice(0, 10);
}

function parseSettings(raw: unknown): WorkflowSettings {
  const settings = defaultWorkflowSettings();
  if (!isPlainObject(raw)) return settings;
  settings.saveDataSuccessExecution = raw.saveDataSuccessExecution === "none" ? "none" : "all";
  settings.saveDataErrorExecution = raw.saveDataErrorExecution === "none" ? "none" : "all";
  settings.saveManualExecutions = raw.saveManualExecutions !== false;
  settings.callerPolicy = raw.callerPolicy === "none" ? "none" : "any";
  // 本仓字段名是 errorWorkflowId；n8n 的导出里叫 errorWorkflow，两个都认。
  const errorWorkflow =
    typeof raw.errorWorkflowId === "string"
      ? raw.errorWorkflowId
      : typeof raw.errorWorkflow === "string"
        ? raw.errorWorkflow
        : "";
  if (errorWorkflow) settings.errorWorkflowId = errorWorkflow;
  return settings;
}

/** 一条导出节点的构造（导出与测试共用）。 */
function exportNode(node: WorkflowNode): N8nNodeExport {
  const result: N8nNodeExport = {
    name: node.name,
    type: toExportType(node.type),
    typeVersion: getNodeType(node.type)?.description.version ?? 1,
    position: [node.position.x, node.position.y],
    parameters: node.parameters ?? {},
  };
  if (node.disabled) result.disabled = true;
  if (node.notes) result.notes = node.notes;
  if (node.retryOnFail) result.retryOnFail = true;
  if (typeof node.maxTries === "number") result.maxTries = node.maxTries;
  if (typeof node.waitBetweenTries === "number") result.waitBetweenTries = node.waitBetweenTries;
  if (node.onError) result.onError = node.onError;
  if (node.executeOnce) result.executeOnce = true;
  if (node.alwaysOutputData) result.alwaysOutputData = true;
  if (node.credentials) {
    const credentials: Record<string, { id: string; name: string }> = {};
    for (const [type, id] of Object.entries(node.credentials)) {
      credentials[type] = { id, name: id };
    }
    result.credentials = credentials;
  }
  return result;
}

/**
 * 导出成类 n8n JSON。
 *
 * 连接按节点 name 输出：n8n 的内部连接表就是按名字索引的；同时把 `pinData`
 * 收成「节点名 → items」的对象（与 n8n 的导出形状一致）。
 */
export function exportWorkflow(workflow: Workflow): N8nWorkflowExport {
  const nodes = workflow.nodes.map(exportNode);
  const byId = new Map(workflow.nodes.map((node) => [node.id, node]));
  const connections: N8nWorkflowExport["connections"] = {};
  for (const [sourceId, ports] of Object.entries(workflow.connections)) {
    const source = byId.get(sourceId);
    if (!source || !ports?.main) continue;
    const main = ports.main.map((list) =>
      (list ?? [])
        .map((target) => {
          const targetNode = byId.get(target.node);
          if (!targetNode) return null;
          return { node: targetNode.name, type: "main" as const, index: target.index };
        })
        .filter((entry): entry is { node: string; type: "main"; index: number } => entry !== null),
    );
    connections[source.name] = { main };
  }
  const pinData: Record<string, Item[]> = {};
  for (const node of workflow.nodes) {
    if (node.pinData && node.pinData.length > 0) pinData[node.name] = node.pinData;
  }
  return {
    name: workflow.name,
    nodes,
    connections,
    pinData,
    settings: { ...workflow.settings },
    active: workflow.active,
    tags: [...workflow.tags],
  };
}

/** 导出成文本（默认缩进 2 空格：用户会直接看/改这份 JSON）。 */
export function exportWorkflowJson(workflow: Workflow, pretty = true): string {
  return JSON.stringify(exportWorkflow(workflow), null, pretty ? 2 : 0);
}

/** 从文本导入：JSON 坏了给中文错误（而不是浏览器那句英文 SyntaxError）。 */
export function importWorkflowFromText(
  text: string,
  options: WorkflowImportOptions = {},
): WorkflowImportResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return {
      ok: false,
      errors: [`不是合法的 JSON：${error instanceof Error ? error.message : String(error)}`],
      warnings: [],
    };
  }
  return importWorkflow(parsed, options);
}

/**
 * 导入 n8n 或本仓导出的 JSON。
 *
 * 容错策略：
 * - 没有 `nodes` 数组 / 不是对象 → 失败；
 * - 单个节点坏（类型缺失/名字空）→ 丢弃并记 warning；
 * - 未知节点类型 → 默认丢弃并记 warning；`onUnknownNode: "error"` 时整体失败；
 * - 连接引用了被丢弃/不存在的节点 → 丢弃并记 warning；
 * - 一个节点都没导入成功、但源数据里确实有节点 → 失败（空工作流会让人以为导入成功）。
 */
export function importWorkflow(
  raw: unknown,
  options: WorkflowImportOptions = {},
): WorkflowImportResult {
  const now = options.now ?? Date.now();
  const onUnknownNode: UnknownNodeMode = options.onUnknownNode ?? "drop";
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!isPlainObject(raw)) {
    return { ok: false, errors: ["导入内容必须是一个 JSON 对象"], warnings };
  }
  const rawNodes = Array.isArray(raw.nodes) ? raw.nodes : null;
  if (!rawNodes) {
    return { ok: false, errors: ["缺少 nodes 数组：这不像一份工作流导出"], warnings };
  }

  const nodes: WorkflowNode[] = [];
  const nameToId = new Map<string, string>();
  const usedNames = new Set<string>();
  const unknownTypes = new Map<string, number>();
  const generation = createWorkflow({ now }); // 只借它的默认 settings 等常量，不保留 id

  rawNodes.forEach((entry, index) => {
    if (!isPlainObject(entry)) {
      warnings.push(`第 ${index + 1} 个节点不是对象，已跳过`);
      return;
    }
    const rawType = typeof entry.type === "string" ? entry.type.trim() : "";
    if (!rawType) {
      warnings.push(`第 ${index + 1} 个节点缺少 type，已跳过`);
      return;
    }
    const type = resolveImportType(rawType);
    if (!type) {
      unknownTypes.set(rawType, (unknownTypes.get(rawType) ?? 0) + 1);
      warnings.push(`不支持的节点类型「${rawType}」，已跳过该节点`);
      return;
    }
    const rawName = typeof entry.name === "string" ? entry.name.trim() : "";
    const baseName = rawName || type;
    let name = baseName;
    let suffix = 2;
    while (usedNames.has(name)) {
      name = `${baseName} ${suffix}`;
      suffix += 1;
    }
    usedNames.add(name);
    const id = newId("wf-node", now);
    nameToId.set(name, id);
    const node: WorkflowNode = {
      id,
      name,
      type,
      position: parsePosition(entry.position, index),
      parameters: asRecord(entry.parameters),
    };
    if (entry.disabled === true) node.disabled = true;
    if (typeof entry.notes === "string" && entry.notes.trim()) node.notes = entry.notes.trim();
    if (entry.retryOnFail === true) node.retryOnFail = true;
    if (isFiniteNumber(entry.maxTries)) {
      node.maxTries = Math.min(
        WORKFLOW_LIMITS.maxTries,
        Math.max(2, Math.trunc(entry.maxTries)),
      );
    }
    if (isFiniteNumber(entry.waitBetweenTries)) {
      node.waitBetweenTries = Math.min(
        WORKFLOW_LIMITS.maxWaitBetweenTries,
        Math.max(0, Math.trunc(entry.waitBetweenTries)),
      );
    }
    if (
      entry.onError === "continueRegularOutput" ||
      entry.onError === "continueErrorOutput" ||
      entry.onError === "stopWorkflow"
    ) {
      if (entry.onError !== "stopWorkflow") node.onError = entry.onError;
    }
    if (entry.executeOnce === true) node.executeOnce = true;
    if (entry.alwaysOutputData === true) node.alwaysOutputData = true;
    const credentials = parseCredentials(entry.credentials);
    if (credentials) node.credentials = credentials;
    if (Array.isArray(entry.pinData)) {
      const pinned = parsePinList(entry.pinData);
      if (pinned.length > 0) node.pinData = pinned;
    }
    nodes.push(node);
  });

  if (unknownTypes.size > 0 && onUnknownNode === "error") {
    for (const type of unknownTypes.keys()) {
      errors.push(`不支持的节点类型「${type}」`);
    }
    return { ok: false, errors, warnings };
  }
  if (nodes.length === 0 && rawNodes.length > 0) {
    return {
      ok: false,
      errors: ["导入的内容里没有本仓支持的节点（可能来自未支持的工作流平台）"],
      warnings,
    };
  }

  // 顶层 pinData（n8n 新导出形状：节点名 → items）。
  if (isPlainObject(raw.pinData)) {
    for (const [nodeName, pinRaw] of Object.entries(raw.pinData)) {
      const node = nodes.find((candidate) => candidate.name === nodeName);
      if (!node) continue;
      const pinned = parsePinList(pinRaw);
      if (pinned.length > 0) node.pinData = pinned;
    }
  }

  // 按名字 → id 重映射连接。
  const connections: WorkflowConnections = {};
  if (isPlainObject(raw.connections)) {
    for (const [sourceName, group] of Object.entries(raw.connections)) {
      const sourceId = nameToId.get(sourceName);
      if (!sourceId) {
        warnings.push(`连接引用了不存在的节点「${sourceName}」，已跳过`);
        continue;
      }
      const mainRaw = isPlainObject(group) && Array.isArray(group.main) ? group.main : [];
      const main: WorkflowConnection[][] = [];
      mainRaw.forEach((list, outputIndex) => {
        if (!Array.isArray(list)) return;
        const targets: WorkflowConnection[] = [];
        for (const target of list) {
          if (!isPlainObject(target)) continue;
          const targetName = typeof target.node === "string" ? target.node : "";
          const targetId = targetName ? nameToId.get(targetName) : undefined;
          if (!targetId) {
            warnings.push(`连接指向不存在的节点「${targetName || "未命名"}」，已跳过`);
            continue;
          }
          const inputIndex =
            isFiniteNumber(target.index) && target.index >= 0 ? Math.trunc(target.index) : 0;
          targets.push({ node: targetId, type: "main", index: inputIndex });
        }
        main[outputIndex] = targets;
      });
      connections[sourceId] = { main };
    }
  }

  const workflow: Workflow = {
    ...generation,
    id: newId("wf", now),
    name: typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : "导入的工作流",
    nodes,
    connections,
    settings: parseSettings(raw.settings),
    active: raw.active === true,
    versionId: newId("ver", now),
    createdAt: now,
    updatedAt: now,
  };
  if (typeof raw.description === "string" && raw.description.trim()) {
    workflow.description = raw.description.trim();
  }
  const tags = parseTags(raw.tags);
  if (tags.length > 0) workflow.tags = tags;

  // 最后再用仓库自己的归一函数兜一遍（它会保证节点/连接/名称都在契约范围内）。
  const normalized = normalizeWorkflow(workflow, now);
  if (!normalized) {
    return { ok: false, errors: ["导入的工作流结构不合法"], warnings };
  }
  return { ok: true, workflow: normalized, errors, warnings };
}
