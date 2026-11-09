/**
 * 执行引擎的对外入口。
 *
 * 依赖方只看这一层：
 * - UI / 调度器（wf-shell）：`executeWorkflow`、`nextScheduleRun`、`EngineEvent`、`EngineDeps`；
 * - 节点库（wf-nodes-core/app）：只需要 `NodeExecutionContext.helpers`（由引擎在运行时填入），
 *   不需要 import 本文件；错误工作流/执行记录由引擎内部处理。
 */

export { executeWorkflow } from "./execute.js";
export type {
  EngineDeps,
  EngineEvent,
  EngineNodeRunStatus,
  ExecuteOptions,
  ExecutionFinishEvent,
  ExecutionStartEvent,
  NodeFinishEvent,
  NodeStartEvent,
  StaticDataProvider,
} from "./execute.js";

export { listScheduleTriggers, nextScheduleRun } from "./schedule.js";

export {
  ExecutionAbortedError,
  errorDescriptionOf,
  errorMessage,
  isAbortError,
  toNodeErrorInfo,
} from "./errors.js";

export {
  applySaveDataPolicy,
  buildNodeRunData,
  countItems,
  createExecutionId,
  createExecutionRecord,
  normalizeNodeResult,
  trimOutputDataForRecord,
} from "./runData.js";
export type { BuildNodeRunInput, CreateExecutionInput } from "./runData.js";
