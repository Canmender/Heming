import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { WikiGraphView } from "./WikiGraphView.js";
import type { WikiGraph, WikiPage } from "../lib/wiki/index.js";

/** 两个节点一条边的最小图：足以验证手势，不牵扯布局细节。 */
function sampleGraph(): WikiGraph {
  return {
    nodes: [
      { id: "a.md", title: "甲", kind: "concepts", degree: 1, orphan: false },
      { id: "b.md", title: "乙", kind: "notes", degree: 1, orphan: false },
    ],
    edges: [{ source: "a.md", target: "b.md" }],
  };
}

function samplePages(): WikiPage[] {
  return sampleGraph().nodes.map((node) => ({
    path: node.id,
    title: node.title,
    kind: node.kind,
    tags: [],
    body: "",
    updatedAt: "",
  }));
}

function renderGraph(onSelect = vi.fn()) {
  const view = render(
    <WikiGraphView graph={sampleGraph()} pages={samplePages()} selected={null} onSelect={onSelect} />,
  );
  const canvas = screen.getByTestId("wiki-graph-canvas");
  return { view, canvas, onSelect };
}

describe("图谱视图 · 缩放与重置", () => {
  it("初始 100%，工具条显示百分比与重置入口", () => {
    renderGraph();
    expect(screen.getByTestId("graph-zoom-percent")).toHaveTextContent("100%");
    expect(screen.getByRole("button", { name: "重置视图" })).toBeInTheDocument();
    expect(screen.getByText(/滚轮缩放（以光标为中心）/)).toBeInTheDocument();
  });

  it("滚轮向上放大、向下缩小（连续缩放，不再一格一格跳）", () => {
    const { canvas } = renderGraph();
    fireEvent.wheel(canvas, { deltaY: -240, clientX: 400, clientY: 240 });
    const zoomedIn = Number(canvas.getAttribute("data-zoom"));
    expect(zoomedIn).toBeGreaterThan(1);
    expect(Number(screen.getByTestId("graph-zoom-percent").textContent?.replace("%", ""))).toBeGreaterThan(100);

    fireEvent.wheel(canvas, { deltaY: 480, clientX: 400, clientY: 240 });
    const zoomedOut = Number(canvas.getAttribute("data-zoom"));
    expect(zoomedOut).toBeLessThan(zoomedIn);
  });

  it("放大/缩小按钮按步进走，且夹在上下限内", () => {
    const { canvas } = renderGraph();
    fireEvent.click(screen.getByRole("button", { name: "放大图谱" }));
    expect(Number(canvas.getAttribute("data-zoom"))).toBeCloseTo(1.2, 3);
    for (let i = 0; i < 20; i += 1) {
      fireEvent.click(screen.getByRole("button", { name: "放大图谱" }));
    }
    expect(Number(canvas.getAttribute("data-zoom"))).toBe(2.4);
    for (let i = 0; i < 30; i += 1) {
      fireEvent.click(screen.getByRole("button", { name: "缩小图谱" }));
    }
    expect(Number(canvas.getAttribute("data-zoom"))).toBe(0.4);
  });

  it("重置视图回到 100%", () => {
    const { canvas } = renderGraph();
    fireEvent.wheel(canvas, { deltaY: -240 });
    expect(Number(canvas.getAttribute("data-zoom"))).toBeGreaterThan(1);
    fireEvent.click(screen.getByRole("button", { name: "重置视图" }));
    expect(screen.getByTestId("graph-zoom-percent")).toHaveTextContent("100%");
    expect(Number(canvas.getAttribute("data-zoom"))).toBe(1);
  });

  it("双击画布也能复位（沿用原有手势）", () => {
    const { canvas } = renderGraph();
    fireEvent.wheel(canvas, { deltaY: -240 });
    fireEvent.doubleClick(canvas);
    expect(screen.getByTestId("graph-zoom-percent")).toHaveTextContent("100%");
  });
});

describe("图谱视图 · 拖拽与点击", () => {
  it("拖拽超过阈值后再松开，补发的 click 不会误打开页面", () => {
    const { canvas, onSelect } = renderGraph();
    const node = screen.getByRole("button", { name: "打开页面 甲" });
    fireEvent.pointerDown(canvas, { clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(canvas, { clientX: 140, clientY: 130, pointerId: 1 });
    fireEvent.pointerUp(canvas, { clientX: 140, clientY: 130, pointerId: 1 });
    // 浏览器拖拽后补发的 click：坐标与松手点重合 → 应该被吞掉
    fireEvent.click(node, { clientX: 140, clientY: 130 });
    expect(onSelect).not.toHaveBeenCalled();

    // 下一次点到别的节点（坐标不同）仍然有效
    fireEvent.click(node, { clientX: 12, clientY: 34 });
    expect(onSelect).toHaveBeenCalledWith("a.md");
  });

  it("没有拖拽时点节点直接打开", () => {
    const { onSelect } = renderGraph();
    fireEvent.click(screen.getByRole("button", { name: "打开页面 乙" }));
    expect(onSelect).toHaveBeenCalledWith("b.md");
  });

  it("空图时给空态提示，不画空画布", () => {
    render(
      <WikiGraphView
        graph={{ nodes: [], edges: [] }}
        pages={[]}
        selected={null}
        onSelect={vi.fn()}
        emptyHint="这里还没有内容"
      />,
    );
    expect(screen.getByText("这里还没有内容")).toBeInTheDocument();
    expect(screen.queryByTestId("wiki-graph-canvas")).not.toBeInTheDocument();
  });
});
