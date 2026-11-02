import { describe, expect, it } from "vitest";
import { indexOfSeq, pairToolCalls, turnCompletion } from "./pair.js";
import type { RolloutItem } from "./types.js";

/**
 * 配对校验：回放面板的「未完成」标注与分叉前置条件共用这一份判定。
 * 用例按「日志里真会出现什么」来写：崩溃、拒绝、模型重试给同一个 id。
 */

const at = (s: number) => `2026-11-02T09:00:${String(s).padStart(2, "0")}.000Z`;

function call(seq: number, id: string, name = "srv__x", args = "{}"): RolloutItem {
  return { type: "tool_call", seq, at: at(seq), streamId: "s1", id, name, args };
}

function result(
  seq: number,
  id: string,
  opts: { ok?: boolean; denied?: boolean; text?: string; name?: string } = {},
): RolloutItem {
  return {
    type: "tool_result",
    seq,
    at: at(seq),
    streamId: "s1",
    id,
    name: opts.name ?? "srv__x",
    ok: opts.ok ?? true,
    ...(opts.denied ? { denied: true } : {}),
    text: opts.text ?? "结果",
  };
}

describe("pairToolCalls", () => {
  it("正常成对：一次调用配一条结果", () => {
    const items: RolloutItem[] = [
      { type: "turn_start", seq: 0, at: at(0), conversationId: "c1", streamId: "s1", agentId: "a1", userText: "查" },
      call(1, "t1", "srv__read"),
      result(2, "t1", { name: "srv__read", text: "内容" }),
      { type: "turn_end", seq: 3, at: at(3), streamId: "s1", status: "ok" },
    ];
    const { pairs, danglingCalls, orphanResults } = pairToolCalls(items);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({ id: "t1", callIndex: 1, resultIndex: 2, ok: true, denied: false });
    expect(danglingCalls).toEqual([]);
    expect(orphanResults).toEqual([]);
  });

  it("悬空调用：有调用没结果（崩溃现场）", () => {
    const { pairs, danglingCalls } = pairToolCalls([call(1, "t1"), call(2, "t2")]);
    expect(pairs).toEqual([]);
    expect(danglingCalls.map((c) => c.id)).toEqual(["t1", "t2"]);
  });

  it("孤立结果：没有对应的调用（数据异常，不能当成正常配对）", () => {
    const { pairs, orphanResults } = pairToolCalls([result(1, "ghost")]);
    expect(pairs).toEqual([]);
    expect(orphanResults.map((r) => r.id)).toEqual(["ghost"]);
  });

  it("同一 id 重复出现：按出现顺序各配各的，不多配也不少配", () => {
    const items: RolloutItem[] = [
      call(1, "dup", "srv__a"),
      result(2, "dup", { text: "第一次" }),
      call(3, "dup", "srv__a"),
      result(4, "dup", { text: "第二次" }),
    ];
    const { pairs, danglingCalls, orphanResults } = pairToolCalls(items);
    expect(pairs).toHaveLength(2);
    expect(pairs.map((p) => p.resultSeq)).toEqual([2, 4]);
    expect(pairs.map((p) => p.callSeq)).toEqual([1, 3]);
    expect(danglingCalls).toEqual([]);
    expect(orphanResults).toEqual([]);
  });

  it("同一 id 重复的单边：两个调用一个结果 → 一个配对 + 一个悬空（先来先配）", () => {
    const items: RolloutItem[] = [call(1, "dup"), call(2, "dup"), result(3, "dup")];
    const { pairs, danglingCalls } = pairToolCalls(items);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.callSeq).toBe(1);
    expect(danglingCalls.map((c) => c.seq)).toEqual([2]);
  });

  it("结果早于调用：按发生顺序判成孤立结果（不回头配对）", () => {
    const items: RolloutItem[] = [result(1, "t1"), call(2, "t1")];
    const { pairs, orphanResults, danglingCalls } = pairToolCalls(items);
    expect(pairs).toEqual([]);
    expect(orphanResults.map((r) => r.seq)).toEqual([1]);
    expect(danglingCalls.map((c) => c.seq)).toEqual([2]);
  });

  it("被拒的结果仍算配对成功（denied 与「没结果」是两件事）", () => {
    const { pairs } = pairToolCalls([call(1, "t1"), result(2, "t1", { ok: false, denied: true })]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({ ok: false, denied: true });
  });
});

describe("turnCompletion", () => {
  it("正常收尾：不算未完成", () => {
    const items: RolloutItem[] = [
      { type: "turn_start", seq: 0, at: at(0), conversationId: "c1", streamId: "s1", agentId: "a1", userText: "hi" },
      call(1, "t1"),
      result(2, "t1"),
      { type: "turn_end", seq: 3, at: at(3), streamId: "s1", status: "ok" },
    ];
    const completion = turnCompletion(items);
    expect(completion.incomplete).toBe(false);
    expect(completion).toMatchObject({ started: true, ended: true, status: "ok", stoppedAtSeq: null });
  });

  it("缺 turn_end：标未完成，并指出停在最后一条", () => {
    const completion = turnCompletion([call(1, "t1"), result(2, "t1")]);
    expect(completion.incomplete).toBe(true);
    expect(completion.reasons).toContain("missing_turn_end");
    expect(completion.reasons).toContain("no_turn_start");
    expect(completion.stoppedAtSeq).toBe(2);
  });

  it("有悬空调用：标未完成，停在悬空那一步", () => {
    const items: RolloutItem[] = [
      { type: "turn_start", seq: 0, at: at(0), conversationId: "c1", streamId: "s1", agentId: "a1", userText: "hi" },
      call(1, "t1"),
      result(2, "t1"),
      call(3, "t2"),
      { type: "turn_end", seq: 4, at: at(4), streamId: "s1", status: "aborted" },
    ];
    const completion = turnCompletion(items);
    expect(completion.incomplete).toBe(true);
    expect(completion.reasons).toEqual(["dangling_call"]);
    expect(completion.danglingCallIds).toEqual(["t2"]);
    expect(completion.stoppedAtSeq).toBe(3);
  });

  it("出错收尾：已收尾所以不算「未完成」，但状态是 error（展示层自会区分）", () => {
    const items: RolloutItem[] = [
      { type: "turn_start", seq: 0, at: at(0), conversationId: "c1", streamId: "s1", agentId: "a1", userText: "hi" },
      { type: "turn_end", seq: 1, at: at(1), streamId: "s1", status: "error", error: "挂了" },
    ];
    const completion = turnCompletion(items);
    expect(completion.incomplete).toBe(false);
    expect(completion).toMatchObject({ ended: true, status: "error" });
  });
});

describe("indexOfSeq", () => {
  it("按 seq 定位数组下标；找不到返回 -1", () => {
    const items: RolloutItem[] = [call(7, "a"), call(9, "b")];
    expect(indexOfSeq(items, 9)).toBe(1);
    expect(indexOfSeq(items, 8)).toBe(-1);
    expect(indexOfSeq(items, Number.NaN)).toBe(-1);
  });
});
