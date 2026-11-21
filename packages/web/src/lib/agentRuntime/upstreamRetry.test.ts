import { describe, it, expect } from "vitest";
import {
  describeUpstreamError,
  isAbortError,
  isRetryableUpstreamError,
  MAX_UPSTREAM_DELAY_MS,
  MAX_UPSTREAM_RETRIES,
  retryDelayMs,
  upstreamStatusOf,
} from "./upstreamRetry.js";

/** 造一个带 status 的错误（真实链路上是 llmClient 的 LlmHttpError）。 */
function httpError(status: number, retryAfterMs = 0): Error {
  const error = new Error(`HTTP ${status}: boom`) as Error & { status: number; retryAfterMs: number };
  error.status = status;
  error.retryAfterMs = retryAfterMs;
  return error;
}

function networkError(message = "TypeError: fetch failed"): Error {
  return new Error(message);
}

describe("上游瞬时错误重试判据（d.203.4.108）", () => {
  it("限流与网关故障算瞬时：429 / 500 / 502 / 503 / 504 / 408 / 529", () => {
    for (const status of [408, 425, 429, 500, 502, 503, 504, 529]) {
      expect(isRetryableUpstreamError(httpError(status)), `HTTP ${status}`).toBe(true);
    }
  });

  it("参数错与鉴权错不算：400 / 401 / 403 / 404 / 413 / 422", () => {
    for (const status of [400, 401, 403, 404, 413, 422]) {
      expect(isRetryableUpstreamError(httpError(status)), `HTTP ${status}`).toBe(false);
    }
  });

  it("网络层错误按报文认（fetch failed / ECONNRESET / socket hang up）", () => {
    expect(isRetryableUpstreamError(networkError("TypeError: fetch failed"))).toBe(true);
    expect(isRetryableUpstreamError(networkError("read ECONNRESET"))).toBe(true);
    expect(isRetryableUpstreamError(networkError("socket hang up"))).toBe(true);
    expect(isRetryableUpstreamError(networkError("数据库连不上"))).toBe(false);
  });

  it("中断优先：AbortError 与「已中断」一律不重试，哪怕带着 5xx", () => {
    const abort = new Error("aborted");
    abort.name = "AbortError";
    expect(isAbortError(abort)).toBe(true);
    expect(isRetryableUpstreamError(abort)).toBe(false);
    expect(isAbortError(new Error("已中断"))).toBe(true);
    expect(isRetryableUpstreamError(new Error("已中断"))).toBe(false);
    const abortedHttp = httpError(503);
    abortedHttp.name = "AbortError";
    expect(isRetryableUpstreamError(abortedHttp)).toBe(false);
  });

  it("upstreamStatusOf 只认数字 status，别的形状返回 null", () => {
    expect(upstreamStatusOf(httpError(503))).toBe(503);
    expect(upstreamStatusOf(new Error("x"))).toBeNull();
    expect(upstreamStatusOf(null)).toBeNull();
    expect(upstreamStatusOf({ status: "503" })).toBeNull();
  });

  it("退避：没有提示时 800ms 起、每次翻倍，且有上限", () => {
    const mid = () => 0.5; // 抖动中心：系数恰为 1.0，锁住 800×2^n 基线
    expect(retryDelayMs(httpError(503), 0, mid)).toBe(800);
    expect(retryDelayMs(httpError(503), 1, mid)).toBe(1600);
    expect(retryDelayMs(httpError(503), 2, mid)).toBe(3200);
    expect(retryDelayMs(httpError(503), 20, mid)).toBe(MAX_UPSTREAM_DELAY_MS);
  });

  it("退避带 ±10% 抖动打散惊群，且不越过上限（d.412）", () => {
    const low = () => 0; // 系数 0.9
    const high = () => 0.999999; // 系数 ≈1.1
    expect(retryDelayMs(httpError(503), 0, low)).toBe(720); // 800×0.9
    expect(retryDelayMs(httpError(503), 0, high)).toBe(880); // 800×1.1
    // 到了上限后，再大的抖动也不能超过 MAX
    expect(retryDelayMs(httpError(503), 20, high)).toBe(MAX_UPSTREAM_DELAY_MS);
  });

  it("供应商给了 Retry-After 就不加抖动（明确指示优先，d.412）", () => {
    const low = () => 0;
    const high = () => 0.999999;
    expect(retryDelayMs(httpError(429, 2500), 0, low)).toBe(2500);
    expect(retryDelayMs(httpError(429, 2500), 0, high)).toBe(2500);
  });

  it("供应商给了 Retry-After 就听它的，并夹在上限内", () => {
    const mid = () => 0.5;
    expect(retryDelayMs(httpError(429, 2500), 0, mid)).toBe(2500);
    expect(retryDelayMs(httpError(429, 60 * 60 * 1000), 0, mid)).toBe(MAX_UPSTREAM_DELAY_MS);
    expect(retryDelayMs(httpError(429, 0), 0, mid)).toBe(800);
  });

  it("默认最多重试 2 次（一次失败最多再试两次）", () => {
    expect(MAX_UPSTREAM_RETRIES).toBe(2);
  });

  it("describeUpstreamError 说人话：不带完整报文", () => {
    expect(describeUpstreamError(httpError(429))).toBe("请求太频繁（HTTP 429）");
    expect(describeUpstreamError(httpError(503))).toBe("上游暂时不可用（HTTP 503）");
    expect(describeUpstreamError(httpError(400))).toBe("HTTP 400");
    expect(describeUpstreamError(networkError("fetch failed"))).toBe("网络连接中断");
  });

  it("408 按 phase 说清卡在哪一段：等响应头 / 流到一半 / 未知（d.211 / d.213）", () => {
    // 没有 phase 的裸 408（别的网关给的）只说明「超时」这一个事实
    expect(describeUpstreamError(httpError(408))).toBe("上游响应超时（可能卡住了）");
    // d.213：连响应头都没等到
    expect(describeUpstreamError(Object.assign(httpError(408), { phase: "connect" }))).toBe(
      "上游一直没有开始响应（可能卡住了）",
    );
    // d.211：响应到一半不再来数据
    expect(describeUpstreamError(Object.assign(httpError(408), { phase: "stream" }))).toBe(
      "流式响应卡住了（长时间没有新数据）",
    );
    // 分类上仍是可重试的瞬时错误（否则卡住的流只能靠用户手点停止）
    expect(isRetryableUpstreamError(httpError(408))).toBe(true);
  });
});
