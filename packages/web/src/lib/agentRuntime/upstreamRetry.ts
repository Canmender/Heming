/**
 * 上游瞬时错误的重试判据（d.203.4.108）。
 *
 * 为什么需要它：一轮对话只用一条流，供应商那边偶发的 429 / 502 / 连接被掐断，
 * 会让整轮当场失败——用户看到「生成出错」，长任务里前面几十轮的活就停在那里，
 * 得自己再点一次「继续」。codex / Claude Code 这类工具都会在这种错误上自己退避重试。
 *
 * 三条边界（写死在这里，别在调用处各自发挥）：
 * 1. **只重试「什么都没发生」的尝试**：已经吐出过字、已经拿到工具调用的，
 *    重试会造成重复文本或重复工具调用，那比失败更糟。
 * 2. **只重试瞬时错误**：429/5xx/超时/连接重置算；400（参数错）、401/403（鉴权）、
 *    404（模型不存在）、内容策略拒绝都不算——重试只是把同一个错误再花一次钱。
 * 3. **中断优先**：用户按了停止，AbortError 一律不重试。
 *
 * 这个模块只做判定，不负责等待与发请求（那些在 agentStream 的调用点上）。
 */

/** 首次之外的自动重试次数上限（一次失败最多再试 2 次）。 */
export const MAX_UPSTREAM_RETRIES = 2;

/** 没有 `Retry-After` 时的基础等待：800ms、1600ms。 */
const BASE_DELAY_MS = 800;

/** 单次等待上限：供应商说「一小时后再来」时不能真睡一小时，宁可放弃。 */
export const MAX_UPSTREAM_DELAY_MS = 10_000;

/**
 * 值得重试的 HTTP 状态。
 *
 * 408 请求超时、425 Too Early、429 限流、500/502/503/504 网关与上游故障、
 * 529 是部分供应商（Anthropic 系）的自定义过载码。
 */
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504, 529]);

/**
 * 网络层错误的特征词。
 *
 * 这些是 `fetch` / undici 抛的 `TypeError: fetch failed` 之类，`status` 拿不到，
 * 只能按报文认。宁可少认几个（多一次失败）也不要多认（重试不该重试的东西）。
 */
const NETWORK_RE =
  /fetch failed|network error|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up|other side closed|terminated|stream (?:ended|closed)|connection (?:reset|error|closed)/i;

interface ErrorShape {
  name?: unknown;
  message?: unknown;
  status?: unknown;
  retryAfterMs?: unknown;
}

function shapeOf(error: unknown): ErrorShape {
  return error && typeof error === "object" ? (error as ErrorShape) : {};
}

/** 取 HTTP 状态（`LlmHttpError` 带 `status`；其它错误没有 → null）。 */
export function upstreamStatusOf(error: unknown): number | null {
  const { status } = shapeOf(error);
  return typeof status === "number" && Number.isFinite(status) ? status : null;
}

/** 用户主动中断：不是失败，任何情况下都不重试。 */
export function isAbortError(error: unknown): boolean {
  const { name } = shapeOf(error);
  if (name === "AbortError") return true;
  const message = String(shapeOf(error).message ?? "");
  return /aborted|已中断|已停止/i.test(message) && !upstreamStatusOf(error);
}

/** 这个错误值不值得再试一次（不含「已经吐出内容」的判断，那条由调用方看现场）。 */
export function isRetryableUpstreamError(error: unknown): boolean {
  if (!error) return false;
  if (isAbortError(error)) return false;
  const status = upstreamStatusOf(error);
  if (status !== null) return RETRYABLE_STATUS.has(status);
  const message = String(shapeOf(error).message ?? "");
  return NETWORK_RE.test(message);
}

/**
 * 这次重试该等多久。
 *
 * 优先听供应商的 `Retry-After`（转成毫秒、夹在 `[0, MAX_UPSTREAM_DELAY_MS]`），
 * 没有就按 800ms × 2^attempt 退避。`attempt` 从 0 起。
 */
export function retryDelayMs(error: unknown, attempt: number): number {
  const raw = shapeOf(error).retryAfterMs;
  const hinted = typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : 0;
  if (hinted > 0) return Math.min(Math.round(hinted), MAX_UPSTREAM_DELAY_MS);
  const step = Math.max(0, Math.floor(attempt));
  return Math.min(BASE_DELAY_MS * 2 ** step, MAX_UPSTREAM_DELAY_MS);
}

/** 一句话说清这次是什么错（给界面的提示用，不带完整报文）。 */
export function describeUpstreamError(error: unknown): string {
  const status = upstreamStatusOf(error);
  if (status !== null) {
    if (status === 429) return "请求太频繁（HTTP 429）";
    // 408 在这里被复用为「超时」（d.211 的空闲超时、d.213 的等响应头超时）：
    // 说成「HTTP 408」等于没说。两者的区别用 `phase` 分辨——用户要知道是
    // 「压根没开始」还是「说到一半停了」，因为要不要立刻重试的判断不一样。
    if (status === 408) {
      const phase = (error as { phase?: unknown } | null)?.phase;
      if (phase === "connect") return "上游一直没有开始响应（可能卡住了）";
      if (phase === "stream") return "流式响应卡住了（长时间没有新数据）";
      return "上游响应超时（可能卡住了）";
    }
    if (status >= 500) return `上游暂时不可用（HTTP ${status}）`;
    return `HTTP ${status}`;
  }
  return "网络连接中断";
}
