import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  TURN_PROGRESS_MAX_ROUND,
  clearTurnProgress,
  describeTurnProgress,
  formatElapsed,
  formatSeconds,
  getTurnProgress,
  noteTurnFirstToken,
  recordTurnProgress,
  resetTurnProgress,
  settleTurnProgress,
  subscribeTurnProgress,
  type TurnProgress,
} from "./turnProgress.js";

const BASE = Date.now();

/** 拼一条完整进度（新增字段都有默认值，用例只写自己关心的那几项）。 */
function make(overrides: Partial<TurnProgress> = {}): TurnProgress {
  return {
    round: 1,
    phase: "round",
    tool: null,
    at: BASE,
    startedAt: BASE,
    tools: 0,
    done: false,
    endedAt: null,
    // d.354 的新字段：没正文时是 null / 0，用例只在关心时覆盖。
    firstTokenAt: null,
    chars: 0,
    ...overrides,
  };
}

// 每个用例从干净的进度表开始：这张表是模块级内存，不清会让上一条用例的痕迹串过来。
beforeEach(() => {
  resetTurnProgress();
});

describe("主对话进度（d.214）", () => {
  it("记一条就查得到，字段原样保留", () => {
    recordTurnProgress("c1", { round: 3, phase: "tool", tool: "file_grep" }, BASE);
    expect(getTurnProgress("c1")).toEqual(make({ round: 3, phase: "tool", tool: "file_grep", tools: 1 }));
    expect(getTurnProgress("c2")).toBeNull();
  });

  it("同一会话返回同一个引用（useSyncExternalStore 的前提）", () => {
    recordTurnProgress("c1", { round: 1, phase: "round" }, BASE);
    expect(getTurnProgress("c1")).toBe(getTurnProgress("c1"));
  });

  it("tool 阶段没有工具名就降级成「在思考」，不编工具、也不记次数", () => {
    recordTurnProgress("c1", { round: 2, phase: "tool" }, BASE);
    expect(getTurnProgress("c1")).toEqual(make({ round: 2 }));
    recordTurnProgress("c1", { round: 2, phase: "tool", tool: "   " }, BASE);
    expect(getTurnProgress("c1")?.tool).toBeNull();
    expect(getTurnProgress("c1")?.tools).toBe(0);
  });

  it("脏轮次与空会话 id 都不入账（宁可少显示，不要显示错的）", () => {
    for (const round of [0, -1, TURN_PROGRESS_MAX_ROUND + 1, Number.NaN, Number.POSITIVE_INFINITY]) {
      recordTurnProgress("c1", { round, phase: "round" }, BASE);
    }
    expect(getTurnProgress("c1")).toBeNull();
    recordTurnProgress("", { round: 1, phase: "round" }, BASE);
    expect(getTurnProgress("")).toBeNull();
  });

  it("清除只影响指定会话；不带参数清全部，并且只在真有变化时通知", () => {
    const listener = vi.fn();
    const off = subscribeTurnProgress(listener);
    recordTurnProgress("c1", { round: 1, phase: "round" }, BASE);
    recordTurnProgress("c2", { round: 2, phase: "round" }, BASE);
    expect(listener).toHaveBeenCalledTimes(2);
    listener.mockClear();
    clearTurnProgress("c1");
    expect(getTurnProgress("c1")).toBeNull();
    expect(getTurnProgress("c2")?.round).toBe(2);
    expect(listener).toHaveBeenCalledTimes(1);
    listener.mockClear();
    clearTurnProgress("c1"); // 已经没有了：不该再通知
    expect(listener).not.toHaveBeenCalled();
    clearTurnProgress();
    expect(getTurnProgress("c2")).toBeNull();
    expect(listener).toHaveBeenCalledTimes(1);
    off();
  });

  it("退订之后不再收到通知", () => {
    const listener = vi.fn();
    subscribeTurnProgress(listener)();
    recordTurnProgress("c9", { round: 1, phase: "round" }, BASE);
    expect(listener).not.toHaveBeenCalled();
  });

  it("reset 清干净（含订阅者）", () => {
    const listener = vi.fn();
    subscribeTurnProgress(listener);
    recordTurnProgress("c1", { round: 1, phase: "round" }, BASE);
    listener.mockClear();
    resetTurnProgress();
    expect(getTurnProgress("c1")).toBeNull();
    recordTurnProgress("c1", { round: 2, phase: "round" }, BASE);
    expect(listener).not.toHaveBeenCalled();
  });

  it("文案只说事实：第几步 + 正在执行的工具，或「正在想下一步」", () => {
    expect(describeTurnProgress(make({ round: 3, phase: "tool", tool: "file_grep" }))).toBe(
      "第 3 步 · 正在执行 file_grep",
    );
    expect(describeTurnProgress(make({ round: 1 }))).toBe("第 1 步 · 正在想下一步");
  });

  it("耗时按人话格式化：不足一分钟报秒，超过报「x 分」/「x 分 y 秒」", () => {
    expect(formatElapsed(0)).toBe("0 秒");
    expect(formatElapsed(42_000)).toBe("42 秒");
    expect(formatElapsed(-500)).toBe("0 秒");
    expect(formatElapsed(60_000)).toBe("1 分");
    expect(formatElapsed(95_000)).toBe("1 分 35 秒");
    expect(formatElapsed(3_600_000)).toBe("60 分");
  });
});

describe("收口后留下小结（d.218）", () => {
  it("工具调用按真实次数累加，不是按轮次猜", () => {
    recordTurnProgress("c1", { round: 1, phase: "round" }, BASE);
    recordTurnProgress("c1", { round: 1, phase: "tool", tool: "file_read" }, BASE + 1_000);
    recordTurnProgress("c1", { round: 1, phase: "tool", tool: "file_read" }, BASE + 2_000);
    recordTurnProgress("c1", { round: 2, phase: "tool", tool: "run_command" }, BASE + 3_000);
    const state = getTurnProgress("c1");
    expect(state?.tools).toBe(3);
    expect(state?.round).toBe(2);
    // 第一次上报的时刻就是起点，后面的上报不重置它
    expect(state?.startedAt).toBe(BASE);
  });

  it("收口后不再说「正在执行」，改成「上一轮：几步 · 用时多少」", () => {
    recordTurnProgress("c1", { round: 1, phase: "round" }, BASE);
    recordTurnProgress("c1", { round: 3, phase: "tool", tool: "file_grep" }, BASE + 60_000);
    settleTurnProgress("c1", BASE + 72_000);
    const settled = getTurnProgress("c1");
    expect(settled?.done).toBe(true);
    expect(settled?.endedAt).toBe(BASE + 72_000);
    expect(settled?.phase).toBe("round");
    expect(settled?.tool).toBeNull();
    expect(settled?.tools).toBe(1);
    expect(describeTurnProgress(settled as TurnProgress)).toBe("上一轮：1 步 · 用时 1 分 12 秒");
  });

  it("一个工具都没用过就不写「0 步」（宁可不提，不要拉长）", () => {
    recordTurnProgress("c1", { round: 1, phase: "round" }, BASE);
    settleTurnProgress("c1", BASE + 30_000);
    expect(describeTurnProgress(getTurnProgress("c1") as TurnProgress)).toBe("上一轮：用时 30 秒");
  });

  it("收口后再来进度 = 新一轮：计时与次数重新起算，不会累加到上一轮头上", () => {
    recordTurnProgress("c1", { round: 1, phase: "tool", tool: "file_read" }, BASE);
    settleTurnProgress("c1", BASE + 10_000);
    recordTurnProgress("c1", { round: 1, phase: "round" }, BASE + 20_000);
    const fresh = getTurnProgress("c1");
    expect(fresh?.done).toBe(false);
    expect(fresh?.endedAt).toBeNull();
    expect(fresh?.tools).toBe(0);
    expect(fresh?.startedAt).toBe(BASE + 20_000);
  });

  it("重复收口只通知一次（恢复提示条重渲染时不重复）", () => {
    const listener = vi.fn();
    recordTurnProgress("c1", { round: 1, phase: "round" }, BASE);
    const off = subscribeTurnProgress(listener);
    settleTurnProgress("c1", BASE + 1_000);
    expect(listener).toHaveBeenCalledTimes(1);
    listener.mockClear();
    settleTurnProgress("c1", BASE + 2_000);
    expect(listener).not.toHaveBeenCalled();
    expect(getTurnProgress("c1")?.endedAt).toBe(BASE + 1_000);
    off();
  });

  it("没上报过进度的会话收口不造一条假的「0 轮」出来", () => {
    settleTurnProgress("c2", BASE);
    expect(getTurnProgress("c2")).toBeNull();
    settleTurnProgress("", BASE);
    expect(getTurnProgress("")).toBeNull();
  });
});

/** d.354：TTFT（首字延迟）与出字速度。 */
describe("首字与出字速度（d.354）", () => {
  it("收口时把首字延迟与字/秒一起写进小结", () => {
    const text = describeTurnProgress(
      make({
        tools: 2,
        firstTokenAt: BASE + 1_200,
        chars: 410,
        endedAt: BASE + 12_000,
        done: true,
      }),
    );
    // 用时 12 秒、首字 1.2 秒、正文段 10.8 秒里出了 410 字 → 约 38 字/秒。
    expect(text).toBe("上一轮：2 步 · 用时 12 秒 · 首字 1.2 秒 · 38 字/秒");
  });

  it("没有正文（纯工具轮）就不编「首字 0 秒」「0 字/秒」", () => {
    const text = describeTurnProgress(make({ tools: 3, endedAt: BASE + 9_000, done: true }));
    expect(text).toBe("上一轮：3 步 · 用时 9 秒");
    expect(text).not.toContain("首字");
    expect(text).not.toContain("字/秒");
  });

  it("正文太短（不足 0.5 秒）时不出「字/秒」——那个数字没有意义", () => {
    const text = describeTurnProgress(
      make({ firstTokenAt: BASE + 400, chars: 12, endedAt: BASE + 700, done: true }),
    );
    expect(text).toContain("首字 0.4 秒");
    expect(text).not.toContain("字/秒");
  });

  it("首字时刻只记第一次；收口之后不再改", () => {
    recordTurnProgress("c1", { round: 1, phase: "round" }, BASE);
    noteTurnFirstToken("c1", BASE + 900);
    noteTurnFirstToken("c1", BASE + 5_000);
    expect(getTurnProgress("c1")?.firstTokenAt).toBe(BASE + 900);
    settleTurnProgress("c1", BASE + 6_000, 300);
    noteTurnFirstToken("c1", BASE + 7_000);
    expect(getTurnProgress("c1")?.firstTokenAt).toBe(BASE + 900);
  });

  it("没有进度条目的会话不凭空记首字", () => {
    noteTurnFirstToken("nobody", BASE);
    expect(getTurnProgress("nobody")).toBeNull();
  });

  it("收口时字符数取最大、负数与小数夹成非负整数", () => {
    recordTurnProgress("c1", { round: 1, phase: "round" }, BASE);
    settleTurnProgress("c1", BASE + 1_000, -20);
    expect(getTurnProgress("c1")?.chars).toBe(0);

    recordTurnProgress("c2", { round: 1, phase: "round" }, BASE);
    settleTurnProgress("c2", BASE + 1_000, 12.7);
    expect(getTurnProgress("c2")?.chars).toBe(12);
  });

  it("formatSeconds 超过 10 秒取整，否则保留一位小数", () => {
    expect(formatSeconds(1_240)).toBe("1.2 秒");
    expect(formatSeconds(12_400)).toBe("12 秒");
    expect(formatSeconds(-5)).toBe("0.0 秒");
  });
});
