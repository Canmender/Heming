/**
 * 执行子流程（Execute Workflow）：调用另一条工作流，并把它的输出接回本流程。
 *
 * 节点自己**不加载**工作流仓库、不建执行记录、不做递归深度控制——这些只有宿主
 * 知道。走 `context.helpers.executeSubWorkflow` 注入：调用方传入 workflowId、
 * 父执行 id 与输入 items，拿到子执行记录与输出 items。
 *
 * 子流程失败按「本节点失败」处理（CONTRACT §5.9）：抛结构化错误，让引擎按本节点
 * 的 onError 三态分流；错误里带上子工作流名与错误摘要，便于从历史追过去。
 */

import type { INodeType } from "../../types.js";
import {
  errorText,
  inputItems,
  readString,
  WorkflowNodeError,
} from "./helpers.js";

export const executeWorkflowNode: INodeType = {
  description: {
    type: "executeWorkflow",
    displayName: "执行子流程",
    group: "action",
    description: "调用另一条工作流并接收它的输出；子流程失败按本节点失败处理。",
    icon: "workflow",
    inputs: 1,
    outputs: 1,
    version: 1,
    properties: [
      {
        name: "workflowId",
        displayName: "子工作流 ID",
        type: "string",
        default: "",
        required: true,
        placeholder: "目标工作流的 id",
        description: "目标工作流必须在设置里允许被调用（callerPolicy = any）。",
      },
      {
        name: "notice",
        displayName: "说明",
        type: "notice",
        default: "",
        description: "子流程里的执行记录会带父执行 id；递归调用深度由宿主限制。",
      },
    ],
  },

  async execute(context) {
    const runner = context.helpers.executeSubWorkflow;
    if (!runner) {
      throw new WorkflowNodeError("子流程执行器未注入", {
        description: "执行子流程节点需要宿主在 helpers.executeSubWorkflow 上注入实现。",
      });
    }
    const workflowId = readString(context, "workflowId", "").trim();
    if (!workflowId) {
      throw new WorkflowNodeError("执行子流程缺少目标工作流 ID");
    }

    let result;
    try {
      result = await runner({
        workflowId,
        mode: "subworkflow",
        parentExecutionId: context.executionId,
        inputData: inputItems(context),
      });
    } catch (error) {
      throw new WorkflowNodeError(`子流程执行失败：${errorText(error)}`, {
        description: `目标工作流：${workflowId}`,
        cause: error,
      });
    }

    const execution = result.execution;
    if (execution.status === "error") {
      throw new WorkflowNodeError(`子工作流「${execution.workflowName}」执行失败`, {
        description: execution.error?.message ?? "子流程没有给出具体错误信息。",
      });
    }
    if (execution.status === "canceled") {
      throw new WorkflowNodeError(`子工作流「${execution.workflowName}」已取消`);
    }
    return { main: [result.output] };
  },
};
