/**
 * 工作流定时调度器：每 15 秒看一眼「谁到点了」，串行跑，跑完记执行记录。
 *
 * 与自动化模块同口径的三条规则：
 * 1. **错过不补跑**：应用启动/刷新时，把「启动前已经到点」的下次触发时刻顺延到
 *    现在之后，而不是把错过的点一次性补出来（否则关了一周再开会一口气跑几百次）；
 * 2. **串行**：同一时刻只跑一条工作流，多条同时到点就排队；工作流之间共享本机资源
 *    （HTTP、磁盘、UI），并发跑只会互相拖慢且让执行记录难读；
 * 3. **只在模块启用时挂载**：`useWorkflowScheduler(enabled)` 由 App 按模块开关调用。
 *
 * 轮询而不是给每条工作流各开一个 setTimeout：15 秒误差对「每天/每小时」的定时
 * 完全够用，而一个定时器让「改了计划立即生效」「启停立即生效」都变成自然行为。
 */

import { useEffect } from "react";
import { nextScheduleRun } from "./engine/schedule";
import { registerAllNodes } from "./nodes/index";
import { getNodeType } from "./registry";
import { useWorkflowStore } from "./store";
import { useWorkflowExecutionsStore } from "./executions";
import { createWorkflowRuntime } from "./runtime";
import type { EngineEvent } from "./engine/index";
import type { Workflow, WorkflowExecution } from "./types";
import { useNotificationStore } from "@heming/sdk";

/** 轮询间隔：到点误差最多 15 秒；对「每天/每几分钟」的工作流足够细。 */
export const WORKFLOW_TICK_MS = 15_000;

/**
 * 调度器可能**先于工作流页面**被 App 挂载（用户没打开页面时也要跑定时）。
 * 节点库没注册的话 `nextScheduleRun` 找不到 scheduleTrigger，所有定时都会被当成
 * 「不可排期」——所以在模块加载时注册一次（registerAllNodes 自身幂等）。
 */
registerAllNodes();

/** 一个 tick 内最多连续跑几条（防止多条秒级计划把主线程钉住）。 */
export const MAX_RUNS_PER_TICK = 5;

/**
 * 模块级串行锁：即使调用方重复挂载（React StrictMode 双执行、或未来多处挂载），
 * 同一时刻也只有一个执行在跑。
 */
let scheduleRunInFlight = false;

/** 是否「有定时触发器」的工作流（注册表优先，未注册时按类型名兜底）。 */
export function isScheduleWorkflow(workflow: Pick<Workflow, "nodes">): boolean {
  return workflow.nodes.some((node) => {
    if (node.disabled) return false;
    const nodeType = getNodeType(node.type);
    if (nodeType) return nodeType.description.trigger === "schedule";
    return node.type === "scheduleTrigger";
  });
}

/** 下一次定时触发的时刻；没有定时触发器或参数坏掉返回 null。 */
export function nextWorkflowRun(
  workflow: Pick<Workflow, "nodes" | "lastRunAt" | "createdAt">,
  from?: Date,
): Date | null {
  if (!isScheduleWorkflow(workflow)) return null;
  const base = from ?? new Date(workflow.lastRunAt ?? workflow.createdAt);
  return nextScheduleRun(workflow, base);
}

/**
 * 当前到点的工作流（按「本该触发的时间」从早到晚）。
 *
 * 「到点」的判据：从上次运行（或创建）时刻算出的下一次触发时刻 ≤ 现在。
 * 没有 lastRunAt 时以 createdAt 为基准——新启用的工作流由 `setActive` 写
 * lastRunAt=now，因此不会因为「创建了很久」而立刻触发。
 */
export function pickDueWorkflows(workflows: readonly Workflow[], now: number): Workflow[] {
  const due: Array<{ workflow: Workflow; at: number }> = [];
  for (const workflow of workflows) {
    if (!workflow.active) continue;
    if (!isScheduleWorkflow(workflow)) continue;
    const next = nextWorkflowRun(workflow);
    if (!next) continue;
    if (next.getTime() > now) continue;
    due.push({ workflow, at: next.getTime() });
  }
  return due.sort((a, b) => a.at - b.at).map((item) => item.workflow);
}

/**
 * 启动时顺延「已经错过的点」：把 nextRunAt 已经过去的 active 工作流的 lastRunAt
 * 写成 now。返回顺延了几条（测试/日志用）。
 *
 * 为什么写 lastRunAt 而不是改 schedule：计划本身没变，只是「本次没跑」，
 * 下一次仍按原计划算；写错计划反而会让用户改过的设置看起来被篡改。
 */
export function postponeMissedRuns(
  now: number = Date.now(),
  store: Pick<typeof useWorkflowStore, "getState"> = useWorkflowStore,
): number {
  const state = store.getState();
  let postponed = 0;
  for (const workflow of state.listActive()) {
    if (!isScheduleWorkflow(workflow)) continue;
    const next = nextScheduleRun(workflow, new Date(workflow.lastRunAt ?? workflow.createdAt));
    if (!next || next.getTime() > now) continue;
    state.markRun(workflow.id, now);
    postponed += 1;
  }
  return postponed;
}

/** 执行失败时推一条通知；kind 用 `workflow`，通知中心点开直达工作流页并选中它。 */
export function notifyWorkflowFailure(
  workflow: Pick<Workflow, "id" | "name">,
  message: string,
  executionId: string,
): void {
  useNotificationStore.getState().push({
    kind: "workflow",
    key: `workflow:${workflow.id}:error:${executionId}`,
    workflowId: workflow.id,
    title: `工作流「${workflow.name}」执行失败`,
    body: message || "请打开工作流查看执行记录",
  });
}

/**
 * 挂载定时调度循环。
 *
 * 只在模块实际启用时调用（App.tsx / 模块注册表由 Lead 接线）；`enabled` 变化时
 * 卸载定时器并停掉后续 tick（正在跑的那一次会自然结束并写记录）。
 */
export function useWorkflowScheduler(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    const startedAt = Date.now();
    // 启动顺延必须先做：不然第一次 tick 会把所有错过的工作流立即跑一遍。
    postponeMissedRuns(startedAt);

    let cancelled = false;
    const runtime = createWorkflowRuntime();

    const runOne = async (workflow: Workflow): Promise<void> => {
      const started = Date.now();
      // 先记账再跑：跑的过程中下一次 tick 不会把同一条工作流再挑出来。
      useWorkflowStore.getState().markRun(workflow.id, started);
      const live = useWorkflowStore.getState().workflows.find((item) => item.id === workflow.id);
      const runCount = (live?.runCount ?? 0) + 1;
      const reached = typeof workflow.maxRuns === "number" && workflow.maxRuns > 0 && runCount >= workflow.maxRuns;
      useWorkflowStore.getState().update(
        workflow.id,
        { runCount, ...(reached ? { active: false } : {}) },
        started,
      );
      let executionId = `wf-exec-${started.toString(36)}`;
      try {
        const execution = await runtime.run(workflow, {
          mode: "trigger",
        });
        executionId = execution.id;
        if (execution.status === "error") {
          notifyWorkflowFailure(workflow, execution.error?.message ?? "", execution.id);
        }
      } catch (error) {
        // runtime.run 正常不会抛（引擎把失败收敛进 execution）；这里只兜底宿主异常。
        notifyWorkflowFailure(
          workflow,
          error instanceof Error ? error.message : String(error),
          executionId,
        );
      }
    };

    const step = async (): Promise<void> => {
      if (cancelled || scheduleRunInFlight) return;
      for (let index = 0; index < MAX_RUNS_PER_TICK; index += 1) {
        if (cancelled) return;
        const due = pickDueWorkflows(useWorkflowStore.getState().listActive(), Date.now());
        const workflow = due[0];
        if (!workflow) return;
        scheduleRunInFlight = true;
        try {
          await runOne(workflow);
        } finally {
          scheduleRunInFlight = false;
        }
      }
    };

    void step();
    const timer = window.setInterval(() => {
      void step();
    }, WORKFLOW_TICK_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [enabled]);
}

/**
 * 给 UI 用的「下次运行」文本/时间（列表卡片）；没有定时触发器返回 null。
 * 独立导出是为了不把组件绑在 store 的实现细节上。
 */
export function describeNextRun(workflow: Workflow, now: number = Date.now()): number | null {
  const next = nextWorkflowRun(workflow, new Date(now));
  return next ? next.getTime() : null;
}

/** 监听引擎事件（编辑器运行态用）的辅助：只把 nodeFinish 转成 UI 需要的最小信息。 */
export type WorkflowRunEventHandler = (event: EngineEvent) => void;

/** 执行记录是否值得提示（成功/失败/取消）——供编辑器与页面共用。 */
export function isExecutionFinished(execution: {
  status: string;
}): execution is { status: "success" | "error" | "canceled" } {
  return execution.status === "success" || execution.status === "error" || execution.status === "canceled";
}

/** 供测试/调试：当前是否有调度执行在跑。 */
export function workflowRunInFlight(): boolean {
  return scheduleRunInFlight;
}

/** 把执行记录写进 executions store（scheduler 与编辑器共用同一口径）。 */
export function recordWorkflowExecution(
  workflow: Pick<Workflow, "settings">,
  execution: WorkflowExecution,
): void {
  useWorkflowExecutionsStore.getState().add(execution, workflow.settings);
}
