/**
 * 定时调度器：每 15 秒看一次「谁到点了」，串行跑，失败写本机通知。
 *
 * 为什么轮询而不是给每条工作流各开一个 setTimeout：
 * - 这是本机单用户服务，「到点误差 ≤15 秒」对间隔/每天/每周/Cron 都够用；
 * - 一个定时器让「改计划立即生效」「启停立即生效」「删工作流立即失效」都变成自然行为，
 *   不需要到处维护/清理定时器；
 * - 串行是刻意的：本机资源（模型连接、磁盘、网络）只够一条工作流占着跑，
 *   并发只会互相拖慢，还让执行记录难以阅读。
 *
 * 三条口径（CONTRACT §4.4）：
 * 1. 只跑 `active === true` 且含定时触发器的工作流（手动/错误/子流程触发器不算）；
 * 2. **启动时错过不补跑**：进程关了一周再开，不能把错过的几百个时刻一次性补出来；
 *    启动时把「已经到点」的 lastRunAt 推到 now，从下一个周期开始正常跑；
 * 3. 失败写 `store.addNotification`（标题带工作流名），不静默吞掉。
 */

import { listScheduleTriggers, nextScheduleRun } from "../engine/index.js";
import type { Workflow, WorkflowExecution } from "../types.js";
import type { Runtime } from "./runtime.js";
import type { Store } from "./storage.js";

/** 轮询间隔（CONTRACT §4.4：15 秒）。测试可注入更小值，不把 15 秒写死在实现里。 */
export const SCHEDULER_INTERVAL_MS = 15_000;

/** 一个 tick 里最多连续跑几条：秒级计划 + 多条同时到点时，防止把进程钉死在执行上。 */
export const MAX_RUNS_PER_TICK = 5;

export interface SchedulerOptions {
  /** 轮询间隔（毫秒）；缺省 15s，测试可调小。最小 10ms 防止误传 0 变成忙轮询。 */
  intervalMs?: number;
  /** 每个 tick 最多跑几条；缺省 5。 */
  maxRunsPerTick?: number;
  /** 每次执行结束回调（写日志/推 UI 用）；回调抛错不影响调度。 */
  onExecution?: (execution: WorkflowExecution, workflow: Workflow) => void;
  /** 当前时间（测试注入假时钟；调度判断全用它）。 */
  now?: () => number;
}

export interface SchedulerStatus {
  /** 是否正在轮询（start 之后、stop 之前）。 */
  running: boolean;
  intervalMs: number;
  /** 当前是否有一个 tick 正在跑（串行锁）。 */
  ticking: boolean;
  /** 最近一次 tick 的时间（epoch ms）；还没跑过则没有这个字段。 */
  lastTickAt?: number;
  /** 正在执行的工作流 id；空闲时没有这个字段。 */
  currentWorkflowId?: string;
}

export interface Scheduler {
  start(): void;
  stop(): void;
  status(): SchedulerStatus;
  /** 手动跑一轮调度（测试/内部用；start 后由定时器按 intervalMs 调用）。 */
  tick(): Promise<void>;
  /** 是否在轮询（等价 `status().running`；健康检查直接读它更省事）。 */
  readonly running: boolean;
}

/** 排队待跑的一项：到点时刻用于排序，保证同一份数据每次 tick 的顺序一致。 */
interface DueWorkflow {
  workflow: Workflow;
  dueAt: number;
}

export function createScheduler(
  store: Store,
  runtime: Runtime,
  options: SchedulerOptions = {},
): Scheduler {
  const intervalMs = Math.max(10, Math.trunc(options.intervalMs ?? SCHEDULER_INTERVAL_MS));
  const maxRunsPerTick = Math.max(1, Math.trunc(options.maxRunsPerTick ?? MAX_RUNS_PER_TICK));
  const now = options.now ?? (() => Date.now());

  let timer: NodeJS.Timeout | null = null;
  let running = false;
  let ticking = false;
  let lastTickAt: number | undefined;
  let currentWorkflowId: string | undefined;

  /** 只有「启用」且「注册了定时触发器」的工作流才归调度器管。 */
  function isSchedulable(workflow: Workflow): boolean {
    if (workflow.active !== true) return false;
    return listScheduleTriggers(workflow).length > 0;
  }

  /**
   * 该工作流下一次应在何时跑；算不出来（没有触发器/参数非法）返回 null。
   *
   * 基准取 `lastRunAt ?? createdAt`：从未跑过的工作流从「创建时刻」起算，
   * 这样新工作流不会因为创建了很久而一启动就触发。
   */
  function dueAtOf(workflow: Workflow): number | null {
    const base = workflow.lastRunAt ?? workflow.createdAt;
    const next = nextScheduleRun(workflow, new Date(base));
    return next ? next.getTime() : null;
  }

  /** 本轮到点的工作流，按到点时刻从早到晚排序。 */
  function dueWorkflows(nowMs: number): DueWorkflow[] {
    const due: DueWorkflow[] = [];
    for (const workflow of store.listWorkflows()) {
      if (!isSchedulable(workflow)) continue;
      const dueAt = dueAtOf(workflow);
      if (dueAt === null || dueAt > nowMs) continue;
      due.push({ workflow, dueAt });
    }
    return due.sort((a, b) => a.dueAt - b.dueAt || a.workflow.id.localeCompare(b.workflow.id));
  }

  /** 有执行失败时写一条本机通知；标题必须带工作流名，用户在通知里能直接定位。 */
  function notifyFailure(workflow: Workflow, execution: WorkflowExecution | null, message: string): void {
    const parts: string[] = [];
    const nodeName = execution?.error?.nodeName;
    const description = execution?.error?.description;
    if (nodeName) parts.push(`节点「${nodeName}」`);
    if (description) parts.push(description);
    try {
      store.addNotification({
        title: `工作流「${workflow.name}」执行失败：${message}`,
        ...(parts.length > 0 ? { body: parts.join("：") } : {}),
        workflowId: workflow.id,
      });
    } catch {
      // 通知写不进去（磁盘满/权限）不能反过来影响调度。
    }
  }

  function callOnExecution(execution: WorkflowExecution, workflow: Workflow): void {
    const callback = options.onExecution;
    if (!callback) return;
    try {
      callback(execution, workflow);
    } catch (error) {
      // 订阅方（日志/UI）抛错是它的问题，不能把调度器带崩。
      console.error("[调度器] onExecution 回调抛错（已忽略）：", error);
    }
  }

  /**
   * 跑一条到点的工作流。
   *
   * 无论成功、失败还是抛错，最后都要把 lastRunAt 推到 now：
   * - 成功/引擎内部失败（execution.status === "error"）：执行已经发生，下个周期再排；
   * - runtime 直接抛错（例如同一条工作流正好被手动运行占着）：同样先推到现在，
   *   否则每 15 秒重试一次会把失败放大成刷屏。
   */
  async function runDueWorkflow(workflow: Workflow): Promise<void> {
    // 手动运行正在占用这条工作流：本次跳过，下个 tick 再看（不推 lastRunAt，
    // 避免把「还没跑」误记成「跑过了」而丢掉这次触发）。
    if (runtime.isRunning(workflow.id)) return;

    currentWorkflowId = workflow.id;
    try {
      const execution = await runtime.runWorkflow(workflow, { mode: "trigger" });
      store.markRun(workflow.id, now());
      if (execution.status === "error") {
        notifyFailure(workflow, execution, execution.error?.message ?? "未知错误");
      }
      callOnExecution(execution, workflow);
    } catch (error) {
      store.markRun(workflow.id, now());
      const message = error instanceof Error ? error.message : String(error);
      notifyFailure(workflow, null, message);
    } finally {
      currentWorkflowId = undefined;
    }
  }

  /** 跑一轮调度；上一轮没跑完时直接返回（全局串行，不排队堆积）。 */
  async function tick(): Promise<void> {
    if (ticking) return;
    ticking = true;
    try {
      lastTickAt = now();
      const due = dueWorkflows(lastTickAt);
      for (const item of due.slice(0, maxRunsPerTick)) {
        await runDueWorkflow(item.workflow);
      }
    } catch (error) {
      // store 读盘异常等：记日志，下一轮再试，不让定时器把进程带崩。
      console.error("[调度器] 调度轮询失败（下一轮重试）：", error);
    } finally {
      ticking = false;
    }
  }

  /**
   * 启动时把「已经到点」的 lastRunAt 推到 now（错过不补跑）。
   *
   * 只改 lastRunAt，不改计划本身：用户看到的下次触发时间自然顺延一个周期，
   * 相当于把停机期间错过的时刻折叠掉。
   */
  function deferMissedRuns(): void {
    const nowMs = now();
    for (const workflow of store.listWorkflows()) {
      if (!isSchedulable(workflow)) continue;
      const dueAt = dueAtOf(workflow);
      if (dueAt !== null && dueAt <= nowMs) {
        store.markRun(workflow.id, nowMs);
      }
    }
  }

  function start(): void {
    if (timer) return;
    deferMissedRuns();
    running = true;
    timer = setInterval(() => {
      void tick();
    }, intervalMs);
    // 不阻止进程退出：服务本身由 HTTP server 保活；测试里也不会因为定时器没清而挂住。
    if (typeof timer.unref === "function") timer.unref();
  }

  function stop(): void {
    running = false;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  function status(): SchedulerStatus {
    return {
      running,
      intervalMs,
      ticking,
      ...(lastTickAt !== undefined ? { lastTickAt } : {}),
      ...(currentWorkflowId !== undefined ? { currentWorkflowId } : {}),
    };
  }

  return {
    start,
    stop,
    status,
    tick,
    get running(): boolean {
      return running;
    },
  };
}
