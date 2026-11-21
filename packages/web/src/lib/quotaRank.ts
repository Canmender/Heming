import type { AccountRow } from "./magpieCli.js";
import { agentName, windowLeftPercent } from "./magpieQuota.js";

/**
 * 一句话说清「现在哪个账号最宽裕、哪个最紧」。
 *
 * 「来源」页把每个账号的每一份额度都画成了进度条，账号一多就得自己扫一遍才知道
 * 该往哪儿放活、谁快用完了。这里只回答那个问题，不给建议——换号仍由人决定。
 *
 * 只比「有确定余量」的窗口：不限量的说不清比例，只有厂商原话的（`text` 行）没有数，
 * 登录失效或读不到的账号也不参与，免得把「不知道」算成「最紧」。
 */
export interface RankEntry {
  agent: string;
  label: string;
  /** 这个账号最紧的那一份还剩多少（0..100）。 */
  left: number;
}

export interface RankText {
  text: string;
  tone: "danger" | "warn" | "muted";
}

/** 一个账号最紧的那份余量；没有可比窗口时 null。 */
export function tightestLeft(row: AccountRow): number | null {
  let tight: number | null = null;
  for (const window of row.windows) {
    if (window.unlimited || window.text) continue;
    const left = windowLeftPercent(window);
    if (!Number.isFinite(left)) continue;
    if (tight === null || left < tight) tight = left;
  }
  return tight;
}

/** 按「最紧的那份余量」从宽到紧排序；读不到、失效、没有可比窗口的账号不在里面。 */
export function rankAccounts(rows: readonly AccountRow[]): RankEntry[] {
  const ranked: RankEntry[] = [];
  for (const row of rows) {
    if (row.lapsed || row.error) continue;
    const left = tightestLeft(row);
    if (left === null) continue;
    ranked.push({ agent: row.agent, label: row.label, left });
  }
  return ranked.sort((a, b) => b.left - a.left || a.label.localeCompare(b.label));
}

function nameOf(entry: RankEntry): string {
  return `${agentName(entry.agent)} ${entry.label}`;
}

function percent(value: number): string {
  return `${Math.round(value)}%`;
}

/**
 * 至少两个可比账号才给一句话（只有一个时说「最宽裕的也是它」没有意义）。
 * `roomy` 保留前两名，`others` 报个数，与额度走向那句的写法一致。
 */
export function rankText(rows: readonly AccountRow[]): RankText | null {
  const ranked = rankAccounts(rows);
  if (ranked.length < 2) return null;
  const roomy = ranked[0];
  const tight = ranked[ranked.length - 1];
  if (!roomy || !tight || roomy === tight) return null;
  const sameSpot = roomy.left === tight.left;
  const head = sameSpot
    ? `${ranked.length} 个账号都差不多，最宽的 ${nameOf(roomy)} 也只剩 ${percent(roomy.left)}`
    : `最宽裕的是 ${nameOf(roomy)}（剩 ${percent(roomy.left)}）；最紧的是 ${nameOf(tight)}（剩 ${percent(tight.left)}）`;
  // 全部并列时所有账号都是「同一档」，根本没有"中间"这一组，别自相矛盾。
  const middle = sameSpot ? 0 : ranked.length - 2;
  const tail = middle > 0 ? `；还有 ${middle} 个在中间` : "";
  const tone = sameSpot
    ? roomy.left <= 10
      ? "danger"
      : roomy.left <= 25
        ? "warn"
        : "muted"
    : tight.left <= 10
      ? "danger"
      : tight.left <= 25
        ? "warn"
        : "muted";
  return { text: `${head}${tail}`, tone };
}