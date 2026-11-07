import { describe, it, expect, beforeEach, beforeAll } from "vitest";
import { registerAllNodes } from "./nodes/index.js";
import { registerNodeType } from "./registry.js";
import { addConnection, createNode, createWorkflow } from "./model.js";
import { executeWorkflow } from "./engine/index.js";
import type { INodeType, Workflow } from "./types.js";
import { registerNodeType as registerType } from "./registry.js";
import { useNotificationStore, setNotificationStorage } from "../../store/notifications.js";

/**
 * 端到端集成测试：用**真实节点 + 真实引擎**跑一条完整工作流。
 *
 * 为什么放在 lib/workflow 根而不是各模块里：模块单测证明「零件对」，这里证明
 * 「装起来能跑」——注册表、模型、引擎、表达式、节点库、通知存储全链路。
 * 不碰网络：HTTP 依赖注入假实现，代码沙箱用注入的同步假实现。
 */

interface BuildSpec {
  nodes: Array<{ type: string; name?: string; parameters?: Record<string, unknown> }>;
  links: Array<[number, number, number, number]>;
}

function buildWorkflow(name: string, spec: BuildSpec): Workflow {
  const workflow = createWorkflow({ name });
  const created = spec.nodes.map((entry) =>
    createNode(entry.type, { workflow, position: { x: 100, y: 100 }, name: entry.name }),
  );
  for (const entry of spec.nodes) {
    const node = created[spec.nodes.indexOf(entry)];
    if (entry.parameters) node.parameters = { ...node.parameters, ...entry.parameters };
  }
  workflow.nodes = created;
  for (const [from, outputIndex, to, inputIndex] of spec.links) {
    addConnection(workflow, created[from].id, outputIndex, created[to].id, inputIndex);
  }
  return workflow;
}

const deps = {
  httpRequest: async () => ({ statusCode: 200, headers: {}, body: { ok: true } }),
  runUserCode: async () => [],
};

beforeAll(() => {
  registerAllNodes();
});

beforeEach(() => {
  setNotificationStorage(null);
  useNotificationStore.setState({ items: [] });
});

describe("工作流端到端（真实节点 + 真实引擎）", () => {
  it("手动触发 → 设置字段 → 条件分支 → 通知：跑通并逐节点留痕", async () => {
    const workflow = buildWorkflow("分支示例", {
      nodes: [
        { type: "manualTrigger" },
        { type: "set", parameters: { mode: "manual", fields: [{ name: "level", value: "high" }] } },
        {
          type: "if",
          parameters: {
            conditions: {
              combinator: "and",
              caseSensitive: false,
              conditions: [{ left: "{{ $json.level }}", operator: "equals", right: "high" }],
            },
          },
        },
        { type: "notification", name: "高优先级", parameters: { title: "高优先级", body: "走了 true" } },
        { type: "notification", name: "普通", parameters: { title: "普通", body: "走了 false" } },
      ],
      links: [
        [0, 0, 1, 0],
        [1, 0, 2, 0],
        [2, 0, 3, 0],
        [2, 1, 4, 0],
      ],
    });

    const events: string[] = [];
    const execution = await executeWorkflow({
      workflow,
      mode: "manual",
      deps,
      onEvent: (event) => {
        if (event.type === "nodeFinish") events.push(`${event.nodeType}:${event.status}`);
      },
    });

    expect(execution.status).toBe("success");
    expect(Object.keys(execution.runData)).toHaveLength(4);
    expect(execution.runData[workflow.nodes[0].id]).toHaveLength(1);
    // true 分支被通知，false 分支没有数据、不执行
    expect(events).toContain("notification:success");
    const notices = useNotificationStore.getState().items;
    expect(notices).toHaveLength(1);
    expect(notices[0].title).toBe("高优先级");
  });

  it("节点主动报错：执行置错、错误里带节点与消息", async () => {
    const workflow = buildWorkflow("报错示例", {
      nodes: [
        { type: "manualTrigger" },
        { type: "stopAndError", parameters: { errorMessage: "演示失败" } },
      ],
      links: [[0, 0, 1, 0]],
    });
    const execution = await executeWorkflow({ workflow, deps });
    expect(execution.status).toBe("error");
    expect(execution.error?.message).toContain("演示失败");
    expect(execution.error?.nodeType).toBe("stopAndError");
  });

  it("节点级重试：只重跑失败节点，最终成功只留一条记录", async () => {
    let attempts = 0;
    const flaky: INodeType = {
      description: {
        type: "testFlaky",
        displayName: "不稳定节点",
        group: "transform",
        description: "测试用：前两次失败，第三次成功",
        icon: "code",
        inputs: 1,
        outputs: 1,
        version: 1,
        properties: [],
      },
      async execute() {
        attempts += 1;
        if (attempts < 3) throw new Error("暂时失败");
        return [{ json: { ok: true } }];
      },
    };
    registerType(flaky);

    const workflow = buildWorkflow("重试示例", {
      nodes: [
        { type: "manualTrigger" },
        {
          type: "testFlaky",
          parameters: {},
        },
      ],
      links: [[0, 0, 1, 0]],
    });
    const flakyNode = workflow.nodes[1];
    flakyNode.retryOnFail = true;
    flakyNode.maxTries = 3;
    flakyNode.waitBetweenTries = 0;

    const execution = await executeWorkflow({ workflow, deps });
    expect(attempts).toBe(3);
    expect(execution.status).toBe("success");
    expect(execution.runData[flakyNode.id]).toHaveLength(1);
  });

  it("错误工作流：失败时按 errorWorkflowId 调起，失败上下文含三段", async () => {
    const workflow = buildWorkflow("会失败的工作流", {
      nodes: [{ type: "manualTrigger" }, { type: "stopAndError", parameters: { errorMessage: "炸了" } }],
      links: [[0, 0, 1, 0]],
    });
    workflow.settings.errorWorkflowId = "wf-error-handler";
    const subCalls: Array<{ workflowId: string; mode: string; items: number }> = [];
    const execution = await executeWorkflow({
      workflow,
      deps: {
        ...deps,
        executeSubWorkflow: async (params) => {
          subCalls.push({
            workflowId: params.workflowId,
            mode: params.mode,
            items: params.inputData.length,
          });
          return {
            execution: {
              id: "exec-sub",
              workflowId: params.workflowId,
              workflowName: "错误处理",
              mode: "error",
              status: "success",
              startedAt: Date.now(),
              runData: {},
            },
            output: [],
          };
        },
      },
    });
    expect(execution.status).toBe("error");
    expect(subCalls).toHaveLength(1);
    expect(subCalls[0].workflowId).toBe("wf-error-handler");
    expect(subCalls[0].mode).toBe("error");
    expect(subCalls[0].items).toBeGreaterThan(0);
  });

  it("部分执行：从指定节点开始、到指定节点结束", async () => {
    const workflow = buildWorkflow("部分执行", {
      nodes: [
        { type: "manualTrigger" },
        { type: "set", parameters: { mode: "manual", fields: [{ name: "a", value: 1 }] } },
        { type: "set", parameters: { mode: "manual", fields: [{ name: "b", value: 2 }] } },
      ],
      links: [
        [0, 0, 1, 0],
        [1, 0, 2, 0],
      ],
    });
    const execution = await executeWorkflow({
      workflow,
      mode: "partial",
      startNodeId: workflow.nodes[1].id,
      destinationNodeId: workflow.nodes[1].id,
      inputData: { main: [[{ json: { seed: true } }]] },
      deps,
    });
    expect(execution.status).toBe("success");
    expect(Object.keys(execution.runData)).toEqual([workflow.nodes[1].id]);
  });
});
