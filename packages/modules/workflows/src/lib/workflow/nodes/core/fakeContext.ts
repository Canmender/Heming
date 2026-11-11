/**
 * 仅测试使用：可预期、可注入的 `NodeExecutionContext`。
 *
 * 为什么放在 src 里而不是测试文件内部：节点单测有 8 个文件，各写一份假上下文
 * 必然分叉（有人记得实现 getWorkflowStaticData，有人忘了），最后会变成
 * 「某个节点的测试通过只是因为它用不到那个方法」。这里一次实现完整接口，
 * 测试只负责按需覆盖。生产代码不要 import 本文件（没有任何节点 import 它）。
 */

import { createWorkflow } from "../../model";
import type {
  Item,
  NodeExecutionContext,
  NodeHelpers,
  Workflow,
  WorkflowNode,
} from "../../types";

export interface FakeContextOptions {
  parameters?: Record<string, unknown>;
  /** 输入：单口（Item[]）或按输入口分组的 Item[][]。 */
  input?: Item[] | Item[][];
  node?: Partial<WorkflowNode>;
  workflow?: Workflow;
  helpers?: Partial<NodeHelpers>;
  runIndex?: number;
  mode?: NodeExecutionContext["mode"];
  executionId?: string;
  /** 模拟上游节点输出（getNodeOutputData）。 */
  nodeOutputData?: Record<string, Item[][]>;
  /** 工作流静态数据（跨运行）；缺省给空对象。 */
  staticData?: Record<string, Record<string, unknown>>;
  emitProgress?: (message: string) => void;
  signal?: AbortSignal;
}

/** 按输入口分组：Item[][] 原样、Item[] 放进 main[0]、空输入给一个空口。 */
function asInputData(input?: Item[] | Item[][]): Item[][] {
  if (!input || input.length === 0) return [[]];
  return Array.isArray(input[0]) ? (input as Item[][]) : [input as Item[]];
}

export function createFakeContext(options: FakeContextOptions = {}): NodeExecutionContext {
  const parameters = options.parameters ?? {};
  const node: WorkflowNode = {
    id: "node-test-1",
    name: "测试节点",
    type: "testNode",
    position: { x: 0, y: 0 },
    parameters,
    ...options.node,
  };
  const workflow = options.workflow ?? createWorkflow({ name: "测试工作流", id: "wf-test" });
  if (!workflow.nodes.some((entry) => entry.id === node.id)) workflow.nodes.push(node);

  const main = asInputData(options.input);
  const nodeOutputData = options.nodeOutputData ?? {};
  const staticData: Record<string, Record<string, unknown>> = options.staticData ?? {};
  const signal = options.signal ?? new AbortController().signal;
  const helpers: NodeHelpers = {
    httpRequest: async () => {
      throw new Error("测试上下文没有注入 httpRequest");
    },
    sleep: async () => {
      /* 默认不真的等待 */
    },
    ...options.helpers,
  };

  return {
    node,
    workflow,
    runIndex: options.runIndex ?? 0,
    parameters,
    inputData: { main },
    mode: options.mode ?? "manual",
    executionId: options.executionId ?? "exec-test",
    getNodeParameter<T>(name: string, fallback: T): T {
      const value = parameters[name];
      return (value === undefined ? fallback : value) as T;
    },
    getInputData(inputIndex = 0): Item[] {
      return main[inputIndex] ?? [];
    },
    getNodeOutputData(nodeId: string, outputIndex = 0): Item[][] {
      // 契约返回的是「该节点各输出口的数组」，不是单个输出口。
      void outputIndex;
      return nodeOutputData[nodeId] ?? [];
    },
    getWorkflowStaticData(kind: "global" | "node" = "global"): Record<string, unknown> {
      if (!staticData[kind]) staticData[kind] = {};
      return staticData[kind];
    },
    async getCredential(): Promise<Record<string, unknown> | null> {
      return null;
    },
    helpers,
    abortSignal: signal,
    logger: {
      info: () => {
        /* 测试里不关心 */
      },
      warn: () => {
        /* 测试里不关心 */
      },
      error: () => {
        /* 测试里不关心 */
      },
    },
    emitProgress: options.emitProgress,
  };
}

/** 便捷构造 items：`makeItems({a:1},{a:2})`。 */
export function makeItems(...jsons: Array<Record<string, unknown>>): Item[] {
  return jsons.map((json) => ({ json }));
}
