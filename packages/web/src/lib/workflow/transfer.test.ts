import { describe, expect, it } from "vitest";
import { createWorkflow } from "./model.js";
import type { Workflow, WorkflowNode } from "./types.js";
import {
  exportWorkflow,
  exportWorkflowJson,
  importWorkflow,
  importWorkflowFromText,
  resolveImportType,
  toExportType,
} from "./transfer.js";

const NOW = 1_700_000_000_000;

function node(id: string, name: string, type: string, extra: Partial<WorkflowNode> = {}): WorkflowNode {
  return { id, name, type, position: { x: 100, y: 100 }, parameters: {}, ...extra };
}

function workflowWith(nodes: WorkflowNode[], connections: Workflow["connections"] = {}): Workflow {
  return {
    ...createWorkflow({ name: "导出测试", now: NOW }),
    nodes,
    connections,
    tags: ["标签一"],
  };
}

describe("toExportType / resolveImportType", () => {
  it("本仓类型导出成 n8n-nodes-base 前缀，noOperation 特判为 noOp", () => {
    expect(toExportType("httpRequest")).toBe("n8n-nodes-base.httpRequest");
    expect(toExportType("noOperation")).toBe("n8n-nodes-base.noOp");
    // 本仓专有节点带 heming. 前缀，n8n 不认识但本仓能导回来
    expect(toExportType("infohubSearch")).toBe("heming.infohubSearch");
  });

  it("导入时剥前缀、认别名、认注册表外置类型", () => {
    expect(resolveImportType("n8n-nodes-base.httpRequest")).toBe("httpRequest");
    expect(resolveImportType("n8n-nodes-base.noOp")).toBe("noOperation");
    expect(resolveImportType("n8n-nodes-base.start")).toBe("manualTrigger");
    expect(resolveImportType("n8n-nodes-base.cron")).toBe("scheduleTrigger");
    expect(resolveImportType("heming.infohubAgenda")).toBe("infohubAgenda");
    expect(resolveImportType("n8n-nodes-base.someUnknownNode")).toBeNull();
  });
});

describe("exportWorkflow", () => {
  it("连接按节点 name 输出，位置转数组，pinData 收成 name 键对象", () => {
    const source = node("n1", "定时", "scheduleTrigger");
    const target = node("n2", "HTTP", "httpRequest", {
      pinData: [{ json: { ok: true } }],
      credentials: { httpHeader: "cred-1" },
      retryOnFail: true,
      maxTries: 4,
      notes: "备注",
    });
    const workflow = workflowWith([source, target], {
      n1: { main: [[{ node: "n2", type: "main", index: 0 }]] },
    });
    const exported = exportWorkflow(workflow);
    expect(exported.name).toBe("导出测试");
    expect(exported.tags).toEqual(["标签一"]);
    expect(exported.nodes).toHaveLength(2);
    expect(exported.nodes[0]?.position).toEqual([100, 100]);
    expect(exported.connections["定时"]?.main[0]?.[0]).toEqual({
      node: "HTTP",
      type: "main",
      index: 0,
    });
    expect(exported.pinData["HTTP"]).toEqual([{ json: { ok: true } }]);
    const httpNode = exported.nodes[1];
    expect(httpNode?.type).toBe("n8n-nodes-base.httpRequest");
    expect(httpNode?.credentials).toEqual({ httpHeader: { id: "cred-1", name: "cred-1" } });
    expect(httpNode?.retryOnFail).toBe(true);
    expect(httpNode?.maxTries).toBe(4);
  });

  it("exportWorkflowJson 输出合法 JSON", () => {
    const json = exportWorkflowJson(workflowWith([]));
    const parsed = JSON.parse(json) as { name: string };
    expect(parsed.name).toBe("导出测试");
  });
});

describe("importWorkflow", () => {
  it("导入 n8n 形状：类型映射、连接 name→id、pinData 与 settings", () => {
    const raw = {
      name: "n8n 工作流",
      nodes: [
        {
          name: "手动触发",
          type: "n8n-nodes-base.manualTrigger",
          position: [100, 200],
          parameters: {},
        },
        {
          name: "HTTP",
          type: "n8n-nodes-base.httpRequest",
          position: [400, 200],
          parameters: { url: "https://example.com" },
        },
      ],
      connections: {
        手动触发: { main: [[{ node: "HTTP", type: "main", index: 0 }]] },
      },
      pinData: { HTTP: [{ json: { pinned: true } }] },
      settings: { saveDataSuccessExecution: "none", errorWorkflow: "wf-error" },
      active: true,
      tags: [{ name: "导入标签" }],
    };
    const result = importWorkflow(raw, { now: NOW });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.workflow.name).toBe("n8n 工作流");
    expect(result.workflow.nodes.map((item) => item.type)).toEqual([
      "manualTrigger",
      "httpRequest",
    ]);
    expect(result.workflow.active).toBe(true);
    expect(result.workflow.tags).toEqual(["导入标签"]);
    expect(result.workflow.settings.saveDataSuccessExecution).toBe("none");
    expect(result.workflow.settings.errorWorkflowId).toBe("wf-error");
    expect(result.workflow.nodes[1]?.pinData).toEqual([{ json: { pinned: true } }]);
    const trigger = result.workflow.nodes[0];
    const target = result.workflow.nodes[1];
    expect(result.workflow.connections[trigger?.id ?? ""]?.main[0]?.[0]?.node).toBe(target?.id);
    expect(result.workflow.id).not.toBe("wf-error");
  });

  it("导出后再导入可往返（节点与连接不丢）", () => {
    const workflow = workflowWith(
      [node("n1", "手动触发", "manualTrigger"), node("n2", "设置", "set")],
      { n1: { main: [[{ node: "n2", type: "main", index: 0 }]] } },
    );
    const imported = importWorkflow(exportWorkflow(workflow), { now: NOW + 1 });
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    expect(imported.workflow.nodes.map((item) => item.name)).toEqual(["手动触发", "设置"]);
    const source = imported.workflow.nodes[0];
    const target = imported.workflow.nodes[1];
    expect(imported.workflow.connections[source?.id ?? ""]?.main[0]?.[0]).toEqual({
      node: target?.id ?? "",
      type: "main",
      index: 0,
    });
  });

  it("未知节点类型默认丢弃并给 warning，全都不认识时给出中文错误", () => {
    const mixed = importWorkflow({
      name: "混合",
      nodes: [
        { name: "认识", type: "n8n-nodes-base.set", position: [0, 0], parameters: {} },
        { name: "不认识", type: "n8n-nodes-base.weirdNode", position: [0, 0], parameters: {} },
      ],
      connections: {},
    }, { now: NOW });
    expect(mixed.ok).toBe(true);
    if (!mixed.ok) return;
    expect(mixed.workflow.nodes).toHaveLength(1);
    expect(mixed.warnings.join("")).toContain("不支持的节点类型");

    const allUnknown = importWorkflow({
      name: "全不认识",
      nodes: [{ name: "x", type: "n8n-nodes-base.weirdNode", position: [0, 0], parameters: {} }],
      connections: {},
    }, { now: NOW });
    expect(allUnknown.ok).toBe(false);
    if (allUnknown.ok) return;
    expect(allUnknown.errors.join("")).toContain("没有本仓支持的节点");
  });

  it("strict 模式（onUnknownNode: error）遇到未知类型直接失败", () => {
    const result = importWorkflow(
      {
        name: "严格",
        nodes: [{ name: "x", type: "n8n-nodes-base.weirdNode", position: [0, 0], parameters: {} }],
        connections: {},
      },
      { now: NOW, onUnknownNode: "error" },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join("")).toContain("weirdNode");
  });

  it("重复节点名自动加后缀，连接按最终名字重映射", () => {
    const result = importWorkflow({
      name: "重名",
      nodes: [
        { name: "设置", type: "n8n-nodes-base.set", position: [0, 0], parameters: {} },
        { name: "设置", type: "n8n-nodes-base.set", position: [0, 200], parameters: {} },
      ],
      connections: {},
    }, { now: NOW });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.workflow.nodes.map((item) => item.name)).toEqual(["设置", "设置 2"]);
  });

  it("坏 JSON 文本给中文错误；缺 nodes 也给错误", () => {
    const text = importWorkflowFromText("{ oops", { now: NOW });
    expect(text.ok).toBe(false);
    if (text.ok) return;
    expect(text.errors[0]).toContain("不是合法的 JSON");

    const noNodes = importWorkflow({ name: "没有节点" }, { now: NOW });
    expect(noNodes.ok).toBe(false);
    if (noNodes.ok) return;
    expect(noNodes.errors[0]).toContain("缺少 nodes");
  });

  it("连接引用不存在的节点时丢弃并给 warning，不整体失败", () => {
    const result = importWorkflow({
      name: "坏连接",
      nodes: [{ name: "设置", type: "n8n-nodes-base.set", position: [0, 0], parameters: {} }],
      connections: { 设置: { main: [[{ node: "不存在", type: "main", index: 0 }]] } },
    }, { now: NOW });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings.join("")).toContain("连接指向不存在的节点");
  });

  it("节点级设置与凭据引用能导入", () => {
    const result = importWorkflow({
      name: "设置",
      nodes: [
        {
          name: "HTTP",
          type: "n8n-nodes-base.httpRequest",
          position: [0, 0],
          parameters: { url: "https://x" },
          disabled: true,
          notes: "别开",
          retryOnFail: true,
          maxTries: 9,
          waitBetweenTries: 99_999,
          onError: "continueErrorOutput",
          executeOnce: true,
          credentials: { httpHeader: { id: "cred-9", name: "头" } },
        },
      ],
      connections: {},
    }, { now: NOW });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const httpNode = result.workflow.nodes[0];
    expect(httpNode?.disabled).toBe(true);
    expect(httpNode?.notes).toBe("别开");
    expect(httpNode?.maxTries).toBe(5);
    expect(httpNode?.waitBetweenTries).toBe(5000);
    expect(httpNode?.onError).toBe("continueErrorOutput");
    expect(httpNode?.executeOnce).toBe(true);
    expect(httpNode?.credentials).toEqual({ httpHeader: "cred-9" });
  });
});
