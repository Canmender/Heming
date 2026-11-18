import { formatResetIn, windowName } from "../../lib/magpieQuota.js";
import type { MergedAgent } from "../../lib/mergedQuota.js";
import { QUOTA_BADGE } from "./quotaBadge.js";

/**
 * 几个账号读成一行（d.294）：省得对着两三行自己心算。
 * 口径写在每枚徽标的 title 里：份额是同一计划的平均，点数是合计。
 */

export interface MergedQuotaStripProps {
  groups: readonly MergedAgent[];
  now: number;
}

export function MergedQuotaStrip({ groups, now }: MergedQuotaStripProps) {
  if (groups.length === 0) return null;
  return (
    <ul className="mt-3 space-y-1.5" aria-label="账号合计">
      {groups.map((group) => (
        <li key={group.agent} className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-ui-sm font-medium">{group.label}</span>
          <span className="ui-caption">{group.accounts} 个账号</span>
          {group.windows.map((window) => {
            const resets = window.resetsAt ? formatResetIn(new Date(window.resetsAt).toISOString(), now) : "";
            const title = resets ? `${window.detail} · 最早 ${resets}` : window.detail;
            return (
              <span
                key={`${group.agent}-${window.name}`}
                className={`ui-chip ${QUOTA_BADGE[window.tone]}`}
                title={title}
              >
                {windowName(window.name)} {window.text}
              </span>
            );
          })}
        </li>
      ))}
    </ul>
  );
}
