/**
 * 并行子代理的界面状态（d.200）。
 *
 * 为什么要单独存一份：`agent_task` 跑在工具调用里，子代理的进度只存在于那个
 * Promise 的闭包里——界面拿不到。而「两个子代理在翻目录」正是用户最需要看见的
 * 那几分钟：看不见就会以为卡住了，于是点停止，把已经查了一半的活全丢掉。
 *
 * 三条口径：
 * - **只存内存**：子代理跑完就没了，界面只在「有在跑」时显示；不落盘、不跨会话。
 * - **只报事实**：进度来自真实轮次与工具名（`file_grep` 而不是「正在分析」），
 *   不编造百分比。
 * - **按派遣顺序**：`subagent.ts` 用 `sub-1..sub-n` 作 id，这里按首次出现顺序排列，
 *   完成先后不改变行序——用户读的是「第 1 件在做什么」。
 */
import type { SubagentProgressEvent } from "./subagent.js";

export type SubagentRunStatus = "running" | "done" | "failed";

export interface SubagentRun {
  /** 派遣内的任务 id（`sub-1` / `sub-2`…）。 */
  id: string;
  /** 这一条要查什么（原样来自模型给的任务描述）。 */
  task: string;
  status: SubagentRunStatus;
  /** 已经走到第几轮（从 1 开始；0 表示刚派出）。 */
  round: number;
  /** 当前正在调的只读工具名；不在工具阶段时为 null。 */
  tool: string | null;
  /** done/failed 时的简述（用完轮次、已中断等）。 */
  note: string | null;
  startedAt: number;
  endedAt: number | null;
}

let runs: SubagentRun[] = [];
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of [...listeners]) listener();
}

/** 订阅变化（`useSyncExternalStore` 用）。 */
export function subscribeSubagentRuns(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 当前快照：**引用稳定**，只在真的变了的时候换新数组（`useSyncExternalStore` 要求）。 */
export function listSubagentRuns(): SubagentRun[] {
  return runs;
}

/** 在跑的那几条（界面只在非空时显示面板）。 */
export function activeSubagentRuns(): SubagentRun[] {
  return runs.filter((run) => run.status === "running");
}

/** 切会话/收口时清空：子代理是这一轮的产物，不该出现在别的会话里。 */
export function resetSubagentRuns(): void {
  if (runs.length === 0) return;
  runs = [];
  emit();
}

function patchRun(id: string, task: string, patch: Partial<SubagentRun>, now: number): void {
  const index = runs.findIndex((run) => run.id === id);
  if (index < 0) {
    runs = [
      ...runs,
      {
        id,
        task,
        status: "running",
        round: 0,
        tool: null,
        note: null,
        startedAt: now,
        endedAt: null,
        ...patch,
      },
    ];
  } else {
    runs = runs.map((run, i) => (i === index ? { ...run, ...patch } : run));
  }
  emit();
}

/**
 * 把一条进度事件落到状态上（幂等：重复事件只是覆盖同一条）。
 *
 * 没有 `start` 事件也能工作：工具层如果先报的是 `tool`（例如测试里只报一条），
 * 这里会按「新派出」补一行，而不是丢掉这条信息。
 */
export function applySubagentProgress(event: SubagentProgressEvent, now = Date.now()): void {
  switch (event.phase) {
    case "start":
      patchRun(
        event.taskId,
        event.task,
        { task: event.task, status: "running", round: 0, tool: null, note: null, startedAt: now, endedAt: null },
        now,
      );
      return;
    case "round":
      patchRun(event.taskId, event.task, { round: event.round }, now);
      return;
    case "tool":
      patchRun(event.taskId, event.task, { round: event.round, tool: event.tool ?? null }, now);
      return;
    case "done":
      patchRun(
        event.taskId,
        event.task,
        {
          status: "done",
          round: event.round,
          tool: null,
          endedAt: now,
          ...(event.note ? { note: event.note } : {}),
        },
        now,
      );
      return;
    default:
      patchRun(
        event.taskId,
        event.task,
        {
          status: "failed",
          round: event.round,
          tool: null,
          endedAt: now,
          note: event.note ?? "已中断",
        },
        now,
      );
  }
}
