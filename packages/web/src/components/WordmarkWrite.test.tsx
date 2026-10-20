import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act } from "@testing-library/react";
import {
  WordmarkWrite,
  buildWriteSchedule,
  strokeProgress,
  WRITE_DRAW_MS,
  WRITE_HOLD_MS,
  WRITE_FADE_MS,
  WRITE_TOTAL_MS,
} from "./WordmarkWrite.js";
import { WORDMARK_STROKES } from "./wordmarkGlyphs.js";

const LETTERS = WORDMARK_STROKES.map((s) => s.letter);

/** jsdom 没有 SVG 几何实现：getTotalLength 恒返回 0 会让运笔进度算不出来，这里给个固定长度。 */
function stubPathLength(len = 100): void {
  const w = window as unknown as { SVGElement: { prototype: Record<string, unknown> } };
  w.SVGElement.prototype.getTotalLength = () => len;
}

function useFakeTimers(): void {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame", "Date", "performance"],
  });
}

describe("buildWriteSchedule", () => {
  it("按长度分配运笔时间：两笔等长时各占一半（无抬手）", () => {
    const s = buildWriteSchedule([50, 50], ["a", "a"], 1000, 100);
    expect(s[0].start).toBe(0);
    expect(s[0].end).toBeCloseTo(500, 5);
    expect(s[1].start).toBeCloseTo(500, 5);
    expect(s[1].end).toBeCloseTo(1000, 5);
  });

  it("按长度分配运笔时间：长度比 3:1 时时间比也是 3:1", () => {
    const s = buildWriteSchedule([75, 25], ["a", "a"], 1000, 100);
    expect(s[0].end - s[0].start).toBeCloseTo(750, 5);
    expect(s[1].end - s[1].start).toBeCloseTo(250, 5);
  });

  it("字母切换处插入抬手间隔，总运笔时间扣掉抬手后分配", () => {
    const s = buildWriteSchedule([50, 50], ["a", "b"], 1000, 100);
    // 抬手 100ms 占用总时长，剩 900 按等长各 450
    expect(s[1].start).toBeCloseTo(100 + 450, 5);
    expect(s[0].end - s[0].start).toBeCloseTo(450, 5);
    expect(s[1].end).toBeCloseTo(1000, 5);
  });

  it("同一字母内的多笔之间不插抬手", () => {
    const s = buildWriteSchedule([10, 10], ["H", "H"], 1000, 500);
    expect(s[1].start).toBeCloseTo(500, 5);
  });

  it("长度全为 0 时不除零、时间仍走完", () => {
    const s = buildWriteSchedule([0, 0], ["a", "a"], 1000, 100);
    expect(Number.isFinite(s[0].end)).toBe(true);
    expect(s[1].end).toBeCloseTo(1000, 5);
  });
});

describe("strokeProgress", () => {
  const timing = { start: 100, end: 300, len: 10 };

  it("开始前为 0、结束后为 1、中间线性", () => {
    expect(strokeProgress(0, timing)).toBe(0);
    expect(strokeProgress(100, timing)).toBe(0);
    expect(strokeProgress(200, timing)).toBeCloseTo(0.5, 6);
    expect(strokeProgress(300, timing)).toBe(1);
    expect(strokeProgress(999, timing)).toBe(1);
  });
});

describe("WordmarkWrite", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    stubPathLength();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("渲染 10 笔字形，初始全部未描出（dashoffset = 全长）", () => {
    useFakeTimers();
    const { container } = render(<WordmarkWrite onDone={() => {}} />);
    const paths = Array.from(container.querySelectorAll("path"));
    expect(paths).toHaveLength(WORDMARK_STROKES.length);
    // 首帧前 offset 尚未写入（等于全长即「没画」）
    expect(paths[0].style.strokeDasharray === "" || Number(paths[0].style.strokeDashoffset) === 100).toBe(true);
  });

  it("逐帧推进：中途 offset 介于 0 与全长之间，运笔结束时归零", () => {
    useFakeTimers();
    const { container } = render(<WordmarkWrite onDone={() => {}} />);
    const paths = Array.from(container.querySelectorAll("path"));

    act(() => {
      // +7ms 避开「每笔恰好等长、帧时刻正落在笔画边界」的巧合（那时所有笔非 0 即满）
      vi.advanceTimersByTime(WRITE_DRAW_MS / 2 + 7);
    });
    const mid = paths.map((p) => Number(p.style.strokeDashoffset));
    // 手写进行中：已有笔写完（0），也还有笔没轮到（全长）——说明是「逐笔」而不是一次全亮
    expect(mid.some((v) => v === 0)).toBe(true);
    expect(mid.some((v) => v === 100)).toBe(true);

    act(() => {
      vi.advanceTimersByTime(WRITE_DRAW_MS);
    });
    for (const p of paths) expect(Number(p.style.strokeDashoffset)).toBe(0);
  });

  it("写完停顿后淡出，整段结束回调 onDone 恰好 1 次", () => {
    useFakeTimers();
    const onDone = vi.fn();
    const { container } = render(<WordmarkWrite onDone={onDone} />);

    // 余量 200ms：rAF 以 ~16ms 为一帧，收尾时刻会比 WRITE_DRAW_MS 晚一两帧
    act(() => {
      vi.advanceTimersByTime(WRITE_DRAW_MS + WRITE_HOLD_MS + 200);
    });
    expect(container.querySelector(".wordmark-write")?.className).toContain("fading");
    expect(onDone).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(WRITE_FADE_MS + 100);
    });
    expect(onDone).toHaveBeenCalledTimes(1);

    // 再推进也不会重复回调
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("总时长 = 运笔 + 停顿 + 淡出（与 splash 的 WRITE_MS 同量级）", () => {
    expect(WRITE_TOTAL_MS).toBe(WRITE_DRAW_MS + WRITE_HOLD_MS + WRITE_FADE_MS);
    expect(LETTERS.slice(0, 3)).toEqual(["H", "H", "H"]); // 字形数据顺序未变
  });
});
