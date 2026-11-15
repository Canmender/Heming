/**
 * 日期换算工具（内置只读工具 `date_calc`，d.150.4.95.11）的纯函数部分。
 *
 * 模型对「三天后是几号」「两个时间差多久」这类问题经常算错，尤其跨月/跨年。
 * 这里只做本机时区下的确定性换算，坏输入返回中文原因、绝不抛。
 */

export type DateParseOutcome = { ok: true; date: Date } | { ok: false; error: string };
export type DateShiftOutcome = { ok: true; date: Date } | { ok: false; error: string };

const UNIT_MS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

const UNIT_ALIASES: Record<string, string> = {
  s: "s",
  sec: "s",
  secs: "s",
  second: "s",
  seconds: "s",
  秒: "s",
  m: "m",
  min: "m",
  mins: "m",
  minute: "m",
  minutes: "m",
  分: "m",
  分钟: "m",
  h: "h",
  hr: "h",
  hrs: "h",
  hour: "h",
  hours: "h",
  时: "h",
  小时: "h",
  个小时: "h",
  d: "d",
  day: "d",
  days: "d",
  天: "d",
  日: "d",
  w: "w",
  week: "w",
  weeks: "w",
  周: "w",
  星期: "w",
  个星期: "w",
  mo: "mo",
  month: "mo",
  months: "mo",
  月: "mo",
  个月: "mo",
  y: "y",
  yr: "y",
  year: "y",
  years: "y",
  年: "y",
  个年: "y",
};

/** 解析用户/模型给的时间；空串与 now/今天/现在 都表示「此刻」。 */
export function parseDateInput(raw: string | undefined, now: Date): DateParseOutcome {
  const text = String(raw ?? "").trim();
  if (!text || /^(now|today|现在|今天|此刻)$/i.test(text)) return { ok: true, date: new Date(now.getTime()) };

  let normalized = text.replace(/\//g, "-").replace(/年|月/g, "-").replace(/日/g, "").trim();
  if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(normalized)) normalized = `${normalized} 00:00:00`;
  if (/^\d{4}-\d{1,2}-\d{1,2} \d{1,2}:\d{1,2}$/.test(normalized)) normalized = `${normalized}:00`;
  if (/^\d{4}-\d{1,2}-\d{1,2}[ T]\d{1,2}:\d{1,2}(:\d{1,2})?$/.test(normalized)) normalized = normalized.replace(" ", "T");
  else if (!/[T ]\d{1,2}:\d{1,2}/.test(normalized)) {
    // 纯日期以外没有任何时间信息时，一次 new Date(YYYY-MM-DD) 也按 UTC 解析，这里补本地零点
    if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(normalized)) normalized = `${normalized}T00:00:00`;
  }

  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) {
    return { ok: false, error: `看不懂的时间：${text}（可用 2026-11-15、2026-11-15 09:30、ISO 8601 或 now）` };
  }
  return { ok: true, date };
}

/** 按日历平移月份，并把「31 日 + 1 个月」收口到目标月的最后一天。 */
function addMonths(date: Date, months: number): Date {
  const day = date.getDate();
  const result = new Date(date.getTime());
  result.setDate(1);
  result.setMonth(result.getMonth() + months);
  const daysInMonth = new Date(result.getFullYear(), result.getMonth() + 1, 0).getDate();
  result.setDate(Math.min(day, daysInMonth));
  return result;
}

/** 按日历平移年份，2 月 29 日遇到平年时收口到 2 月 28 日。 */
function addYears(date: Date, years: number): Date {
  return addMonths(date, years * 12);
}

/**
 * 按 `3d`、`-2h`、`1w 2d`、`1个月` 这类规格平移时间。
 * 月/年用日历进位（1月31日 + 1个月 = 2月28/29日），其余按固定时长。
 */
export function shiftDate(base: Date, spec: string): DateShiftOutcome {
  const text = String(spec ?? "").trim();
  if (!text) return { ok: true, date: new Date(base.getTime()) };
  const pattern = /([+-]?\d+(?:\.\d+)?)\s*([a-zA-Z\u4e00-\u9fa5]+)/g;
  let matched = 0;
  let consumed = "";
  let date = new Date(base.getTime());
  for (const match of text.matchAll(pattern)) {
    const amount = Number(match[1]);
    const unitKey = UNIT_ALIASES[match[2].toLowerCase()];
    if (!Number.isFinite(amount)) return { ok: false, error: `看不懂的时长：${match[0]}` };
    if (!unitKey) return { ok: false, error: `不支持的时长单位：${match[2]}（可用 秒/分/时/天/周/月/年）` };
    consumed += match[0];
    matched += 1;
    if (unitKey === "mo") {
      date = addMonths(date, Math.trunc(amount));
    } else if (unitKey === "y") {
      date = addYears(date, Math.trunc(amount));
    } else {
      date = new Date(date.getTime() + amount * (UNIT_MS[unitKey] ?? 0));
    }
  }
  if (matched === 0) {
    return { ok: false, error: `看不懂的时长：${text}（示例：3d、-2h、1w、1个月）` };
  }
  if (consumed.replace(/\s+/g, "").length !== text.replace(/\s+/g, "").length) {
    return { ok: false, error: `时长里有多余内容：${text}` };
  }
  return { ok: true, date };
}

/** 两个时间相差多久（给人看的粗略文本，绝对值 + 方向）。 */
export function describeDifference(from: Date, to: Date): string {
  let ms = to.getTime() - from.getTime();
  const direction = ms < 0 ? "早" : "晚";
  ms = Math.abs(ms);
  const days = Math.floor(ms / UNIT_MS.d);
  const hours = Math.floor((ms % UNIT_MS.d) / UNIT_MS.h);
  const minutes = Math.floor((ms % UNIT_MS.h) / UNIT_MS.m);
  const seconds = Math.floor((ms % UNIT_MS.m) / UNIT_MS.s);
  const parts: string[] = [];
  if (days) parts.push(`${days} 天`);
  if (hours) parts.push(`${hours} 小时`);
  if (minutes) parts.push(`${minutes} 分钟`);
  if (!days && !hours) parts.push(`${seconds} 秒`);
  return `相差 ${parts.join(" ")}（后者比前者${direction}）`;
}

const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];

function pad2(value: number): string {
  return String(Math.abs(value)).padStart(2, "0");
}

/** 本机时区下的人类可读时间（模型看 ISO 的 Z 容易误读成本地时间）。 */
export function formatLocal(date: Date): { iso: string; pretty: string; weekday: string; utc: string } {
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const iso =
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}` +
    `T${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}` +
    `${sign}${pad2(Math.trunc(offset / 60))}:${pad2(offset % 60)}`;
  return {
    iso,
    pretty:
      `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日` +
      `星期${WEEKDAYS[date.getDay()] ?? ""} ${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`,
    weekday: `星期${WEEKDAYS[date.getDay()] ?? ""}`,
    utc: date.toISOString(),
  };
}

/** 本机时区名（Intl 不可用时退回中文说明）。 */
export function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "本机时区";
  } catch {
    return "本机时区";
  }
}
