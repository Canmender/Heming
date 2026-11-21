import type { AccountRow } from "./magpieCli.js";
import {
  formatResetIn,
  windowLeftPercent,
  windowLeftText,
  windowName,
  windowTone,
  type QuotaTone,
} from "./magpieQuota.js";

/** 智能体分区里每行贴的那枚额度徽标（d.282）：把「来源」的账号数据带到「智能体」来。 */

export interface AgentQuota {
  /** 这个智能体登录了几个订阅账号。 */
  accounts: number;
  /** 徽标上的短文案，例如「剩 18%」「剩 7,000 点」。 */
  label: string;
  /** 徽标颜色：还有余量 / 偏紧 / 用完；读数缺失时是 empty。 */
  tone: QuotaTone | "empty";
  /** 悬停时的完整说明：每个账号、每个窗口、什么时候重置。 */
  detail: string;
}

/** 读不到额度的账号不进徽标（它们已经在自己那一行说清了原因）。 */
function usable(row: AccountRow): boolean {
  return !row.error && !row.lapsed;
}

function accountDetail(row: AccountRow, now: number): string {
  if (row.windows.length === 0) return `${row.label}：额度未知`;
  const parts = row.windows.map((window) => {
    const reset = formatResetIn(window.resetsAt, now);
    return `${windowName(window.name)} ${windowLeftText(window)}${reset ? `，${reset}` : ""}`;
  });
  return `${row.label}：${parts.join("，")}`;
}

export function agentQuota(rows: readonly AccountRow[], agentId: string | null, now: number): AgentQuota | null {
  if (!agentId) return null;
  const mine = rows.filter((row) => row.agent === agentId);
  if (mine.length === 0) return null;
  const readable = mine.filter(usable);
  if (readable.length === 0) return null;

  const windows = readable.flatMap((row) => row.windows);
  if (windows.length === 0) {
    return {
      accounts: readable.length,
      label: "额度未知",
      tone: "empty",
      detail: readable.map((row) => `${row.label}：这次没读到额度`).join("；"),
    };
  }

  // text 窗口的 display 是一句话（如 "In use"），used/remaining 只是占位数字，
  // 不能当百分比参与"最紧"比较——否则一句话会把徽标染成红/绿。与 quotaRank /
  // swapAccount / accountFilter 的口径一致：只看真正可量化的窗口。
  const measured = windows.filter((window) => !window.unlimited && !window.text);
  if (measured.length === 0) {
    return {
      accounts: readable.length,
      label: "不限量",
      tone: "ok",
      detail: readable.map((row) => accountDetail(row, now)).join("；"),
    };
  }

  let tightest = measured[0]!;
  let tightestLeft = windowLeftPercent(tightest);
  for (const window of measured) {
    const left = windowLeftPercent(window);
    if (left < tightestLeft) {
      tightest = window;
      tightestLeft = left;
    }
  }

  const shown = readable.slice(0, 3).map((row) => accountDetail(row, now));
  if (readable.length > 3) shown.push(`等 ${readable.length} 个账号`);
  return {
    accounts: readable.length,
    label: tightestLeft <= 0 ? "额度用完" : windowLeftText(tightest),
    tone: windowTone(tightest),
    detail: shown.join("；"),
  };
}

/** 一次算完整页的徽标，避免每行都重扫账号表。 */
export function agentQuotaMap(rows: readonly AccountRow[], now: number): Map<string, AgentQuota> {
  const map = new Map<string, AgentQuota>();
  for (const row of rows) {
    if (map.has(row.agent)) continue;
    if (!/^[a-z0-9-]+$/.test(row.agent)) continue;
    const quota = agentQuota(rows, row.agent, now);
    if (quota) map.set(row.agent, quota);
  }
  return map;
}
