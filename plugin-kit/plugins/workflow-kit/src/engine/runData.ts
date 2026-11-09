/**
 * 执行记录（`WorkflowExecution` / `NodeRunData`）的构建与裁剪。
 *
 * 为什么把「记录」和「执行」分开：
 * - 引擎只负责在内存里产生记录，**不做持久化**（CONTRACT §5.12）；
 *   localStorage 上限、条数淘汰是 `executions.ts` 的事；
 * - `saveData*` 与 `maxItemsPerNodeRun` 的裁剪规则是纯函数，单独放这里可以
 *   不启动引擎就单测「哪些数据不该被存下来」。
 *
 * 裁剪只影响**记录里保存的数据**，不影响节点之间流动的真实 items——
 * 用户把 saveData 关掉是为了省磁盘，不是为了改变执行结果。
 */

import {
  WORKFLOW_LIMITS,
  toOutputData,
  type BinaryData,
  type ExecutionMode,
  type ExecutionStatus,
  type Item,
  type NodeErrorInfo,
  type NodeExecuteResult,
  type NodeOutputData,
  type NodeRunData,
  type Workflow,
  type WorkflowExecution,
  type WorkflowSettings,
} from "../types.js";

/** 单条 item 被截断时写进 json 的标记（UI/导出可识别，不是真实业务字段）。 */
export const TRUNCATED_MARKER = "__hemingTruncated";

/** 一次执行的 id；便于在日志/执行列表里一眼区分（不用于安全用途）。 */
export function createExecutionId(now: number): string {
  return `exec-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 把节点返回的四种形状统一成 `NodeOutputData`。
 *
 * 为什么在 `toOutputData` 之外再加一层：契约允许节点直接返回 `Item[][]`
 * （见 CONTRACT §5.3），而 `toOutputData` 把所有数组都当成 `Item[]`。
 * 这里按「第一个元素是不是数组」区分两种形状，避免把二维数组塞进一个输出口。
 */
export function normalizeNodeResult(result: NodeExecuteResult): NodeOutputData {
  if (Array.isArray(result) && result.length > 0 && Array.isArray(result[0])) {
    return { main: result as Item[][] };
  }
  return toOutputData(result);
}

/** 把输出里不是数组的输出口补成空数组（防节点返回稀疏/畸形二维数组）。 */
export function sanitizeOutputData(output: NodeOutputData): NodeOutputData {
  return {
    main: (Array.isArray(output.main) ? output.main : []).map((port) =>
      Array.isArray(port) ? port : [],
    ),
  };
}

/** 输出条数（所有输出口之和），执行列表与节点运行态展示用。 */
export function countItems(output: NodeOutputData | undefined): number {
  if (!output) return 0;
  let total = 0;
  for (const port of output.main ?? []) {
    if (Array.isArray(port)) total += port.length;
  }
  return total;
}

/**
 * 单条二进制超过执行上限时丢掉内容、留下说明，而不是让整条记录写不进磁盘。
 *
 * 为什么保留 `binary` 这个键（内容置空 + 文件名后缀）：下游/UI 仍能知道
 * 「这次运行产生过二进制」，只是内容没保存；直接删键会让数据形状在不同执行间不一致。
 */
function trimBinary(item: Item): Item {
  if (!item.binary) return item;
  const binary: Record<string, BinaryData> = {};
  let changed = false;
  for (const [key, value] of Object.entries(item.binary)) {
    if (value && typeof value.data === "string" && value.data.length > WORKFLOW_LIMITS.maxBinaryBytes) {
      binary[key] = {
        ...value,
        data: "",
        fileName: `${value.fileName ?? "文件"}（内容超过单次执行上限，未保存）`,
      };
      changed = true;
    } else {
      binary[key] = value;
    }
  }
  return changed ? { ...item, binary } : item;
}

function utf8Length(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/** 按 UTF-8 字节截断字符串（不劈坏多字节字符）。 */
function clipUtf8(text: string, maxBytes: number): string {
  if (utf8Length(text) <= maxBytes) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (utf8Length(text.slice(0, mid)) <= maxBytes) low = mid;
    else high = mid - 1;
  }
  return `${text.slice(0, Math.max(0, low))}…`;
}

/**
 * 裁剪单条 item：二进制超限丢内容；json 序列化后超过 `maxItemPreviewBytes`
 * 时换成「截断说明 + 预览」，而不是把几十 MB 原样写进执行记录。
 *
 * 为什么必须有这一层：`maxItemsPerNodeRun` 只限条数，不限单条大小——一个 HTTP 节点
 * 返回 10MB JSON、或代码节点拼一个大字符串，执行记录就会把磁盘/UI 拖死。
 */
export function trimItemForRecord(
  item: Item,
  maxBytes: number = WORKFLOW_LIMITS.maxItemPreviewBytes,
): Item {
  const withBinary = trimBinary(item);
  let text: string;
  try {
    text = JSON.stringify(withBinary.json ?? {});
  } catch {
    return { ...withBinary, json: { [TRUNCATED_MARKER]: true, reason: "数据无法序列化" } };
  }
  const bytes = utf8Length(text);
  if (bytes <= maxBytes) return withBinary;
  return {
    ...withBinary,
    json: {
      [TRUNCATED_MARKER]: true,
      originalBytes: bytes,
      preview: clipUtf8(text, Math.max(256, maxBytes - 200)),
    },
  };
}

/**
 * 裁剪要写进执行记录的输出数据：每口最多 `maxItemsPerNodeRun` 条，
 * 单条 json ≤ `maxItemPreviewBytes`，超大二进制丢内容。
 *
 * 注意只裁记录：引擎内部仍保留完整 items 继续往下游流。
 */
export function trimOutputDataForRecord(
  output: NodeOutputData | undefined,
  maxItems: number = WORKFLOW_LIMITS.maxItemsPerNodeRun,
): NodeOutputData | undefined {
  if (!output) return undefined;
  return {
    main: (output.main ?? []).map((port) =>
      (Array.isArray(port) ? port : [])
        .slice(0, Math.max(0, maxItems))
        .map((item) => trimItemForRecord(item)),
    ),
  };
}

export interface CreateExecutionInput {
  workflow: Pick<Workflow, "id" | "name">;
  mode: ExecutionMode;
  executionId: string;
  now: number;
  parentExecutionId?: string;
  triggerNodeId?: string;
  triggerData?: Item[];
}

/** 建立执行的初始记录（`runData` 先放同一个对象引用，边跑边填）。 */
export function createExecutionRecord(input: CreateExecutionInput): WorkflowExecution {
  const execution: WorkflowExecution = {
    id: input.executionId,
    workflowId: input.workflow.id,
    workflowName: input.workflow.name,
    mode: input.mode,
    status: "new",
    startedAt: input.now,
    runData: {},
  };
  if (input.parentExecutionId) execution.parentExecutionId = input.parentExecutionId;
  if (input.triggerNodeId) execution.triggerNodeId = input.triggerNodeId;
  if (input.triggerData) {
    const limited = input.triggerData.slice(0, WORKFLOW_LIMITS.maxItemsPerNodeRun);
    const trimmed = limited.map((item) => trimItemForRecord(item));
    execution.triggerData = trimmed;
    if (
      limited.length !== input.triggerData.length ||
      trimmed.some((item, index) => item !== limited[index])
    ) {
      execution.dataTruncated = true;
    }
  }
  return execution;
}

export interface BuildNodeRunInput {
  startTime: number;
  executionTime: number;
  executionIndex: number;
  /** 触发本次运行的直接上游节点（触发节点/部分执行起点为空）。 */
  sourceNodeId?: string;
  status: NodeRunData["status"];
  output?: NodeOutputData;
  error?: NodeErrorInfo;
  /** 截断前的真实条数（记录里 data 可能已被裁剪）。 */
  itemsTotal: number;
}

/** 构造单次节点运行记录。 */
export function buildNodeRunData(input: BuildNodeRunInput): NodeRunData {
  const run: NodeRunData = {
    startTime: input.startTime,
    executionTime: Math.max(0, input.executionTime),
    executionIndex: input.executionIndex,
    source: input.sourceNodeId ? [{ previousNode: input.sourceNodeId }] : [{}],
    status: input.status,
    itemsTotal: Math.max(0, input.itemsTotal),
  };
  const data = trimOutputDataForRecord(input.output);
  if (data) run.data = data;
  if (input.error) run.error = input.error;
  return run;
}

/** 追加一条节点运行记录（同一节点在循环里会多次运行，按顺序排列）。 */
export function appendRunData(
  execution: WorkflowExecution,
  nodeId: string,
  runData: NodeRunData,
): void {
  const list = (execution.runData[nodeId] ??= []);
  list.push(runData);
}

/**
 * 收尾：写终态、结束时间与耗时。
 *
 * 为什么不在这里应用 saveData：调用方要在事件发射前决定记录是否裁剪，
 * 而事件里的 execution 与最终返回的是同一个对象，先裁剪再发 `executionFinish`
 * 才能让 UI 看到的记录与落到磁盘的一致。
 */
export function finalizeExecution(
  execution: WorkflowExecution,
  status: Extract<ExecutionStatus, "success" | "error" | "canceled">,
  now: number,
  error?: NodeErrorInfo,
): void {
  execution.status = status;
  execution.finishedAt = now;
  execution.durationMs = Math.max(0, now - execution.startedAt);
  if (error) execution.error = error;
}

/**
 * 按工作流设置裁剪执行数据（`saveData*Execution`）。
 *
 * 口径：
 * - 成功执行看 `saveDataSuccessExecution`；
 * - 失败与取消看 `saveDataErrorExecution`（取消不是成功，按失败口径处理）；
 * - 关掉数据时**只删 `run.data`**，`runData` 条目与错误信息保留——
 *   历史列表仍要能看到「跑过哪些节点、哪个错了多久」。
 */
export function applySaveDataPolicy(
  execution: WorkflowExecution,
  settings: WorkflowSettings,
): void {
  const mode = execution.status;
  const keepData =
    mode === "success"
      ? settings.saveDataSuccessExecution !== "none"
      : mode === "error" || mode === "canceled"
        ? settings.saveDataErrorExecution !== "none"
        : true;
  if (keepData) return;
  for (const runs of Object.values(execution.runData)) {
    for (const run of runs) delete run.data;
  }
}
