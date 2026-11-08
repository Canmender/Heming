/**
 * vault 图谱：把索引变成节点/边（全库或「当前页 N 跳」局部图），并复用
 * `lib/wiki/layout.ts` 的力导向布局。
 *
 * 为什么复用 layout：那是仓库里已经稳定、确定性的实现（初值由 id 哈希决定，
 * 同一份库每次打开的布局一致）。图谱这层只负责「选哪些节点/边、度数怎么算」，
 * 不重复写物理模拟。
 *
 * 确定性：节点按 rel 排序、边按 (source,target) 排序、边去重（无向对只留一条），
 * 自环不画——同一份索引永远得到同一张图。
 */

import { layoutGraph, type LayoutPoint } from "../wiki/layout.js";
import type { VaultIndex } from "./types.js";

/** 图谱节点类别：md 笔记 / canvas 画布 / 其它文本。 */
export type VaultNodeKind = "md" | "canvas" | "other";

export interface VaultGraphNode {
  /** 节点 id = 页面 rel（与索引的 key 一致）。 */
  id: string;
  rel: string;
  title: string;
  kind: VaultNodeKind;
  /** 无向度数：去重后的相连边数。 */
  degree: number;
  /** 是否孤立页（来自索引的 orphans）。 */
  orphan: boolean;
  tags: string[];
}

export interface VaultGraphEdge {
  source: string;
  target: string;
}

export interface VaultGraph {
  nodes: VaultGraphNode[];
  edges: VaultGraphEdge[];
}

/** 局部图默认跳数。 */
export const LOCAL_DEPTH_DEFAULT = 1;
/** 局部图最大跳数（再远就不是「局部」了，界面也只提供 1–2 跳）。 */
export const LOCAL_DEPTH_MAX = 3;

export interface GraphOptions {
  /** 局部图中心页；缺省 = 全库图。 */
  localOf?: string;
  /** 局部图跳数（1–3，默认 1）。 */
  depth?: number;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function nodeKindOf(rel: string): VaultNodeKind {
  if (/\.md$/i.test(rel)) return "md";
  if (/\.canvas$/i.test(rel)) return "canvas";
  return "other";
}

/** 无向边的规范键：两端排序后拼接，避免 A→B 与 B→A 画两条。 */
function edgeKey(source: string, target: string): string {
  return source < target ? `${source}\u0000${target}` : `${target}\u0000${source}`;
}

/**
 * 构建图谱。
 *
 * - 全库：索引里所有页面 + 所有已解析链接（去重、去自环）；
 * - 局部：从 `localOf` 出发按**无向**边做 N 跳 BFS，只保留落在集合内的节点与边。
 */
export function buildGraph(index: VaultIndex | null, options: GraphOptions = {}): VaultGraph {
  if (!index) return { nodes: [], edges: [] };

  const pages = [...index.pages.values()].sort((a, b) => compareText(a.rel, b.rel));
  const adjacency = new Map<string, Set<string>>();
  const edges: VaultGraphEdge[] = [];
  const seenEdge = new Set<string>();
  for (const page of pages) adjacency.set(page.rel, new Set());

  for (const link of index.links) {
    if (link.resolved === null) continue;
    if (link.resolved === link.from) continue; // 自环不画
    const key = edgeKey(link.from, link.resolved);
    if (seenEdge.has(key)) continue;
    seenEdge.add(key);
    edges.push({ source: link.from, target: link.resolved });
    adjacency.get(link.from)?.add(link.resolved);
    adjacency.get(link.resolved)?.add(link.from);
  }
  edges.sort((a, b) => compareText(a.source, b.source) || compareText(a.target, b.target));

  const orphanSet = new Set(index.orphans);
  const nodes: VaultGraphNode[] = pages.map((page) => ({
    id: page.rel,
    rel: page.rel,
    title: page.title,
    kind: nodeKindOf(page.rel),
    degree: adjacency.get(page.rel)?.size ?? 0,
    orphan: orphanSet.has(page.rel),
    tags: [...page.tags],
  }));

  if (!options.localOf) return { nodes, edges };

  const start = String(options.localOf).replace(/\\/g, "/").replace(/^\/+/, "");
  if (!index.pages.has(start)) return { nodes: [], edges: [] };
  const depth = Math.min(
    LOCAL_DEPTH_MAX,
    Math.max(1, Math.floor(options.depth ?? LOCAL_DEPTH_DEFAULT)),
  );

  const visited = new Set<string>([start]);
  let frontier: string[] = [start];
  for (let hop = 0; hop < depth; hop += 1) {
    const next: string[] = [];
    for (const rel of frontier) {
      for (const neighbor of adjacency.get(rel) ?? []) {
        if (visited.has(neighbor)) continue;
        visited.add(neighbor);
        next.push(neighbor);
      }
    }
    frontier = next.sort(compareText);
    if (!frontier.length) break;
  }

  const localNodes = nodes.filter((node) => visited.has(node.rel));
  const localEdges = edges.filter(
    (edge) => visited.has(edge.source) && visited.has(edge.target),
  );
  return { nodes: localNodes, edges: localEdges };
}

/**
 * 用 `lib/wiki/layout.ts` 的力导向算坐标。
 *
 * 只做形状适配：vault 节点没有「wiki 类别」，统一映射成 `notes`（布局只用到
 * id / degree，类别不参与力学计算）。
 */
export function layoutVaultGraph(
  graph: VaultGraph,
  width: number,
  height: number,
): LayoutPoint[] {
  return layoutGraph(
    {
      nodes: graph.nodes.map((node) => ({
        id: node.id,
        title: node.title,
        kind: "notes" as const,
        degree: node.degree,
        orphan: node.orphan,
      })),
      edges: graph.edges.map((edge) => ({ source: edge.source, target: edge.target })),
    },
    width,
    height,
  );
}
