/**
 * 过滤（Filter）：只保留（或只丢弃）满足条件的数据。
 *
 * 与 If 的差别：If 分两路给下游连线；Filter 只把「留下的」继续往下传，
 * 条件语义与 If 完全共用 `helpers` 里的实现（避免两套比较规则）。
 */

import type { INodeType, Item } from "../../types";
import {
  inputItems,
  matchesConditionGroup,
  parseConditionGroup,
  readBoolean,
} from "./helpers";

export const filterNode: INodeType = {
  description: {
    type: "filter",
    displayName: "过滤",
    group: "transform",
    description: "按条件保留匹配的数据；也可以反过来只丢弃匹配的数据。",
    icon: "filter",
    inputs: 1,
    outputs: 1,
    version: 1,
    properties: [
      {
        name: "conditions",
        displayName: "条件",
        type: "json",
        default: {
          combinator: "and",
          caseSensitive: false,
          conditions: [{ left: "", operator: "equals", right: "" }],
        },
        description: "与「条件判断」节点同一套条件语法：left/right 支持表达式。",
      },
      {
        name: "keepOnlyMatching",
        displayName: "保留匹配项",
        type: "boolean",
        default: true,
        description: "关闭后改为「丢弃匹配项、保留不匹配项」。",
      },
    ],
  },

  async execute(context) {
    const group = parseConditionGroup(context.getNodeParameter<unknown>("conditions", {}), "条件");
    const keepOnlyMatching = readBoolean(context, "keepOnlyMatching", true);
    const output: Item[] = inputItems(context).filter((item) => {
      const matched = matchesConditionGroup(group, item);
      return keepOnlyMatching ? matched : !matched;
    });
    return { main: [output] };
  },
};
