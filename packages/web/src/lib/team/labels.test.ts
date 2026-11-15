import { describe, expect, it } from "vitest";
import { activitySummaryLabel, activitySummaryLine, activityTitle } from "./labels.js";
import { TASK_ACTIVITY_TITLE } from "./share.js";

describe("团队摘要标签：只由 kind + status 派生", () => {
  it("任务按状态给出中文标签", () => {
    expect(activitySummaryLabel({ kind: "task", status: "running" })).toBe("任务 · 进行中");
    expect(activitySummaryLabel({ kind: "task", status: "done" })).toBe("任务 · 已完成");
    expect(activitySummaryLabel({ kind: "task", status: "failed" })).toBe("任务 · 失败");
    expect(activitySummaryLabel({ kind: "task", status: "cancelled" })).toBe("任务 · 已中断");
  });

  it("日程按到期档位给出中文标签", () => {
    expect(activitySummaryLabel({ kind: "agenda", status: "overdue" })).toBe("日程 · 已逾期");
    expect(activitySummaryLabel({ kind: "agenda", status: "today" })).toBe("日程 · 今天到期");
    expect(activitySummaryLabel({ kind: "agenda", status: "next24h" })).toBe(
      "日程 · 24 小时内到期",
    );
  });

  it("未知状态/非人成员类不显示（不回显任何自由文本）", () => {
    expect(activitySummaryLabel({ kind: "task", status: "这是什么正文" })).toBe("");
    expect(activitySummaryLabel({ kind: "agenda", status: undefined })).toBe("");
    expect(activitySummaryLabel({ kind: "agent", status: "done" })).toBe("");
    expect(activitySummaryLabel({ kind: "staff", status: "done" })).toBe("");
    expect(activitySummaryLabel({ kind: "join", status: "done" })).toBe("");
  });
});

describe("动向标题列：任务类不回显 title（隐私红线）", () => {
  it("任务类的历史标题（提问首行）一律不上屏，只显示状态摘要", () => {
    const legacy = { kind: "task" as const, status: "done", title: "整理会议纪要并抄送全员" };
    expect(activityTitle(legacy)).toBe("任务 · 已完成");
    expect(activityTitle(legacy)).not.toContain("整理会议纪要");
  });

  it("状态认不出的老行退化成固定的「任务」占位词，也不回显 title", () => {
    const odd = { kind: "task" as const, status: "weird", title: "把银行卡号发群里" };
    expect(activityTitle(odd)).toBe(TASK_ACTIVITY_TITLE);
    expect(activityTitle({ kind: "task" as const, status: undefined, title: "提示词首行" })).toBe(
      TASK_ACTIVITY_TITLE,
    );
  });

  it("其它 kind 正常显示自己的 title", () => {
    expect(activityTitle({ kind: "agenda", status: "today", title: "周五交材料" })).toBe(
      "周五交材料",
    );
  });

  it("第二行摘要与标题重复时不再重复画（任务类标题已是摘要）", () => {
    const task = { kind: "task" as const, status: "done", title: "任务" };
    expect(activitySummaryLine(task)).toBe("");
    const agenda = { kind: "agenda" as const, status: "today", title: "周五交材料" };
    expect(activitySummaryLine(agenda)).toBe("日程 · 今天到期");
  });
});
