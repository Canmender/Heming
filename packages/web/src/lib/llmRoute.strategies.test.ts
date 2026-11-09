/**
 * 选路策略（magpie 移植第二批）：八档各自的排序规则 + 轮询状态。
 *
 * 本地「模型路由」模块已删除（由 magpie 路由组取代），所以这里不再有模块闸门用例。
 *
 * 断言口径：用假 `streamChat` 把「候选被问的顺序」原样记录下来——
 * 让所有候选都 429（4xx 里明确是限流的那类，不会触发同候选重试），
 * 就能一次看到整条排序；轮询档则用「第一个答上的就是被选中的」逐轮观察。
 * 时间用假时钟冻结在月中，用量/衰减/pace 的分母都是确定值。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LlmHttpError, streamChat, type ChatMessage } from "./llmClient.js";
import { resetRouteStrategyState, streamChatRouted, type RoutedProfile } from "./llmRoute.js";
import { accountKey, llmHealth } from "./llmHealth.js";
import { llmSpeed } from "./llmSpeed.js";
import {
  useLlmStore,
  type LlmProfile,
  type RouteGroup,
  type RouteMember,
  type RouteStrategy,
} from "../store/llm.js";
import { useTokenUsageStore, type UsageRecord } from "../store/tokenUsage.js";

vi.mock("./llmClient.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("./llmClient.js")>();
  return { ...mod, streamChat: vi.fn() };
});

const ask = vi.mocked(streamChat);

/** 能力表查不到的名字 = 窗口未知/无价目，用来验证「不知道就排最后」。 */
const MODEL_A = "testmodel-alpha";
/** 参考价 12+12=24（贵）。 */
const MODELS_PRICED = {
  expensive: "moonshot-v1-8k",
  cheap: "deepseek-chat",
} as const;

/** 2026-11-15 12:00（+08）——月中，任何时区都还是 11 月。 */
const NOW = new Date("2026-11-15T12:00:00+08:00").getTime();

const msg = (content: string): ChatMessage[] => [{ role: "user", content }];
const signal = (): AbortSignal => new AbortController().signal;
const rateVerdict = { kind: "rate", rests: true, scope: "account", failover: true } as const;

function profile(id: string, model = MODEL_A): LlmProfile {
  return { id, label: id, provider: "openai", apiKey: `sk-${id}`, model };
}

function routed(members: RouteMember[], strategy?: RouteStrategy): RoutedProfile {
  const group: RouteGroup = {
    id: "g1",
    label: "候选链",
    members,
    ...(strategy ? { strategy } : {}),
  };
  return { ...profile(`route.${group.id}`, members[0]?.model ?? MODEL_A), label: group.label, route: group };
}

/** 只装这些连接（其余绝不残留：排序完全由本用例的数据决定）。 */
function setProfiles(entries: readonly (readonly [string, string])[]): void {
  useLlmStore.setState({
    profiles: entries.map(([id, model]) => profile(id, model ?? MODEL_A)),
    routes: [],
    bindings: {},
  });
}

const hoursAgo = (h: number): string => new Date(NOW - h * 3_600_000).toISOString();

const usage = (
  profileId: string,
  model: string,
  tokens: number,
  at: string,
): UsageRecord => ({ profileId, profileLabel: profileId, model, tokens, at });

/**
 * 让所有候选都 429 → 记录整条排序（限流不会触发「同一候选再问一次」）。
 * 返回被问的 profile id 序列。
 */
async function orderOf(head: RoutedProfile): Promise<string[]> {
  ask.mockReset();
  ask.mockImplementation(async (p) => {
    throw new LlmHttpError(429, `Too Many Requests: rate limit exceeded (${p.id})`);
  });
  await streamChatRouted(head, msg("嗨"), { signal: signal(), onDelta: vi.fn() }).catch(() => {});
  return ask.mock.calls.map((c) => c[0].id);
}

/** 让第一个被问的候选直接答上（观察轮询档「这次轮到谁」）。 */
function answerAll(): void {
  ask.mockImplementation(async (p, _m, o) => {
    o.onDelta(`${p.id} 好`);
    return `${p.id} 好`;
  });
}

/** 走一次路由并返回这次被选中的候选 id（轮询档专用）。 */
async function pick(head: RoutedProfile): Promise<string> {
  const before = ask.mock.calls.length;
  await streamChatRouted(head, msg("嗨"), { signal: signal(), onDelta: vi.fn() });
  return ask.mock.calls[before][0].id;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  ask.mockReset();
  llmHealth.reset();
  llmSpeed.reset();
  resetRouteStrategyState();
  useTokenUsageStore.setState({ records: [] });
  useLlmStore.setState({ profiles: [], routes: [], bindings: {} });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("order（老数据缺省档：零迁移、行为不变）", () => {
  it("strategy 缺失 = 声明顺序，价目/用量数据都不影响", async () => {
    setProfiles([
      ["p1", MODELS_PRICED.expensive],
      ["p2", MODELS_PRICED.cheap],
    ]);
    // 这些数据会让 cheap/usage 档把 p2 排前面；order 档必须原地不动
    useTokenUsageStore.setState({
      records: [usage("p1", MODELS_PRICED.expensive, 999_999, hoursAgo(1))],
    });

    expect(await orderOf(routed([{ profileId: "p1" }, { profileId: "p2" }]))).toEqual([
      "p1",
      "p2",
    ]);
  });
});

describe("smart（本月用量 / 近期失败 综合打分，d.93 起无价格维度）", () => {
  it("用量少 + 无失败史的排前面；有失败史的不占首发", async () => {
    setProfiles([
      ["p1", MODELS_PRICED.expensive],
      ["p2", MODELS_PRICED.cheap],
      ["p3", MODEL_A],
    ]);
    useTokenUsageStore.setState({
      records: [
        usage("p1", MODELS_PRICED.expensive, 100_000, hoursAgo(1)),
        usage("p2", MODELS_PRICED.cheap, 1_000, hoursAgo(1)),
      ],
    });
    // p3 有一档近期失败（1 分钟休息），2 分钟后已过期：既不在休息，也留下失败史
    llmHealth.mark(accountKey("p3"), rateVerdict);
    vi.advanceTimersByTime(2 * 60_000);

    // p1 = .65×1.0 + .35×0 = .650
    // p2 = .65×.01 + .35×0 = .0065
    // p3 = .65×0 + .35×1.0 = .350
    expect(
      await orderOf(
        routed([{ profileId: "p1" }, { profileId: "p2" }, { profileId: "p3" }], "smart"),
      ),
    ).toEqual(["p2", "p3", "p1"]);
  });

  it("其它条件相同：有近期失败的排后面", async () => {
    setProfiles([
      ["p4", MODEL_A],
      ["p5", MODEL_A],
    ]);
    llmHealth.mark(accountKey("p5"), rateVerdict);
    vi.advanceTimersByTime(2 * 60_000);

    expect(await orderOf(routed([{ profileId: "p4" }, { profileId: "p5" }], "smart"))).toEqual([
      "p4",
      "p5",
    ]);
  });

  it("一点数据都没有时 ≡ 声明顺序（同分按声明序）", async () => {
    setProfiles([
      ["p4", MODEL_A],
      ["p5", MODEL_A],
    ]);
    expect(await orderOf(routed([{ profileId: "p4" }, { profileId: "p5" }], "smart"))).toEqual([
      "p4",
      "p5",
    ]);
  });

  it("休息中的候选永远排最后：数据再好也只能排在醒着的后面（且绝不删除）", async () => {
    setProfiles([
      ["p6", MODELS_PRICED.cheap],
      ["p7", MODELS_PRICED.expensive],
    ]);
    // p6 本会赢（更便宜、零用量），但在休息 → 排最后；它仍在链里（会被问到）
    llmHealth.mark(accountKey("p6"), rateVerdict);
    expect(await orderOf(routed([{ profileId: "p6" }, { profileId: "p7" }], "smart"))).toEqual([
      "p7",
      "p6",
    ]);
  });
});

describe("usage（Least used：本月用量升序，1 小时半衰）", () => {
  it("按衰减后的用量排序：两小时前的 1000 比半小时前的 500 更靠前", async () => {
    setProfiles([
      ["p1", MODELS_PRICED.expensive],
      ["p2", MODELS_PRICED.cheap],
      ["p3", MODEL_A],
    ]);
    useTokenUsageStore.setState({
      records: [
        usage("p1", MODELS_PRICED.expensive, 1_000, hoursAgo(2)), // 衰减到 250
        usage("p2", MODELS_PRICED.cheap, 500, hoursAgo(0.5)), // 衰减到 ≈353.6
      ],
    });

    // 未衰减口径是 p3 < p2 < p1；半衰把 p1 拉到 p2 前面
    expect(
      await orderOf(
        routed([{ profileId: "p1" }, { profileId: "p2" }, { profileId: "p3" }], "usage"),
      ),
    ).toEqual(["p3", "p1", "p2"]);
  });

  it("上个月的用量不算本月（月窗口之外一律不参与）", async () => {
    setProfiles([
      ["p1", MODELS_PRICED.expensive],
      ["p2", MODELS_PRICED.cheap],
    ]);
    useTokenUsageStore.setState({
      records: [
        usage("p1", MODELS_PRICED.expensive, 999_999, new Date("2026-10-20T12:00:00+08:00").toISOString()),
      ],
    });
    expect(await orderOf(routed([{ profileId: "p1" }, { profileId: "p2" }], "usage"))).toEqual([
      "p1",
      "p2",
    ]);
  });
});

describe("pace（本月用量 ÷ 本月已过时间比例）", () => {
  it("花得比时间慢的先问（比值升序）；不假装有配额", async () => {
    setProfiles([
      ["p1", MODELS_PRICED.expensive],
      ["p2", MODELS_PRICED.cheap],
      ["p3", MODEL_A],
    ]);
    useTokenUsageStore.setState({
      records: [
        usage("p1", MODELS_PRICED.expensive, 2_000, hoursAgo(5)),
        usage("p2", MODELS_PRICED.cheap, 1_000, hoursAgo(5)),
      ],
    });
    expect(
      await orderOf(
        routed([{ profileId: "p1" }, { profileId: "p2" }, { profileId: "p3" }], "pace"),
      ),
    ).toEqual(["p3", "p2", "p1"]);
  });
});

describe("weight（平滑加权轮询）", () => {
  it("3:1 的前四轮序列是 p1, p1, p2, p1（平滑分布，不是连续四次同一个人）", async () => {
    setProfiles([
      ["p1", MODEL_A],
      ["p2", MODEL_A],
    ]);
    answerAll();
    const head = routed(
      [
        { profileId: "p1", weight: 3 },
        { profileId: "p2", weight: 1 },
      ],
      "weight",
    );
    const picks = [await pick(head), await pick(head), await pick(head), await pick(head)];
    expect(picks).toEqual(["p1", "p1", "p2", "p1"]);
  });

  it("权重缺省 1：均分轮询（1:1 → p1, p2, p1, p2）", async () => {
    setProfiles([
      ["p1", MODEL_A],
      ["p2", MODEL_A],
    ]);
    answerAll();
    const head = routed([{ profileId: "p1" }, { profileId: "p2" }], "weight");
    const picks = [await pick(head), await pick(head), await pick(head), await pick(head)];
    expect(picks).toEqual(["p1", "p2", "p1", "p2"]);
  });

  it("休息中的候选不参与轮询（全轮到醒着的那个）", async () => {
    setProfiles([
      ["p1", MODEL_A],
      ["p2", MODEL_A],
    ]);
    llmHealth.mark(accountKey("p2"), rateVerdict);
    answerAll();
    const head = routed(
      [
        { profileId: "p1" },
        { profileId: "p2", weight: 5 },
      ],
      "weight",
    );
    expect([await pick(head), await pick(head), await pick(head)]).toEqual(["p1", "p1", "p1"]);
  });

  it("reset 让轮询从头开始（重启语义）", async () => {
    setProfiles([
      ["p1", MODEL_A],
      ["p2", MODEL_A],
    ]);
    answerAll();
    const head = routed([{ profileId: "p1" }, { profileId: "p2" }], "weight");
    expect(await pick(head)).toBe("p1");
    resetRouteStrategyState();
    expect(await pick(head)).toBe("p1");
    expect(await pick(head)).toBe("p2");
  });
});

describe("rotate（轮流用）", () => {
  it("三次请求依次 p1 → p2 → p3；休息的跳过", async () => {
    setProfiles([
      ["p1", MODEL_A],
      ["p2", MODEL_A],
      ["p3", MODEL_A],
    ]);
    answerAll();
    const head = routed(
      [{ profileId: "p1" }, { profileId: "p2" }, { profileId: "p3" }],
      "rotate",
    );
    expect([await pick(head), await pick(head), await pick(head)]).toEqual(["p1", "p2", "p3"]);

    llmHealth.mark(accountKey("p2"), rateVerdict);
    expect([await pick(head), await pick(head)]).toEqual(["p1", "p3"]);
  });

  it("全在休息时仍问最快回来的那个（probeOne 语义不动）", async () => {
    setProfiles([
      ["p1", MODEL_A],
      ["p2", MODEL_A],
      ["p3", MODEL_A],
    ]);
    // 先被打入休息的回来得更早：p3 → p2 → p1
    llmHealth.mark(accountKey("p3"), rateVerdict);
    vi.advanceTimersByTime(1_000);
    llmHealth.mark(accountKey("p2"), rateVerdict);
    vi.advanceTimersByTime(1_000);
    llmHealth.mark(accountKey("p1"), rateVerdict);

    expect(
      await orderOf(
        routed([{ profileId: "p1" }, { profileId: "p2" }, { profileId: "p3" }], "rotate"),
      ),
    ).toEqual(["p3", "p2", "p1"]);
  });
});

describe("fast（速度优先：首 token + 200 token 用时）", () => {
  it("一条测速数据都没有 → 退化为声明顺序", async () => {
    setProfiles([
      ["p1", MODEL_A],
      ["p2", MODEL_A],
    ]);
    expect(await orderOf(routed([{ profileId: "p1" }, { profileId: "p2" }], "fast"))).toEqual([
      "p1",
      "p2",
    ]);
  });

  it("测过速的排前面，按比较键从快到慢；没测过的垫底", async () => {
    setProfiles([
      ["p1", MODEL_A],
      ["p2", MODEL_A],
      ["p3", MODEL_A],
    ]);
    // 比较键：ttft + 200 × 单 token 生成耗时
    llmSpeed.record("p1", MODEL_A, { ttftMs: 0, outputTokens: 200, elapsedMs: 5_000 });
    llmSpeed.record("p2", MODEL_A, { ttftMs: 0, outputTokens: 200, elapsedMs: 1_000 });

    expect(
      await orderOf(routed([{ profileId: "p1" }, { profileId: "p2" }, { profileId: "p3" }], "fast")),
    ).toEqual(["p2", "p1", "p3"]);
  });

  it("同一档（500ms 粒度）内保持声明顺序，不为几十毫秒抖动换人", async () => {
    setProfiles([
      ["p1", MODEL_A],
      ["p2", MODEL_A],
    ]);
    llmSpeed.record("p1", MODEL_A, { ttftMs: 0, outputTokens: 200, elapsedMs: 1_100 });
    llmSpeed.record("p2", MODEL_A, { ttftMs: 0, outputTokens: 200, elapsedMs: 1_200 });
    expect(await orderOf(routed([{ profileId: "p1" }, { profileId: "p2" }], "fast"))).toEqual([
      "p1",
      "p2",
    ]);
  });

  it("每第 5 个请求给没测过速的候选一次先手（防饿死）", async () => {
    setProfiles([
      ["p1", MODEL_A],
      ["p2", MODEL_A],
    ]);
    llmSpeed.record("p1", MODEL_A, { ttftMs: 0, outputTokens: 200, elapsedMs: 1_000 });
    answerAll();
    const head = routed([{ profileId: "p1" }, { profileId: "p2" }], "fast");
    const picks = [await pick(head), await pick(head), await pick(head), await pick(head), await pick(head)];
    expect(picks).toEqual(["p1", "p1", "p1", "p1", "p2"]);
  });

  it("真实路由调用会顺手记下测速样本（不用主动探测）", async () => {
    setProfiles([
      ["p1", MODEL_A],
      ["p2", MODEL_A],
    ]);
    answerAll();
    // 先按声明序问一次 p1：被选中的候选留下一条测速样本
    await streamChatRouted(routed([{ profileId: "p1" }, { profileId: "p2" }], "order"), msg("嗨"), {
      signal: signal(),
      onDelta: vi.fn(),
    });
    // 假时钟冻结 → TTFT 0、总用时 0 → 比较键 0（只验证「记上了」，不验证真实毫秒）
    expect(llmSpeed.rankOf("p1", MODEL_A)).toBe(0);
    expect(llmSpeed.rankOf("p2", MODEL_A)).toBeUndefined();

    // 声明序是 p2 在前，但 p1 测过速 → fast 先问 p1
    expect(await orderOf(routed([{ profileId: "p2" }, { profileId: "p1" }], "fast"))).toEqual([
      "p1",
      "p2",
    ]);
  });
});
