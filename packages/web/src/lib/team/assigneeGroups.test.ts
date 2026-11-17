/**
 * 按人看任务（d.250）的分组与负载文案。
 *
 * 这些用例的重点不是「能分组」，而是几条容易被写错的边界：
 * 组长排最前、待认领排最后；已完成不算逾期；认不出时间的截止时间不报逾期；
 * 已退出成员的遗留任务不能从列表里消失。
 */

import { describe, expect, it } from "vitest";

import type { TeamTask } from "@heming/shared";

import {
  assigneeFilterLabel,
  describeAssigneeLoad,
  groupTasksByAssignee,
  isTaskOverdue,
  UNASSIGNED_GROUP,
} from "./assigneeGroups.js";

const NOW = Date.parse("2026-11-17T10:00:00.000Z");

function task(over: Partial<TeamTask> & { id: string; title: string }): TeamTask {
  return {
    teamId: "t1",
    planId: null,
    detail: "",
    assigneeId: null,
    status: "todo",
    createdBy: "u1",
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    dueAt: null,
    attachmentFileId: null,
    ...over,
  };
}

const members = [
  { user: { id: "u1", displayName: "李雷" } },
  { user: { id: "u2", displayName: "韩梅梅" } },
];

describe("按人看任务（d.250）", () => {
  it("组长排最前、待认领排最后，中间按名字排", () => {
    const groups = groupTasksByAssignee(
      [
        task({ id: "a", title: "待认领的活" }),
        task({ id: "b", title: "韩梅梅的活", assigneeId: "u2" }),
        task({ id: "c", title: "组长的活", assigneeId: "u1" }),
      ],
      members,
      "u1",
      NOW,
    );
    expect(groups.map((g) => g.key)).toEqual(["u1", "u2", UNASSIGNED_GROUP]);
    expect(groups.map((g) => g.role)).toEqual(["leader", "member", "unassigned"]);
    expect(groups[2]?.name).toBe("待认领");
  });

  it("组内按截止时间由近到远，没定截止的排最后", () => {
    const groups = groupTasksByAssignee(
      [
        task({ id: "a", title: "没有截止", assigneeId: "u1" }),
        task({ id: "b", title: "后天", assigneeId: "u1", dueAt: "2026-11-19T00:00:00.000Z" }),
        task({ id: "c", title: "明天", assigneeId: "u1", dueAt: "2026-11-18T00:00:00.000Z" }),
      ],
      members,
      "u1",
      NOW,
    );
    expect(groups[0]?.tasks.map((t) => t.id)).toEqual(["c", "b", "a"]);
  });

  it("未完成与逾期分开数，已完成不算逾期", () => {
    const groups = groupTasksByAssignee(
      [
        task({ id: "a", title: "逾期了", assigneeId: "u2", dueAt: "2026-11-16T00:00:00.000Z" }),
        task({ id: "b", title: "在做", assigneeId: "u2", status: "doing" }),
        task({
          id: "c",
          title: "做完了但早该交",
          assigneeId: "u2",
          status: "done",
          dueAt: "2026-11-10T00:00:00.000Z",
        }),
      ],
      members,
      "u1",
      NOW,
    );
    const group = groups.find((g) => g.key === "u2");
    expect(group?.openCount).toBe(2);
    expect(group?.overdueCount).toBe(1);
  });

  it("逾期判定：标签算未完成，坏时间不报逾期", () => {
    expect(isTaskOverdue({ status: "blocked", dueAt: "2026-11-16T00:00:00.000Z" }, NOW)).toBe(true);
    expect(isTaskOverdue({ status: "todo", dueAt: "2026-11-18T00:00:00.000Z" }, NOW)).toBe(false);
    expect(isTaskOverdue({ status: "todo", dueAt: null }, NOW)).toBe(false);
    expect(isTaskOverdue({ status: "todo", dueAt: "不是时间" }, NOW)).toBe(false);
    expect(isTaskOverdue({ status: "done", dueAt: "2026-11-01T00:00:00.000Z" }, NOW)).toBe(false);
  });

  it("已退出成员的遗留任务仍然出现（名字说清，不吞任务）", () => {
    const groups = groupTasksByAssignee(
      [task({ id: "a", title: "离职的人留下的", assigneeId: "u9" })],
      members,
      "u1",
      NOW,
    );
    expect(groups[0]?.name).toBe("已退出的成员");
    expect(groups[0]?.role).toBe("member");
    expect(groups[0]?.tasks).toHaveLength(1);
  });

  it("没有任务就没有组", () => {
    expect(groupTasksByAssignee([], members, "u1", NOW)).toEqual([]);
  });

  it("组头与筛选项文案", () => {
    const groups = groupTasksByAssignee(
      [task({ id: "a", title: "逾期", assigneeId: "u2", dueAt: "2026-11-16T00:00:00.000Z" })],
      members,
      "u1",
      NOW,
    );
    expect(describeAssigneeLoad(groups[0]!)).toBe("1 项未完成 · 1 项逾期");
    expect(assigneeFilterLabel(groups[0]!)).toBe("韩梅梅 · 1 项未完成 · 1 项逾期");
  });
});
