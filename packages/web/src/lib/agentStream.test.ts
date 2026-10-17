import { describe, it, expect, vi } from "vitest";
import { runAgentMentions, newStreamId } from "./agentStream.js";
import type { LlmProfile } from "../store/llm.js";

const profile: LlmProfile = { id: "p1", label: "l", provider: "openai", apiKey: "k", model: "m" };

function makeDeps(overrides: Partial<Parameters<typeof runAgentMentions>[3]> = {}) {
  const send = vi.fn();
  const onLocalDelta = vi.fn();
  return {
    send,
    onLocalDelta,
    deps: {
      getProfile: () => profile,
      getPrompt: () => "你是和小鸣",
      fetchHistory: async () => [{ role: "user" as const, content: "早前消息" }],
      streamChat: vi.fn(async (_p, msgs, o: { onDelta: (t: string) => void }) => {
        o.onDelta("你");
        o.onDelta("好");
        return "你好";
      }),
      send,
      onLocalDelta,
      ...overrides,
    },
  };
}

describe("runAgentMentions", () => {
  it("无绑定 → 发 agent_error(provider_error) 不调 streamChat", async () => {
    const { send, deps } = makeDeps({ getProfile: () => undefined });
    const streamChat = deps.streamChat as ReturnType<typeof vi.fn>;
    await runAgentMentions("c1", [{ agentId: "a1", name: "X" }], "hi", deps);
    expect(streamChat).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ type: "agent_error", code: "provider_error" }),
    );
  });

  it("正常流：delta 累积回调 + chunk + finish 全文", async () => {
    const { send, onLocalDelta, deps } = makeDeps();
    await runAgentMentions("c1", [{ agentId: "a1", name: "X" }], "hi", deps);
    expect(onLocalDelta).toHaveBeenCalledTimes(2);
    expect(onLocalDelta).toHaveBeenLastCalledWith(expect.any(String), "你好");
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "agent_chunk", text: "你" }));
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "agent_finish", text: "你好" }));
    const prompts = (deps.streamChat as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(prompts[0]).toEqual({ role: "system", content: "你是和小鸣" });
    expect(prompts.at(-1)).toEqual({ role: "user", content: "hi" });
  });

  it("生成失败但已有部分 → finish(partial) + error(aborted/provider_error)", async () => {
    const { send, deps } = makeDeps({
      streamChat: vi.fn(async (_p, _m, o: { onDelta: (t: string) => void }) => {
        o.onDelta("半");
        throw new Error("provider_error: HTTP 401 bad key");
      }),
    });
    await runAgentMentions("c1", [{ agentId: "a1", name: "X" }], "hi", deps);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "agent_finish", text: "半" }));
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ type: "agent_error", code: "provider_error" }),
    );
  });

  it("多 mention 并行且 streamId 互异", async () => {
    const { send, deps } = makeDeps();
    await runAgentMentions(
      "c1",
      [
        { agentId: "a1", name: "X" },
        { agentId: "a2", name: "Y" },
      ],
      "hi",
      deps,
    );
    const finishes = send.mock.calls.map((c) => c[0]).filter((e) => e.type === "agent_finish");
    expect(finishes).toHaveLength(2);
    expect(new Set(finishes.map((f) => f.streamId)).size).toBe(2);
  });

  it("onStart 在流启动时回调（本机流登记），无绑定分支也先回调", async () => {
    const onStart = vi.fn();
    const { deps } = makeDeps({ onStart });
    await runAgentMentions("c1", [{ agentId: "a1", name: "X" }], "hi", deps);
    expect(onStart).toHaveBeenCalledWith(expect.any(String), { agentId: "a1", name: "X" });

    const { deps: unbound } = makeDeps({ getProfile: () => undefined, onStart });
    await runAgentMentions("c1", [{ agentId: "a9", name: "Y" }], "hi", unbound);
    expect(onStart).toHaveBeenCalledTimes(2);
  });

  it("abortAll 中止进行中的流 → finish(partial) + error(aborted)", async () => {
    const { send, onLocalDelta, deps } = makeDeps({
      streamChat: vi.fn(
        (_p: unknown, _m: unknown, o: { signal: AbortSignal; onDelta: (t: string) => void }) =>
          new Promise<string>((_res, rej) => {
            const abort = () => rej(new DOMException("AbortError", "AbortError"));
            if (o.signal.aborted) return abort(); // 启动前已中断
            o.onDelta("半");
            o.signal.addEventListener("abort", abort);
          }),
      ),
    });
    // 不 await：句柄同步挂在返回的 promise 上，流跑着也能中断
    const run = runAgentMentions("c1", [{ agentId: "a1", name: "X" }], "hi", deps);
    await vi.waitFor(() => expect(onLocalDelta).toHaveBeenCalledWith(expect.any(String), "半"));
    run.abortAll();
    await vi.waitFor(() =>
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({ type: "agent_error", code: "aborted" }),
      ),
    );
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "agent_finish", text: "半" }));
    await run; // 全部落定（promise 等全部流完成）
  });

  it("流启动前 abortAll：启动即中止，无 partial 只报 error(aborted)", async () => {
    const { send, deps } = makeDeps({
      streamChat: vi.fn(
        (_p: unknown, _m: unknown, o: { signal: AbortSignal; onDelta: (t: string) => void }) =>
          new Promise<string>((_res, rej) => {
            const abort = () => rej(new DOMException("AbortError", "AbortError"));
            if (o.signal.aborted) return abort();
            o.onDelta("半");
            o.signal.addEventListener("abort", abort);
          }),
      ),
    });
    const run = runAgentMentions("c1", [{ agentId: "a1", name: "X" }], "hi", deps);
    run.abortAll(); // fetchHistory 尚未落定：controller 创建时补 abort
    await vi.waitFor(() =>
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({ type: "agent_error", code: "aborted" }),
      ),
    );
    expect(send).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "agent_finish" }),
    );
    await run;
  });
});

it("newStreamId 唯一性", () => {
  expect(newStreamId()).not.toBe(newStreamId());
});

/**
 * Task 4 增量接线（设计 §6）：异步系统提示词构建 + 轮次收尾回调。
 * 两个字段都是可选的，缺省时上面既有用例的行为必须逐字不变。
 */
describe("runAgentMentions 运行时接线", () => {
  /** 取 streamChat 首次调用收到的 messages（组装结果断言面）。 */
  function seenMessages(deps: { streamChat: unknown }): { role: string; content: string }[] {
    return (deps.streamChat as ReturnType<typeof vi.fn>).mock.calls[0][1];
  }

  it("buildSystemPrompt 存在时优先于 getPrompt，且传入 mention 的 agentId 与触发文本", async () => {
    const getPrompt = vi.fn(() => "原提示词");
    const buildSystemPrompt = vi.fn(async () => "拼装后的提示词");
    const { deps } = makeDeps({ getPrompt, buildSystemPrompt });

    await runAgentMentions("c1", [{ agentId: "a1", name: "X" }], "hi", deps);

    expect(buildSystemPrompt).toHaveBeenCalledWith("a1", "hi");
    expect(getPrompt).not.toHaveBeenCalled(); // 优先即不再取原提示词
    expect(seenMessages(deps)[0]).toEqual({ role: "system", content: "拼装后的提示词" });
  });

  it("buildSystemPrompt 抛错 → 回落 getPrompt，三事件照常收口", async () => {
    const buildSystemPrompt = vi.fn(async () => {
      throw new Error("记忆组装失败");
    });
    const { send, deps } = makeDeps({ buildSystemPrompt });

    await runAgentMentions("c1", [{ agentId: "a1", name: "X" }], "hi", deps);

    expect(seenMessages(deps)[0]).toEqual({ role: "system", content: "你是和小鸣" });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "agent_finish", text: "你好" }));
    expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: "agent_error" }));
  });

  it("成功 finish → onTurnComplete(agentId, 触发文本, 全文, \"ok\")", async () => {
    const onTurnComplete = vi.fn();
    const { deps } = makeDeps({ onTurnComplete });

    await runAgentMentions("c1", [{ agentId: "a1", name: "X" }], "hi", deps);

    expect(onTurnComplete).toHaveBeenCalledTimes(1);
    expect(onTurnComplete).toHaveBeenCalledWith("a1", "hi", "你好", "ok");
  });

  it("失败但已有部分文本 → onTurnComplete(..., \"partial\")", async () => {
    const onTurnComplete = vi.fn();
    const { send, deps } = makeDeps({
      onTurnComplete,
      streamChat: vi.fn(async (_p, _m, o: { onDelta: (t: string) => void }) => {
        o.onDelta("半");
        throw new Error("provider_error: HTTP 401 bad key");
      }),
    });

    await runAgentMentions("c1", [{ agentId: "a1", name: "X" }], "hi", deps);

    expect(onTurnComplete).toHaveBeenCalledWith("a1", "hi", "半", "partial");
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "agent_finish", text: "半" }));
  });

  it("中断（abort）已有部分文本 → 同样按 partial 回调（与失败同口径）", async () => {
    const onTurnComplete = vi.fn();
    const { onLocalDelta, deps } = makeDeps({
      onTurnComplete,
      streamChat: vi.fn(
        (_p: unknown, _m: unknown, o: { signal: AbortSignal; onDelta: (t: string) => void }) =>
          new Promise<string>((_res, rej) => {
            const abort = () => rej(new DOMException("AbortError", "AbortError"));
            if (o.signal.aborted) return abort();
            o.onDelta("半");
            o.signal.addEventListener("abort", abort);
          }),
      ),
    });

    const run = runAgentMentions("c1", [{ agentId: "a1", name: "X" }], "hi", deps);
    await vi.waitFor(() => expect(onLocalDelta).toHaveBeenCalledWith(expect.any(String), "半"));
    run.abortAll();
    await run;

    expect(onTurnComplete).toHaveBeenCalledWith("a1", "hi", "半", "partial");
  });

  it("失败且完全无文本 → 不回调（无内容可记）", async () => {
    const onTurnComplete = vi.fn();
    const { deps } = makeDeps({
      onTurnComplete,
      streamChat: vi.fn(async () => {
        throw new Error("provider_error: 启动即失败");
      }),
    });

    await runAgentMentions("c1", [{ agentId: "a1", name: "X" }], "hi", deps);

    expect(onTurnComplete).not.toHaveBeenCalled();
  });

  it("onTurnComplete 抛错不上行：finish 只发一次、不产生多余 agent_error", async () => {
    const onTurnComplete = vi.fn(() => {
      throw new Error("记忆爆炸");
    });
    const { send, deps } = makeDeps({ onTurnComplete });

    await runAgentMentions("c1", [{ agentId: "a1", name: "X" }], "hi", deps);

    const types = send.mock.calls.map((c) => c[0].type);
    expect(types.filter((t) => t === "agent_finish")).toHaveLength(1);
    expect(types).not.toContain("agent_error");
  });

  it("partial 回调抛错同样静默：run promise 不 reject", async () => {
    const onTurnComplete = vi.fn(() => {
      throw new Error("记忆爆炸");
    });
    const { deps } = makeDeps({
      onTurnComplete,
      streamChat: vi.fn(async (_p, _m, o: { onDelta: (t: string) => void }) => {
        o.onDelta("半");
        throw new Error("provider_error: HTTP 500");
      }),
    });

    await expect(
      runAgentMentions("c1", [{ agentId: "a1", name: "X" }], "hi", deps),
    ).resolves.toBeDefined();
    expect(onTurnComplete).toHaveBeenCalledWith("a1", "hi", "半", "partial");
  });

  it("无绑定分支：不构建提示词、不回调、不触达供应商", async () => {
    const buildSystemPrompt = vi.fn(async () => "拼装后的提示词");
    const onTurnComplete = vi.fn();
    const { deps } = makeDeps({ getProfile: () => undefined, buildSystemPrompt, onTurnComplete });

    await runAgentMentions("c1", [{ agentId: "a1", name: "X" }], "hi", deps);

    expect(buildSystemPrompt).not.toHaveBeenCalled();
    expect(onTurnComplete).not.toHaveBeenCalled();
  });
});
