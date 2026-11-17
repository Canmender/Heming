/**
 * 主对话的「现在在干什么」（d.214）。
 *
 * 为什么需要：长任务里模型一跑就是十几轮，界面上只有一句静态的「生成中：和小鸣」。
 * 用户判断不了「它在干活」还是「它卡死了」，于是要么干等、要么点停止把跑了十分钟的活掐掉。
 * 子代理（d.200）与后台作业（d.203）各有自己的进度面板，**主对话这一条偏偏没有**。
 *
 * 口径（只报事实，不猜进度）：
 * - 只报「第几轮」与「正在执行哪个工具」——这两件都是模型真实做过的事；
 * - 不估算百分比（没有人知道还差几轮），不编「正在思考」之外的措辞；
 * - 按会话存，切走再切回来还能看到；收口时换成一行小结（d.218），停止/报错同样；
 * - 只放内存：这类瞬时状态写盘没有意义（重开应用也不该看到一条假的「正在跑」）。
 */
import type { TurnProgressEvent } from "../agentStream.js";

export interface TurnProgress {
  /** 本会话当前这一轮走到第几轮工具循环（从 1 开始）。 */
  round: number;
  /**
   * `"round"` = 模型在思考下一步；`"tool"` = 正在执行某个工具。
   *
   * 收口后（`done`）统一落回 `"round"`：小结里不该还写着「正在执行 file_grep」。
   */
  phase: "round" | "tool";
  /** `phase === "tool"` 时的工具名。 */
  tool: string | null;
  /** 这条进度是什么时候更新的（界面据此算「已经跑了多久」）。 */
  at: number;
  /** 这一轮第一次上报的时刻（收口后算总用时，见 `settleTurnProgress`）。 */
  startedAt: number;
  /** 到目前执行过的工具调用次数——真数出来的，不按轮次猜。 */
  tools: number;
  /**
   * 这一轮是否已经收口（d.218）。
   *
   * 收口之后不再显示「正在执行 X」，而是留一行「上一轮：3 轮 · 5 次工具 · 用时 1 分 12 秒」。
   * 为什么留着：长任务一次跑十几分钟，收口那一刻用户往往不在屏幕前；行一消失，他就只能
   * 靠翻消息猜「刚才那一下到底干了多少」。这些数字本来就是模型真实做过的事，白扔了可惜。
   */
  done: boolean;
  /** 收口时刻（`done` 为真时才有值）。 */
  endedAt: number | null;
}

/** 一轮的上限按轮次上限来（36），这里只防脏数据把界面撑坏。 */
export const TURN_PROGRESS_MAX_ROUND = 99;

const progress = new Map<string, TurnProgress>();
const listeners = new Set<() => void>();
/** 每个会话的快照缓存：`useSyncExternalStore` 要求同一个会话返回同一个引用。 */
const snapshots = new Map<string, TurnProgress>();
const EMPTY = null as TurnProgress | null;

function emit(): void {
  for (const listener of listeners) listener();
}

function validRound(round: unknown): number | null {
  if (typeof round !== "number" || !Number.isFinite(round)) return null;
  const value = Math.floor(round);
  if (value < 1 || value > TURN_PROGRESS_MAX_ROUND) return null;
  return value;
}

/**
 * 记下一条进度。`phase: "tool"` 必须带工具名，否则退回 `"round"`（宁可少说，不要瞎说）。
 *
 * 收口后（`done`）又来了新进度 = 开始了新一轮：计时与工具计数从这一条重新起算，
 * 否则「上一轮 5 次工具」会累加到下一轮头上，数字就成了假的。
 */
export function recordTurnProgress(
  conversationId: string,
  event: TurnProgressEvent,
  now: number = Date.now(),
): void {
  if (!conversationId) return;
  const round = validRound(event.round);
  if (round === null) return;
  const tool = event.phase === "tool" && typeof event.tool === "string" && event.tool.trim() !== "" ? event.tool : null;
  const prev = progress.get(conversationId);
  const fresh = prev === undefined || prev.done;
  const next: TurnProgress = {
    round,
    phase: tool ? "tool" : "round",
    tool,
    at: now,
    startedAt: fresh ? now : prev.startedAt,
    tools: (fresh ? 0 : prev.tools) + (tool ? 1 : 0),
    done: false,
    endedAt: null,
  };
  progress.set(conversationId, next);
  snapshots.set(conversationId, next);
  emit();
}

/**
 * 这一轮收口了（成功/失败/用户停止都算）：把跑动的进度换成一条小结，而不是直接消失（d.218）。
 *
 * 只改「还在跑」的那条：已经收口过的（`done`）再调一次不重复通知——比如恢复提示条重渲染。
 * 没上报过任何进度的会话不会有小结（不能凭空造一个「0 轮」出来）。
 */
export function settleTurnProgress(conversationId: string, now: number = Date.now()): void {
  if (!conversationId) return;
  const prev = progress.get(conversationId);
  if (prev === undefined || prev.done) return;
  const next: TurnProgress = {
    ...prev,
    phase: "round",
    tool: null,
    at: now,
    done: true,
    endedAt: now,
  };
  progress.set(conversationId, next);
  snapshots.set(conversationId, next);
  emit();
}

/** 读当前进度（没在跑 → null）。返回引用稳定，可直接给 `useSyncExternalStore`。 */
export function getTurnProgress(conversationId: string): TurnProgress | null {
  if (!conversationId) return EMPTY;
  return snapshots.get(conversationId) ?? EMPTY;
}

/** 收口/停止/报错/切会话时清掉：不能让上一轮的数字留在界面上。 */
export function clearTurnProgress(conversationId?: string): void {
  let changed = false;
  if (conversationId === undefined) {
    if (progress.size === 0) return;
    progress.clear();
    snapshots.clear();
    changed = true;
  } else if (progress.delete(conversationId)) {
    snapshots.delete(conversationId);
    changed = true;
  }
  if (changed) emit();
}

export function subscribeTurnProgress(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 测试用：清空全部（含订阅）。 */
export function resetTurnProgress(): void {
  progress.clear();
  snapshots.clear();
  listeners.clear();
}

/** 一句话说清现在在干什么；收口后说清这一轮干了多少（界面与 /status 共用同一口径）。 */
export function describeTurnProgress(state: TurnProgress): string {
  if (state.done) {
    const endedAt = state.endedAt ?? state.at;
    const used = formatElapsed(endedAt - state.startedAt);
    const rounds = `${state.round} 轮`;
    const tools = state.tools > 0 ? ` · ${state.tools} 次工具` : "";
    return `上一轮：${rounds}${tools} · 用时 ${used}`;
  }
  if (state.phase === "tool" && state.tool) return `第 ${state.round} 轮 · 正在执行 ${state.tool}`;
  return `第 ${state.round} 轮 · 正在想下一步`;
}

/** 把毫秒数说成人话（不足 1 分钟只报秒，超过 1 分钟报「x 分 y 秒」）。 */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total} 秒`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return seconds === 0 ? `${minutes} 分` : `${minutes} 分 ${seconds} 秒`;
}
