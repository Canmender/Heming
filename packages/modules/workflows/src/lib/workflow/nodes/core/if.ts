/**
 * 条件判断（If）：把输入按条件分到 true / false 两个输出口。
 *
 * 两个输出都是**必有**的（即使某一侧为空数组）：画布上的连线按输出口索引存，
 * 若某次运行只返回一个输出口，引擎会把另一侧的下游当成「没有输入」，
 * 让「false 分支」看起来时有时无。空数组表示「这个分支这次没数据」。
 *
 * 条件组为空时视为恒真（全走 true），与「没写条件 = 不拦数据」的直觉一致。
 */

import type { INodeType, Item } from "../../types";
import {
  inputItems,
  matchesConditionGroup,
  parseConditionGroup,
  type ConditionGroup,
} from "./helpers";

/** 默认条件组：一条「等于」空条件，保证新建节点不是空白 JSON。 */
export const DEFAULT_CONDITION_GROUP: ConditionGroup = {
  combinator: "and",
  caseSensitive: false,
  conditions: [{ left: "", operator: "equals", right: "" }],
};

/** 条件组参数的默认 JSON（描述里的 default 用）。 */
export const DEFAULT_CONDITION_GROUP_JSON = {
  combinator: "and",
  caseSensitive: false,
  conditions: [{ left: "", operator: "equals", right: "" }],
};

export const ifNode: INodeType = {
  description: {
    type: "if",
    displayName: "条件判断",
    group: "flow",
    description: "按条件把数据分成两路：满足的走 true，不满足的走 false。",
    icon: "git-branch",
    inputs: 1,
    outputs: 2,
    outputNames: ["true", "false"],
    version: 1,
    properties: [
      {
        name: "conditions",
        displayName: "条件",
        type: "json",
        default: DEFAULT_CONDITION_GROUP_JSON,
        description:
          '形如 {"combinator":"and","caseSensitive":false,"conditions":[{"left":"{{ $json.status }}","operator":"equals","right":"done"}]}。left/right 都支持表达式。',
      },
    ],
  },

  async execute(context) {
    const group = parseConditionGroup(context.getNodeParameter<unknown>("conditions", {}), "条件");
    const trueItems: Item[] = [];
    const falseItems: Item[] = [];
    for (const item of inputItems(context)) {
      if (matchesConditionGroup(group, item)) trueItems.push(item);
      else falseItems.push(item);
    }
    return { main: [trueItems, falseItems] };
  },
};
