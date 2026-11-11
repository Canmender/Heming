/**
 * 拆分（Split Out）：把某个字段里的数组拆成多条数据。
 *
 * 典型场景：接口返回 `{ items: [...] }`，后续节点想逐条处理数组元素。
 * 元素是对象 ⇒ 把它的字段并进输出（可选是否保留外层其它字段）；
 * 元素是标量 ⇒ 放进目标字段（`destinationFieldName`），因为 item.json 必须是对象。
 * 字段不存在或值为 null 时跳过该条（不是报错）：列表接口返回空字段很常见。
 */

import type { INodeType, Item } from "../../types";
import {
  getItemField,
  inputItems,
  isPlainObject,
  readBoolean,
  readString,
} from "./helpers";

export interface SplitOutOptions {
  fieldToSplitOut: string;
  includeOtherFields: boolean;
  destinationFieldName: string;
}

/** 删除外层字段本身；字段是点路径时只删首段（`a.b` ⇒ 删 `a`）。 */
function deleteSplitField(json: Record<string, unknown>, field: string): void {
  const topLevel = field.split(/[.[\]]/).filter((part) => part !== "")[0];
  if (topLevel) delete json[topLevel];
}

/** 纯拆分函数（Item Lists 节点复用）。 */
export function splitOutItems(items: Item[], options: SplitOutOptions): Item[] {
  const field = options.fieldToSplitOut.trim();
  if (!field) return [];
  const output: Item[] = [];
  items.forEach((item, itemIndex) => {
    const value = getItemField(item, field);
    if (value === undefined || value === null) return;
    const elements = Array.isArray(value) ? value : [value];
    for (const element of elements) {
      let json: Record<string, unknown>;
      if (isPlainObject(element)) {
        json = options.includeOtherFields ? { ...item.json, ...element } : { ...element };
      } else {
        json = options.includeOtherFields ? { ...item.json } : {};
        json[options.destinationFieldName] = element;
      }
      // 拆分字段本身不再出现在输出里，避免「外层 items 又套着原数组」的困惑。
      if (options.includeOtherFields) deleteSplitField(json, field);
      output.push({ json, pairedItem: itemIndex });
    }
  });
  return output;
}

export const splitOutNode: INodeType = {
  description: {
    type: "splitOut",
    displayName: "拆分成多条",
    group: "transform",
    description: "把某字段里的数组拆成多条数据，便于逐条处理。",
    icon: "split",
    inputs: 1,
    outputs: 1,
    version: 1,
    properties: [
      {
        name: "fieldToSplitOut",
        displayName: "要拆分的字段",
        type: "string",
        default: "",
        required: true,
        placeholder: "例如 items 或 data.list",
        description: "该字段的值应当是数组（单个对象也可以）。",
      },
      {
        name: "includeOtherFields",
        displayName: "保留其它字段",
        type: "boolean",
        default: false,
        description: "拆分出的是对象时，是否连同外层字段一起输出。",
      },
      {
        name: "destinationFieldName",
        displayName: "标量存放字段",
        type: "string",
        default: "value",
        description: "拆分出的是字符串/数字时，放进哪个字段。",
      },
    ],
  },

  async execute(context) {
    const options: SplitOutOptions = {
      fieldToSplitOut: readString(context, "fieldToSplitOut", ""),
      includeOtherFields: readBoolean(context, "includeOtherFields", false),
      destinationFieldName: readString(context, "destinationFieldName", "value") || "value",
    };
    return { main: [splitOutItems(inputItems(context), options)] };
  },
};
