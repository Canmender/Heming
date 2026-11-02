import { describe, expect, it } from "vitest";
import { buildForkTaskPlan, resolveForkRun } from "./forkTask.js";
import type { TaskRecord } from "./store.js";
import type { RolloutItem } from "../rollout/types.js";
import { MAX_TEXT_CHARS } from "../rollout/log.js";

/**
 * 分叉落地的纯逻辑：能不能分叉、新建什么任务、带什么前缀、该说什么话。
 * 这里把「原任务不动」也钉死——分叉是新建任务，不是原地修改。
 */

const at = (s: number) => `2026-11-02T09:00:${String(s).padStart(2, "0")}.000Z`;

function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: "t1",
    conversationId: "c1",
    agentId: "a1",
    agentName: "和小鸣",
    title: "整理依赖",
    prompt: "整理 packages/web 的模块依赖",
    status: "cancelled",
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    streamId: "s1",
    steps: [],
    ...overrides,
  };
}

function items(overrides: { turnEnd?: "ok" | "aborted" | "error" | null; final?: boolean; truncated?: boolean } = {}): RolloutItem[] {
  const list: RolloutItem[] = [
    { type: "turn_start", seq: 0, at: at(0), conversationId: "c1", streamId: "s1", agentId: "a1", userText: "整理依赖" },
    { type: "tool_call", seq: 1, at: at(1), streamId: "s1", id: "t1", name: "srv__read", args: '{"path":"a.md"}' },
    { type: "tool_result", seq: 2, at: at(2), streamId: "s1", id: "t1", name: "srv__read", ok: true, text: "a.md 内容" },
    { type: "tool_call", seq: 3, at: at(3), streamId: "s1", id: "t2", name: "srv__grep", args: '{"q":"import"}' },
    {
      type: "tool_result",
      seq: 4,
      at: at(4),
      streamId: "s1",
      id: "t2",
      name: "srv__grep",
      ok: true,
      text: overrides.truncated ? `${"字".repeat(MAX_TEXT_CHARS)}…` : "命中 3 处",
    },
  ];
  if (overrides.final) {
    list.push({ type: "assistant_final", seq: 5, at: at(5), streamId: "s1", text: "完成" });
  }
  if (overrides.turnEnd !== null) {
    list.push({
      type: "turn_end",
      seq: 6,
      at: at(6),
      streamId: "s1",
      status: overrides.turnEnd ?? "aborted",
    });
  }
  return list;
}

describe("buildForkTaskPlan 通过", () => {
  it("继承目标/智能体/会话，forkedFrom 指向原 streamId+seq，前缀为重建成对的消息", () => {
    const origin = task();
    const snapshot = JSON.stringify(origin);
    const result = buildForkTaskPlan(origin, items(), { targetSeq: 4, version: 2 });

    expect(result.ok).toBe(true);
    expect(result.rejections).toEqual([]);
    const plan = result.plan!;
    expect(plan).toMatchObject({
      conversationId: "c1",
      agentId: "a1",
      agentName: "和小鸣",
      prompt: "整理 packages/web 的模块依赖",
      forkedFrom: { streamId: "s1", seq: 4 },
      mentions: [{ agentId: "a1", name: "和小鸣" }],
    });
    // 前缀形状：assistant(tool_calls) + 等长 tool 消息
    const toolCalls = plan.forkPrefix.flatMap((m) => m.tool_calls ?? []);
    const toolMessages = plan.forkPrefix.filter((m) => m.role === "tool");
    expect(toolCalls.map((c) => c.id)).toEqual(["t1", "t2"]);
    expect(toolMessages.map((m) => m.tool_call_id)).toEqual(["t1", "t2"]);
    // 没有截断时不落 truncatedResults 噪音
    expect(plan.forkedFrom).not.toHaveProperty("truncatedResults");
    // 纯函数：原任务一个字都没变（分叉是新建任务，不是原地改）
    expect(JSON.stringify(origin)).toBe(snapshot);
  });

  it("确认文案：含写操作提示与「前缀由日志重建」", () => {
    const result = buildForkTaskPlan(task(), items(), { targetSeq: 4, version: 2 });
    const text = result.plan!.notices.join("");
    expect(text).toContain("写操作");
    expect(text).toContain("不会回滚");
    expect(text).toContain("前缀由本机日志重建");
    expect(text).toContain("超过 2000 字符的工具结果已被截断");
  });

  it("前缀有被截断的结果：truncatedResults 落盘，文案升级「结果不完整」", () => {
    const result = buildForkTaskPlan(task(), items({ truncated: true }), { targetSeq: 4, version: 2 });
    expect(result.plan!.forkedFrom.truncatedResults).toBe(1);
    expect(result.plan!.notices.join("")).toContain("结果不完整，后续可能需要重新读取");
  });

  it("P3 预览一并给出：复用哪些、丢弃哪些", () => {
    const result = buildForkTaskPlan(task(), items(), { targetSeq: 2, version: 2 });
    expect(result.preview?.reuse.map((p) => p.id)).toEqual(["t1"]);
    expect(result.preview?.discard.map((it) => it.seq)).toEqual([3, 4, 6]);
  });
});

describe("buildForkTaskPlan 拒绝", () => {
  it("任务没有绑定日志：拒绝并说明", () => {
    const result = buildForkTaskPlan(task({ streamId: undefined }), items(), { targetSeq: 4, version: 2 });
    expect(result.ok).toBe(false);
    expect(result.rejections.map((r) => r.code)).toContain("task_without_stream");
    expect(result.plan).toBeNull();
  });

  it("任务仍在运行：拒绝（前缀还不稳定）", () => {
    const result = buildForkTaskPlan(task({ status: "running" }), items(), { targetSeq: 4, version: 2 });
    expect(result.ok).toBe(false);
    expect(result.rejections.map((r) => r.code)).toContain("running");
  });

  it("有最终答案：拒绝并提示改用重跑", () => {
    const result = buildForkTaskPlan(task({ status: "done" }), items({ final: true, turnEnd: "ok" }), {
      targetSeq: 4,
      version: 2,
    });
    expect(result.ok).toBe(false);
    expect(result.rejections.map((r) => r.code)).toContain("assistant_final_after");
  });

  it("v1 日志：拒绝（没有真序号），但仍给出预览", () => {
    const result = buildForkTaskPlan(task(), items(), { targetSeq: 4, version: 1 });
    expect(result.ok).toBe(false);
    expect(result.rejections.map((r) => r.code)).toContain("legacy_version");
    expect(result.preview?.reuse).toHaveLength(2);
  });

  it("崩溃回合：要显式确认才放行", () => {
    const crashed = items({ turnEnd: null });
    expect(buildForkTaskPlan(task(), crashed, { targetSeq: 4, version: 2 }).ok).toBe(false);
    const allowed = buildForkTaskPlan(task(), crashed, { targetSeq: 4, version: 2, allowCrashed: true });
    expect(allowed.ok).toBe(true);
  });

  it("含 denied 的前缀：拒绝", () => {
    const denied: RolloutItem[] = [
      ...items().slice(0, 4),
      { type: "tool_result", seq: 4, at: at(4), streamId: "s1", id: "t2", name: "srv__write", ok: false, denied: true, text: "未执行" },
      { type: "turn_end", seq: 5, at: at(5), streamId: "s1", status: "aborted" },
    ];
    const result = buildForkTaskPlan(task(), denied, { targetSeq: 4, version: 2 });
    expect(result.ok).toBe(false);
    expect(result.rejections.map((r) => r.code)).toContain("denied_call");
  });

  it("参数被截断（非法 JSON）：前缀重建不出来，拒绝而不是拼个坏请求", () => {
    const brokenArgs: RolloutItem[] = [
      { type: "turn_start", seq: 0, at: at(0), conversationId: "c1", streamId: "s1", agentId: "a1", userText: "x" },
      { type: "tool_call", seq: 1, at: at(1), streamId: "s1", id: "t1", name: "srv__read", args: '{"path":"a.md"' },
      { type: "tool_result", seq: 2, at: at(2), streamId: "s1", id: "t1", name: "srv__read", ok: true, text: "内容" },
      { type: "turn_end", seq: 3, at: at(3), streamId: "s1", status: "aborted" },
    ];
    const result = buildForkTaskPlan(task(), brokenArgs, { targetSeq: 2, version: 2 });
    expect(result.ok).toBe(false);
    expect(result.rejections.map((r) => r.code)).toContain("prefix_invalid");
    expect(result.rejections[0]!.message).toContain("参数被截断");
  });
});

describe("resolveForkRun 运行期前缀解析与降级", () => {
  const forkedTask = () =>
    task({ forkedFrom: { streamId: "src", seq: 4, truncatedResults: 1 } });

  it("来源 v2 日志可重建：给出前缀，不降级、不提示", () => {
    const run = resolveForkRun(forkedTask(), { version: 2, items: items() });
    expect(run.degraded).toBeUndefined();
    expect(run.notice).toBeUndefined();
    expect(run.forkedFrom).toEqual({ streamId: "src", seq: 4 });
    const toolCalls = (run.forkPrefix ?? []).flatMap((m) => m.tool_calls ?? []);
    const toolMessages = (run.forkPrefix ?? []).filter((m) => m.role === "tool");
    expect(toolCalls.map((c) => c.id)).toEqual(["t1", "t2"]);
    expect(toolMessages.map((m) => m.tool_call_id)).toEqual(["t1", "t2"]);
  });

  it("普通任务（不是分叉）什么都不给：不读日志、不提示", () => {
    expect(resolveForkRun(task(), { version: 2, items: items() })).toEqual({});
    expect(resolveForkRun(undefined, null)).toEqual({});
  });

  it("降级：来源日志读不到 → 按普通重跑执行并说明原因", () => {
    const run = resolveForkRun(forkedTask(), null);
    expect(run.degraded).toBe("log_unreadable");
    expect(run.forkPrefix).toBeUndefined();
    expect(run.forkedFrom).toEqual({ streamId: "src", seq: 4 });
    expect(run.notice).toContain("本次按普通重跑执行");
  });

  it("降级：来源是 v1 日志（没有序号）→ 不伪造前缀", () => {
    const run = resolveForkRun(forkedTask(), { version: 1, items: items() });
    expect(run.degraded).toBe("legacy_version");
    expect(run.forkPrefix).toBeUndefined();
    expect(run.notice).toContain("旧版本日志");
    expect(run.notice).toContain("普通重跑");
  });

  it("降级：前缀重建失败（参数截断）→ 不拼坏请求，但仍保留来源", () => {
    const broken: RolloutItem[] = [
      { type: "turn_start", seq: 0, at: at(0), conversationId: "c1", streamId: "s1", agentId: "a1", userText: "x" },
      { type: "tool_call", seq: 1, at: at(1), streamId: "s1", id: "t1", name: "srv__read", args: '{"broken' },
      { type: "tool_result", seq: 2, at: at(2), streamId: "s1", id: "t1", name: "srv__read", ok: true, text: "内容" },
      { type: "turn_end", seq: 3, at: at(3), streamId: "s1", status: "aborted" },
    ];
    const run = resolveForkRun({ ...forkedTask(), forkedFrom: { streamId: "src", seq: 2 } }, {
      version: 2,
      items: broken,
    });
    expect(run.degraded).toBe("prefix_invalid");
    expect(run.forkPrefix).toBeUndefined();
    expect(run.forkedFrom).toEqual({ streamId: "src", seq: 2 });
    expect(run.notice).toContain("普通重跑");
  });
});
