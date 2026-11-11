/**
 * 停止并报错（Stop And Error）：主动让本次执行失败，并给出用户写好的原因。
 *
 * 为什么它永远抛错、没有成功输出：这个节点的语义就是「到这里为止」。
 * 它抛的是带 description 的结构化错误，执行记录里能直接看到用户写的原因，
 * 错误工作流（errorTrigger）也能据此分流。
 */

import type { INodeType } from "../../types";
import { readString, WorkflowNodeError } from "./helpers";

export const stopAndErrorNode: INodeType = {
  description: {
    type: "stopAndError",
    displayName: "停止并报错",
    group: "output",
    description: "立即停止本次执行并标记为失败，错误信息由你填写。",
    icon: "alert-octagon",
    inputs: 1,
    outputs: 1,
    version: 1,
    properties: [
      {
        name: "errorMessage",
        displayName: "错误信息",
        type: "string",
        default: "工作流在此处主动停止",
        required: true,
        description: "执行记录与错误工作流里看到的错误摘要。",
      },
      {
        name: "errorDescription",
        displayName: "详细说明",
        type: "multiline",
        default: "",
        rows: 3,
        description: "可选：补充排查线索（例如「上游返回了空列表」）。",
      },
    ],
  },

  async execute(context) {
    const message = readString(context, "errorMessage", "").trim() || "工作流在此处主动停止";
    const description = readString(context, "errorDescription", "").trim();
    throw new WorkflowNodeError(message, description ? { description } : {});
  },
};
