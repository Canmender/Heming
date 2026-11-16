import { createDefaultStorage, isPlainObject, readJson, writeJson } from "../memory/storage.js";
import type { StorageLike } from "./types.js";

/**
 * 手动压缩后「下一轮立刻生效」的一次性摘要（d.183）。
 *
 * 为什么不复用 `SummaryCache`：缓存键是「被折叠的那段历史的指纹」，而 `/compact`
 * 在**用户消息发送路径**上触发，手里只有简化后的文本行（没有工具调用配对），
 * 算出来的指纹跟下一轮真实请求算出来的往往对不上 → 缓存写了也不命中，用户点完
 * 「压缩」下一轮却还要再花一次摘要调用，白等一次。
 *
 * 所以手动摘要单独存一份**一次性覆盖**：下一轮组装历史时优先用掉（用完即删）。
 * 这样「点完就生效」是确定的，而不是「可能命中缓存」；过期风险也归零——同一段
 * 对话不会一直用旧摘要，下一轮之后回落到正常的缓存/确定性摘要链路。
 */

export const MANUAL_SUMMARY_KEY = "heming.contextManual.v1";
/** 用户输入这条命令触发手动压缩（d.183）。 */
export const COMPACT_COMMAND = "/compact";
/** 同时最多留存多少个会话的手动摘要（一次性，正常不会堆积）。 */
export const MANUAL_SUMMARY_MAX = 20;

type Bucket = Record<string, string>;

function storageOrDefault(storage?: StorageLike): StorageLike {
  return storage ?? createDefaultStorage();
}

function readBucket(storage?: StorageLike): Bucket {
  const raw = readJson<unknown>(storageOrDefault(storage), MANUAL_SUMMARY_KEY, {});
  if (!isPlainObject(raw)) return {};
  const out: Bucket = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string" && value.trim()) out[key] = value;
  }
  return out;
}

/** 记下「这个会话下一轮用这段摘要」。空摘要当没设置。 */
export function setManualSummary(conversationId: string, summary: string, storage?: StorageLike): void {
  const id = String(conversationId ?? "").trim();
  const text = String(summary ?? "").trim();
  if (!id || !text) return;
  const bucket = readBucket(storage);
  delete bucket[id]; // 重设时挪到末尾（淘汰按插入顺序）
  bucket[id] = text;
  const ids = Object.keys(bucket);
  for (const stale of ids.slice(0, Math.max(0, ids.length - MANUAL_SUMMARY_MAX))) delete bucket[stale];
  writeJson(storageOrDefault(storage), MANUAL_SUMMARY_KEY, bucket);
}

/**
 * 取走一次性摘要：读出来并从存储里删掉。
 *
 * 「取走」而不是「读取」是刻意的——摘要是对某一时刻历史的理解，用一次就该作废；
 * 留着会变成模型眼里的陈旧事实（用户早就把需求改了，摘要还在说旧结论）。
 */
export function takeManualSummary(conversationId: string, storage?: StorageLike): string {
  const id = String(conversationId ?? "").trim();
  if (!id) return "";
  const bucket = readBucket(storage);
  const text = bucket[id];
  if (!text) return "";
  delete bucket[id];
  writeJson(storageOrDefault(storage), MANUAL_SUMMARY_KEY, bucket);
  return text;
}

/** 清空全部手动摘要（测试与「重置本机数据」用）。 */
export function clearManualSummaries(storage?: StorageLike): void {
  writeJson(storageOrDefault(storage), MANUAL_SUMMARY_KEY, {});
}
