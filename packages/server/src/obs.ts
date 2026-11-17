import { randomUUID, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

/**
 * 服务端可观测性（d.236）：请求 id、一行式结构化日志、内存指标。
 *
 * 设计取舍：
 * - 不引第三方库：请求量是「单机桌面端 + 少量团队用户」的量级，内存直方图足够；
 * - 日志固定字段、绝不打印 body/header：登录 token、密码、消息正文都不能进日志；
 * - 指标按「方法 + 归一化路由」聚合：会话/任务 id 每来一个新对象就多一条时间线，没法看。
 */

export type LogSink = (line: string) => void;

export interface ObservabilityOptions {
  /** 结构化日志落点；缺省写 stdout（vitest 下静默，避免测试输出被逐请求日志淹没）。 */
  sink?: LogSink;
  /** 指标令牌覆盖；缺省调用时读 HEMING_METRICS_TOKEN（便于测试与运维热改）。 */
  metricsToken?: string;
  /** 时钟注入（测试用）；缺省 Date.now。 */
  now?: () => number;
}

/** 延迟直方图的分桶上界（毫秒）；越过最后一档的落进溢出桶。 */
const LATENCY_BUCKETS_MS = [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 路由归一化：纯数字段与 uuid 段替换成 `:id`。
 * 例：`/api/teams/42/tasks/3f2c...` → `/api/teams/:id/tasks/:id`。
 */
export function normalizeRoute(path: string): string {
  return path
    .split("/")
    .map((seg) => (/^\d+$/.test(seg) || UUID_RE.test(seg) ? ":id" : seg))
    .join("/");
}

/** 回环地址判定：127.0.0.0/8、::1，以及 Node 常见的 IPv4-mapped `::ffff:127.x`。 */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const addr = address.startsWith("::ffff:") ? address.slice(7) : address;
  if (addr === "::1") return true;
  const v4 = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(addr);
  return !!v4 && v4.slice(1).every((part) => Number(part) <= 255);
}

export interface MetricsSnapshot {
  uptimeMs: number;
  requests: {
    total: number;
    byStatus: { "2xx": number; "3xx": number; "4xx": number; "5xx": number };
    /** 5xx 数量（调用方问题不算服务端故障）。 */
    errors: number;
    /** 键形如 `GET /api/teams/:id`。 */
    byRoute: Record<string, number>;
  };
  latencyMs: { p50: number; p95: number; max: number; samples: number };
}

export interface Observability {
  /** Express 中间件：生成/透传 x-request-id，finish 时记录日志与指标。 */
  middleware(req: Request, res: Response, next: NextFunction): void;
  /** 当前指标快照（GET /api/metrics 的响应体）。 */
  snapshot(): MetricsSnapshot;
  /**
   * /api/metrics 是否放行：
   * - 配置了 HEMING_METRICS_TOKEN → 一律要求 Bearer 匹配（回环也不例外）；
   * - 未配置 → 仅回环地址可访问。
   * 两种不放行情况在路由层都回 404（不暴露该接口存在）。
   */
  metricsAllowed(req: Request): boolean;
}

/** 缺省日志落点：生产写 stdout；vitest 下静默（测试要断言日志就注入 sink）。 */
const defaultSink: LogSink = (line) => {
  if (process.env.VITEST) return;
  process.stdout.write(`${line}\n`);
};

export function createObservability(opts: ObservabilityOptions = {}): Observability {
  const now = opts.now ?? Date.now;
  const sink = opts.sink ?? defaultSink;
  const startedAt = now();

  let total = 0;
  const byStatus = { "2xx": 0, "3xx": 0, "4xx": 0, "5xx": 0 };
  let errors = 0;
  const byRoute = new Map<string, number>();
  // 长度 = 分桶数 + 1（溢出桶）。
  const buckets = new Array<number>(LATENCY_BUCKETS_MS.length + 1).fill(0);
  let maxMs = 0;

  function record(status: number, route: string, ms: number): void {
    total += 1;
    if (status >= 500) {
      byStatus["5xx"] += 1;
      errors += 1;
    } else if (status >= 400) {
      byStatus["4xx"] += 1;
    } else if (status >= 300) {
      byStatus["3xx"] += 1;
    } else {
      byStatus["2xx"] += 1;
    }
    byRoute.set(route, (byRoute.get(route) ?? 0) + 1);
    const idx = LATENCY_BUCKETS_MS.findIndex((upper) => ms <= upper);
    buckets[idx >= 0 ? idx : LATENCY_BUCKETS_MS.length] += 1;
    if (ms > maxMs) maxMs = ms;
  }

  function percentile(p: number): number {
    if (total === 0) return 0;
    const target = Math.ceil(total * p);
    let seen = 0;
    for (let i = 0; i < buckets.length; i += 1) {
      seen += buckets[i];
      if (seen < target) continue;
      // 溢出桶没有上界，用实际观察到的最慢请求兜底。
      return i < LATENCY_BUCKETS_MS.length
        ? LATENCY_BUCKETS_MS[i]
        : Math.max(maxMs, LATENCY_BUCKETS_MS[LATENCY_BUCKETS_MS.length - 1]);
    }
    return Math.max(maxMs, LATENCY_BUCKETS_MS[LATENCY_BUCKETS_MS.length - 1]);
  }

  function metricsToken(): string {
    return (opts.metricsToken ?? process.env.HEMING_METRICS_TOKEN ?? "").trim();
  }

  return {
    middleware(req, res, next) {
      const incoming = req.header("x-request-id")?.trim() ?? "";
      // 透传调用方的 id（前后端联调、网关链路追踪），但限长防止脏头进日志/响应头。
      const requestId = incoming !== "" && incoming.length <= 200 ? incoming : randomUUID();
      res.setHeader("x-request-id", requestId);
      (req as Request & { requestId?: string }).requestId = requestId;

      const start = process.hrtime.bigint();
      res.on("finish", () => {
        const ms = Number(process.hrtime.bigint() - start) / 1e6;
        const status = res.statusCode;
        const route = `${req.method} ${normalizeRoute(req.path)}`;
        record(status, route, ms);

        const userId = (req as Request & { userId?: string }).userId;
        // 固定字段、一行 JSON：不打印 body/header，token 与密码没有进入日志的通道。
        sink(
          JSON.stringify({
            ts: new Date(now()).toISOString(),
            level: status >= 500 ? "error" : status >= 400 ? "warn" : "info",
            requestId,
            method: req.method,
            path: req.path,
            status,
            ms: Math.round(ms * 10) / 10,
            ...(userId ? { userId } : {}),
          }),
        );
      });
      next();
    },

    snapshot() {
      return {
        uptimeMs: Math.max(0, now() - startedAt),
        requests: {
          total,
          byStatus: { ...byStatus },
          errors,
          byRoute: Object.fromEntries(byRoute),
        },
        latencyMs: { p50: percentile(0.5), p95: percentile(0.95), max: Math.round(maxMs), samples: total },
      };
    },

    metricsAllowed(req) {
      const expected = metricsToken();
      if (expected) {
        const header = req.header("authorization") ?? "";
        const given = header.startsWith("Bearer ") ? header.slice(7) : "";
        const a = Buffer.from(given);
        const b = Buffer.from(expected);
        // 定长比较：别让响应时间泄露令牌前缀。
        return a.length === b.length && timingSafeEqual(a, b);
      }
      return isLoopbackAddress(req.socket.remoteAddress) || isLoopbackAddress(req.ip);
    },
  };
}
