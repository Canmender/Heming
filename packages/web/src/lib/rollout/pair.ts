import type { RolloutItem, RolloutToolCall, RolloutToolResult } from "./types.js";

/**
 * 工具调用 / 结果的配对校验（纯函数）。
 *
 * 为什么必须有它：日志里 `tool_call` 与 `tool_result` 是两条独立记录，
 * 崩溃发生在两者之间时会留下「有调用、没结果」的悬空记录；HITL 拒绝也会留下一条
 * `denied` 结果。**回放面板的「未完成」标注**与**分叉的前置条件**必须用同一份判定，
 * 否则会出现「面板说能分叉、点了却报错」——本模块就是那份唯一判定。
 *
 * 配对规则（按数组顺序，不依赖时间戳）：
 * - 结果去找**同一 id、且在它之前、尚未被配上**的调用，先来先配（FIFO）；
 * - 同一 id 重复出现（模型重试给了同样的 id）时，按出现顺序各配各的；
 * - 配不上的调用 = 悬空调用（崩溃证据）；配不上的结果 = 孤立结果（数据异常）。
 */

/** 一条配对成功的调用/结果。`callIndex`/`resultIndex` 是数组下标（界面高亮用）。 */
export interface RolloutToolPair {
  id: string;
  name: string;
  call: RolloutToolCall;
  result: RolloutToolResult;
  callSeq: number;
  resultSeq: number;
  callIndex: number;
  resultIndex: number;
  /** 结果是否成功（`denied` 也算失败，但语义另有字段）。 */
  ok: boolean;
  /** 被 HITL 拒绝：没有真正执行。 */
  denied: boolean;
}

export interface PairToolCallsResult {
  pairs: RolloutToolPair[];
  /** 有调用、没有结果的（按出现顺序）。 */
  danglingCalls: RolloutToolCall[];
  /** 有结果、没有调用的（按出现顺序）。 */
  orphanResults: RolloutToolResult[];
}

/** 按 id 配对一次回合的工具调用与结果。 */
export function pairToolCalls(items: RolloutItem[]): PairToolCallsResult {
  const pairs: RolloutToolPair[] = [];
  const danglingCalls: RolloutToolCall[] = [];
  const orphanResults: RolloutToolResult[] = [];
  /** 尚未配上的调用，按 id 分桶、桶内保序（FIFO）。 */
  const pending = new Map<string, { call: RolloutToolCall; index: number }[]>();

  items.forEach((item, index) => {
    if (item.type === "tool_call") {
      const bucket = pending.get(item.id) ?? [];
      bucket.push({ call: item, index });
      pending.set(item.id, bucket);
      return;
    }
    if (item.type !== "tool_result") return;
    const bucket = pending.get(item.id);
    const matched = bucket?.shift();
    if (!matched) {
      orphanResults.push(item);
      return;
    }
    pairs.push({
      id: item.id,
      name: item.name || matched.call.name,
      call: matched.call,
      result: item,
      callSeq: matched.call.seq,
      resultSeq: item.seq,
      callIndex: matched.index,
      resultIndex: index,
      ok: item.ok === true,
      denied: item.denied === true,
    });
  });

  // 悬空调用按出现顺序交出：桶是后进先出地被清空的，不能直接遍历 Map。
  const danglingIndexes: { call: RolloutToolCall; index: number }[] = [];
  for (const bucket of pending.values()) danglingIndexes.push(...bucket);
  danglingIndexes.sort((a, b) => a.index - b.index);
  for (const entry of danglingIndexes) danglingCalls.push(entry.call);

  return { pairs, danglingCalls, orphanResults };
}

/** 回合是否收尾、收在什么状态；缺 `turn_end` 或存在悬空调用都算「未完成」。 */
export type TurnIncompleteReason = "no_turn_start" | "missing_turn_end" | "dangling_call";

export interface TurnCompletion {
  /** 有没有 `turn_start`（正常回合恒为 true）。 */
  started: boolean;
  /** 有没有 `turn_end`。 */
  ended: boolean;
  status?: "ok" | "aborted" | "error";
  /** 未完成：缺 `turn_end`，或收尾了却仍有悬空调用。 */
  incomplete: boolean;
  reasons: TurnIncompleteReason[];
  /** 悬空调用的 id（按出现顺序）：崩溃发生在调用与结果之间。 */
  danglingCallIds: string[];
  /** 停在哪个 `seq`：有悬空 → 第一个悬空调用的 seq；缺 turn_end → 最后一条的 seq。 */
  stoppedAtSeq: number | null;
}

/**
 * 判定一回合是否「正常收尾」。
 *
 * 崩溃的唯一证据就在这里：进程被杀时最后一条往往是 `tool_call`（没等到结果），
 * 或整段没有 `turn_end`。**不能把它当成正常结束**——所以单独判，不当成展示细节。
 */
export function turnCompletion(items: RolloutItem[]): TurnCompletion {
  const started = items.some((it) => it.type === "turn_start");
  const end = items.find((it) => it.type === "turn_end") as
    | { status: "ok" | "aborted" | "error"; seq: number }
    | undefined;
  const { danglingCalls } = pairToolCalls(items);
  const reasons: TurnIncompleteReason[] = [];
  if (!started) reasons.push("no_turn_start");
  if (!end) reasons.push("missing_turn_end");
  if (danglingCalls.length > 0) reasons.push("dangling_call");

  let stoppedAtSeq: number | null = null;
  if (danglingCalls.length > 0) stoppedAtSeq = danglingCalls[0]!.seq;
  else if (!end && items.length > 0) stoppedAtSeq = items[items.length - 1]!.seq;

  return {
    started,
    ended: !!end,
    ...(end ? { status: end.status } : {}),
    incomplete: reasons.length > 0,
    reasons,
    danglingCallIds: danglingCalls.map((call) => call.id),
    stoppedAtSeq,
  };
}

/** 按 `seq` 找数组下标（找不到返回 -1）。分叉定位、回放跳转共用。 */
export function indexOfSeq(items: RolloutItem[], seq: number): number {
  if (!Number.isFinite(seq)) return -1;
  for (let i = 0; i < items.length; i += 1) {
    if (items[i]!.seq === seq) return i;
  }
  return -1;
}
