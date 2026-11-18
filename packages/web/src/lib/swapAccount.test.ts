import { describe, expect, it } from "vitest";
import type { AccountRow } from "./magpieCli.js";
import { emptyWindow, type QuotaWindow } from "./magpieQuota.js";
import { accountUsedUp, swapArgs, swapSuggestions, swapText } from "./swapAccount.js";

function window(left: number, extra: Partial<QuotaWindow> = {}): QuotaWindow {
  return { ...emptyWindow(), name: "5 hours", used: 100 - left, remaining: left, ...extra };
}

function row(agent: string, windows: QuotaWindow[], extra: Partial<AccountRow> = {}): AccountRow {
  return {
    agent,
    label: `${agent}-${windows.length}`,
    active: true,
    on: true,
    windows,
    raw: {},
    ...extra,
  };
}

describe("换到还有额度的那个账号", () => {
  it("窗口全见底才算用完：没窗口、只有原话、不限量的都不算", () => {
    expect(accountUsedUp(row("claude", [window(0)]))).toBe(true);
    expect(accountUsedUp(row("claude", [window(0), window(0)]))).toBe(true);
    expect(accountUsedUp(row("claude", [window(0), window(40)]))).toBe(false);
    expect(accountUsedUp(row("claude", []))).toBe(false);
    expect(accountUsedUp(row("claude", [window(0, { text: true })]))).toBe(false);
    expect(accountUsedUp(row("claude", [window(0, { unlimited: true })]))).toBe(false);
  });

  it("一家用完、另一家还有余量时才给建议", () => {
    const rows = [
      row("claude", [window(0)]),
      row("claude", [window(60)]),
      row("codex", [window(0)]),
    ];
    const suggestions = swapSuggestions(rows);
    expect(suggestions).toEqual([{ agent: "claude", usedUp: 1, ready: 1 }]);
  });

  it("只有一家时不说「换过去」——没有别处可换", () => {
    expect(swapSuggestions([row("claude", [window(0)])])).toEqual([]);
    expect(swapSuggestions([row("claude", [window(0)]), row("claude", [window(0)])])).toEqual([]);
  });

  it("余量太少的不算「还有额度」：阈值以上才算", () => {
    const rows = [row("claude", [window(0)]), row("claude", [window(10)])];
    expect(swapSuggestions(rows)).toEqual([]);
    expect(swapSuggestions(rows, 5)).toEqual([{ agent: "claude", usedUp: 1, ready: 1 }]);
  });

  it("失效或读不到错误的账号不参与建议", () => {
    const rows = [
      row("codex", [window(0)], { lapsed: "3 天前失效" }),
      row("codex", [window(80)]),
      row("codex", [window(0)], { error: "401" }),
    ];
    expect(swapSuggestions(rows)).toEqual([]);
  });

  it("不限量的账号算「还有余量」", () => {
    const rows = [row("claude", [window(0)]), row("claude", [window(0, { unlimited: true })])];
    expect(swapSuggestions(rows)).toEqual([{ agent: "claude", usedUp: 1, ready: 1 }]);
  });

  it("命令与文案", () => {
    expect(swapArgs("claude")).toEqual(["accounts", "switch", "claude", "next"]);
    expect(swapText({ agent: "claude", usedUp: 1, ready: 2 }, (agent) => (agent === "claude" ? "Claude" : agent))).toBe(
      "Claude 有 1 个账号用完了，另有 2 个还有余量",
    );
  });
});
