import { describe, it, expect, beforeEach, vi } from "vitest";
import { createHitlGate, toHitlBatch } from "./gate.js";
import { HitlPolicyStore, type HitlPolicy } from "./policy.js";
import type { HitlBatch, HitlCall, HitlMode, HitlVerdict, RiskLevel } from "./types.js";

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
const dangerCall = makeCall("d1", "fs__delete_file", "danger");

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

  it("任何策略组合下危险操作都进确认队列（不被免问）", async () => {
    // ★ 这是「没有全部放行档」这条红线在**闸门层**的护栏。
    // 免问下限最高只能取到 write（danger 严格高于 write），
    // 所以哪怕用户把下限调到最宽、哪怕档位是 trusted，危险操作也必须弹窗。
    //
    // ★ 矩阵里**故意带上 "danger"**：它已经不是合法的下限值，
    // 但把它喂进去正是这条护栏的用处——
    // 如果有人把 `danger` 重新加回 `FLOORS`，`policy.set` 就会原样存下它，
    // 判定式「风险不高于下限 ⇒ 免问」随即对 danger 恒真 ⇒ 危险操作被静默放行，
    // 这条用例会当场失败。
    const modes: HitlMode[] = ["strict", "guarded", "trusted"];
    const floors: RiskLevel[] = ["read", "write", "danger"];

    for (const mode of modes) {
      for (const floor of floors) {
        policy.set({ mode, floor, scope: "global" });
        // mock 带上 batch 参数（与 `ask` 的签名一致），
        // 这样 `mock.calls[0][0]` 的类型才是 `HitlBatch` 而不是 `undefined`。
        const ask = vi.fn(async (_b: HitlBatch): Promise<HitlVerdict[]> => [
          { callId: "d1", decision: "allow" },
        ]);
        const gate = createHitlGate({ policy, ask });

        await gate.review(batchOf([dangerCall]));

        expect(ask, `${mode} + floor=${floor} 应当问用户`).toHaveBeenCalledTimes(1);
        const asked = ask.mock.calls[0][0] as HitlBatch;
        expect(asked.calls.map((c) => c.id)).toEqual(["d1"]);
        // 危险项绝不能出现在「已自动放行」里
        expect(asked.auto ?? []).toEqual([]);
      }
    }
  });
});

describe("HITL 闸门：记住的规则", () => {
  let policy: HitlPolicyStore;
  const callAt = (id: string, name: string, path: string, risk: HitlCall["risk"] = "write"): HitlCall => ({
    ...makeCall(id, name, risk),
    argsJson: JSON.stringify({ path }),
  });

  beforeEach(() => {
    policy = new HitlPolicyStore(new FakeStorage());
  });

  it("命中允许规则：不弹窗，直接放行", async () => {
    const call = callAt("w1", "fs__write_file", "notes/a.md");
    policy.rememberRule(call.name, "notes/a.md", "allow");
    const ask = vi.fn(async (): Promise<HitlVerdict[]> => []);
    const gate = createHitlGate({ policy, ask });

    const outcomes = await gate.review(batchOf([call]));

    expect(ask).not.toHaveBeenCalled();
    expect(outcomes[0].kind).toBe("allow");
  });

  it("命中拒绝规则：不弹窗，直接拒绝且 cause=rule", async () => {
    const call = callAt("w1", "fs__write_file", "notes/a.md");
    policy.rememberRule(call.name, "notes/a.md", "deny");
    const ask = vi.fn(async (): Promise<HitlVerdict[]> => []);
    const gate = createHitlGate({ policy, ask });

    const outcomes = await gate.review(batchOf([call]));

    expect(ask).not.toHaveBeenCalled();
    expect(outcomes[0].kind).toBe("deny");
    expect(outcomes[0].kind === "deny" && outcomes[0].cause).toBe("rule");
  });

  it("裁决带 remember：允许/拒绝都落成规则，下次同资源不再问", async () => {
    const allowCall = callAt("w1", "fs__write_file", "notes/a.md");
    const denyCall = callAt("w2", "fs__write_file", "notes/b.md");
    const ask = vi.fn(async (): Promise<HitlVerdict[]> => [
      { callId: "w1", decision: "allow", remember: true },
      { callId: "w2", decision: "deny", reason: "别动这个", remember: true },
    ]);
    const gate = createHitlGate({ policy, ask });

    await gate.review(batchOf([allowCall, denyCall], "s1"));
    expect(policy.ruleFor(allowCall, "a1")).toBe("allow");
    expect(policy.ruleFor(denyCall, "a1")).toBe("deny");

    const again = await gate.review(batchOf([allowCall, denyCall], "s2"));
    expect(again.map((o) => o.kind)).toEqual(["allow", "deny"]);
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it("记住的规则只作用于当前智能体：换个智能体仍会问", async () => {
    const call = callAt("w1", "fs__write_file", "notes/a.md");
    const ask = vi.fn(async (): Promise<HitlVerdict[]> => [
      { callId: "w1", decision: "allow", remember: true },
    ]);
    const gate = createHitlGate({ policy, ask });

    await gate.review(batchOf([call], "s1"));
    const rule = policy.rules()[0];
    expect(rule).toMatchObject({ agentId: "a1", agentName: "架构师" });
    expect(policy.ruleFor(call, "a1")).toBe("allow");
    expect(policy.ruleFor(call, "a2")).toBeNull();

    // 另一个智能体（a2）不受这条规则影响，仍要弹窗
    const otherBatch = { ...batchOf([call], "s2"), agentId: "a2", agentName: "写手" };
    await gate.review(otherBatch);
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it("危险操作即使勾了记住允许，也不落规则（下次仍问）", async () => {
    const danger = callAt("d1", "fs__delete_file", "C:/data/a.txt", "danger");
    const ask = vi.fn(async (): Promise<HitlVerdict[]> => [
      { callId: "d1", decision: "allow", remember: true },
    ]);
    const gate = createHitlGate({ policy, ask });

    const first = await gate.review(batchOf([danger], "s1"));
    expect(first[0].kind).toBe("allow");
    expect(policy.rules()).toEqual([]);

    await gate.review(batchOf([danger], "s2"));
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it("闸门异常补的 deny 标记 cause=gate（不能被说成用户拒绝）", async () => {
    const ask = vi.fn(async () => {
      throw new Error("UI 崩了");
    });
    const gate = createHitlGate({ policy, ask });

    const outcomes = await gate.review(batchOf([writeCall]));
    expect(outcomes[0].kind).toBe("deny");
    expect(outcomes[0].kind === "deny" && outcomes[0].cause).toBe("gate");
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
