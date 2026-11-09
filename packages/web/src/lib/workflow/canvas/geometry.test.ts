/**
 * 画布几何单测：端口位置、缩放锚点、框选命中、适配视图。
 *
 * 只测纯函数——交互本身在 Canvas.test.tsx 里用 fireEvent 覆盖。
 */

import { describe, it, expect } from "vitest";
import {
  NODE_HEIGHT,
  NODE_WIDTH,
  canvasToScreen,
  clampZoom,
  edgePath,
  fitView,
  inputPortPoint,
  nodeAtPoint,
  nodeRect,
  nodesInRect,
  normalizeRect,
  outputPortPoint,
  pointInRect,
  rectsIntersect,
  screenToCanvas,
  zoomAtPoint,
} from "./geometry.js";

describe("画布几何 · 坐标变换", () => {
  it("屏幕/画布互转可逆", () => {
    const viewport = { x: 40, y: -20, zoom: 1.5 };
    const canvas = screenToCanvas({ x: 200, y: 100 }, viewport);
    const screen = canvasToScreen(canvas, viewport);
    expect(screen.x).toBeCloseTo(200);
    expect(screen.y).toBeCloseTo(100);
  });

  it("以锚点缩放：锚点下的画布位置不动", () => {
    const viewport = { x: 0, y: 0, zoom: 1 };
    const anchor = { x: 300, y: 200 };
    const before = screenToCanvas(anchor, viewport);
    const next = zoomAtPoint(viewport, anchor, 2);
    expect(next.zoom).toBe(2);
    const after = screenToCanvas(anchor, next);
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
  });

  it("缩放夹紧在 0.2–2", () => {
    expect(clampZoom(0.01)).toBe(0.2);
    expect(clampZoom(9)).toBe(2);
    expect(clampZoom(1)).toBe(1);
    expect(clampZoom(Number.NaN)).toBe(1);
  });
});

describe("画布几何 · 节点与端口", () => {
  it("节点矩形固定宽度与估算高度", () => {
    expect(nodeRect({ x: 10, y: 20 })).toEqual({ x: 10, y: 20, width: NODE_WIDTH, height: NODE_HEIGHT });
  });

  it("单输入/单输出端口在竖直中点", () => {
    const input = inputPortPoint({ x: 0, y: 0 }, 0, 1);
    expect(input).toEqual({ x: 0, y: NODE_HEIGHT / 2 });
    const output = outputPortPoint({ x: 0, y: 0 }, 0, 1);
    expect(output).toEqual({ x: NODE_WIDTH, y: NODE_HEIGHT / 2 });
  });

  it("两输出口上下分开（If 的 true/false）", () => {
    const top = outputPortPoint({ x: 0, y: 0 }, 0, 2);
    const bottom = outputPortPoint({ x: 0, y: 0 }, 1, 2);
    expect(top.y).toBeLessThan(bottom.y);
    expect(top.x).toBe(NODE_WIDTH);
  });

  it("连线路径是三次贝塞尔，且控制点在两端水平外扩", () => {
    const path = edgePath({ x: 100, y: 0 }, { x: 400, y: 100 });
    expect(path.startsWith("M 100 0 C ")).toBe(true);
    expect(path).toContain("400 100");
  });
});

describe("画布几何 · 命中与框选", () => {
  it("矩形规范化支持反向拉框", () => {
    expect(normalizeRect({ x: 50, y: 40 }, { x: 10, y: 20 })).toEqual({
      x: 10,
      y: 20,
      width: 40,
      height: 20,
    });
  });

  it("点命中与矩形相交", () => {
    const rect = { x: 0, y: 0, width: 100, height: 50 };
    expect(pointInRect({ x: 50, y: 25 }, rect)).toBe(true);
    expect(pointInRect({ x: 150, y: 25 }, rect)).toBe(false);
    expect(rectsIntersect(rect, { x: 90, y: 40, width: 50, height: 50 })).toBe(true);
    expect(rectsIntersect(rect, { x: 200, y: 200, width: 10, height: 10 })).toBe(false);
  });

  it("框选返回相交节点；点命中取最后绘制（上层）的节点", () => {
    const nodes = [
      { id: "a", position: { x: 0, y: 0 } },
      { id: "b", position: { x: 300, y: 0 } },
    ];
    expect(nodesInRect(nodes, { x: -10, y: -10, width: 100, height: 100 })).toEqual(["a"]);
    expect(nodesInRect(nodes, { x: -10, y: -10, width: 900, height: 200 })).toEqual(["a", "b"]);
    expect(nodeAtPoint(nodes, { x: 310, y: 20 })).toBe("b");
    expect(nodeAtPoint(nodes, { x: 900, y: 900 })).toBeNull();
  });
});

describe("画布几何 · 适配视图", () => {
  it("空工作流回到 100% 原点", () => {
    expect(fitView([], { width: 800, height: 600 })).toEqual({ x: 0, y: 0, zoom: 1 });
  });

  it("把节点放进视口中央且不放大超过 1 倍", () => {
    const view = fitView([{ position: { x: 0, y: 0 } }], { width: 800, height: 600 });
    expect(view.zoom).toBe(1);
    // 单个节点应被放大约居中位置（左上有 padding，右侧留白更多）
    expect(view.x).toBeGreaterThan(0);
    expect(view.y).toBeGreaterThan(0);
  });

  it("节点很多时缩小到视口内", () => {
    const nodes = Array.from({ length: 20 }, (_, i) => ({ position: { x: i * 300, y: i * 80 } }));
    const view = fitView(nodes, { width: 800, height: 600 });
    expect(view.zoom).toBeLessThan(1);
    expect(view.zoom).toBeGreaterThanOrEqual(0.2);
  });
});
