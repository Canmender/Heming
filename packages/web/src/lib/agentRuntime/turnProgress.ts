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
  /** 工具总共花了多久（d.379）：让「上一轮」能分清慢在工具还是慢在模型。 */
  toolMs?: number;
  /** 用户点了停止（d.377）：小结里要标出来。 */
  stopped?: boolean;
  /** 这一轮到底产出了多少正文字符（d.354）：收口时由调用方带上，用来算「字/秒」。 */
  chars?: number;
}

/** 一轮的上限按轮次上限来（36），这里只防脏数据把界面撑坏。 */
export const TURN_PROGRESS_MAX_ROUND = 99;

/**
 * 收口小结的落盘位置（d.359）。
 *
 * 为什么只存小结、不存「正在跑」：跑动中的进度写盘没有意义，重开应用看到一条假的
 * 「正在执行 file_grep」比什么都糟。但**跑完之后**那行小结（几步、多久、首字、字/秒）
 * 是这一轮真实发生过的事，重开就没掉很可惜——用户往往在跑完之后才回来看。
 */
export const TURN_SUMMARY_KEY = "heming.turnSummary.v1";

/** 最多留几个会话的小结：与 msgCache 同一思路，按最近写入淘汰最旧的。 */
export const TURN_SUMMARY_SESSIONS = 20;

type StoredSummary = {
  round: number;
  tools: number;
  startedAt: number;
  endedAt: number;
  at: number;
  firstTokenAt: number | null;
  chars: number;
  /** 工具总耗时（d.379）；老档没有这个字段。 */
  toolMs?: number;
  /** 用户点了停止（d.377）；老档没有这个字段。 */
  stopped?: boolean;
};

const progress = new Map<string, TurnProgress>();
const listeners = new Set<() => void>();
/** 每个会话的快照缓存：`useSyncExternalStore` 要求同一个会话返回同一个引用。 */
const snapshots = new Map<string, TurnProgress>();
const EMPTY = null as TurnProgress | null;

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** 从落盘读回小结；坏档（不是对象、字段不对、时间不成立）静默丢弃那一条，不整份清空。 */
function readSummaries(): Record<string, StoredSummary> {
  const box = storage();
  if (!box) return {};
  let raw: unknown;
  try {
    const text = box.getItem(TURN_SUMMARY_KEY);
    if (!text) return {};
    raw = JSON.parse(text) as unknown;
  } catch {
    return {};
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, StoredSummary> = {};
  for (const [conversationId, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!conversationId || value === null || typeof value !== "object") continue;
    const record = value as Record<string, unknown>;
    const startedAt = numberOr(record.startedAt, 0);
    const endedAt = numberOr(record.endedAt, 0);
    if (startedAt <= 0 || endedAt < startedAt) continue;
    const firstAt = record.firstTokenAt;
    out[conversationId] = {
      round: Math.max(1, Math.floor(numberOr(record.round, 1))),
      tools: Math.max(0, Math.floor(numberOr(record.tools, 0))),
      startedAt,
      endedAt,
      at: numberOr(record.at, endedAt),
      firstTokenAt: typeof firstAt === "number" && Number.isFinite(firstAt) && firstAt >= startedAt ? firstAt : null,
      chars: Math.max(0, Math.floor(numberOr(record.chars, 0))),
      ...(numberOr(record.toolMs, 0) > 0 ? { toolMs: Math.floor(numberOr(record.toolMs, 0)) } : {}),
      ...(record.stopped === true ? { stopped: true } : {}),
    };
  }
  return out;
}

/** 写入全部小结；超配额/隐私模式静默失败（这是锦上添花，不能反过来弄坏界面）。 */
function writeSummaries(map: Map<string, StoredSummary>): void {
  const box = storage();
  if (!box) return;
  const entries = [...map.entries()].sort((a, b) => b[1].endedAt - a[1].endedAt).slice(0, TURN_SUMMARY_SESSIONS);
  const payload: Record<string, StoredSummary> = {};
  for (const [conversationId, value] of entries) payload[conversationId] = value;
  try {
    box.setItem(TURN_SUMMARY_KEY, JSON.stringify(payload));
  } catch {
    // 配额满了就放弃这次落盘：下次收口还会再试，界面不因此中断。
  }
}

function summaryOf(state: TurnProgress): StoredSummary {
  return {
    round: state.round,
    tools: state.tools,
    startedAt: state.startedAt,
    endedAt: state.endedAt ?? state.at,
    at: state.at,
    firstTokenAt: state.firstTokenAt ?? null,
    chars: state.chars ?? 0,
    ...(state.stopped ? { stopped: true } : {}),
    ...(state.toolMs ? { toolMs: state.toolMs } : {}),
  };
}

/** 把落盘的小结装回内存（模块加载时调一次，测试里也可动手重放）。 */
export function hydrateTurnSummaries(): void {
  for (const [conversationId, saved] of Object.entries(readSummaries())) {
    // 内存里已有更权威的状态（比如这一轮正在跑）就不要用旧档覆盖它。
    if (progress.has(conversationId)) continue;
    const restored: TurnProgress = {
      round: saved.round,
      phase: "round",
      tool: null,
      at: saved.at,
      startedAt: saved.startedAt,
      tools: saved.tools,
      done: true,
      endedAt: saved.endedAt,
      firstTokenAt: saved.firstTokenAt,
      chars: saved.chars,
      ...(saved.stopped ? { stopped: true } : {}),
      ...(saved.toolMs ? { toolMs: saved.toolMs } : {}),
    };
    progress.set(conversationId, restored);
    snapshots.set(conversationId, restored);
  }
}

/** 测试用：丢掉内存里的进度、按落盘重放（模拟「重开应用」），用于验证小结确实活过了重启。 */
export function reloadTurnSummaries(): void {
  progress.clear();
  snapshots.clear();
  hydrateTurnSummaries();
  emit();
}

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
  stopped = false,
  toolMs?: number,
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
    // d.377：用户点了停止——小结要说出来，否则「上一轮」看着像正常收口的。
    ...(stopped ? { stopped: true } : {}),
    // d.379：工具耗时单独记一笔，小结里能看出慢在工具还是慢在模型。
    ...(typeof toolMs === "number" && Number.isFinite(toolMs) && toolMs > 0
      ? { toolMs: Math.floor(toolMs) }
      : {}),
  };
  progress.set(conversationId, next);
  snapshots.set(conversationId, next);
  // d.359：收口小结落盘，重开应用还能看到「刚才那一轮跑了多少」。
  const saved = readSummaries();
  saved[conversationId] = summaryOf(next);
  writeSummaries(new Map(Object.entries(saved)));
  emit();
}

/** 读当前进度（没在跑 → null）。返回引用稳定，可直接给 `useSyncExternalStore`。 */
export function getTurnProgress(conversationId: string): TurnProgress | null {
  if (!conversationId) return EMPTY;
  return snapshots.get(conversationId) ?? EMPTY;
}

/** 收口/停止/报错/切会话时清掉：不能让上一轮的数字留在界面上（落盘的小结也一起删）。 */
export function clearTurnProgress(conversationId?: string): void {
  let changed = false;
  if (conversationId === undefined) {
    if (progress.size === 0) return;
    progress.clear();
    snapshots.clear();
    try {
      storage()?.removeItem(TURN_SUMMARY_KEY);
    } catch {
      // 清不掉也不影响内存里的显示。
    }
    changed = true;
  } else if (progress.delete(conversationId)) {
    snapshots.delete(conversationId);
    const saved = readSummaries();
    if (conversationId in saved) {
      delete saved[conversationId];
      writeSummaries(new Map(Object.entries(saved)));
    }
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

/** 测试用：清空全部（含订阅与落盘小结）。 */
export function resetTurnProgress(): void {
  progress.clear();
  snapshots.clear();
  listeners.clear();
  try {
    storage()?.removeItem(TURN_SUMMARY_KEY);
  } catch {
    // 清不掉也不影响内存状态。
  }
}

/** 一句话说清现在在干什么；收口后说清这一轮走了多少步（界面与 /status 共用同一口径）。 */
export function describeTurnProgress(state: TurnProgress): string {
  if (state.done) {
    const endedAt = state.endedAt ?? state.at;
    const used = formatElapsed(endedAt - state.startedAt);
    // d.350：这里的数字是**这一步到哪了**，不是「第几轮对话」——用户说的「轮」是
    // 「一次输入 + 一次输出 + 停止」，那是输入框下方那行 `N 轮 · M 步` 的事。
    const parts: string[] = [];
    // d.377：用户按了停止——这一轮不是自然收口的，小结里必须说，否则「上一轮」看着
    // 像跑完了（DSH 在正文尾也标一句「已停止」）。
    if (state.stopped) parts.push("已停止");
    if (state.tools > 0) parts.push(`${state.tools} 步`);
    parts.push(`用时 ${used}`);
    // d.379：工具占了多久。总共 1 分 40 秒里如果 1 分 30 秒是工具，那就不该怪模型慢；
    // 占比过小（不到 1 秒）不写，免得每轮都挂个「工具 0.2 秒」。
    const toolMs = state.toolMs ?? 0;
    if (toolMs >= 500) parts.push(`工具 ${formatSeconds(toolMs)}`);
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

// d.359：模块加载即装回上次收口的小结——重开应用时，「上一轮跑了多少」不该凭空消失。
hydrateTurnSummaries();





