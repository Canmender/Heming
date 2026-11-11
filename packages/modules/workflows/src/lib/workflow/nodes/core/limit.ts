/**
 * 限制（Limit）：只保留前 N 条或后 N 条数据。
 *
 * 「前/后」比「从第几条开始」更贴近本模块的实际用法：抓回来一屏先做预览，
 * 或者只取最近几条写通知。数量非法时按 0 处理（输出空），而不是把非法值透传。
 */

import type { INodeType, Item } from "../../types";
import { clampInteger, inputItems, readNumber, readOption } from "./helpers";

export type LimitKeep = "firstItems" | "lastItems";

export interface LimitOptions {
  maxItems: number;
  keep: LimitKeep;
}

const KEEP = ["firstItems", "lastItems"] as const;

/** 纯限制函数（Item Lists 节点复用）。 */
export function limitItems(items: Item[], options: LimitOptions): Item[] {
  const maxItems = clampInteger(options.maxItems, 0, items.length);
  if (maxItems === 0) return [];
  return options.keep === "lastItems" ? items.slice(items.length - maxItems) : items.slice(0, maxItems);
}

export const limitNode: INodeType = {
  description: {
    type: "limit",
    displayName: "限制数量",
    group: "transform",
    description: "只保留前 N 条或后 N 条数据。",
    icon: "list",
    inputs: 1,
    outputs: 1,
    version: 1,
    properties: [
      {
        name: "maxItems",
        displayName: "最大条数",
        type: "number",
        default: 10,
        description: "最多保留多少条数据。",
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
      },
    ],
  },

  async execute(context) {
    const options: LimitOptions = {
      maxItems: readNumber(context, "maxItems", 10),
      keep: readOption<LimitKeep>(context, "keep", KEEP, "firstItems"),
    };
    return { main: [limitItems(inputItems(context), options)] };
  },
};
