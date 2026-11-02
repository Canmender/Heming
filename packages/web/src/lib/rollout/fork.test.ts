import { describe, expect, it } from "vitest";
import {
  FORK_PREFIX_NOTICE,
  FORK_TRUNCATED_NOTICE,
  buildForkPrefix,
  checkFork,
  forkNoticeLines,
  looksTruncated,
  previewFork,
} from "./fork.js";
import { buildRequest, type ChatMessage } from "../llmClient.js";
import { toAnthropicMessages } from "../llmAnthropic.js";
import { MAX_TEXT_CHARS } from "./log.js";
import type { RolloutItem } from "./types.js";

/**
 * 分叉逻辑：前置条件（缺一不可）、代价预览、前缀重建。
 *
 * 三条验收口径都写死在这里：
 * 1. 判定与回放标注同源（都走 pairToolCalls）；
 * 2. 重建出来的前缀必须是**合法请求形状**（tool_calls 与 tool 消息等长同序）；
 * 3. 文案必须诚实说明「前缀是重建的、可能被截断」，不能暗示无损续跑。
 */

const at = (s: number) => `2026-11-02T09:00:${String(s).padStart(2, "0")}.000Z`;

function turnStart(seq = 0, userText = "整理依赖"): RolloutItem {
  return {
    type: "turn_start",
    seq,
    at: at(seq),
    conversationId: "c1",
    streamId: "s1",
    agentId: "a1",
    userText,
  };
}

function call(seq: number, id: string, name = "srv__read", args = '{"path":"a.md"}'): RolloutItem {
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
    name: opts.name ?? "srv__read",
    ok: opts.ok ?? true,
    ...(opts.denied ? { denied: true } : {}),
    text: opts.text ?? "内容",
  };
}

function end(seq: number, status: "ok" | "aborted" | "error" = "ok"): RolloutItem {
  return { type: "turn_end", seq, at: at(seq), streamId: "s1", status };
}

/** 一次健康回合：读文件 → 读第二个文件 → 收尾。第二条结果 seq = 4。 */
function healthyTurn(): RolloutItem[] {
  return [
    turnStart(),
    call(1, "t1", "srv__read"),
    result(2, "t1", { name: "srv__read", text: "a.md 内容" }),
    call(3, "t2", "srv__grep"),
    result(4, "t2", { name: "srv__grep", text: "命中 3 处" }),
    end(5),
  ];
}

describe("checkFork 前置条件", () => {
  it("健康回合：从第二条工具结果之后可以分叉", () => {
    const check = checkFork(healthyTurn(), { targetSeq: 4, version: 2 });
    expect(check.ok).toBe(true);
    expect(check.rejections).toEqual([]);
    expect(check.target?.seq).toBe(4);
  });

  it("目标之后有 assistant_final：拒绝（已给出答案的回合，重跑更直接）", () => {
    const items = [...healthyTurn().slice(0, 5), { type: "assistant_final", seq: 5, at: at(5), streamId: "s1", text: "完成" } as RolloutItem, end(6)];
    const check = checkFork(items, { targetSeq: 4, version: 2 });
    expect(check.ok).toBe(false);
    expect(check.rejections.map((r) => r.code)).toContain("assistant_final_after");
  });

  it("前缀里有悬空调用：拒绝（不能拿半截现场当依据）", () => {
    const items: RolloutItem[] = [turnStart(), call(1, "t1"), result(2, "t1"), call(3, "t2"), result(4, "t2")];
    // 再追加一个悬空调用后从最后一条结果分叉：前缀里 t3 没有结果
    const withDangling = [...items.slice(0, 5), call(5, "t3"), result(6, "t4"), end(7)];
    const check = checkFork(withDangling, { targetSeq: 6, version: 2 });
    expect(check.ok).toBe(false);
    expect(check.rejections.map((r) => r.code)).toContain("dangling_call");
  });

  it("前缀里含 denied：拒绝（被拒 = 没执行，续跑会让模型以为执行过）", () => {
    const items: RolloutItem[] = [
      turnStart(),
      call(1, "t1"),
      result(2, "t1", { ok: false, denied: true, text: "未执行" }),
      end(3),
    ];
    const check = checkFork(items, { targetSeq: 2, version: 2 });
    expect(check.ok).toBe(false);
    expect(check.rejections.map((r) => r.code)).toContain("denied_call");
  });

  it("v1 日志：拒绝并说明原因（没有序号，定位不了分叉点）", () => {
    const check = checkFork(healthyTurn(), { targetSeq: 4, version: 1 });
    expect(check.ok).toBe(false);
    expect(check.rejections.map((r) => r.code)).toContain("legacy_version");
    expect(check.rejections[0]!.message).toContain("重跑");
  });

  it("未来版本：拒绝且不猜结构", () => {
    const check = checkFork(healthyTurn(), { targetSeq: 4, version: 3 });
    expect(check.ok).toBe(false);
    expect(check.rejections.map((r) => r.code)).toContain("unknown_version");
  });

  it("任务仍在运行：拒绝", () => {
    const check = checkFork(healthyTurn(), { targetSeq: 4, version: 2, running: true });
    expect(check.ok).toBe(false);
    expect(check.rejections.map((r) => r.code)).toContain("running");
  });

  it("目标不是 tool_result：拒绝", () => {
    const check = checkFork(healthyTurn(), { targetSeq: 3, version: 2 });
    expect(check.ok).toBe(false);
    expect(check.rejections.map((r) => r.code)).toContain("target_not_tool_result");
  });

  it("崩溃回合（缺 turn_end）：默认拒绝，显式确认后放行", () => {
    const crashed = healthyTurn().slice(0, 5);
    const denied = checkFork(crashed, { targetSeq: 4, version: 2 });
    expect(denied.ok).toBe(false);
    expect(denied.rejections.map((r) => r.code)).toContain("missing_turn_end");

    const allowed = checkFork(crashed, { targetSeq: 4, version: 2, allowCrashed: true });
    expect(allowed.ok).toBe(true);
  });

  it("出错收尾：默认拒绝，显式确认后放行", () => {
    const errored = [...healthyTurn().slice(0, 5), end(5, "error")];
    expect(checkFork(errored, { targetSeq: 4, version: 2 }).rejections.map((r) => r.code)).toContain(
      "turn_error",
    );
    expect(checkFork(errored, { targetSeq: 4, version: 2, allowCrashed: true }).ok).toBe(true);
  });

  it("一次给全部原因：不逐条挤牙膏（界面一次说清为什么不能分叉）", () => {
    const items: RolloutItem[] = [turnStart(), call(1, "t1"), end(2, "error")];
    const check = checkFork(items, { targetSeq: 1, version: 1, running: true });
    expect(check.ok).toBe(false);
    expect(check.rejections.length).toBeGreaterThanOrEqual(4);
  });
});

describe("previewFork 代价预览（P3）", () => {
  it("复用目标及其之前的配对，丢弃目标之后的内容（含收尾记录）", () => {
    const preview = previewFork(healthyTurn(), 4);
    expect(preview.reuse.map((p) => p.id)).toEqual(["t1", "t2"]);
    expect(preview.discard.map((it) => it.type)).toEqual(["turn_end"]);
    expect(preview.danglingInPrefix).toEqual([]);
    expect(preview.deniedInPrefix).toEqual([]);
    expect(preview.truncatedResults).toBe(0);
  });

  it("从中途分叉：后面的步骤进「将丢弃」", () => {
    const preview = previewFork(healthyTurn(), 2);
    expect(preview.reuse.map((p) => p.id)).toEqual(["t1"]);
    expect(preview.discard.map((it) => it.seq)).toEqual([3, 4, 5]);
  });

  it("被截断的结果会被数出来（确认文案据此升级）", () => {
    const items: RolloutItem[] = [
      turnStart(),
      call(1, "t1"),
      result(2, "t1", { text: `${"字".repeat(MAX_TEXT_CHARS)}…` }),
      end(3),
    ];
    expect(looksTruncated(`${"字".repeat(MAX_TEXT_CHARS)}…`)).toBe(true);
    expect(looksTruncated("短结果")).toBe(false);
    expect(previewFork(items, 2).truncatedResults).toBe(1);
  });
});

describe("buildForkPrefix 前缀重建", () => {
  it("连续调用合成一条 assistant，跟等长同序的 tool 消息", () => {
    const items: RolloutItem[] = [
      turnStart(),
      call(1, "t1", "srv__a", '{"a":1}'),
      call(2, "t2", "srv__b", '{"b":2}'),
      result(3, "t1", { name: "srv__a", text: "A" }),
      result(4, "t2", { name: "srv__b", text: "B" }),
      end(5),
    ];
    const prefix = buildForkPrefix(items, 4);
    expect(prefix.messages).toHaveLength(3);
    const [assistant, firstTool, secondTool] = prefix.messages as ChatMessage[];
    expect(assistant!.role).toBe("assistant");
    expect(assistant!.tool_calls?.map((c) => c.id)).toEqual(["t1", "t2"]);
    expect(firstTool).toMatchObject({ role: "tool", tool_call_id: "t1", content: "A" });
    expect(secondTool).toMatchObject({ role: "tool", tool_call_id: "t2", content: "B" });
    expect(prefix.reusedPairs).toBe(2);
    expect(prefix.skipped).toEqual([]);
  });

  it("合法请求形状：喂给既有请求构造函数不抛，且 tool_calls 与 tool 消息等长同序", () => {
    const prefix = buildForkPrefix(healthyTurn(), 4);
    const toolCalls = prefix.messages.flatMap((m) => m.tool_calls ?? []);
    const toolMessages = prefix.messages.filter((m) => m.role === "tool");
    expect(toolCalls).toHaveLength(toolMessages.length);
    expect(toolMessages.map((m) => m.tool_call_id)).toEqual(toolCalls.map((c) => c.id));

    // 既有构造函数的验收：Anthropic 分支不会丢弃任何 tool_use（丢弃说明前缀不合法）。
    const { messages } = toAnthropicMessages(prefix.messages);
    const toolUseIds: string[] = [];
    const toolResultIds: string[] = [];
    for (const message of messages) {
      for (const block of message.content) {
        if (block.type === "tool_use") toolUseIds.push(block.id);
        if (block.type === "tool_result") toolResultIds.push(block.tool_use_id);
      }
    }
    expect(toolUseIds).toEqual(["t1", "t2"]);
    expect(toolResultIds).toEqual(["t1", "t2"]);

    // OpenAI 形状的构造函数同样不能抛（这里是「能拼出请求」而非「能连通」）。
    const built = buildRequest(
      {
        id: "p1",
        label: "测试",
        provider: "anthropic",
        baseUrl: "https://example.com",
        apiKey: "sk-test",
        model: "claude-test",
      } as never,
      prefix.messages,
      { stream: false, tools: [] },
    );
    expect(() => JSON.parse(built.body)).not.toThrow();
  });

  it("参数被截断（非法 JSON）的调用整条跳过，不留孤儿 tool 消息", () => {
    const items: RolloutItem[] = [
      turnStart(),
      call(1, "t1", "srv__a", '{"path":"a.md"'),
      result(2, "t1", { name: "srv__a", text: "A" }),
      call(3, "t2", "srv__b", '{"b":2}'),
      result(4, "t2", { name: "srv__b", text: "B" }),
      end(5),
    ];
    const prefix = buildForkPrefix(items, 4);
    expect(prefix.skipped).toEqual([{ id: "t1", name: "srv__a", reason: "args_invalid" }]);
    const toolCalls = prefix.messages.flatMap((m) => m.tool_calls ?? []);
    const toolMessages = prefix.messages.filter((m) => m.role === "tool");
    expect(toolCalls.map((c) => c.id)).toEqual(["t2"]);
    expect(toolMessages.map((m) => m.tool_call_id)).toEqual(["t2"]);
  });

  it("悬空调用不会进入前缀（前置条件之外的兜底）", () => {
    // 目标 seq=4：它之前有一个没有结果的 t2，重建时整条跳过而不是留下孤儿 tool_calls
    const items: RolloutItem[] = [turnStart(), call(1, "t1"), result(2, "t1"), call(3, "t2"), result(4, "t3"), end(5)];
    const prefix = buildForkPrefix(items, 4);
    expect(prefix.skipped).toEqual([{ id: "t2", name: "srv__read", reason: "dangling" }]);
    expect(prefix.reusedPairs).toBe(1);
  });

  it("被截断的结果计数：>0 时文案要升级", () => {
    const items: RolloutItem[] = [
      turnStart(),
      call(1, "t1"),
      result(2, "t1", { text: `${"字".repeat(MAX_TEXT_CHARS)}…` }),
      end(3),
    ];
    expect(buildForkPrefix(items, 2).truncatedResults).toBe(1);
  });
});

describe("分叉文案（诚实提示）", () => {
  it("必须写明「重建 + 截断」，且不出现暗示无损续跑的说法", () => {
    const lines = forkNoticeLines(0);
    const text = lines.join("");
    expect(text).toContain(FORK_PREFIX_NOTICE);
    expect(text).toContain("写操作");
    expect(text).toContain("不会回滚");
    expect(text).not.toContain("从第 3 步继续");
    expect(text).not.toContain("接着上次");
  });

  it("前缀有被截断的结果时，追加「结果不完整」提示", () => {
    const text = forkNoticeLines(2).join("");
    expect(text).toContain("2 条工具");
    expect(text).toContain(FORK_TRUNCATED_NOTICE);
  });
});
