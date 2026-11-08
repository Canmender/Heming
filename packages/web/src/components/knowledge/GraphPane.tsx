import { useMemo, useState } from "react";
import type { VaultIndex } from "../../lib/vault/types.js";
import { buildGraph, type VaultGraph } from "../../lib/vault/graph.js";
import type { WikiGraph, WikiPage } from "../../lib/wiki/index.js";
import { WikiGraphView } from "../WikiGraphView.js";

/**
 * 图谱面板：全库 / 局部 1–2 跳切换，点节点打开页面。
 *
 * 复用 `WikiGraphView`（力导向布局 + 缩放拖拽 + 节点点击）而不是再写一份画布：
 * 唯一的差别是 vault 页面没有 wiki 的类别（entities/concepts/…），所以：
 * - 节点类别统一映射成 `notes`（布局只用到 id/degree，类别不参与力学计算）；
 * - 通过 `showLegend={false}` 关掉 wiki 的五类图例，避免显示没有意义的分类；
 * - 节点大小/度数说明写清楚**按全库统计**（局部图沿用全库度数，不是局部度数）。
 */

export interface GraphPaneProps {
  /** 全库索引（null = 还没建好）。 */
  index: VaultIndex | null;
  /** 当前文件 rel（局部图的中心；为空时局部图不可用）。 */
  activeRel?: string | null;
  /** 点击节点打开页面。 */
  onOpen: (rel: string) => void;
}

type Scope = "all" | "local";

export function GraphPane({ index, activeRel = null, onOpen }: GraphPaneProps) {
  const [scope, setScope] = useState<Scope>("all");
  const [depth, setDepth] = useState(1);

  const vaultGraph: VaultGraph = useMemo(() => {
    const local = scope === "local" && activeRel ? { localOf: activeRel, depth } : {};
    return buildGraph(index, local);
  }, [index, scope, depth, activeRel]);

  // 形状适配：WikiGraphView 只认 wiki 的 WikiGraph / WikiPage（不改它的旧接口）
  const graph: WikiGraph = useMemo(
    () => ({
      nodes: vaultGraph.nodes.map((node) => ({
        id: node.id,
        title: node.title,
        kind: "notes" as const,
        degree: node.degree,
        orphan: node.orphan,
      })),
      edges: vaultGraph.edges.map((edge) => ({ source: edge.source, target: edge.target })),
    }),
    [vaultGraph],
  );

  const pages: WikiPage[] = useMemo(
    () =>
      vaultGraph.nodes.map((node) => ({
        path: node.rel,
        title: node.title,
        kind: "notes" as const,
        tags: node.tags,
        body: "",
        updatedAt: "",
      })),
    [vaultGraph],
  );

  const localAvailable = Boolean(activeRel);

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="ui-section-title">图谱</span>
        <span className="ui-caption">
          {scope === "local" && activeRel
            ? `以 ${activeRel} 为中心 ${depth} 跳`
            : "全库视图"}
        </span>
        <span className="ui-caption ml-1">节点大小按全库度数，不是局部分布。</span>

        <span className="ml-auto flex items-center gap-1" role="group" aria-label="图谱范围">
          <button
            type="button"
            aria-pressed={scope === "all"}
            onClick={() => setScope("all")}
            className={`ui-btn ui-btn-sm ${scope === "all" ? "ui-btn-primary" : "ui-btn-ghost"}`}
          >
            全库
          </button>
          <button
            type="button"
            aria-pressed={scope === "local"}
            onClick={() => setScope("local")}
            disabled={!localAvailable}
            title={localAvailable ? "只看当前页附近的节点" : "先打开一篇笔记才能看局部图"}
            className={`ui-btn ui-btn-sm ${scope === "local" ? "ui-btn-primary" : "ui-btn-ghost"}`}
          >
            局部
          </button>
          {scope === "local" ? (
            <span className="ml-1 flex items-center gap-1" role="group" aria-label="局部跳数">
              {[1, 2].map((n) => (
                <button
                  key={n}
                  type="button"
                  aria-pressed={depth === n}
                  aria-label={`局部 ${n} 跳`}
                  onClick={() => setDepth(n)}
                  className={`ui-btn ui-btn-sm ${depth === n ? "ui-btn-primary" : "ui-btn-ghost"}`}
                >
                  {n} 跳
                </button>
              ))}
            </span>
          ) : null}
        </span>
      </div>

      <div className="min-h-0 flex-1">
        <WikiGraphView
          graph={graph}
          pages={pages}
          selected={activeRel}
          onSelect={onOpen}
          showLegend={false}
          emptyHint={
            scope === "local"
              ? "当前页附近还没有可画的链接。全库图谱可能更有内容。"
              : "还没有页面。建一页写点双链，这里就会长出图来。"
          }
        />
      </div>
    </div>
  );
}
