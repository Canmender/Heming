import { describe, expect, it } from "vitest";
import type { TeamTask } from "@heming/shared";
import { summarizeTeamTasks } from "./teamCounts.js";

function task(patch: Partial<TeamTask> & Pick<TeamTask, "id">): TeamTask {
  return {
    teamId: "t1",
    planId: null,
    title: "任务",
    detail: "",
    assigneeId: null,
    status: "todo",
    createdBy: "u1",
    createdAt: "2026-11-20T00:00:00.000Z",
    updatedAt: "2026-11-20T00:00:00.000Z",
    dueAt: null,
    attachmentFileId: null,
    ...patch,
  };
}

const NOW = Date.parse("2026-11-20T12:00:00.000Z");

describe("团队任务概览计数", () => {
  it("前置任务未完成 → 被阻塞", () => {
    const tasks = [task({ id: "post" }), task({ id: "pre", blockedBy: ["post"] })];
    const { counts } = summarizeTeamTasks(tasks, NOW);
    expect(counts.blocked).toBe(1);
  });

  it("前置任务已完成 → 不算被阻塞", () => {
    const tasks = [task({ id: "pre", status: "done" }), task({ id: "post", blockedBy: ["pre"] })];
    const { counts } = summarizeTeamTasks(tasks, NOW);
    expect(counts.blocked).toBe(0);
  });

  it("前置任务不存在（历史/导入脏数据）→ 不算被阻塞", () => {
    // 旧写法 `byId.get(id)?.status !== "done"` 会把缺失项判成阻塞。
    const tasks = [task({ id: "post", blockedBy: ["gone"] })];
    const { counts } = summarizeTeamTasks(tasks, NOW);
    expect(counts.blocked).toBe(0);
  });
});
