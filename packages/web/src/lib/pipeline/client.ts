/**
 * `services/agent-pipeline`（Python / LangGraph 流水线）的桌面端客户端。
 *
 * 为什么单独一个文件、而不是塞进 `api.ts`：
 * - 它连的是另一个服务（默认 `http://127.0.0.1:8000`），不是和鸣自己的 `/api/*`；
 * - 它的鉴权是 `Authorization: Bearer <AGENT_PIPELINE_API_KEY>`；
 * - 它是「提交 → 轮询」的异步协议，不是请求-响应。
 *
 * 默认不启用：界面不会自动连它，调用方要显式构造客户端。这样做是因为流水线需要
 * 单独部署（见 services/agent-pipeline/README），未部署时不该让聊天链路出现超时。
 *
 * 协议（与 service.py 对齐）：
 *   POST /v1/runs          → 202 {run_id, status, poll?}（并发满 → 429 + Retry-After）
 *   GET  /v1/runs/{id}     → {run_id, status, result?, error?, pending_approvals}
 *   POST /v1/runs/{id}/cancel    → 202
 *   POST /v1/runs/{id}/approve   → {call_id?, approved}
 *   GET  /health
 *
 * `status` 的终态是 `ok` / `error` / `aborted`——到了终态客户端就返回，不再轮询。
 * 非 2xx、网络错误、超时、用户中止都抛 `PipelineError`，调用方按 `kind` 区分怎么提示。
 */

export type PipelineStatus = "running" | "ok" | "error" | "aborted";

/** 摘要引用：`doc_id` + 第几块 + 原文片段（service 侧只保留真的出现在工具结果里的来源）。 */
export interface PipelineCitation {
  doc_id: string;
  chunk: number;
  quote: string;
}

/** 一次等待裁决的工具调用（`AGENT_APPROVAL_MODE=write` 才会有）。 */
export interface PipelineApproval {
  call_id: string;
  tool: string;
  arguments: Record<string, unknown>;
  requested_at: number;
  timeout_s: number;
}

export interface PipelineRunRequest {
  goal: string;
  cwd?: string;
  constraints?: string[];
  mode?: "react" | "adversarial";
  /** 0–1；只有 adversarial 模式用到（对抗环达标即收口）。 */
  coverageTarget?: number;
  toolsAllowed?: string[];
  /** 幂等键：同一个 runId 重复提交，服务只跑一次。 */
  runId?: string;
}

/** 归一化后的运行结果（服务端字段是 snake_case，这里转成前端习惯的 camelCase）。 */
export interface PipelineRun {
  runId: string;
  status: PipelineStatus;
  answer: string;
  citations: PipelineCitation[];
  coverage: number | null;
  stopReason: string | null;
  llmCalls: number;
  tokens: number;
  configVersion: number;
  /** 失败时的原因；`status === "ok"` 时是 null。 */
  error: string | null;
}

export type PipelineErrorKind = "http" | "network" | "timeout" | "aborted";

export class PipelineError extends Error {
  readonly kind: PipelineErrorKind;
  readonly status: number | undefined;
  /** 服务端 `detail` 文案（有的话），便于直接展示给用户。 */
  readonly detail: string | undefined;

  constructor(kind: PipelineErrorKind, message: string, status?: number, detail?: string) {
    super(message);
    this.name = "PipelineError";
    this.kind = kind;
    this.status = status;
    this.detail = detail;
  }
}

export interface PipelineClientOptions {
  /** 例如 `http://127.0.0.1:8000`；末尾斜杠会自动去掉。 */
  baseUrl: string;
  apiKey?: string;
  /** 单次 HTTP 请求超时，默认 15s（一个 run 可能跑很久，但单次请求不该久等）。 */
  requestTimeoutMs?: number;
  /** 轮询间隔，默认 500ms。 */
  pollIntervalMs?: number;
  /** 整个 run 的最长等待，默认 30 分钟（服务端预算默认 10 分钟，留出排队余量）。 */
  runTimeoutMs?: number;
  /**
   * 收到「待你裁决」的工具调用时怎么办。
   * 不给 = 不处理（服务端等到 `AGENT_APPROVAL_TIMEOUT_S` 后按拒绝收口）。
   * 给了 = 逐条询问，返回 true 批准、false 拒绝。
   */
  onPendingApproval?: (approval: PipelineApproval) => boolean | Promise<boolean>;
  /** 测试注入点：替换 fetch / 睡眠 / 时钟。 */
  fetchImpl?: typeof fetch;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
}

interface RawRun {
  run_id?: string;
  status?: string;
  result?: Record<string, unknown> | null;
  error?: string | null;
  pending_approvals?: PipelineApproval[];
}

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_POLL_INTERVAL_MS = 500;
const DEFAULT_RUN_TIMEOUT_MS = 30 * 60_000;
const TERMINAL: ReadonlySet<string> = new Set(["ok", "error", "aborted"]);

/** `Retry-After` 只可能是秒数（服务端固定 5）；解析不出来就按 1s 兜底。 */
function parseRetryAfter(raw: string | null): number {
  const seconds = raw === null ? Number.NaN : Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : 1_000;
}

function abortError(): PipelineError {
  return new PipelineError("aborted", "已中止（用户点了停止）");
}

/** 可被 signal 打断的等待；测试里换成同步推进的假 sleep。 */
function realSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(abortError());
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function normalizeCitation(raw: unknown): PipelineCitation | null {
  if (typeof raw !== "object" || raw === null) return null;
  const row = raw as Record<string, unknown>;
  if (typeof row.doc_id !== "string" || !row.doc_id) return null;
  if (typeof row.chunk !== "number" || !Number.isInteger(row.chunk)) return null;
  return {
    doc_id: row.doc_id,
    chunk: row.chunk,
    quote: typeof row.quote === "string" ? row.quote : "",
  };
}

/**
 * 把服务端的 run 载荷收敛成前端要的形状。
 *
 * 服务端在 run 结束时给 `result`（RunResult.to_dict()）；运行中只有 `status`。
 * 字段缺失一律给安全默认值——界面不该因为某个可选字段没回来就崩。
 */
export function normalizeRun(raw: RawRun, fallbackRunId: string): PipelineRun {
  const result = raw.result && typeof raw.result === "object" ? raw.result : {};
  const status = raw.status === "ok" || raw.status === "error" || raw.status === "aborted" ? raw.status : "running";
  const citations = Array.isArray(result.citations)
    ? result.citations.map(normalizeCitation).filter((item): item is PipelineCitation => item !== null)
    : [];
  const coverage = typeof result.coverage === "number" ? result.coverage : null;
  const stopReason = typeof result.stop_reason === "string" ? result.stop_reason : null;
  return {
    runId: typeof result.run_id === "string" && result.run_id ? result.run_id : (raw.run_id ?? fallbackRunId),
    status,
    answer: typeof result.answer === "string" ? result.answer : "",
    citations,
    coverage,
    stopReason,
    llmCalls: typeof result.llm_calls === "number" ? result.llm_calls : 0,
    tokens: typeof result.tokens === "number" ? result.tokens : 0,
    configVersion: typeof result.config_version === "number" ? result.config_version : 0,
    error: typeof raw.error === "string" && raw.error ? raw.error : typeof result.error === "string" && result.error ? result.error : null,
  };
}

export interface PipelineClient {
  /** 提交并等到终态（并发满会自动退避重试一次）。 */
  run(request: PipelineRunRequest, options?: { signal?: AbortSignal }): Promise<PipelineRun>;
  /** 只查一次状态，不等待。 */
  getRun(runId: string, options?: { signal?: AbortSignal }): Promise<PipelineRun>;
  /** 请求停止（节点边界收口，不硬杀）。 */
  cancel(runId: string, options?: { signal?: AbortSignal }): Promise<void>;
  /** 健康检查：用来在界面上显示「流水线已连上/没连上」。 */
  health(): Promise<{ ok: boolean; tools: string[]; running: number }>;
}

export function createPipelineClient(options: PipelineClientOptions): PipelineClient {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const runTimeoutMs = options.runTimeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
  const sleep = options.sleep ?? realSleep;
  const now = options.now ?? Date.now;

  /** fetch 注入只用于测试；生产走全局 fetch（Electron 渲染进程里有）。 */
  const doFetch = (input: string, init: RequestInit) =>
    options.fetchImpl ? options.fetchImpl(input, init) : fetch(input, init);

  function headers(): Record<string, string> {
    const out: Record<string, string> = { "Content-Type": "application/json" };
    if (options.apiKey) out.Authorization = `Bearer ${options.apiKey}`;
    return out;
  }

  async function readDetail(response: Response): Promise<string | undefined> {
    try {
      const body = (await response.json()) as { detail?: unknown };
      return typeof body.detail === "string" ? body.detail : undefined;
    } catch {
      return undefined;
    }
  }

  async function requestJson<T>(path: string, init: RequestInit, signal?: AbortSignal): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
    const onOuterAbort = () => controller.abort();
    signal?.addEventListener("abort", onOuterAbort, { once: true });
    let response: Response;
    try {
      response = await doFetch(`${baseUrl}${path}`, {
        ...init,
        headers: { ...headers(), ...(init.headers as Record<string, string> | undefined) },
        signal: controller.signal,
      });
    } catch (error) {
      if (signal?.aborted) throw abortError();
      const name = (error as { name?: string } | null)?.name;
      if (name === "AbortError") throw new PipelineError("timeout", `请求超时（${requestTimeoutMs}ms）：${path}`);
      throw new PipelineError("network", `连不上流水线服务：${(error as Error)?.message ?? String(error)}`);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onOuterAbort);
    }
    if (!response.ok) {
      const detail = await readDetail(response);
      throw new PipelineError("http", `流水线返回 ${response.status}${detail ? `：${detail}` : ""}`, response.status, detail);
    }
    return (await response.json()) as T;
  }

  async function submit(
    request: PipelineRunRequest,
    signal?: AbortSignal,
  ): Promise<{ runId: string; status: string }> {
    const body = {
      goal: request.goal,
      ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
      ...(request.constraints === undefined ? {} : { constraints: request.constraints }),
      ...(request.mode === undefined ? {} : { mode: request.mode }),
      ...(request.coverageTarget === undefined ? {} : { coverage_target: request.coverageTarget }),
      ...(request.toolsAllowed === undefined ? {} : { tools_allowed: request.toolsAllowed }),
      ...(request.runId === undefined ? {} : { run_id: request.runId }),
    };
    try {
      const raw = await requestJson<{ run_id: string; status: string }>(
        "/v1/runs",
        { method: "POST", body: JSON.stringify(body) },
        signal,
      );
      return { runId: raw.run_id, status: raw.status };
    } catch (error) {
      if (error instanceof PipelineError && error.status === 429) {
        // 并发满不是错误，是背压：等 Retry-After 再来一次，别让用户看到红字。
        await sleep(parseRetryAfter(null), signal);
        const raw = await requestJson<{ run_id: string; status: string }>(
          "/v1/runs",
          { method: "POST", body: JSON.stringify(body) },
          signal,
        );
        return { runId: raw.run_id, status: raw.status };
      }
      throw error;
    }
  }

  async function handleApprovals(raw: RawRun, runId: string, signal?: AbortSignal): Promise<void> {
    const pending = Array.isArray(raw.pending_approvals) ? raw.pending_approvals : [];
    if (pending.length === 0 || !options.onPendingApproval) return;
    for (const approval of pending) {
      const approved = await options.onPendingApproval(approval);
      await requestJson(
        `/v1/runs/${encodeURIComponent(runId)}/approve`,
        { method: "POST", body: JSON.stringify({ call_id: approval.call_id, approved }) },
        signal,
      );
    }
  }

  return {
    async run(request, runOptions = {}) {
      const signal = runOptions.signal;
      const started = now();
      const created = await submit(request, signal);
      let runId = created.runId;
      // 服务端可能返回 202 但已经有结果（极快的 run）——先查一次再决定是否轮询。
      for (;;) {
        const raw = await requestJson<RawRun>(`/v1/runs/${encodeURIComponent(runId)}`, { method: "GET" }, signal);
        runId = raw.run_id ?? runId;
        await handleApprovals(raw, runId, signal);
        if (TERMINAL.has(String(raw.status))) return normalizeRun(raw, runId);
        if (now() - started > runTimeoutMs) {
          // 超时不代表服务端停了：请求取消，让它别再白烧模型。
          await this.cancel(runId).catch(() => undefined);
          throw new PipelineError("timeout", `流水线超过 ${Math.round(runTimeoutMs / 60_000)} 分钟仍未结束，已请求取消`);
        }
        await sleep(pollIntervalMs, signal);
      }
    },

    async getRun(runId, runOptions = {}) {
      const raw = await requestJson<RawRun>(`/v1/runs/${encodeURIComponent(runId)}`, { method: "GET" }, runOptions.signal);
      return normalizeRun(raw, runId);
    },

    async cancel(runId, runOptions = {}) {
      await requestJson<Record<string, unknown>>(
        `/v1/runs/${encodeURIComponent(runId)}/cancel`,
        { method: "POST" },
        runOptions.signal,
      );
    },

    async health() {
      const raw = await requestJson<{ ok?: boolean; tools?: string[]; running?: number }>("/health", { method: "GET" });
      return {
        ok: raw.ok === true,
        tools: Array.isArray(raw.tools) ? raw.tools.filter((item): item is string => typeof item === "string") : [],
        running: typeof raw.running === "number" ? raw.running : 0,
      };
    },
  };
}