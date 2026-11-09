/**
 * 列表操作（Item Lists）：把「限制 / 排序 / 去重 / 拆分 / 汇总」收进一个节点。
 *
 * 为什么既要有独立节点又要有这个节点：画布上「一个列表操作」用一个节点表达更紧凑
 * （用户不用为了排序+限制连两条线），但实现必须复用独立节点的**同一套纯函数**，
 * 否则两个入口的排序/去重语义会分叉。这里只做参数归一与分发，没有第二套逻辑。
 */

import type { INodeType, Item } from "../../types.js";
import { aggregateItems, parseAggregateFields, type AggregateMode } from "./aggregate.js";
import {
  dedupeItems,
  parseFieldList,
  type DedupeMode,
} from "./removeDuplicates.js";
import { inputItems, readBoolean, readJsonArray, readNumber, readOption, readString } from "./helpers.js";
import { limitItems, type LimitKeep } from "./limit.js";
import { sortItems, type SortOrder, type SortType } from "./sort.js";
import { splitOutItems } from "./splitOut.js";

export const ITEM_LIST_OPERATIONS = [
  "limit",
  "sort",
  "removeDuplicates",
  "splitOut",
  "aggregateItems",
] as const;

export type ItemListOperation = (typeof ITEM_LIST_OPERATIONS)[number];

const ORDERS = ["asc", "desc"] as const;
const TYPES = ["string", "number", "dateTime"] as const;
const KEEP = ["firstItems", "lastItems"] as const;
const DEDUPE_MODES = ["allFields", "selectedFields"] as const;
const AGGREGATE_MODES = ["allItemData", "individualFields"] as const;

export const itemListsNode: INodeType = {
  description: {
    type: "itemLists",
    displayName: "列表操作",
    group: "transform",
    description: "对数据列表做限制、排序、去重、拆分或汇总，一个节点完成常见列表处理。",
    icon: "list",
    inputs: 1,
    outputs: 1,
    version: 1,
    properties: [
      {
        name: "operation",
        displayName: "操作",
        type: "options",
        default: "limit",
        options: [
          { name: "限制数量", value: "limit" },
          { name: "排序", value: "sort" },
          { name: "去重", value: "removeDuplicates" },
          { name: "拆分成多条", value: "splitOut" },
          { name: "汇总", value: "aggregateItems" },
        ],
      },
      // ---- 限制数量 ----
      {
        name: "maxItems",
        displayName: "最大条数",
        type: "number",
        default: 10,
        displayOptions: { show: { operation: ["limit"] } },
      },
      {
        name: "keep",
        displayName: "保留",
        type: "options",
        default: "firstItems",
        options: [
          { name: "前 N 条", value: "firstItems" },
          { name: "后 N 条", value: "lastItems" },
        ],
        displayOptions: { show: { operation: ["limit"] } },
      },
      // ---- 排序 ----
      {
        name: "sortByField",
        displayName: "排序字段",
        type: "string",
        default: "",
        placeholder: "例如 createdAt 或 user.name",
        displayOptions: { show: { operation: ["sort"] } },
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
        displayOptions: { show: { operation: ["sort"] } },
      },
      {
        name: "type",
        displayName: "比较方式",
        type: "options",
        default: "string",
        options: [
          { name: "字符串", value: "string" },
          { name: "数字", value: "number" },
          { name: "日期时间", value: "dateTime" },
        ],
        displayOptions: { show: { operation: ["sort"] } },
      },
      // ---- 去重 ----
      {
        name: "mode",
        displayName: "比较方式",
        type: "options",
        default: "allFields",
        options: [
          { name: "所有字段", value: "allFields" },
          { name: "指定字段", value: "selectedFields" },
        ],
        displayOptions: { show: { operation: ["removeDuplicates"] } },
      },
      {
        name: "fields",
        displayName: "字段列表",
        type: "json",
        default: [],
        description: '比较哪些字段，例如 ["id"]。',
        displayOptions: { show: { operation: ["removeDuplicates"], mode: ["selectedFields"] } },
      },
      // ---- 拆分 ----
      {
        name: "fieldToSplitOut",
        displayName: "要拆分的字段",
        type: "string",
        default: "",
        placeholder: "例如 items 或 data.list",
        displayOptions: { show: { operation: ["splitOut"] } },
      },
      {
        name: "includeOtherFields",
        displayName: "保留其它字段",
        type: "boolean",
        default: false,
        displayOptions: { show: { operation: ["splitOut"] } },
      },
      {
        name: "destinationFieldName",
        displayName: "标量存放字段",
        type: "string",
        default: "value",
        displayOptions: { show: { operation: ["splitOut"] } },
      },
      // ---- 汇总 ----
      {
        name: "aggregate",
        displayName: "汇总方式",
        type: "options",
        default: "allItemData",
        options: [
          { name: "收集全部数据", value: "allItemData" },
          { name: "按字段聚合", value: "individualFields" },
        ],
        displayOptions: { show: { operation: ["aggregateItems"] } },
      },
      {
        name: "destinationFieldName",
        displayName: "存放字段名",
        type: "string",
        default: "data",
        displayOptions: { show: { operation: ["aggregateItems"], aggregate: ["allItemData"] } },
      },
      {
        name: "fieldsToAggregate",
        displayName: "聚合字段",
        type: "json",
        default: [{ fieldName: "", aggregation: "sum" }],
        displayOptions: {
          show: { operation: ["aggregateItems"], aggregate: ["individualFields"] },
        },
      },
    ],
  },

  async execute(context) {
    const operation = readOption<ItemListOperation>(
      context,
      "operation",
      ITEM_LIST_OPERATIONS,
      "limit",
    );
    const items = inputItems(context);
    let output: Item[];
    switch (operation) {
      case "sort":
        output = sortItems(items, {
          sortByField: readString(context, "sortByField", "").trim(),
          order: readOption<SortOrder>(context, "order", ORDERS, "asc"),
          type: readOption<SortType>(context, "type", TYPES, "string"),
        });
        break;
      case "removeDuplicates":
        output = dedupeItems(items, {
          mode: readOption<DedupeMode>(context, "mode", DEDUPE_MODES, "allFields"),
          fields: parseFieldList(context.getNodeParameter<unknown>("fields", [])),
        });
        break;
      case "splitOut":
        output = splitOutItems(items, {
          fieldToSplitOut: readString(context, "fieldToSplitOut", ""),
          includeOtherFields: readBoolean(context, "includeOtherFields", false),
          destinationFieldName: readString(context, "destinationFieldName", "value") || "value",
        });
        break;
      case "aggregateItems":
        output = aggregateItems(items, {
          aggregate: readOption<AggregateMode>(context, "aggregate", AGGREGATE_MODES, "allItemData"),
          destinationFieldName: readString(context, "destinationFieldName", "data"),
          fields: parseAggregateFields(readJsonArray(context, "fieldsToAggregate", "聚合字段")),
        });
        break;
      case "limit":
      default:
        output = limitItems(items, {
          maxItems: readNumber(context, "maxItems", 10),
          keep: readOption<LimitKeep>(context, "keep", KEEP, "firstItems"),
        });
        break;
    }
    return { main: [output] };
  },
};
