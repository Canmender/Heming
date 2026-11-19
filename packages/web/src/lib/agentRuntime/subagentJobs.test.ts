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
  restoreInterruptedJobs,
  setSubagentJobDelivery,
  subagentDeliveryText,
  takeUndeliveredJobs,
  undeliveredJobsOf,
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

describe("subagentJobs · 重启恢复（d.353）", () => {
  const STORAGE_KEY = "heming.subagentJobs.v1";

  beforeEach(() => {
    resetSubagentJobs();
    localStorage.removeItem(STORAGE_KEY);
  });

  it("没跑完的任务落盘：收口后自然消失，不留下幽灵", async () => {
    const gates = Array.from({ length: 6 }, () => deferred());
    gates.forEach((gate, index) => start(index + 1, () => gate.promise));
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]") as Array<{
      status: string;
      id: string;
    }>;
    expect(stored).toHaveLength(6);
    expect(stored.filter((item) => item.status === "running")).toHaveLength(SUBAGENT_MAX_ACTIVE);

    // 全部跑完：盘上不再有「没跑完」的记录
    for (const gate of gates) gate.resolve({ ok: true, text: "好", rounds: 1, toolCalls: 0 });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]")).toHaveLength(0);
  });

  it("重启后把 running / queued 标成「被重启中断」，补送时说明白", () => {
    const base = {
      conversationId: "c1",
      agentId: "a1",
      agentName: "和小鸣",
      label: "通用子代理",
      task: "查一下路由是怎么注册的",
      createdAt: 1_700_000_000_000,
      startedAt: 1_700_000_000_100,
    };
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([
        { ...base, id: "bg-1", taskId: "bg-1", status: "running" },
        { ...base, id: "bg-2", taskId: "bg-2", status: "queued", startedAt: null },
        { ...base, id: "bg-3", taskId: "bg-3", status: "done" }, // 收口的不该恢复
      ]),
    );

    const restored = restoreInterruptedJobs(1_800_000_000_000);
    expect(restored).toHaveLength(2);
    expect(restored.every((job) => job.status === "failed")).toBe(true);
    expect(restored[0]!.error).toContain("重启");
    expect(restored[0]!.endedAt).toBe(1_800_000_000_000);
    // 不占并发：没有「还在跑」的假象
    expect(activeSubagentJobCount()).toBe(0);
    // 恢复后盘上清掉，避免下次再报一遍
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();

    const taken = takeUndeliveredJobs("c1");
    expect(taken).toHaveLength(2);
    const text = subagentDeliveryText(taken[0]!);
    expect(text).toContain("没能完成");
    expect(text).toContain("重启");
    expect(text).toContain("查一下路由是怎么注册的");
    expect(text).toContain("不要把它没做完的事当成已完成");
  });

  it("坏档安静丢弃，不当成任务", () => {
    localStorage.setItem(STORAGE_KEY, "这不是 JSON");
    expect(restoreInterruptedJobs()).toEqual([]);
    localStorage.setItem(STORAGE_KEY, JSON.stringify([{ id: "bg-1", status: "running" }]));
    expect(restoreInterruptedJobs()).toEqual([]); // 缺字段的记录不猜
  });

  it("同一批恢复只发生一次：第二次读到的是空", () => {
    const record = {
      id: "bg-1",
      conversationId: "c1",
      agentId: "a1",
      agentName: "和小鸣",
      label: "通用子代理",
      task: "查一件事",
      taskId: "bg-1",
      status: "running",
      createdAt: 1,
      startedAt: 2,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify([record]));
    expect(restoreInterruptedJobs()).toHaveLength(1);
    expect(restoreInterruptedJobs()).toHaveLength(0);
  });
});
describe("undeliveredJobsOf：只数不取（d.383）", () => {
  it("算完没交付的才算，还在跑的不算", async () => {
    const done = enqueueSubagentJob({
      conversationId: "c1",
      agentId: "a1",
      agentName: "和小鸣",
      label: "查入口",
      task: "查入口",
      taskId: "bg-1",
      run: () => Promise.resolve({ ok: true, text: "好了", rounds: 1, toolCalls: 0 }),
    });
    const slow = enqueueSubagentJob({
      conversationId: "c1",
      agentId: "a1",
      agentName: "和小鸣",
      label: "慢的",
      task: "慢的",
      taskId: "bg-2",
      run: () => new Promise<{ ok: boolean; text: string; rounds: number; toolCalls: number }>(() => {}),
    });
    await Promise.resolve();
    const pending = undeliveredJobsOf("c1");
    expect(pending.map((job) => job.id)).toContain(done.id);
    expect(pending.map((job) => job.id)).not.toContain(slow.id);
    // 数了不等于取了：按 id 判（别的用例可能留下同会话、尚未落定的作业）
    expect(takeUndeliveredJobs("c1").map((job) => job.id)).toContain(done.id);
    expect(undeliveredJobsOf("c1").map((job) => job.id)).not.toContain(done.id);
  });
});



