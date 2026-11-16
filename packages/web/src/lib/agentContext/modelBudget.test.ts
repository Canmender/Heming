import { describe, it, expect } from "vitest";
import {
  TURN_BUDGET_TOKENS,
  BUDGET_WINDOW_RATIO,
  MAX_AUTO_BUDGET,
  MAX_AUTO_TURNS,
  MIN_AUTO_BUDGET,
  MIN_AUTO_TURNS,
  applyModelBudget,
  autoBudgetTokens,
  autoKeepRecentTurns,
  windowBudgetTokens,
} from "./modelBudget.js";
import { DEFAULT_CONTEXT_SETTINGS } from "./settings.js";
import { DEFAULT_CAPABILITY } from "../modelCaps.js";

/**
 * d.160：预算按模型窗口分配。
 *
 * 这里的每个数字都是产品口径，不是实现细节：
 * 60% 留给历史（其余给系统提示词/工具声明/输出），自动档封顶 3.2 万（再大不划算），
 * 每 750 token 算一轮、夹在 8–24 轮之间。改这些常量必须同步改本文件。
 */

describe("modelBudget 按模型窗口分配历史预算", () => {
  it("窗口比例是 60%（改这个数要连设置卡一起看）", () => {
    expect(BUDGET_WINDOW_RATIO).toBeCloseTo(0.6, 10);
  });

  it("窗口预算 = 窗口 × 60%，能力未知 → 0（由调用方回默认）", () => {
    expect(windowBudgetTokens({ contextWindow: 200_000, maxOutput: 8_192 })).toBe(120_000);
    expect(windowBudgetTokens({ contextWindow: 8_192, maxOutput: 4_096 })).toBe(4_915);
    expect(windowBudgetTokens(null)).toBe(0);
    expect(windowBudgetTokens(undefined)).toBe(0);
    expect(windowBudgetTokens({ contextWindow: 0, maxOutput: 0 })).toBe(0);
    expect(windowBudgetTokens({ contextWindow: Number.NaN, maxOutput: 1 })).toBe(0);
  });

  it("自动档预算：大窗口封顶 3.2 万，小窗口不越过 60% 硬塞", () => {
    // 200K 的 60% 是 12 万，但自动档不让它无限涨
    expect(autoBudgetTokens({ contextWindow: 200_000, maxOutput: 8_192 })).toBe(MAX_AUTO_BUDGET);
    // 64K 的 60% 是 38.4K，同样封顶
    expect(autoBudgetTokens({ contextWindow: 64_000, maxOutput: 4_096 })).toBe(MAX_AUTO_BUDGET);
    // 32K 的 60% = 19.66K，没到上限，按实际值
    expect(autoBudgetTokens({ contextWindow: 32_768, maxOutput: 4_096 })).toBe(19_660);
    // 8K 窗口：60% = 4.9K，低于下限 6K——**不能**为了凑下限去超窗
    expect(autoBudgetTokens({ contextWindow: 8_192, maxOutput: 4_096 })).toBe(4_915);
    // 能力未知：保持历史默认值，不偷偷改小
    expect(autoBudgetTokens(null)).toBe(MIN_AUTO_BUDGET);
  });

  it("保留轮数随预算放大，但夹在 8–24 轮", () => {
    expect(autoKeepRecentTurns(MIN_AUTO_BUDGET)).toBe(MIN_AUTO_TURNS);
    expect(autoKeepRecentTurns(MAX_AUTO_BUDGET)).toBe(MAX_AUTO_TURNS);
    expect(autoKeepRecentTurns(9_000)).toBe(12);
    expect(autoKeepRecentTurns(0)).toBe(MIN_AUTO_TURNS);
    expect(autoKeepRecentTurns(Number.NaN)).toBe(MIN_AUTO_TURNS);
    // 每轮 750 token 是换算口径本身
    expect(TURN_BUDGET_TOKENS).toBe(750);
    expect(Math.floor(MAX_AUTO_BUDGET / TURN_BUDGET_TOKENS)).toBeGreaterThanOrEqual(MAX_AUTO_TURNS);
  });

  it("自动档：默认设置 + 20 万窗口 → 3.2 万预算 / 24 轮（d.159 之前是 6000 / 8）", () => {
    const out = applyModelBudget(DEFAULT_CONTEXT_SETTINGS, { contextWindow: 200_000, maxOutput: 8_192 });
    expect(out.budgetTokens).toBe(MAX_AUTO_BUDGET);
    expect(out.keepRecentTurns).toBe(MAX_AUTO_TURNS);
    // 其余开关原样带过来
    expect(out.enabled).toBe(true);
    expect(out.llmSummary).toBe(true);
    expect(out.autoBudget).toBe(true);
  });

  it("自动档 + 未知模型：行为与 d.159 一致（6000 / 8），不因查不到就变差", () => {
    const out = applyModelBudget(DEFAULT_CONTEXT_SETTINGS, null);
    expect(out.budgetTokens).toBe(6000);
    expect(out.keepRecentTurns).toBe(8);
  });

  it("自动档 + 保守缺省能力（8K 窗口）：取 60% 上限，不超窗", () => {
    const out = applyModelBudget(DEFAULT_CONTEXT_SETTINGS, DEFAULT_CAPABILITY);
    expect(out.budgetTokens).toBe(4_915);
    expect(out.keepRecentTurns).toBe(MIN_AUTO_TURNS);
  });

  it("手动档：尊重用户手填值，但仍收敛到窗口上限（超窗只会换来 400）", () => {
    const manual = { ...DEFAULT_CONTEXT_SETTINGS, autoBudget: false, budgetTokens: 6_000, keepRecentTurns: 4 };
    const same = applyModelBudget(manual, { contextWindow: 200_000, maxOutput: 8_192 });
    expect(same.budgetTokens).toBe(6_000);
    expect(same.keepRecentTurns).toBe(4);

    const tooBig = applyModelBudget({ ...manual, budgetTokens: 200_000 }, { contextWindow: 8_192, maxOutput: 4_096 });
    expect(tooBig.budgetTokens).toBe(4_915);
    expect(tooBig.keepRecentTurns).toBe(4);
  });

  it("手动档 + 能力未知：一个字都不改", () => {
    const manual = { ...DEFAULT_CONTEXT_SETTINGS, autoBudget: false, budgetTokens: 9_999 };
    expect(applyModelBudget(manual, null)).toEqual(manual);
  });

  it("关掉自动档不会擦掉手填值（开关语义，不是覆盖语义）", () => {
    // 自动档下用户手填 12000 仍留着：再开回来的时候不会变成 6000 之外的意外值
    const on = applyModelBudget(
      { ...DEFAULT_CONTEXT_SETTINGS, budgetTokens: 12_000 },
      { contextWindow: 200_000, maxOutput: 8_192 },
    );
    expect(on.budgetTokens).toBe(MAX_AUTO_BUDGET);
    const off = applyModelBudget({ ...on, autoBudget: false }, { contextWindow: 200_000, maxOutput: 8_192 });
    // 关掉后用的是「当时算出来的值」，不是用户很久以前手填的 12000——
    // 这是刻意的：界面上看到多少，关掉之后就是多少，不会突然退回旧值。
    expect(off.budgetTokens).toBe(MAX_AUTO_BUDGET);
  });
});

