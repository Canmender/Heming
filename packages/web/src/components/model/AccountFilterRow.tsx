import { Button } from "../ui/Button.js";
import {
  ACCOUNT_FILTER_MIN,
  ACCOUNT_FILTERS,
  accountFilterCounts,
  type AccountFilter,
} from "../../lib/accountFilter.js";
import type { AccountRow } from "../../lib/magpieCli.js";

export interface AccountFilterRowProps {
  rows: readonly AccountRow[];
  value: AccountFilter;
  onChange: (filter: AccountFilter) => void;
}

/**
 * 账号攒到半屏以上时，给一排「只看这类」的按钮。
 *
 * 两个取舍：
 *   · 不到 `ACCOUNT_FILTER_MIN` 个账号就直接不渲染——三个账号一眼看完，
 *     多一排按钮只是多一次点击；
 *   · 条数为 0 的那档不出现（「全部」除外）：点进去必然空空如也的按钮不算功能。
 */
export function AccountFilterRow({ rows, value, onChange }: AccountFilterRowProps) {
  if (rows.length < ACCOUNT_FILTER_MIN) return null;
  const counts = accountFilterCounts(rows);
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2" role="group" aria-label="按状态筛选账号">
      {ACCOUNT_FILTERS.map((option) => {
        const count = counts[option.id];
        if (count === 0 && option.id !== "all") return null;
        const selected = value === option.id;
        return (
          <Button
            key={option.id}
            size="sm"
            variant={selected ? "primary" : "ghost"}
            aria-pressed={selected}
            onClick={() => onChange(option.id)}
          >
            {option.label}
            <span className="ui-numeric ml-1 opacity-70">{count}</span>
          </Button>
        );
      })}
    </div>
  );
}