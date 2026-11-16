/**
 * 输入框的历史回溯（d.194）：按 ↑ 调出这条会话里发过的消息。
 *
 * 为什么要做：长任务的用法常常是「接着说」「不对，重来」「照刚才那样再来一遍」——
 * 用户得把上次的话重新打一遍。codex / Claude Code 都是 ↑ 调回上一条。
 * 这里只从**本会话已加载的消息**里取，不新开存储：会话就是历史，另存一份会与「删消息/清空会话」漂移。
 *
 * 两条边界：
 * 1. 本地命令（`/compact`、`/plan`、`/status`、`/help`）不进历史——它们不是「说过的话」，
 *    调出来再发一次没有意义（重复压缩、把状态命令当消息发）；
 * 2. 只认「空输入框里按 ↑」进入回溯，之后 ↑↓ 在历史里走；走到底回原草稿。
 *    这样多行输入框里的正常光标移动不受影响。
 */

import { SLASH_COMMANDS } from "./slashCommands.js";

/** 最多记多少条（只是界面回溯，不需要全量）。 */
export const MAX_INPUT_HISTORY = 50;

const LOCAL_COMMANDS = new Set(SLASH_COMMANDS.map((item) => item.command));

/** 这条文本是否属于「本地命令」：精确等于某条命令（含前后空白）。 */
export function isLocalCommand(text: string): boolean {
  return LOCAL_COMMANDS.has(text.trim());
}

/**
 * 从会话消息里抽出可回溯的历史文本：去空、去相邻重复、丢掉本地命令，只留最近 `MAX_INPUT_HISTORY` 条。
 * 顺序保持「旧 → 新」（最后一格是最新一条），这样 `stepHistory` 的方向可以直接对着数组下标走。
 */
export function historyFrom(texts: readonly string[], max = MAX_INPUT_HISTORY): string[] {
  const out: string[] = [];
  for (const raw of texts) {
    const text = (raw ?? "").trim();
    if (!text) continue;
    if (isLocalCommand(text)) continue;
    if (out.length > 0 && out[out.length - 1] === text) continue;
    out.push(text);
  }
  return out.slice(-max);
}

/** 回溯状态：`index === -1` 表示「不在回溯里」，输入框里是用户自己的草稿。 */
export interface HistoryStep {
  index: number;
  text: string;
}

/**
 * 走一步。`index` 为 -1 时按 ↑ 从最新一条开始；`draft` 是进入回溯前用户自己的草稿，
 * 一路按 ↓ 走到头会把它放回去（不是清空——用户可能打了一半）。
 */
export function stepHistory(
  history: readonly string[],
  index: number,
  direction: "up" | "down",
  draft: string,
): HistoryStep {
  if (history.length === 0) return { index, text: draft };
  if (direction === "up") {
    if (index < 0) return { index: history.length - 1, text: history[history.length - 1] };
    // 已经在回溯里：到顶就停在最早一条（再按不越界，也不把草稿顶掉）
    const next = Math.max(0, index - 1);
    return { index: next, text: history[next] };
  }
  if (index < 0) return { index, text: draft };
  const next = index + 1;
  if (next >= history.length) return { index: -1, text: draft };
  return { index: next, text: history[next] };
}
