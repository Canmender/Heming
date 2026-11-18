import { describe, expect, it } from "vitest";
import {
  ACCOUNT_FILTER_MIN,
  ACCOUNT_FILTERS,
  accountBucket,
  accountFilterCounts,
  accountFilterEmptyText,
  filterAccounts,
} from "./accountFilter.js";
import { emptyWindow, type QuotaWindow } from "./magpieQuota.js";
import type { AccountRow } from "./magpieCli.js";

function account(over: Partial<AccountRow> = {}): AccountRow {
  return {
    agent: "claude",
    label: "工作号",
    active: true,
    on: true,
    windows: [],
    raw: {},
    ...over,
  };
}

function span(left: number, over: Partial<QuotaWindow> = {}): QuotaWindow {
  return { ...emptyWindow(), name: "5 hours", used: 100 - left, remaining: left, ...over };
}

describe("accountBucket", () => {
  it("登录失效优先于用量：额度数字不可信时不说「快用完」", () => {
    expect(accountBucket(account({ lapsed: "登录过期了", windows: [span(2)] }))).toBe("lapsed");
  });

  it("读不到额度也算要重新登录，因为数字本来就缺", () => {
    expect(accountBucket(account({ error: "403" }))).toBe("lapsed");
  });

  it("剩 25% 及以下算快用完，31% 还归「还有余量」", () => {
    expect(accountBucket(account({ windows: [span(25)] }))).toBe("low");
    expect(accountBucket(account({ windows: [span(31)] }))).toBe("ready");
  });

  it("多个窗口里只要有一个紧，就是快用完", () => {
    expect(accountBucket(account({ windows: [span(80), span(5)] }))).toBe("low");
  });

  it("不限量与只有厂商原话的窗口不判紧", () => {
    expect(accountBucket(account({ windows: [span(0, { unlimited: true })] }))).toBe("ready");
    expect(accountBucket(account({ windows: [span(0, { text: true, display: "积分 300" })] }))).toBe(
      "ready",
    );
  });

  it("没有窗口的账号归「还有余量」：没读到窗口不等于用完", () => {
    expect(accountBucket(account())).toBe("ready");
  });
});

describe("accountFilterCounts / filterAccounts", () => {
  const rows = [
    account({ label: "A", windows: [span(60)] }),
    account({ label: "B", windows: [span(12)] }),
    account({ label: "C", lapsed: "过期" }),
    account({ label: "D" }),
  ];

  it("三档加起来正好是全部", () => {
    const counts = accountFilterCounts(rows);
    expect(counts.all).toBe(4);
    expect(counts.ready + counts.low + counts.lapsed).toBe(4);
    expect(counts).toMatchObject({ ready: 2, low: 1, lapsed: 1 });
  });

  it("按档筛出来的就是那几个，全部则原样返回", () => {
    expect(filterAccounts(rows, "low").map((row) => row.label)).toEqual(["B"]);
    expect(filterAccounts(rows, "lapsed").map((row) => row.label)).toEqual(["C"]);
    expect(filterAccounts(rows, "ready").map((row) => row.label)).toEqual(["A", "D"]);
    expect(filterAccounts(rows, "all")).toHaveLength(4);
  });

  it("筛出来的数组是新的，改动它不会动到原列表", () => {
    const all = filterAccounts(rows, "all");
    all.pop();
    expect(rows).toHaveLength(4);
  });

  it("空列表也能算", () => {
    expect(accountFilterCounts([])).toEqual({ all: 0, ready: 0, low: 0, lapsed: 0 });
  });
});

describe("常量的形状", () => {
  it("四档、顺序固定、门槛是个正整数", () => {
    expect(ACCOUNT_FILTERS.map((item) => item.id)).toEqual(["all", "lapsed", "low", "ready"]);
    expect(ACCOUNT_FILTERS[0]?.id).toBe("all");
    expect(Number.isInteger(ACCOUNT_FILTER_MIN)).toBe(true);
    expect(ACCOUNT_FILTER_MIN).toBeGreaterThan(1);
  });

  it("每档都有一句自己的空态说明，且互不相同", () => {
    const texts = ACCOUNT_FILTERS.map((item) => accountFilterEmptyText(item.id));
    expect(new Set(texts).size).toBe(texts.length);
    for (const text of texts) expect(text.length).toBeGreaterThan(0);
  });
});