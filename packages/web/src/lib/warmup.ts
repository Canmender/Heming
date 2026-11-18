/**
 * 额度窗口预热：内核会在一个窗口刚重置时替我们先发一个极小的请求，
 * 让下一轮从这个时刻开始算（Codex / Claude 的窗口都从「第一次使用」起算，
 * 闲置一天，下一轮也晚一天结束）。
 *
 * 纯函数，命令形状照内核 `settings` 的真话：空值是「重置回默认」，
 * 因为 `settings set <key> ""` 会被内核当成没给值而拒绝。
 */

/** 一家被预热的厂商在两处设置里的名字。 */
export interface WarmupVendor {
  /** 这句话里的厂商 id，用来做 key。 */
  vendor: "codex" | "claude";
  /** 给人看的名字，与模型页其它地方一致。 */
  name: string;
  /** 开关键，值只有 "" / "week" / "all"。 */
  levelKey: string;
  /** 每天固定开 5 小时窗口的时间点，值是 "HH:MM" 的列表。 */
  timesKey: string;
}

export const WARMUP_VENDORS: readonly WarmupVendor[] = [
  { vendor: "codex", name: "ChatGPT", levelKey: "codexWarmup", timesKey: "codexWarmAts" },
  { vendor: "claude", name: "Claude", levelKey: "claudeWarmup", timesKey: "claudeWarmAts" },
];

export type WarmupLevel = "off" | "week" | "all";

/** 三档的文案：说清「预热」到底省下什么，而不是只写技术名词。 */
export const WARMUP_LEVELS: readonly { value: WarmupLevel; label: string; hint: string }[] = [
  {
    value: "off",
    label: "不预热",
    hint: "窗口从你第一次用到它的那一刻才开始算，闲置多久就晚多久结束。",
  },
  {
    value: "week",
    label: "只预热每周",
    hint: "每周窗口一重置，内核就先发一个极小的请求，让下一周从那天开始。",
  },
  {
    value: "all",
    label: "每周与 5 小时",
    hint: "连 5 小时窗口也一重置就接着开，一天能多塞一轮，额度不用等。",
  },
];

/** 现在是哪一档（认不出的值按「不预热」，与内核一致）。 */
export function warmupLevel(values: ReadonlyMap<string, unknown>, levelKey: string): WarmupLevel {
  const value = values.get(levelKey);
  return value === "week" || value === "all" ? value : "off";
}

/** 切档要发的命令：「不预热」等于把这一项重置回默认。 */
export function warmupArgs(levelKey: string, level: WarmupLevel): string[] {
  return level === "off"
    ? ["settings", "reset", levelKey]
    : ["settings", "set", levelKey, level];
}

/** 一天里的几个时间点：内核那边是列表，也可能是只有一条的老写法。 */
export function warmupTimes(values: ReadonlyMap<string, unknown>, timesKey: string): string[] {
  const value = values.get(timesKey);
  const raw: unknown[] = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[,，、\s]+/) : [];
  return parseTimeList(raw.filter((item): item is string => typeof item === "string").join(" "));
}

/** 把时间点说成一句人话。 */
export function warmupTimesText(times: readonly string[]): string {
  return times.length > 0 ? `每天 ${times.join("、")} 各开一次` : "还没设固定时间";
}

/** 用户敲进来的时间点：逗号、顿号、空格都能分开，认不出的丢掉，去重并按时间排好。 */
export function parseTimeList(text: string): string[] {
  const seen = new Set<string>();
  const times: string[] = [];
  for (const token of text.split(/[,，、;；\s]+/)) {
    const normalised = normaliseTime(token);
    if (!normalised || seen.has(normalised)) continue;
    seen.add(normalised);
    times.push(normalised);
  }
  return times.sort();
}

/** "9:05" / "09:05" / "0905" 都收下，返回 "09:05"；认不出返回空串。 */
export function normaliseTime(text: string): string {
  const match = /^(\d{1,2})[:：.]?(\d{2})$/.exec(text.trim());
  if (!match) return "";
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return "";
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/** 写回时间点的命令：一条都没有时重置回空列表。 */
export function warmupTimesArgs(timesKey: string, times: readonly string[]): string[] {
  return times.length === 0
    ? ["settings", "reset", timesKey]
    : ["settings", "set", timesKey, times.join(",")];
}

/** 卡片底部那张一句话总结：现在替谁开着、在什么时间开。 */
export function warmupSummary(values: ReadonlyMap<string, unknown>): string {
  const parts: string[] = [];
  for (const item of WARMUP_VENDORS) {
    const level = warmupLevel(values, item.levelKey);
    if (level === "off") continue;
    const times = warmupTimes(values, item.timesKey);
    const what = level === "all" ? "每周与 5 小时窗口" : "每周窗口";
    parts.push(times.length > 0 ? `${item.name}：${what}，每天 ${times.join("、")} 开一次` : `${item.name}：${what}`);
  }
  return parts.length > 0 ? parts.join("；") : "两家都还没预热：窗口从你第一次用它时才开始算。";
}
