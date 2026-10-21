import { describe, it, expect, vi } from "vitest";
import { runAgentMentions, newStreamId, sourceFooter, MAX_SOURCES } from "./agentStream.js";
import type { ChatMessage } from "./llmClient.js";
import type { LlmProfile } from "../store/llm.js";
import { toHitlCall } from "./hitl/classify.js";

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

  // —— E2E Task 4：流式信封（sealChunk/sealFinish 注入，设计 §5.3）——

  it("E2E：注入 sealChunk/sealFinish → chunk 文本置空带 cipher+index，finish 带全文信封", async () => {
    const sealChunk = vi.fn(async (_s: string, index: number) => ({
      cipher: `c${index}`,
      chainKid: "k",
      n: index,
    }));
    const sealFinish = vi.fn(async (text: string) => ({ cipher: `f-${text}`, chainKid: "k", n: 9 }));
    const { send, onLocalDelta, deps } = makeDeps({ sealChunk, sealFinish });
    await runAgentMentions("c1", [{ agentId: "a1", name: "X" }], "hi", deps);

    const events = send.mock.calls.map((c) => c[0] as Record<string, unknown>);
    const chunks = events.filter((e) => e.type === "agent_chunk");
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toMatchObject({ text: "", index: 0, cipher: "c0", chainKid: "k", n: 0 });
    expect(chunks[1]).toMatchObject({ text: "", index: 1, cipher: "c1", chainKid: "k", n: 1 });
    expect(chunks.every((e) => e.text === "")).toBe(true); // 密文片不夹明文
    const finish = events.find((e) => e.type === "agent_finish");
    expect(finish).toMatchObject({ text: "", cipher: "f-你好", chainKid: "k", n: 9 });
    expect(sealChunk).toHaveBeenCalledTimes(2);
    expect(sealFinish).toHaveBeenCalledWith("你好");
    expect(onLocalDelta).toHaveBeenLastCalledWith(expect.any(String), "你好"); // 本机打字机不受加密影响
  });

  it("E2E：sealChunk 抛错该片跳过（绝不发明文片）；sealFinish 抛错改报 agent_error 不落明文 finish", async () => {
    let calls = 0;
    const { send, deps } = makeDeps({
      sealChunk: vi.fn(async () => {
        calls += 1;
        if (calls === 1) throw new Error("seal boom");
        return { cipher: "ok", chainKid: "k", n: 1 };
      }),
      sealFinish: vi.fn(async () => {
        throw new Error("seal boom");
      }),
    });
    await runAgentMentions("c1", [{ agentId: "a1", name: "X" }], "hi", deps);

    const events = send.mock.calls.map((c) => c[0] as Record<string, unknown>);
    const chunks = events.filter((e) => e.type === "agent_chunk");
    expect(chunks).toHaveLength(1); // 首片封失败跳过，次片照发
    expect(chunks[0]).toMatchObject({ text: "", index: 1, cipher: "ok" });
    expect(events.some((e) => e.type === "agent_chunk" && e.text === "你")).toBe(false); // 无明文回退
    expect(events.some((e) => e.type === "agent_finish")).toBe(false); // 加密失败不发明文 finish
    expect(events).toContainEqual(
      expect.objectContaining({ type: "agent_error", code: "bad_event" }),
    );
  });

  it("E2E：chunk 上行串行——首片 seal 未落定时次片不抢先（index 与发送序一致）", async () => {
    const { send, deps } = makeDeps({
      sealChunk: vi.fn(async (_s: string, index: number) => {
        if (index === 0) await new Promise((r) => setTimeout(r, 15));
        return { cipher: `c${index}`, chainKid: "k", n: index };
      }),
    });
    await runAgentMentions("c1", [{ agentId: "a1", name: "X" }], "hi", deps);
    const chunks = send.mock.calls
      .map((c) => c[0] as { type: string; index?: number; cipher?: string })
      .filter((e) => e.type === "agent_chunk");
    expect(chunks.map((c) => c.index)).toEqual([0, 1]);
    expect(chunks[0].cipher).toBe("c0"); // 未被 index=1 的密文抢先
  });

  // —— fix I2：agent_error 信封化 ——

  it("E2E：注入 sealError → agent_error 的 message 置空带 cipher；封失败回退通用明文文案", async () => {
    const sealError = vi.fn(async (_s: string, message: string) => ({
      cipher: `e-${message}`,
      chainKid: "k",
      n: 5,
    }));
    const { send, deps } = makeDeps({
      streamChat: vi.fn(async (_p, _m, o: { onDelta: (t: string) => void }) => {
        o.onDelta("半");
        throw new Error("供应商把请求片段吐出来了: POST /v1/chat body=...");
      }),
      sealError,
    });
    await runAgentMentions("c1", [{ agentId: "a1", name: "X" }], "hi", deps);

    const errs = send.mock.calls
      .map((c) => c[0] as Record<string, unknown>)
      .filter((e) => e.type === "agent_error");
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatchObject({
      code: "provider_error",
      message: "",
      cipher: "e-供应商把请求片段吐出来了: POST /v1/chat body=...",
      chainKid: "k",
      n: 5,
    }); // 错误正文只进密文
    expect(sealError).toHaveBeenCalledWith(expect.any(String), expect.stringContaining("供应商"));
  });

  it("E2E：sealError 抛错 → 通用明文文案收口（不发明文错误正文），code 保留", async () => {
    const { send, deps } = makeDeps({
      streamChat: vi.fn(async (_p, _m, o: { onDelta: (t: string) => void }) => {
        o.onDelta("半");
        throw new Error("供应商秘密片段");
      }),
      sealError: vi.fn(async () => {
        throw new Error("seal boom");
      }),
    });
    await runAgentMentions("c1", [{ agentId: "a1", name: "X" }], "hi", deps);

    const errs = send.mock.calls
      .map((c) => c[0] as Record<string, unknown>)
      .filter((e) => e.type === "agent_error");
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatchObject({ code: "provider_error", message: "生成出错（内容无法解密）" });
    expect(errs[0]).not.toHaveProperty("cipher");
    expect(JSON.stringify(errs[0])).not.toContain("供应商秘密片段"); // 原文不落帧
  });

  it("E2E：无绑定分支的 agent_error 同样走信封（message 置空）", async () => {
    const sealError = vi.fn(async (_s: string, message: string) => ({
      cipher: `e-${message}`,
      chainKid: "k",
      n: 0,
    }));
    const { send, deps } = makeDeps({ getProfile: () => undefined, sealError });
    await runAgentMentions("c1", [{ agentId: "a1", name: "X" }], "hi", deps);
    const err = send.mock.calls
      .map((c) => c[0] as Record<string, unknown>)
      .find((e) => e.type === "agent_error");
    expect(err).toMatchObject({ code: "provider_error", message: "", cipher: "e-未绑定 LLM 连接" });
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

/**
 * Task B 增量接线（设计 §4 / §3.4）：上下文压缩注入（`prepareHistory`）+ 供应商 400
 * 上下文超限的收紧重试。字段缺省时，上面全部既有用例的行为必须逐字不变。
 */
describe("runAgentMentions 上下文预算接线", () => {
  /** 原始历史（触发前由 fetchHistory 给出）。 */
  const history = [{ role: "user" as const, content: "早前消息" }];
  /** 供应商 400 上下文超限（OpenAI 措辞）：命中「maximum context」且带 400。 */
  const overflow = () =>
    new Error(
      "provider_error: HTTP 400 {\"error\":{\"message\":\"This model's maximum context length is 8192 tokens. Please reduce the length of the messages.\"}}",
    );
  /** 第 n 次尝试收到的 messages。 */
  const attemptMessages = (deps: { streamChat: unknown }, n: number): ChatMessage[] =>
    (deps.streamChat as ReturnType<typeof vi.fn>).mock.calls[n][1] as ChatMessage[];
  /** 某类上行事件（断言「只发一次」「完全没有」）。 */
  const framesOf = (send: ReturnType<typeof vi.fn>, type: string) =>
    send.mock.calls.map((c) => c[0]).filter((e) => e.type === type);

  it("缺省 prepareHistory：不调用、messages 与今天逐字一致", async () => {
    const { send, deps } = makeDeps();

    await runAgentMentions("c1", [{ agentId: "a1", name: "X" }], "hi", deps);

    expect(attemptMessages(deps, 0)).toEqual([
      { role: "system", content: "你是和小鸣" },
      ...history,
      { role: "user", content: "hi" },
    ]);
    expect(framesOf(send, "agent_finish")).toHaveLength(1);
    expect(framesOf(send, "agent_error")).toHaveLength(0);
  });

  it("prepareHistory 抛错 → 回落原 history，生成照常收口（不上行错误）", async () => {
    const prepareHistory = vi.fn(async () => {
      throw new Error("压缩爆炸");
    });
    const { send, deps } = makeDeps({ prepareHistory });

    await runAgentMentions("c1", [{ agentId: "a1", name: "X" }], "hi", deps);

    expect(prepareHistory).toHaveBeenCalledTimes(1);
    expect(attemptMessages(deps, 0)).toEqual([
      { role: "system", content: "你是和小鸣" },
      ...history,
      { role: "user", content: "hi" },
    ]);
    expect(framesOf(send, "agent_finish")).toHaveLength(1);
    expect(framesOf(send, "agent_error")).toHaveLength(0);
  });

  it("正常路径：以 (history, agentId) 调用一次，压缩结果夹在系统提示词与本条 user 轮之间", async () => {
    const prepared: ChatMessage[] = [
      { role: "system", content: "【早期对话摘要】\n意图：早期" },
      { role: "user", content: "近两轮" },
    ];
    const prepareHistory = vi.fn(
      async (_rows: ChatMessage[], _agentId: string, _opts?: { aggressive?: 1 | 2 }) => prepared,
    );
    const { deps } = makeDeps({ prepareHistory });

    await runAgentMentions("c1", [{ agentId: "a1", name: "X" }], "hi", deps);

    expect(prepareHistory).toHaveBeenCalledTimes(1);
    expect(prepareHistory.mock.calls[0]).toHaveLength(2); // 正常路径不传 opts
    expect(prepareHistory.mock.calls[0][0]).toEqual(history);
    expect(prepareHistory.mock.calls[0][1]).toBe("a1");
    expect(attemptMessages(deps, 0)).toEqual([
      { role: "system", content: "你是和小鸣" },
      ...prepared,
      { role: "user", content: "hi" },
    ]);
  });

  it("溢出重试：最多 2 次（aggressive 1→2）重新组装，重试不上行 chunk，成功只 finish 一次", async () => {
    const prepareHistory = vi.fn(
      async (rows: ChatMessage[], _agentId: string, opts?: { aggressive?: 1 | 2 }) => [
        ...(opts?.aggressive
          ? [{ role: "system" as const, content: `摘要${opts.aggressive}` }]
          : []),
        ...rows,
      ],
    );
    let n = 0;
    const streamChat = vi.fn(
      async (_p: unknown, _m: ChatMessage[], o: { onDelta: (t: string) => void }) => {
        n += 1;
        if (n === 1) {
          o.onDelta("半");
          throw overflow();
        }
        if (n === 2) {
          o.onDelta("再");
          throw overflow();
        }
        o.onDelta("好");
        return "好";
      },
    );
    const onTurnComplete = vi.fn();
    const { send, onLocalDelta, deps } = makeDeps({ prepareHistory, streamChat, onTurnComplete });

    await runAgentMentions("c1", [{ agentId: "a1", name: "X" }], "hi", deps);

    // 三次尝试：原始 → aggressive 1 → aggressive 2
    expect(streamChat).toHaveBeenCalledTimes(3);
    expect(prepareHistory.mock.calls.map((c) => c[2])).toEqual([
      undefined,
      { aggressive: 1 },
      { aggressive: 2 },
    ]);
    // 每次尝试都重新前置系统提示词、重挂本条 user 轮，并用该次 aggressive 的重装结果
    const expectedSecond: ChatMessage[] = [
      { role: "user", content: "早前消息" },
      { role: "system", content: "摘要1" },
      { role: "system", content: "摘要2" },
    ];
    for (let i = 0; i < 3; i++) {
      const messages = attemptMessages(deps, i);
      expect(messages[0]).toEqual({ role: "system", content: "你是和小鸣" });
      expect(messages[1]).toEqual(expectedSecond[i]);
      expect(messages.at(-1)).toEqual({ role: "user", content: "hi" });
    }
    // 重试期间不重复上行 chunk：chunk 只有第 1 次尝试的那一帧
    const chunks = framesOf(send, "agent_chunk");
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ text: "半" });
    expect(onLocalDelta).toHaveBeenCalledTimes(1);
    // 成功收口：finish 只发一次，且是重试成功的全文
    const finishes = framesOf(send, "agent_finish");
    expect(finishes).toHaveLength(1);
    expect(finishes[0]).toMatchObject({ text: "好" });
    expect(framesOf(send, "agent_error")).toHaveLength(0);
    expect(onTurnComplete).toHaveBeenCalledTimes(1);
    expect(onTurnComplete).toHaveBeenCalledWith("a1", "hi", "好", "ok");
  });

  it("非超限错误不重试：401 与「不含超限特征的 400」都只调一次 streamChat", async () => {
    for (const message of [
      "provider_error: HTTP 401 bad key",
      "provider_error: HTTP 400 invalid model id",
    ]) {
      const prepareHistory = vi.fn(async (rows: ChatMessage[]) => rows);
      const streamChat = vi.fn(
        async (_p: unknown, _m: ChatMessage[], o: { onDelta: (t: string) => void }) => {
          o.onDelta("半");
          throw new Error(message);
        },
      );
      const { send, deps } = makeDeps({ prepareHistory, streamChat });

      await runAgentMentions("c1", [{ agentId: "a1", name: "X" }], "hi", deps);

      expect(streamChat).toHaveBeenCalledTimes(1);
      expect(prepareHistory).toHaveBeenCalledTimes(1);
      expect(framesOf(send, "agent_finish")).toHaveLength(1);
      expect(framesOf(send, "agent_error")).toHaveLength(1);
      expect(framesOf(send, "agent_error")[0]).toMatchObject({ code: "provider_error" });
      expect(send).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: "agent_error", code: "aborted" }),
      );
    }
  });

  it("abort 不重试：中断后即便错误文本像超限也走既有 aborted 分支", async () => {
    const prepareHistory = vi.fn(async (rows: ChatMessage[]) => rows);
    const { send, onLocalDelta, deps } = makeDeps({
      prepareHistory,
      streamChat: vi.fn(
        (_p: unknown, _m: unknown, o: { signal: AbortSignal; onDelta: (t: string) => void }) =>
          new Promise<string>((_res, rej) => {
            const abort = () =>
              rej(
                new DOMException(
                  "provider_error: HTTP 400 maximum context length exceeded",
                  "AbortError",
                ),
              );
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

    expect(deps.streamChat).toHaveBeenCalledTimes(1); // 未重试
    expect(prepareHistory).toHaveBeenCalledTimes(1);
    expect(framesOf(send, "agent_error")).toHaveLength(1);
    expect(framesOf(send, "agent_error")[0]).toMatchObject({ code: "aborted" });
    expect(framesOf(send, "agent_finish")[0]).toMatchObject({ text: "半" });
  });

  it("两次重试仍超限 → 不无限重试，走既有 finish-partial + agent_error", async () => {
    const prepareHistory = vi.fn(async (rows: ChatMessage[]) => rows);
    let n = 0;
    const streamChat = vi.fn(
      async (_p: unknown, _m: ChatMessage[], o: { onDelta: (t: string) => void }) => {
        n += 1;
        o.onDelta(`半${n}`);
        throw overflow();
      },
    );
    const onTurnComplete = vi.fn();
    const { send, deps } = makeDeps({ prepareHistory, streamChat, onTurnComplete });

    await runAgentMentions("c1", [{ agentId: "a1", name: "X" }], "hi", deps);

    expect(streamChat).toHaveBeenCalledTimes(3); // 首次 + 两次收紧
    // partial = 已上行文本（与接收端按 streamId 累积的 chunk 一致）
    const finishes = framesOf(send, "agent_finish");
    expect(finishes).toHaveLength(1);
    expect(finishes[0]).toMatchObject({ text: "半1" });
    expect(framesOf(send, "agent_chunk")).toHaveLength(1);
    expect(framesOf(send, "agent_error")).toHaveLength(1);
    expect(framesOf(send, "agent_error")[0]).toMatchObject({ code: "provider_error" });
    expect(onTurnComplete).toHaveBeenCalledWith("a1", "hi", "半1", "partial");
  });

  it("缺省 prepareHistory 时溢出错误不重试（无收紧手段）：只走既有失败收口", async () => {
    const streamChat = vi.fn(async () => {
      throw overflow();
    });
    const { send, deps } = makeDeps({ streamChat });

    await runAgentMentions("c1", [{ agentId: "a1", name: "X" }], "hi", deps);

    expect(streamChat).toHaveBeenCalledTimes(1);
    expect(framesOf(send, "agent_error")).toHaveLength(1);
  });
});

describe("runAgentMentions 工具调用（MCP 桥）", () => {
  it("先执行工具并把结果回灌，中间话术不上行，只上行最终答案", async () => {
    const executed: { name: string; arguments: string }[] = [];
    const rounds = [
      {
        text: "我先查一下",
        calls: [
          {
            id: "call_1",
            type: "function" as const,
            function: { name: "srv__echo", arguments: '{"q":"hi"}' },
          },
        ],
      },
      { text: "查到了：hi", calls: [] as never[] },
    ];
    let round = 0;
    const streamChat = vi.fn(async (_p: unknown, _m: ChatMessage[], o: {
      onDelta: (t: string) => void;
      onToolCalls?: (c: unknown[]) => void;
    }) => {
      const r = rounds[round++];
      if (r.calls.length) o.onToolCalls?.(r.calls);
      if (r.text) o.onDelta(r.text);
      return r.text;
    });
    const { send, deps } = makeDeps({
      streamChat: streamChat as never,
      getTools: () => ({
        tools: [{ type: "function", function: { name: "srv__echo" } }],
        execute: async (call) => {
          executed.push(call);
          return { text: "工具说：hi", ok: true };
        },
      }),
    });

    await runAgentMentions("c1", [{ agentId: "a1", name: "X" }], "hi", deps);

    // 工具被真正执行了一次
    expect(executed).toEqual([{ name: "srv__echo", arguments: '{"q":"hi"}' }]);
    // 第二轮请求里带上了 assistant(tool_calls) + tool 结果
    const second = streamChat.mock.calls[1][1];
    expect(second.some((m) => m.role === "assistant" && m.tool_calls?.length === 1)).toBe(true);
    expect(second.some((m) => m.role === "tool" && m.content === "工具说：hi")).toBe(true);

    // 上行给用户的只有最终答案（工具轮的「我先查一下」被丢弃）
    const chunks = (send.mock.calls as unknown[][])
      .map(([e]) => e as { type: string; text?: string })
      .filter((e) => e.type === "agent_chunk")
      .map((e) => e.text ?? "")
      .join("");
    expect(chunks).toBe("查到了：hi");
    const finish = (send.mock.calls as unknown[][])
      .map(([e]) => e as { type: string; text?: string })
      .find((e) => e.type === "agent_finish");
    expect(finish?.text).toBe("查到了：hi");
  });

  it("没有工具时不注入 tools、不缓冲（行为与旧版一致）", async () => {
    const streamChat = vi.fn(async (_p: unknown, _m: ChatMessage[], o: { onDelta: (t: string) => void }) => {
      o.onDelta("好");
      return "好";
    });
    const { deps } = makeDeps({
      streamChat: streamChat as never,
      getTools: () => null,
    });
    await runAgentMentions("c1", [{ agentId: "a1", name: "X" }], "hi", deps);
    const opts = streamChat.mock.calls[0][2] as { tools?: unknown };
    expect(opts.tools).toBeUndefined();
  });
});

/**
 * 知识库来源脚注（R6）：工具真的返回过哪些页面，由编排层拼在答案末尾。
 *
 * 三条约束：
 * 1. 只统计**执行成功**且带回 sources 的调用（被拒/失败不算引用）；
 * 2. 按调用顺序去重，同一页面只列一次；
 * 3. 没来源就不加脚注——绝不让模型或编排层凭空造一条「来源」。
 */
describe("sourceFooter", () => {
  it("去重、封顶、压掉标题换行（不让来源破坏 markdown 结构）", () => {
    const many = Array.from({ length: MAX_SOURCES + 4 }, (_, i) => ({
      id: `wiki/${i}.md`,
      title: `页\n${i}`,
    }));
    const footer = sourceFooter([{ id: "wiki/0.md", title: "重复" }, ...many]);
    expect(footer.match(/^- /gm)).toHaveLength(MAX_SOURCES);
    expect(footer).not.toContain("\n\n- 页");
    expect(footer).toContain("页 1");
    expect(footer).toContain("来源（来自本机知识库）");
  });

  it("无来源时返回空串（调用方据此决定不发脚注）", () => {
    expect(sourceFooter([])).toBe("");
    expect(sourceFooter([{ id: "  ", title: "空" }])).toBe("");
  });
});

describe("runAgentMentions 来源脚注", () => {
  function twoRounds(calls: unknown[]) {
    const rounds = [
      { text: "我先查一下", calls },
      { text: "答案是 42", calls: [] as never[] },
    ];
    let round = 0;
    return vi.fn(async (_p: unknown, _m: ChatMessage[], o: {
      onDelta: (t: string) => void;
      onToolCalls?: (c: unknown[]) => void;
    }) => {
      const r = rounds[round++];
      if (r.calls.length) o.onToolCalls?.(r.calls);
      if (r.text) o.onDelta(r.text);
      return r.text;
    });
  }

  const call = (id: string, name: string) => ({
    id,
    type: "function" as const,
    function: { name, arguments: "{}" },
  });

  it("工具带回 sources → 最终答案末尾附脚注，chunk 拼接与 finish 一致", async () => {
    const streamChat = twoRounds([call("c1", "wiki_search")]);
    const { send, deps } = makeDeps({
      streamChat: streamChat as never,
      getTools: () => ({
        tools: [{ type: "function", function: { name: "wiki_search" } }],
        execute: async () => ({
          text: "找到页面",
          ok: true,
          sources: [{ id: "wiki/entities/heming.md", title: "和鸣" }],
        }),
      }),
    });

    await runAgentMentions("c1", [{ agentId: "a1", name: "X" }], "hi", deps);

    const events = send.mock.calls.map((c) => c[0] as { type: string; text?: string });
    const chunks = events.filter((e) => e.type === "agent_chunk").map((e) => e.text ?? "").join("");
    const finish = events.find((e) => e.type === "agent_finish");
    expect(chunks).toContain("来源（来自本机知识库）");
    expect(chunks).toContain("wiki/entities/heming.md");
    expect(finish?.text).toBe(chunks);
    // 工具轮的「我先查一下」仍不上行
    expect(chunks).not.toContain("我先查一下");
  });

  it("同一页面被多次读到只列一次（按调用顺序去重）", async () => {
    const streamChat = twoRounds([call("c1", "wiki_search"), call("c2", "wiki_read")]);
    const { send, deps } = makeDeps({
      streamChat: streamChat as never,
      getTools: () => ({
        tools: [
          { type: "function", function: { name: "wiki_search" } },
          { type: "function", function: { name: "wiki_read" } },
        ],
        execute: async (c) => ({
          text: c.name,
          ok: true,
          sources: [{ id: "wiki/entities/heming.md", title: "和鸣" }],
        }),
      }),
    });

    await runAgentMentions("c1", [{ agentId: "a1", name: "X" }], "hi", deps);

    const finish = (send.mock.calls as unknown[][])
      .map(([e]) => e as { type: string; text?: string })
      .find((e) => e.type === "agent_finish");
    const occurrences = finish?.text?.split("wiki/entities/heming.md").length ?? 0;
    expect(occurrences - 1).toBe(1);
  });

  it("调用被拒绝 → 不计来源、不加脚注", async () => {
    const execute = vi.fn(async () => ({
      text: "读到",
      ok: true,
      sources: [{ id: "wiki/a.md", title: "A" }],
    }));
    const streamChat = twoRounds([call("c1", "wiki_search")]);
    const { send, deps } = makeDeps({
      streamChat: streamChat as never,
      getTools: () => ({
        tools: [{ type: "function", function: { name: "wiki_search" } }],
        execute,
      }),
      confirmToolCalls: async (calls) =>
        calls.map((c) => ({
          kind: "deny" as const,
          call: toHitlCall(c),
          reason: "用户拒绝",
        })),
    });

    await runAgentMentions("c1", [{ agentId: "a1", name: "X" }], "hi", deps);

    expect(execute).not.toHaveBeenCalled();
    const finish = (send.mock.calls as unknown[][])
      .map(([e]) => e as { type: string; text?: string })
      .find((e) => e.type === "agent_finish");
    expect(finish?.text).toBe("答案是 42");
    expect(finish?.text).not.toContain("来源");
  });

  it("执行失败（ok=false）即便带了 sources 也不计入", async () => {
    const streamChat = twoRounds([call("c1", "wiki_read")]);
    const { send, deps } = makeDeps({
      streamChat: streamChat as never,
      getTools: () => ({
        tools: [{ type: "function", function: { name: "wiki_read" } }],
        execute: async () => ({
          text: "读了一半",
          ok: false,
          sources: [{ id: "wiki/a.md", title: "A" }],
        }),
      }),
    });

    await runAgentMentions("c1", [{ agentId: "a1", name: "X" }], "hi", deps);

    const finish = (send.mock.calls as unknown[][])
      .map(([e]) => e as { type: string; text?: string })
      .find((e) => e.type === "agent_finish");
    expect(finish?.text).not.toContain("来源");
  });

  it("没有工具来源的普通回答不出现脚注", async () => {
    const streamChat = twoRounds([call("c1", "wiki_search")]);
    const { send, deps } = makeDeps({
      streamChat: streamChat as never,
      getTools: () => ({
        tools: [{ type: "function", function: { name: "wiki_search" } }],
        execute: async () => ({ text: "没有匹配", ok: true }),
      }),
    });

    await runAgentMentions("c1", [{ agentId: "a1", name: "X" }], "hi", deps);

    const finish = (send.mock.calls as unknown[][])
      .map(([e]) => e as { type: string; text?: string })
      .find((e) => e.type === "agent_finish");
    expect(finish?.text).toBe("答案是 42");
  });
});

/** HITL 闸门（设计 §4.3）：工具执行**之前**问用户。
 *
 * 三条硬约束在这里逐条被钉死：
 * 1. 被拒的项**绝不**调用 bridge.execute；
 * 2. 回灌的 `tool` 消息条数恒等于 `tool_calls` 条数（少一条供应商就 400）；
 * 3. 不注入 confirmToolCalls 时行为与接入之前**逐字等价**。
 */
describe("runAgentMentions HITL 闸门", () => {
  /** 造一个会先要工具、再给答案的两轮流。 */
  function twoRounds(calls: unknown[]) {
    const rounds = [
      { text: "我先做一下", calls },
      { text: "做完了", calls: [] as never[] },
    ];
    let round = 0;
    return vi.fn(async (_p: unknown, _m: ChatMessage[], o: {
      onDelta: (t: string) => void;
      onToolCalls?: (c: unknown[]) => void;
    }) => {
      const r = rounds[round++];
      if (r.calls.length) o.onToolCalls?.(r.calls);
      if (r.text) o.onDelta(r.text);
      return r.text;
    });
  }

  const oneCall = [
    { id: "call_1", type: "function" as const, function: { name: "fs__write_file", arguments: '{"p":"a"}' } },
  ];

  /** 第二次请求里的 role=tool 消息。 */
  function toolMessages(streamChat: unknown): { content: string; tool_call_id?: string }[] {
    const second = (streamChat as ReturnType<typeof vi.fn>).mock.calls[1][1] as ChatMessage[];
    return second.filter((m) => m.role === "tool") as never;
  }

  it("不注入 confirmToolCalls：工具照常执行，行为与接入之前逐字等价", async () => {
    const executed: string[] = [];
    const streamChat = twoRounds(oneCall);
    const { deps } = makeDeps({
      streamChat: streamChat as never,
      getTools: () => ({
        tools: [{ type: "function", function: { name: "fs__write_file" } }],
        execute: async (call) => {
          executed.push(call.name);
          return { text: "写好了", ok: true };
        },
      }),
    });

    await runAgentMentions("c1", [{ agentId: "a1", name: "X" }], "hi", deps);

    expect(executed).toEqual(["fs__write_file"]);
    expect(toolMessages(streamChat)[0].content).toBe("写好了");
  });

  it("全部拒绝：bridge.execute 调用次数为 0（闸门形同虚设的防线）", async () => {
    const execute = vi.fn(async () => ({ text: "写好了", ok: true }));
    const streamChat = twoRounds(oneCall);
    const { deps } = makeDeps({
      streamChat: streamChat as never,
      getTools: () => ({
        tools: [{ type: "function", function: { name: "fs__write_file" } }],
        execute,
      }),
      confirmToolCalls: async (calls) =>
        calls.map((c) => ({
          kind: "deny" as const,
          call: {
            id: c.id,
            name: c.function.name,
            argsJson: c.function.arguments,
            displayName: "写文件",
            risk: "write" as const,
            summary: "a",
            source: "mcp" as const,
          },
          reason: "用户拒绝",
        })),
    });

    await runAgentMentions("c1", [{ agentId: "a1", name: "X" }], "hi", deps);

    expect(execute).not.toHaveBeenCalled();
  });

  it("全部拒绝：回灌的 tool 消息条数仍等于 tool_calls 条数（少一条供应商就 400）", async () => {
    const streamChat = twoRounds(oneCall);
    const { deps } = makeDeps({
      streamChat: streamChat as never,
      getTools: () => ({
        tools: [{ type: "function", function: { name: "fs__write_file" } }],
        execute: async () => ({ text: "写好了", ok: true }),
      }),
      confirmToolCalls: async (calls) =>
        calls.map((c) => ({
          kind: "deny" as const,
          call: {
            id: c.id,
            name: c.function.name,
            argsJson: c.function.arguments,
            displayName: "写文件",
            risk: "write" as const,
            summary: "a",
            source: "mcp" as const,
          },
        })),
    });

    await runAgentMentions("c1", [{ agentId: "a1", name: "X" }], "hi", deps);

    const messages = toolMessages(streamChat);
    expect(messages).toHaveLength(1);
    expect(messages[0].tool_call_id).toBe("call_1");
  });

  it("全部拒绝：回灌内容显式声明「文件与系统状态未被修改」（防模型幻觉）", async () => {
    const streamChat = twoRounds(oneCall);
    const { deps } = makeDeps({
      streamChat: streamChat as never,
      getTools: () => ({
        tools: [{ type: "function", function: { name: "fs__write_file" } }],
        execute: async () => ({ text: "写好了", ok: true }),
      }),
      confirmToolCalls: async (calls) =>
        calls.map((c) => ({
          kind: "deny" as const,
          call: {
            id: c.id,
            name: c.function.name,
            argsJson: c.function.arguments,
            displayName: "写文件",
            risk: "write" as const,
            summary: "a",
            source: "mcp" as const,
          },
        })),
    });

    await runAgentMentions("c1", [{ agentId: "a1", name: "X" }], "hi", deps);

    const content = toolMessages(streamChat)[0].content;
    expect(content).toContain("未被修改");
    expect(content).toContain("不存在部分写入或中间状态");
  });

  it("部分放行：只有被放行的项才执行，被拒的项回填拒绝文案", async () => {
    const executed: string[] = [];
    const calls = [
      { id: "call_1", type: "function" as const, function: { name: "fs__read_file", arguments: "{}" } },
      { id: "call_2", type: "function" as const, function: { name: "fs__write_file", arguments: "{}" } },
    ];
    const streamChat = twoRounds(calls);
    const { deps } = makeDeps({
      streamChat: streamChat as never,
      getTools: () => ({
        tools: [{ type: "function", function: { name: "fs__read_file" } }],
        execute: async (call) => {
          executed.push(call.name);
          return { text: "读到了", ok: true };
        },
      }),
      confirmToolCalls: async (batch) =>
        batch.map((c) => ({
          kind: c.function.name === "fs__read_file" ? ("allow" as const) : ("deny" as const),
          call: {
            id: c.id,
            name: c.function.name,
            argsJson: c.function.arguments,
            displayName: c.function.name,
            risk: "write" as const,
            summary: "",
            source: "mcp" as const,
          },
        })),
    });

    await runAgentMentions("c1", [{ agentId: "a1", name: "X" }], "hi", deps);

    expect(executed).toEqual(["fs__read_file"]);
    const messages = toolMessages(streamChat);
    expect(messages).toHaveLength(2);
    expect(messages[0].content).toBe("读到了");
    expect(messages[1].content).toContain("未被修改");
  });

  it("闸门抛错：按拒绝处理（工具不执行，但仍回灌 tool 消息）", async () => {
    const executed: string[] = [];
    const streamChat = twoRounds(oneCall);
    const { deps } = makeDeps({
      streamChat: streamChat as never,
      getTools: () => ({
        tools: [{ type: "function", function: { name: "fs__write_file" } }],
        execute: async (call) => {
          executed.push(call.name);
          return { text: "写好了", ok: true };
        },
      }),
      confirmToolCalls: async () => {
        throw new Error("闸门炸了");
      },
    });

    await runAgentMentions("c1", [{ agentId: "a1", name: "X" }], "hi", deps);

    // 兜底方向是 deny：闸门坏掉的时刻最不该让危险操作裸奔。
    expect(executed).toEqual([]);
    const messages = toolMessages(streamChat);
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toContain("未被修改");
    // 异常 ≠ 用户拒绝：模型不能把系统故障归因成用户的选择。
    expect(messages[0].content).toContain("确认流程异常");
    expect(messages[0].content).not.toContain("用户拒绝");
  });

  it("闸门返回条数与调用数不一致：按拒绝处理（对不上就不能信）", async () => {
    const executed: string[] = [];
    const streamChat = twoRounds(oneCall);
    const { deps } = makeDeps({
      streamChat: streamChat as never,
      getTools: () => ({
        tools: [{ type: "function", function: { name: "fs__write_file" } }],
        execute: async (call) => {
          executed.push(call.name);
          return { text: "写好了", ok: true };
        },
      }),
      confirmToolCalls: async () => [],
    });

    await runAgentMentions("c1", [{ agentId: "a1", name: "X" }], "hi", deps);

    expect(executed).toEqual([]);
    const messages = toolMessages(streamChat);
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toContain("未被修改");
  });

  it("被拒的项在工具轨迹里标为「已拒绝」（用户要能确认自己真的拒了）", async () => {
    const toolEvents: { phase: string; denied?: boolean; denyCause?: string }[] = [];
    const streamChat = twoRounds(oneCall);
    const { deps } = makeDeps({
      streamChat: streamChat as never,
      getTools: () => ({
        tools: [{ type: "function", function: { name: "fs__write_file" } }],
        execute: async () => ({ text: "写好了", ok: true }),
      }),
      confirmToolCalls: async (calls) =>
        calls.map((c) => ({
          kind: "deny" as const,
          call: {
            id: c.id,
            name: c.function.name,
            argsJson: c.function.arguments,
            displayName: "写文件",
            risk: "write" as const,
            summary: "",
            source: "mcp" as const,
          },
          cause: "rule" as const,
        })),
      onToolTrace: (_id, e) => toolEvents.push(e),
    });

    await runAgentMentions("c1", [{ agentId: "a1", name: "X" }], "hi", deps);

    const end = toolEvents.find((e) => e.phase === "end");
    expect(end?.denied).toBe(true);
    // 拒绝原因随轨迹带出：任务汇总要能区分「用户拒」与「规则拒/闸门异常」
    expect(end?.denyCause).toBe("rule");
  });

  it("工具轨迹 end 带成功来源与被拒原因（任务区汇总依赖这两个字段）", async () => {
    const toolEvents: {
      phase: string;
      denied?: boolean;
      sources?: { id: string; title: string }[];
      denyCause?: string;
    }[] = [];
    const streamChat = twoRounds(oneCall);
    const { deps } = makeDeps({
      streamChat: streamChat as never,
      getTools: () => ({
        tools: [{ type: "function", function: { name: "fs__write_file" } }],
        execute: async () => ({
          text: "读到了",
          ok: true,
          sources: [{ id: "wiki/a", title: "页面 A" }],
        }),
      }),
      onToolTrace: (_id, e) => toolEvents.push(e),
    });

    await runAgentMentions("c1", [{ agentId: "a1", name: "X" }], "hi", deps);

    const end = toolEvents.find((e) => e.phase === "end");
    expect(end?.sources).toEqual([{ id: "wiki/a", title: "页面 A" }]);
    expect(end?.denyCause).toBeUndefined();
  });

  it("★ 拒绝后模型若再要工具，会**再次**被问（不因为上轮被拒就一路放行）", async () => {
    // 这是闸门最容易被绕过的地方：模型被拒一次后换个名字再调，
    // 如果「本轮已拒过」的去重表没按轮清空、或闸门只对第一轮生效，
    // 第二次就会静默执行。
    //
    // 去重表按 streamId 清空，而同一轮里同一个指纹才去重——
    // 所以这里要验的是「**新一轮的同名调用仍会被问**」。
    const asked: number[] = [];
    const execute = vi.fn(async () => ({ text: "写好了", ok: true }));
    const streamChat = twoRounds(oneCall);
    const { deps } = makeDeps({
      streamChat: streamChat as never,
      getTools: () => ({
        tools: [{ type: "function", function: { name: "fs__write_file" } }],
        execute,
      }),
      confirmToolCalls: async (calls) => {
        asked.push(calls.length);
        return calls.map((c) => ({
          kind: "deny" as const,
          call: {
            id: c.id,
            name: c.function.name,
            argsJson: c.function.arguments,
            displayName: "写文件",
            risk: "write" as const,
            summary: "",
            source: "mcp" as const,
          },
        }));
      },
    });

    await runAgentMentions("c1", [{ agentId: "a1", name: "X" }], "hi", deps);

    // 闸门被调用过（至少一次）
    expect(asked.length).toBeGreaterThanOrEqual(1);
    // 且整个过程里 execute 一次都没被调
    expect(execute).not.toHaveBeenCalled();
  });

  it("★ 多轮工具调用：每一轮都独立询问，不是一次问完就放行后续", async () => {
    // 三轮都要工具。每一轮都必须过闸门——
    // 如果闸门只在第一轮生效（或只在第一轮弹窗），第 2、3 轮就静默执行了。
    const rounds = [
      { text: "一", calls: [{ id: "c1", type: "function" as const, function: { name: "fs__a", arguments: "{}" } }] },
      { text: "二", calls: [{ id: "c2", type: "function" as const, function: { name: "fs__b", arguments: "{}" } }] },
      { text: "三", calls: [] as never[] },
    ];
    let round = 0;
    const streamChat = vi.fn(async (_p: unknown, _m: ChatMessage[], o: {
      onDelta: (t: string) => void;
      onToolCalls?: (c: unknown[]) => void;
    }) => {
      const r = rounds[round++];
      if (r.calls.length) o.onToolCalls?.(r.calls);
      if (r.text) o.onDelta(r.text);
      return r.text;
    });

    const askedNames: string[] = [];
    const execute = vi.fn(async () => ({ text: "ok", ok: true }));
    const { deps } = makeDeps({
      streamChat: streamChat as never,
      getTools: () => ({
        tools: [
          { type: "function", function: { name: "fs__a" } },
          { type: "function", function: { name: "fs__b" } },
        ],
        execute,
      }),
      confirmToolCalls: async (calls) => {
        askedNames.push(...calls.map((c) => c.function.name));
        return calls.map((c) => ({
          kind: "deny" as const,
          call: {
            id: c.id,
            name: c.function.name,
            argsJson: c.function.arguments,
            displayName: c.function.name,
            risk: "write" as const,
            summary: "",
            source: "mcp" as const,
          },
        }));
      },
    });

    await runAgentMentions("c1", [{ agentId: "a1", name: "X" }], "hi", deps);

    // 两轮两个不同的工具名，**两次都被问了**
    expect(askedNames).toEqual(["fs__a", "fs__b"]);
    // 且一次都没执行
    expect(execute).not.toHaveBeenCalled();
  });
});

describe("runAgentMentions 可视化（思考过程 / 工具轨迹）", () => {
  it("思考过程累积后回传全文，工具 start/end 各一次且带结果", async () => {
    const reasoningEvents: string[] = [];
    const toolEvents: { phase: string; name: string; ok?: boolean; result?: string }[] = [];
    const rounds = [
      {
        text: "",
        calls: [
          { id: "c1", type: "function" as const, function: { name: "srv__echo", arguments: '{"q":1}' } },
        ],
      },
      { text: "答", calls: [] as never[] },
    ];
    let round = 0;
    const streamChat = vi.fn(async (_p: unknown, _m: ChatMessage[], o: {
      onDelta: (t: string) => void;
      onToolCalls?: (c: unknown[]) => void;
      onReasoning?: (t: string) => void;
    }) => {
      const r = rounds[round++];
      if (round === 1) {
        o.onReasoning?.("先想");
        o.onReasoning?.("一下");
      }
      if (r.calls.length) o.onToolCalls?.(r.calls);
      if (r.text) o.onDelta(r.text);
      return r.text;
    });
    const { deps } = makeDeps({
      streamChat: streamChat as never,
      getTools: () => ({
        tools: [{ type: "function", function: { name: "srv__echo" } }],
        execute: async () => ({ text: "工具结果", ok: true }),
      }),
      onReasoning: (_id, text) => reasoningEvents.push(text),
      onToolTrace: (_id, e) => toolEvents.push(e),
    });

    await runAgentMentions("c1", [{ agentId: "a1", name: "X" }], "hi", deps);

    // 思考过程是累积全文（UI 直接替换显示）
    expect(reasoningEvents).toEqual(["先想", "先想一下"]);
    // 工具轨迹：一次 start + 一次 end，end 带 ok 与结果
    expect(toolEvents.map((e) => e.phase)).toEqual(["start", "end"]);
    expect(toolEvents[0].name).toBe("srv__echo");
    expect(toolEvents[1].ok).toBe(true);
    expect(toolEvents[1].result).toBe("工具结果");
  });

  it("没有工具/思考能力时不产生任何可视化事件", async () => {
    const onReasoning = vi.fn();
    const onToolTrace = vi.fn();
    const streamChat = vi.fn(async (_p: unknown, _m: ChatMessage[], o: { onDelta: (t: string) => void }) => {
      o.onDelta("好");
      return "好";
    });
    const { deps } = makeDeps({ streamChat: streamChat as never, onReasoning, onToolTrace });
    await runAgentMentions("c1", [{ agentId: "a1", name: "X" }], "hi", deps);
    expect(onReasoning).not.toHaveBeenCalled();
    expect(onToolTrace).not.toHaveBeenCalled();
  });
});

/**
 * 任务区终态（onRunSettled）：每个流恰好一次。
 *
 * 与 onTurnComplete 的分工：后者只管「有没有可记忆的文本」，完全无文本的失败
 * 不回调；任务记录需要每条流都有终态，否则会永远停在「进行中」。
 */
describe("runAgentMentions onRunSettled", () => {
  it("成功 → ok + 全文，且只回调一次", async () => {
    const onRunSettled = vi.fn();
    const { deps } = makeDeps({ onRunSettled });
    await runAgentMentions("c1", [{ agentId: "a1", name: "X" }], "hi", deps);
    expect(onRunSettled).toHaveBeenCalledTimes(1);
    expect(onRunSettled).toHaveBeenCalledWith(expect.any(String), {
      status: "ok",
      finalText: "你好",
    });
  });

  it("无绑定 → error（不进供应商，但任务必须有终态）", async () => {
    const onRunSettled = vi.fn();
    const { deps } = makeDeps({ getProfile: () => undefined, onRunSettled });
    await runAgentMentions("c1", [{ agentId: "a1", name: "X" }], "hi", deps);
    expect(onRunSettled).toHaveBeenCalledTimes(1);
    expect(onRunSettled).toHaveBeenCalledWith(expect.any(String), {
      status: "error",
      error: "未绑定 LLM 连接",
    });
  });

  it("供应商失败 → error + 原因（有部分文本时一并带出）", async () => {
    const onRunSettled = vi.fn();
    const { deps } = makeDeps({
      onRunSettled,
      streamChat: vi.fn(async (_p, _m, o: { onDelta: (t: string) => void }) => {
        o.onDelta("半");
        throw new Error("HTTP 500");
      }),
    });
    await runAgentMentions("c1", [{ agentId: "a1", name: "X" }], "hi", deps);
    expect(onRunSettled).toHaveBeenCalledTimes(1);
    expect(onRunSettled).toHaveBeenCalledWith(expect.any(String), {
      status: "error",
      finalText: "半",
      error: "HTTP 500",
    });
  });

  it("中止 → aborted + 已产生的文本（不记成失败）", async () => {
    const onRunSettled = vi.fn();
    const onLocalDelta = vi.fn();
    const { deps } = makeDeps({
      onRunSettled,
      onLocalDelta,
      streamChat: vi.fn(
        (_p: unknown, _m: unknown, o: { signal: AbortSignal; onDelta: (t: string) => void }) =>
          new Promise<string>((_res, rej) => {
            o.onDelta("半");
            o.signal.addEventListener("abort", () =>
              rej(new DOMException("AbortError", "AbortError")),
            );
          }),
      ),
    });
    const run = runAgentMentions("c1", [{ agentId: "a1", name: "X" }], "hi", deps);
    await vi.waitFor(() => expect(onLocalDelta).toHaveBeenCalledWith(expect.any(String), "半"));
    run.abortAll();
    await run;
    expect(onRunSettled).toHaveBeenCalledTimes(1);
    expect(onRunSettled).toHaveBeenCalledWith(expect.any(String), {
      status: "aborted",
      finalText: "半",
    });
  });

  it("读历史失败 → 整轮仍 reject（原行为），但终态先落定为 error", async () => {
    const onRunSettled = vi.fn();
    const { deps } = makeDeps({
      onRunSettled,
      fetchHistory: async () => {
        throw new Error("历史读取失败");
      },
    });
    await expect(
      runAgentMentions("c1", [{ agentId: "a1", name: "X" }], "hi", deps),
    ).rejects.toThrow("历史读取失败");
    expect(onRunSettled).toHaveBeenCalledTimes(1);
    expect(onRunSettled).toHaveBeenCalledWith(expect.any(String), {
      status: "error",
      error: "历史读取失败",
    });
  });
});
