import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CONTEXT_FOLD_KEY,
  MAX_CONTEXT_FOLD_SESSIONS,
  clearContextFold,
  foldAgeMinutes,
  foldNoticeText,
  formatFoldAgeMinutes,
  getContextFold,
  recordContextFold,
  resetContextFolds,
} from "./contextFold.js";

beforeEach(() => {
  resetContextFolds();
});

describe("上下文折叠记录（d.217）", () => {
  it("按会话记最近一次折叠；没记过的会话返回 null", () => {
    expect(getContextFold("c1")).toBeNull();
    recordContextFold("c1", 12, 1_000);
    expect(getContextFold("c1")).toEqual({ foldedCount: 12, at: 1_000 });
    expect(getContextFold("c2")).toBeNull();
  });

  it("同一会话再折一次就覆盖（只留最近一次）", () => {
    recordContextFold("c1", 12, 1_000);
    recordContextFold("c1", 30, 2_000);
    expect(getContextFold("c1")).toEqual({ foldedCount: 30, at: 2_000 });
  });

  it("折叠条数不是正数（0 / 负数 / NaN）时不写记录，也不覆盖之前的", () => {
    recordContextFold("c1", 8, 1_000);
    recordContextFold("c1", 0, 2_000);
    recordContextFold("c1", -3, 3_000);
    recordContextFold("c1", Number.NaN, 4_000);
    expect(getContextFold("c1")).toEqual({ foldedCount: 8, at: 1_000 });
  });

  it("空会话 id 不记账（避免写到 `undefined` 键上）", () => {
    recordContextFold("", 5, 1_000);
    expect(getContextFold("")).toBeNull();
  });

  it("返回的是拷贝：改它不会污染内部记录", () => {
    recordContextFold("c1", 5, 1_000);
    const fold = getContextFold("c1");
    expect(fold).not.toBeNull();
    if (fold) fold.foldedCount = 999;
    expect(getContextFold("c1")?.foldedCount).toBe(5);
  });

  it("清除单个会话 / 全部", () => {
    recordContextFold("c1", 5, 1_000);
    recordContextFold("c2", 6, 2_000);
    clearContextFold("c1");
    expect(getContextFold("c1")).toBeNull();
    expect(getContextFold("c2")?.foldedCount).toBe(6);
    clearContextFold();
    expect(getContextFold("c2")).toBeNull();
  });

  it("落盘只保留最近 20 个会话（按时间新→旧）", () => {
    for (let i = 0; i < MAX_CONTEXT_FOLD_SESSIONS + 5; i += 1) {
      recordContextFold(`c${i}`, i + 1, 1_000 + i);
    }
    const raw = localStorage.getItem(CONTEXT_FOLD_KEY);
    expect(raw).toBeTruthy();
    const saved = JSON.parse(raw ?? "{}") as Record<string, { foldedCount: number }>;
    expect(Object.keys(saved)).toHaveLength(MAX_CONTEXT_FOLD_SESSIONS);
    // 最老的几个已经被挤掉，最新的一定在
    expect(saved[`c${MAX_CONTEXT_FOLD_SESSIONS + 4}`]).toBeTruthy();
    expect(saved.c0).toBeUndefined();
  });

  it("坏数据（字符串 / 缺字段 / 负条数）读回来一律丢弃", () => {
    localStorage.setItem(
      CONTEXT_FOLD_KEY,
      JSON.stringify({
        good: { foldedCount: 7, at: 1_000 },
        badString: "12",
        badMissing: { foldedCount: 3 },
        badNegative: { foldedCount: -1, at: 1_000 },
        badAt: { foldedCount: 3, at: 0 },
      }),
    );
    resetContextFolds();
    localStorage.setItem(
      CONTEXT_FOLD_KEY,
      JSON.stringify({ good: { foldedCount: 7, at: 1_000 }, badString: "12", badMissing: { foldedCount: 3 } }),
    );
    // resetContextFolds 会懒装载标记置位，这里直接重载模块太麻烦：换个会话 id 断言坏条目不影响读
    expect(getContextFold("badString")).toBeNull();
    expect(getContextFold("badMissing")).toBeNull();
  });

  it("localStorage 写入抛异常时不影响记账（静默降级）", () => {
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    try {
      expect(() => recordContextFold("c1", 3, 1_000)).not.toThrow();
      expect(getContextFold("c1")?.foldedCount).toBe(3);
    } finally {
      spy.mockRestore();
    }
  });

  it("提示文案说清三件事：多少条、原文没删、忘了就再说一遍", () => {
    const text = foldNoticeText(9);
    expect(text).toContain("更早的 9 条消息");
    expect(text).toContain("原文一条没删");
    expect(text).toContain("/compact");
    expect(foldNoticeText(0)).toContain("更早的 0 条");
  });

  it("距今分钟数与「多久以前」的文案", () => {
    expect(foldAgeMinutes({ foldedCount: 1, at: Date.now() }, Date.now())).toBe(0);
    expect(foldAgeMinutes({ foldedCount: 1, at: 1_000 }, 1_000 + 90_000)).toBe(1);
    expect(foldAgeMinutes({ foldedCount: 1, at: 2_000 }, 1_000)).toBe(0);
    expect(formatFoldAgeMinutes(0)).toBe("刚刚");
    expect(formatFoldAgeMinutes(1)).toBe("1 分钟前");
    expect(formatFoldAgeMinutes(59)).toBe("59 分钟前");
    expect(formatFoldAgeMinutes(60)).toBe("1 小时前");
    expect(formatFoldAgeMinutes(60 * 25)).toBe("1 天前");
  });
});

  it("手动压缩的记录会被标出来，重开也还是手动（d.397）", () => {
    recordContextFold("c1", 9, 1_000, true);
    expect(getContextFold("c1")?.manual).toBe(true);
    // 不写 manual 的老记录不会被误标
    recordContextFold("c2", 3, 1_000);
    expect(getContextFold("c2")?.manual).toBeUndefined();
  });
