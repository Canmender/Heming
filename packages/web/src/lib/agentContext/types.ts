/**
 * 上下文预算与压缩的数据契约（设计 §3）。
 * `ChatMessage` / `StorageLike` 一律直接复用既有定义，本模块不重复声明。
 */

export type { ChatMessage } from "../llmClient.js";
export type { StorageLike } from "../memory/types.js";

/** 摘要缓存条目：summary 为摘要正文，at 为写入时刻（毫秒，淘汰排序用）。 */
export interface SummaryCacheEntry {
  summary: string;
  at: number;
}

/** 摘要缓存落盘结构：会话 → 指纹 → 条目。 */
export type SummaryCacheData = Record<string, Record<string, SummaryCacheEntry>>;
