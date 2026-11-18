import { describe, expect, it } from "vitest";
import type { AccountRow } from "./magpieCli.js";
import { emptyWindow } from "./magpieQuota.js";
import { mergeAccounts } from "./mergedQuota.js";

const now = Date.parse("2026-11-18T05:00:00Z");
const later = (hours: number): string => new Date(now + hours * 3600_000).toISOString();

const account = (over: Partial<AccountRow> & { agent: string }): AccountRow => ({
  label: over.agent,
  active: true,
  on: true,
  windows: [],
  raw: {},
  ...over,
});

const window = (name: string, remaining: number, extra: Partial<ReturnType<typeof emptyWindow>> = {}) => ({
  ...emptyWindow(),
  name,
  remaining,
  used: 100 - remaining,
  ...extra,
});

describe("mergeAccounts", () => {
  it("同一个计划的份额按平均合并，两个账号才会出现", () => {
    const rows = [
      account({ agent: "claude", plan: "Max", windows: [window("5 hours", 80)] }),
      account({ agent: "claude", plan: "Max", windows: [window("5 hours", 20)] }),
    ];
    const [group] = mergeAccounts(rows, now);
    expect(group.agent).toBe("claude");
    expect(group.label).toBe("Claude");
    expect(group.accounts).toBe(2);
    expect(group.windows).toHaveLength(1);
    expect(group.windows[0]).toMatchObject({ name: "5 hours", accounts: 2, left: 50, tone: "ok", text: "平均剩 50%" });
    expect(group.windows[0].detail).toMatch(/同一计划下 2 个账号的平均/);
  });

  it("只有一个账号时不合并：那一行自己已经在下面", () => {
    const rows = [account({ agent: "claude", plan: "Max", windows: [window("5 hours", 30)] })];
    expect(mergeAccounts(rows, now)).toEqual([]);
  });

  it("点数窗口把用量与上限分别相加", () => {
    const rows = [
      account({
        agent: "workbuddy",
        windows: [window("Month", 100, { amount: 3000, limit: 10000, unit: "credits", remaining: 70 })],
      }),
      account({
        agent: "workbuddy",
        windows: [window("Month", 100, { amount: 0, limit: 5000, unit: "credits", remaining: 100 })],
      }),
    ];
    const [group] = mergeAccounts(rows, now);
    expect(group.label).toBe("WorkBuddy");
    expect(group.windows[0]).toMatchObject({ text: "剩 12,000 点", left: 80, tone: "ok" });
    expect(group.windows[0].detail).toMatch(/合计 已用 3,000 \/ 共 15,000 点/);
  });

  it("只有余额的钱包把余额相加", () => {
    const rows = [
      account({ agent: "deepseek", windows: [window("balance", 100, { balance: 12.5 })] }),
      account({ agent: "deepseek", windows: [window("balance", 100, { balance: 7.5 })] }),
    ];
    const [group] = mergeAccounts(rows, now);
    expect(group.windows[0].text).toBe("余额 20");
  });

  it("读不到的账号不算进来，并单独计数", () => {
    const rows = [
      account({ agent: "claude", plan: "Max", windows: [window("5 hours", 70)] }),
      account({ agent: "claude", plan: "Max", windows: [window("5 hours", 50)] }),
      account({ agent: "claude", plan: "Max", windows: [], error: "超时" }),
    ];
    const [group] = mergeAccounts(rows, now);
    expect(group.accounts).toBe(2);
    expect(group.windows[0].text).toBe("平均剩 60%");
  });

  it("读数是重置之前的旧数：算读不到，不参与平均", () => {
    const rows = [
      account({ agent: "claude", plan: "Max", windows: [window("5 hours", 80)] }),
      account({ agent: "claude", plan: "Max", windows: [window("5 hours", 10)] }),
      account({
        agent: "claude",
        plan: "Max",
        asOf: new Date(now - 3600_000).toISOString(),
        windows: [window("5 hours", 5, { resetsAt: new Date(now - 60_000).toISOString() })],
      }),
    ];
    const [group] = mergeAccounts(rows, now);
    expect(group.windows[0]).toMatchObject({ accounts: 2, left: 45, detail: expect.stringMatching(/1 份读不到/) });
  });

  it("不同计划各算各的：各自只有一个账号就不合并", () => {
    const rows = [
      account({ agent: "claude", plan: "Max", windows: [window("5 hours", 80)] }),
      account({ agent: "claude", plan: "Pro", windows: [window("5 hours", 20)] }),
    ];
    expect(mergeAccounts(rows, now)).toEqual([]);
  });

  it("不限量只有每个账号都读成不限量时才算", () => {
    const both = [
      account({ agent: "claude", plan: "Max", windows: [window("credits", 100, { unlimited: true })] }),
      account({ agent: "claude", plan: "Max", windows: [window("credits", 100, { unlimited: true })] }),
    ];
    expect(mergeAccounts(both, now)[0].windows[0]).toMatchObject({ text: "不限量", tone: "ok" });

    const mixed = [both[0], account({ agent: "claude", plan: "Max", windows: [window("credits", 40)] })];
    // 一份读成不限量、一份按份额：读法不同，谁也没有第二份可以合，整组不出现。
    expect(mergeAccounts(mixed, now)).toEqual([]);
  });

  it("只有厂商原话的窗口不参与合并", () => {
    const rows = [
      account({ agent: "qoder", windows: [window("积分", 100, { text: true, display: "积分 300" })] }),
      account({ agent: "qoder", windows: [window("积分", 100, { text: true, display: "积分 200" })] }),
    ];
    expect(mergeAccounts(rows, now)).toEqual([]);
  });

  it("余量见底转成危险色，并按名字排序", () => {
    const rows = [
      account({ agent: "codex", plan: "Plus", windows: [window("week", 4)] }),
      account({ agent: "codex", plan: "Plus", windows: [window("week", 6)] }),
      account({ agent: "claude", plan: "Max", windows: [window("week", 90)] }),
      account({ agent: "claude", plan: "Max", windows: [window("week", 70)] }),
    ];
    const groups = mergeAccounts(rows, now);
    expect(groups.map((group) => group.label)).toEqual(["ChatGPT", "Claude"]);
    expect(groups[0].windows[0]).toMatchObject({ left: 5, tone: "danger", text: "平均剩 5%" });
  });

  it("最早一份的重置时间带出来，只算未来的", () => {
    const rows = [
      account({ agent: "claude", plan: "Max", windows: [window("5 hours", 60, { resetsAt: later(3) })] }),
      account({ agent: "claude", plan: "Max", windows: [window("5 hours", 40, { resetsAt: later(1) })] }),
      account({ agent: "claude", plan: "Max", windows: [window("5 hours", 20, { resetsAt: later(9) })] }),
    ];
    const [group] = mergeAccounts(rows, now);
    expect(group.windows[0].resetsAt).toBe(Date.parse(later(1)));
  });
});
