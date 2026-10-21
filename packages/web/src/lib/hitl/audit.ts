/**
 * 工具确认的留痕。
 *
 * 为什么复用 `selfEdit/guards.ts` 的 `appendAudit` 而不是另建一套：
 * 留痕设施只该有一份。两套并行必然漂移，而「批准/拒绝记录查不到」这件事
 * 在事后追责时是致命的——用户问「刚才那次到底批没批」，答不上来就等于没做。
 *
 * 做法只是把 `scope` 扩成 `"tool"`（见 `guards.ts` 的 `AuditEntry`），
 * 于是工具确认与自我修改的记录在同一条时间线上，界面也能一起展示。
 */

import { appendAudit, type StorageLike } from "../selfEdit/guards.js";

/** 一次工具确认的裁决（`action` 直接落进 `AuditEntry.action`）。 */
export interface ToolAuditEntry {
  /** 发起这次调用的智能体。 */
  agentId: string;
  /** 裁决：`allow` / `allow-session` / `deny`。 */
  action: string;
  /** 被确认的工具（给人看的可读标识）。 */
  target: string;
  /** 拒绝理由（非拒绝时可省）。 */
  rejected?: string;
  /** 时间戳（ISO 字符串；不传则取当前时间）。 */
  at?: string;
}

/** 记一条工具确认留痕。 */
export function appendToolAudit(storage: StorageLike, entry: ToolAuditEntry): void {
  appendAudit(storage, {
    at: entry.at ?? new Date().toISOString(),
    agentId: entry.agentId,
    scope: "tool",
    action: entry.action,
    target: entry.target,
    ...(entry.rejected ? { rejected: entry.rejected } : {}),
  });
}
