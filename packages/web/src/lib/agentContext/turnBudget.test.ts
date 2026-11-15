import { describe, expect, it } from "vitest";
import { DEFAULT_BUDGET_TOKENS, DEFAULT_RESERVED_TOKENS } from "./budget.js";
import { MAX_TOOL_CONTEXT_TOKENS } from "./toolResults.js";
import { DEFAULT_TURN_CAPS, planTurnBudget } from "./turnBudget.js";

/**
 * P2-T11 的账本测试：三个上限（context / toolContext / turnTool）必须在**同一份账**上，
 * 且 `remaining.history` 是 `planContext` 能直接用的净值——这一条最容易写错两次扣减。
 */

describe("planTurnBudget · 默认账本", () => {
  it("默认上限就是 P0 的三个常量（搬到账本里，数值不变）", () => {
    expect(DEFAULT_TURN_CAPS.context).toBe(DEFAULT_BUDGET_TOKENS);
    expect(DEFAULT_TURN_CAPS.toolContext).toBe(MAX_TOOL_CONTEXT_TOKENS);
    expect(DEFAULT_TURN_CAPS.turnTool).toBe(12_000);
    expect(DEFAULT_TURN_CAPS.reserved).toBe(DEFAULT_RESERVED_TOKENS);
  });

  it("空输入：在限内，剩余额度按 context 算", () => {
    const plan = planTurnBudget();
    expect(plan.verdict).toBe("ok");
    expect(plan.over).toEqual([]);
    expect(plan.used.total).toBe(0);
    expect(plan.remaining.history).toBe(DEFAULT_BUDGET_TOKENS - DEFAULT_RESERVED_TOKENS);
  });
});

describe("planTurnBudget · 三个闸门", () => {
  it("总请求超 context：判 over，闸门是 context", () => {
    const plan = planTurnBudget({ systemTokens: 2000, historyTokens: 4000, toolTokens: 500 });
    expect(plan.used.total).toBe(6500);
    expect(plan.over).toEqual(["context"]);
    expect(plan.remaining.context).toBe(0);
  });

  it("工具结果超折叠预算：闸门是 toolResults（即使总请求还没超）", () => {
    const plan = planTurnBudget({ systemTokens: 500, historyTokens: 500, toolTokens: 3500 });
    expect(plan.over).toEqual(["toolResults"]);
  });

  it("工具结果超单轮上限：两个工具闸门同时报（toolResults 更紧，先撞）", () => {
    const plan = planTurnBudget({ toolTokens: 13_000 });
    expect(plan.over).toContain("toolResults");
    expect(plan.over).toContain("turn");
  });

  it("单轮上限可以单独放宽：只报 turn 不报 toolResults", () => {
    const plan = planTurnBudget({ toolTokens: 5000, caps: { toolContext: 9000 } });
    expect(plan.over).toEqual([]);
  });
});

describe("planTurnBudget · 历史额度是净值（不重复扣预留）", () => {
  it("系统提示词在 900 预留信封内时不额外扣（它本来就属于注入预留）", () => {
    const plan = planTurnBudget({ systemTokens: 800 });
    expect(plan.remaining.history).toBe(DEFAULT_BUDGET_TOKENS - DEFAULT_RESERVED_TOKENS);
  });

  it("系统提示词超出预留信封时，只扣超出部分", () => {
    const plan = planTurnBudget({ systemTokens: 1400 });
    expect(plan.remaining.history).toBe(
      DEFAULT_BUDGET_TOKENS - DEFAULT_RESERVED_TOKENS - (1400 - DEFAULT_RESERVED_TOKENS),
    );
  });

  it("工具结果从历史额度里扣掉（它不占注入预留）", () => {
    const plan = planTurnBudget({ toolTokens: 800 });
    expect(plan.remaining.history).toBe(DEFAULT_BUDGET_TOKENS - DEFAULT_RESERVED_TOKENS - 800);
  });

  it("扣到负数时归零，不返回负额度", () => {
    const plan = planTurnBudget({ systemTokens: 5000, toolTokens: 1000 });
    expect(plan.remaining.history).toBe(0);
    expect(plan.remaining.turn).toBe(11_000);
  });
});

describe("planTurnBudget · 参数健壮性", () => {
  it("非法/负数输入按 0 处理，负数上限按 0", () => {
    const plan = planTurnBudget({
      systemTokens: Number.NaN,
      historyTokens: -10,
      toolTokens: -1,
      caps: { context: -5, toolContext: 1.9 },
    });
    expect(plan.used).toEqual({ system: 0, history: 0, toolResults: 0, total: 0 });
    expect(plan.caps.context).toBe(0);
    expect(plan.caps.toolContext).toBe(1);
    // 空请求在 0 上限里也算放得下（0 > 0 不成立），但剩余额度为 0
    expect(plan.over).toEqual([]);
    expect(plan.remaining.context).toBe(0);
  });

  it("caps 只覆盖给出的字段，其余保持默认", () => {
    const plan = planTurnBudget({ caps: { context: 20_000 } });
    expect(plan.caps.context).toBe(20_000);
    expect(plan.caps.toolContext).toBe(MAX_TOOL_CONTEXT_TOKENS);
    expect(plan.caps.reserved).toBe(DEFAULT_RESERVED_TOKENS);
  });
});
