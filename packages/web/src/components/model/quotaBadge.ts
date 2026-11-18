import type { QuotaTone } from "../../lib/magpieQuota.js";

/**
 * 额度徽标的一套配色（d.282 的智能体分区、d.284 的国内端卡片共用）：
 * 颜色只跟「剩下多少」走，和圈里别处的告警色保持一致——浅灰是还够用，
 * 黄是偏紧，红是用完，读不到额度也用浅灰（别用红色吓人，它只是没读到）。
 */
export const QUOTA_BADGE: Record<QuotaTone | "empty", string> = {
  ok: "bg-subtle-3 text-muted",
  warn: "bg-warn-soft text-warn",
  danger: "bg-danger-soft text-danger",
  empty: "bg-subtle-3 text-muted",
};
