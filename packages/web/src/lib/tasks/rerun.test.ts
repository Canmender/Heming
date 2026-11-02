import { describe, expect, it } from "vitest";
import {
  RERUN_NOTICE_REPLAY,
  RERUN_NOTICE_SIDE_EFFECT,
  buildRerunPlan,
  canRerun,
  rerunNoticeLines,
} from "./rerun.js";
import type { TaskRecord } from "./store.js";

/**
 * 重跑（rerun）的纯逻辑：目标/智能体/会话原样继承，确认文案必须把副作用说清。
 * 语义按 §12.2：保留原任务，新建任务 + 新 streamId。
 */

function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: "t1",
    conversationId: "c1",
    agentId: "a1",
    agentName: "和小鸣",
    title: "梳理依赖",
    prompt: "梳理 packages/web 的模块依赖",
    status: "failed",
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    steps: [],
    ...overrides,
  };
}

describe("重跑确认文案", () => {
  it("两句话都在：会重新执行一遍 + 之前的写操作可能重复", () => {
    const text = rerunNoticeLines().join("");
    expect(text).toContain(RERUN_NOTICE_REPLAY);
    expect(text).toContain(RERUN_NOTICE_SIDE_EFFECT);
    expect(text).toContain("写操作可能重复");
  });

  it("同时说明原任务不受影响（留痕，不覆盖）", () => {
    expect(rerunNoticeLines().join("")).toContain("原任务的记录、日志与状态保持不变");
  });

  it("不出现「断点续跑」这类暗示无损的说法", () => {
    const text = rerunNoticeLines().join("");
    expect(text).not.toContain("接着上次");
    expect(text).not.toContain("从第");
  });
});

describe("canRerun", () => {
  it("运行中不可重跑（两个回合会抢同一个会话）", () => {
    expect(canRerun(task({ status: "running" }))).toBe(false);
  });

  it("已完成/失败/已中断都可以重跑", () => {
    expect(canRerun(task({ status: "done" }))).toBe(true);
    expect(canRerun(task({ status: "failed" }))).toBe(true);
    expect(canRerun(task({ status: "cancelled" }))).toBe(true);
  });
});

describe("buildRerunPlan", () => {
  it("原样继承目标、智能体与会话（不重新解读意图、不换会话）", () => {
    const origin = task({ prompt: "  原目标  " });
    const plan = buildRerunPlan(origin);
    expect(plan).toEqual({
      conversationId: "c1",
      agentId: "a1",
      agentName: "和小鸣",
      prompt: "  原目标  ",
      mentions: [{ agentId: "a1", name: "和小鸣" }],
    });
  });

  it("是纯函数：不改原任务对象", () => {
    const origin = task();
    const snapshot = JSON.stringify(origin);
    buildRerunPlan(origin);
    expect(JSON.stringify(origin)).toBe(snapshot);
  });
});
