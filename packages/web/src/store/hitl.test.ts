import { describe, it, expect, beforeEach } from "vitest";
import { useHitlStore } from "./hitl.js";
import type { HitlCall } from "../lib/hitl/types.js";

function makeCall(id: string, name = "fs__write_file"): HitlCall {
  return {
    id,
    name,
    argsJson: "{}",
    displayName: "写文件",
    risk: "write",
    summary: "a.md",
    source: "mcp",
  };
}

const ctx = { agentId: "a1", conversationId: "c1", streamId: "s1", agentName: "架构师" };

describe("HITL 待确认 store", () => {
  beforeEach(() => {
    useHitlStore.getState().cancelAll("测试清理");
  });

  it("enqueue 后 pending 出现，带上归属上下文", async () => {
    const p = useHitlStore.getState().enqueue({ kind: "tool-call", payload: [makeCall("c1")] }, ctx);

    const pending = useHitlStore.getState().pending;
    expect(pending).not.toBeNull();
    expect(pending?.kind).toBe("tool-call");
    expect(pending?.calls.map((c) => c.id)).toEqual(["c1"]);
    expect(pending?.agentId).toBe("a1");
    expect(pending?.streamId).toBe("s1");

    useHitlStore.getState().decide({ requestId: pending!.requestId, verdicts: [] });
    await p;
  });

  it("decide 把裁决回传给等待者", async () => {
    const p = useHitlStore.getState().enqueue({ kind: "tool-call", payload: [makeCall("c1")] }, ctx);
    const requestId = useHitlStore.getState().pending!.requestId;

    useHitlStore.getState().decide({
      requestId,
      verdicts: [{ callId: "c1", decision: "allow" }],
    });

    await expect(p).resolves.toEqual([{ callId: "c1", decision: "allow" }]);
    expect(useHitlStore.getState().pending).toBeNull();
  });

  it("decide 用错 requestId → 忽略（不能 resolve 别人的等待者）", async () => {
    const p = useHitlStore.getState().enqueue({ kind: "tool-call", payload: [makeCall("c1")] }, ctx);

    useHitlStore.getState().decide({
      requestId: "不存在的 requestId",
      verdicts: [{ callId: "c1", decision: "allow" }],
    });

    // 等待者仍在挂起（没被错误地 resolve）
    expect(useHitlStore.getState().pending).not.toBeNull();

    const requestId = useHitlStore.getState().pending!.requestId;
    useHitlStore.getState().decide({ requestId, verdicts: [] });
    await p;
  });

  it("并发两次 enqueue：单槽 + 队列化（第二个等第一个决定完再弹）", async () => {
    const first = useHitlStore.getState().enqueue({ kind: "tool-call", payload: [makeCall("c1")] }, ctx);
    const second = useHitlStore.getState().enqueue({ kind: "tool-call", payload: [makeCall("c2")] }, ctx);

    // 同时只有一个 pending
    expect(useHitlStore.getState().pending?.calls.map((c) => c.id)).toEqual(["c1"]);

    const firstId = useHitlStore.getState().pending!.requestId;
    useHitlStore.getState().decide({
      requestId: firstId,
      verdicts: [{ callId: "c1", decision: "allow" }],
    });
    await expect(first).resolves.toEqual([{ callId: "c1", decision: "allow" }]);

    // 第一个决定完，第二个成为新的 pending
    await Promise.resolve();
    expect(useHitlStore.getState().pending?.calls.map((c) => c.id)).toEqual(["c2"]);

    const secondId = useHitlStore.getState().pending!.requestId;
    useHitlStore.getState().decide({
      requestId: secondId,
      verdicts: [{ callId: "c2", decision: "deny" }],
    });
    await expect(second).resolves.toEqual([{ callId: "c2", decision: "deny" }]);
  });

  it("cancelAll：所有等待者按拒绝收口（用户按了停止 = 别执行）", async () => {
    const first = useHitlStore.getState().enqueue({ kind: "tool-call", payload: [makeCall("c1")] }, ctx);
    const second = useHitlStore.getState().enqueue({ kind: "tool-call", payload: [makeCall("c2")] }, ctx);

    useHitlStore.getState().cancelAll("用户中断");

    // 空裁决 = 什么都没被允许 → 闸门按「未收到确认结果」全部拒绝
    await expect(first).resolves.toEqual([]);
    await expect(second).resolves.toEqual([]);
    expect(useHitlStore.getState().pending).toBeNull();
  });

  it("自动放行的只读项与待确认项分开（UI 不能把要问的藏起来）", async () => {
    const p = useHitlStore.getState().enqueue(
      {
        kind: "tool-call",
        payload: [makeCall("c1")],
        auto: [{ ...makeCall("r1"), risk: "read" }],
      },
      ctx,
    );

    const pending = useHitlStore.getState().pending!;
    expect(pending.calls.map((c) => c.id)).toEqual(["c1"]);
    expect(pending.auto.map((c) => c.id)).toEqual(["r1"]);

    useHitlStore.getState().decide({ requestId: pending.requestId, verdicts: [] });
    await p;
  });
});
