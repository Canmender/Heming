/**
 * 路由层行为测试：换候选的三条硬规矩 + 冷却记账 + 窗口预筛 + 绝不死路。
 *
 * `streamChat` 整体替换为可控假实现（`LlmHttpError` 用真实的，`instanceof` 才认），
 * 供应商协议解析本身在 llmClient.test.ts 里覆盖。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { LlmHttpError, streamChat, type ChatMessage, type RouteAttempt } from "./llmClient.js";
import { streamChatRouted, type RoutedProfile } from "./llmRoute.js";
import { accountKey, llmHealth } from "./llmHealth.js";
import { useLlmStore, type LlmProfile, type RouteGroup, type RouteMember } from "../store/llm.js";

vi.mock("./llmClient.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("./llmClient.js")>();
  return { ...mod, streamChat: vi.fn() };
});

const ask = vi.mocked(streamChat);

/** 能力表查不到的名字 = 「窗口未知」，不参与 withRoom 预筛（只按失败判定）。 */
const MODEL_A = "testmodel-alpha";
const MODEL_B = "testmodel-beta";

function profile(id: string, model = MODEL_A, baseUrl?: string): LlmProfile {
  return { id, label: id, provider: "openai", apiKey: `sk-${id}`, model, baseUrl };
}

/** 造合成 profile（等价于界面绑定 `route.<id>` 后 resolveBoundProfile 的产物）。 */
function routed(members: RouteMember[]): RoutedProfile {
  const group: RouteGroup = { id: "g1", label: "候选链", members };
  return {
    ...profile(`route.${group.id}`, members[0]?.model ?? MODEL_A),
    label: group.label,
    route: group,
  };
}

const msg = (content: string): ChatMessage[] => [{ role: "user", content }];
const rateVerdict = { kind: "rate", rests: true, scope: "account", failover: true } as const;

beforeEach(() => {
  ask.mockReset();
  llmHealth.reset();
  useLlmStore.setState({
    profiles: [
      profile("p1"),
      profile("p2", MODEL_B),
      profile("p3", MODEL_A),
      profile("p4", MODEL_A, "https://gateway.example/v1"),
    ],
    routes: [],
    bindings: {},
  });
});

describe("单候选透传（不路由时零改动）", () => {
  it("链长为 1：opts 原样交给 streamChat，不排序不记账", async () => {
    const p = profile("p1");
    const opts = { signal: new AbortController().signal, onDelta: vi.fn() };
    ask.mockResolvedValue("你好");

    await expect(streamChatRouted(p, msg("嗨"), opts)).resolves.toBe("你好");

    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask.mock.calls[0]).toEqual([p, msg("嗨"), opts]); // 第三个参数是同一个对象引用
    expect(llmHealth.entries()).toEqual([]);
  });
});

describe("失败换候选（magpie retryable / holdWriter.passing）", () => {
  it("429 冷却当前候选并换下一个，成功清零", async () => {
    const attempts: string[] = [];
    ask.mockImplementation(async (p, _m, o) => {
      if (p.id === "p1") throw new LlmHttpError(429, "Too Many Requests: rate limit exceeded");
      o.onDelta("来自 p2");
      return "来自 p2";
    });

    const text = await streamChatRouted(routed([{ profileId: "p1" }, { profileId: "p2" }]), msg("嗨"), {
      signal: new AbortController().signal,
      onDelta: vi.fn(),
      onAttempt: (a) => attempts.push(`${a.profileId}:${a.ok ? "ok" : a.kind}`),
    });

    expect(text).toBe("来自 p2");
    expect(ask.mock.calls.map((c) => c[0].id)).toEqual(["p1", "p2"]);
    expect(llmHealth.resting(accountKey("p1"))).toBe(true);
    expect(attempts).toEqual(["p1:rate", "p2:ok"]);
  });

  it("正文已经吐出后失败：不换候选、错误原样抛，休息账照记", async () => {
    ask.mockImplementation(async (p, _m, o) => {
      o.onDelta("写了一半");
      throw new LlmHttpError(429, "Too Many Requests: rate limit exceeded");
    });

    await expect(
      streamChatRouted(routed([{ profileId: "p1" }, { profileId: "p2" }]), msg("嗨"), {
        signal: new AbortController().signal,
        onDelta: vi.fn(),
      }),
    ).rejects.toBeInstanceOf(LlmHttpError);

    expect(ask).toHaveBeenCalledTimes(1); // 不会让用户看到两份回复
    expect(llmHealth.resting(accountKey("p1"))).toBe(true);
  });

  it("裸 400（请求本身有问题）：不换、不冷却，错误交给调用方", async () => {
    const err = new LlmHttpError(400, '{"error":{"message":"something odd"}}');
    ask.mockImplementation(async (p) => {
      if (p.id === "p1") throw err;
      return "p2 的答案";
    });

    await expect(
      streamChatRouted(routed([{ profileId: "p1" }, { profileId: "p2" }]), msg("嗨"), {
        signal: new AbortController().signal,
        onDelta: vi.fn(),
      }),
    ).rejects.toBe(err);

    expect(ask).toHaveBeenCalledTimes(1);
    expect(llmHealth.entries()).toEqual([]);
  });

  it("调用方中止：不判定、不冷却、不换", async () => {
    ask.mockImplementation(async () => {
      throw new DOMException("AbortError", "AbortError");
    });

    await expect(
      streamChatRouted(routed([{ profileId: "p1" }, { profileId: "p2" }]), msg("嗨"), {
        signal: new AbortController().signal,
        onDelta: vi.fn(),
      }),
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(ask).toHaveBeenCalledTimes(1);
    expect(llmHealth.entries()).toEqual([]);
  });
});

describe("上下文窗口（withRoom / spentRoom）", () => {
  it("说过「太长」的同端点同模型本轮不再问，换一家端点仍可问", async () => {
    ask.mockImplementation(async (p) => {
      if (p.id !== "p4")
        throw new LlmHttpError(400, "This model's maximum context length is 8192 tokens");
      return "另一家端点的答案";
    });

    const text = await streamChatRouted(
      routed([
        { profileId: "p1" }, // MODEL_A，官方端点：说过太长
        { profileId: "p3" }, // 同 MODEL_A、同端点：应被跳过
        { profileId: "p2", model: MODEL_B }, // 同端点另一个模型：也会先问一次
        { profileId: "p4" }, // MODEL_A，网关端点：值得再问
      ]),
      msg("嗨"),
      { signal: new AbortController().signal, onDelta: vi.fn() },
    );

    expect(text).toBe("另一家端点的答案");
    // p2 也撞上同一条「太长」，p3 与 p1 同端点同模型直接被排除
    expect(ask.mock.calls.map((c) => c[0].id)).toEqual(["p1", "p2", "p4"]);
    expect(llmHealth.entries()).toEqual([]); // overflow 谁都不冷却
  });

  it("已知窗口装不下这条请求的候选在发 HTTP 之前就被排除", async () => {
    ask.mockImplementation(async () => "好");
    const big = "字".repeat(10_000); // ≈10k token：> 8k 模型的窗口，< 128k 模型的窗口

    await streamChatRouted(
      routed([{ profileId: "p1", model: "moonshot-v1-8k" }, { profileId: "p2", model: "gpt-4o" }]),
      msg(big),
      { signal: new AbortController().signal, onDelta: vi.fn() },
    );

    expect(ask.mock.calls.map((c) => c[0].model)).toEqual(["gpt-4o"]);
  });

  it("全被排除时退回整条链（绝不死路）", async () => {
    let calls = 0;
    ask.mockImplementation(async () => {
      if (calls++ === 0) throw new LlmHttpError(429, "Too Many Requests: rate limit exceeded");
      return "好";
    });
    const big = "字".repeat(200_000); // 两个候选的已知窗口都装不下

    const text = await streamChatRouted(
      routed([{ profileId: "p1", model: "moonshot-v1-8k" }, { profileId: "p2", model: "gpt-4o" }]),
      msg(big),
      { signal: new AbortController().signal, onDelta: vi.fn() },
    );

    expect(text).toBe("好");
    expect(ask.mock.calls.map((c) => c[0].model)).toEqual(["moonshot-v1-8k", "gpt-4o"]);
  });
});

describe("休息中的候选排到最后但绝不删除（probeOne）", () => {
  it("全都休息时仍去问最快回来的那一个，答上即清零", async () => {
    llmHealth.mark(accountKey("p1"), rateVerdict);
    llmHealth.mark(accountKey("p2"), rateVerdict);
    ask.mockImplementation(async () => "好");

    await streamChatRouted(routed([{ profileId: "p1" }, { profileId: "p2" }]), msg("嗨"), {
      signal: new AbortController().signal,
      onDelta: vi.fn(),
    });

    // 两条休息一样长 → 按声明序取 p1；它答上了，p2 留着继续休息
    expect(ask.mock.calls.map((c) => c[0].id)).toEqual(["p1"]);
    expect(llmHealth.resting(accountKey("p1"))).toBe(false);
    expect(llmHealth.resting(accountKey("p2"))).toBe(true);
  });

  it("先问醒着的，休息中的留到后面（顺序：醒→声明序，休息→回来早晚）", async () => {
    llmHealth.mark(accountKey("p1"), rateVerdict);
    ask.mockImplementation(async (p) => `${p.id} 的答案`);

    await streamChatRouted(routed([{ profileId: "p1" }, { profileId: "p2" }, { profileId: "p3" }]), msg("嗨"), {
      signal: new AbortController().signal,
      onDelta: vi.fn(),
    });

    expect(ask.mock.calls.map((c) => c[0].id)).toEqual(["p2"]); // p2 醒着且答上了，p1 不再被问
  });
});

describe("瞬时失败的处理（lastRetries / longestPause）", () => {
  it("5xx 先在同一个候选上再问一次（等 1 秒），不换人也不留冷却", async () => {
    vi.useFakeTimers();
    try {
      let failed = 0;
      ask.mockImplementation(async () => {
        if (failed++ === 0) throw new LlmHttpError(500, "Internal Server Error");
        return "第二次成功";
      });

      const running = streamChatRouted(routed([{ profileId: "p1" }, { profileId: "p2" }]), msg("嗨"), {
        signal: new AbortController().signal,
        onDelta: vi.fn(),
      });
      const settled = await vi.runAllTimersAsync().then(() => running);

      expect(settled).toBe("第二次成功");
      expect(ask.mock.calls.map((c) => c[0].id)).toEqual(["p1", "p1"]);
      expect(llmHealth.entries()).toEqual([]); // 一次成功清两档
    } finally {
      vi.useRealTimers();
    }
  });

  it("供应商让等超过 8 秒：别傻等，直接换下一个候选", async () => {
    ask.mockImplementation(async (p) => {
      if (p.id === "p1") throw new LlmHttpError(503, "Internal Server Error", 30_000);
      return "p2 的答案";
    });

    const text = await streamChatRouted(routed([{ profileId: "p1" }, { profileId: "p2" }]), msg("嗨"), {
      signal: new AbortController().signal,
      onDelta: vi.fn(),
    });

    expect(text).toBe("p2 的答案");
    expect(ask.mock.calls.map((c) => c[0].id)).toEqual(["p1", "p2"]); // 没有在 p1 上等 30 秒
  });
});

describe("一次请求的 HTTP 上限", () => {
  it("候选再多也最多问 6 次", async () => {
    useLlmStore.setState({
      profiles: Array.from({ length: 8 }, (_, i) => profile(`p${i + 1}`)),
    });
    ask.mockImplementation(async (p) => {
      throw new LlmHttpError(429, `Too Many Requests: rate limit exceeded (${p.id})`);
    });

    const members: RouteMember[] = Array.from({ length: 8 }, (_, i) => ({ profileId: `p${i + 1}` }));
    await expect(
      streamChatRouted(routed(members), msg("嗨"), {
        signal: new AbortController().signal,
        onDelta: vi.fn(),
      }),
    ).rejects.toBeInstanceOf(LlmHttpError);

    expect(ask).toHaveBeenCalledTimes(6);
  });
});

describe("路由组的成员引用与空链", () => {
  it("成员已被删除时跳过，全删光才报错", async () => {
    ask.mockImplementation(async (p) => `${p.id} 的答案`);

    await expect(
      streamChatRouted(routed([{ profileId: "p1" }, { profileId: "不存在" }]), msg("嗨"), {
        signal: new AbortController().signal,
        onDelta: vi.fn(),
      }),
    ).resolves.toBe("p1 的答案"); // 只剩一个候选 → 透传，仍然答得上

    expect(
      await streamChatRouted(routed([{ profileId: "不存在" }, { profileId: "也不存在" }]), msg("嗨"), {
        signal: new AbortController().signal,
        onDelta: vi.fn(),
      }).catch((e: Error) => e.message),
    ).toContain("候选链为空");
  });
});

describe("逐候选用量留痕（d.48 记账归属）", () => {
  it("成功候选带上这一次调用的用量；调用方的 onUsage 照旧收到它", async () => {
    const up: unknown[] = [];
    ask.mockImplementation(async (p, _m, o) => {
      if (p.id === "p1") throw new LlmHttpError(429, "Too Many Requests: rate limit exceeded");
      o.onUsage?.({ inputTokens: 20, outputTokens: 7, totalTokens: 27 });
      o.onDelta("来自 p2");
      return "来自 p2";
    });
    const attempts: RouteAttempt[] = [];

    await streamChatRouted(routed([{ profileId: "p1" }, { profileId: "p2" }]), msg("嗨"), {
      signal: new AbortController().signal,
      onDelta: vi.fn(),
      onUsage: (u) => up.push(u),
      onAttempt: (a) => attempts.push(a),
    });

    expect(up).toHaveLength(1); // 包一层不改语义：调用方仍收到供应商那份对象
    expect(attempts[1].usage).toEqual({ inputTokens: 20, outputTokens: 7, totalTokens: 27 });
    expect(attempts[0].usage).toBeUndefined(); // 没跑完的那次不带动量
  });

  it("供应商没报用量 → 留痕里 usage 缺省（不补 0，0 是「真的用了 0」）", async () => {
    ask.mockImplementation(async (_p, _m, o) => {
      o.onDelta("好");
      return "好";
    });
    const attempts: RouteAttempt[] = [];

    await streamChatRouted(routed([{ profileId: "p1" }, { profileId: "p2" }]), msg("嗨"), {
      signal: new AbortController().signal,
      onDelta: vi.fn(),
      onAttempt: (a) => attempts.push(a),
    });

    expect(attempts).toHaveLength(1);
    expect(attempts[0].ok).toBe(true);
    expect(attempts[0].usage).toBeUndefined();
  });
});
