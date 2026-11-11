/**
 * 核心节点注册入口：调色板与执行引擎都从这里拿到「有哪些核心节点」。
 *
 * 注册顺序 = 调色板顺序（CONTRACT §4 的 registry 注释）：先触发器（工作流起点），
 * 再数据变换、分支流程、动作/集成，最后「停止并报错」这类收尾节点。
 */

import { getNodeType, registerNodeType } from "../../registry";
import type { INodeType } from "../../types";
import { aggregateNode } from "./aggregate";
import { codeNode } from "./code";
import { errorTrigger } from "./errorTrigger";
import { executeWorkflowNode } from "./executeWorkflow";
import { executeWorkflowTrigger } from "./executeWorkflowTrigger";
import { filterNode } from "./filter";
import { httpRequestNode } from "./httpRequest";
import { ifNode } from "./if";
import { itemListsNode } from "./itemLists";
import { limitNode } from "./limit";
import { manualTrigger } from "./manualTrigger";
import { mergeNode } from "./merge";
import { noOperationNode } from "./noOperation";
import { removeDuplicatesNode } from "./removeDuplicates";
import { scheduleTrigger } from "./scheduleTrigger";
import { setNode } from "./set";
import { sortNode } from "./sort";
import { splitInBatchesNode } from "./splitInBatches";
import { splitOutNode } from "./splitOut";
import { stopAndErrorNode } from "./stopAndError";
import { switchNode } from "./switch";
import { waitNode } from "./wait";

/** 核心节点清单（顺序即调色板顺序）。 */
export const CORE_NODE_TYPES: INodeType[] = [
  // 触发器
  manualTrigger,
  scheduleTrigger,
  errorTrigger,
  executeWorkflowTrigger,
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
