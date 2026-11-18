/**
 * 每个账号用多少就换下一个（内核的 `provider account-cap`）。
 *
 * 内核把上限读作「窗口用到这个份额就不再动它，让下一个账号接上」：`MinCap=1`–`MaxCap=99`，
 * `off`（或 0）表示不设上限、一直用到 100%。数据落在内核设置里，只能靠这条命令读——
 * 它的文本输出是「<账号> · capped at 80% of each usage window」与「<账号> · no cap: used to 100%」。
 */
import { stripAnsi } from "./magpieCli.js";

/** 候选档位：0 表示不设上限。 */
export const CAP_CHOICES: readonly number[] = [0, 50, 70, 80, 90];

/** 档位的中文说法：下拉选项与提示条共用。 */
export function capText(cap: number): string {
  if (!Number.isFinite(cap) || cap <= 0) return "不设上限";
  return `用到 ${Math.round(cap)}%`;
}

/** 从 `provider account-cap <id>` 的输出里读每个账号的档位（键为小写账号名）。 */
export function parseAccountCaps(output: string): Map<string, number> {
  const caps = new Map<string, number>();
  for (const raw of stripAnsi(output || "").split(/\r?\n/)) {
    if (!raw.trim() || /^\s/.test(raw)) continue; // 缩进的「某个窗口单独设」不在这里读
    const capped = /^(.*?)\s+·\s+capped at (\d+)%/i.exec(raw.trim());
    if (capped) {
      const key = capped[1]?.trim().toLowerCase() ?? "";
      const value = Number(capped[2]);
      if (key && Number.isFinite(value)) caps.set(key, value);
      continue;
    }
    const none = /^(.*?)\s+·\s+no cap/i.exec(raw.trim());
    if (none) {
      const key = none[1]?.trim().toLowerCase() ?? "";
      if (key) caps.set(key, 0);
    }
  }
  return caps;
}

/** 写档位的命令：0 走 `off`，其余给百分比。 */
export function capArgs(agent: string, user: string, cap: number): string[] {
  return ["provider", "account-cap", agent, user, cap > 0 ? String(Math.round(cap)) : "off"];
}

/** 下拉里要摆的档位：当前值不在候选里时补进去，按大小排好。 */
export function capOptions(current: number | undefined): number[] {
  const value = current && current > 0 ? Math.round(current) : 0;
  const all = CAP_CHOICES.includes(value) ? [...CAP_CHOICES] : [...CAP_CHOICES, value];
  return [...new Set(all)].sort((a, b) => a - b);
}