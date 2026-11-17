/**
 * 工具失败的按错误码计数（d.221）。
 *
 * ## 为什么
 *
 * d.220 让每一次失败都说得清「为什么」；但「为什么」是一次性的，用户真正想知道的
 * 是**这一段活到底卡在哪**：长任务里七次调用红了三次，如果三次都是 `path-escape`，
 * 那是工作区没选对，改一个设置就能过；如果三次分别是 `match-failed`、`read-failed`、
 * `unknown-tool`，那是模型在用错工具，得换个说法。两种情况的处置完全不同，而界面
 * 只有零散的单次提示。
 *
 * ## 口径
 *
 * - **只数事实**：按 `toolError.ts` 的稳定错误码归类（`failureCode` 解析）；被用户
 *   拒绝的那次没有错误码，单独记成 `denied`，不和「失败」混一起。
 * - **按会话、按本进程**：不落盘（重启后重新数），也不跨会话汇总——不同工作区的失败
 *   原因不可比。
 * - **最多记 20 个错误码**：长尾只做截断，不假装完整；`/status` 里会说明只列前几个。
 */

import { failureCode } from "../toolFailure.js";

/** 被用户拒绝时的归类键（契约里没有错误码）。 */
export const DENIED_CODE = "denied";

/** 每个会话最多记多少个不同的错误码。 */
export const MAX_FAILURE_CODES = 20;

/** 一个错误码的计数。 */
export interface FailureCodeCount {
  code: string;
  count: number;
}

/** 一个会话的失败归因。 */
export interface ToolFailureStats {
  /** 总失败次数（含被拒）。 */
  total: number;
  /** 按次数从多到少；同次数按首次出现顺序。 */
  codes: readonly FailureCodeCount[];
  /** 出问题的工具名（按次数从多到少，最多 5 个）。 */
  tools: readonly FailureCodeCount[];
  /** 出错码种类超过上限时，被截断的种类数（0 表示没截断）。 */
  dropped: number;
}

interface Bucket {
  total: number;
  codes: Map<string, number>;
  order: string[];
  dropped: number;
  tools: Map<string, number>;
}

const buckets = new Map<string, Bucket>();

function bucketOf(conversationId: string): Bucket | null {
  if (!conversationId) return null;
  let bucket = buckets.get(conversationId);
  if (!bucket) {
    bucket = { total: 0, codes: new Map(), order: [], dropped: 0, tools: new Map() };
    buckets.set(conversationId, bucket);
  }
  return bucket;
}

function bump(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function sorted(map: Map<string, number>, order: readonly string[]): FailureCodeCount[] {
  const rank = new Map(order.map((key, index) => [key, index]));
  return [...map.entries()]
    .map(([code, count]) => ({ code, count }))
    .sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return (rank.get(a.code) ?? 0) - (rank.get(b.code) ?? 0);
    });
}

/**
 * 记一次失败。
 *
 * `denied` 为 true 时按 `denied` 归类（用户拒绝不是工具失败）；其余从结果文本里取错误码，
 * 取不到记 `unknown`——**不猜**，但也不能悄悄丢掉这次失败。
 */
export function recordToolFailure(
  conversationId: string,
  input: { tool: string; result?: string; denied?: boolean; errorCode?: string },
): void {
  const bucket = bucketOf(conversationId);
  if (!bucket) return;
  const explicit = (input.errorCode ?? "").trim();
  const code = input.denied
    ? DENIED_CODE
    : explicit !== ""
      ? explicit
      : (failureCode(input.result) ?? "unknown");
  bucket.total += 1;
  const seen = bucket.codes.has(code);
  if (!seen) {
    if (bucket.codes.size >= MAX_FAILURE_CODES) {
      // 长尾：只记次数，不新增种类（也不假装记全了）。
      bucket.dropped += 1;
      bump(bucket.tools, String(input.tool || "unknown"));
      return;
    }
    bucket.order.push(code);
  }
  bump(bucket.codes, code);
  bump(bucket.tools, String(input.tool || "unknown"));
}

/** 读一个会话的失败归因；没记过返回 null（调用方据此不写这一行）。 */
export function getToolFailureStats(conversationId: string): ToolFailureStats | null {
  const bucket = conversationId ? buckets.get(conversationId) : undefined;
  if (!bucket || bucket.total === 0) return null;
  return {
    total: bucket.total,
    codes: sorted(bucket.codes, bucket.order),
    tools: sorted(bucket.tools, []).slice(0, 5),
    dropped: bucket.dropped,
  };
}

/** 清掉一个会话的计数（换工作区/清空上下文后从零数）。 */
export function clearToolFailureStats(conversationId?: string): void {
  if (!conversationId) {
    buckets.clear();
    return;
  }
  buckets.delete(conversationId);
}

/** 测试与「重新开始」用：全部清空。 */
export function resetToolFailureStats(): void {
  buckets.clear();
}
