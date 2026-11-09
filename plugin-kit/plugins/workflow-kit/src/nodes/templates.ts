/**
 * 起手模板：让用户不用从空画布开始。
 *
 * 模板用「构建函数」而不是序列化好的死 JSON：节点默认参数会随节点描述演进，
 * 走 `createNode`/注册表能让模板永远与当前节点定义一致。
 *
 * 模板只依赖节点 type 字符串，不 import 具体节点实现，避免循环依赖。
 */

import { addConnection, createNode, createWorkflow } from "../model.js";
import type { Workflow, WorkflowNode } from "../types.js";

export interface WorkflowTemplate {
  id: string;
  name: string;
  description: string;
  build(): Workflow;
}

interface NodeSpec {
  type: string;
  name?: string;
  position: { x: number; y: number };
  parameters?: Record<string, unknown>;
}

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
    description: "手动触发 → 请求一个公开接口 → 整理字段 → 写一条本机通知。",
    build: () =>
      buildWorkflow(
        "抓取接口并通知",
        [
          { type: "manualTrigger", position: { x: 80, y: 160 } },
          {
            type: "httpRequest",
            position: { x: 320, y: 160 },
            parameters: { method: "GET", url: "https://httpbin.org/json", responseFormat: "json" },
          },
          {
            type: "set",
            position: { x: 560, y: 160 },
            parameters: { mode: "manual", fields: [{ name: "done", value: "接口已抓取" }] },
          },
          {
            type: "notification",
            position: { x: 800, y: 160 },
            parameters: { title: "抓取完成", body: "接口请求已返回，可以去执行记录里看数据。" },
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
    id: "daily-brief",
    name: "每日一句（大模型）",
    description: "每天 9 点：取当前日期 → 交给大模型写一句简报 → 写本机通知（需先配置模型连接）。",
    build: () =>
      buildWorkflow(
        "每日一句（大模型）",
        [
          {
            type: "scheduleTrigger",
            position: { x: 80, y: 160 },
            parameters: { triggerInterval: "days", intervalCount: 1, triggerAtHour: 9, triggerAtMinute: 0 },
          },
          {
            type: "dateTime",
            position: { x: 320, y: 160 },
            parameters: { operation: "format", format: "yyyy-MM-dd", outputField: "day" },
          },
          {
            type: "llm",
            position: { x: 560, y: 160 },
            parameters: {
              systemPrompt: "你是简洁的日程助理，用中文回答，不超过两句话。",
              userPrompt: "今天是 {{ $json.day }}，写一句适合早上看的提醒。",
              maxTokens: 256,
            },
          },
          {
            type: "notification",
            position: { x: 800, y: 160 },
            parameters: { title: "每日一句", body: "{{ $json.text }}" },
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
    description: "构造一条数据 → 按值走不同分支 → 两个分支各自写通知。",
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
    description: "错误触发 → 写一条通知；在别的工作流设置里把「错误工作流」选成本流程即可。",
    build: () =>
      buildWorkflow(
        "错误处理工作流",
        [
          { type: "errorTrigger", position: { x: 80, y: 160 } },
          {
            type: "notification",
            position: { x: 320, y: 160 },
            parameters: { title: "工作流出错了", body: "{{ $json.error.message }}" },
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

/** 给 HTTP 层用的模板摘要（不含构建结果，避免每次列模板都跑一遍节点注册）。 */
export function listWorkflowTemplates(): Array<{ id: string; name: string; description: string }> {
  return WORKFLOW_TEMPLATES.map((template) => ({
    id: template.id,
    name: template.name,
    description: template.description,
  }));
}
