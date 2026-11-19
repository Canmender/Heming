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
  /**
   * 这一轮第一个正文片段到达的时刻（d.354，对齐 DSH 的 TTFT 口径）。
   *
   * 为什么记它：用户判断「模型快不快」看的是**多久出第一个字**，而不是总用时——
   * 一个跑了两分钟、但十秒才开口的答复，和一个跑了两分钟、立刻开口的答复，
   * 体感完全不同。只在有正文流时才会被 `noteTurnFirstToken` 写上；工具轮没有正文
   * 输出时保持 null，界面就不会编一个「首字 0 秒」出来。
   */
  firstTokenAt?: number | null;
  /** 这一轮到底产出了多少正文字符（d.354）：收口时由调用方带上，用来算「字/秒」。 */
  chars?: number;
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
    // 同一轮里保留首字时刻与已产出字符数；新一轮（fresh）从零开始。
    firstTokenAt: fresh ? null : (prev?.firstTokenAt ?? null),
    chars: fresh ? 0 : (prev?.chars ?? 0),
  };
  progress.set(conversationId, next);
  snapshots.set(conversationId, next);
  emit();
}

/**
 * 记下这一轮「第一个正文字到达」的时刻（d.354）。
 *
 * 只在没有进度条目时静默忽略：没有这一轮的事实，就不能凭空造一个「首字 0.3 秒」。
 * 已经有值就不再改写——TTFT 是一次性的，多调几次也不会把数字越改越小。
 */
export function noteTurnFirstToken(conversationId: string, now: number = Date.now()): void {
  if (!conversationId) return;
  const prev = progress.get(conversationId);
  if (prev === undefined || prev.done || prev.firstTokenAt != null) return;
  const next: TurnProgress = { ...prev, firstTokenAt: now };
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
export function settleTurnProgress(
  conversationId: string,
  now: number = Date.now(),
  chars = 0,
): void {
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
    chars: Math.max(prev.chars ?? 0, Math.max(0, Math.floor(chars))),
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

/** 一句话说清现在在干什么；收口后说清这一轮走了多少步（界面与 /status 共用同一口径）。 */
export function describeTurnProgress(state: TurnProgress): string {
  if (state.done) {
    const endedAt = state.endedAt ?? state.at;
    const used = formatElapsed(endedAt - state.startedAt);
    // d.350：这里的数字是**这一步到哪了**，不是「第几轮对话」——用户说的「轮」是
    // 「一次输入 + 一次输出 + 停止」，那是输入框下方那行 `N 轮 · M 步` 的事。
    const parts: string[] = [];
    if (state.tools > 0) parts.push(`${state.tools} 步`);
    parts.push(`用时 ${used}`);
    // d.354：首字延迟与出字速度（DSH 的 TTFT / tok·s⁻¹ 口径）。只在真有正文时补，
    // 纯工具轮不编这两个数字。
    const firstAt = state.firstTokenAt ?? null;
    if (firstAt !== null && firstAt > state.startedAt) {
      parts.push(`首字 ${formatSeconds(firstAt - state.startedAt)}`);
    }
    const chars = state.chars ?? 0;
    const genMs = firstAt !== null ? endedAt - firstAt : 0;
    if (chars > 0 && genMs >= 500) {
      // 中文按「字」算，不冒充 token：这里没有分词器，叫字/秒是诚实的近似。
      parts.push(`${Math.round((chars * 1000) / genMs)} 字/秒`);
    }
    return `上一轮：${parts.join(" · ")}`;
  }
  if (state.phase === "tool" && state.tool) return `第 ${state.round} 步 · 正在执行 ${state.tool}`;
  return `第 ${state.round} 步 · 正在想下一步`;
}

/** 首字延迟说成人话：保留一位小数，超过 10 秒就不再报小数（精度没有意义）。 */
export function formatSeconds(ms: number): string {
  const value = Math.max(0, ms) / 1000;
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} 秒`;
}

/** 把毫秒数说成人话（不足 1 分钟只报秒，超过 1 分钟报「x 分 y 秒」）。 */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total} 秒`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return seconds === 0 ? `${minutes} 分` : `${minutes} 分 ${seconds} 秒`;
}
