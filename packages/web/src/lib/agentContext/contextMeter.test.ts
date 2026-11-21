import { describe, expect, it } from "vitest";
import {
  CONTEXT_METER_QUIET_RATIO,
  CONTEXT_METER_QUIET_TOKENS,
  CONTEXT_METER_WARN_RATIO,
  contextMeter,
  formatTokens,
} from "./contextMeter.js";

describe("上下文用量指示（d.187）", () => {
  it("formatTokens 只做显示：千以下原样、千以上一位小数、百万级 M", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(850)).toBe("850");
    expect(formatTokens(12345)).toBe("12.3K");
    expect(formatTokens(99_999)).toBe("100.0K");
    // K→M 的分界在 100 万，不是 10 万：20 万该显示 200.0K，不能拧成 0.2M（d.412 回归）
    expect(formatTokens(100_000)).toBe("100.0K");
    expect(formatTokens(200_000)).toBe("200.0K");
    expect(formatTokens(456_789)).toBe("456.8K");
    expect(formatTokens(999_999)).toBe("1.0M");
    expect(formatTokens(1_000_000)).toBe("1.0M");
    expect(formatTokens(2_400_000)).toBe("2.4M");
    // 负数/NaN 不该出现，但出现了也不能崩或显示 "-3"
    expect(formatTokens(-5)).toBe("0");
    expect(formatTokens(Number.NaN)).toBe("0");
  });

  it("对话还很短时是安静档（整条不渲染）", () => {
    const meter = contextMeter(400, 25_000);
    expect(meter.level).toBe("quiet");
    // 阈值本身也钉住：低于 30% 或低于 1500 tokens 都安静
    expect(contextMeter(CONTEXT_METER_QUIET_TOKENS - 1, 1000).level).toBe("quiet");
    expect(
      contextMeter(Math.floor(25_000 * (CONTEXT_METER_QUIET_RATIO - 0.01)), 25_000).level,
    ).toBe("quiet");
  });

  it("过了安静档就是正常档，文案里带用量/预算/百分比", () => {
    const meter = contextMeter(12_400, 25_900);
    expect(meter.level).toBe("ok");
    expect(meter.text).toBe("上下文 ≈ 12.4K / 25.9K（48%）");
    expect(meter.ratio).toBeCloseTo(0.4788, 3);
  });

  it("到 80% 提醒可以 /compact，但不说「下一轮会压缩」", () => {
    const meter = contextMeter(20_000, 25_000);
    expect(meter.level).toBe("warn");
    expect(meter.text).toContain("可以发 /compact 压一次");
    expect(meter.text).not.toContain("下一轮会压缩");
    expect(contextMeter(25_000 * CONTEXT_METER_WARN_RATIO, 25_000).level).toBe("warn");
  });

  it("到 100% 说明下一轮会压缩早期内容", () => {
    const meter = contextMeter(26_000, 25_000);
    expect(meter.level).toBe("full");
    expect(meter.ratio).toBeGreaterThan(1);
    expect(meter.text).toContain("下一轮会压缩早期内容");
  });

  it("预算为 0（还没有模型窗口）时安静，不显示 0% 或除零结果", () => {
    const meter = contextMeter(12_000, 0);
    expect(meter.level).toBe("quiet");
    expect(meter.ratio).toBe(0);
    expect(meter.text).toBe("上下文 ≈ 12.0K / 0（0%）");
  });

  it("负数与小数被归一：用量不会比 0 小，ratio 也不会被 NaN 传染", () => {
    const meter = contextMeter(-100, 10_000);
    expect(meter.used).toBe(0);
    expect(meter.level).toBe("quiet");
    const rounded = contextMeter(12_345.6, 25_000.4);
    expect(rounded.used).toBe(12_346);
    expect(rounded.budget).toBe(25_000);
  });
});
