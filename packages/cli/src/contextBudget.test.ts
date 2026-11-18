import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../../../packages/web/src/lib/llmClient.js";
import {
  CLI_CONTEXT_BUDGET_DEFAULT,
  CLI_CONTEXT_BUDGET_MAX,
  CLI_CONTEXT_BUDGET_MIN,
  createCliHistoryPrep,
  describeCliContext,
  normalizeCliContextBudget,
  parseCliContextBudget,
} from "./contextBudget.js";

/** 一段够长的中文（1 字 ≈ 1 token）：用来把历史顶出预算。 */
const LONG = "把登录改成扫码的那次改动里，还要顺手把会话过期的分支补上，".repeat(8);

/** 造 n 轮问答（一轮 = user + assistant）。 */
function turns(n: number): ChatMessage[] {
  const rows: ChatMessage[] = [];
  for (let i = 1; i <= n; i += 1) {
    rows.push({ role: "user", content: `第 ${i} 轮：${LONG}` });
    rows.push({ role: "assistant", content: `第 ${i} 轮做完了：${LONG}` });
  }
  return rows;
}

describe("预算取值", () => {
  it("缺省与非法值都回落到默认预算", () => {
    expect(normalizeCliContextBudget(undefined)).toBe(CLI_CONTEXT_BUDGET_DEFAULT);
    expect(normalizeCliContextBudget(Number.NaN)).toBe(CLI_CONTEXT_BUDGET_DEFAULT);
    expect(normalizeCliContextBudget(Number.POSITIVE_INFINITY)).toBe(CLI_CONTEXT_BUDGET_DEFAULT);
  });

  it("越界值被夹到合法区间，合法值原样保留", () => {
    expect(normalizeCliContextBudget(10)).toBe(CLI_CONTEXT_BUDGET_MIN);
    expect(normalizeCliContextBudget(CLI_CONTEXT_BUDGET_MAX + 1)).toBe(CLI_CONTEXT_BUDGET_MAX);
    expect(normalizeCliContextBudget(4000)).toBe(4000);
    expect(normalizeCliContextBudget(4000.9)).toBe(4000);
  });

  it("--context-budget 的解析：正整数且在区间内才通过", () => {
    expect(parseCliContextBudget("4000")).toEqual({ ok: true, value: 4000 });
    for (const raw of ["abc", "0", "-5", "4000.5", ""]) {
      const parsed = parseCliContextBudget(raw);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.error).toContain("正整数");
    }
  });

  it("--context-budget 超出区间时点名区间，并指向 --no-compact", () => {
    for (const raw of ["100", String(CLI_CONTEXT_BUDGET_MAX + 1)]) {
      const parsed = parseCliContextBudget(raw);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) {
        expect(parsed.error).toContain(`${CLI_CONTEXT_BUDGET_MIN}–${CLI_CONTEXT_BUDGET_MAX}`);
        expect(parsed.error).toContain("--no-compact");
      }
    }
  });
});

describe("describeCliContext", () => {
  const base = { folded: 0, folds: 0, budgetTokens: 12000, aggressive: 0 as const, enabled: true };

  it("关掉折叠时说清是用户关的，而不是「都在预算内」", () => {
    expect(describeCliContext({ ...base, enabled: false })).toBe(
      "上下文：不折叠（--no-compact），历史原样发送。",
    );
  });

  it("没折的时候只说预算，不编数字", () => {
    expect(describeCliContext(base)).toBe("上下文：历史都在预算内（预算 12000 tokens），没有折叠。");
  });

  it("折了报条数与预算，重试收紧时补一句", () => {
    expect(describeCliContext({ ...base, folded: 6, folds: 1 })).toBe(
      "上下文：折叠了 6 条早期对话（预算 12000 tokens）。",
    );
    expect(describeCliContext({ ...base, folded: 6, folds: 2, aggressive: 2 })).toBe(
      "上下文：折叠了 6 条早期对话（预算 12000 tokens，命中上下文上限后收紧到第 2 级）。",
    );
  });
});

describe("createCliHistoryPrep", () => {
  it("历史在预算内时原样通过，统计是 0", async () => {
    const prep = createCliHistoryPrep({ budgetTokens: 12000 });
    const rows: ChatMessage[] = [
      { role: "user", content: "把登录改成扫码" },
      { role: "assistant", content: "改好了" },
    ];
    const prepared = await prep.prepare(rows, "cli");
    expect(prepared).toEqual(rows);
    expect(prep.stats.folded).toBe(0);
    expect(prep.stats.folds).toBe(0);
  });

  it("超出预算时把早期对话折成摘要头，最近的一轮原文还在", async () => {
    const prep = createCliHistoryPrep({ budgetTokens: 2000, keepRecentTurns: 2 });
    const rows = turns(12);
    const prepared = await prep.prepare(rows, "cli");

    expect(prepared[0]?.role).toBe("system");
    expect(String(prepared[0]?.content)).toContain("【早期对话摘要】");
    expect(prep.stats.folded).toBeGreaterThan(0);
    expect(prep.stats.folds).toBe(1);
    // 摘要替代了早期对话：条数一定比原文少。
    expect(prepared.length).toBeLessThan(rows.length);
    // 最后一轮原封不动，否则等于把用户刚说的话也折了。
    expect(prepared.at(-1)).toEqual(rows.at(-1));
    expect(describeCliContext(prep.stats)).toContain("折叠了");
  });

  it("--no-compact 时一条都不折，统计如实为 0", async () => {
    const prep = createCliHistoryPrep({ budgetTokens: 500, enabled: false });
    const rows = turns(12);
    const prepared = await prep.prepare(rows, "cli");
    expect(prepared).toBe(rows);
    expect(prep.stats.folded).toBe(0);
    expect(describeCliContext(prep.stats)).toContain("--no-compact");
  });

  it("系统提示词也吃同一份预算：系统长，历史就更早被折", async () => {
    const rows = turns(6);
    const loose = createCliHistoryPrep({ budgetTokens: 1000, keepRecentTurns: 2 });
    const tight = createCliHistoryPrep({
      budgetTokens: 1000,
      keepRecentTurns: 2,
      systemTokens: 900,
    });
    const looseRows = await loose.prepare(rows, "cli");
    const tightRows = await tight.prepare(rows, "cli");
    expect(tight.stats.folded).toBeGreaterThanOrEqual(loose.stats.folded);
    expect(tightRows.length).toBeLessThanOrEqual(looseRows.length);
  });

  it("溢出重试的 aggressive 会被记下，预算按级折算", async () => {
    const prep = createCliHistoryPrep({ budgetTokens: 8000, keepRecentTurns: 4 });
    const rows = turns(20);

    await prep.prepare(rows, "cli", { aggressive: 1 });
    expect(prep.stats.aggressive).toBe(1);
    expect(prep.stats.budgetTokens).toBe(4000);

    await prep.prepare(rows, "cli", { aggressive: 2 });
    expect(prep.stats.aggressive).toBe(2);
    expect(prep.stats.budgetTokens).toBe(2000);
    expect(prep.stats.folds).toBe(2);
  });

  it("历史形状不对也不阻断：拿不到行就当空历史，不抛错", async () => {
    const prep = createCliHistoryPrep({ budgetTokens: 500 });
    const prepared = await prep.prepare(
      undefined as unknown as ChatMessage[],
      "cli",
    );
    expect(Array.isArray(prepared)).toBe(true);
    expect(prep.stats.folded).toBe(0);
  });
});