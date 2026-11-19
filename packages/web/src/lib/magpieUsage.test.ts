import { afterEach, describe, expect, it, vi } from "vitest";
import {
  averageTTFT,
  breakdownOf,
  bucketLabel,
  chartBars,
  describeRequestTries,
  describeRequestWait,
  fetchUsage,
  fetchUsageRequests,
  formatCost,
  formatTokens,
  pointTTFT,
  type UsageRequestRow,
  type UsageSeriesPoint,
  type UsageSummary,
} from "./magpieUsage.js";

/** 用量数据层（d.110）：读内核用量 JSON + 纯展示函数。 */

afterEach(() => vi.unstubAllGlobals());

const usageJson = {
  period: "30d",
  since: "2026-10-10T00:00:00+08:00",
  calls: 4,
  errors: 1,
  input: 1200,
  output: 800,
  cache_read: 300,
  cache_write: 0,
  cost: 0.25,
  unpriced: 2,
  series: [
    { label: "Oct 10", time: "t1", calls: 0, errors: 0, input: 0, output: 0, cost: 0, unpriced: 0 },
    { label: "Oct 11", time: "t2", calls: 4, errors: 1, input: 1200, output: 800, cost: 0.25, unpriced: 2 },
  ],
  agents: [
    { id: "heming", name: "和鸣", calls: 4, errors: 1, input: 1200, output: 800, cost: 0.25 },
    { id: "claude", name: "Claude", calls: 2, errors: 0, input: 100, output: 50, cost: 0 },
  ],
  models: [
    { id: "mock/mock-model", provider: "mock", model: "mock/mock-model", calls: 4, input: 1200, output: 800, cost: 0.25 },
  ],
  accounts: [],
};

describe("fetchUsage / fetchUsageRequests", () => {
  it("解析用量 JSON：数字缺省为 0、拆分数组收敛", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify(usageJson), { status: 200, headers: { "content-type": "application/json" } }),
      ),
    );
    const summary = await fetchUsage("http://127.0.0.1:4000/v1", "30d");
    expect(summary.calls).toBe(4);
    expect(summary.errors).toBe(1);
    expect(summary.series).toHaveLength(2);
    expect(summary.agents).toHaveLength(2);
    expect(summary.models[0]).toMatchObject({ calls: 4, model: "mock/mock-model" });
    expect(String(vi.mocked(fetch).mock.calls[0][0])).toContain("/magpie/usage?period=30d");
  });

  it("解析请求明细：首字、拆分与重试都读得出来；HTTP 错误给人话", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            period: "7d",
            total: 1,
            rows: [
              {
                route_id: 7,
                t: "2026-11-08T10:00:00Z",
                agent: "heming",
                model: "m",
                req: "mock/m",
                in: 3,
                out: 5,
                ms: 900,
                ttft_ms: 720,
                first_text_ms: 800,
                sent_ms: 600,
                own_ms: 100,
                retried_ms: 200,
                queued_ms: 50,
                flow_ms: 120,
                tries: 2,
                handed_on: true,
                err: "rate limited",
                err_type: "rate_limit_error",
                stop: "end_turn",
                status: 429,
                cost: 0,
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    const requests = await fetchUsageRequests("http://x/v1", "7d", 5);
    expect(requests.total).toBe(1);
    expect(requests.rows[0]).toMatchObject({
      agent: "heming",
      in: 3,
      out: 5,
      status: 429,
      ttft: 720,
      firstText: 800,
      sent: 600,
      own: 100,
      retried: 200,
      queued: 50,
      flow: 120,
      tries: 2,
      handedOn: true,
      err: "rate limited",
      errType: "rate_limit_error",
      stop: "end_turn",
    });

    vi.stubGlobal("fetch", vi.fn(async () => new Response("no", { status: 500 })));
    await expect(fetchUsage("http://x/v1", "today")).rejects.toThrow(/HTTP 500/);
  });

  it("老记录里没有首字与重试：就不编一个出来", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            period: "7d",
            total: 1,
            rows: [{ route_id: 1, t: "t", agent: "a", model: "m", req: "", in: 0, out: 0, ms: 61, status: 200, cost: 0 }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    const requests = await fetchUsageRequests("http://x/v1", "7d", 5);
    expect(requests.rows[0]?.ttft).toBeUndefined();
    expect(requests.rows[0]?.tries).toBeUndefined();
    expect(requests.rows[0]?.handedOn).toBe(false);
    expect(requests.rows[0]?.err).toBeUndefined();
  });
});

describe("展示函数", () => {
  it("formatTokens 紧凑显示；formatCost 处理未定价", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(1200)).toBe("1.2k");
    expect(formatTokens(3_400_000)).toBe("3.4M");
    expect(formatCost(0, 2)).toBe("未定价");
    expect(formatCost(0)).toBe("0");
    expect(formatCost(0.25)).toBe("0.2500");
    expect(formatCost(12.345, 1)).toContain("未定价");
  });

  it("chartBars：按指标取高度比例，并抽稀标签", () => {
    const series = Array.from({ length: 30 }, (_, i) => ({
      label: `d${i}`,
      time: String(i),
      calls: i,
      errors: 0,
      input: i * 10,
      output: i,
      cost: 0,
      unpriced: 0,
    }));
    const bars = chartBars(series, "calls");
    expect(bars).toHaveLength(30);
    expect(bars[29]!.ratio).toBeCloseTo(1);
    expect(bars.filter((bar) => bar.showLabel).length).toBeLessThan(10);
    expect(chartBars(series, "tokens")[10]!.value).toBe(110);
  });

  it("breakdownOf 按调用次数排序并截断；bucketLabel 按维度取名", () => {
    const summary = usageJson as unknown as UsageSummary;
    expect(breakdownOf(summary, "agents").map((item) => item.id)).toEqual(["heming", "claude"]);
    expect(bucketLabel({ id: "x", name: "小鸣", calls: 1, errors: 0, input: 0, output: 0, cost: 0 }, "agents")).toBe("小鸣");
    expect(bucketLabel({ id: "p/m", model: "p/m", calls: 1, errors: 0, input: 0, output: 0, cost: 0 }, "models")).toBe("p/m");
  });

  it("describeRequestWait 把首字拆开说：和鸣自己、先失败的那几次、排队、上游", () => {
    const full = { ttft: 720, sent: 600, own: 100, retried: 200, queued: 50 } as unknown as UsageRequestRow;
    expect(describeRequestWait(full)).toBe("首字 720ms（和鸣自己 100ms、先失败的那几次 200ms、排队 50ms、上游 250ms）");
    expect(describeRequestWait({ ttft: 500 } as unknown as UsageRequestRow)).toBe("首字 500ms");
    expect(describeRequestWait({ ms: 900 } as unknown as UsageRequestRow)).toBe("");
  });

  it("describeRequestTries：试了多次才成、这一试失败交了班、只试一次都不提", () => {
    expect(describeRequestTries({ tries: 3 } as unknown as UsageRequestRow)).toBe("试了 3 次");
    expect(describeRequestTries({ tries: 2, handedOn: true } as unknown as UsageRequestRow)).toBe("这一试失败，交给了下一条");
    expect(describeRequestTries({ tries: 1 } as unknown as UsageRequestRow)).toBe("");
    expect(describeRequestTries({} as unknown as UsageRequestRow)).toBe("");
  });

  it("averageTTFT：只算真被计时的流式回复，没计时就不给数", () => {
    expect(averageTTFT({ id: "m", calls: 4, errors: 0, input: 0, output: 0, cost: 0, timed: 4, ttft_ms: 3200 })).toBe(800);
    expect(averageTTFT({ id: "m", calls: 4, errors: 0, input: 0, output: 0, cost: 0, timed: 0, ttft_ms: 3200 })).toBeNull();
    expect(averageTTFT({ id: "m", calls: 4, errors: 0, input: 0, output: 0, cost: 0 })).toBeNull();
  });

  it("按天的首字：有计时的天才给数，柱状图按这个指标取平均", () => {
    const series: UsageSeriesPoint[] = [
      { label: "11-06", time: "", calls: 2, errors: 0, input: 0, output: 0, cost: 0, unpriced: 0 },
      { label: "11-07", time: "", calls: 3, errors: 0, input: 0, output: 0, cost: 0, unpriced: 0, timed: 2, ttft_ms: 1600 },
      { label: "11-08", time: "", calls: 5, errors: 0, input: 0, output: 0, cost: 0, unpriced: 0, timed: 4, ttft_ms: 1200 },
    ];
    expect(pointTTFT(series[0]!)).toBeNull();
    expect(pointTTFT(series[1]!)).toBe(800);
    const bars = chartBars(series, "ttft");
    expect(bars.map((bar) => bar.value)).toEqual([0, 800, 300]);
    expect(bars[2]!.ratio).toBeCloseTo(300 / 800);
    expect(chartBars(series, "calls").map((bar) => bar.value)).toEqual([2, 3, 5]);
  });
});
