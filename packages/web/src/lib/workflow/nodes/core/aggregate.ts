/**
 * 汇总（Aggregate）：把多条数据压成一条。
 *
 * 两种用法：
 * - allItemData：把全部 item 的 json 收进一个数组字段（最常见的「攒起来一次写回」）；
 * - individualFields：对指定字段做求和/平均/去重/拼接等聚合。
 *
 * 为什么输出永远是**一条** item：汇总的语义就是「多条进、一条出」；
 * 即使输入为空也输出一条（计数为 0、数组为空），否则下游会因为「没有输入」
 * 而整段不执行，用户看到的像是节点坏了。
 */

import type { INodeType, Item } from "../../types.js";
import {
  getItemField,
  inputItems,
  isPlainObject,
  readJsonArray,
  readOption,
  readString,
  stableStringify,
} from "./helpers.js";

export type AggregateMode = "allItemData" | "individualFields";

export const AGGREGATIONS = [
  "sum",
  "average",
  "min",
  "max",
  "count",
  "countUnique",
  "unique",
  "concatenate",
  "first",
  "last",
] as const;

export type Aggregation = (typeof AGGREGATIONS)[number];

export interface AggregateField {
  fieldName: string;
  aggregation: Aggregation;
}

export interface AggregateOptions {
  aggregate: AggregateMode;
  destinationFieldName: string;
  fields: AggregateField[];
}

const MODES = ["allItemData", "individualFields"] as const;

function toNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }
  return null;
}

function valueToText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return stableStringify(value);
}

function aggregateField(items: Item[], fieldName: string, aggregation: Aggregation): unknown {
  const values = items
    .map((item) => getItemField(item, fieldName))
    .filter((value) => value !== undefined && value !== null);
  const numbers = values
    .map((value) => toNumber(value))
    .filter((value): value is number => value !== null);
  switch (aggregation) {
    case "sum":
      return numbers.reduce((total, value) => total + value, 0);
    case "average":
      return numbers.length === 0
        ? 0
        : numbers.reduce((total, value) => total + value, 0) / numbers.length;
    case "min":
      return numbers.length === 0 ? null : Math.min(...numbers);
    case "max":
      return numbers.length === 0 ? null : Math.max(...numbers);
    case "count":
      // 「计数」数的是数据条数（含缺字段的），与 n8n 的口径一致。
      return items.length;
    case "countUnique":
      return new Set(values.map((value) => stableStringify(value))).size;
    case "unique": {
      const seen = new Set<string>();
      const unique: unknown[] = [];
      for (const value of values) {
        const key = stableStringify(value);
        if (seen.has(key)) continue;
        seen.add(key);
        unique.push(value);
      }
      return unique;
    }
    case "concatenate":
      return values.map((value) => valueToText(value)).join(",");
    case "first":
      return values.length === 0 ? null : values[0];
    case "last":
      return values.length === 0 ? null : values[values.length - 1];
    default:
      return null;
  }
}

/** 汇总字段参数的归一：忽略没有 fieldName 的条目，聚合方式落回 sum。 */
export function parseAggregateFields(raw: unknown[]): AggregateField[] {
  const fields: AggregateField[] = [];
  const allowed = new Set<string>(AGGREGATIONS);
  for (const entry of raw) {
    if (!isPlainObject(entry)) continue;
    const fieldName = typeof entry.fieldName === "string" ? entry.fieldName.trim() : "";
    if (!fieldName) continue;
    const aggregation =
      typeof entry.aggregation === "string" && allowed.has(entry.aggregation)
        ? (entry.aggregation as Aggregation)
        : "sum";
    fields.push({ fieldName, aggregation });
  }
  return fields;
}

/** 纯汇总函数（Item Lists 节点复用）。 */
export function aggregateItems(items: Item[], options: AggregateOptions): Item[] {
  if (options.aggregate === "allItemData") {
    const destination = options.destinationFieldName.trim() || "data";
    return [{ json: { [destination]: items.map((item) => item.json) } }];
  }
  const json: Record<string, unknown> = {};
  for (const field of options.fields) {
    json[field.fieldName] = aggregateField(items, field.fieldName, field.aggregation);
  }
  return [{ json }];
}

export const aggregateNode: INodeType = {
  description: {
    type: "aggregate",
    displayName: "汇总",
    group: "transform",
    description: "把多条数据合并成一条：收集成数组，或对字段求和/平均/去重/拼接。",
    icon: "layers",
    inputs: 1,
    outputs: 1,
    version: 1,
    properties: [
      {
        name: "aggregate",
        displayName: "汇总方式",
        type: "options",
        default: "allItemData",
        options: [
          { name: "收集全部数据", value: "allItemData" },
          { name: "按字段聚合", value: "individualFields" },
        ],
      },
      {
        name: "destinationFieldName",
        displayName: "存放字段名",
        type: "string",
        default: "data",
        description: "收集全部数据时，数组放进哪个字段。",
        displayOptions: { show: { aggregate: ["allItemData"] } },
      },
      {
        name: "fieldsToAggregate",
        displayName: "聚合字段",
        type: "json",
        default: [{ fieldName: "", aggregation: "sum" }],
        description:
          '形如 [{"fieldName":"amount","aggregation":"sum"}]；聚合方式支持 sum/average/min/max/count/countUnique/unique/concatenate/first/last。',
        displayOptions: { show: { aggregate: ["individualFields"] } },
      },
    ],
  },

  async execute(context) {
    const mode = readOption<AggregateMode>(context, "aggregate", MODES, "allItemData");
    const options: AggregateOptions = {
      aggregate: mode,
      destinationFieldName: readString(context, "destinationFieldName", "data"),
      fields: parseAggregateFields(
        readJsonArray(context, "fieldsToAggregate", "聚合字段"),
      ),
    };
    return { main: [aggregateItems(inputItems(context), options)] };
  },
};
