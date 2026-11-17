import { describe, expect, it } from "vitest";

import {
  MY_TASK_BADGE_MAX,
  myTaskBadgeText,
  myTaskButtonLabel,
  summarizeMyTasks,
} from "./myTaskBadge.js";

describe("我的任务角标（d.263）", () => {
  it("两个列表都空：总数为 0、没有文字、按钮名字保持原样", () => {
    const badge = summarizeMyTasks([], []);
    expect(badge).toEqual({ assigned: 0, claimable: 0, total: 0 });
    expect(myTaskBadgeText(badge)).toBe("");
    expect(myTaskButtonLabel(badge)).toBe("我的任务");
    expect(myTaskButtonLabel(null)).toBe("我的任务");
  });

  it("只有派到名下的：说「几项待办」", () => {
    const badge = summarizeMyTasks([{}, {}, {}], []);
    expect(badge.total).toBe(3);
    expect(myTaskBadgeText(badge)).toBe("3 项待办");
    expect(myTaskButtonLabel(badge)).toBe("我的任务：3 项待办");
  });

  it("只有待认领的：说「几项可接」，不混成待办", () => {
    const badge = summarizeMyTasks([], [{}, {}]);
    expect(myTaskBadgeText(badge)).toBe("2 项可接");
    expect(myTaskButtonLabel(badge)).toBe("我的任务：2 项可接");
  });

  it("两类都有：分开数、用 · 连接", () => {
    const badge = summarizeMyTasks([{}, {}, {}], [{}, {}]);
    expect(badge).toEqual({ assigned: 3, claimable: 2, total: 5 });
    expect(myTaskBadgeText(badge)).toBe("3 项待办 · 2 项可接");
  });

  it("超过上限只显示 99+：角标是提示，精确数字在面板里", () => {
    const many = Array.from({ length: MY_TASK_BADGE_MAX + 5 }, () => ({}));
    const badge = summarizeMyTasks(many, []);
    expect(badge.total).toBe(MY_TASK_BADGE_MAX + 5);
    expect(myTaskBadgeText(badge)).toBe(`${MY_TASK_BADGE_MAX}+ 项待办`);
  });
});
