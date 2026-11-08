import { describe, expect, it } from "vitest";
import { buildGraph, layoutVaultGraph, LOCAL_DEPTH_MAX } from "./graph.js";
import { buildVaultIndex, type VaultDocInput } from "./index.js";

/**
 * vault 图谱：全库/局部 N 跳、度数、孤儿标记、确定性，以及复用 wiki 力导向的布局。
 */

function doc(rel: string, text: string): VaultDocInput {
  return { rel, text, mtime: "2026-11-08T00:00:00.000Z" };
}

const FIXTURE: VaultDocInput[] = [
  doc("a.md", "[[b]]\n"),
  doc("b.md", "[[c]] [[a]]\n"),
  doc("c.md", "[[b]] [[b]]\n"), // 重复链接只画一条边
  doc("d.md", "没有链接\n"),
  doc("e.md", "[[不存在]]\n"),
];

const INDEX = buildVaultIndex(FIXTURE);

describe("buildGraph 全库", () => {
  it("节点来自全部页面，按 rel 排序", () => {
    const graph = buildGraph(INDEX);
    expect(graph.nodes.map((node) => node.rel)).toEqual(["a.md", "b.md", "c.md", "d.md", "e.md"]);
    expect(graph.nodes.every((node) => node.kind === "md")).toBe(true);
  });

  it("边去重、去自环、未解析链接不造节点", () => {
    const graph = buildGraph(INDEX);
    // a→b 与 b→a 是同一条无向边；b→c / c→b 同理
    expect(graph.edges).toEqual([
      { source: "a.md", target: "b.md" },
      { source: "b.md", target: "c.md" },
    ]);
    expect(graph.edges.some((edge) => edge.source === edge.target)).toBe(false);
  });

  it("度数是去重后的无向度，孤儿标记来自索引", () => {
    const graph = buildGraph(INDEX);
    const byRel = new Map(graph.nodes.map((node) => [node.rel, node]));
    expect(byRel.get("a.md")?.degree).toBe(1);
    expect(byRel.get("b.md")?.degree).toBe(2);
    expect(byRel.get("c.md")?.degree).toBe(1);
    expect(byRel.get("d.md")?.degree).toBe(0);
    expect(byRel.get("d.md")?.orphan).toBe(true);
    expect(byRel.get("e.md")?.orphan).toBe(true);
    expect(byRel.get("b.md")?.orphan).toBe(false);
  });

  it("空索引 / null 返回空图", () => {
    expect(buildGraph(null)).toEqual({ nodes: [], edges: [] });
    expect(buildGraph(buildVaultIndex([]))).toEqual({ nodes: [], edges: [] });
  });

  it("确定性：两次构建结果完全一致", () => {
    expect(buildGraph(INDEX)).toEqual(buildGraph(INDEX));
  });
});

describe("buildGraph 局部图", () => {
  const chain = buildVaultIndex([
    doc("x1.md", "[[x2]]\n"),
    doc("x2.md", "[[x3]]\n"),
    doc("x3.md", "[[x4]]\n"),
    doc("x4.md", "终点\n"),
  ]);

  it("1 跳只含中心与直接邻居", () => {
    const graph = buildGraph(chain, { localOf: "x2.md", depth: 1 });
    expect(graph.nodes.map((node) => node.rel)).toEqual(["x1.md", "x2.md", "x3.md"]);
    expect(graph.edges).toEqual([
      { source: "x1.md", target: "x2.md" },
      { source: "x2.md", target: "x3.md" },
    ]);
  });

  it("2 跳沿链扩展，且只保留两端都在集合内的边", () => {
    const graph = buildGraph(chain, { localOf: "x2.md", depth: 2 });
    expect(graph.nodes.map((node) => node.rel)).toEqual([
      "x1.md",
      "x2.md",
      "x3.md",
      "x4.md",
    ]);
    expect(graph.edges).toHaveLength(3);
  });

  it("跳数被夹在 1..上限之间", () => {
    const one = buildGraph(chain, { localOf: "x2.md", depth: 0 });
    expect(one.nodes.map((node) => node.rel)).toEqual(["x1.md", "x2.md", "x3.md"]);
    const huge = buildGraph(chain, { localOf: "x2.md", depth: 99 });
    expect(huge.nodes).toHaveLength(4);
    expect(LOCAL_DEPTH_MAX).toBeGreaterThanOrEqual(2);
  });

  it("中心页不存在时返回空图", () => {
    expect(buildGraph(chain, { localOf: "没有这页.md" })).toEqual({ nodes: [], edges: [] });
  });

  it("局部图里孤立页不出现（除非它就是中心）", () => {
    const idx = buildVaultIndex([doc("a.md", "[[b]]\n"), doc("b.md", "B\n"), doc("z.md", "Z\n")]);
    expect(buildGraph(idx, { localOf: "a.md" }).nodes.map((node) => node.rel)).toEqual([
      "a.md",
      "b.md",
    ]);
    expect(buildGraph(idx, { localOf: "z.md" }).nodes.map((node) => node.rel)).toEqual(["z.md"]);
  });
});

describe("layoutVaultGraph", () => {
  it("复用 wiki 力导向：每个节点一个坐标，id 对齐", () => {
    const graph = buildGraph(INDEX);
    const points = layoutVaultGraph(graph, 400, 300);
    expect(points).toHaveLength(graph.nodes.length);
    expect(points.map((point) => point.id).sort()).toEqual(graph.nodes.map((node) => node.rel));
    for (const point of points) {
      expect(Number.isFinite(point.x)).toBe(true);
      expect(Number.isFinite(point.y)).toBe(true);
    }
  });

  it("确定性：同一张图两次布局完全一致", () => {
    const graph = buildGraph(INDEX);
    expect(layoutVaultGraph(graph, 400, 300)).toEqual(layoutVaultGraph(graph, 400, 300));
  });

  it("空图返回空坐标", () => {
    expect(layoutVaultGraph({ nodes: [], edges: [] }, 400, 300)).toEqual([]);
  });
});
