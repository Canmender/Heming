import { describe, expect, it } from "vitest";
import { CAP_CHOICES, capArgs, capOptions, capText, parseAccountCaps } from "./accountCap.js";

describe("accountCap", () => {
  it("从内核的散文里读出每个账号的档位", () => {
    const caps = parseAccountCaps(
      [
        "work@example.com · capped at 80% of each usage window",
        "  week · capped at 50%", // 单独给某个窗口设的，不归这里
        "gpt@example.com · no cap: used to 100%",
      ].join("\n"),
    );
    expect(caps.get("work@example.com")).toBe(80);
    expect(caps.get("gpt@example.com")).toBe(0);
    expect(caps.size).toBe(2);
  });

  it("带颜色的输出也能读", () => {
    expect(parseAccountCaps("\u001b[2mwork@example.com\u001b[0m · capped at 70% of each usage window").get("work@example.com")).toBe(70);
  });

  it("认不出来就说没读到，不猜", () => {
    expect(parseAccountCaps("").size).toBe(0);
    expect(parseAccountCaps("claude has no account").size).toBe(0);
  });

  it("写档位的命令：0 走 off，其余给百分比", () => {
    expect(capArgs("claude", "work@example.com", 80)).toEqual([
      "provider",
      "account-cap",
      "claude",
      "work@example.com",
      "80",
    ]);
    expect(capArgs("claude", "work@example.com", 0)).toEqual([
      "provider",
      "account-cap",
      "claude",
      "work@example.com",
      "off",
    ]);
  });

  it("档位说法", () => {
    expect(capText(0)).toBe("不设上限");
    expect(capText(80)).toBe("用到 80%");
  });

  it("当前值不在候选里时补进去并排好", () => {
    expect(capOptions(undefined)).toEqual([...CAP_CHOICES]);
    expect(capOptions(45)).toEqual([0, 45, 50, 70, 80, 90]);
    expect(capOptions(80)).toEqual([...CAP_CHOICES]);
  });
});