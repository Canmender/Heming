/**
 * Anthropic 前缀缓存的断点规划。
 *
 * ★ 为什么值得做：一次 @ 提及最多发 4 个请求（1 正文 + 最多 3 轮工具，见
 * `agentStream.ts` 的 `MAX_TOOL_ROUNDS`），每个请求都重带整段
 * 「系统提示词 + 记忆 + 技能 + 历史 + 已完成的工具结果」，全按未缓存输入计费。
 * 缓存写入 1.25×、读取 0.1× ⇒ 4 次请求从 `4P` 降到约 `1.55P`。
 *
 * ★ 三条不变量（借 hermes-agent `agent/prompt_caching.py`，MIT © 2025 Nous Research）：
 *   1. **一次请求最多 4 个断点**，多一个就是硬报错；
 *   2. **每次先剥掉上一轮的标记**（幂等）——否则重复规划会累积成第 5 个；
 *   3. **只落在已完成的事务末尾**，绝不落在「还开着的那一轮」上：工具结果还没回填的
 *      assistant 行下一请求一定会变，写进缓存等于白付 1.25× 溢价。
 *
 * 跨 @ 提及不规划断点：和鸣的系统提示词每次重算（记忆/技能依赖本轮输入），
 * 前缀本身不保证逐字相同，给它打标记只会稳定地赔写入费。
 */
import type { AnthropicMessage, AnthropicTool, CacheMarker, TextBlock } from "./llmAnthropic.js";

/** 供应商硬上限。 */
export const MAX_CACHE_BREAKPOINTS = 4;

/** 缺省 TTL：和鸣的会话与自动化都是短节拍，1h 档写入价 2× 不值得默认吃。 */
export const CACHE_TTL = "5m";

export interface CachePlanInput {
  systemBlocks: TextBlock[];
  messages: AnthropicMessage[];
  tools: AnthropicTool[];
  /** 已完成工具事务在 `messages` 里的位置（由 `toAnthropicMessages` 一并产出）。 */
  transactionEnds: { index: number; blockIndex: number }[];
  ttl?: string;
}

/** 递归删掉 `cache_control`（浅拷贝即可：调用方给的都是本次新建的对象）。 */
export function stripCacheMarkers<T>(node: T): T {
  if (Array.isArray(node)) {
    for (const item of node) stripCacheMarkers(item);
    return node;
  }
  if (node && typeof node === "object") {
    const obj = node as Record<string, unknown>;
    delete obj.cache_control;
    for (const value of Object.values(obj)) {
      if (value && typeof value === "object") stripCacheMarkers(value);
    }
  }
  return node;
}

const marker = (ttl: string): CacheMarker => ({ type: "ephemeral", ttl });

/**
 * 就地打标记，返回实际使用的断点数。
 *
 * 布局：`system` 最后一块 → `tools` 最后一个工具 → 最近两个已完成事务末尾。
 * 前两项不存在时额度顺延给后一项。
 */
export function planCache(input: CachePlanInput): number {
  const { systemBlocks, messages, tools, transactionEnds, ttl = CACHE_TTL } = input;
  // 不变量 2：先剥净，规划两次与规划一次等价
  stripCacheMarkers(systemBlocks);
  stripCacheMarkers(messages);
  stripCacheMarkers(tools);

  let used = 0;
  const spend = (): boolean => used < MAX_CACHE_BREAKPOINTS;

  if (systemBlocks.length > 0 && spend()) {
    systemBlocks[systemBlocks.length - 1].cache_control = marker(ttl);
    used++;
  }
  if (tools.length > 0 && spend()) {
    tools[tools.length - 1].cache_control = marker(ttl);
    used++;
  }
  // 不变量 3：只有事务闭合了才值得缓存这一段；从末尾往前取，额度用满即止
  for (let i = transactionEnds.length - 1; i >= 0 && spend(); i--) {
    const end = transactionEnds[i];
    const block = messages[end.index]?.content[end.blockIndex];
    if (!block) continue;
    block.cache_control = marker(ttl);
    used++;
  }
  return used;
}

/** 统计 body 里的标记数（测试与自检用：绝不允许 > 4）。 */
export function countCacheMarkers(node: unknown): number {
  if (Array.isArray(node)) return node.reduce((n: number, v) => n + countCacheMarkers(v), 0);
  if (!node || typeof node !== "object") return 0;
  const obj = node as Record<string, unknown>;
  let n = typeof obj.cache_control === "object" ? 1 : 0;
  for (const value of Object.values(obj)) n += countCacheMarkers(value);
  return n;
}
