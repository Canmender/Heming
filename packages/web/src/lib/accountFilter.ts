import type { AccountRow } from "./magpieCli.js";
import { windowTone } from "./magpieQuota.js";

/**
 * 订阅账号多于几个才给筛选项。
 *
 * 三个账号时一眼看完，加一排按钮只是多一次点击；真正需要「只看快用完的」
 * 是在账号攒到半屏以后。这个门槛放在这里，页面与测试读的是同一个数。
 */
export const ACCOUNT_FILTER_MIN = 6;

export type AccountFilter = "all" | "ready" | "low" | "lapsed";
/** 非「全部」的三档：一个账号只归其中一档，加起来正好是全部。 */
export type AccountBucket = Exclude<AccountFilter, "all">;

export interface AccountFilterOption {
  id: AccountFilter;
  label: string;
}

/**
 * 顺序即优先级：先看真正需要动手的（要重新登录、快用完），再看其余的。
 * 「全部」永远在最前，方便一键回到全貌。
 */
export const ACCOUNT_FILTERS: readonly AccountFilterOption[] = [
  { id: "all", label: "全部" },
  { id: "lapsed", label: "要重新登录" },
  { id: "low", label: "快用完" },
  { id: "ready", label: "还有余量" },
];

/**
 * 这个账号归哪一档。
 *
 * 判定顺序是有意的：
 *   · 登录失效或读不到额度的，先算「要重新登录」——额度数字本来就不可信，
 *     说「快用完」会把一个登录问题说成用量问题；
 *   · 只要有一个窗口紧（剩余 ≤ 25%，与进度条同一套色调）就是「快用完」；不限量的、
 *     只有厂商原话的窗口没有百分比可判，跳过；
 *   · 其余都算「还有余量」：不限量的、只有厂商原话的，也在这里。
 */
export function accountBucket(row: AccountRow): AccountBucket {
  if (row.lapsed || row.error) return "lapsed";
  const tight = row.windows.some((window) => {
    if (window.unlimited || window.text) return false;
    const tone = windowTone(window);
    return tone === "warn" || tone === "danger";
  });
  return tight ? "low" : "ready";
}

/** 各档的条数；`all` 是总数，等于三档之和。 */
export function accountFilterCounts(rows: readonly AccountRow[]): Record<AccountFilter, number> {
  const counts: Record<AccountFilter, number> = { all: rows.length, ready: 0, low: 0, lapsed: 0 };
  for (const row of rows) counts[accountBucket(row)] += 1;
  return counts;
}

export function filterAccounts(rows: readonly AccountRow[], filter: AccountFilter): AccountRow[] {
  if (filter === "all") return [...rows];
  return rows.filter((row) => accountBucket(row) === filter);
}

/** 筛完之后一句「这几条是什么」，用在列表为空时的说明里。 */
export function accountFilterEmptyText(filter: AccountFilter): string {
  switch (filter) {
    case "lapsed":
      return "这个筛选下没有失效的账号：现在登录着的都还能用。";
    case "low":
      return "这个筛选下没有快用完的账号：剩下这些都很宽裕。";
    case "ready":
      return "这个筛选下没有还有余量的账号：额度都紧，或者登录已经失效。";
    case "all":
      return "还没有账号。";
  }
}