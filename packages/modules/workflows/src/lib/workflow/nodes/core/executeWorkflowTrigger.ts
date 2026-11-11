/**
 * 子流程触发：另一条工作流用「执行子流程」节点调用本工作流时，从这里开始。
 *
 * 父流程通过 `SubWorkflowParams.inputData` 把 items 交给子流程的触发节点，
 * 引擎把它们放进本节点的 inputData；节点只做透传。
 * 手动运行子流程时没有父流程输入，产出一条空 item 以便调试整条链路。
 */

import type { INodeType } from "../../types";
import { inputItems } from "./helpers";

export const executeWorkflowTrigger: INodeType = {
  description: {
    type: "executeWorkflowTrigger",
    displayName: "子流程触发",
    group: "trigger",
    description: "被其它工作流的「执行子流程」节点调用时从这里开始，输出调用方传入的数据。",
    icon: "workflow",
    inputs: 0,
    outputs: 1,
    isTrigger: true,
    trigger: "subworkflow",
    version: 1,
    properties: [
      {
        name: "notice",
        displayName: "说明",
        type: "notice",
        default: "",
        description: "只有在工作流设置允许被调用（callerPolicy）时，其它工作流才能执行它。",
      },
    ],
  },

  async execute(context) {
    const items = inputItems(context);
    return { main: [items.length > 0 ? items : [{ json: {} }]] };
  },
};
