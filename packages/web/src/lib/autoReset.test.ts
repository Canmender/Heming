import { describe, expect, it } from "vitest";
import {
  AUTO_RESET_LEVELS,
  autoResetArgs,
  autoResetLevelText,
  parseAutoReset,
  parseResetLead,
  resetLeadArgs,
  resetLeadLabel,
  resetLeadOptions,
  spendsExpiringResets,
} from "./autoReset.js";

describe("parseAutoReset", () => {
  it("没有账号自己花时是一张空表", () => {
    expect(
      parseAutoReset("no Codex account uses a reset by itself · magpie quota auto-reset <account> on"),
    ).toEqual(new Map());
  });

  it("空输出与坏输出都不当成有账号", () => {
    expect(parseAutoReset("")).toEqual(new Map());
    expect(parseAutoReset("magpie quota auto-reset")).toEqual(new Map());
  });

  it("两档都开的账号读成 both", () => {
    const levels = parseAutoReset(
      "● me@example.com  uses a reset by itself when its week runs out, or before one expires",
    );
    expect(levels.get("me@example.com")).toBe("both");
  });

  it("只开周用完之后读成 week，只开快过期读成 expiring", () => {
    expect(
      parseAutoReset("● me@example.com  uses a reset by itself when its week runs out").get(
        "me@example.com",
      ),
    ).toBe("week");
    expect(
      parseAutoReset("● me@example.com  uses a reset by itself before one expires").get(
        "me@example.com",
      ),
    ).toBe("expiring");
  });

  it("多个账号各读各的，邮箱统一小写", () => {
    const levels = parseAutoReset(
      [
        "● Work@Example.com  uses a reset by itself when its week runs out",
        "● other@example.com  uses a reset by itself when its week runs out, or before one expires",
      ].join("\n"),
    );
    expect(levels.size).toBe(2);
    expect(levels.get("work@example.com")).toBe("week");
    expect(levels.get("other@example.com")).toBe("both");
  });

  it("带颜色的输出也能读", () => {
    const levels = parseAutoReset(
      "\u001b[32m●\u001b[0m me@example.com \u001b[2muses a reset by itself before one expires\u001b[0m",
    );
    expect(levels.get("me@example.com")).toBe("expiring");
  });
});

describe("autoResetArgs", () => {
  it("关掉只发一条", () => {
    expect(autoResetArgs("me@example.com", "off")).toEqual([
      ["quota", "auto-reset", "me@example.com", "off"],
    ]);
  });

  it("两档都开只发一条 on", () => {
    expect(autoResetArgs("me@example.com", "both")).toEqual([
      ["quota", "auto-reset", "me@example.com", "on"],
    ]);
  });

  it("只开一档时把另一档显式关掉，否则会变成两档都开", () => {
    expect(autoResetArgs("me@example.com", "week")).toEqual([
      ["quota", "auto-reset", "me@example.com", "week", "on"],
      ["quota", "auto-reset", "me@example.com", "expiring", "off"],
    ]);
    expect(autoResetArgs("me@example.com", "expiring")).toEqual([
      ["quota", "auto-reset", "me@example.com", "expiring", "on"],
      ["quota", "auto-reset", "me@example.com", "week", "off"],
    ]);
  });
});

describe("autoResetLevelText", () => {
  it("每一档都说成一句人话", () => {
    expect(AUTO_RESET_LEVELS.map(autoResetLevelText)).toEqual([
      "不自己花",
      "周额度用完就花",
      "快过期就花",
      "两种时候都花",
    ]);
  });
});

describe("parseResetLead", () => {
  it("默认那句话说成 30 分钟", () => {
    expect(
      parseResetLead("a reset about to expire unused is used 30m before it expires (the default)"),
    ).toBe(30);
  });

  it("整小时与小时加分钟都认", () => {
    expect(parseResetLead("a reset about to expire unused is used 3h before it expires")).toBe(180);
    expect(parseResetLead("a reset about to expire unused is used 1h30m before it expires")).toBe(90);
  });

  it("认不出就给 null，页面宁可不显示这一项", () => {
    expect(parseResetLead("")).toBeNull();
    expect(parseResetLead("magpie quota auto-reset lead")).toBeNull();
  });

  it("带颜色的输出也能读", () => {
    expect(
      parseResetLead("\u001b[2ma reset about to expire unused is used 5m before it expires\u001b[0m"),
    ).toBe(5);
  });
});

describe("resetLeadArgs", () => {
  it("默认值发 default，别的值按分钟或小时发", () => {
    expect(resetLeadArgs(30)).toEqual(["quota", "auto-reset", "lead", "default"]);
    expect(resetLeadArgs(5)).toEqual(["quota", "auto-reset", "lead", "5m"]);
    expect(resetLeadArgs(120)).toEqual(["quota", "auto-reset", "lead", "2h"]);
    expect(resetLeadArgs(90)).toEqual(["quota", "auto-reset", "lead", "1h30m"]);
  });
});

describe("resetLeadLabel", () => {
  it("默认档写清楚它是默认", () => {
    expect(resetLeadLabel(30)).toBe("30 分钟（默认）");
    expect(resetLeadLabel(3)).toBe("3 分钟");
    expect(resetLeadLabel(120)).toBe("2 小时");
    expect(resetLeadLabel(90)).toBe("1 小时 30 分钟");
  });
});

describe("resetLeadOptions", () => {
  it("当前值不在候选里也补进去，免得下拉显示成别的档", () => {
    expect(resetLeadOptions(45)).toContain(45);
    expect(resetLeadOptions(45)).toEqual([...resetLeadOptions(45)].sort((a, b) => a - b));
    expect(resetLeadOptions(30)).toEqual([3, 5, 10, 15, 30, 60, 120, 180, 360, 720, 1440]);
    expect(resetLeadOptions(null)).toEqual([3, 5, 10, 15, 30, 60, 120, 180, 360, 720, 1440]);
  });
});

describe("spendsExpiringResets", () => {
  it("只有 expiring / both 才让「提前多久」有意义", () => {
    expect(spendsExpiringResets(new Map())).toBe(false);
    expect(spendsExpiringResets(new Map([["a@b.c", "week" as const]]))).toBe(false);
    expect(spendsExpiringResets(new Map([["a@b.c", "expiring" as const]]))).toBe(true);
    expect(
      spendsExpiringResets(
        new Map([
          ["a@b.c", "week" as const],
          ["d@e.f", "both" as const],
        ]),
      ),
    ).toBe(true);
  });
});