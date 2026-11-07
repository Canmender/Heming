/**
 * 去重（Remove Duplicates）：按整条 JSON 或指定字段组合去掉重复数据。
 *
 * 键用「稳定序列化」生成（对象键排序），否则 `{a:1,b:2}` 与 `{b:2,a:1}`
 * 会被当成两条不同数据——用户会觉得去重「偶尔不生效」。
 * 保留**首次出现**的那条，顺序不变：去重通常发生在排序/限制之后，顺序本身有意义。
 */

import type { INodeType, Item } from "../../types.js";
import {
  getItemField,
  inputItems,
  readOption,
  stableStringify,
} from "./helpers.js";

export type DedupeMode = "allFields" | "selectedFields";

export interface RemoveDuplicatesOptions {
  mode: DedupeMode;
  /** 选中的字段路径（mode=selectedFields 时使用）。 */
  fields: string[];
}

const MODES = ["allFields", "selectedFields"] as const;

/** 解析字段列表：JSON 数组、逗号分隔字符串都接受；坏 JSON 时退回字符串拆分。 */
export function parseFieldList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim())
      .filter((entry) => entry !== "");
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.startsWith("[")) {
      try {
        return parseFieldList(JSON.parse(trimmed) as unknown);
      } catch {
        // 不是合法 JSON 就按逗号串处理，避免一个手误把整条去重变成「全删」。
        return parseFieldList(trimmed.replace(/[[\]"]/g, ""));
      }
    }
    return trimmed
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry !== "");
  }
  return [];
}

function dedupeKey(item: Item, options: RemoveDuplicatesOptions): string {
  if (options.mode === "allFields") return stableStringify(item.json);
  return stableStringify(options.fields.map((field) => getItemField(item, field)));
}

/** 纯去重函数（Item Lists 节点复用）。 */
export function dedupeItems(items: Item[], options: RemoveDuplicatesOptions): Item[] {
  if (options.mode === "selectedFields" && options.fields.length === 0) {
    // 没选字段时退化为整条比较，而不是把所有数据都当成重复丢掉。
    return dedupeItems(items, { mode: "allFields", fields: [] });
  }
  const seen = new Set<string>();
  const output: Item[] = [];
  for (const item of items) {
    const key = dedupeKey(item, options);
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(item);
  }
  return output;
}

export const removeDuplicatesNode: INodeType = {
  description: {
    type: "removeDuplicates",
    displayName: "去重",
    group: "transform",
    description: "按整条数据或指定字段去掉重复项，保留首次出现的数据。",
    icon: "copy",
    inputs: 1,
    outputs: 1,
    version: 1,
    properties: [
      {
        name: "mode",
        displayName: "比较方式",
        type: "options",
        default: "allFields",
        options: [
          { name: "所有字段", value: "allFields" },
          { name: "指定字段", value: "selectedFields" },
        ],
      },
      {
        name: "fields",
        displayName: "字段列表",
        type: "json",
        default: [],
        description: '比较哪些字段，例如 ["id"] 或 ["user.email"]。',
        displayOptions: { show: { mode: ["selectedFields"] } },
      },
    ],
  },

  async execute(context) {
    const options: RemoveDuplicatesOptions = {
      mode: readOption<DedupeMode>(context, "mode", MODES, "allFields"),
      fields: parseFieldList(context.getNodeParameter<unknown>("fields", [])),
    };
    return { main: [dedupeItems(inputItems(context), options)] };
  },
};
