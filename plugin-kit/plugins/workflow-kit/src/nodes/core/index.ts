/**
 * 核心节点注册入口：调色板与执行引擎都从这里拿到「有哪些核心节点」。
 *
 * 注册顺序 = 调色板顺序（见 `registry.ts` 注释）：先触发器（工作流起点），
 * 再数据变换、分支流程、动作/集成，最后「停止并报错」这类收尾节点。
 */

import { getNodeType, registerNodeType } from "../../registry.js";
import type { INodeType } from "../../types.js";
import { aggregateNode } from "./aggregate.js";
import { codeNode } from "./code.js";
import { errorTrigger } from "./errorTrigger.js";
import { executeWorkflowNode } from "./executeWorkflow.js";
import { executeWorkflowTrigger } from "./executeWorkflowTrigger.js";
import { filterNode } from "./filter.js";
import { httpRequestNode } from "./httpRequest.js";
import { ifNode } from "./if.js";
import { itemListsNode } from "./itemLists.js";
import { limitNode } from "./limit.js";
import { manualTrigger } from "./manualTrigger.js";
import { mergeNode } from "./merge.js";
import { noOperationNode } from "./noOperation.js";
import { removeDuplicatesNode } from "./removeDuplicates.js";
import { scheduleTrigger } from "./scheduleTrigger.js";
import { setNode } from "./set.js";
import { sortNode } from "./sort.js";
import { splitInBatchesNode } from "./splitInBatches.js";
import { splitOutNode } from "./splitOut.js";
import { stopAndErrorNode } from "./stopAndError.js";
import { switchNode } from "./switch.js";
import { waitNode } from "./wait.js";
import { webhookTrigger } from "./webhookTrigger.js";

/** 核心节点清单（顺序即调色板顺序）。 */
export const CORE_NODE_TYPES: INodeType[] = [
  // 触发器
  manualTrigger,
  scheduleTrigger,
  errorTrigger,
  executeWorkflowTrigger,
  webhookTrigger,
  // 数据变换
  setNode,
  splitOutNode,
  filterNode,
  sortNode,
  limitNode,
  removeDuplicatesNode,
  aggregateNode,
  itemListsNode,
  // 分支与流程
  ifNode,
  switchNode,
  mergeNode,
  splitInBatchesNode,
  waitNode,
  noOperationNode,
  // 动作
  httpRequestNode,
  codeNode,
  executeWorkflowNode,
  // 收尾
  stopAndErrorNode,
];

/**
 * 注册全部核心节点。
 *
 * 已注册的 type 直接跳过：应用可能在热更新/重复 mount 时再次调用，
 * 而 `registerNodeType` 对重复注册是抛错的（那是为了防止两条事实来源，
 * 不该被启动流程的重复调用触发）。测试里先 `clearNodeRegistry()` 即可重来。
 */
export function registerCoreNodes(): void {
  for (const nodeType of CORE_NODE_TYPES) {
    if (getNodeType(nodeType.description.type)) continue;
    registerNodeType(nodeType);
  }
}
