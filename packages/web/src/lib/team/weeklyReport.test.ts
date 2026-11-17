import { describe, expect, it } from "vitest";
import type { TeamTask, TeamWorkspaceSnapshot } from "@heming/shared";
import { weeklyReportFileName, weeklyReportMarkdown } from "./weeklyReport.js";

const NOW = Date.parse("2026-11-18T02:00:00.000Z");
const ME = { id: "u1", username: "admin", displayName: "阿鸣" };
const BOB = { id: "u2", username: "bob", displayName: "鲍勃" };

function task(overrides: Partial<TeamTask> = {}): TeamTask {
  return {
    id: "k1",
    teamId: "t1",
    planId: null,
    title: "接口联调",
    detail: "",
    assigneeId: BOB.id,
    status: "todo",
    createdBy: ME.id,
    createdAt: "2026-11-10T09:00:00.000Z",
    updatedAt: "2026-11-10T09:00:00.000Z",
    dueAt: null,
    attachmentFileId: null,
    ...overrides,
  } as TeamTask;
}

function snapshot(over: Partial<TeamWorkspaceSnapshot> = {}): TeamWorkspaceSnapshot {
  return {
    team: {
      id: "t1",
      name: "增长小组",
      goal: "把周报自动化，把复盘变成习惯",
      ownerId: ME.id,
      createdAt: "2026-11-01T00:00:00.000Z",
      updatedAt: "2026-11-01T00:00:00.000Z",
    },
    members: [
      { user: ME, role: "owner", joinedAt: "2026-11-01T00:00:00.000Z" },
      { user: BOB, role: "member", joinedAt: "2026-11-01T00:00:00.000Z" },
    ],
    plans: [],
    tasks: [task()],
    ...over,
  } as TeamWorkspaceSnapshot;
}

function report(over: Partial<TeamWorkspaceSnapshot> = {}, now = NOW): string {
  return weeklyReportMarkdown(snapshot(over), {
    now,
    memberName: (userId) => {
      if (userId === ME.id) return "阿鸣（@admin）";
      if (userId === BOB.id) return "鲍勃（@bob）";
      return userId;
    },
  });
}

describe("周报成稿的结构（d.269）", () => {
  it("标题带团队名，元信息带时间窗与生成时间，团队目标单列一行", () => {
    const text = report();
    expect(text.startsWith("# 团队周报 · 增长小组\n")).toBe(true);
    expect(text).toContain("（7 天）");
    expect(text).toContain("由和鸣生成于 2026-11-18");
    expect(text).toContain("**团队目标**：把周报自动化，把复盘变成习惯");
    expect(text).toContain("## 概况");
    expect(text).toContain("## 这 7 天完成的");
    expect(text).toContain("## 进行中");
    expect(text).toContain("## 需要关注");
    expect(text).toContain("## 成员负荷");
    expect(text).toContain("## 下周建议");
    expect(text.endsWith("\n")).toBe(true);
  });

  it("概况按事实统计：总数、未完成/已完成、窗口内新建与完成、需要盯的项", () => {
    const text = report({
      tasks: [
        task({ id: "k1", title: "接口联调" }),
        task({
          id: "k2",
          title: "写周报",
          status: "done",
          completedAt: "2026-11-16T09:00:00.000Z",
          completedBy: BOB.id,
          result: "初稿已发群里",
        }),
        task({ id: "k3", title: "下周排期", assigneeId: null }),
      ],
    });
    expect(text).toContain("任务：共 3 项（未完成 2 / 已完成 1）");
    expect(text).toContain("新建 0 项、完成 1 项");
    expect(text).toContain("需要盯：待认领 1");
  });
});

describe("周报里的完成与进行中（d.269）", () => {
  it("只列窗口内完成的，带结论与负责人；窗口外的不算", () => {
    const text = report({
      tasks: [
        task({
          id: "k2",
          title: "写周报",
          status: "done",
          completedAt: "2026-11-16T09:00:00.000Z",
          completedBy: BOB.id,
          result: "初稿已发群里",
        }),
        task({
          id: "k3",
          title: "老任务",
          status: "done",
          completedAt: "2026-10-01T09:00:00.000Z",
          completedBy: ME.id,
        }),
      ],
    });
    expect(text).toContain("## 这 7 天完成的（1）");
    expect(text).toContain("- 写周报 —— 结论：初稿已发群里（鲍勃（@bob），11-16）");
    expect(text).not.toContain("老任务");
  });

  it("进行中按优先级排序：高在前、低在后，逾期给出天数", () => {
    const text = report({
      tasks: [
        task({ id: "k-low", title: "低优先的活", priority: "low" }),
        task({ id: "k-high", title: "高优先的活", priority: "high", dueAt: "2026-11-16T09:00:00.000Z" }),
        task({ id: "k-mid", title: "普通活" }),
      ],
    });
    const high = text.indexOf("高优先的活");
    const mid = text.indexOf("普通活");
    const low = text.indexOf("低优先的活");
    expect(high).toBeGreaterThan(-1);
    expect(high).toBeLessThan(mid);
    expect(mid).toBeLessThan(low);
    expect(text).toContain("【高】高优先的活");
    expect(text).toContain("（已逾期 2 天）");
  });

  it("进行中超过 8 条时收口提示，不把台账全抄进来", () => {
    const tasks = Array.from({ length: 12 }, (_, i) =>
      task({ id: `k${i}`, title: `任务${i + 1}` }),
    );
    const text = report({ tasks });
    expect(text).toContain("还有 4 项没列出来");
  });
});

describe("周报里的需要关注（d.269）", () => {
  it("四类风险各自成段，有事实就点名", () => {
    const text = report({
      tasks: [
        task({ id: "k1", title: "逾期的活", dueAt: "2026-11-16T09:00:00.000Z" }),
        task({ id: "k2", title: "没人领的活", assigneeId: null }),
        task({ id: "k3", title: "被挡住的活", blockedBy: ["k4"] }),
        task({
          id: "k4",
          title: "前置没做",
          status: "todo",
          assigneeId: ME.id,
        }),
        task({
          id: "k5",
          title: "催过没动的活",
          nudgedAt: "2026-11-17T09:00:00.000Z",
          nudgedBy: ME.id,
          nudgeCount: 2,
        }),
      ],
    });
    expect(text).toContain("- 逾期的活 · 鲍勃（@bob） · 截止 11-16（已逾期 2 天）");
    expect(text).toContain("- 没人领的活（创建于 11-10）");
    expect(text).toContain("- 被挡住的活 被「前置没做」挡住");
    expect(text).toContain("- 催过没动的活 · 鲍勃（@bob） · 组长催过 2 次（最近 11-17）");
  });

  it("没有异常时四段都写「没有…」而不是留空", () => {
    const text = report({
      tasks: [
        task({
          id: "k1",
          title: "已完成",
          status: "done",
          completedAt: "2026-11-16T09:00:00.000Z",
          completedBy: BOB.id,
        }),
      ],
    });
    expect(text).toContain("没有逾期任务。");
    expect(text).toContain("没有待认领的任务。");
    expect(text).toContain("没有被前置挡住的任务。");
    expect(text).toContain("没有被催过还没动的任务。");
  });
});

describe("成员负荷与下周建议（d.269）", () => {
  it("按成员统计未完成与其中逾期", () => {
    const text = report({
      tasks: [
        task({ id: "k1", assigneeId: BOB.id, dueAt: "2026-11-16T09:00:00.000Z" }),
        task({ id: "k2", assigneeId: BOB.id }),
        task({ id: "k3", assigneeId: ME.id }),
      ],
    });
    expect(text).toContain("| 阿鸣（@admin） | 1 | 0 |");
    expect(text).toContain("| 鲍勃（@bob） | 2 | 1 |");
  });

  it("建议随事实变化：有逾期先说清逾期，全清则保持节奏", () => {
    const withRisk = report({
      tasks: [task({ id: "k1", dueAt: "2026-11-16T09:00:00.000Z" })],
    });
    expect(withRisk).toContain("先把 1 项逾期的收尾或改期");

    const allDone = report({
      tasks: [
        task({
          id: "k1",
          status: "done",
          completedAt: "2026-11-16T09:00:00.000Z",
          completedBy: BOB.id,
        }),
      ],
    });
    expect(allDone).toContain("这一周没有异常，保持节奏。");
  });
});

describe("周报数出待验收的活（d.275）", () => {
  it("待验收单独成段，带负责人的结论，且已验收的不列", () => {
    const text = weeklyReportMarkdown(
      snapshot({
        tasks: [
          task({ id: "k1", status: "done", reviewState: "pending", result: "初版文档已交付" }),
          task({ id: "k2", status: "done", reviewState: "approved", result: "这版通过了" }),
        ],
      }),
      { now: NOW, days: 7, memberName: (id: string) => (id === ME.id ? "我（@admin）" : "鲍勃（@bob）") },
    );
    expect(text).toContain("**待验收**");
    expect(text).toContain("初版文档已交付");
    expect(text).not.toContain("这版通过了");
  });
});

describe("周报文件名（d.269）", () => {
  it("去掉非法字符与空格，带上日期", () => {
    expect(weeklyReportFileName("增长/小组: A", Date.parse("2026-11-18T02:00:00.000Z"))).toBe(
      "团队周报-增长-小组-A-20261118.md",
    );
  });

  it("名字全被清空时回退成 team，不至于生成 `团队周报--日期.md`", () => {
    expect(weeklyReportFileName("///", Date.parse("2026-11-18T02:00:00.000Z"))).toBe(
      "团队周报-team-20261118.md",
    );
  });
});
