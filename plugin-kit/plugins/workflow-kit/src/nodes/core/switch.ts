/**
 * 分支（Switch）：按顺序匹配多条规则，命中第几条就走第几个输出口。
 *
 * 动态输出口：输出数 = 规则数 + 1（最后一个口是「其它/未匹配」）。为什么保底
 * 永远有一个未匹配口：否则没命中的数据会静默消失，用户很难发现是自己漏写了规则；
 * 集中到一个口里，接不接线由用户决定，但数据不会凭空不见。
 *
 * `getOutputCount` 必须能在**参数还没解析表达式**时也算出数量：它只依赖规则条数，
 * 不依赖规则内容，所以这里对坏 JSON 做保守回退（2 个口），不抛错也不返回 0。
 */

import type { INodeType, Item } from "../../types.js";
import {
  inputItems,
  isPlainObject,
  matchesConditionRule,
  parseJsonParameter,
  type ConditionRule,
  WorkflowNodeError,
} from "./helpers.js";

/** 默认规则：一条「等于」空值，保证新建节点时 getOutputCount 至少是 2。 */
export const DEFAULT_SWITCH_RULES = [{ left: "", operator: "equals", right: "" }];

/** 把参数里的规则数组归一；非法结构直接报参数错误（执行路径上不猜用户意图）。 */
export function parseSwitchRules(value: unknown): ConditionRule[] {
  const parsed = parseJsonParameter(value, "分支规则");
  if (parsed === undefined || parsed === null) return [];
  if (!Array.isArray(parsed)) {
    throw new WorkflowNodeError("参数「分支规则」必须是一个 JSON 数组");
  }
  const rules: ConditionRule[] = [];
  for (const entry of parsed) {
    if (!isPlainObject(entry)) continue;
    rules.push({
      left: entry.left,
      operator: typeof entry.operator === "string" && entry.operator ? entry.operator : "equals",
      right: entry.right,
    });
  }
  return rules;
}

/** 动态输出口数量：规则数 + 1（未匹配口），至少 1。 */
export function switchOutputCount(parameters: Record<string, unknown>): number {
  let raw: unknown = parameters.rules;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw) as unknown;
    } catch {
      return 2;
    }
  }
  if (!Array.isArray(raw)) return 2;
  const count = raw.filter((entry) => isPlainObject(entry)).length;
  return Math.max(1, count + 1);
}

export const switchNode: INodeType = {
  description: {
    type: "switch",
    displayName: "分支",
    group: "flow",
    description: "按多条规则把数据分到不同输出口；没命中的数据进最后的「未匹配」口。",
    icon: "git-fork",
    inputs: 1,
    outputs: 2,
    version: 1,
    properties: [
      {
        name: "rules",
        displayName: "分支规则",
        type: "json",
        default: DEFAULT_SWITCH_RULES,
        description:
          '按顺序匹配，形如 [{"left":"{{ $json.type }}","operator":"equals","right":"a"}]；第 1 条对应输出 1，未命中走最后一个输出口。',
      },
    ],
  },

  getOutputCount(parameters) {
    return switchOutputCount(parameters);
  },

  async execute(context) {
    const rules = parseSwitchRules(context.getNodeParameter<unknown>("rules", []));
    const outputCount = Math.max(1, rules.length + 1);
    const buckets: Item[][] = Array.from({ length: outputCount }, () => []);
    for (const item of inputItems(context)) {
      const matchedIndex = rules.findIndex((rule) => matchesConditionRule(rule, item, false));
      const targetIndex = matchedIndex >= 0 ? matchedIndex : outputCount - 1;
      buckets[targetIndex]?.push(item);
    }
    return { main: buckets };
  },
};
