/**
 * 执行记录仓库（本机）：每次执行结束留一条，最新在前。
 *
 * 为什么要在这里再裁剪一次数据（引擎也会按 `saveData*` 裁剪）：
 * - 引擎只管「这次执行怎么跑」，它不知道 localStorage 的 1MB 预算；
 * - 执行记录是**会长期堆积**的（60 条），而单次执行的 runData 可能有几千条 items；
 * - 单个 item 可能是几十 KB 的 JSON 或 base64 二进制——不裁剪的话，一条记录就能
 *   把整个键顶爆，结果是所有历史一起丢。裁剪是「保留可读的调试信息」而不是丢数据。
 *
 * 红线：只存本机；记录里的 items 可能含用户内容，与记忆/消息同口径，不上云。
 */

import { create } from "zustand";
import {
  createDefaultStorage,
  isPlainObject,
  readJson,
  utf8Length,
  writeJson,
} from "../memory/storage.js";
import type { StorageLike } from "../memory/types.js";
import {
  WORKFLOW_LIMITS,
  type Item,
  type NodeErrorInfo,
  type NodeRunData,
  type WorkflowExecution,
  type WorkflowSettings,
} from "./types.js";

/** 执行记录键（契约 §8）。 */
export const EXECUTIONS_KEY = "heming.workflows.executions.v1";

/** 截断标记：item 的 json 被换成了「预览 + 字节数」，UI 据此提示「已截断」。 */
export const TRUNCATED_MARK = "__hemingTruncated";
/** 二进制被丢弃标记：写在 item.json 上（json 本身保留）。 */
export const BINARY_DROPPED_MARK = "__hemingBinaryDropped";

/** 执行记录条数上限（契约 §8：60 条）。 */
export const MAX_EXECUTIONS = WORKFLOW_LIMITS.maxExecutions;
/** 执行记录总字节上限（契约 §8：1MB）。 */
export const EXECUTIONS_BYTE_LIMIT = WORKFLOW_LIMITS.maxExecutionsBytes;

let storage: StorageLike | null = null;

function getStorage(): StorageLike {
  return (storage ??= createDefaultStorage());
}

/** 测试注入点：传 null 恢复默认（jsdom 的 localStorage）。 */
export function setWorkflowExecutionStorage(next: StorageLike | null): void {
  storage = next;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** 单个 item 的 JSON 字节数（只算 json，binary 单独按二进制口径算）。 */
function itemJsonBytes(item: Item): number {
  try {
    return utf8Length(JSON.stringify(item.json));
  } catch {
    // 循环引用/不可序列化：按超限处理（写盘时本来也会失败）
    return WORKFLOW_LIMITS.maxItemPreviewBytes + 1;
  }
}

/** 二进制字节数（base64 的字符数 ≈ 原始字节 × 4/3；这里按 base64 长度保守估）。 */
function binaryBytes(item: Item): number {
  if (!item.binary) return 0;
  let total = 0;
  for (const entry of Object.values(item.binary)) {
    total += typeof entry?.data === "string" ? entry.data.length : 0;
  }
  return total;
}

/**
 * 裁剪单个 item：
 * - json 超过 64KB → 换成截断标记（保留前 2000 字符预览，便于看出是什么数据）；
 * - binary 总和超过整条执行的二进制上限 → 丢掉 binary 并打标记。
 *
 * 为什么预览要留一段原文：执行记录的主要用途是「看这个节点吐了什么」。
 * 只写「已截断 87KB」等于把线索也删了。
 */
function trimItem(item: Item, dropAllBinary: boolean): Item {
  const result: Item = { json: item.json };
  if (item.pairedItem !== undefined) result.pairedItem = item.pairedItem;

  const bytes = itemJsonBytes(item);
  if (bytes > WORKFLOW_LIMITS.maxItemPreviewBytes) {
    let preview = "";
    try {
      preview = JSON.stringify(item.json).slice(0, 2000);
    } catch {
      preview = "";
    }
    result.json = {
      [TRUNCATED_MARK]: true,
      bytes,
      limit: WORKFLOW_LIMITS.maxItemPreviewBytes,
      preview,
    };
  }

  const binary = item.binary;
  if (binary && Object.keys(binary).length > 0) {
    if (dropAllBinary) {
      result.json = { ...result.json, [BINARY_DROPPED_MARK]: true };
    } else {
      result.binary = binary;
    }
  }
  return result;
}

/** 裁剪一次节点运行的输出：所有输出口合计最多 200 条 items。 */
export function trimNodeRunData(
  data: { main: Item[][] } | undefined,
  dropAllBinary: boolean,
): { main: Item[][] } | undefined {
  if (!data || !Array.isArray(data.main)) return undefined;
  let remaining = WORKFLOW_LIMITS.maxItemsPerNodeRun;
  const main = data.main.map((list) => {
    if (!Array.isArray(list) || remaining <= 0) return [];
    const take = list.slice(0, remaining);
    remaining -= take.length;
    return take.map((item) => trimItem(item, dropAllBinary));
  });
  return { main };
}

/** 裁剪一组 items（触发数据用；规则与节点输出一致）。 */
export function trimItems(items: Item[] | undefined, dropAllBinary: boolean): Item[] | undefined {
  if (!Array.isArray(items)) return undefined;
  return items
    .slice(0, WORKFLOW_LIMITS.maxItemsPerNodeRun)
    .map((item) => trimItem(item, dropAllBinary));
}

function clipError(error: NodeErrorInfo | undefined): NodeErrorInfo | undefined {
  if (!error) return undefined;
  const next: NodeErrorInfo = { message: String(error.message ?? "").slice(0, 2000) };
  if (error.description) next.description = String(error.description).slice(0, 2000);
  if (error.nodeId) next.nodeId = error.nodeId;
  if (error.nodeName) next.nodeName = error.nodeName;
  if (error.nodeType) next.nodeType = error.nodeType;
  if (error.httpCode) next.httpCode = error.httpCode;
  if (error.stack) next.stack = String(error.stack).slice(0, 4000);
  if (typeof error.itemIndex === "number") next.itemIndex = error.itemIndex;
  return next;
}

function shouldKeepData(execution: WorkflowExecution, settings?: WorkflowSettings): boolean {
  if (!settings) return true;
  if (execution.status === "error") return settings.saveDataErrorExecution !== "none";
  if (execution.status === "success") return settings.saveDataSuccessExecution !== "none";
  return true;
}

/**
 * 把一次执行整成「可落盘」的形态：
 * - 按 `saveDataSuccessExecution` / `saveDataErrorExecution` 决定要不要留 runData.data；
 * - 节点输出与触发数据按条数/单条大小裁剪；
 * - 二进制整条执行超上限时统一丢弃（否则一次执行就能把历史键顶死）。
 */
export function prepareExecution(
  execution: WorkflowExecution,
  settings?: WorkflowSettings,
): WorkflowExecution {
  const keepData = shouldKeepData(execution, settings);
  // 先算整条执行的二进制总量：超过上限就整条都不留二进制（与 types.ts 的注释一致）。
  let totalBinary = 0;
  const scan = (items: Item[] | undefined): void => {
    if (!items) return;
    for (const item of items) totalBinary += binaryBytes(item);
  };
  for (const runs of Object.values(execution.runData ?? {})) {
    for (const run of runs ?? []) {
      for (const list of run.data?.main ?? []) scan(list);
    }
  }
  scan(execution.triggerData);
  const dropAllBinary = totalBinary > WORKFLOW_LIMITS.maxBinaryBytes;

  const runData: Record<string, NodeRunData[]> = {};
  for (const [nodeId, runs] of Object.entries(execution.runData ?? {})) {
    if (!Array.isArray(runs)) continue;
    runData[nodeId] = runs.map((run) => {
      const next: NodeRunData = {
        startTime: isFiniteNumber(run.startTime) ? run.startTime : execution.startedAt,
        executionTime: isFiniteNumber(run.executionTime) ? Math.max(0, run.executionTime) : 0,
        executionIndex: isFiniteNumber(run.executionIndex) ? Math.max(0, run.executionIndex) : 0,
        source: Array.isArray(run.source)
          ? run.source
              .filter((entry): entry is { previousNode?: string } => isPlainObject(entry))
              .map((entry) => ({ ...(typeof entry.previousNode === "string" ? { previousNode: entry.previousNode } : {}) }))
          : [],
        status: run.status === "error" || run.status === "waiting" ? run.status : "success",
        itemsTotal: isFiniteNumber(run.itemsTotal) ? Math.max(0, run.itemsTotal) : 0,
      };
      if (keepData && run.data) {
        const trimmed = trimNodeRunData(run.data, dropAllBinary);
        if (trimmed) next.data = trimmed;
      }
      const error = clipError(run.error);
      if (error) next.error = error;
      return next;
    });
  }

  const next: WorkflowExecution = {
    id: execution.id,
    workflowId: execution.workflowId,
    workflowName: execution.workflowName,
    mode: execution.mode,
    status: execution.status,
    startedAt: execution.startedAt,
    runData,
  };
  if (isFiniteNumber(execution.finishedAt)) next.finishedAt = execution.finishedAt;
  if (isFiniteNumber(execution.durationMs)) next.durationMs = Math.max(0, execution.durationMs);
  if (execution.triggerNodeId) next.triggerNodeId = execution.triggerNodeId;
  const triggerData = trimItems(execution.triggerData, dropAllBinary);
  if (triggerData) next.triggerData = triggerData;
  const error = clipError(execution.error);
  if (error) next.error = error;
  if (execution.parentExecutionId) next.parentExecutionId = execution.parentExecutionId;
  return next;
}

/**
 * 读执行记录的归一校验。
 *
 * 坏条目逐条丢弃（与工作流列表同策略）：缺 id/workflowName 的记录在界面上
 * 无法辨认也无法重跑，留着只会占额度。
 */
export function normalizeExecution(raw: unknown): WorkflowExecution | null {
  if (!isPlainObject(raw)) return null;
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  const workflowId = typeof raw.workflowId === "string" ? raw.workflowId.trim() : "";
  if (!id || !workflowId) return null;
  if (!isFiniteNumber(raw.startedAt) || raw.startedAt <= 0) return null;
  const mode = raw.mode;
  if (
    mode !== "manual" &&
    mode !== "trigger" &&
    mode !== "retry" &&
    mode !== "subworkflow" &&
    mode !== "error" &&
    mode !== "partial"
  ) {
    return null;
  }
  const status = raw.status;
  if (
    status !== "new" &&
    status !== "running" &&
    status !== "success" &&
    status !== "error" &&
    status !== "canceled" &&
    status !== "waiting"
  ) {
    return null;
  }
  const execution: WorkflowExecution = {
    id,
    workflowId,
    workflowName:
      typeof raw.workflowName === "string" && raw.workflowName.trim()
        ? raw.workflowName.trim()
        : "未命名工作流",
    mode,
    status,
    startedAt: raw.startedAt,
    runData: isPlainObject(raw.runData) ? (raw.runData as Record<string, NodeRunData[]>) : {},
  };
  if (isFiniteNumber(raw.finishedAt) && raw.finishedAt >= 0) execution.finishedAt = raw.finishedAt;
  if (isFiniteNumber(raw.durationMs) && raw.durationMs >= 0) execution.durationMs = raw.durationMs;
  if (typeof raw.triggerNodeId === "string" && raw.triggerNodeId) {
    execution.triggerNodeId = raw.triggerNodeId;
  }
  if (Array.isArray(raw.triggerData)) {
    execution.triggerData = raw.triggerData.filter(
      (item): item is Item => isPlainObject(item) && isPlainObject(item.json),
    );
  }
  if (isPlainObject(raw.error)) execution.error = raw.error as unknown as NodeErrorInfo;
  if (typeof raw.parentExecutionId === "string" && raw.parentExecutionId) {
    execution.parentExecutionId = raw.parentExecutionId;
  }
  // 读盘时再裁一次：旧版本可能写进过没裁剪的数据，读出来也要能撑住预算。
  return prepareExecution(execution);
}

/**
 * 条数 + 字节双淘汰（最新在前）。
 *
 * 先按开始时间倒序取前 60 条，再逐条弹出直到装得下 1MB；单条都装不下就清空
 * （写一个超限数组进去只会让整个键失效，连其它正常记录一起丢）。
 */
export function pruneExecutions(
  items: WorkflowExecution[],
  limit = EXECUTIONS_BYTE_LIMIT,
): WorkflowExecution[] {
  const next = [...items]
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, MAX_EXECUTIONS);
  let bytes = utf8Length(JSON.stringify(next));
  while (bytes > limit && next.length > 1) {
    next.pop();
    bytes = utf8Length(JSON.stringify(next));
  }
  return bytes > limit ? [] : next;
}

/** 读执行记录：缺键/损坏回退空，坏条目逐条丢弃，再按条数/字节淘汰。 */
export function readExecutions(
  storageLike: StorageLike = createDefaultStorage(),
): WorkflowExecution[] {
  return readJson(storageLike, EXECUTIONS_KEY, [] as WorkflowExecution[], (raw) => {
    if (!Array.isArray(raw)) return [];
    return pruneExecutions(
      raw
        .map(normalizeExecution)
        .filter((execution): execution is WorkflowExecution => execution !== null),
    );
  });
}

/**
 * 落盘并返回最终保留的列表。写不进去时仍返回内存态：
 * 本次会话里用户看得见刚跑完的记录，只是重启后没有（与自动化运行记录同口径）。
 */
function persist(executions: WorkflowExecution[]): WorkflowExecution[] {
  const pruned = pruneExecutions(executions);
  writeJson(getStorage(), EXECUTIONS_KEY, pruned, EXECUTIONS_BYTE_LIMIT);
  return pruned;
}

interface WorkflowExecutionsState {
  /** 执行记录，最新在前。 */
  executions: WorkflowExecution[];
  /**
   * 记一条执行记录。
   *
   * 返回实际落盘的那一条（已裁剪）；`null` 表示按工作流设置**不该记录**
   * （手动执行但关闭了「保存手动执行」）。传 `settings` 是为了让
   * saveDataSuccessExecution 之类的开关在记录入口就生效，而不是等读盘时。
   */
  add: (execution: WorkflowExecution, settings?: WorkflowSettings) => WorkflowExecution | null;
  list: () => WorkflowExecution[];
  byWorkflow: (workflowId: string) => WorkflowExecution[];
  remove: (id: string) => void;
  /** 工作流被删除时级联清掉它的历史（页面文案承诺过）。 */
  removeForWorkflow: (workflowId: string) => void;
  /** 清空全部（破坏性操作，UI 侧应先确认）。 */
  clear: () => void;
}

export const useWorkflowExecutionsStore = create<WorkflowExecutionsState>((set, get) => ({
  executions: readExecutions(),

  add: (execution, settings) => {
    if (execution.mode === "manual" && settings?.saveManualExecutions === false) {
      return null;
    }
    const prepared = prepareExecution(execution, settings);
    const executions = persist([
      prepared,
      ...get().executions.filter((item) => item.id !== prepared.id),
    ]);
    set({ executions });
    return prepared;
  },

  list: () => get().executions,

  byWorkflow: (workflowId) =>
    get().executions.filter((execution) => execution.workflowId === workflowId),

  remove: (id) => {
    const current = get().executions;
    const next = current.filter((execution) => execution.id !== id);
    if (next.length === current.length) return;
    set({ executions: persist(next) });
  },

  removeForWorkflow: (workflowId) => {
    const current = get().executions;
    const next = current.filter((execution) => execution.workflowId !== workflowId);
    if (next.length === current.length) return;
    set({ executions: persist(next) });
  },

  clear: () => set({ executions: persist([]) }),
}));
