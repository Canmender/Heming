/**
 * 定时触发：按「间隔 / 每天 / 每周 / Cron」计算下一次触发时刻。
 *
 * `getNextRun(parameters, from)` 是**纯函数**：返回严格晚于 from 的下一个触发时刻，
 * 非法参数返回 null（调度器据此判断「这条工作流没法定时」，不会拿坏值去跑）。
 * 调度器约定（CONTRACT §5）：把上一次算出的触发时刻作为下一次的 from，
 * 因此本函数必须是「固定点」友好的——从恰好等于触发时刻的 from 出发，
 * 必须给出下一个周期，而不是同一个时刻。
 *
 * 时间语义全部按**本机本地时区**（模块设置只有 `timezone: "local"`）。
 */

import type { INodeType } from "../../types";
import { nextCronRun } from "./cron";

const INTERVALS = ["seconds", "minutes", "hours", "days", "weeks", "cron"] as const;
type Interval = (typeof INTERVALS)[number];

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

function pickInterval(value: unknown): Interval {
  return typeof value === "string" && (INTERVALS as readonly string[]).includes(value)
    ? (value as Interval)
    : "hours";
}

function pickInteger(value: unknown, min: number, max: number, fallback: number): number | null {
  // 缺省/空串用默认值；给了值但不可解析（NaN、非数字串、越界）返回 null，
  // 让 getNextRun 明确表示「这条定时规则不可用」，而不是悄悄按默认值跑。
  if (value === undefined || value === null || value === "") return fallback;
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) return null;
  const integer = Math.trunc(number);
  if (integer < min || integer > max) return null;
  return integer;
}

/** 「每天」的下一次：今天的目标时刻还没到就是今天，否则顺延 N 天。 */
function nextDaily(from: Date, count: number, hour: number, minute: number): Date {
  const candidate = new Date(from.getTime());
  candidate.setHours(hour, minute, 0, 0);
  if (candidate.getTime() <= from.getTime()) {
    candidate.setDate(candidate.getDate() + count);
  }
  return candidate;
}

/**
 * 「每周」的下一次：先找最近的目标星期 + 目标时刻；
 * 若 from 恰好就是那个时刻，则按 N 周顺延（保证固定点不返回同一时刻）。
 * 首次触发可能落在「本周的目标星期」，之后由调度器以触发时刻为 from 推进，
 * 才严格按 N 周走——这是没有激活锚点时能做到的最合理解释，写在这里备忘。
 */
function nextWeekly(
  from: Date,
  count: number,
  hour: number,
  minute: number,
  isoDayOfWeek: number,
): Date {
  const targetJsDay = isoDayOfWeek % 7;
  const base = new Date(from.getTime());
  base.setHours(hour, minute, 0, 0);
  const candidate = new Date(base.getTime());
  const deltaDays = (targetJsDay - base.getDay() + 7) % 7;
  candidate.setDate(base.getDate() + deltaDays);
  if (candidate.getTime() <= from.getTime()) {
    candidate.setDate(candidate.getDate() + 7 * count);
  }
  return candidate;
}

export const scheduleTrigger: INodeType = {
  description: {
    type: "scheduleTrigger",
    displayName: "定时触发",
    group: "trigger",
    description: "按固定间隔、每天、每周或 Cron 表达式定时启动工作流。",
    icon: "clock",
    inputs: 0,
    outputs: 1,
    isTrigger: true,
    trigger: "schedule",
    defaultName: "定时触发",
    version: 1,
    properties: [
      {
        name: "triggerInterval",
        displayName: "触发方式",
        type: "options",
        default: "hours",
        description: "选择按时间间隔、每天/每周固定时刻，还是自定义 Cron 表达式。",
        options: [
          { name: "间隔（秒）", value: "seconds" },
          { name: "间隔（分钟）", value: "minutes" },
          { name: "间隔（小时）", value: "hours" },
          { name: "每天", value: "days" },
          { name: "每周", value: "weeks" },
          { name: "Cron 表达式", value: "cron" },
        ],
      },
      {
        name: "intervalCount",
        displayName: "间隔数量",
        type: "number",
        default: 1,
        description: "每隔几个单位触发一次，例如「小时 + 2」是每两小时一次。",
        displayOptions: {
          show: { triggerInterval: ["seconds", "minutes", "hours", "days", "weeks"] },
        },
      },
      {
        name: "triggerAtHour",
        displayName: "小时",
        type: "number",
        default: 9,
        description: "每天/每周在几点触发（0–23）。",
        displayOptions: { show: { triggerInterval: ["days", "weeks"] } },
      },
      {
        name: "triggerAtMinute",
        displayName: "分钟",
        type: "number",
        default: 0,
        description: "在几分触发（0–59）。",
        displayOptions: { show: { triggerInterval: ["days", "weeks"] } },
      },
      {
        name: "triggerAtDayOfWeek",
        displayName: "星期",
        type: "options",
        default: 1,
        description: "每周几触发。",
        options: [
          { name: "周一", value: 1 },
          { name: "周二", value: 2 },
          { name: "周三", value: 3 },
          { name: "周四", value: 4 },
          { name: "周五", value: 5 },
          { name: "周六", value: 6 },
          { name: "周日", value: 7 },
        ],
        displayOptions: { show: { triggerInterval: ["weeks"] } },
      },
      {
        name: "cronExpression",
        displayName: "Cron 表达式",
        type: "string",
        default: "0 9 * * *",
        placeholder: "分 时 日 月 周，例如 0 9 * * 1-5",
        description:
          "标准 5 段 Cron（分 时 日 月 周），支持 *、列表、范围与步长；按本机时区计算。",
        displayOptions: { show: { triggerInterval: ["cron"] } },
      },
    ],
  },

  getNextRun(parameters, from) {
    if (Number.isNaN(from.getTime())) return null;
    const interval = pickInterval(parameters.triggerInterval);
    const count = pickInteger(parameters.intervalCount, 1, 100_000, 1);
    if (count === null) return null;

    switch (interval) {
      case "seconds":
        return new Date(from.getTime() + count * 1000);
      case "minutes":
        return new Date(from.getTime() + count * MINUTE_MS);
      case "hours":
        return new Date(from.getTime() + count * HOUR_MS);
      case "days": {
        const hour = pickInteger(parameters.triggerAtHour, 0, 23, 9);
        const minute = pickInteger(parameters.triggerAtMinute, 0, 59, 0);
        if (hour === null || minute === null) return null;
        return nextDaily(from, count, hour, minute);
      }
      case "weeks": {
        const hour = pickInteger(parameters.triggerAtHour, 0, 23, 9);
        const minute = pickInteger(parameters.triggerAtMinute, 0, 59, 0);
        const dayOfWeek = pickInteger(parameters.triggerAtDayOfWeek, 1, 7, 1);
        if (hour === null || minute === null || dayOfWeek === null) return null;
        return nextWeekly(from, count, hour, minute, dayOfWeek);
      }
      case "cron": {
        const expression =
          typeof parameters.cronExpression === "string" ? parameters.cronExpression : "";
        return nextCronRun(expression, from);
      }
      default:
        return null;
    }
  },

  async execute() {
    // 定时触发不接收上游数据；输出一条带触发时间戳的空 item，下游可用表达式读取。
    return { main: [[{ json: { timestamp: Date.now() } }]] };
  },
};
