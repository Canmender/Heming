/**
 * 5 段 Cron 表达式解析与「下一次触发时刻」计算（本仓自写，不引第三方库）。
 *
 * 为什么自己写：产品范围只要求「间隔 / 每天 / 每周 / Cron」四种调度，
 * 引入完整的 cron 库会顺带打开大量用不到（也很难解释清楚）的语法与依赖。
 * 这里只支持标准 5 段：分 时 日 月 周，字段内支持 `*`、`N`、`a-b`、`a-b/step`、
 * 以及「星号加 / 步长」（例如 `*` 后跟 `/15`）、逗号列表；周字段 0/7 都表示周日，
 * 周与月还接受 sun..sat / jan..dec 三个字母的别名。时区固定按**本机本地时区**
 * （与模块设置 `timezone: "local"` 一致）。
 *
 * 语义边界（写清楚，避免用户以为支持完整 cron）：
 * - 不支持秒字段、不支持 `L`/`W`/`#`/`?` 等扩展（`?` 当 `*` 处理）；
 * - 「日」与「周」同时被限制时按传统 cron 语义取**或**；
 * - 最多向前找 366 天，找不到返回 null（例如 `0 0 31 2 *` 这种不存在的时间）。
 */

/** 解析后的字段集合；`domRestricted` / `dowRestricted` 用于「日/周同时限制取或」。 */
export interface ParsedCron {
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
  domRestricted: boolean;
  dowRestricted: boolean;
}

const MINUTES_PER_DAY = 24 * 60;
/** 最多向前找 366 天（闰年也覆盖）。 */
const MAX_LOOKAHEAD_DAYS = 366;

const MONTH_ALIASES: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

const WEEKDAY_ALIASES: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

function parseNumberToken(token: string, aliases?: Record<string, number>): number | null {
  const normalized = token.trim().toLowerCase();
  if (!normalized) return null;
  if (aliases && aliases[normalized] !== undefined) return aliases[normalized];
  if (!/^\d+$/.test(normalized)) return null;
  return Number(normalized);
}

/**
 * 解析单个字段。
 * `min..max` 是取值区间；`stepOffset` 处理周字段 7→0 的归一（在解析后由调用方做）。
 */
function parseField(
  raw: string,
  min: number,
  max: number,
  aliases?: Record<string, number>,
): Set<number> | null {
  const values = new Set<number>();
  for (const part of raw.split(",")) {
    const token = part.trim().toLowerCase();
    if (!token) return null;
    const slash = token.split("/");
    if (slash.length > 2) return null;
    const rangePart = slash[0] ?? "";
    const stepPart = slash[1];
    let step = 1;
    if (stepPart !== undefined) {
      if (!/^\d+$/.test(stepPart)) return null;
      step = Number(stepPart);
      if (step <= 0) return null;
    }
    let start: number;
    let end: number;
    if (rangePart === "*" || rangePart === "?") {
      start = min;
      end = max;
    } else if (rangePart.includes("-")) {
      const bounds = rangePart.split("-");
      if (bounds.length !== 2) return null;
      const rawStart = parseNumberToken(bounds[0] ?? "", aliases);
      const rawEnd = parseNumberToken(bounds[1] ?? "", aliases);
      if (rawStart === null || rawEnd === null) return null;
      start = rawStart;
      end = rawEnd;
    } else {
      const single = parseNumberToken(rangePart, aliases);
      if (single === null) return null;
      start = single;
      end = single;
    }
    if (start < min || end > max || start > end) return null;
    for (let value = start; value <= end; value += step) values.add(value);
  }
  return values.size > 0 ? values : null;
}

/**
 * 解析 5 段 cron；任何一段非法都返回 null。
 * 空表达式、段数不对、越界（例如分钟 60、月 13）一律 null。
 */
export function parseCron(expression: string): ParsedCron | null {
  if (typeof expression !== "string") return null;
  const fields = expression.trim().split(/\s+/).filter((field) => field !== "");
  if (fields.length !== 5) return null;
  const [minuteRaw, hourRaw, dayRaw, monthRaw, weekRaw] = fields;
  const minutes = parseField(minuteRaw ?? "", 0, 59);
  const hours = parseField(hourRaw ?? "", 0, 23);
  const daysOfMonth = parseField(dayRaw ?? "", 1, 31);
  const months = parseField(monthRaw ?? "", 1, 12, MONTH_ALIASES);
  const rawDaysOfWeek = parseField(weekRaw ?? "", 0, 7, WEEKDAY_ALIASES);
  if (!minutes || !hours || !daysOfMonth || !months || !rawDaysOfWeek) return null;
  // 周字段允许写 7 表示周日；统一归一到 0，避免「0 和 7 是两天」的经典坑。
  const daysOfWeek = new Set<number>();
  for (const value of rawDaysOfWeek) daysOfWeek.add(value === 7 ? 0 : value);
  return {
    minutes,
    hours,
    daysOfMonth,
    months,
    daysOfWeek,
    domRestricted: (dayRaw ?? "") !== "*" && (dayRaw ?? "") !== "?",
    dowRestricted: (weekRaw ?? "") !== "*" && (weekRaw ?? "") !== "?",
  };
}

function matchesCron(parsed: ParsedCron, date: Date): boolean {
  if (!parsed.minutes.has(date.getMinutes())) return false;
  if (!parsed.hours.has(date.getHours())) return false;
  if (!parsed.months.has(date.getMonth() + 1)) return false;
  const domMatch = parsed.daysOfMonth.has(date.getDate());
  const dowMatch = parsed.daysOfWeek.has(date.getDay());
  if (parsed.domRestricted && parsed.dowRestricted) return domMatch || dowMatch;
  if (parsed.domRestricted) return domMatch;
  if (parsed.dowRestricted) return dowMatch;
  return true;
}

/**
 * 计算 `from` **之后**的下一次触发时刻（严格大于 from，秒/毫秒截断到 0）。
 *
 * 实现是朴素的「逐分钟推进」：从 from 的下一分钟开始，最多推进 366 天。
 * 为什么不做字段级跳跃优化：本机单用户、最多 50 条工作流，一次求解 36 万次循环
 * 也就是毫秒级；逐分钟推进的代码可以直接对着语义读，出错概率远低于手写跳跃。
 */
export function nextCronRun(expression: string, from: Date): Date | null {
  if (Number.isNaN(from.getTime())) return null;
  const parsed = parseCron(expression);
  if (!parsed) return null;
  const candidate = new Date(from.getTime());
  // 对齐到下一分钟：cron 的触发点永远是 :00 秒。
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1);
  const maxSteps = MAX_LOOKAHEAD_DAYS * MINUTES_PER_DAY;
  for (let step = 0; step < maxSteps; step += 1) {
    if (matchesCron(parsed, candidate)) return candidate;
    candidate.setMinutes(candidate.getMinutes() + 1);
  }
  return null;
}

/** 表达式是否合法（UI 校验与 getNextRun 共用，避免两处判断分叉）。 */
export function isValidCron(expression: string): boolean {
  return parseCron(expression) !== null;
}
