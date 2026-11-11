/**
 * 错误触发：某条工作流执行失败时，由引擎以 `mode: "error"` 调起本工作流。
 *
 * 引擎注入的错误上下文 items 形如
 * `{ execution: {…}, workflow: {…}, error: { message, nodeName, … } }`；
 * 本节点只负责把它原样交给下游，不改写——下游要取 `$json.error.message`
 * 还是整段执行记录都行，节点多做一层包装反而会破坏用户预期的路径。
 *
 * 手动运行错误工作流时没有错误上下文，此时产出一条空 item，
 * 让整条工作流能被调试运行（而不是静默什么也不发生）。
 */

import type { INodeType } from "../../types";
import { inputItems } from "./helpers";

export const errorTrigger: INodeType = {
  description: {
    type: "errorTrigger",
    displayName: "错误触发",
    group: "trigger",
    description: "其它工作流执行失败时触发；输入是错误上下文（execution / workflow / error）。",
    icon: "alert-triangle",
    inputs: 0,
    outputs: 1,
    isTrigger: true,
    trigger: "error",
    version: 1,
    properties: [
      {
        name: "notice",
        displayName: "说明",
        type: "notice",
        default: "",
        description: "在目标工作流的设置里选它作为「错误工作流」后，执行失败时会带着错误上下文触发。",
      },
    ],
  },

  async execute(context) {
    const items = inputItems(context);
    return { main: [items.length > 0 ? items : [{ json: {} }]] };
  },
};
