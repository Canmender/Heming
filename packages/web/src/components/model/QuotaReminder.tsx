import type {
  BalanceAlertValue,
  ResetReminderValue,
  UsageAlertValue,
} from "../../lib/magpieReminder.js";
import {
  BALANCE_ALERT_CHOICES,
  RESET_REMINDER_CHOICES,
  USAGE_ALERT_CHOICES,
  balanceAlertText,
  numberSetting,
  reminderSummary,
  resetReminderText,
  usageAlertText,
} from "../../lib/magpieReminder.js";
import { resetLeadLabel, resetLeadOptions } from "../../lib/autoReset.js";

/** 订阅账号卡底部的三枚提醒（d.283、d.307）：都是内核设置，没有自己的状态。 */

export interface QuotaReminderProps {
  /** 已读的 `settings list --json`，三个键都在里面。 */
  values: ReadonlyMap<string, unknown>;
  disabled: boolean;
  onChange: (key: "usageAlert" | "resetReminder" | "balanceAlert", value: number) => void;
  /**
   * 「快过期时提前多久花」（`quota auto-reset lead`），分钟。
   * **null = 不显示这一项**：只有真有账号会在快过期时自动花掉，这个提前量才影响行为。
   */
  lead?: number | null;
  onLeadChange?: (minutes: number) => void;
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

const BALANCE_LABEL: Record<number, string> = {
  0: "不提醒余额",
  1: "低到 1",
  5: "低到 5",
  10: "低到 10",
  20: "低到 20",
};

export function QuotaReminder({
  values,
  disabled,
  onChange,
  lead = null,
  onLeadChange,
}: QuotaReminderProps) {
  const usage = numberSetting(values, "usageAlert");
  const reset = numberSetting(values, "resetReminder");
  const balance = numberSetting(values, "balanceAlert");

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
        <label className="flex items-center gap-2 ui-caption">
          余额少
          <select
            className="ui-input w-36"
            aria-label="余额快用完时提醒"
            value={String(balance)}
            disabled={disabled}
            title={balanceAlertText(balance)}
            onChange={(event) => onChange("balanceAlert", Number(event.target.value))}
          >
            {BALANCE_ALERT_CHOICES.map((value) => (
              <option key={value} value={value}>
                {BALANCE_LABEL[value] ?? balanceAlertText(value as BalanceAlertValue)}
              </option>
            ))}
          </select>
        </label>
        {lead !== null && onLeadChange && (
          // 只在真有账号会「快过期时自动花掉」时才出现：否则这个提前量调了也看不出任何变化。
          <label className="flex items-center gap-2 ui-caption">
            重置提前
            <select
              className="ui-input w-36"
              aria-label="重置快过期时提前多久花"
              title="一份重置在到期前这么久还没用上，内核就替你花掉；只对选了「快过期就花」的账号生效"
              value={String(lead)}
              disabled={disabled}
              onChange={(event) => onLeadChange(Number(event.target.value))}
            >
              {resetLeadOptions(lead).map((minutes) => (
                <option key={minutes} value={minutes}>
                  {resetLeadLabel(minutes)}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      <p className="mt-2 ui-caption">
        {reminderSummary(usage, reset, balance)}
        {balance > 0 && "（余额按各自的币种或点数算）"}
      </p>
    </div>
  );
}
