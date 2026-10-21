import { describe, it, expect, beforeEach, vi } from "vitest";
import { createHitlGate, toHitlBatch } from "./gate.js";
import { HitlPolicyStore, type HitlPolicy } from "./policy.js";
import type { HitlBatch, HitlCall, HitlVerdict } from "./types.js";

/** 内存存储：每个测试一份，互不干扰。 */
class FakeStorage {
  private readonly map = new Map<string, string>();
  getItem(k: string): string | null {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.map.set(k, v);
  }
  removeItem(k: string): void {
    this.map.delete(k);
  }
}

function makeCall(id: string, name: string, risk: HitlCall["risk"] = "write"): HitlCall {
  return {
    id,
    name,
    argsJson: "{}",
    displayName: name,
    risk,
    summary: "",
    source: "mcp",
  };
}

const readCall = makeCall("r1", "srv__get_file", "read");
const writeCall = makeCall("w1", "fs__write_file");

function batchOf(calls: HitlCall[], streamId = "s1") {
  return {
    streamId,
    conversationId: "c1",
    agentId: "a1",
    agentName: "架构师",
    calls,
  };
}

describe("HITL 闸门", () => {
  let storage: FakeStorage;
  let policy: HitlPolicyStore;
  beforeEach(() => {
    storage = new FakeStorage();
    policy = new HitlPolicyStore(storage);
  });

  it("guarded 档下 [read, write] 一批：只读自动放行，只有写操作问用户", async () => {
    const ask = vi.fn(async (_b: HitlBatch): Promise<HitlVerdict[]> => [
      { callId: "w1", decision: "allow" },
    ]);
    const gate = createHitlGate({ policy, ask });

    const outcomes = await gate.review(batchOf([readCall, writeCall]));

    expect(ask).toHaveBeenCalledTimes(1);
    const asked = ask.mock.calls[0][0] as HitlBatch;
    expect(asked.calls.map((c) => c.id)).toEqual(["w1"]);
    expect((asked.auto ?? []).map((c) => c.id)).toEqual(["r1"]);
    // 返回 2 个 outcome，顺序与输入一致
    expect(outcomes).toHaveLength(2);
    expect(outcomes[0].kind).toBe("allow");
    expect(outcomes[1].kind).toBe("allow");
  });

  it("用户拒绝 → 该项 deny，且理由透传", async () => {
    const ask = vi.fn(async (): Promise<HitlVerdict[]> => [
      { callId: "w1", decision: "deny", reason: "不放心" },
    ]);
    const gate = createHitlGate({ policy, ask });

    const outcomes = await gate.review(batchOf([writeCall]));

    expect(outcomes[0].kind).toBe("deny");
    expect(outcomes[0].kind === "deny" && outcomes[0].reason).toBe("不放心");
  });

  it("ask 抛错 → 全部按拒绝处理（闸门故障不得让危险操作静默执行）", async () => {
    const ask = vi.fn(async () => {
      throw new Error("UI 崩了");
    });
    const gate = createHitlGate({ policy, ask });

    const outcomes = await gate.review(batchOf([writeCall]));

    // ★ 「不得让整轮对话失败」= 模型总能收到一条 tool 消息，
    //   **不是「工具总能执行」**——工具不执行时模型照样收到「未执行」的消息。
    //
    // 兜底方向的选择比索引正确性更关键：兜底是 deny 时出错只会「误拒」
    //（用户立刻发现并报告）；兜底是 allow 时出错就是「误放行」，
    // **静默且不可见**。而 UI 恰恰是在这种「坏了」的时刻最不该让危险操作裸奔。
    expect(outcomes[0].kind).toBe("deny");
  });

  it("ask 返回的条数与待确认项不匹配 → 缺失项补齐为 deny（绝不执行未确认项）", async () => {
    const ask = vi.fn(async (): Promise<HitlVerdict[]> => []);
    const gate = createHitlGate({ policy, ask });

    const outcomes = await gate.review(batchOf([writeCall]));

    expect(outcomes[0].kind).toBe("deny");
    expect(outcomes[0].kind === "deny" && outcomes[0].reason).toBe("未收到确认结果");
  });

  it("ask 返回未知 callId → 视为未确认，补 deny", async () => {
    const ask = vi.fn(async (): Promise<HitlVerdict[]> => [
      { callId: "不存在的 id", decision: "allow" },
    ]);
    const gate = createHitlGate({ policy, ask });

    const outcomes = await gate.review(batchOf([writeCall]));

    expect(outcomes[0].kind).toBe("deny");
  });

  it("同一指纹被拒后再次调用：不再弹窗，直接 deny", async () => {
    const ask = vi.fn(async (): Promise<HitlVerdict[]> => [
      { callId: "w1", decision: "deny", reason: "不放心" },
    ]);
    const gate = createHitlGate({ policy, ask });

    const first = await gate.review(batchOf([writeCall]));
    const second = await gate.review(batchOf([writeCall]));

    expect(first[0].kind).toBe("deny");
    expect(second[0].kind).toBe("deny");
    expect(second[0].kind === "deny" && second[0].reason).toBe("本轮已拒绝过相同调用");
    expect(ask).toHaveBeenCalledTimes(1); // 第二次没再问
  });

  it("换一轮（streamId 变了）→ 去重表清空，同一调用会重新问", async () => {
    const ask = vi.fn(async (): Promise<HitlVerdict[]> => [
      { callId: "w1", decision: "deny" },
    ]);
    const gate = createHitlGate({ policy, ask });

    await gate.review(batchOf([writeCall], "s1"));
    await gate.review(batchOf([writeCall], "s2"));

    expect(ask).toHaveBeenCalledTimes(2);
  });

  it("allow-session → 记下会话授权，同一工具下次免问（trusted 档）", async () => {
    policy.set({ mode: "trusted", floor: "read", scope: "global" });
    const ask = vi.fn(async (): Promise<HitlVerdict[]> => [
      { callId: "w1", decision: "allow-session" },
    ]);
    const gate = createHitlGate({ policy, ask });

    const first = await gate.review(batchOf([writeCall]));
    expect(first[0].kind).toBe("allow");
    expect(policy.granted("a1", "fs__write_file", "global")).toBe(true);

    // 第二次同样的调用：策略层直接放行，不再问用户
    const second = await gate.review(batchOf([writeCall]));
    expect(second[0].kind).toBe("allow");
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it("严格档：只读项也要问（auto 放行的与待确认的不混在一起）", async () => {
    policy.set({ mode: "strict", floor: "read", scope: "global" });
    const ask = vi.fn(async (_b: HitlBatch): Promise<HitlVerdict[]> => [
      { callId: "r1", decision: "allow" },
      { callId: "w1", decision: "allow" },
    ]);
    const gate = createHitlGate({ policy, ask });

    await gate.review(batchOf([readCall, writeCall]));

    const asked = ask.mock.calls[0][0] as HitlBatch;
    expect(asked.calls.map((c) => c.id)).toEqual(["r1", "w1"]);
    expect(asked.auto ?? []).toEqual([]);
  });

  it("没有待确认项时根本不问 UI", async () => {
    const ask = vi.fn(async (): Promise<HitlVerdict[]> => []);
    const gate = createHitlGate({ policy, ask });

    const outcomes = await gate.review(batchOf([readCall]));

    expect(ask).not.toHaveBeenCalled();
    expect(outcomes[0].kind).toBe("allow");
  });
});

describe("toHitlBatch", () => {
  it("把模型的 tool_call 转成分类好的批次", () => {
    const batch = toHitlBatch(
      [{ id: "call_1", function: { name: "srv__get_file", arguments: '{"path":"a.md"}' } }],
      { agentId: "a1", agentName: "架构师", streamId: "s1", conversationId: "c1" },
    );
    expect(batch.calls[0].id).toBe("call_1");
    expect(batch.calls[0].risk).toBe("read");
    expect(batch.calls[0].summary).toBe("a.md");
    expect(batch.streamId).toBe("s1");
  });

  it("桥给的 meta 覆盖名字启发", () => {
    const batch = toHitlBatch(
      [{ id: "call_1", function: { name: "fs__delete_file", arguments: "{}" } }],
      { agentId: "a1", agentName: "架构师", streamId: "s1", conversationId: "c1" },
      () => ({ risk: "read", displayName: "自定义动作" }),
    );
    expect(batch.calls[0].risk).toBe("read");
    expect(batch.calls[0].displayName).toBe("自定义动作");
  });
});
