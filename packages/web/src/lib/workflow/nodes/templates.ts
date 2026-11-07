/**
 * 起手模板：让用户不用从空画布开始。
 *
 * 为什么模板用「构建函数」而不是序列化好的 JSON：节点默认参数会随节点描述演进，
 * 存一份死 JSON 等于把默认值冻结在模板里；用 `createNode` 走注册表，模板永远与
 * 当前节点定义一致（节点改名/加参数时模板自动跟上）。
 *
 * 模板只依赖节点 type 字符串与 createNode，不 import 具体节点实现，避免循环依赖。
 */

import { addConnection, createNode, createWorkflow } from "../model.js";
import type { Workflow, WorkflowNode } from "../types.js";

export interface WorkflowTemplate {
  id: string;
  name: string;
  description: string;
  /** 构建一条全新工作流（每次调用返回独立实例，id 都是新的）。 */
  build(): Workflow;
}

type NodeSpec = {
  type: string;
  name?: string;
  position: { x: number; y: number };
  parameters?: Record<string, unknown>;
};

type LinkSpec = [from: number, outputIndex: number, to: number, inputIndex: number];

function buildWorkflow(name: string, nodes: NodeSpec[], links: LinkSpec[]): Workflow {
  const workflow = createWorkflow({ name });
  const created: WorkflowNode[] = nodes.map((spec) => {
    const node = createNode(spec.type, { workflow, position: spec.position, name: spec.name });
    if (spec.parameters) node.parameters = { ...node.parameters, ...spec.parameters };
    return node;
  });
  workflow.nodes = created;
  for (const [from, outputIndex, to, inputIndex] of links) {
    const source = created[from];
    const target = created[to];
    if (source && target) addConnection(workflow, source.id, outputIndex, target.id, inputIndex);
  }
  return workflow;
}

export const WORKFLOW_TEMPLATES: readonly WorkflowTemplate[] = [
  {
    id: "http-and-notify",
    name: "抓取接口并通知",
    description: "手动触发 → 请求一个公开接口 → 整理字段 → 推一条站内通知。",
    build: () =>
      buildWorkflow(
        "抓取接口并通知",
        [
          { type: "manualTrigger", position: { x: 80, y: 160 } },
          {
            type: "httpRequest",
            position: { x: 320, y: 160 },
            parameters: {
              method: "GET",
              url: "https://httpbin.org/json",
              responseFormat: "json",
            },
          },
          {
            type: "set",
            position: { x: 560, y: 160 },
            parameters: {
              mode: "manual",
              fields: [{ name: "done", value: "接口已抓取" }],
            },
          },
          {
            type: "notification",
            position: { x: 800, y: 160 },
            parameters: {
              title: "抓取完成",
              body: "接口请求已返回，可以去执行记录里看数据。",
            },
          },
        ],
        [
          [0, 0, 1, 0],
          [1, 0, 2, 0],
          [2, 0, 3, 0],
        ],
      ),
  },
  {
    id: "daily-agenda-digest",
    name: "每日日程摘要",
    description: "每天 9 点读取本机归档日程，交给大模型总结，再推一条通知。",
    build: () =>
      buildWorkflow(
        "每日日程摘要",
        [
          {
            type: "scheduleTrigger",
            position: { x: 80, y: 160 },
            parameters: { triggerInterval: "days", intervalCount: 1, triggerAtHour: 9, triggerAtMinute: 0 },
          },
          { type: "infohubAgenda", position: { x: 320, y: 160 }, parameters: { days: 7, overdue: 14 } },
          {
            type: "llm",
            position: { x: 560, y: 160 },
            parameters: {
              systemPrompt: "你是日程助理，用中文简洁总结。",
              userPrompt: "这是本机归档里的日程摘要，请挑出最要紧的三件事：{{ $json.agenda }}",
              maxTokens: 512,
            },
          },
          {
            type: "notification",
            position: { x: 800, y: 160 },
            parameters: { title: "今天要紧的日程", body: "{{ $json.text }}" },
          },
        ],
        [
          [0, 0, 1, 0],
          [1, 0, 2, 0],
          [2, 0, 3, 0],
        ],
      ),
  },
  {
    id: "if-branch",
    name: "条件分支示例",
    description: "构造一条数据 → 按值走不同分支 → 两个分支各自通知。",
    build: () =>
      buildWorkflow(
        "条件分支示例",
        [
          { type: "manualTrigger", position: { x: 80, y: 160 } },
          {
            type: "set",
            position: { x: 320, y: 160 },
            parameters: { mode: "manual", fields: [{ name: "level", value: "high" }] },
          },
          {
            type: "if",
            position: { x: 560, y: 160 },
            parameters: {
              conditions: {
                combinator: "and",
                caseSensitive: false,
                conditions: [{ left: "{{ $json.level }}", operator: "equals", right: "high" }],
              },
            },
          },
          {
            type: "notification",
            position: { x: 800, y: 80 },
            parameters: { title: "高优先级", body: "走了 true 分支。" },
          },
          {
            type: "notification",
            position: { x: 800, y: 260 },
            parameters: { title: "普通优先级", body: "走了 false 分支。" },
          },
        ],
        [
          [0, 0, 1, 0],
          [1, 0, 2, 0],
          [2, 0, 3, 0],
          [2, 1, 4, 0],
        ],
      ),
  },
  {
    id: "error-handler",
    name: "错误处理工作流",
    description: "错误触发 → 推一条通知；在别的「工作流设置」里把它选成错误工作流即可。",
    build: () =>
      buildWorkflow(
        "错误处理工作流",
        [
          { type: "errorTrigger", position: { x: 80, y: 160 } },
          {
            type: "notification",
            position: { x: 320, y: 160 },
            parameters: {
              title: "工作流出错了",
              body: "{{ $json.error.message }}",
            },
          },
        ],
        [[0, 0, 1, 0]],
      ),
  },
];

/** 按 id 取模板。 */
export function findWorkflowTemplate(id: string): WorkflowTemplate | undefined {
  return WORKFLOW_TEMPLATES.find((template) => template.id === id);
}
