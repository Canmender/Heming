import { describe, it, expect } from "vitest";
import {
  COMPACT_HEADROOM_TOKENS,
  COMPACT_RETAIN_RATIO,
  COMPACT_THRESHOLD_RATIO,
  MAX_AUTO_TURNS,
  MIN_AUTO_BUDGET,
  MIN_AUTO_TURNS,
  TURN_BUDGET_TOKENS,
  applyModelBudget,
  autoBudgetTokens,
  autoKeepRecentTurns,
  compactSpec,
  windowBudgetTokens,
} from "./modelBudget.js";
import { DEFAULT_CONTEXT_SETTINGS } from "./settings.js";
import { DEFAULT_CAPABILITY } from "../modelCaps.js";

/**
 * 上下文预算（d.351）：照 DSH 的压缩规则从窗口算，不再有手动档。
 *
 * 三个数是产品口径，不是实现细节：
 * - 用到窗口 80% 才该压；
 * - 摘要请求本身留 64K 余量，阈值取「窗口 80%」与「窗口 − 输出 − 余量」的较小值；
 * - 压缩时保留最近 16% 原文（换算成轮数）。改这些常量必须同步改本文件。
 */

describe("modelBudget 按 DSH 规则算上下文预算", () => {
  it("阈值/保留/余量三个比例与 DSH 同值", () => {
    expect(COMPACT_THRESHOLD_RATIO).toBeCloseTo(0.8, 10);
    expect(COMPACT_RETAIN_RATIO).toBeCloseTo(0.16, 10);
    expect(COMPACT_HEADROOM_TOKENS).toBe(65_536);
  });

  it("大窗口：阈值 = 窗口 80%，保留量 = 消息预算的 16%", () => {
    const spec = compactSpec({ contextWindow: 200_000, maxOutput: 8_192 });
    expect(spec).not.toBeNull();
    expect(spec!.messageBudgetTokens).toBe(191_808);
    expect(spec!.pressureBudgetTokens).toBe(191_808 - 65_536);
    expect(spec!.thresholdTokens).toBe(126_272);
    expect(spec!.retainTokens).toBe(Math.floor(191_808 * 0.16));
    // 保留量必须小于阈值，否则「压缩」反而留下更多原文
    expect(spec!.retainTokens).toBeLessThan(spec!.thresholdTokens);
  });

  it("中窗口：压力预算比 80% 更紧时，以压力预算为阈值", () => {
    // 64K 窗口：80% = 52.4K，压力预算 = 64K-4K-64K = 负 → 走小窗口分支
    const spec = compactSpec({ contextWindow: 64_000, maxOutput: 4_096 });
    expect(spec).not.toBeNull();
    expect(spec!.thresholdTokens).toBe(Math.floor(64_000 * 0.8));
  });

  it("小窗口（比余量还小）：按窗口 80% 压，不返回负数预算", () => {
    const spec = compactSpec({ contextWindow: 8_192, maxOutput: 4_096 });
    expect(spec!.thresholdTokens).toBe(Math.floor(8_192 * 0.8));
    expect(spec!.pressureBudgetTokens).toBeGreaterThan(0);
    expect(windowBudgetTokens({ contextWindow: 8_192, maxOutput: 4_096 })).toBe(6_553);
  });

  it("窗口未知：compactSpec 返回 null，预算回落到保守默认", () => {
    expect(compactSpec(null)).toBeNull();
    expect(compactSpec(undefined)).toBeNull();
    expect(compactSpec({ contextWindow: 0, maxOutput: 0 })).toBeNull();
    expect(compactSpec({ contextWindow: Number.NaN, maxOutput: 1 })).toBeNull();
    expect(windowBudgetTokens(null)).toBe(0);
  });

  it("自动预算：窗口已知走阈值，未知回 6000", () => {
    expect(autoBudgetTokens({ contextWindow: 200_000, maxOutput: 8_192 })).toBe(126_272);
    expect(autoBudgetTokens(null)).toBe(MIN_AUTO_BUDGET);
    expect(autoBudgetTokens({ contextWindow: 8_192, maxOutput: 4_096 })).toBe(4_096);
  });

  it("保留轮数：按 16% 保留量换算，夹在 8–40 轮", () => {
    expect(autoKeepRecentTurns(6_000)).toBe(MIN_AUTO_TURNS);
    // 大窗口：保留量 30_689 token ≈ 40 轮，正好是上限
    expect(autoKeepRecentTurns(126_272, { contextWindow: 200_000, maxOutput: 8_192 })).toBe(MAX_AUTO_TURNS);
    expect(TURN_BUDGET_TOKENS).toBe(750);
    expect(Math.floor(30_689 / TURN_BUDGET_TOKENS)).toBe(40);
  });

  it("applyModelBudget：窗口已知用 DSH 阈值，其余开关原样带过来", () => {
    const out = applyModelBudget(DEFAULT_CONTEXT_SETTINGS, { contextWindow: 200_000, maxOutput: 8_192 });
    expect(out.budgetTokens).toBe(126_272);
    expect(out.keepRecentTurns).toBe(MAX_AUTO_TURNS);
    expect(out.enabled).toBe(true);
    expect(out.llmSummary).toBe(true);
  });

  it("applyModelBudget：窗口未知保持 6000 / 至少 8 轮", () => {
    const out = applyModelBudget(DEFAULT_CONTEXT_SETTINGS, null);
    expect(out.budgetTokens).toBe(6000);
    expect(out.keepRecentTurns).toBe(8);
  });

  it("applyModelBudget：旧设置里残留的手填值不再起作用", () => {
    const manual = { ...DEFAULT_CONTEXT_SETTINGS, budgetTokens: 12_000, autoBudget: false, keepRecentTurns: 4 };
    const out = applyModelBudget(manual, { contextWindow: 200_000, maxOutput: 8_192 });
    expect(out.budgetTokens).toBe(126_272);
    expect(out.keepRecentTurns).toBe(MAX_AUTO_TURNS);
  });

  it("保守缺省能力（8K 窗口）不超窗", () => {
    const out = applyModelBudget(DEFAULT_CONTEXT_SETTINGS, DEFAULT_CAPABILITY);
    expect(out.budgetTokens).toBe(4_096);
    expect(out.keepRecentTurns).toBe(MIN_AUTO_TURNS);
  });
});
