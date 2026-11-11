/**
 * 工作流执行引擎。
 *
 * 为什么用「执行栈 + 主循环」而不是递归调用节点：
 * - 工作流是**图**，允许回环（Loop Over Items 的循环用法）与多输入合并，递归会在回环上爆栈；
 * - 每一步都要写执行记录、发进度事件、检查预算（运行次数/时长/取消），
 *   这些横切逻辑放在一个主循环里只有一处，节点实现不需要知道；
 * - 执行顺序只由「连接 + 画布位置」决定，同一工作流同一输入必然得到同一顺序（CONTRACT §5.13），
 *   便于测试与「运行结果可复现」。
 *
 * 语义按 CONTRACT.md §5 实现（n8n 的公开行为语义，独立实现，未复制其源码）：
 * 输入合并、items 流、节点级重试、onError 三态、executeOnce、pinData、部分执行、
 * Wait（helpers.sleep）、子流程注入、错误工作流、进度事件、saveData* 裁剪、预算兜底。
 *
 * 这里**不做持久化**：返回完整 `WorkflowExecution` 即可，落盘是 executions.ts 的事。
 */

import {
  findTriggerNode,
  getInputConnections,
  getNodeById,
  getOutputConnections,
  inputCountOf,
  outputCountOf,
} from "../model";
import { getNodeType } from "../registry";
import { buildExpressionContext, resolveParameters } from "../expressions/index";
import {
  WORKFLOW_LIMITS,
  retryParams,
  type CredentialResolver,
  type ExecutionMode,
  type ExpressionContext,
  type Item,
  type NodeErrorInfo,
  type NodeExecutionContext,
  type NodeHelpers,
  type NodeInputData,
  type NodeLogger,
  type NodeOutputData,
  type NodeRunData,
  type SubWorkflowParams,
  type SubWorkflowResult,
  type UserCodeRunner,
  type Workflow,
  type WorkflowExecution,
  type WorkflowNode,
} from "../types";
import {
  ExecutionAbortedError,
  errorDescriptionOf,
  errorMessage,
  isAbortError,
  passThroughInput,
  routeErrorItemsToLastOutput,
  toNodeErrorInfo,
} from "./errors";
import {
  applySaveDataPolicy,
  buildNodeRunData,
  countItems,
  createExecutionId,
  createExecutionRecord,
  finalizeExecution,
  normalizeNodeResult,
  sanitizeOutputData,
} from "./runData";

// ---------------------------------------------------------------------------
// 对外类型（index.ts 原样再导出）
// ---------------------------------------------------------------------------

/**
 * 工作流静态数据的读写接口（`context.getWorkflowStaticData`）。
 *
 * 为什么做成可注入：引擎自己**不落盘**（CONTRACT §5.12），单次执行内用内存实现即可；
 * runtime.ts 想让它跨运行保留，就注入一个基于 localStorage 的实现。
 * 缺省实现只保证「同一次执行内、多次运行之间」共享同一对象（回环/去重节点需要这个）。
 */
export interface StaticDataProvider {
  getWorkflowStaticData(workflowId: string): Record<string, unknown>;
  getNodeStaticData(workflowId: string, nodeId: string): Record<string, unknown>;
}

/** 引擎可注入的依赖；全部可选，缺省值保证引擎能独立跑测试。 */
export interface EngineDeps {
  /** HTTP 能力（节点通过 `context.helpers.httpRequest` 使用）。 */
  httpRequest?: NodeHelpers["httpRequest"];
  /** 等待能力（Wait 节点与重试共用；`signal` 中止时抛错）。 */
  sleep?: NodeHelpers["sleep"];
  /** 代码沙箱运行器；引擎原样放进 `context.helpers.runUserCode`。 */
  runUserCode?: UserCodeRunner;
  /** 子流程执行器；引擎原样放进 `context.helpers.executeSubWorkflow`，错误工作流也走它。 */
  executeSubWorkflow?: (params: SubWorkflowParams) => Promise<SubWorkflowResult>;
  /** 凭据解析器（节点用 `context.getCredential(type)` 取）。 */
  getCredential?: CredentialResolver;
  logger?: NodeLogger;
  /** 当前时间（测试注入假时钟；确定性执行依赖它）。 */
  now?: () => number;
  /** 跨运行静态数据（缺省为单次执行内存实现）。 */
  staticData?: StaticDataProvider;
}

/** 一次执行的调用参数。 */
export interface ExecuteOptions {
  workflow: Workflow;
  /** 执行模式；缺省手动执行，部分执行自动为 `partial`。 */
  mode?: ExecutionMode;
  /** 部分执行：从这个节点开始（不再执行它上游）。 */
  startNodeId?: string;
  /** 部分执行：这个节点完成后停止（不再调度它下游）。 */
  destinationNodeId?: string;
  /** 部分执行起点节点要用的输入（调用方给）；缺省为空。 */
  inputData?: NodeInputData;
  /** 触发器收到的数据（手动/子流程调用）；作为触发器节点的输入。 */
  triggerData?: Item[];
  executionId?: string;
  parentExecutionId?: string;
  abortSignal?: AbortSignal;
  /** 进度事件（UI 画运行态用）；回调抛错不会影响执行。 */
  onEvent?: (event: EngineEvent) => void;
  deps?: EngineDeps;
  /** 全局变量（表达式 `$vars` 用）。 */
  vars?: Record<string, unknown>;
}

/** 节点运行态（UI 只关心这四种）。 */
export type EngineNodeRunStatus = "success" | "error" | "waiting";

export interface ExecutionStartEvent {
  type: "executionStart";
  execution: WorkflowExecution;
}

export interface NodeStartEvent {
  type: "nodeStart";
  executionId: string;
  nodeId: string;
  nodeName: string;
  nodeType: string;
  /** 同一节点在本次执行里的第几次运行（0 起）。 */
  runIndex: number;
  /** 本次执行里第几次节点运行（全局递增，0 起）。 */
  executionIndex: number;
  mode: ExecutionMode;
}

export interface NodeFinishEvent {
  type: "nodeFinish";
  executionId: string;
  nodeId: string;
  nodeName: string;
  nodeType: string;
  runIndex: number;
  executionIndex: number;
  status: EngineNodeRunStatus;
  /** 该次运行产出的 items 总数（所有输出口之和，截断前）。 */
  itemsTotal: number;
  error?: NodeErrorInfo;
}

export interface ExecutionFinishEvent {
  type: "executionFinish";
  execution: WorkflowExecution;
}

/** 引擎进度事件（CONTRACT §5.11）。 */
export type EngineEvent =
  | ExecutionStartEvent
  | NodeStartEvent
  | NodeFinishEvent
  | ExecutionFinishEvent;

/** 执行栈里的一项：待运行节点 + 它的输入来源。 */
interface StackEntry {
  nodeId: string;
  /** 触发本次入栈的上游节点 id（起点为空）。 */
  sourceNodeId?: string;
  /** 起点/部分执行时调用方直接给的输入；没有时从上游已完成的输出汇总。 */
  explicitInput?: NodeInputData;
}

/** 单次节点运行的结局；`continued` 表示失败但按 onError 继续。 */
type NodeOutcome =
  | { kind: "success"; output: NodeOutputData }
  | { kind: "continued"; output: NodeOutputData; error: NodeErrorInfo }
  | { kind: "failed"; error: NodeErrorInfo }
  | { kind: "canceled" }
  | { kind: "skipped" };

type StartResolution =
  | { node: WorkflowNode; explicitInput: NodeInputData }
  | { error: NodeErrorInfo };

const SILENT_LOGGER: NodeLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

function canceledErrorInfo(): NodeErrorInfo {
  return {
    message: "执行已取消",
    description: "执行被中止；已产生的节点运行记录保留，不会继续调度下游。",
  };
}

function withDescription(errorInfo: NodeErrorInfo): NodeErrorInfo {
  if (errorInfo.description) return errorInfo;
  const description = errorDescriptionOf(errorInfo);
  return description ? { ...errorInfo, description } : errorInfo;
}

/** 缺省 HTTP 能力：没注入就直接报可读的错，而不是让节点去碰浏览器 fetch。 */
function missingHttpRequest(): Promise<never> {
  return Promise.reject(new Error("当前环境没有注入 HTTP 能力（helpers.httpRequest），无法发送请求。"));
}

/**
 * 缺省等待实现：内存 setTimeout，可被 AbortSignal 中断（CONTRACT §5.8：
 * Wait 节点 v1 不跨重启，进程/页面刷新后这次等待就没了）。
 */
function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (!(ms > 0)) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ExecutionAbortedError());
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    function cleanup(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
    function onAbort(): void {
      cleanup();
      reject(new ExecutionAbortedError());
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function positionKey(node: Pick<WorkflowNode, "position">): number {
  return node.position.x * 10_000 + node.position.y;
}

/** 收集上游输出时把多个输入口的数组拼起来（只用于输入口 index 0 的表达式上下文）。 */
function firstPortItems(input: NodeInputData): Item[] {
  return input.main[0] ?? [];
}

// ---------------------------------------------------------------------------
// 引擎主体
// ---------------------------------------------------------------------------

class WorkflowEngine {
  private readonly options: ExecuteOptions;
  private readonly workflow: Workflow;
  private readonly deps: EngineDeps;
  private readonly nowFn: () => number;
  private readonly logger: NodeLogger;
  private readonly vars: Record<string, unknown>;
  private readonly controller = new AbortController();
  private readonly staticProvider: StaticDataProvider;
  private readonly runtimeStatic = new Map<string, Record<string, unknown>>();

  private readonly start: StartResolution;
  private readonly execution: WorkflowExecution;

  /** 待执行队列：`shift()` 取队首（FIFO），入栈顺序由画布位置决定，保证确定性。 */
  private readonly stack: StackEntry[] = [];
  /** 每个节点最近一次运行的输出（不只用于记录，也是输入合并/表达式 `$node` 的数据源）。 */
  private readonly lastOutputs: Record<string, Item[][]> = {};
  /** 已经运行过的节点（多输入节点的就绪判断用）。 */
  private readonly completed = new Set<string>();
  /** 多输入节点：输入口还没全部就绪时先挂起，等后续上游完成再调度。 */
  private readonly pending = new Map<string, string>();

  /** 本次执行里已弹出的节点数（maxNodeRuns 预算）。 */
  private nodeRuns = 0;
  /** 本次执行里第几次节点运行（NodeRunData.executionIndex）。 */
  private executionCounter = 0;
  private finalStatus: "success" | "error" | "canceled" | undefined;
  private finalError: NodeErrorInfo | undefined;
  private detachAbort: () => void = () => {};

  constructor(options: ExecuteOptions) {
    this.options = options;
    this.workflow = options.workflow;
    this.deps = options.deps ?? {};
    this.nowFn = this.deps.now ?? (() => Date.now());
    this.logger = this.deps.logger ?? SILENT_LOGGER;
    this.vars = options.vars ?? {};

    if (this.deps.staticData) {
      this.staticProvider = this.deps.staticData;
    } else {
      const statics = this.runtimeStatic;
      this.staticProvider = {
        getWorkflowStaticData: (workflowId) => {
          let data = statics.get(workflowId);
          if (!data) {
            data = {};
            statics.set(workflowId, data);
          }
          return data;
        },
        getNodeStaticData: (workflowId, nodeId) => {
          const key = `${workflowId}:${nodeId}`;
          let data = statics.get(key);
          if (!data) {
            data = {};
            statics.set(key, data);
          }
          return data;
        },
      };
    }

    this.start = this.resolveStart();
    const startNode = "node" in this.start ? this.start.node : undefined;
    const mode: ExecutionMode =
      this.options.mode ??
      (this.options.startNodeId || this.options.destinationNodeId ? "partial" : "manual");
    this.execution = createExecutionRecord({
      workflow: this.workflow,
      mode,
      now: this.nowFn(),
      executionId: this.options.executionId ?? createExecutionId(this.nowFn()),
      parentExecutionId: this.options.parentExecutionId,
      triggerNodeId: this.options.startNodeId ?? startNode?.id,
      triggerData: this.options.triggerData,
    });
  }

  // -- 对外主流程 ----------------------------------------------------------

  async run(): Promise<WorkflowExecution> {
    this.attachAbort();
    this.execution.status = "running";
    this.emit({ type: "executionStart", execution: this.execution });

    try {
      if ("error" in this.start) {
        this.fail(this.start.error);
      } else if (this.signal.aborted) {
        this.cancel();
      } else {
        this.stack.push({
          nodeId: this.start.node.id,
          explicitInput: this.start.explicitInput,
        });
        await this.runLoop();
        if (!this.finalStatus && this.pending.size > 0) {
          // 多输入节点的某个输入口始终没有上游产出（例如分支没走到）：
          // 不强行拿空数据跑（那会改变语义），只记一笔日志，执行按成功收尾。
          this.logger.info("部分节点因输入口未全部就绪未执行", {
            nodeIds: [...this.pending.keys()],
          });
        }
      }
    } catch (error) {
      if (!this.finalStatus) {
        if (this.signal.aborted || isAbortError(error)) this.cancel();
        else this.fail(toNodeErrorInfo(error));
      }
    } finally {
      this.detachAbort();
      finalizeExecution(this.execution, this.finalStatus ?? "success", this.nowFn(), this.finalError);
      applySaveDataPolicy(this.execution, this.workflow.settings);
      this.emit({ type: "executionFinish", execution: this.execution });
    }

    // 错误工作流在「本次执行已收尾」之后再跑：它自己的失败不覆盖原错误（CONTRACT §5.10），
    // 也不应把父执行的状态改回去。
    if (this.finalStatus === "error") {
      await this.runErrorWorkflow();
    }
    return this.execution;
  }

  private async runLoop(): Promise<void> {
    while (this.stack.length > 0) {
      if (this.signal.aborted) {
        this.cancel();
        return;
      }
      const budget = this.budgetError();
      if (budget) {
        this.fail(budget);
        return;
      }
      const entry = this.stack.shift();
      if (!entry) return;
      this.nodeRuns += 1;
      const node = getNodeById(this.workflow, entry.nodeId);
      // 连接指向已删除节点（画布上刚删、但连接没清干净）：跳过，不让执行崩掉。
      if (!node) continue;

      const outcome = await this.executeNode(entry, node);
      if (outcome.kind === "canceled") {
        this.cancel();
        return;
      }
      if (outcome.kind === "skipped") continue;
      if (outcome.kind === "failed") {
        this.fail(outcome.error);
        return;
      }
      // 节点执行期间被取消：不再调度下游（已完成的节点记录保留）。
      if (this.signal.aborted) {
        this.cancel();
        return;
      }
      // 部分执行：目标节点完成即停，不再调度它的下游。
      if (this.options.destinationNodeId && node.id === this.options.destinationNodeId) {
        return;
      }
      this.scheduleDownstream(node, outcome.output);
      this.flushPending();
    }
  }

  /** 起点的决定：显式 startNodeId 优先，否则找触发节点；两者都没有就没法执行。 */
  private resolveStart(): StartResolution {
    const { startNodeId, destinationNodeId } = this.options;

    if (startNodeId) {
      const node = getNodeById(this.workflow, startNodeId);
      if (!node) {
        return { error: { message: `找不到部分执行的起点节点：${startNodeId}` } };
      }
      const portCount = Math.max(1, inputCountOf(node));
      const input =
        this.options.inputData ?? {
          main: Array.from({ length: portCount }, () => [] as Item[]),
        };
      return { node, explicitInput: cloneInputData(input) };
    }

    if (destinationNodeId && !getNodeById(this.workflow, destinationNodeId)) {
      return { error: { message: `找不到部分执行的终点节点：${destinationNodeId}` } };
    }

    const trigger = findTriggerNode(this.workflow);
    if (!trigger) {
      return {
        error: {
          message: "工作流没有触发器节点，无法确定从哪个节点开始执行。",
          description: "手动运行时请指定起点节点，或在工作流里添加触发节点。",
        },
      };
    }

    // 触发器节点的输入来自调用方：triggerData（手动/子流程），兼容只给 inputData 的调用。
    const triggerItems = this.options.triggerData ?? this.options.inputData?.main[0] ?? [];
    return { node: trigger, explicitInput: { main: [cloneItems(triggerItems)] } };
  }

  // -- 节点执行 ------------------------------------------------------------

  private async executeNode(entry: StackEntry, node: WorkflowNode): Promise<NodeOutcome> {
    const inputData = entry.explicitInput ?? this.gatherInput(node);

    // 禁用节点：不执行、不记录，输入原样透传给下游（用户在画布上「临时旁路」一个节点）。
    if (node.disabled === true) {
      const output: NodeOutputData = { main: [firstPortItems(inputData)] };
      this.markCompleted(node.id, output);
      return { kind: "success", output };
    }

    const runIndex = this.execution.runData[node.id]?.length ?? 0;

    // executeOnce（CONTRACT §5.6）：本次执行里只跑一次，首次拿全部输入，后续入栈直接跳过。
    if (node.executeOnce === true && runIndex > 0) {
      return { kind: "skipped" };
    }

    // pinData：不执行节点，直接用固定输出；仍记一条成功记录，UI 能看到「这里是钉住的」。
    if (node.pinData && node.pinData.length > 0) {
      return this.executePinned(entry, node, runIndex);
    }

    const startTime = this.nowFn();
    const executionIndex = this.executionCounter;
    this.executionCounter += 1;
    this.emitNodeStart(node, runIndex, executionIndex);

    const nodeType = getNodeType(node.type);
    if (!nodeType) {
      return this.handleFailure(
        entry,
        node,
        inputData,
        toNodeErrorInfo(new Error(`未知的节点类型：${node.type}`), node, {
          description: "该节点类型未注册，可能来自更新版本的工作流或未安装的节点包。",
        }),
        runIndex,
        startTime,
        executionIndex,
      );
    }

    // 表达式在节点执行前解析（context.parameters 是已解析快照）。
    // 解析失败算节点失败：用户写的 {{ }} 有错时，应该看到「哪个节点、哪段参数」失败。
    let parameters: Record<string, unknown>;
    try {
      parameters = resolveParameters(
        node.parameters ?? {},
        this.buildExpressionContext(node, inputData, runIndex),
      );
    } catch (error) {
      return this.handleFailure(
        entry,
        node,
        inputData,
        toNodeErrorInfo(error, node, {
          description: "参数里的表达式求值失败，检查 {{ }} 中的写法。",
        }),
        runIndex,
        startTime,
        executionIndex,
      );
    }

    const retry = retryParams(node);
    let lastError: unknown;

    for (let attempt = 0; attempt < retry.tries; attempt += 1) {
      if (this.signal.aborted) return { kind: "canceled" };

      // 重试等待：只有第二次起才等；等待可被取消（CONTRACT §5.4）。
      if (attempt > 0 && retry.waitMs > 0) {
        try {
          await (this.deps.sleep ?? defaultSleep)(retry.waitMs, this.signal);
        } catch (error) {
          if (this.signal.aborted || isAbortError(error)) return { kind: "canceled" };
          lastError = error;
          break;
        }
      }

      try {
        const context = this.createNodeContext(node, parameters, inputData, runIndex);
        const raw = await nodeType.execute(context);
        const output = sanitizeOutputData(normalizeNodeResult(raw));
        this.applyAlwaysOutputData(node, output);
        const itemsTotal = countItems(output);
        // 重试的中间尝试不落记录：只写最终成功/失败那一条（CONTRACT §5.4）。
        const run = buildNodeRunData({
          startTime,
          executionTime: this.nowFn() - startTime,
          executionIndex,
          sourceNodeId: entry.sourceNodeId,
          status: "success",
          output,
          itemsTotal,
        });
        this.appendRun(node.id, run);
        this.markCompleted(node.id, output);
        this.emitNodeFinish(node, runIndex, executionIndex, "success", itemsTotal, run);
        return { kind: "success", output };
      } catch (error) {
        if (this.signal.aborted || isAbortError(error)) return { kind: "canceled" };
        lastError = error;
      }
    }

    return this.handleFailure(
      entry,
      node,
      inputData,
      toNodeErrorInfo(lastError, node),
      runIndex,
      startTime,
      executionIndex,
    );
  }

  private executePinned(
    entry: StackEntry,
    node: WorkflowNode,
    runIndex: number,
  ): NodeOutcome {
    const startTime = this.nowFn();
    const executionIndex = this.executionCounter;
    this.executionCounter += 1;
    this.emitNodeStart(node, runIndex, executionIndex);

    const output: NodeOutputData = { main: [node.pinData ?? []] };
    const itemsTotal = countItems(output);
    const run = buildNodeRunData({
      startTime,
      executionTime: this.nowFn() - startTime,
      executionIndex,
      sourceNodeId: entry.sourceNodeId,
      status: "success",
      output,
      itemsTotal,
    });
    this.appendRun(node.id, run);
    this.markCompleted(node.id, output);
    this.emitNodeFinish(node, runIndex, executionIndex, "success", itemsTotal, run);
    return { kind: "success", output };
  }

  /**
   * 按 `onError` 三态处理节点失败（CONTRACT §5.5）。
   *
   * 失败也要落一条 `status: "error"` 记录：执行历史里能看到「这个节点错了、错在哪」，
   * 即使整体执行因为 continue* 还在继续。
   */
  private handleFailure(
    entry: StackEntry,
    node: WorkflowNode,
    inputData: NodeInputData,
    errorInfo: NodeErrorInfo,
    runIndex: number,
    startTime: number,
    executionIndex: number,
  ): NodeOutcome {
    const described = withDescription(errorInfo);
    const mode = node.onError ?? "stopWorkflow";

    if (mode === "continueRegularOutput") {
      const output = passThroughInput(firstPortItems(inputData));
      const itemsTotal = countItems(output);
      const run = buildNodeRunData({
        startTime,
        executionTime: this.nowFn() - startTime,
        executionIndex,
        sourceNodeId: entry.sourceNodeId,
        status: "error",
        output,
        error: described,
        itemsTotal,
      });
      this.appendRun(node.id, run);
      this.markCompleted(node.id, output);
      this.emitNodeFinish(node, runIndex, executionIndex, "error", itemsTotal, run);
      return { kind: "continued", output, error: described };
    }

    if (mode === "continueErrorOutput") {
      // 错误项切到最后一个输出口；成功项（本模型里抛错时没有）留在原输出口。
      const outputCount = Math.max(1, outputCountOf(node));
      const output = routeErrorItemsToLastOutput(outputCount, firstPortItems(inputData), described);
      const itemsTotal = countItems(output);
      const run = buildNodeRunData({
        startTime,
        executionTime: this.nowFn() - startTime,
        executionIndex,
        sourceNodeId: entry.sourceNodeId,
        status: "error",
        output,
        error: described,
        itemsTotal,
      });
      this.appendRun(node.id, run);
      this.markCompleted(node.id, output);
      this.emitNodeFinish(node, runIndex, executionIndex, "error", itemsTotal, run);
      return { kind: "continued", output, error: described };
    }

    // stopWorkflow（默认）：记录错误后停整条执行；已产生的 runData 保留。
    const run = buildNodeRunData({
      startTime,
      executionTime: this.nowFn() - startTime,
      executionIndex,
      sourceNodeId: entry.sourceNodeId,
      status: "error",
      error: described,
      itemsTotal: 0,
    });
    this.appendRun(node.id, run);
    this.emitNodeFinish(node, runIndex, executionIndex, "error", 0, run);
    return { kind: "failed", error: described };
  }

  /** alwaysOutputData：没数据也塞一条空 item，让下游能被调度（调试用）。 */
  private applyAlwaysOutputData(node: WorkflowNode, output: NodeOutputData): void {
    if (node.alwaysOutputData !== true) return;
    if (countItems(output) > 0) return;
    if (output.main.length === 0) output.main = [[]];
    output.main[0] = [{ json: {} }];
  }

  // -- 输入 / 输出 ---------------------------------------------------------

  /** 从静态连接表 + 上游最近输出汇总输入：同一输入口多根线按上游画布位置拼接（CONTRACT §5.2）。 */
  private gatherInput(node: WorkflowNode): NodeInputData {
    const portCount = Math.max(1, inputCountOf(node));
    const main: Item[][] = [];
    for (let inputIndex = 0; inputIndex < portCount; inputIndex += 1) {
      const items: Item[] = [];
      // getInputConnections 已按上游节点画布位置排序，拼接顺序因此是确定的。
      for (const connection of getInputConnections(this.workflow, node.id, inputIndex)) {
        const port = this.lastOutputs[connection.nodeId]?.[connection.outputIndex] ?? [];
        items.push(...port);
      }
      main.push(items);
    }
    return { main };
  }

  private markCompleted(nodeId: string, output: NodeOutputData): void {
    this.completed.add(nodeId);
    // 复制一层：节点实现可能改自己返回的数组，不能让它改到引擎缓存的上游输出。
    this.lastOutputs[nodeId] = output.main.map((port) => [...port]);
  }

  /** 把本次运行的下游入队：只调度「有 items 的输出口」连到的节点，按画布位置排序。 */
  private scheduleDownstream(node: WorkflowNode, output: NodeOutputData): void {
    const targets = new Map<string, number>();
    for (let outputIndex = 0; outputIndex < output.main.length; outputIndex += 1) {
      if ((output.main[outputIndex] ?? []).length === 0) continue;
      for (const connection of getOutputConnections(this.workflow, node.id, outputIndex)) {
        if (targets.has(connection.node)) continue;
        const target = getNodeById(this.workflow, connection.node);
        if (!target) continue;
        targets.set(connection.node, positionKey(target));
      }
    }
    const ordered = [...targets.entries()].sort(
      (a, b) => a[1] - b[1] || a[0].localeCompare(b[0]),
    );
    for (const [targetId] of ordered) {
      this.enqueueTarget(targetId, node.id);
    }
  }

  /**
   * 多输入节点的就绪判断：每个「有上游连线」的输入口都至少有一个上游完成过才执行。
   *
   * 为什么需要它：双输入的 Merge 节点若在上游 A 完成时立刻跑，会拿到「A 有数据、B 还没跑」
   * 的半成品输入，等 B 完成又跑一次——用户看到的是重复执行。等所有输入口就绪后一次跑完，
   * 才是「合并」该有的语义。单输入节点不做等待（每条上游到达都按一次触发处理）。
   */
  private isReady(nodeId: string): boolean {
    const node = getNodeById(this.workflow, nodeId);
    if (!node) return false;
    const portCount = Math.max(1, inputCountOf(node));
    if (portCount <= 1) return true;
    for (let inputIndex = 0; inputIndex < portCount; inputIndex += 1) {
      const connections = getInputConnections(this.workflow, nodeId, inputIndex);
      if (connections.length === 0) continue;
      if (!connections.some((connection) => this.completed.has(connection.nodeId))) {
        return false;
      }
    }
    return true;
  }

  private enqueueTarget(targetId: string, sourceNodeId: string): void {
    if (this.isReady(targetId)) {
      this.pending.delete(targetId);
      this.stack.push({ nodeId: targetId, sourceNodeId });
    } else {
      this.pending.set(targetId, sourceNodeId);
    }
  }

  /** 某个上游完成后，别的挂起目标可能也凑齐了输入口，补调度一次。 */
  private flushPending(): void {
    for (const [targetId, sourceNodeId] of [...this.pending]) {
      if (!this.isReady(targetId)) continue;
      this.pending.delete(targetId);
      this.stack.push({ nodeId: targetId, sourceNodeId });
    }
  }

  // -- 上下文 --------------------------------------------------------------

  private buildExpressionContext(
    node: WorkflowNode,
    inputData: NodeInputData,
    runIndex: number,
  ): ExpressionContext {
    const items = firstPortItems(inputData);
    // 为什么参数只解析一次（而不是每个 item 一次）：
    // 本仓节点是「一次拿到全部 items」的批处理模型（与 types.ts 的 NodeExecutionContext 一致），
    // 所以 `$json` 取第一条输入作为代表；需要逐条处理时由节点自己遍历 items
    // （例如 code 节点的 runOnceForEachItem 在沙箱里逐条执行）。
    // `$node["名字"]` 取「该节点最近一次运行的第一个输出口」；`$node.x.all()` 取全部。
    const nodeOutputs: Record<string, Item[]> = {};
    for (const other of this.workflow.nodes) {
      const outputs = this.lastOutputs[other.id];
      if (!outputs) continue;
      nodeOutputs[other.name] = outputs[0] ?? [];
    }
    return buildExpressionContext({
      json: items[0]?.json ?? {},
      items,
      itemIndex: 0,
      runIndex,
      nodeOutputs,
      workflow: { id: this.workflow.id, name: this.workflow.name, active: this.workflow.active },
      execution: { id: this.execution.id, mode: this.execution.mode },
      vars: this.vars,
      parameter: node.parameters ?? {},
      now: new Date(this.nowFn()),
    });
  }

  private createNodeContext(
    node: WorkflowNode,
    parameters: Record<string, unknown>,
    inputData: NodeInputData,
    runIndex: number,
  ): NodeExecutionContext {
    const helpers: NodeHelpers = {
      httpRequest: this.deps.httpRequest ?? missingHttpRequest,
      sleep: this.deps.sleep ?? defaultSleep,
      // 原样透传（CONTRACT：代码节点与执行子流程节点只通过 helpers 拿能力）。
      ...(this.deps.runUserCode ? { runUserCode: this.deps.runUserCode } : {}),
      ...(this.deps.executeSubWorkflow ? { executeSubWorkflow: this.deps.executeSubWorkflow } : {}),
    };
    const resolveCredential = this.deps.getCredential;
    return {
      node,
      workflow: this.workflow,
      runIndex,
      parameters,
      inputData,
      mode: this.execution.mode,
      executionId: this.execution.id,
      getNodeParameter: <T>(name: string, fallback: T): T => {
        const value = parameters[name];
        return value === undefined ? fallback : (value as T);
      },
      getInputData: (inputIndex = 0) => inputData.main[inputIndex] ?? [],
      getNodeOutputData: (nodeId: string, outputIndex?: number) => {
        const outputs = this.lastOutputs[nodeId] ?? [];
        if (outputIndex === undefined) return outputs;
        return [outputs[outputIndex] ?? []];
      },
      getWorkflowStaticData: (kind: "global" | "node" = "global") =>
        kind === "node"
          ? this.staticProvider.getNodeStaticData(this.workflow.id, node.id)
          : this.staticProvider.getWorkflowStaticData(this.workflow.id),
      getCredential: async (type: string) => {
        const credentialId = node.credentials?.[type];
        if (!credentialId || !resolveCredential) return null;
        return resolveCredential(type, credentialId);
      },
      helpers,
      abortSignal: this.controller.signal,
      logger: this.logger,
    };
  }

  // -- 预算 / 取消 / 事件 --------------------------------------------------

  private get signal(): AbortSignal {
    return this.controller.signal;
  }

  private attachAbort(): void {
    const external = this.options.abortSignal;
    if (!external) return;
    if (external.aborted) {
      this.controller.abort();
      return;
    }
    const onAbort = (): void => {
      this.controller.abort();
    };
    external.addEventListener("abort", onAbort, { once: true });
    this.detachAbort = () => {
      external.removeEventListener("abort", onAbort);
    };
  }

  private budgetError(): NodeErrorInfo | null {
    if (this.nodeRuns >= WORKFLOW_LIMITS.maxNodeRuns) {
      return {
        message: `执行次数超过上限（${WORKFLOW_LIMITS.maxNodeRuns} 次）`,
        description: "工作流里可能存在死循环：检查循环节点是否设置了退出条件。",
      };
    }
    const elapsed = this.nowFn() - this.execution.startedAt;
    if (elapsed > WORKFLOW_LIMITS.maxExecutionMs) {
      return {
        message: `执行超时（超过 ${Math.round(WORKFLOW_LIMITS.maxExecutionMs / 60_000)} 分钟）`,
        description: "检查是否有节点长时间等待，或把工作流拆小一点。",
      };
    }
    return null;
  }

  private fail(errorInfo: NodeErrorInfo): void {
    this.finalStatus = "error";
    this.finalError = withDescription(errorInfo);
  }

  private cancel(): void {
    this.finalStatus = "canceled";
    this.finalError = canceledErrorInfo();
  }

  private appendRun(nodeId: string, run: NodeRunData): void {
    const list = (this.execution.runData[nodeId] ??= []);
    list.push(run);
  }

  private emit(event: EngineEvent): void {
    const onEvent = this.options.onEvent;
    if (!onEvent) return;
    try {
      onEvent(event);
    } catch (error) {
      // 订阅方的问题不能影响执行：UI 挂了不代表工作流该失败。
      this.logger.warn("进度事件回调抛错，已忽略", { message: errorMessage(error) });
    }
  }

  private emitNodeStart(node: WorkflowNode, runIndex: number, executionIndex: number): void {
    this.emit({
      type: "nodeStart",
      executionId: this.execution.id,
      nodeId: node.id,
      nodeName: node.name,
      nodeType: node.type,
      runIndex,
      executionIndex,
      mode: this.execution.mode,
    });
  }

  private emitNodeFinish(
    node: WorkflowNode,
    runIndex: number,
    executionIndex: number,
    status: EngineNodeRunStatus,
    itemsTotal: number,
    run: NodeRunData,
  ): void {
    const event: NodeFinishEvent = {
      type: "nodeFinish",
      executionId: this.execution.id,
      nodeId: node.id,
      nodeName: node.name,
      nodeType: node.type,
      runIndex,
      executionIndex,
      status,
      itemsTotal,
    };
    if (run.error) event.error = run.error;
    this.emit(event);
  }

  // -- 错误工作流 ----------------------------------------------------------

  /**
   * 执行失败后按 `settings.errorWorkflowId` 交给错误工作流（CONTRACT §5.10）。
   *
   * 输入是错误上下文 items（`{execution, workflow, error}` 三段），由子流程的
   * 错误触发器节点接收；错误工作流自己失败只记日志，不改父执行结果。
   */
  private async runErrorWorkflow(): Promise<void> {
    const errorWorkflowId = this.workflow.settings.errorWorkflowId;
    if (!errorWorkflowId) return;
    // 错误工作流自己失败时不再套娃触发它的错误工作流。
    if (this.execution.mode === "error") return;
    const executor = this.deps.executeSubWorkflow;
    if (!executor) {
      this.logger.info("未注入 executeSubWorkflow，跳过错误工作流", { errorWorkflowId });
      return;
    }

    const errorInfo = this.execution.error ?? { message: "执行失败" };
    const errorItems: Item[] = [
      {
        json: {
          execution: {
            id: this.execution.id,
            workflowId: this.execution.workflowId,
            workflowName: this.execution.workflowName,
            mode: this.execution.mode,
            status: this.execution.status,
            startedAt: this.execution.startedAt,
            finishedAt: this.execution.finishedAt,
            durationMs: this.execution.durationMs,
          },
          workflow: {
            id: this.workflow.id,
            name: this.workflow.name,
            versionId: this.workflow.versionId,
          },
          error: { ...errorInfo },
        },
      },
    ];

    try {
      const result = await executor({
        workflowId: errorWorkflowId,
        mode: "error",
        parentExecutionId: this.execution.id,
        inputData: errorItems,
      });
      if (result.execution.status === "error") {
        this.logger.warn("错误工作流自身执行失败，不影响原执行错误", {
          executionId: result.execution.id,
        });
      }
    } catch (error) {
      this.logger.warn("错误工作流执行失败，不影响原执行错误", {
        message: errorMessage(error),
      });
    }
  }
}

function cloneItems(items: Item[]): Item[] {
  return items.map((item) => ({ ...item }));
}

function cloneInputData(input: NodeInputData): NodeInputData {
  return { main: (input.main ?? []).map((port) => cloneItems(Array.isArray(port) ? port : [])) };
}

/**
 * 执行一条工作流。
 *
 * 约定：**不抛异常**。任何错误都收敛成返回值的 `status: "error" | "canceled"` +
 * `error` + 已产生的 `runData`；调用方（UI/调度器）只需要看返回记录。
 */
export async function executeWorkflow(options: ExecuteOptions): Promise<WorkflowExecution> {
  try {
    const engine = new WorkflowEngine(options);
    return await engine.run();
  } catch (error) {
    // 最后一道兜底：引擎内部保证不抛，但调用方可能传入未归一的畸形工作流
    // （例如导入数据里 nodes 不是数组）。这种情况也要给一条可读的执行记录，
    // 不能让 UI 的「运行」按钮直接炸掉。
    const workflow = options.workflow;
    const now = options.deps?.now?.() ?? Date.now();
    const execution = createExecutionRecord({
      workflow: { id: workflow?.id ?? "unknown", name: workflow?.name ?? "未知工作流" },
      mode: options.mode ?? "manual",
      executionId: options.executionId ?? createExecutionId(now),
      now,
      parentExecutionId: options.parentExecutionId,
    });
    finalizeExecution(execution, "error", now, toNodeErrorInfo(error));
    return execution;
  }
}
