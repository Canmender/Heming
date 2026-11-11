/**
 * 排序（Sort）：按一个字段对 items 排序。
 *
 * 为什么缺字段的 item 永远排在最后：升序里「没有值」如果排最前，用户会看到
 * 一堆空行挡住了真正的数据；降序里排最后同理。排序是稳定的（相同值保持原顺序），
 * 这样「先按状态排、再按时间排」这类组合用法不会随机打乱。
 */

import type { INodeType, Item } from "../../types";
import { getItemField, inputItems, readOption, readString } from "./helpers";

export type SortOrder = "asc" | "desc";
export type SortType = "string" | "number" | "dateTime";

export interface SortOptions {
  sortByField: string;
  order: SortOrder;
  type: SortType;
}

const ORDERS = ["asc", "desc"] as const;
const TYPES = ["string", "number", "dateTime"] as const;

/** 取可比较值；返回 null 表示「缺值/不可比较」，排序时放最后。 */
function comparableValue(item: Item, options: SortOptions): string | number | null {
  const raw = getItemField(item, options.sortByField);
  if (raw === undefined || raw === null || raw === "") return null;
  if (options.type === "number") {
    const number = typeof raw === "number" ? raw : Number(raw);
    return Number.isFinite(number) ? number : null;
  }
  if (options.type === "dateTime") {
    const millis = raw instanceof Date ? raw.getTime() : Date.parse(String(raw));
    return Number.isNaN(millis) ? null : millis;
  }
  return typeof raw === "string" ? raw : String(raw);
}

/** 纯排序函数（Item Lists 节点复用，保证两个节点的排序规则一致）。 */
export function sortItems(items: Item[], options: SortOptions): Item[] {
  if (!options.sortByField) return [...items];
  const factor = options.order === "desc" ? -1 : 1;
  const decorated = items.map((item, index) => ({
    item,
    index,
    value: comparableValue(item, options),
  }));
  decorated.sort((left, right) => {
    if (left.value === null && right.value === null) return left.index - right.index;
    if (left.value === null) return 1;
    if (right.value === null) return -1;
    if (left.value === right.value) return left.index - right.index;
    return left.value < right.value ? -1 * factor : 1 * factor;
  });
  return decorated.map((entry) => entry.item);
}

export const sortNode: INodeType = {
  description: {
    type: "sort",
    displayName: "排序",
    group: "transform",
    description: "按指定字段升序或降序排列数据；缺字段的数据排在最后。",
    icon: "sort",
    inputs: 1,
    outputs: 1,
    version: 1,
    properties: [
      {
        name: "sortByField",
        displayName: "排序字段",
        type: "string",
        default: "",
        placeholder: "例如 createdAt 或 user.name",
        description: "支持点路径（a.b[0]）；留空则不排序。",
      },
      {
        name: "order",
        displayName: "顺序",
        type: "options",
        default: "asc",
        options: [
          { name: "升序", value: "asc" },
          { name: "降序", value: "desc" },
        ],
      },
      {
        name: "type",
        displayName: "比较方式",
        type: "options",
        default: "string",
        description: "按字符串、数字还是日期时间比较。",
        options: [
          { name: "字符串", value: "string" },
          { name: "数字", value: "number" },
          { name: "日期时间", value: "dateTime" },
        ],
      },
    ],
  },

  async execute(context) {
    const options: SortOptions = {
      sortByField: readString(context, "sortByField", "").trim(),
      order: readOption<SortOrder>(context, "order", ORDERS, "asc"),
      type: readOption<SortType>(context, "type", TYPES, "string"),
    };
    return { main: [sortItems(inputItems(context), options)] };
  },
};
