/**
 * `$now` / `$today` 的最小日期能力（不引日期库）。
 *
 * 为什么不引 dayjs / date-fns：工作流模块只用到「格式化、加减、取整」三件事，
 * 引一个库要背上打包体积、时区黑盒与版本锁定，收益不抵成本。
 * 这里全部用本地时区（`new Date()` 的本地语义），与自动化模块「本地时区」口径一致；
 * 跨时区/夏令时的精确边界不在本版承诺内（需要时用 `toISO()` 交给下游处理）。
 */

import type { DateUnit, WorkflowDate } from "../types.js";

const UNIT_MS: Record<DateUnit, number> = {
  second: 1_000,
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
  week: 7 * 86_400_000,
  month: 0,
  year: 0,
};

function pad(value: number, width = 2): string {
  return String(Math.abs(value)).padStart(width, "0");
}

/** 本地时区的 ISO 字符串（带毫秒与偏移量）。 */
function localIso(date: Date): string {
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const offset = `${sign}${pad(Math.floor(Math.abs(offsetMinutes) / 60))}:${pad(Math.abs(offsetMinutes) % 60)}`;
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}` +
    offset
  );
}

/** 常用格式：支持 yyyy / MM / dd / HH / mm / ss / SSS，其余字符原样输出。 */
function formatDate(date: Date, pattern = "yyyy-MM-dd HH:mm:ss"): string {
  return pattern.replace(/yyyy|MM|dd|HH|mm|ss|SSS/g, (token) => {
    switch (token) {
      case "yyyy":
        return String(date.getFullYear());
      case "MM":
        return pad(date.getMonth() + 1);
      case "dd":
        return pad(date.getDate());
      case "HH":
        return pad(date.getHours());
      case "mm":
        return pad(date.getMinutes());
      case "ss":
        return pad(date.getSeconds());
      case "SSS":
        return pad(date.getMilliseconds(), 3);
      default:
        return token;
    }
  });
}

function addUnits(date: Date, amount: number, unit: DateUnit): Date {
  const next = new Date(date.getTime());
  if (unit === "month") {
    next.setMonth(next.getMonth() + amount);
    return next;
  }
  if (unit === "year") {
    next.setFullYear(next.getFullYear() + amount);
    return next;
  }
  next.setTime(next.getTime() + amount * UNIT_MS[unit]);
  return next;
}

function startOf(date: Date, unit: DateUnit): Date {
  const next = new Date(date.getTime());
  switch (unit) {
    case "second":
      next.setMilliseconds(0);
      return next;
    case "minute":
      next.setSeconds(0, 0);
      return next;
    case "hour":
      next.setMinutes(0, 0, 0);
      return next;
    case "day":
      next.setHours(0, 0, 0, 0);
      return next;
    case "week": {
      // 与自动化模块一致：周一为一周起点
      const day = (next.getDay() + 6) % 7;
      next.setHours(0, 0, 0, 0);
      next.setDate(next.getDate() - day);
      return next;
    }
    case "month":
      next.setDate(1);
      next.setHours(0, 0, 0, 0);
      return next;
    case "year":
      next.setMonth(0, 1);
      next.setHours(0, 0, 0, 0);
      return next;
    default:
      return next;
  }
}

/** 一个不可变的日期包装：所有加减都返回新对象，表达式里不会互相污染。 */
export class WorkflowDateImpl implements WorkflowDate {
  private readonly date: Date;

  constructor(date: Date | number | string) {
    this.date = date instanceof Date ? new Date(date.getTime()) : new Date(date);
  }

  toISO(): string {
    return localIso(this.date);
  }

  format(pattern?: string): string {
    return formatDate(this.date, pattern);
  }

  toMillis(): number {
    return this.date.getTime();
  }

  toDate(): Date {
    return new Date(this.date.getTime());
  }

  plus(amount: number, unit: DateUnit): WorkflowDateImpl {
    return new WorkflowDateImpl(addUnits(this.date, amount, unit));
  }

  minus(amount: number, unit: DateUnit): WorkflowDateImpl {
    return new WorkflowDateImpl(addUnits(this.date, -amount, unit));
  }

  startOf(unit: DateUnit): WorkflowDateImpl {
    return new WorkflowDateImpl(startOf(this.date, unit));
  }

  /** 便于拼接的字符串形式（`"" + $now`）。 */
  toString(): string {
    return localIso(this.date);
  }

  toJSON(): string {
    return this.toISO();
  }
}

/** 造一个 `$now`/`$today`。 */
export function createWorkflowDate(date: Date | number | string): WorkflowDateImpl {
  return new WorkflowDateImpl(date);
}
