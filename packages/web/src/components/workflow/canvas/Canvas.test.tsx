/**
 * 画布交互测试（jsdom）：选中、拖动、拖线、删除、双击加节点。
 *
 * 几何计算已在 geometry.test.ts 钉死；这里只证明「事件接上了」：
 * 每个手势都能触发对应回调，且参数是画布坐标（不是屏幕坐标）。
 */

import { describe, it, expect, vi, beforeAll } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { WorkflowCanvas } from "./Canvas.js";
import { addConnection, createNode, createWorkflow } from "../../../lib/workflow/model.js";
import { registerAllNodes } from "../../../lib/workflow/nodes/index.js";
import type { Workflow } from "../../../lib/workflow/types.js";

beforeAll(() => {
  registerAllNodes();
});

function makeWorkflow(): Workflow {
  const workflow = createWorkflow({ name: "画布测试" });
  const trigger = createNode("manualTrigger", { workflow, position: { x: 100, y: 100 } });
  const setNode = createNode("set", { workflow, position: { x: 500, y: 100 } });
  workflow.nodes = [trigger, setNode];
  addConnection(workflow, trigger.id, 0, setNode.id, 0);
  return workflow;
}

function baseProps(workflow: Workflow) {
  return {
    workflow,
    selectedIds: [] as string[],
    nodeRunState: {},
    onSelectionChange: vi.fn(),
    onMoveNodes: vi.fn(),
    onConnect: vi.fn(),
    onRequestDelete: vi.fn(),
    onOpenNode: vi.fn(),
    onRequestAddNode: vi.fn(),
    onCanvasDoubleClick: vi.fn(),
  };
}

describe("画布 · 渲染与选中", () => {
  it("渲染节点与空态提示，画布有可访问名称", () => {
    const workflow = makeWorkflow();
    const props = baseProps(workflow);
    render(<WorkflowCanvas {...props} />);
    expect(screen.getByRole("application", { name: "工作流画布" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "节点 手动触发" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "节点 设置字段" })).toBeInTheDocument();
  });

  it("点击节点选中它（单选）", () => {
    const workflow = makeWorkflow();
    const props = baseProps(workflow);
    render(<WorkflowCanvas {...props} />);
    fireEvent.pointerDown(screen.getByRole("button", { name: "节点 手动触发" }), {
      button: 0,
      clientX: 150,
      clientY: 130,
    });
    fireEvent.pointerUp(screen.getByRole("application"));
    expect(props.onSelectionChange).toHaveBeenCalledWith([workflow.nodes[0].id]);
  });

  it("双击节点打开详情；回车也打开", () => {
    const workflow = makeWorkflow();
    const props = baseProps(workflow);
    render(<WorkflowCanvas {...props} />);
    const node = screen.getByRole("button", { name: "节点 手动触发" });
    fireEvent.doubleClick(node);
    expect(props.onOpenNode).toHaveBeenCalledWith(workflow.nodes[0].id);
    fireEvent.keyDown(node, { key: "Enter" });
    expect(props.onOpenNode).toHaveBeenCalledTimes(2);
  });
});

describe("画布 · 手势回调", () => {
  it("拖动节点：松手时按画布坐标回调 onMoveNodes", () => {
    const workflow = makeWorkflow();
    const props = baseProps(workflow);
    render(<WorkflowCanvas {...props} />);
    // 先重置视口到 100%，让屏幕坐标 = 画布坐标
    fireEvent.click(screen.getByRole("button", { name: "重置缩放" }));
    const node = screen.getByRole("button", { name: "节点 手动触发" });
    fireEvent.pointerDown(node, { button: 0, clientX: 150, clientY: 130, pointerId: 1 });
    fireEvent.pointerMove(screen.getByRole("application"), { clientX: 250, clientY: 180, pointerId: 1 });
    fireEvent.pointerUp(screen.getByRole("application"), { pointerId: 1 });
    expect(props.onMoveNodes).toHaveBeenCalledTimes(1);
    const moves = props.onMoveNodes.mock.calls[0][0] as Array<{ id: string; position: { x: number; y: number } }>;
    expect(moves[0].id).toBe(workflow.nodes[0].id);
    expect(moves[0].position).toEqual({ x: 200, y: 150 });
  });

  it("从输出端口拖到另一个节点：回调 onConnect（落到最近输入口）", () => {
    const workflow = makeWorkflow();
    const props = baseProps(workflow);
    const { container } = render(<WorkflowCanvas {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "重置缩放" }));
    const port = container.querySelector(`[data-port="${workflow.nodes[0].id}:out:0"]`);
    expect(port).not.toBeNull();
    fireEvent.pointerDown(port!, { button: 0, clientX: 324, clientY: 134, pointerId: 1 });
    fireEvent.pointerMove(screen.getByRole("application"), { clientX: 520, clientY: 134, pointerId: 1 });
    fireEvent.pointerUp(screen.getByRole("application"), { pointerId: 1 });
    expect(props.onConnect).toHaveBeenCalledWith({
      sourceId: workflow.nodes[0].id,
      sourceOutput: 0,
      targetId: workflow.nodes[1].id,
      targetInput: 0,
    });
  });

  it("Delete 删除选中节点；Esc 清空选择", () => {
    const workflow = makeWorkflow();
    const props = { ...baseProps(workflow), selectedIds: [workflow.nodes[0].id] };
    render(<WorkflowCanvas {...props} />);
    const canvas = screen.getByRole("application");
    fireEvent.keyDown(canvas, { key: "Delete" });
    expect(props.onRequestDelete).toHaveBeenCalledWith([workflow.nodes[0].id]);
    fireEvent.keyDown(canvas, { key: "Escape" });
    expect(props.onSelectionChange).toHaveBeenCalledWith([]);
  });

  it("双击空白：回调 onRequestAddNode，坐标是画布坐标", () => {
    const workflow = makeWorkflow();
    const props = baseProps(workflow);
    render(<WorkflowCanvas {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "重置缩放" }));
    const canvas = screen.getByRole("application");
    fireEvent.doubleClick(canvas, { clientX: 300, clientY: 200 });
    expect(props.onRequestAddNode).toHaveBeenCalledTimes(1);
    expect(props.onRequestAddNode.mock.calls[0][0]).toEqual({ x: 300, y: 200 });
  });
});
