/**
 * 合并（Merge）：把两个输入口的数据合到一起。
 *
 * 四种模式对应四类真实用法：
 * - append：排队拼接（两个数据源汇总）；
 * - combineByPosition：按下标一一配对（两边是同一批数据的两个视角）；
 * - combineByField：按字段关联（类似 join，例如按 id 关联用户与订单）；
 * - chooseBranch：只取其中一路（调试或条件分支收口）。
 *
 * 第二输入口在画布上可能没连线，此时 `getInputData(1)` 是空数组，
 * 各模式都按「只有一路数据」正常工作，而不是报错。
 */

import type { INodeType, Item } from "../../types";
import {
  errorText,
  inputItems,
  isPlainObject,
  readJsonArray,
  readOption,
  secondaryInputItems,
  WorkflowNodeError,
} from "./helpers";

export const MERGE_MODES = [
  "append",
  "combineByPosition",
  "combineByField",
  "chooseBranch",
] as const;

export type MergeMode = (typeof MERGE_MODES)[number];

export type MergeJoinType = "keepEverything" | "keepMatchesOnly";

const JOIN_TYPES = ["keepEverything", "keepMatchesOnly"] as const;
const BRANCHES = ["input1", "input2"] as const;

interface FieldPair {
  field1: string;
  field2: string;
}

/** 解析按字段关联的字段对；结构不对时给出可读错误。 */
function parseFieldPairs(raw: unknown[]): FieldPair[] {
  const pairs: FieldPair[] = [];
  for (const entry of raw) {
    if (!isPlainObject(entry)) continue;
    const field1 = typeof entry.field1 === "string" ? entry.field1.trim() : "";
    const field2 = typeof entry.field2 === "string" ? entry.field2.trim() : "";
    if (!field1 || !field2) continue;
    pairs.push({ field1, field2 });
  }
  if (pairs.length === 0) {
    throw new WorkflowNodeError("按字段合并时至少要指定一组关联字段", {
      description: '形如 [{"field1":"id","field2":"id"}]。',
    });
  }
  return pairs;
}

/** 把两侧字段采集出来做相等判断（按值比较；数字与字符串不混用）。 */
function buildJoinKey(item: Item, field: string): string {
  let value: unknown = item.json;
  for (const part of field.replace(/\[(\d+)\]/g, ".$1").split(".").filter((key) => key !== "")) {
    if (value === null || value === undefined || typeof value !== "object") return "undefined";
    value = Array.isArray(value)
      ? value[Number(part)]
      : (value as Record<string, unknown>)[part];
  }
  return JSON.stringify(value) ?? "undefined";
}

function mergedItem(left: Item, right: Item): Item {
  return { json: { ...left.json, ...right.json } };
}

function combineByPosition(left: Item[], right: Item[]): Item[] {
  const length = Math.max(left.length, right.length);
  const output: Item[] = [];
  for (let index = 0; index < length; index += 1) {
    const leftItem = left[index];
    const rightItem = right[index];
    if (leftItem && rightItem) output.push(mergedItem(leftItem, rightItem));
    else if (leftItem) output.push(leftItem);
    else if (rightItem) output.push(rightItem);
  }
  return output;
}

function combineByField(
  left: Item[],
  right: Item[],
  pairs: FieldPair[],
  joinType: MergeJoinType,
): Item[] {
  const rightMatched = new Set<number>();
  const output: Item[] = [];
  left.forEach((leftItem) => {
    let matched = false;
    right.forEach((rightItem, rightIndex) => {
      const isMatch = pairs.every(
        (pair) => buildJoinKey(leftItem, pair.field1) === buildJoinKey(rightItem, pair.field2),
      );
      if (!isMatch) return;
      matched = true;
      rightMatched.add(rightIndex);
      output.push(mergedItem(leftItem, rightItem));
    });
    if (!matched && joinType === "keepEverything") output.push(leftItem);
  });
  if (joinType === "keepEverything") {
    right.forEach((rightItem, rightIndex) => {
      if (!rightMatched.has(rightIndex)) output.push(rightItem);
    });
  }
  return output;
}

export const mergeNode: INodeType = {
  description: {
    type: "merge",
    displayName: "合并",
    group: "flow",
    description: "把两路数据合并：排队拼接、按下标配对、按字段关联，或只取其中一路。",
    icon: "merge",
    inputs: 2,
    outputs: 1,
    version: 1,
    properties: [
      {
        name: "mode",
        displayName: "合并方式",
        type: "options",
        default: "append",
        options: [
          { name: "排队拼接", value: "append" },
          { name: "按下标配对", value: "combineByPosition" },
          { name: "按字段关联", value: "combineByField" },
          { name: "只取一路", value: "chooseBranch" },
        ],
      },
      {
        name: "fieldsToMatch",
        displayName: "关联字段",
        type: "json",
        default: [{ field1: "id", field2: "id" }],
        description: '形如 [{"field1":"左字段","field2":"右字段"}]，支持点路径。',
        displayOptions: { show: { mode: ["combineByField"] } },
      },
      {
        name: "joinType",
        displayName: "输出内容",
        type: "options",
        default: "keepEverything",
        options: [
          { name: "匹配项 + 未匹配项", value: "keepEverything" },
          { name: "只保留匹配项", value: "keepMatchesOnly" },
        ],
        displayOptions: { show: { mode: ["combineByField"] } },
      },
      {
        name: "branch",
        displayName: "取哪一路",
        type: "options",
        default: "input1",
        options: [
          { name: "输入 1", value: "input1" },
          { name: "输入 2", value: "input2" },
        ],
        displayOptions: { show: { mode: ["chooseBranch"] } },
      },
    ],
  },

  async execute(context) {
    const mode = readOption<MergeMode>(context, "mode", MERGE_MODES, "append");
    const left = inputItems(context, 0);
    const right = secondaryInputItems(context);

    switch (mode) {
      case "combineByPosition":
        return { main: [combineByPosition(left, right)] };
      case "combineByField": {
        let pairs: FieldPair[];
        try {
          pairs = parseFieldPairs(readJsonArray(context, "fieldsToMatch", "关联字段"));
        } catch (error) {
          throw error instanceof WorkflowNodeError
            ? error
            : new WorkflowNodeError("关联字段参数有误", { description: errorText(error) });
        }
        const joinType = readOption<MergeJoinType>(context, "joinType", JOIN_TYPES, "keepEverything");
        return { main: [combineByField(left, right, pairs, joinType)] };
      }
      case "chooseBranch": {
        const branch = readOption<string>(context, "branch", BRANCHES, "input1");
        return { main: [branch === "input2" ? right : left] };
      }
      case "append":
      default:
        return { main: [[...left, ...right]] };
    }
  },
};
