import { describe, expect, it } from "vitest";
import { activitySummaryLabel } from "./labels.js";

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
