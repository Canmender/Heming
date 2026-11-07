/**
 * 空操作（No Operation）：把输入原样传给输出，什么都不改。
 *
 * 存在的意义是画布上的「占位/收口」：给分支合流找一个明确的汇合点、
 * 或临时把一段链路接起来但不改变数据。没有输入时输出空数组（不凭空造数据）。
 */

import type { INodeType } from "../../types.js";
import { inputItems } from "./helpers.js";

export const noOperationNode: INodeType = {
  description: {
    type: "noOperation",
    displayName: "空操作",
    group: "flow",
    description: "不做任何处理，把输入数据原样传给下游。",
    icon: "square",
    inputs: 1,
    outputs: 1,
    version: 1,
    properties: [
      {
        name: "notice",
        displayName: "说明",
        type: "notice",
        default: "",
        description: "常用于分支汇合占位，或先接好线、稍后再替换成真正的处理节点。",
      },
    ],
  },

  async execute(context) {
    return { main: [inputItems(context)] };
  },
};
