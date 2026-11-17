import { describe, expect, it } from "vitest";
import type { TeamTask } from "@heming/shared";
import { describeTeamSummary, summarizeTeamTasks } from "./teamSummary.js";

const iso = "2026-11-17T10:00:00.000Z";

function task(over: Partial<TeamTask> = {}): TeamTask {
  return {
    id: "k1",
    teamId: "t1",
    planId: null,
    title: "任务",
    detail: "",
    assigneeId: null,
    status: "todo",
    createdBy: "u1",
    createdAt: iso,
    updatedAt: iso,
    dueAt: null,
    attachmentFileId: null,
    ...over,
  };
}

describe("团队概览（d.257）", () => {
  it("未完成/已完成分开数，未认领与逾期各自计数", () => {
    const now = Date.parse("2026-11-17T12:00:00.000Z");
    const summary = summarizeTeamTasks(
      [
        task({ id: "k1", assigneeId: null, dueAt: "2026-11-15T00:00:00.000Z" }),
        task({ id: "k2", assigneeId: "u2" }),
        task({ id: "k3", status: "done", assigneeId: "u2" }),
      ],
      now,
    );
    expect(summary).toEqual({
      open: 2,
      done: 1,
      pendingReview: 0,
      overdue: 1,
      unassigned: 1,
      blocked: 0,
    });
  });

  it("前置没做完才算被卡住，前置完成就不算", () => {
    const summary = summarizeTeamTasks([
      task({ id: "k1", status: "todo" }),
      task({ id: "k2", blockedBy: ["k1"] }),
      task({ id: "k3", status: "done" }),
      task({ id: "k4", blockedBy: ["k3"] }),
      task({ id: "k5", blockedBy: ["missing"] }),
    ]);
    expect(summary.blocked).toBe(1);
  });

  it("没截止时间、坏时间都不算逾期", () => {
    const summary = summarizeTeamTasks([
      task({ id: "k1", dueAt: null }),
      task({ id: "k2", dueAt: "不是时间" }),
    ]);
    expect(summary.overdue).toBe(0);
  });

  it("全清与空团队都要说出来", () => {
    expect(describeTeamSummary(summarizeTeamTasks([]))).toBe("还没有任务");
    // 验收上线前完成的老任务没有 reviewState，不算待验收（d.275 口径）。
    expect(describeTeamSummary(summarizeTeamTasks([task({ status: "done" })]))).toBe(
      "没有未完成任务（已完成 1 项）",
    );
  });

  it("有活时把细节按顺序写出来", () => {
    const text = describeTeamSummary({
      open: 4,
      done: 1,
      pendingReview: 0,
      overdue: 1,
      unassigned: 1,
      blocked: 1,
    });
    expect(text).toBe("4 项未完成（逾期 1、待认领 1、被前置卡住 1） · 已完成 1");
  });
});

describe("待验收也算进概览（d.275）", () => {
  it("只数显式 pending 的：老任务（没有 reviewState）与已验收都不算", () => {
    const summary = summarizeTeamTasks([
      task({ id: "k1", status: "done", reviewState: "pending" }),
      task({ id: "k2", status: "done" }),
      task({ id: "k3", status: "done", reviewState: "approved" }),
      task({ id: "k4", status: "doing", reviewState: "changes" }),
    ]);
    expect(summary.done).toBe(3);
    expect(summary.pendingReview).toBe(1);
  });

  it("没有未完成但有活待验收时，概览也要说出来", () => {
    const summary = summarizeTeamTasks([
      task({ id: "k1", status: "done", reviewState: "pending" }),
    ]);
    expect(describeTeamSummary(summary)).toBe("没有未完成任务（已完成 1 项） · 待验收 1");
  });
});
