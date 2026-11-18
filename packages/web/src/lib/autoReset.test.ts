import { describe, expect, it } from "vitest";
import { AUTO_RESET_LEVELS, autoResetArgs, autoResetLevelText, parseAutoReset } from "./autoReset.js";

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