import type { WikiGraph } from "./index.js";

/**
 * 力导向布局（参照 Obsidian graph view 的观感）。
 *
 * 纯函数、无依赖、可测：给定图谱与画布尺寸，迭代若干轮斥力 + 弹簧 + 向心力，
 * 输出每个节点的坐标。图谱规模不大（个人 wiki 通常几百页），
 * O(n²) 的斥力足够，不需要 d3-force 之类的库。
 *
 * **确定性**：初始位置由节点 id 哈希决定，不用 Math.random——
 * 同一份 wiki 每次打开的布局一致，用户能形成空间记忆；
 * 且布局可被测试断言。
 */

/** 迭代轮数。太多会抖（力导向是松弛过程，不是收敛方程），200 轮视觉上已稳定。 */
export const LAYOUT_ITERATIONS = 200;

/** 斥力强度：节点间推开的力度。 */
const REPULSION = 5200;

/** 弹簧强度与理想长度：把有连接的节点拉近。 */
const SPRING = 0.012;
const SPRING_LENGTH = 90;

/** 向心力：把所有节点往中心收，避免图散开成一片。 */
const CENTER_PULL = 0.012;

/** 阻尼：模拟能量耗散，否则会一直抖动停不下来。 */
const DAMPING = 0.82;

/** 最小距离：小于它就直接按固定距离分开，避免两点重叠成一坨。 */
const MIN_DIST = 26;

/** 稳定判据：全体最大位移小于该值即提前收敛退出。 */
const EPSILON = 0.35;

/** 节点 id → [0,1) 的确定性初值（字符串哈希，跨会话稳定）。 */
function hashUnit(id: string, salt: number): number {
  let h = 2166136261 ^ salt;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  // >>> 0 转无符号，再用 2^32 取模得 [0,1)
  return (h >>> 0) / 4294967296;
}

export interface LayoutPoint {
  id: string;
  x: number;
  y: number;
}

/**
 * 计算布局坐标。
 * @param graph 图谱（来自 buildGraph）
 * @param width 画布宽（px）
 * @param height 画布高（px）
 */
export function layoutGraph(
  graph: WikiGraph,
  width: number,
  height: number,
): LayoutPoint[] {
  const n = graph.nodes.length;
  const cx = width / 2;
  const cy = height / 2;
  if (n === 0) return [];

  // 初值：哈希决定的环形散布（比纯随机更均匀，且确定性）
  const pos = graph.nodes.map((node, i) => {
    const angle = hashUnit(node.id, 0x9e37) * Math.PI * 2 + (i / n) * Math.PI * 2;
    const radius = MIN_DIST + hashUnit(node.id, 0x85eb) * (Math.min(width, height) / 3);
    return { id: node.id, x: cx + Math.cos(angle) * radius, y: cy + Math.sin(angle) * radius };
  });

  const index = new Map<string, number>();
  graph.nodes.forEach((node, i) => index.set(node.id, i));

  for (let step = 0; step < LAYOUT_ITERATIONS; step++) {
    const force = new Array(n).fill(0).map(() => ({ x: 0, y: 0 }));

    // 斥力：任意两点互斥
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let dx = pos[i].x - pos[j].x;
        let dy = pos[i].y - pos[j].y;
        let dist2 = dx * dx + dy * dy;
        if (dist2 < 1) {
          // 完全重合时用哈希给一个确定的方向，避免除零
          dx = hashUnit(pos[i].id, 0x2545) - 0.5 || 0.1;
          dy = hashUnit(pos[i].id, 0x2722) - 0.5 || 0.1;
          dist2 = dx * dx + dy * dy;
        }
        const dist = Math.sqrt(dist2);
        if (dist < MIN_DIST) {
          // 太近：按固定距离直接分开（比平方反比更稳，不会把点弹飞）
          const push = (MIN_DIST - dist) / MIN_DIST;
          const ux = dx / dist;
          const uy = dy / dist;
          force[i].x += ux * push * 12;
          force[i].y += uy * push * 12;
          force[j].x -= ux * push * 12;
          force[j].y -= uy * push * 12;
          continue;
        }
        const f = REPULSION / dist2;
        const ux = dx / dist;
        const uy = dy / dist;
        force[i].x += ux * f;
        force[i].y += uy * f;
        force[j].x -= ux * f;
        force[j].y -= uy * f;
      }
    }

    // 弹簧：每条边把两端拉向理想长度
    for (const edge of graph.edges) {
      const a = index.get(edge.source);
      const b = index.get(edge.target);
      if (a === undefined || b === undefined) continue;
      const dx = pos[b].x - pos[a].x;
      const dy = pos[b].y - pos[a].y;
      const dist = Math.hypot(dx, dy) || 1;
      const f = (dist - SPRING_LENGTH) * SPRING;
      const ux = dx / dist;
      const uy = dy / dist;
      force[a].x += ux * f;
      force[a].y += uy * f;
      force[b].x -= ux * f;
      force[b].y -= uy * f;
    }

    // 向心力 + 阻尼推进
    let maxMove = 0;
    for (let i = 0; i < n; i++) {
      force[i].x += (cx - pos[i].x) * CENTER_PULL;
      force[i].y += (cy - pos[i].y) * CENTER_PULL;
      const stepX = force[i].x * DAMPING;
      const stepY = force[i].y * DAMPING;
      // 单步位移上限：防止个别强斥力把节点甩出画布
      const clamped = Math.min(24, Math.hypot(stepX, stepY));
      const scale = Math.hypot(stepX, stepY) > 0 ? clamped / Math.hypot(stepX, stepY) : 0;
      pos[i].x += stepX * scale;
      pos[i].y += stepY * scale;
      maxMove = Math.max(maxMove, clamped);
    }

    if (maxMove < EPSILON) break; // 已静止，无需继续
  }

  return pos;
}

/**
 * 节点半径：枢纽页（度越大）越大，与 Obsidian graph view 一致。
 * 下限 4、上限 16，避免单节点时缩成一个点或过度占位。
 */
export function nodeRadius(degree: number): number {
  return Math.min(16, 4 + Math.sqrt(degree) * 3.2);
}