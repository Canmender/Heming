import { describe, expect, it } from "vitest";
import { agentQuota, agentQuotaMap } from "./agentQuota.js";
import type { AccountRow } from "./magpieCli.js";
import { emptyWindow, type QuotaWindow } from "./magpieQuota.js";

/** 智能体分区那枚额度徽标（d.282）：同一份账号数据，换个地方看。 */

const NOW = Date.parse("2026-11-18T10:00:00.000Z");

function win(patch: Partial<QuotaWindow>): QuotaWindow {
  return { ...emptyWindow(), ...patch };
}

function account(patch: Partial<AccountRow> & { agent: string; label: string }): AccountRow {
  return {
    active: true,
    on: true,
    windows: [],
    raw: {},
    ...patch,
  };
}

describe("智能体的额度徽标", () => {
  it("没有这个智能体的账号就不贴徽标", () => {
    expect(agentQuota([], "claude", NOW)).toBeNull();
    expect(agentQuota([account({ agent: "codex", label: "A" })], "claude", NOW)).toBeNull();
    expect(agentQuota([account({ agent: "claude", label: "A" })], null, NOW)).toBeNull();
  });

  it("取最紧的那个窗口说话", () => {
    const row = account({
      agent: "claude",
      label: "工作号",
      windows: [
        win({ name: "5 hours", used: 40, remaining: 60 }),
        win({ name: "week", used: 90, remaining: 10 }),
      ],
    });
    const quota = agentQuota([row], "claude", NOW);
    expect(quota?.label).toBe("剩 10%");
    expect(quota?.tone).toBe("danger");
    expect(quota?.accounts).toBe(1);
    expect(quota?.detail).toContain("5 小时 剩 60%");
    expect(quota?.detail).toContain("每周 剩 10%");
  });

  it("点数窗口按点数说，用完就说用完", () => {
    const partial = account({
      agent: "workbuddy",
      label: "小号",
      windows: [win({ name: "Month", used: 30, remaining: 70, amount: 3000, limit: 10000, unit: "credits" })],
    });
    expect(agentQuota([partial], "workbuddy", NOW)?.label).toBe("剩 7,000 点");

    const spent = account({
      agent: "workbuddy",
      label: "小号",
      windows: [win({ name: "Month", used: 100, remaining: 0, amount: 10000, limit: 10000, unit: "credits" })],
    });
    expect(agentQuota([spent], "workbuddy", NOW)?.label).toBe("额度用完");
    expect(agentQuota([spent], "workbuddy", NOW)?.tone).toBe("danger");
  });

  it("不限量、没窗口、读不到账号，各有各的说法", () => {
    const unlimited = account({
      agent: "copilot",
      label: "GitHub",
      windows: [win({ name: "month", unlimited: true })],
    });
    expect(agentQuota([unlimited], "copilot", NOW)).toMatchObject({ label: "不限量", tone: "ok" });

    const noWindows = account({ agent: "qoder", label: "阿里" });
    expect(agentQuota([noWindows], "qoder", NOW)).toMatchObject({ label: "额度未知", tone: "empty" });

    const broken = account({ agent: "qoder", label: "阿里", error: "接口 500" });
    expect(agentQuota([broken], "qoder", NOW)).toBeNull();
    const lapsed = account({ agent: "qoder", label: "阿里", lapsed: "2026-11-01" });
    expect(agentQuota([lapsed], "qoder", NOW)).toBeNull();
  });

  it("多个账号时把每个都写进悬停说明，太多就收尾", () => {
    const rows = ["一", "二", "三", "四"].map((name, index) =>
      account({
        agent: "claude",
        label: name,
        windows: [win({ name: "week", used: 20 * (index + 1), remaining: 80 - 20 * index })],
      }),
    );
    const quota = agentQuota(rows, "claude", NOW);
    expect(quota?.accounts).toBe(4);
    expect(quota?.label).toBe("剩 20%");
    expect(quota?.detail).toContain("一：");
    expect(quota?.detail).toContain("等 4 个账号");
  });

  it("整页一次算完，一个智能体一条", () => {
    const rows = [
      account({ agent: "claude", label: "A", windows: [win({ name: "week", used: 50, remaining: 50 })] }),
      account({ agent: "claude", label: "B", windows: [win({ name: "week", used: 10, remaining: 90 })] }),
      account({ agent: "workbuddy", label: "C", windows: [win({ name: "Month", used: 10, remaining: 90 })] }),
    ];
    const map = agentQuotaMap(rows, NOW);
    expect([...map.keys()]).toEqual(["claude", "workbuddy"]);
    expect(map.get("claude")?.accounts).toBe(2);
  });
});
