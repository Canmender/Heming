import { beforeEach, describe, expect, it } from "vitest";
import { MAX_TOOL_ROUNDS } from "../agentStream.js";
import { resetTodoStore, setTodos } from "../todo/store.js";
import {
  LONG_TASK_MAX_ROUNDS,
  LONG_TASK_MAX_SEGMENTS,
  LONG_TASK_ROUNDS_PER_SEGMENT,
  longTaskLimitNotice,
  longTaskNotice,
  longTaskVerdict,
  unfinishedTodoCount,
} from "./longTask.js";

/**
 * 长任务续跑的判据是「宁可停也不无限跑」，所以每个「不续」的理由都要单独钉住：
 * 少一条，将来改条件时就可能把「没有未完成项」也续上——那会凭空拉长每一轮对话。
 */
describe("longTaskVerdict", () => {
  it("每段轮数与 agentStream 的上限必须一致（写死两份常量，靠这条防漂移）", () => {
    expect(LONG_TASK_ROUNDS_PER_SEGMENT).toBe(MAX_TOOL_ROUNDS);
    expect(LONG_TASK_MAX_ROUNDS).toBe(MAX_TOOL_ROUNDS * LONG_TASK_MAX_SEGMENTS);
  });

  it("不在段边界不续（第 5 轮还轮不到判定）", () => {
    expect(longTaskVerdict({ roundsDone: 5, unfinished: 3 })).toEqual({
      continue: false,
      reason: "not-boundary",
    });
  });

  it("到段边界且清单有未完成项 → 续跑，并在每段边界都成立（12 / 24）", () => {
    expect(longTaskVerdict({ roundsDone: 12, unfinished: 1 }).continue).toBe(true);
    expect(longTaskVerdict({ roundsDone: 24, unfinished: 2 }).continue).toBe(true);
  });

  it("清单全完成 → 不续（模型自己说做完了，就不该再替它跑）", () => {
    expect(longTaskVerdict({ roundsDone: 12, unfinished: 0 })).toEqual({
      continue: false,
      reason: "no-unfinished",
    });
  });

  it("用户中断优先于清单：中断后绝不续跑", () => {
    expect(longTaskVerdict({ roundsDone: 12, unfinished: 5, aborted: true })).toEqual({
      continue: false,
      reason: "aborted",
    });
  });

  it("到总量上限（36 轮）→ 不续，哪怕清单还有活", () => {
    expect(longTaskVerdict({ roundsDone: LONG_TASK_MAX_ROUNDS, unfinished: 9 })).toEqual({
      continue: false,
      reason: "limit",
    });
  });

  it("负轮次/小数轮次按 0 处理，不误判成边界", () => {
    expect(longTaskVerdict({ roundsDone: -12, unfinished: 1 }).continue).toBe(false);
    expect(longTaskVerdict({ roundsDone: 11.9, unfinished: 1 }).continue).toBe(false);
  });
});

describe("unfinishedTodoCount", () => {
  beforeEach(() => {
    resetTodoStore();
    localStorage.clear();
  });

  it("只数 pending / in_progress，完成的与别人的清单都不算", () => {
    setTodos("c1", [
      { content: "读配置", status: "completed" },
      { content: "改实现", status: "in_progress" },
      { content: "跑测试", status: "pending" },
    ]);
    expect(unfinishedTodoCount("c1")).toBe(2);
    expect(unfinishedTodoCount("c2")).toBe(0);
  });

  it("没有会话 id（未分组/脏数据）返回 0 —— 判据不明时不续", () => {
    expect(unfinishedTodoCount(undefined)).toBe(0);
    expect(unfinishedTodoCount("")).toBe(0);
    expect(unfinishedTodoCount("   ")).toBe(0);
  });
});

describe("续跑提示文案", () => {
  it("第 1 段后告诉用户还剩几段，且不要求用户再敲「继续」", () => {
    const text = longTaskNotice(12);
    expect(text).toContain("自动接着做");
    expect(text).toContain("12 轮");
    expect(text).toContain("再做 2 段");
    expect(text).not.toContain("回复「继续」");
  });

  it("最后一段后续跑时剩余段数为 0 也说得清楚（24 轮 → 再做 1 段）", () => {
    expect(longTaskNotice(24)).toContain("再做 1 段");
  });

  it("到顶文案给的是总量 36 轮，而不是单段 12 轮", () => {
    const text = longTaskLimitNotice();
    expect(text).toContain("36 轮");
    expect(text).toContain("3 段");
    expect(text).toContain("回复「继续」");
  });
});
