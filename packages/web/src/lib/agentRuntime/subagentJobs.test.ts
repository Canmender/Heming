/**
 * 后台子代理的排队与交付（d.349）。
 *
 * 这里测的是「调度与投递」本身：并发上限、排队、失败不吞、交付一次且只有一次、
 * 切会话时先不送。子代理内部怎么跑由 `subagent.test.ts` 覆盖。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  SUBAGENT_MAX_ACTIVE,
  activeSubagentJobCount,
  cancelSubagentJob,
  enqueueSubagentJob,
  listSubagentJobs,
  queuedSubagentJobCount,
  resetSubagentJobs,
  setSubagentJobDelivery,
  subagentDeliveryText,
  takeUndeliveredJobs,
  type SubagentJob,
} from "./subagentJobs.js";

function deferred() {
  let resolve!: (value: { ok: boolean; text: string; rounds: number; toolCalls: number }) => void;
  const promise = new Promise<{ ok: boolean; text: string; rounds: number; toolCalls: number }>(
    (done) => {
      resolve = done;
    },
  );
  return { promise, resolve };
}

function start(index: number, run = () => deferred().promise) {
  let seq = 0;
  return enqueueSubagentJob({
    conversationId: "c1",
    agentId: "a1",
    agentName: "和小鸣",
    label: "通用子代理",
    task: `查第 ${index} 件事`,
    taskId: `bg-test-${index}-${++seq}`,
    run,
  });
}

describe("subagentJobs · 调度（d.349）", () => {
  beforeEach(() => {
    resetSubagentJobs();
  });

  it("同时最多跑 5 个，其余排队；一个收口就补上", async () => {
    const pending = Array.from({ length: 7 }, (_, index) => deferred());
    for (let index = 0; index < 7; index++) {
      const gate = pending[index]!;
      start(index + 1, () => gate.promise);
    }
    expect(activeSubagentJobCount()).toBe(SUBAGENT_MAX_ACTIVE);
    expect(queuedSubagentJobCount()).toBe(2);
    expect(listSubagentJobs().filter((job) => job.status === "running")).toHaveLength(5);

    pending[0]!.resolve({ ok: true, text: "第一条结论", rounds: 2, toolCalls: 3 });
    await Promise.resolve();
    await Promise.resolve();
    expect(activeSubagentJobCount()).toBe(SUBAGENT_MAX_ACTIVE);
    expect(queuedSubagentJobCount()).toBe(1);
  });

  it("收口后把结论交给交付器，只交一次", async () => {
    const seen: SubagentJob[] = [];
    setSubagentJobDelivery((job) => {
      seen.push(job);
    });
    const gate = deferred();
    const job = start(1, () => gate.promise);
    gate.resolve({ ok: true, text: "查到了：在 a.ts", rounds: 1, toolCalls: 2 });
    await Promise.resolve();
    await Promise.resolve();

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ id: job.id, status: "done", rounds: 1, toolCalls: 2 });
    expect(seen[0]!.text).toContain("a.ts");
    expect(listSubagentJobs().find((item) => item.id === job.id)?.delivered).toBe(true);
  });

  it("交付器说「现在不方便」时保持未交付，切回会话能补取", async () => {
    setSubagentJobDelivery(() => false);
    const gate = deferred();
    const job = start(1, () => gate.promise);
    gate.resolve({ ok: true, text: "给别的会话的结论", rounds: 1, toolCalls: 0 });
    await Promise.resolve();
    await Promise.resolve();
    expect(listSubagentJobs().find((item) => item.id === job.id)?.delivered).toBe(false);

    const taken = takeUndeliveredJobs("c1");
    expect(taken).toHaveLength(1);
    expect(taken[0]!.text).toContain("给别的会话的结论");
    // 取走即标记：同一份结论不会让模型看两遍
    expect(takeUndeliveredJobs("c1")).toHaveLength(0);
  });

  it("失败也交付：带原因，模型才知道这件事没成", async () => {
    const seen: SubagentJob[] = [];
    setSubagentJobDelivery((job) => {
      seen.push(job);
    });
    const gate = deferred();
    start(1, () => gate.promise);
    gate.resolve({ ok: false, text: "读文件失败了", rounds: 1, toolCalls: 1 });
    await Promise.resolve();
    await Promise.resolve();
    expect(seen[0]).toMatchObject({ status: "failed" });
    expect(seen[0]!.error).toContain("读文件失败了");
    expect(subagentDeliveryText(seen[0]!)).toContain("没能完成");
  });

  it("排队中的任务可以直接取消，不占着位置", async () => {
    const gates = Array.from({ length: 6 }, () => deferred());
    const jobs = gates.map((gate, index) => start(index + 1, () => gate.promise));
    expect(queuedSubagentJobCount()).toBe(1);
    const queuedJob = jobs[5]!;
    expect(cancelSubagentJob(queuedJob.id)).toBe(true);
    expect(queuedSubagentJobCount()).toBe(0);
    expect(listSubagentJobs().find((item) => item.id === queuedJob.id)?.status).toBe("cancelled");
  });

  it("交付文案自包含：带任务、轮次与「不要当成已完成」的提醒", async () => {
    const gate = deferred();
    start(1, () => gate.promise);
    gate.resolve({ ok: true, text: "结论正文", rounds: 3, toolCalls: 4 });
    await Promise.resolve();
    await Promise.resolve();
    const job = listSubagentJobs()[0]!;
    const text = subagentDeliveryText(job);
    expect(text).toContain("后台子代理交回结论");
    expect(text).toContain("3 轮 / 4 次工具调用");
    expect(text).toContain("查第 1 件事");
    expect(text).toContain("结论正文");
  });

  it("reset 会清空任务表与交付器", () => {
    setSubagentJobDelivery(() => {});
    start(1);
    expect(listSubagentJobs().length).toBe(1);
    resetSubagentJobs();
    expect(listSubagentJobs()).toHaveLength(0);
    expect(activeSubagentJobCount()).toBe(0);
    expect(vi.isMockFunction(resetSubagentJobs)).toBe(false);
  });
});
