/**
 * 引擎测试的公共设施：假节点类型 + 工作流构造器。
 *
 * 为什么不 import `nodes/` 下的真实节点库：
 * - 引擎语义（执行栈、合并、重试、onError、部分执行）应该独立于任何具体节点成立；
 * - 真实节点库由别人实现，把它当测试依赖会让两边的测试互相牵连；
 * - 假节点可以精确制造「第 2 次调用才成功」「永远抛错」「返回两个输出口」这些场景。
 *
 * 注意：这是测试辅助模块，不是 *.test.ts，vitest 不会把它当用例执行。
 */

import { addConnection } from "../model.js";
import { clearNodeRegistry, registerNodeType } from "../registry.js";
import type {
  INodeType,
  Item,
  NodeTypeDescription,
  Workflow,
  WorkflowConnections,
  WorkflowNode,
  WorkflowSettings,
} from "../types.js";

/** 每个用例前清空注册表，避免假节点类型跨用例串味。 */
export function resetNodeRegistry(): void {
  clearNodeRegistry();
}

export interface FakeNodeOptions {
  /** 覆盖默认描述（inputs/outputs/isTrigger/trigger 等）。 */
  description?: Partial<Pick<
    NodeTypeDescription,
    "displayName" | "group" | "description" | "icon" | "inputs" | "outputs" | "outputNames" | "isTrigger" | "trigger" | "version"
  >>;
  getNextRun?: INodeType["getNextRun"];
  getOutputCount?: INodeType["getOutputCount"];
}

/** 注册一个假节点类型。 */
export function registerFakeNode(
  type: string,
  execute: INodeType["execute"],
  options: FakeNodeOptions = {},
): void {
  const overrides = options.description ?? {};
  const description: NodeTypeDescription = {
    type,
    displayName: overrides.displayName ?? type,
    group: overrides.group ?? "action",
    description: overrides.description ?? "测试节点",
    icon: overrides.icon ?? "test",
    inputs: overrides.inputs ?? 1,
    outputs: overrides.outputs ?? 1,
    properties: [],
    version: overrides.version ?? 1,
  };
  if (overrides.outputNames !== undefined) description.outputNames = overrides.outputNames;
  if (overrides.isTrigger !== undefined) description.isTrigger = overrides.isTrigger;
  if (overrides.trigger !== undefined) description.trigger = overrides.trigger;

  const nodeType: INodeType = { description, execute };
  if (options.getNextRun) nodeType.getNextRun = options.getNextRun;
  if (options.getOutputCount) nodeType.getOutputCount = options.getOutputCount;
  registerNodeType(nodeType);
}

/** 注册一个假触发器（`isTrigger` 自动为 true）。 */
export function registerFakeTrigger(
  type: string,
  execute: INodeType["execute"],
  options: Omit<FakeNodeOptions, "description"> & {
    description?: FakeNodeOptions["description"];
  } = {},
): void {
  registerFakeNode(type, execute, {
    ...options,
    description: {
      inputs: 0,
      isTrigger: true,
      trigger: "manual",
      ...options.description,
    },
  });
}

/** 造一个节点（位置用来验证「按画布位置排序」的确定性）。 */
export function makeNode(
  id: string,
  type: string,
  options: Partial<Omit<WorkflowNode, "id" | "type" | "name" | "position">> & {
    name?: string;
    position?: { x: number; y: number };
  } = {},
): WorkflowNode {
  const { name = id, position = { x: 0, y: 0 }, ...rest } = options;
  return {
    ...rest,
    id,
    name,
    type,
    position,
    parameters: rest.parameters ?? {},
  };
}

/** 造一条工作流（默认设置：成功/失败都保存数据）。 */
export function makeWorkflow(
  options: {
    id?: string;
    name?: string;
    nodes?: WorkflowNode[];
    connections?: WorkflowConnections;
    settings?: Partial<WorkflowSettings>;
    active?: boolean;
  } = {},
): Workflow {
  return {
    id: options.id ?? "wf-test",
    name: options.name ?? "测试工作流",
    tags: [],
    nodes: options.nodes ?? [],
    connections: options.connections ?? {},
    settings: {
      timezone: "local",
      saveDataSuccessExecution: "all",
      saveDataErrorExecution: "all",
      saveManualExecutions: true,
      callerPolicy: "any",
      ...options.settings,
    },
    active: options.active ?? false,
    versionId: "ver-test",
    createdAt: 0,
    updatedAt: 0,
  };
}

/** 连一条线（等价于在画布上拖线）。 */
export function connect(
  workflow: Workflow,
  sourceId: string,
  targetId: string,
  outputIndex = 0,
  inputIndex = 0,
): void {
  // addConnection 的参数顺序是 (workflow, sourceId, outputIndex, targetId, inputIndex)
  addConnection(workflow, sourceId, outputIndex, targetId, inputIndex);
}

/** 造一条 item。 */
export function item(json: Record<string, unknown> = {}): Item {
  return { json };
}

/** 造一批 item。 */
export function items(...jsons: Array<Record<string, unknown>>): Item[] {
  return jsons.map((json) => ({ json }));
}

/** 执行记录里某节点的运行次数。 */
export function runCount(execution: { runData: Record<string, unknown[]> }, nodeId: string): number {
  return execution.runData[nodeId]?.length ?? 0;
}

/** 取执行记录里某节点第 `index` 次运行的第一个输出口的 items（没有返回空数组）。 */
export function outputItems(
  execution: { runData: Record<string, Array<{ data?: { main: Item[][] } }>> },
  nodeId: string,
  index = 0,
  outputIndex = 0,
): Item[] {
  return execution.runData[nodeId]?.[index]?.data?.main?.[outputIndex] ?? [];
}
