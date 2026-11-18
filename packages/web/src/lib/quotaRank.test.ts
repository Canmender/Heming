import { describe, expect, it } from "vitest";

import { rankAccounts, rankText, tightestLeft } from "./quotaRank";
import type { AccountRow } from "./magpieCli";
import { emptyWindow } from "./magpieQuota";

function account(overrides: Partial<AccountRow> & { windows?: AccountRow["windows"] }): AccountRow {
  return {
    agent: "claude",
    label: "工作号",
    active: false,
    on: false,
    windows: [
      { ...emptyWindow(), name: "5 hours", used: 18, remaining: 82 },
    ],
    raw: {},
    ...overrides,
  };
}

describe("quotaRank", () => {
  it("一个账号最紧的那份决定它的名次", () => {
    const row = account({
      windows: [
        { ...emptyWindow(), name: "5 hours", used: 18, remaining: 82 },
        { ...emptyWindow(), name: "week", used: 74, remaining: 26 },
      ],
    });
    expect(tightestLeft(row)).toBe(26);
  });

  it("不限量、只有原话、读不到与失效的账号不参与排名", () => {
    expect(tightestLeft(account({ windows: [{ ...emptyWindow(), name: "week", unlimited: true }] }))).toBeNull();
    expect(
      tightestLeft(account({ windows: [{ ...emptyWindow(), name: "credits", text: true, display: "还剩 30 点" }] })),
    ).toBeNull();

    const ranked = rankAccounts([
      account({ label: "好的" }),
      account({ label: "失效的", lapsed: "登录过期" }),
      account({ label: "读不到的", error: "超时" }),
      account({ label: "没说清的", windows: [{ ...emptyWindow(), name: "week", text: true }] }),
    ]);
    expect(ranked.map((entry) => entry.label)).toEqual(["好的"]);
  });

  it("从宽到紧排序，同分按名字稳下来", () => {
    const ranked = rankAccounts([
      account({ label: "紧的", windows: [{ ...emptyWindow(), name: "week", used: 92, remaining: 8 }] }),
      account({ label: "宽的", windows: [{ ...emptyWindow(), name: "week", used: 10, remaining: 90 }] }),
      account({ agent: "codex", label: "中的", windows: [{ ...emptyWindow(), name: "week", used: 50, remaining: 50 }] }),
    ]);
    expect(ranked.map((entry) => entry.label)).toEqual(["宽的", "中的", "紧的"]);
  });

  it("两个账号时才说这一句，说清最宽与最紧", () => {
    const rows = [
      account({ label: "工作号", windows: [{ ...emptyWindow(), name: "week", used: 18, remaining: 82 }] }),
      account({ agent: "codex", label: "个人", windows: [{ ...emptyWindow(), name: "week", used: 88, remaining: 12 }] }),
    ];
    expect(rankText(rows)).toEqual({
      text: "最宽裕的是 Claude 工作号（剩 82%）；最紧的是 ChatGPT 个人（剩 12%）",
      tone: "warn",
    });
    expect(rankText([rows[0]!])).toBeNull();
    expect(rankText([])).toBeNull();
  });

  it("三个以上时中间那几个只报个数", () => {
    const rows = [
      account({ label: "a", windows: [{ ...emptyWindow(), name: "week", used: 5, remaining: 95 }] }),
      account({ label: "b", windows: [{ ...emptyWindow(), name: "week", used: 40, remaining: 60 }] }),
      account({ label: "c", windows: [{ ...emptyWindow(), name: "week", used: 50, remaining: 50 }] }),
      account({ label: "d", windows: [{ ...emptyWindow(), name: "week", used: 95, remaining: 5 }] }),
    ];
    expect(rankText(rows)).toEqual({
      text: "最宽裕的是 Claude a（剩 95%）；最紧的是 Claude d（剩 5%）；还有 2 个在中间",
      tone: "danger",
    });
  });

  it("都差不多时不硬分高低", () => {
    const rows = [
      account({ label: "a", windows: [{ ...emptyWindow(), name: "week", used: 60, remaining: 40 }] }),
      account({ label: "b", windows: [{ ...emptyWindow(), name: "week", used: 60, remaining: 40 }] }),
    ];
    expect(rankText(rows)).toEqual({
      text: "2 个账号都差不多，最宽的 Claude a 也只剩 40%",
      tone: "muted",
    });
  });
});