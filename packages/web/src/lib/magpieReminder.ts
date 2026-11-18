/**
 * 额度提醒（d.283）：内核有两个「到点会说话」的设置，加压在这里之前，页面没有出口。
 *
 * - `usageAlert`：一个窗口用到这个百分比时提醒一次（0 = 关）；
 * - `resetReminder`：到期前这么多小时提醒「还有多少会作废」（0 = 关），
 *   专门为「免费额度不用就清零」这件事准备的——它提醒的是还剩多少没花完。
 *
 * 两个键都是内核 `settings` 里的真键，取值是数字（真机验证过写入与回读）。
 */

export const USAGE_ALERT_CHOICES = [0, 50, 70, 80, 90] as const;
export const RESET_REMINDER_CHOICES = [0, 3, 6, 12, 24] as const;

export type UsageAlertValue = (typeof USAGE_ALERT_CHOICES)[number];
export type ResetReminderValue = (typeof RESET_REMINDER_CHOICES)[number];

/** 设置值读出来可能是数字、数字字符串，其它一律当没设（0 = 关）。 */
export function numberSetting(values: ReadonlyMap<string, unknown>, key: string): number {
  const value = values.get(key);
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return 0;
}

export function usageAlertText(value: number): string {
  return value > 0 ? `窗口用到 ${value}% 时提醒一次` : "不提醒额度快用完";
}

export function resetReminderText(value: number): string {
  return value > 0 ? `窗口到期前 ${value} 小时提醒还剩多少没花` : "不提醒「快到期了还剩多少」";
}

/** 写回去只用一条 `settings set`，值转成字符串——内核这两种键都收。 */
export function reminderArgs(key: "usageAlert" | "resetReminder", value: number): string[] {
  return ["settings", "set", key, String(value)];
}

/** 一行说清现在提醒什么，给卡片底部的小字用。 */
export function reminderSummary(usage: number, reset: number): string {
  const parts: string[] = [];
  if (usage > 0) parts.push(`用到 ${usage}% 提醒`);
  if (reset > 0) parts.push(`到期前 ${reset} 小时提醒还剩多少`);
  return parts.length > 0 ? parts.join("；") : "两个提醒都关着";
}
