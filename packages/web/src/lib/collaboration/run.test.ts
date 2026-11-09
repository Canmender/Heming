import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveBoundProfile, streamChatRouted } from "../llmRoute.js";
import { useLlmStore, type LlmProfile } from "../../store/llm.js";
import { buildCollaborationSystemPrompt, COLLAB_SYSTEM_RULES, createCollaborationAsk } from "./run.js";

vi.mock("../llmRoute.js", () => ({
  resolveBoundProfile: vi.fn(),
  streamChatRouted: vi.fn(),
}));

const profile: LlmProfile = {
  id: "p1",
  label: "本地",
  provider: "openai",
  apiKey: "sk-secret",
  model: "m1",
};

const signal = new AbortController().signal;

beforeEach(() => {
  vi.mocked(resolveBoundProfile).mockReset();
  vi.mocked(streamChatRouted).mockReset();
  useLlmStore.setState({ prompts: {} });
});

describe("协作 run · 真实 ask 适配", () => {
  it("没有绑定：抛可读的「未绑定模型」，不发起请求", async () => {
    vi.mocked(resolveBoundProfile).mockReturnValue(undefined);
    const ask = createCollaborationAsk();
    await expect(
      ask("a1", [{ role: "user", content: "任务" }], signal, {
        turnId: "t1",
        role: "方案",
        round: 1,
        agentName: "小研",
      }),
    ).rejects.toThrow("未绑定模型：小研");
    expect(streamChatRouted).not.toHaveBeenCalled();
  });

  it("绑定后：用该智能体的 profile / 自己的提示词 + 协作纪律，透传 signal 并回填流", async () => {
    vi.mocked(resolveBoundProfile).mockReturnValue(profile as never);
    vi.mocked(streamChatRouted).mockImplementation(async (_p, _messages, opts) => {
      opts.onDelta("你");
      opts.onDelta("好");
      return "你好";
    });
    useLlmStore.setState({ prompts: { a1: "你是严谨的研究员" } });
    const onToken = vi.fn();

    const ask = createCollaborationAsk({ onToken });
    const text = await ask("a1", [{ role: "user", content: "任务正文" }], signal, {
      turnId: "t1",
      role: "方案",
      round: 1,
      agentName: "小研",
    });

    expect(text).toBe("你好");
    expect(resolveBoundProfile).toHaveBeenCalledWith("a1");
    const [usedProfile, messages, opts] = vi.mocked(streamChatRouted).mock.calls[0];
    expect(usedProfile).toBe(profile);
    expect(messages[0]).toMatchObject({ role: "system" });
    expect(messages[0].content).toContain("你是严谨的研究员");
    expect(messages[0].content).toContain("多人协作");
    expect(messages[1]).toEqual({ role: "user", content: "任务正文" });
    // Key 不进消息
    expect(messages.map((m) => m.content).join("\n")).not.toContain("sk-secret");
    expect(opts.signal).toBe(signal);
    expect(onToken).toHaveBeenNthCalledWith(1, "t1", "你");
    expect(onToken).toHaveBeenLastCalledWith("t1", "你好");
  });

  it("注入的 prompts 优先于 store（UI 用快照，测试可完全隔离）", async () => {
    vi.mocked(resolveBoundProfile).mockReturnValue(profile as never);
    vi.mocked(streamChatRouted).mockResolvedValue("ok");
    useLlmStore.setState({ prompts: { a1: "store 里的旧提示词" } });
    const ask = createCollaborationAsk({ prompts: { a1: "快照提示词" } });
    await ask("a1", [{ role: "user", content: "x" }], signal);
    const [, messages] = vi.mocked(streamChatRouted).mock.calls[0];
    expect(messages[0].content).toContain("快照提示词");
    expect(messages[0].content).not.toContain("store 里的旧提示词");
  });

  it("流中断：错误上挂 partialText，编排器能保留已生成内容", async () => {
    vi.mocked(resolveBoundProfile).mockReturnValue(profile as never);
    vi.mocked(streamChatRouted).mockImplementation(async (_p, _m, opts) => {
      opts.onDelta("写到一半");
      throw new DOMException("AbortError", "AbortError");
    });
    const ask = createCollaborationAsk({ prompts: {} });
    await expect(
      ask("a1", [{ role: "user", content: "x" }], signal, {
        turnId: "t1",
        role: "方案",
        round: 1,
        agentName: "小研",
      }),
    ).rejects.toMatchObject({ name: "AbortError", partialText: "写到一半" });
  });

  it("系统提示词只由自身 prompt 与固定纪律组成", () => {
    expect(buildCollaborationSystemPrompt("")).toBe(COLLAB_SYSTEM_RULES);
    expect(buildCollaborationSystemPrompt("  人格  ")).toBe(`人格\n\n${COLLAB_SYSTEM_RULES}`);
  });
});
