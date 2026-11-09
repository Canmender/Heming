/**
 * 手动触发：工作流没有触发器时，用户点「运行」从这里开始。
 *
 * 为什么输出一条空 item 而不是什么都不输出：执行引擎从触发节点开始，
 * 下游节点需要有输入才会被入栈；给一条 `{}` 让「手动跑一次」的下游
 * 至少执行一次（n8n 的 Manual Trigger 同样是这个口径）。
 */

import type { INodeType } from "../../types.js";
import { inputItems } from "./helpers.js";

export const manualTrigger: INodeType = {
  description: {
    type: "manualTrigger",
    displayName: "手动触发",
    group: "trigger",
    description: "手动点击「运行」时从这里开始，不需要配置。",
    icon: "play",
    inputs: 0,
    outputs: 1,
    isTrigger: true,
    trigger: "manual",
    version: 1,
    properties: [
      {
        name: "notice",
        displayName: "说明",
        type: "notice",
        default: "",
        description: "手动运行时下游会收到一条空数据；如果调用方传了输入数据，则原样输出。",
      },
    ],
  },

  async execute(context) {
    const items = inputItems(context);
    return { main: [items.length > 0 ? items : [{ json: {} }]] };
  },
};
