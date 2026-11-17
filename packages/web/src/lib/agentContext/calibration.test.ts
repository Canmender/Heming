import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CONTEXT_CALIBRATION_KEY,
  MAX_CALIBRATION_ENTRIES,
  MIN_SAMPLE_ESTIMATE,
  RATIO_MAX,
  RATIO_MIN,
  calibrateEstimate,
  contextCalibrationRatio,
  listContextCalibration,
  recordContextSample,
  resetContextCalibration,
} from "./calibration.js";

beforeEach(() => {
  resetContextCalibration();
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("上下文估算校准（d.215）", () => {
  it("没有样本时倍率是 1，校准函数原样返回", () => {
    expect(contextCalibrationRatio("deepseek-chat")).toBe(1);
    expect(calibrateEstimate(12345, "deepseek-chat")).toBe(12345);
  });

  it("估算太小不采样：工具 schema 的固定开销会被摊成假倍率", () => {
    expect(recordContextSample({ model: "m", estimated: MIN_SAMPLE_ESTIMATE - 1, actual: 5000 })).toBeNull();
    expect(contextCalibrationRatio("m")).toBe(1);
  });

  it("实际值不是正数、或模型名为空时也不采样", () => {
    expect(recordContextSample({ model: "m", estimated: 10_000, actual: 0 })).toBeNull();
    expect(recordContextSample({ model: "m", estimated: 10_000, actual: -1 })).toBeNull();
    expect(recordContextSample({ model: "m", estimated: 10_000, actual: Number.NaN })).toBeNull();
    expect(recordContextSample({ model: "  ", estimated: 10_000, actual: 12_000 })).toBeNull();
    expect(contextCalibrationRatio("m")).toBe(1);
  });

  it("第一条样本直接成为倍率，并立刻作用到显示值", () => {
    const ratio = recordContextSample({ model: "deepseek-chat", estimated: 10_000, actual: 15_000 });
    expect(ratio).toBe(1.5);
    expect(contextCalibrationRatio("deepseek-chat")).toBe(1.5);
    expect(calibrateEstimate(10_000, "deepseek-chat")).toBe(15_000);
  });

  it("离谱样本被夹在上下限之间", () => {
    recordContextSample({ model: "high", estimated: 10_000, actual: 100_000 });
    expect(contextCalibrationRatio("high")).toBe(RATIO_MAX);
    recordContextSample({ model: "low", estimated: 10_000, actual: 1_000 });
    expect(contextCalibrationRatio("low")).toBe(RATIO_MIN);
  });

  it("后续样本只占一半权重：单个异常值不会立刻改写口径", () => {
    recordContextSample({ model: "m", estimated: 10_000, actual: 14_000 });
    expect(contextCalibrationRatio("m")).toBeCloseTo(1.4, 5);
    // 第二条完全对得上（比例 1），平滑后应落在中间
    recordContextSample({ model: "m", estimated: 10_000, actual: 10_000 });
    expect(contextCalibrationRatio("m")).toBeCloseTo(1.2, 5);
  });

  it("按模型分别记账，模型名大小写与空白不产生两条账", () => {
    recordContextSample({ model: "DeepSeek-Chat ", estimated: 10_000, actual: 12_000 });
    recordContextSample({ model: "other-model", estimated: 10_000, actual: 9_000 });
    expect(contextCalibrationRatio("deepseek-chat")).toBeCloseTo(1.2, 5);
    expect(contextCalibrationRatio("OTHER-MODEL")).toBeCloseTo(0.9, 5);
    expect(contextCalibrationRatio("never-seen")).toBe(1);
  });

  it("倍率写进 localStorage，重新加载模块后仍然生效", async () => {
    recordContextSample({ model: "m", estimated: 10_000, actual: 13_000 });
    const raw = localStorage.getItem(CONTEXT_CALIBRATION_KEY);
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(String(raw)) as Record<string, { ratio: number; samples: number }>;
    expect(parsed.m?.ratio).toBeCloseTo(1.3, 5);
    expect(parsed.m?.samples).toBe(1);

    vi.resetModules();
    const fresh = await import("./calibration.js");
    expect(fresh.contextCalibrationRatio("m")).toBeCloseTo(1.3, 5);
    fresh.resetContextCalibration();
  });

  it("坏数据一律当没有（字符串 / 缺字段 / ratio 为 0 / samples 非整数）", () => {
    localStorage.setItem(
      CONTEXT_CALIBRATION_KEY,
      JSON.stringify({
        a: "skip",
        b: { ratio: 1.2 },
        c: { ratio: 0, samples: 1, updatedAt: 1 },
        d: { ratio: 1.2, samples: 1.5, updatedAt: 1 },
        ok: { ratio: 1.4, samples: 3, updatedAt: Date.now() },
      }),
    );
    vi.resetModules();
    return import("./calibration.js").then((fresh) => {
      expect(fresh.listContextCalibration().map((item) => item.model)).toEqual(["ok"]);
      expect(fresh.contextCalibrationRatio("ok")).toBeCloseTo(1.4, 5);
      fresh.resetContextCalibration();
    });
  });

  it("写不进去（配额/隐私模式）也不抛，内存里照样生效", () => {
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    expect(() => recordContextSample({ model: "m", estimated: 10_000, actual: 11_000 })).not.toThrow();
    expect(contextCalibrationRatio("m")).toBeCloseTo(1.1, 5);
    spy.mockRestore();
  });

  it("只保留最近的若干模型，超出的丢最旧", () => {
    for (let i = 0; i < MAX_CALIBRATION_ENTRIES + 3; i += 1) {
      recordContextSample({ model: `m-${i}`, estimated: 10_000, actual: 10_000, at: 1_000 + i });
    }
    const items = listContextCalibration();
    expect(items).toHaveLength(MAX_CALIBRATION_ENTRIES);
    expect(items.map((item) => item.model)).not.toContain("m-0");
    expect(items[0]?.model).toBe(`m-${MAX_CALIBRATION_ENTRIES + 2}`);
  });

  it("listContextCalibration 按最近更新时间倒序，并带回样本数", () => {
    recordContextSample({ model: "old", estimated: 10_000, actual: 10_000, at: 100 });
    recordContextSample({ model: "new", estimated: 10_000, actual: 10_000, at: 200 });
    recordContextSample({ model: "new", estimated: 10_000, actual: 10_000, at: 300 });
    const items = listContextCalibration();
    expect(items[0]).toMatchObject({ model: "new", samples: 2, updatedAt: 300 });
    expect(items[1]).toMatchObject({ model: "old", samples: 1 });
  });

  it("非法估算值原样返回（-1 / NaN 不做乘法）", () => {
    expect(calibrateEstimate(-1, "m")).toBe(-1);
    expect(Number.isNaN(calibrateEstimate(Number.NaN, "m"))).toBe(true);
    expect(calibrateEstimate(0, "m")).toBe(0);
  });
});
