import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SubagentProgressEvent } from "./subagent.js";
import {
  activeSubagentRuns,
  applySubagentProgress,
  listSubagentRuns,
  resetSubagentRuns,
  subscribeSubagentRuns,
} from "./subagentRuns.js";

/** 造一条进度事件（默认 phase=start，省得每处都写全）。 */
function event(
  phase: SubagentProgressEvent["phase"],
  extra: Partial<SubagentProgressEvent> = {},
): SubagentProgressEvent {
  return { taskId: "sub-1", task: "查 docs", phase, round: 0, ...extra };
}

describe("subagentRuns（d.200）", () => {
  beforeEach(() => {
    resetSubagentRuns();
  });

  it("start 建一行：running、0 轮、没有工具；active 里能查到", () => {
    applySubagentProgress(event("start", { task: "查 docs" }), 1_000);
    const runs = listSubagentRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      id: "sub-1",
      task: "查 docs",
      status: "running",
      round: 0,
      tool: null,
      note: null,
      startedAt: 1_000,
      endedAt: null,
    });
    expect(activeSubagentRuns()).toHaveLength(1);
  });

  it("round / tool 只改对应字段：轮次上涨、工具名可见，行还在 running", () => {
    applySubagentProgress(event("start"), 1_000);
    applySubagentProgress(event("round", { round: 2 }), 1_100);
    applySubagentProgress(event("tool", { round: 2, tool: "file_grep" }), 1_200);
    const [run] = listSubagentRuns();
    expect(run).toMatchObject({ status: "running", round: 2, tool: "file_grep", endedAt: null });
  });

  it("done 收口：状态、轮次、结束时间、说明都写上，工具清空，不再算在跑", () => {
    applySubagentProgress(event("start"), 1_000);
    applySubagentProgress(event("done", { round: 3, note: "用完了轮次" }), 2_000);
    const [run] = listSubagentRuns();
    expect(run).toMatchObject({
      status: "done",
      round: 3,
      tool: null,
      note: "用完了轮次",
      endedAt: 2_000,
    });
    expect(activeSubagentRuns()).toEqual([]);
  });

  it("failed 没给说明时写「已中断」，不假装跑完了", () => {
    applySubagentProgress(event("start"), 1_000);
    applySubagentProgress(event("failed", { round: 1 }), 1_500);
    const [run] = listSubagentRuns();
    expect(run).toMatchObject({ status: "failed", note: "已中断", endedAt: 1_500 });
  });

  it("没有 start 事件也能补一行（只在工具阶段报进度时别把信息丢掉）", () => {
    applySubagentProgress(event("tool", { task: "查日志", round: 1, tool: "file_read" }), 500);
    const [run] = listSubagentRuns();
    expect(run).toMatchObject({
      id: "sub-1",
      task: "查日志",
      status: "running",
      round: 1,
      tool: "file_read",
      startedAt: 500,
    });
  });

  it("行序是派遣顺序（sub-2 先报也不插到 sub-1 前面）", () => {
    applySubagentProgress(event("start"), 1_000);
    applySubagentProgress(event("start", { taskId: "sub-2", task: "查日志" }), 1_010);
    applySubagentProgress(event("done", { task: "查 docs", round: 1 }), 1_020);
    expect(listSubagentRuns().map((run) => run.id)).toEqual(["sub-1", "sub-2"]);
  });

  it("引用稳定：没变化时同一个数组，变化之后才换新（useSyncExternalStore 依赖这条）", () => {
    applySubagentProgress(event("start"), 1_000);
    const first = listSubagentRuns();
    expect(listSubagentRuns()).toBe(first);
    applySubagentProgress(event("round", { round: 1 }), 1_100);
    expect(listSubagentRuns()).not.toBe(first);
  });

  it("订阅在每条事件后通知，退订后不再通知", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeSubagentRuns(listener);
    applySubagentProgress(event("start"), 1_000);
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    applySubagentProgress(event("round", { round: 1 }), 1_100);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("reset 清空并通知；本来就空时不打扰订阅者", () => {
    applySubagentProgress(event("start"), 1_000);
    const listener = vi.fn();
    const unsubscribe = subscribeSubagentRuns(listener);
    resetSubagentRuns();
    expect(listSubagentRuns()).toEqual([]);
    expect(listener).toHaveBeenCalledTimes(1);
    resetSubagentRuns();
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });
});
