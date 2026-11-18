import { describe, expect, it } from "vitest";
import {
  accountState,
  agentName,
  emptyWindow,
  formatCount,
  formatDuration,
  formatReadAt,
  formatResetIn,
  hasCount,
  hasQuota,
  latestReadAt,
  parseTime,
  relativeTime,
  resetsText,
  unitLabel,
  windowCountText,
  windowDetailText,
  windowLeftPercent,
  windowLeftText,
  windowName,
  windowPercent,
  windowTone,
  type QuotaWindow,
} from "./magpieQuota.js";

/** 订阅额度的文案层（d.278）：内核给机器字段，这里翻成人话，全是纯函数。 */

const NOW = Date.parse("2026-11-18T09:00:00Z");

/** 造一个窗口，只写关心的字段。 */
function window(patch: Partial<QuotaWindow>): QuotaWindow {
  return { ...emptyWindow(), name: "5 hours", used: 40, remaining: 60, ...patch };
}

describe("agentName", () => {
  it("按用户订的产品叫，不摊内核 id", () => {
    expect(agentName("claude")).toBe("Claude");
    expect(agentName("codex")).toBe("ChatGPT");
    expect(agentName("gemini")).toBe("Gemini");
    expect(agentName("antigravity")).toBe("Antigravity");
  });

  it("插件自己的 agent 原样显示；空值有兜底", () => {
    expect(agentName("some-plugin")).toBe("some-plugin");
    expect(agentName("  ")).toBe("账号");
  });
});

describe("windowName", () => {
  it("把内核的英文窗口名翻成中文", () => {
    expect(windowName("5 hours")).toBe("5 小时");
    expect(windowName("5h")).toBe("5 小时");
    expect(windowName("7 days")).toBe("7 天");
    expect(windowName("2 weeks")).toBe("2 周");
    expect(windowName("Week")).toBe("每周");
    expect(windowName("monthly")).toBe("每月");
    expect(windowName("Credits")).toBe("点数");
    expect(windowName("Extra usage")).toBe("额外用量");
  });

  it("认不出来的原样显示，空名兜底", () => {
    expect(windowName("Gemini pool")).toBe("Gemini pool");
    expect(windowName("")).toBe("额度");
  });
});

describe("windowPercent / windowLeftPercent / windowTone", () => {
  it("百分比取整并夹到 0-100", () => {
    expect(windowPercent(window({ used: 82.4 }))).toBe(82);
    expect(windowPercent(window({ used: -5 }))).toBe(0);
    expect(windowPercent(window({ used: 140 }))).toBe(100);
    expect(windowLeftPercent(window({ remaining: 18.6 }))).toBe(19);
  });

  it("按剩余定色调：10% 以下危险，25% 以下偏紧", () => {
    expect(windowTone(window({ remaining: 60 }))).toBe("ok");
    expect(windowTone(window({ remaining: 25 }))).toBe("warn");
    expect(windowTone(window({ remaining: 26 }))).toBe("ok");
    expect(windowTone(window({ remaining: 10 }))).toBe("danger");
    expect(windowTone(window({ remaining: 0 }))).toBe("danger");
  });

  it("不限量的窗口永远不报警", () => {
    expect(windowTone(window({ unlimited: true, remaining: 0 }))).toBe("ok");
    expect(windowLeftText(window({ unlimited: true, remaining: 0 }))).toBe("不限");
  });

  it("左侧结论：剩多少 / 已用完 / 厂商自己那句话", () => {
    expect(windowLeftText(window({ remaining: 42 }))).toBe("剩 42%");
    expect(windowLeftText(window({ remaining: 0 }))).toBe("已用完");
    expect(windowLeftText(window({ text: true, display: "In use", remaining: 0 }))).toBe("In use");
  });
});

describe("formatDuration / relativeTime", () => {
  it("时长分档：分钟 / 小时 / 天", () => {
    expect(formatDuration(30_000)).toBe("不到 1 分钟");
    expect(formatDuration(5 * 60_000)).toBe("5 分钟");
    expect(formatDuration(60 * 60_000)).toBe("1 小时");
    expect(formatDuration((60 + 12) * 60_000)).toBe("1 小时 12 分钟");
    expect(formatDuration(26 * 60 * 60_000)).toBe("1 天 2 小时");
    expect(formatDuration(48 * 60 * 60_000)).toBe("2 天");
    expect(formatDuration(0)).toBe("");
  });

  it("相对时间：带纳秒的时间戳也能读", () => {
    expect(relativeTime("2026-11-18T08:59:40.123456789Z", NOW)).toBe("刚刚");
    expect(relativeTime("2026-11-18T08:55:00Z", NOW)).toBe("5 分钟前");
    expect(relativeTime("bad", NOW)).toBe("");
    expect(relativeTime(undefined, NOW)).toBe("");
  });

  it("纳秒小数裁到毫秒再解析", () => {
    expect(parseTime("2026-11-18T09:00:00.123456789Z")).toBe(Date.parse("2026-11-18T09:00:00.123Z"));
    expect(parseTime("")).toBeNull();
  });
});

describe("formatResetIn / formatReadAt", () => {
  it("重置倒计时；已经过了就是马上重置", () => {
    expect(formatResetIn("2026-11-18T10:00:00Z", NOW)).toBe("1 小时后重置");
    expect(formatResetIn("2026-11-18T09:00:00Z", NOW)).toBe("马上重置");
    expect(formatResetIn("2026-11-18T08:00:00Z", NOW)).toBe("马上重置");
    expect(formatResetIn(null, NOW)).toBe("");
  });

  it("新读数与上次读数分开说", () => {
    expect(formatReadAt("2026-11-18T08:58:00Z", undefined, NOW)).toBe("读数 2 分钟前");
    expect(formatReadAt(undefined, "2026-11-18T08:00:00Z", NOW)).toBe("上次读数 1 小时前");
    expect(formatReadAt(undefined, undefined, NOW)).toBe("");
  });
});

describe("windowDetailText", () => {
  it("厂商写法 + 重置倒计时，用「·」接", () => {
    expect(
      windowDetailText(window({ display: "82% used", resetsAt: "2026-11-18T10:00:00Z" }), NOW),
    ).toBe("82% used · 1 小时后重置");
    expect(windowDetailText(window({ display: "" }), NOW)).toBe("");
  });

  it("text 窗口左侧已经显示那句话时，右侧不重复", () => {
    const display = "In use";
    const text = window({ text: true, display, remaining: 100, resetsAt: "2026-11-18T10:00:00Z" });
    expect(windowLeftText(text)).toBe(display);
    expect(windowDetailText(text, NOW)).toBe("1 小时后重置");
  });

  it("不限量只留厂商写法", () => {
    expect(
      windowDetailText(window({ unlimited: true, display: "Unlimited", resetsAt: "2026-11-18T10:00:00Z" }), NOW),
    ).toBe("Unlimited");
  });
});

describe("点数窗口（WorkBuddy、MiniMax 这类端点数据）", () => {
  const credits = window({
    name: "Month",
    used: 30,
    remaining: 70,
    amount: 3000,
    limit: 10000,
    unit: "credits",
    display: "3k / 10k",
  });

  it("formatCount 加千分位，unitLabel 把 credits 说成点", () => {
    expect(formatCount(3000)).toBe("3,000");
    expect(formatCount(0)).toBe("0");
    expect(formatCount(1234567)).toBe("1,234,567");
    expect(formatCount(Number.NaN)).toBe("0");
    expect(unitLabel("credits")).toBe("点");
    expect(unitLabel("Credits")).toBe("点");
    expect(unitLabel("tokens")).toBe("tokens");
    expect(unitLabel("")).toBe("");
  });

  it("有 limit 与 amount 才算点数窗口", () => {
    expect(hasCount(credits)).toBe(true);
    expect(hasCount(window({ amount: 10 }))).toBe(false);
    expect(hasCount(window({ limit: 0, amount: 0 }))).toBe(false);
    expect(hasCount(window({ limit: 10, amount: null }))).toBe(false);
  });

  it("三个方向的说法：已用 / 剩 / 共", () => {
    expect(windowCountText(credits, "used")).toBe("3,000 点");
    expect(windowCountText(credits, "left")).toBe("7,000 点");
    expect(windowCountText(credits, "total")).toBe("10,000 点");
    expect(windowCountText(window({}), "left")).toBe("");
  });

  it("结论先说点数，不把「剩 70%」当结论", () => {
    expect(windowLeftText(credits)).toBe("剩 7,000 点");
    expect(windowLeftText(window({ ...credits, amount: 10000 }))).toBe("已用完");
    expect(windowLeftText(window({ ...credits, amount: -5 }))).toBe("剩 10,000 点");
    expect(windowLeftText(window({ ...credits, amount: 20000 }))).toBe("已用完");
  });

  it("明细写「已用 / 共」，不抄厂商的 3k / 10k", () => {
    expect(windowDetailText(credits, NOW)).toBe("已用 3,000 点 / 共 10,000 点");
    expect(
      windowDetailText(window({ ...credits, resetsAt: "2026-11-18T10:00:00Z" }), NOW),
    ).toBe("已用 3,000 点 / 共 10,000 点 · 1 小时后重置");
  });
});

describe("resetsText", () => {
  it("Codex 可手动重置次数（带到期时间）", () => {
    expect(resetsText({ count: 2, until: "2026-11-18T10:00:00Z" }, NOW)).toBe(
      "可手动重置 2 次（1 小时后到期）",
    );
    expect(resetsText({ count: 2, until: "2026-11-18T08:00:00Z" }, NOW)).toBe(
      "可手动重置 2 次（已经到期）",
    );
    expect(resetsText({ count: 1 }, NOW)).toBe("可手动重置 1 次");
  });

  it("没有次数就不出现这一行", () => {
    expect(resetsText(undefined, NOW)).toBe("");
    expect(resetsText({ count: 0 }, NOW)).toBe("");
  });
});

describe("accountState", () => {
  it("优先级：读不到 > 登录失效 > 在用 > 接手 > 已登录 > 备用", () => {
    expect(accountState({ active: true, on: true, error: "boom" })).toMatchObject({
      tone: "danger",
      label: "读不到",
      detail: "boom",
    });
    expect(accountState({ active: true, on: true, lapsed: "token expired" }).label).toBe("登录失效");
    expect(accountState({ active: true, on: true })).toMatchObject({ tone: "info", label: "在用" });
    expect(accountState({ active: false, on: true })).toMatchObject({ tone: "info", label: "接手" });
    expect(accountState({ active: true, on: false })).toMatchObject({ tone: "muted", label: "已登录" });
    expect(accountState({ active: false, on: false })).toMatchObject({ tone: "muted", label: "备用" });
  });

  it("徽标只有两个字，原因放在 detail 里", () => {
    expect(accountState({ active: false, on: true }).detail).toContain("自动换到它");
  });
});

describe("hasQuota / latestReadAt", () => {
  it("没有窗口时页面只说额度未知", () => {
    expect(hasQuota([])).toBe(false);
    expect(hasQuota(undefined)).toBe(false);
    expect(hasQuota([window({})])).toBe(true);
  });

  it("卡头取最新的那次读数", () => {
    expect(
      latestReadAt(
        [{ readAt: "2026-11-18T08:00:00Z" }, { readAt: "2026-11-18T08:58:00Z" }],
        NOW,
      ),
    ).toBe("最近读数 2 分钟前");
    expect(latestReadAt([{ asOf: "2026-11-18T08:30:00Z" }], NOW)).toBe("最近读数 30 分钟前");
    expect(latestReadAt([], NOW)).toBe("");
  });
});
