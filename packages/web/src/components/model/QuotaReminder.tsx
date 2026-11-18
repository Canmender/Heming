import type { ResetReminderValue, UsageAlertValue } from "../../lib/magpieReminder.js";
import {
  RESET_REMINDER_CHOICES,
  USAGE_ALERT_CHOICES,
  numberSetting,
  reminderSummary,
  resetReminderText,
  usageAlertText,
} from "../../lib/magpieReminder.js";

/** 订阅账号卡底部的两枚提醒（d.283）：都是内核设置，没有自己的状态。 */

export interface QuotaReminderProps {
  /** 已读的 `settings list --json`，两个键都在里面。 */
  values: ReadonlyMap<string, unknown>;
  disabled: boolean;
  onChange: (key: "usageAlert" | "resetReminder", value: number) => void;
}

const USAGE_LABEL: Record<number, string> = {
  0: "不提醒快用完",
  50: "用到一半时提醒",
  70: "用到 70% 时提醒",
  80: "用到 80% 时提醒",
  90: "用到 90% 时提醒",
};

const RESET_LABEL: Record<number, string> = {
  0: "不提醒快到期",
  3: "到期前 3 小时",
  6: "到期前 6 小时",
  12: "到期前 12 小时",
  24: "到期前 24 小时",
};

export function QuotaReminder({ values, disabled, onChange }: QuotaReminderProps) {
  const usage = numberSetting(values, "usageAlert");
  const reset = numberSetting(values, "resetReminder");

  return (
    <div className="mt-3 rounded-xl border border-line bg-subtle px-3 py-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-ui-md font-semibold">额度提醒</span>
        <span className="ui-caption">免费额度不用就清零，提醒一下还能赶在到期前花完</span>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2">
        <label className="flex items-center gap-2 ui-caption">
          快用完
          <select
            className="ui-input w-36"
            aria-label="额度快用完时提醒"
            value={String(usage)}
            disabled={disabled}
            title={usageAlertText(usage)}
            onChange={(event) => onChange("usageAlert", Number(event.target.value))}
          >
            {USAGE_ALERT_CHOICES.map((value) => (
              <option key={value} value={value}>
                {USAGE_LABEL[value] ?? usageAlertText(value as UsageAlertValue)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 ui-caption">
          快到期
          <select
            className="ui-input w-36"
            aria-label="额度快到期时提醒"
            value={String(reset)}
            disabled={disabled}
            title={resetReminderText(reset)}
            onChange={(event) => onChange("resetReminder", Number(event.target.value))}
          >
            {RESET_REMINDER_CHOICES.map((value) => (
              <option key={value} value={value}>
                {RESET_LABEL[value] ?? resetReminderText(value as ResetReminderValue)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="mt-2 ui-caption">{reminderSummary(usage, reset)}</p>
    </div>
  );
}
