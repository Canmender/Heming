/**
 * 工作流模型：创建、连接、校验、归一（读盘/导入）与纯查询helper。
 *
 * 这里**不执行任何节点**，也不碰 localStorage——执行在 `engine/`，持久化在 `store.ts`。
 * 把「工作流的形状」与「怎么跑 / 怎么存」分开，是为了让三处可以各自测试：
 * 改画布不需要跑引擎，改引擎不需要挂 React。
 *
 * 连接用**节点 id** 做键（见 types.ts 的 `WorkflowConnections`）：重命名节点不会丢边。
 * 显示名仍参与表达式（`$node["名字"]`）与错误信息，所以名字在工作流内保持唯一。
 */

import { getNodeType } from "./registry.js";
import {
  WORKFLOW_LIMITS,
  retryParams,
  type Item,
  type NodePropertyDescription,
  type NodeTypeDescription,
  type Workflow,
  type WorkflowConnection,
  type WorkflowConnections,
  type WorkflowNode,
  type WorkflowSettings,
} from "./types.js";

export const WORKFLOW_NAME_MAX = 60;
export const NODE_NAME_MAX = 40;
export const MAX_TAGS = 10;
export const TAG_MAX = 20;
export const MAX_NODES = 200;

let seq = 0;

/** 生成稳定 id（时间 + 序号 + 随机尾；不用 crypto 以便测试可预期前缀）。 */
export function newId(prefix: string, now: number = Date.now()): string {
  seq += 1;
  return `${prefix}-${now.toString(36)}-${seq.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

export function defaultWorkflowSettings(): WorkflowSettings {
  return {
    timezone: "local",
    saveDataSuccessExecution: "all",
    saveDataErrorExecution: "all",
    saveManualExecutions: true,
    callerPolicy: "any",
  };
}

/** 新建一条空工作流。 */
export function createWorkflow(opts: { name?: string; id?: string; now?: number } = {}): Workflow {
  const now = opts.now ?? Date.now();
  return {
    id: opts.id ?? newId("wf", now),
    name: clipName(opts.name?.trim() || "未命名工作流", WORKFLOW_NAME_MAX),
    tags: [],
    nodes: [],
    connections: {},
    settings: defaultWorkflowSettings(),
    active: false,
    versionId: newId("ver", now),
    createdAt: now,
    updatedAt: now,
  };
}

/** 文本截断（按码点，不劈 emoji；末尾补省略号）。 */
export function clipText(text: string, max: number): string {
  const chars = [...String(text ?? "").replace(/\s+/g, " ").trim()];
  if (chars.length <= max) return chars.join("");
  return `${chars.slice(0, Math.max(0, max - 1)).join("")}…`;
}

function clipName(text: string, max: number): string {
  return [...String(text ?? "")].slice(0, max).join("").trim();
}

/** 由节点描述生成默认参数（只写有 default 的字段）。 */
export function defaultParametersFor(description: NodeTypeDescription): Record<string, unknown> {
  const parameters: Record<string, unknown> = {};
  for (const property of description.properties) {
    if (property.default !== undefined) {
      parameters[property.name] = cloneValue(property.default);
    }
  }
  return parameters;
}

function cloneValue<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

/** 工作流内唯一的节点名：`基础名`、`基础名 2`、`基础名 3`…… */
export function uniqueNodeName(workflow: Pick<Workflow, "nodes">, base: string): string {
  const trimmed = clipName(base || "节点", NODE_NAME_MAX) || "节点";
  const used = new Set(workflow.nodes.map((node) => node.name));
  if (!used.has(trimmed)) return trimmed;
  let n = 2;
  while (n < 1000) {
    const candidate = `${trimmed} ${n}`;
    if (!used.has(candidate)) return candidate;
    n += 1;
  }
  return `${trimmed} ${newId("n").slice(-4)}`;
}

/** 按 type 新建节点；type 未注册时抛错（UI 只从调色板建节点，不会走到这里）。 */
export function createNode(
  type: string,
  opts: { workflow?: Pick<Workflow, "nodes">; position?: { x: number; y: number }; name?: string; id?: string },
): WorkflowNode {
  const nodeType = getNodeType(type);
  if (!nodeType) throw new Error(`未知的节点类型：${type}`);
  const baseName = opts.name?.trim() || nodeType.description.defaultName || nodeType.description.displayName;
  return {
    id: opts.id ?? newId("wf-node"),
    name: opts.workflow ? uniqueNodeName(opts.workflow, baseName) : clipName(baseName, NODE_NAME_MAX),
    type,
    position: opts.position ?? { x: 160, y: 160 },
    parameters: defaultParametersFor(nodeType.description),
  };
}

/** 复制一个节点（粘贴/克隆用）：新 id、新名字、保留参数与节点级设置，丢掉运行时数据。 */
export function cloneNode(node: WorkflowNode, workflow: Pick<Workflow, "nodes">): WorkflowNode {
  const copy: WorkflowNode = {
    ...node,
    id: newId("wf-node"),
    name: uniqueNodeName(workflow, node.name),
    position: { x: node.position.x, y: node.position.y },
    parameters: cloneValue(node.parameters),
  };
  delete copy.pinData;
  return copy;
}

/** 工作流里的某个节点；找不到返回 undefined。 */
export function getNodeById(workflow: Pick<Workflow, "nodes">, nodeId: string): WorkflowNode | undefined {
  return workflow.nodes.find((node) => node.id === nodeId);
}

/** 按显示名找节点（表达式/导入映射用）。 */
export function getNodeByName(workflow: Pick<Workflow, "nodes">, name: string): WorkflowNode | undefined {
  return workflow.nodes.find((node) => node.name === name);
}

/** 节点是否有触发器语义（注册信息优先；未注册时按类型名兜底）。 */
export function isTriggerNode(node: Pick<WorkflowNode, "type">): boolean {
  const nodeType = getNodeType(node.type);
  if (nodeType) return nodeType.description.isTrigger === true;
  return /Trigger$/.test(node.type);
}

/** 找到工作流的触发节点：优先注册为触发器的，按画布位置从左到右。 */
export function findTriggerNode(workflow: Pick<Workflow, "nodes">): WorkflowNode | undefined {
  const triggers = workflow.nodes.filter((node) => !node.disabled && isTriggerNode(node));
  if (triggers.length === 0) return undefined;
  return [...triggers].sort((a, b) => a.position.x - b.position.x || a.position.y - b.position.y)[0];
}

/** 某个输入口的上游连接（同一输入口多根线时按上游节点画布位置排序，保证执行顺序确定）。 */
export function getInputConnections(
  workflow: Pick<Workflow, "nodes" | "connections">,
  nodeId: string,
  inputIndex = 0,
): Array<{ nodeId: string; outputIndex: number }> {
  const result: Array<{ nodeId: string; outputIndex: number }> = [];
  for (const [sourceId, ports] of Object.entries(workflow.connections)) {
    const outputs = ports?.main ?? [];
    for (let outputIndex = 0; outputIndex < outputs.length; outputIndex += 1) {
      const targets = outputs[outputIndex] ?? [];
      for (const target of targets) {
        if (target.node === nodeId && target.index === inputIndex) {
          result.push({ nodeId: sourceId, outputIndex });
        }
      }
    }
  }
  const positionOf = (id: string): number => {
    const node = getNodeById(workflow, id);
    if (!node) return Number.MAX_SAFE_INTEGER;
    return node.position.x * 10_000 + node.position.y;
  };
  return result.sort((a, b) => positionOf(a.nodeId) - positionOf(b.nodeId));
}

/** 某个输出口连到的目标节点。 */
export function getOutputConnections(
  workflow: Pick<Workflow, "connections">,
  nodeId: string,
  outputIndex = 0,
): WorkflowConnection[] {
  return workflow.connections[nodeId]?.main?.[outputIndex] ?? [];
}

/** 加一条连接；重复连接幂等。返回是否新增。 */
export function addConnection(
  workflow: Pick<Workflow, "nodes" | "connections">,
  sourceNodeId: string,
  outputIndex: number,
  targetNodeId: string,
  targetInputIndex = 0,
): boolean {
  if (sourceNodeId === targetNodeId) return false;
  const ports = (workflow.connections[sourceNodeId] ??= { main: [] });
  while (ports.main.length <= outputIndex) ports.main.push([]);
  const list = ports.main[outputIndex];
  const exists = list.some((item) => item.node === targetNodeId && item.index === targetInputIndex);
  if (exists) return false;
  list.push({ node: targetNodeId, type: "main", index: targetInputIndex });
  return true;
}

/** 删一条连接；返回是否删除。 */
export function removeConnection(
  workflow: Pick<Workflow, "connections">,
  sourceNodeId: string,
  outputIndex: number,
  targetNodeId: string,
  targetInputIndex = 0,
): boolean {
  const list = workflow.connections[sourceNodeId]?.main?.[outputIndex];
  if (!list) return false;
  const index = list.findIndex((item) => item.node === targetNodeId && item.index === targetInputIndex);
  if (index < 0) return false;
  list.splice(index, 1);
  return true;
}

/** 删节点，同时清掉所有与它相关的连接。 */
export function removeNode(workflow: Pick<Workflow, "nodes" | "connections">, nodeId: string): void {
  workflow.nodes = workflow.nodes.filter((node) => node.id !== nodeId);
  delete workflow.connections[nodeId];
  for (const ports of Object.values(workflow.connections)) {
    if (!ports?.main) continue;
    for (let i = 0; i < ports.main.length; i += 1) {
      ports.main[i] = (ports.main[i] ?? []).filter((target) => target.node !== nodeId);
    }
  }
}

/** 改名：保持工作流内唯一；返回最终名字。 */
export function renameNode(workflow: Pick<Workflow, "nodes">, nodeId: string, nextName: string): string {
  const node = getNodeById(workflow, nodeId);
  if (!node) return "";
  const base = clipName(nextName, NODE_NAME_MAX) || node.name;
  const others = { nodes: workflow.nodes.filter((item) => item.id !== nodeId) };
  const name = uniqueNodeName(others, base);
  node.name = name;
  return name;
}

/** 整体克隆（复制工作流 / 模板实例化用）：新 id、节点新 id、连接按 id 重映射。 */
export function cloneWorkflow(
  workflow: Workflow,
  opts: { name?: string; now?: number } = {},
): Workflow {
  const now = opts.now ?? Date.now();
  const idMap = new Map<string, string>();
  const nodes = workflow.nodes.map((node) => {
    const id = newId("wf-node", now);
    idMap.set(node.id, id);
    return { ...cloneValue(node), id, position: { ...node.position } };
  });
  const connections: WorkflowConnections = {};
  for (const [sourceId, ports] of Object.entries(workflow.connections)) {
    const nextSource = idMap.get(sourceId);
    if (!nextSource || !ports?.main) continue;
    connections[nextSource] = {
      main: ports.main.map((list) =>
        (list ?? [])
          .map((target) => {
            const nextTarget = idMap.get(target.node);
            return nextTarget ? { node: nextTarget, type: "main" as const, index: target.index } : null;
          })
          .filter((item): item is WorkflowConnection => Boolean(item)),
      ),
    };
  }
  return {
    ...workflow,
    id: newId("wf", now),
    name: clipName(opts.name ?? `${workflow.name} 副本`, WORKFLOW_NAME_MAX),
    nodes,
    connections,
    active: false,
    versionId: newId("ver", now),
    createdAt: now,
    updatedAt: now,
    lastRunAt: undefined,
  };
}

/** 已注册节点类型的输出口数量（动态节点用参数算；未注册时按 1）。 */
export function outputCountOf(node: Pick<WorkflowNode, "type" | "parameters">): number {
  const nodeType = getNodeType(node.type);
  if (!nodeType) return 1;
  if (nodeType.getOutputCount) return Math.max(0, nodeType.getOutputCount(node.parameters ?? {}));
  return Math.max(0, nodeType.description.outputs);
}

/** 已注册节点类型的输入口数量（未注册时按 1）。 */
export function inputCountOf(node: Pick<WorkflowNode, "type">): number {
  return getNodeType(node.type)?.description.inputs ?? 1;
}

// ---------------------------------------------------------------------------
// 校验与归一
// ---------------------------------------------------------------------------

export type WorkflowIssueLevel = "error" | "warning";

export interface WorkflowIssue {
  level: WorkflowIssueLevel;
  /** 一句话说明（面向用户，中文）。 */
  message: string;
  nodeId?: string;
}

/**
 * 结构校验（不判断业务参数是否填对，那在节点自己的 execute 里）。
 *
 * 回环（Loop Over Items 的循环用法）是**合法**的，只给 warning：
 * 引擎用执行栈 + 最大运行次数兜底，不需要在图上禁止环。
 */
export function validateWorkflow(workflow: Workflow): WorkflowIssue[] {
  const issues: WorkflowIssue[] = [];
  if (!workflow.name.trim()) issues.push({ level: "error", message: "工作流还没有名字。" });
  if (workflow.nodes.length === 0) issues.push({ level: "warning", message: "工作流里还没有节点。" });

  const ids = new Set<string>();
  const names = new Set<string>();
  for (const node of workflow.nodes) {
    if (ids.has(node.id)) issues.push({ level: "error", message: `节点 id 重复：${node.id}`, nodeId: node.id });
    ids.add(node.id);
    if (names.has(node.name)) {
      issues.push({ level: "error", message: `节点名重复：${node.name}`, nodeId: node.id });
    }
    names.add(node.name);
    const nodeType = getNodeType(node.type);
    if (!nodeType) {
      issues.push({ level: "error", message: `未知的节点类型：${node.type}`, nodeId: node.id });
      continue;
    }
    for (const property of nodeType.description.properties) {
      if (!property.required) continue;
      const value = node.parameters?.[property.name];
      if (value === undefined || value === null || value === "") {
        issues.push({
          level: "error",
          message: `「${node.name}」缺少必填参数：${property.displayName}`,
          nodeId: node.id,
        });
      }
    }
  }

  for (const [sourceId, ports] of Object.entries(workflow.connections)) {
    if (!ids.has(sourceId)) {
      issues.push({ level: "error", message: `连接引用了不存在的节点：${sourceId}` });
      continue;
    }
    const source = getNodeById(workflow, sourceId);
    const outputs = source ? outputCountOf(source) : 1;
    (ports?.main ?? []).forEach((list, outputIndex) => {
      if (outputIndex >= outputs) {
        issues.push({ level: "error", message: `「${source?.name ?? sourceId}」没有第 ${outputIndex + 1} 个输出` });
      }
      for (const target of list ?? []) {
        if (!ids.has(target.node)) {
          issues.push({ level: "error", message: `连接指向不存在的节点：${target.node}` });
          continue;
        }
        const targetNode = getNodeById(workflow, target.node);
        const inputs = targetNode ? inputCountOf(targetNode) : 1;
        if (target.index >= inputs) {
          issues.push({
            level: "error",
            message: `「${targetNode?.name ?? target.node}」没有第 ${target.index + 1} 个输入`,
            nodeId: target.node,
          });
        }
      }
    });
  }

  if (!findTriggerNode(workflow) && workflow.nodes.length > 0) {
    issues.push({ level: "warning", message: "没有触发器节点，手动运行时需要指定起点。" });
  }
  const triggerCount = workflow.nodes.filter((node) => isTriggerNode(node)).length;
  if (triggerCount > 1) {
    issues.push({ level: "warning", message: "有多个触发器节点，定时触发只使用最左侧的一个。" });
  }
  for (const node of workflow.nodes) {
    if (node.disabled) continue;
    const hasInput = node.type === "manualTrigger" || isTriggerNode(node) || getInputConnections(workflow, node.id).length > 0;
    if (!hasInput) {
      issues.push({ level: "warning", message: `「${node.name}」没有上游连接，运行时拿不到数据。`, nodeId: node.id });
    }
  }
  return issues;
}

/** 工作流是否可运行（没有 error 级问题）。 */
export function canRunWorkflow(workflow: Workflow): boolean {
  return validateWorkflow(workflow).every((issue) => issue.level !== "error");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toFinite(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * 把任意输入归一整条工作流（读盘/导入共用）。
 *
 * 原则：**能救的救，救不了的就丢，绝不抛**——一条坏工作流不该让整个列表读不出来。
 * 返回 null 只表示「连最小形状都不成立」（例如不是对象、没有 id）。
 */
export function normalizeWorkflow(raw: unknown, now: number = Date.now()): Workflow | null {
  if (!isPlainObject(raw)) return null;
  const id = typeof raw.id === "string" && raw.id ? clipName(raw.id, 80) : newId("wf", now);
  const name = clipName(
    typeof raw.name === "string" && raw.name.trim() ? raw.name : "未命名工作流",
    WORKFLOW_NAME_MAX,
  );

  const seenIds = new Set<string>();
  const nodes: WorkflowNode[] = [];
  const rawNodes = Array.isArray(raw.nodes) ? raw.nodes : [];
  for (const item of rawNodes.slice(0, MAX_NODES)) {
    const node = normalizeNode(item, seenIds);
    if (node) {
      seenIds.add(node.id);
      nodes.push(node);
    }
  }

  const connections = normalizeConnections(raw.connections, nodes);
  const settingsRaw = isPlainObject(raw.settings) ? raw.settings : {};
  const settings: WorkflowSettings = {
    timezone: "local",
    saveDataSuccessExecution:
      settingsRaw.saveDataSuccessExecution === "none" ? "none" : "all",
    saveDataErrorExecution: settingsRaw.saveDataErrorExecution === "none" ? "none" : "all",
    saveManualExecutions: settingsRaw.saveManualExecutions !== false,
    callerPolicy: settingsRaw.callerPolicy === "none" ? "none" : "any",
  };
  if (typeof settingsRaw.errorWorkflowId === "string" && settingsRaw.errorWorkflowId) {
    settings.errorWorkflowId = clipName(settingsRaw.errorWorkflowId, 80);
  }

  const tags = Array.isArray(raw.tags)
    ? [...new Set(raw.tags.filter((tag): tag is string => typeof tag === "string" && tag.trim() !== ""))]
        .slice(0, MAX_TAGS)
        .map((tag) => clipName(tag, TAG_MAX))
    : [];

  const createdAt = toFinite(raw.createdAt, now);
  const updatedAt = toFinite(raw.updatedAt, createdAt);

  return {
    id,
    name,
    ...(typeof raw.description === "string" && raw.description.trim()
      ? { description: clipName(raw.description, 500) }
      : {}),
    tags,
    nodes,
    connections,
    settings,
    active: raw.active === true,
    versionId: typeof raw.versionId === "string" && raw.versionId ? clipName(raw.versionId, 80) : newId("ver", now),
    createdAt,
    updatedAt,
    ...(typeof raw.lastRunAt === "number" && Number.isFinite(raw.lastRunAt)
      ? { lastRunAt: raw.lastRunAt }
      : {}),
  };
}

function normalizeNode(raw: unknown, seenIds: ReadonlySet<string>): WorkflowNode | null {
  if (!isPlainObject(raw)) return null;
  if (typeof raw.type !== "string" || !raw.type.trim()) return null;
  const id =
    typeof raw.id === "string" && raw.id && !seenIds.has(raw.id)
      ? clipName(raw.id, 80)
      : newId("wf-node");
  const positionRaw = isPlainObject(raw.position) ? raw.position : {};
  const parameters = isPlainObject(raw.parameters) ? raw.parameters : {};
  const name =
    typeof raw.name === "string" && raw.name.trim() ? clipName(raw.name, NODE_NAME_MAX) : clipName(raw.type, NODE_NAME_MAX);
  const node: WorkflowNode = {
    id,
    name,
    type: raw.type,
    position: { x: toFinite(positionRaw.x, 160), y: toFinite(positionRaw.y, 160) },
    parameters,
  };
  if (raw.disabled === true) node.disabled = true;
  if (typeof raw.notes === "string" && raw.notes.trim()) node.notes = clipName(raw.notes, 500);
  if (raw.retryOnFail === true) node.retryOnFail = true;
  if (typeof raw.maxTries === "number" && Number.isFinite(raw.maxTries)) {
    node.maxTries = Math.min(WORKFLOW_LIMITS.maxTries, Math.max(2, Math.trunc(raw.maxTries)));
  }
  if (typeof raw.waitBetweenTries === "number" && Number.isFinite(raw.waitBetweenTries)) {
    node.waitBetweenTries = Math.min(
      WORKFLOW_LIMITS.maxWaitBetweenTries,
      Math.max(0, Math.trunc(raw.waitBetweenTries)),
    );
  }
  if (raw.onError === "continueRegularOutput" || raw.onError === "continueErrorOutput") {
    node.onError = raw.onError;
  }
  if (raw.alwaysOutputData === true) node.alwaysOutputData = true;
  if (raw.executeOnce === true) node.executeOnce = true;
  if (isPlainObject(raw.credentials)) {
    const credentials: Record<string, string> = {};
    for (const [type, value] of Object.entries(raw.credentials)) {
      if (typeof value === "string" && value) credentials[type] = value;
    }
    if (Object.keys(credentials).length > 0) node.credentials = credentials;
  }
  if (Array.isArray(raw.pinData)) {
    const pinned: Item[] = [];
    for (const item of raw.pinData) {
      if (isPlainObject(item) && isPlainObject(item.json)) pinned.push({ json: item.json });
      else if (isPlainObject(item)) pinned.push({ json: item });
    }
    if (pinned.length > 0) node.pinData = pinned.slice(0, WORKFLOW_LIMITS.maxItemsPerNodeRun);
  }
  return node;
}

function normalizeConnections(raw: unknown, nodes: readonly WorkflowNode[]): WorkflowConnections {
  if (!isPlainObject(raw)) {
    // n8n 导出里 connections 也可能是空对象；不是对象就当没有连接
    return {};
  }
  const known = new Set(nodes.map((node) => node.id));
  const connections: WorkflowConnections = {};
  for (const [sourceId, ports] of Object.entries(raw)) {
    if (!known.has(sourceId) || !isPlainObject(ports)) continue;
    const mainRaw = Array.isArray(ports.main) ? ports.main : [];
    const main = mainRaw.map((list) => {
      if (!Array.isArray(list)) return [] as WorkflowConnection[];
      return list
        .filter((target): target is Record<string, unknown> => isPlainObject(target))
        .map((target) => {
          const nodeId = typeof target.node === "string" ? target.node : "";
          if (!nodeId || !known.has(nodeId)) return null;
          const index = typeof target.index === "number" && Number.isInteger(target.index) && target.index >= 0
            ? target.index
            : 0;
          return { node: nodeId, type: "main" as const, index };
        })
        .filter((item): item is WorkflowConnection => Boolean(item));
    });
    connections[sourceId] = { main };
  }
  return connections;
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/** 上次保存以来的变化摘要（列表页展示「N 个节点 · M 条连接」）。 */
export function workflowSummary(workflow: Workflow): { nodes: number; links: number; triggers: number } {
  let links = 0;
  for (const ports of Object.values(workflow.connections)) {
    for (const list of ports?.main ?? []) links += (list ?? []).length;
  }
  return {
    nodes: workflow.nodes.length,
    links,
    triggers: workflow.nodes.filter((node) => isTriggerNode(node)).length,
  };
}

/** 节点级重试参数（把类型层的纯函数在这里再导出，UI 与引擎共用同一口径）。 */
export { retryParams };

/** 节点的参数描述（UI 表单用）；未知节点返回空数组。 */
export function nodeProperties(node: Pick<WorkflowNode, "type">): NodePropertyDescription[] {
  return getNodeType(node.type)?.description.properties ?? [];
}
