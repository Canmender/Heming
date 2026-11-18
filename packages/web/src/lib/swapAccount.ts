/**
 * 换到还有额度的那个账号（d.310）。
 *
 * 内核只会替「能存下登录态」的智能体换号（`accounts switch <claude|codex> next`），
 * 所以这里也只在 Claude / Codex 上给建议：一个账号的窗口全用完了、同门还有别的账号有额度，
 * 就值得问一句「要不要现在换过去」——不然用户只能等它自己重置。
 */

import type { AccountRow } from "./magpieCli.js";
import { windowLeftPercent } from "./magpieQuota.js";

/** 内核能自动换号的智能体：登录态存得下来，换完别家工具也是这个账号。 */
export const SWAPPABLE_AGENTS = ["claude", "codex"] as const;

export interface SwapSuggestion {
  agent: string;
  /** 已经用不完的账号数（窗口全见底）。 */
  usedUp: number;
  /** 同门还有余量的账号数。 */
  ready: number;
}

/** 一个账号的窗口全见底才算用完：没窗口、只有原话、不限量的都不算。 */
export function accountUsedUp(row: AccountRow): boolean {
  const windows = row.windows.filter((window) => !window.unlimited && !window.text);
  if (windows.length === 0) return false;
  return windows.every((window) => windowLeftPercent(window) <= 0);
}

/**
 * 该不该问「换过去」：只在 Claude / Codex 上、且确实有人用完、也有人还有余量时给建议。
 * 顺序按 `SWAPPABLE_AGENTS`，同一家只给一条。
 */
export function swapSuggestions(
  rows: readonly AccountRow[],
  readyAbove = 25,
): SwapSuggestion[] {
  const out: SwapSuggestion[] = [];
  for (const agent of SWAPPABLE_AGENTS) {
    const mine = rows.filter((row) => row.agent === agent && !row.lapsed && !row.error);
    const usedUp = mine.filter(accountUsedUp).length;
    const ready = mine.filter(
      (row) =>
        !accountUsedUp(row) &&
        row.windows.some(
          (window) => !window.text && (window.unlimited || windowLeftPercent(window) > readyAbove),
        ),
    ).length;
    if (usedUp > 0 && ready > 0) out.push({ agent, usedUp, ready });
  }
  return out;
}

/** 一句话说清为什么值得换，用在按钮旁边的说明里。 */
export function swapText(suggestion: SwapSuggestion, name: (agent: string) => string): string {
  return `${name(suggestion.agent)} 有 ${suggestion.usedUp} 个账号用完了，另有 ${suggestion.ready} 个还有余量`;
}

/** 换号命令：内核自己挑「还有额度、剩得最多」的那个。 */
export function swapArgs(agent: string): string[] {
  return ["accounts", "switch", agent, "next"];
}
