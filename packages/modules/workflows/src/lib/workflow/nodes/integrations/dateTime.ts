/**
 * 日期时间节点：取当前时间、加减、取整、格式化、取某一部分。
 *
 * 为什么不引日期库：工作流时间几乎都是「本地时区 + 常见格式」，自带的
 * `WorkflowDate`（expressions/date.ts）已经覆盖；引 dayjs/date-fns 会把打包体积、
 * 时区黑盒与版本锁定一起带进来，收益不抵成本。
 */

import type { INodeType } from "../../types";
import { createWorkflowDate } from "../../expressions/date";
import type { DateUnit } from "../../types";
import { inputItems, readNumber, readString, withField } from "./helpers";

const UNITS: Array<{ name: string; value: string }> = [
  { name: "秒", value: "second" },
  { name: "分钟", value: "minute" },
  { name: "小时", value: "hour" },
  { name: "天", value: "day" },
  { name: "周", value: "week" },
  { name: "月", value: "month" },
  { name: "年", value: "year" },
];

const OPERATIONS = [
  { name: "取当前时间", value: "now" },
  { name: "加一段时间", value: "add" },
  { name: "减一段时间", value: "subtract" },
  { name: "取整到单位", value: "roundDown" },
  { name: "格式化", value: "format" },
  { name: "取某一部分", value: "extract" },
];

function isUnit(value: string): value is DateUnit {
  return ["second", "minute", "hour", "day", "week", "month", "year"].includes(value);
}

export const dateTimeNode: INodeType = {
  description: {
    type: "dateTime",
    displayName: "日期时间",
    group: "transform",
    description: "取当前时间、加减、取整、格式化，或取出年/月/日/时/分/秒。",
    icon: "calendar",
    inputs: 1,
    outputs: 1,
    version: 1,
    properties: [
      {
        name: "operation",
        displayName: "操作",
        type: "options",
        default: "now",
        options: OPERATIONS,
        description: "要做的日期操作。",
      },
      {
        name: "amount",
        displayName: "数量",
        type: "number",
        default: 1,
        description: "加减或取整的数量（取整时忽略）。",
        displayOptions: { show: { operation: ["add", "subtract"] } },
      },
      {
        name: "unit",
        displayName: "单位",
        type: "options",
        default: "day",
        options: UNITS,
        description: "以什么单位加减/取整/提取。",
        displayOptions: { show: { operation: ["add", "subtract", "roundDown", "extract"] } },
      },
      {
        name: "format",
        displayName: "格式",
        type: "string",
        default: "yyyy-MM-dd HH:mm:ss",
        placeholder: "yyyy-MM-dd HH:mm:ss",
        description: "格式占位：yyyy 年、MM 月、dd 日、HH 时、mm 分、ss 秒、SSS 毫秒。",
        displayOptions: { show: { operation: ["format"] } },
      },
      {
        name: "outputField",
        displayName: "结果字段",
        type: "string",
        default: "date",
        description: "把结果写到每条数据的哪个字段。",
      },
    ],
  },

  async execute(context) {
    const operation = readString(context, "operation", "now");
    const unitRaw = readString(context, "unit", "day");
    const unit: DateUnit = isUnit(unitRaw) ? unitRaw : "day";
    const amount = readNumber(context, "amount", 1);
    const pattern = readString(context, "format", "yyyy-MM-dd HH:mm:ss");
    const outputField = readString(context, "outputField", "date") || "date";
    const items = inputItems(context);

    const compute = (): unknown => {
      const now = createWorkflowDate(new Date());
      switch (operation) {
        case "add":
          return now.plus(amount, unit).toISO();
        case "subtract":
          return now.minus(amount, unit).toISO();
        case "roundDown":
          return now.startOf(unit).toISO();
        case "format":
          return now.format(pattern);
        case "extract": {
          // 提取用本地时间的各段值：月/日从 1 起，与用户直觉一致
          const date = now.toDate();
          switch (unit) {
            case "year":
              return date.getFullYear();
            case "month":
              return date.getMonth() + 1;
            case "day":
              return date.getDate();
            case "hour":
              return date.getHours();
            case "minute":
              return date.getMinutes();
            case "second":
              return date.getSeconds();
            case "week":
              return Math.ceil((date.getDate() + new Date(date.getFullYear(), date.getMonth(), 1).getDay()) / 7);
            default:
              return date.getTime();
          }
        }
        case "now":
        default:
          return now.toISO();
      }
    };

    const value = compute();
    return withField(items, outputField, value);
  },
};
