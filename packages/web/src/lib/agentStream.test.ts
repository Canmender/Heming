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
