/**
 * 测速账本（`fast` 档的数据源）：比较键口径 + 20 分钟半衰 + 条数上限。
 *
 * 这里不碰网络也不碰路由：只验证 `lib/llmSpeed.ts` 的确定性算术。
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  LlmSpeed,
  MAX_SPEED_SAMPLES,
  SPEED_HALF_LIFE_MS,
  metricOf,
  llmSpeed,
} from "./llmSpeed.js";

beforeEach(() => {
  llmSpeed.reset();
});

describe("比较键（首 token + 200 token 用时）", () => {
  it("TTFT + 200 个 token 的生成用时", () => {
    // 首 token 100ms；10 个 token 用了 500ms → 每 token 50ms → 200 token = 10000ms
    expect(metricOf({ ttftMs: 100, outputTokens: 10, elapsedMs: 600 })).toBe(100 + 200 * 50);
  });

  it("没有输出 token：只留首 token 时延（不拿整段用时冒充生成速度）", () => {
    expect(metricOf({ ttftMs: 250, outputTokens: 0, elapsedMs: 900 })).toBe(250);
    expect(metricOf({ ttftMs: 250, elapsedMs: 900 })).toBe(250);
  });

  it("总用时短于 TTFT（时钟抖动）按 TTFT 算，生成耗时为 0", () => {
    expect(metricOf({ ttftMs: 300, outputTokens: 10, elapsedMs: 100 })).toBe(300);
  });

  it("负数夹到 0：坏样本不翻转排序", () => {
    expect(metricOf({ ttftMs: -50, outputTokens: 10, elapsedMs: -10 })).toBe(0);
  });
});

describe("记录与读取", () => {
  it("没测过速 → undefined（调用方据此排到测过的后面）", () => {
    expect(llmSpeed.rankOf("p1", "m")).toBeUndefined();
    expect(llmSpeed.sampleOf("p1", "m")).toBeUndefined();
  });

  it("首条样本即比较键，样本数从 1 开始", () => {
    llmSpeed.record("p1", "m", { ttftMs: 100, outputTokens: 10, elapsedMs: 600 });
    expect(llmSpeed.rankOf("p1", "m")).toBe(10_100);
    expect(llmSpeed.sampleOf("p1", "m")?.samples).toBe(1);
  });

  it("不同连接/模型互不影响", () => {
    llmSpeed.record("p1", "m", { ttftMs: 100, outputTokens: 0, elapsedMs: 100 });
    expect(llmSpeed.rankOf("p2", "m")).toBeUndefined();
    expect(llmSpeed.rankOf("p1", "m2")).toBeUndefined();
  });

  it("20 分钟后的新样本：旧值权重减半（时间加权平均）", () => {
    const t0 = 1_760_000_000_000;
    const speed = new LlmSpeed();
    speed.record("p1", "m", { ttftMs: 1000, outputTokens: 0, elapsedMs: 1000 }, t0);
    speed.record(
      "p1",
      "m",
      { ttftMs: 3000, outputTokens: 0, elapsedMs: 3000 },
      t0 + SPEED_HALF_LIFE_MS,
    );
    // (1000 × 0.5 + 3000) / (0.5 + 1) = 2333.33…
    expect(speed.rankOf("p1", "m")).toBeCloseTo(7000 / 3, 5);
    expect(speed.sampleOf("p1", "m")?.samples).toBe(2);
  });

  it("刚记完的样本不减权：连续两次同速样本仍是同一个值", () => {
    const speed = new LlmSpeed();
    speed.record("p1", "m", { ttftMs: 500, outputTokens: 0, elapsedMs: 500 }, 1000);
    speed.record("p1", "m", { ttftMs: 500, outputTokens: 0, elapsedMs: 500 }, 1000);
    expect(speed.rankOf("p1", "m")).toBe(500);
  });

  it(`最多留 ${MAX_SPEED_SAMPLES} 条：超了淘汰最久未更新的`, () => {
    const speed = new LlmSpeed();
    for (let i = 0; i < MAX_SPEED_SAMPLES; i++) {
      speed.record(`p${i}`, "m", { ttftMs: 1, outputTokens: 0, elapsedMs: 1 }, 1000 + i);
    }
    expect(speed.size()).toBe(MAX_SPEED_SAMPLES);

    speed.record("new", "m", { ttftMs: 1, outputTokens: 0, elapsedMs: 1 }, 10_000);
    expect(speed.size()).toBe(MAX_SPEED_SAMPLES);
    expect(speed.rankOf("p0", "m")).toBeUndefined(); // 最旧的被淘汰
    expect(speed.rankOf("new", "m")).toBe(1);
  });

  it("reset 清空（重启语义；生产不调用）", () => {
    llmSpeed.record("p1", "m", { ttftMs: 1, outputTokens: 0, elapsedMs: 1 });
    expect(llmSpeed.size()).toBe(1);
    llmSpeed.reset();
    expect(llmSpeed.size()).toBe(0);
    expect(llmSpeed.rankOf("p1", "m")).toBeUndefined();
  });
});
