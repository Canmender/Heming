import { beforeEach, describe, expect, it } from "vitest";
import { LlmHealth, accountKey, modelKey, restDurationMs } from "./llmHealth.js";
import { createMemoryStorage } from "./memory/storage.js";
import type { FailureVerdict } from "./llmFailure.js";

const MIN = 60_000;

const verdict = (kind: FailureVerdict["kind"], scope: FailureVerdict["scope"] = "account"): FailureVerdict => ({
  kind,
  rests: true,
  scope,
  failover: true,
});

function fresh() {
  return new LlmHealth(createMemoryStorage());
}

describe("速率限制阶梯（magpie rateRest）", () => {
  it("第一次 1 分钟；每次在休息结束时立刻再犯就翻倍", () => {
    const h = fresh();
    const k = accountKey("p1");
    let now = 0;
    const rungs: number[] = [];
    for (let i = 0; i < 4; i++) {
      const rec = h.mark(k, verdict("rate"), { now })!;
      rungs.push(rec.until - now);
      now = rec.until + 1; // 刚好在休息结束时又撞上 429
    }
    expect(rungs).toEqual([1 * MIN, 2 * MIN, 4 * MIN, 8 * MIN]);
  });

  it("还在休息中又失败不加档（同一次请求自己的重试不该拉长它）", () => {
    const h = fresh();
    const k = accountKey("p1");
    expect(h.mark(k, verdict("rate"), { now: 0 })!.until).toBe(1 * MIN);
    const second = h.mark(k, verdict("rate"), { now: 10_000 })!;
    expect(second.until - 10_000).toBe(1 * MIN);
    expect(second.failures).toBe(1);
  });

  it("连续再犯封顶在 30 分钟，不再往上翻", () => {
    const h = fresh();
    const k = accountKey("p1");
    let now = 0;
    let last = 0;
    for (let i = 0; i < 12; i++) {
      const rec = h.mark(k, verdict("rate"), { now })!;
      last = rec.until - now;
      now = rec.until + 1;
    }
    expect(last).toBe(30 * MIN);
  });

  it("安静超过 30 分钟后重新开始算（rateForget）", () => {
    const h = fresh();
    const k = accountKey("p1");
    const first = h.mark(k, verdict("rate"), { now: 0 })!;
    const lateAt = first.until + 31 * MIN;
    expect(h.mark(k, verdict("rate"), { now: lateAt })!.until - lateAt).toBe(1 * MIN);
  });

  it("供应商说了 Retry-After 且更长就听它的，但不超 1 小时（longestWait）", () => {
    const h = fresh();
    const k = accountKey("p1");
    expect(h.mark(k, verdict("rate"), { now: 0, retryAfterMs: 5 * MIN })!.until).toBe(5 * MIN);
    const h2 = fresh();
    expect(h2.mark(k, verdict("rate"), { now: 0, retryAfterMs: 5 * 60 * MIN })!.until).toBe(60 * MIN);
  });
});

describe("余额与额度（magpie creditLadder / quotaRest）", () => {
  it("credit 走长阶梯：30 分钟 → 2 小时 → 8 小时", () => {
    const h = fresh();
    const k = accountKey("p1");
    expect(h.mark(k, verdict("credit"), { now: 0 })!.until).toBe(30 * MIN);
    expect(h.mark(k, verdict("credit"), { now: 30 * MIN })!.until - 30 * MIN).toBe(2 * 60 * MIN);
    expect(h.mark(k, verdict("credit"), { now: 3 * 60 * MIN })!.until - 3 * 60 * MIN).toBe(8 * 60 * MIN);
  });

  it("quota 什么都没说时休息 15 分钟", () => {
    const h = fresh();
    expect(h.mark(accountKey("p1"), verdict("quota"), { now: 0 })!.until).toBe(15 * MIN);
  });

  it("说不出所以然的失败封顶 10 分钟（longestRetry）", () => {
    const h = fresh();
    const k = accountKey("p1");
    let now = 0;
    for (let i = 0; i < 8; i++) now = h.mark(k, verdict("transient"), { now })!.until + 1;
    expect(h.mark(k, verdict("transient"), { now })!.until - now).toBeLessThanOrEqual(10 * MIN);
  });
});

describe("不冷却的失败原样返回 null", () => {
  it("shape/overflow/protection/fatal 不进休息名单", () => {
    const h = fresh();
    const v: FailureVerdict = { kind: "shape", rests: false, scope: "account", failover: true };
    expect(h.mark(accountKey("p1"), v, { now: 0 })).toBeNull();
    expect(h.entries(0)).toEqual([]);
  });
});

describe("作用域两档（magpie restKey / restID）", () => {
  it("「这个 Key 不供这个模型」只关这个模型，同 Key 其他模型照问", () => {
    const h = fresh();
    h.mark(modelKey("p1", "glm-4.6"), verdict("modelGone", "model"), { now: 0 });
    expect(h.resting(modelKey("p1", "glm-4.6"), 1000)).toBe(true);
    expect(h.resting(accountKey("p1"), 1000)).toBe(false);
    expect(h.resting(modelKey("p1", "glm-4-flash"), 1000)).toBe(false);
  });
});

describe("成功清零与更长优先", () => {
  it("一次成功同时清掉休息与失败计数", () => {
    const h = fresh();
    const k = accountKey("p1");
    h.mark(k, verdict("rate"), { now: 0 });
    h.mark(k, verdict("rate"), { now: MIN });
    h.clear(k);
    expect(h.resting(k, MIN + 1)).toBe(false);
    // 档位归零：下一次失败又是 1 分钟
    expect(h.mark(k, verdict("rate"), { now: MIN + 1 })!.until - (MIN + 1)).toBe(1 * MIN);
  });

  it("更长的休息不被更短的覆盖", () => {
    const h = fresh();
    const k = accountKey("p1");
    h.mark(k, verdict("credit"), { now: 0 }); // 30 分钟
    const after = h.mark(k, verdict("rate"), { now: 1000 }); // 1 分钟
    expect(after!.until).toBe(30 * MIN); // 仍是 credit 的那次
  });

  it("unrest 立刻恢复（界面上的「立即恢复」）", () => {
    const h = fresh();
    const k = accountKey("p1");
    h.mark(k, verdict("restricted"), { now: 0 });
    expect(h.resting(k, 1000)).toBe(true);
    h.unrest(k);
    expect(h.resting(k, 1000)).toBe(false);
  });
});

describe("soonestBack：绝不死路（magpie probeOne）", () => {
  it("有醒着的就选它（保持声明顺序）", () => {
    const h = fresh();
    const awake = accountKey("p2");
    h.mark(accountKey("p1"), verdict("rate"), { now: 0 });
    expect(h.soonestBack([accountKey("p1"), awake], 1000)).toBe(awake);
  });

  it("全在休息时挑最快回来的那个，而不是丢弃", () => {
    const h = fresh();
    const a = accountKey("p1");
    const b = accountKey("p2");
    h.mark(a, verdict("rate"), { now: 0 }); // 1 分钟
    h.mark(b, verdict("credit"), { now: 0 }); // 30 分钟
    expect(h.soonestBack([b, a], 1000)).toBe(a);
  });

  it("过期记录被顺手清掉，账本不会越长越大", () => {
    const h = fresh();
    const k = accountKey("p1");
    h.mark(k, verdict("rate"), { now: 0 });
    expect(h.entries(MIN * 2)).toEqual([]);
    expect(h.resting(k, MIN * 2)).toBe(false);
  });
});
