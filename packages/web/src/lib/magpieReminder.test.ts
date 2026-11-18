import { describe, expect, it } from "vitest";
import {
  BALANCE_ALERT_CHOICES,
  RESET_REMINDER_CHOICES,
  USAGE_ALERT_CHOICES,
  balanceAlertText,
  numberSetting,
  reminderArgs,
  reminderSummary,
  resetReminderText,
  usageAlertText,
} from "./magpieReminder.js";

/** 额度提醒（d.283、d.307）：内核的三个数字设置，页面只负责读写与说人话。 */

describe("额度提醒", () => {
  it("取值只给内核认识的档位（0 是关）", () => {
    expect([...USAGE_ALERT_CHOICES]).toEqual([0, 50, 70, 80, 90]);
    expect([...RESET_REMINDER_CHOICES]).toEqual([0, 3, 6, 12, 24]);
    expect([...BALANCE_ALERT_CHOICES]).toEqual([0, 1, 5, 10, 20]);
  });

  it("读设置：数字、数字字符串都认，其它当没设", () => {
    const values = new Map<string, unknown>([
      ["usageAlert", 80],
      ["resetReminder", "6"],
    ]);
    expect(numberSetting(values, "usageAlert")).toBe(80);
    expect(numberSetting(values, "resetReminder")).toBe(6);
    expect(numberSetting(values, "missing")).toBe(0);
    expect(numberSetting(new Map([["usageAlert", ""]]), "usageAlert")).toBe(0);
    expect(numberSetting(new Map([["usageAlert", true]]), "usageAlert")).toBe(0);
  });

  it("写回去是一条 settings set，值是字符串", () => {
    expect(reminderArgs("usageAlert", 80)).toEqual(["settings", "set", "usageAlert", "80"]);
    expect(reminderArgs("resetReminder", 0)).toEqual(["settings", "set", "resetReminder", "0"]);
    expect(reminderArgs("balanceAlert", 5)).toEqual(["settings", "set", "balanceAlert", "5"]);
  });

  it("文案说清提醒什么，0 就说关了", () => {
    expect(usageAlertText(0)).toContain("不提醒");
    expect(usageAlertText(80)).toBe("窗口用到 80% 时提醒一次");
    expect(resetReminderText(0)).toContain("不提醒");
    expect(resetReminderText(6)).toContain("6 小时");
    expect(balanceAlertText(0)).toContain("不提醒");
    expect(balanceAlertText(5)).toBe("余额低到 5 或更少时提醒一次，直到充值回来");
    expect(reminderSummary(0, 0)).toBe("三个提醒都关着");
    expect(reminderSummary(80, 6)).toBe("用到 80% 提醒；到期前 6 小时提醒还剩多少");
    expect(reminderSummary(0, 6)).toBe("到期前 6 小时提醒还剩多少");
    expect(reminderSummary(0, 0, 5)).toBe("余额低到 5 提醒");
    expect(reminderSummary(80, 0, 5)).toBe("用到 80% 提醒；余额低到 5 提醒");
  });
});
