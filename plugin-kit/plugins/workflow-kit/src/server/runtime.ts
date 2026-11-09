/**
 * 运行时装配：把引擎不关心的外部能力注入进去（Node 版）。
 *
 * 与旧宿主版的区别：
 * - HTTP 直接用 Node 全局 fetch（没有浏览器的 CORS 限制，也不需要桌面桥）；
 * - 凭据、静态数据、执行记录都来自本机 `Store`；
 * - 代码沙箱由 expressions 的 Node 实现注入（`node:vm` 隔离）；
 * - 长任务在内存里保留「进行中的执行」，HTTP 层可以边跑边查（UI 轮询用）。
 */

import { randomUUID } from "node:crypto";
import { executeWorkflow, type EngineDeps, type EngineEvent } from "../engine/index.js";
import { runUserCode } from "../expressions/sandbox.js";
import {
  WORKFLOW_LIMITS,
  type ExecutionMode,
  type HttpRequestOptions,
  type HttpResponse,
  type Item,
  type SubWorkflowParams,
  type SubWorkflowResult,
  type Workflow,
  type WorkflowExecution,
} from "../types.js";
import type { WorkflowConfig } from "./config.js";
import type { Store } from "./storage.js";

export interface RunOptions {
  mode?: ExecutionMode;
  startNodeId?: string;
  destinationNodeId?: string;
  inputData?: Item[];
  onEvent?: (event: EngineEvent) => void;
  /**
   * 本次执行的超时（毫秒）。到点 abort 整条执行（状态置 canceled 并写明超时），
   * 用于 `workflow_test` 这类必须在上限内返回的调用。
   */
  timeoutMs?: number;
}

export interface Runtime {
  runWorkflow(workflow: Workflow, options?: RunOptions): Promise<WorkflowExecution>;
  /** 进行中的执行（UI 轮询用）；结束后从内存移除，可在 store 里查到。 */
  getLiveExecution(id: string): WorkflowExecution | undefined;
  /** 某个工作流当前是否在跑。 */
  isRunning(workflowId: string): boolean;
  /** 取消当前执行；返回是否真的取消了。 */
  stop(): boolean;
}

export const MAX_SUBWORKFLOW_DEPTH = 8;

function hasHeader(headers: Record<string, string>, name: string): boolean {
  const lowered = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === lowered);
}

/** 把查询参数拼到 URL 上（URLSearchParams 负责编码）。 */
export function appendQuery(url: string, query?: Record<string, string>): string {
  if (!query) return url;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) if (key) params.append(key, value);
  const queryString = params.toString();
  if (!queryString) return url;
  const hashIndex = url.indexOf("#");
  const base = hashIndex >= 0 ? url.slice(0, hashIndex) : url;
  const hash = hashIndex >= 0 ? url.slice(hashIndex) : "";
  return `${base}${base.includes("?") ? "&" : "?"}${queryString}${hash}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** options.body → fetch body，并按 bodyType 补 Content-Type。 */
export function prepareFetchBody(options: HttpRequestOptions): {
  body?: string;
  headers: Record<string, string>;
} {
  const headers = { ...(options.headers ?? {}) };
  const bodyType = options.bodyType ?? (options.body === undefined ? "none" : "json");
  if (bodyType === "none" || options.body === undefined) return { headers };
  if (bodyType === "json") {
    if (!hasHeader(headers, "content-type")) headers["Content-Type"] = "application/json";
    return { headers, body: JSON.stringify(options.body) };
  }
  if (bodyType === "form") {
    if (!hasHeader(headers, "content-type")) headers["Content-Type"] = "application/x-www-form-urlencoded";
    const params = new URLSearchParams();
    if (isPlainObject(options.body)) {
      for (const [key, value] of Object.entries(options.body)) {
        params.append(key, value === undefined || value === null ? "" : String(value));
      }
    }
    return { headers, body: params.toString() };
  }
  if (!hasHeader(headers, "content-type")) headers["Content-Type"] = "text/plain";
  return { headers, body: typeof options.body === "string" ? options.body : JSON.stringify(options.body) };
}

/** HTTP 依赖：Node 全局 fetch；超时/取消都转成可读中文。 */
export function createHttpRequest(): (options: HttpRequestOptions) => Promise<HttpResponse> {
  return async (options) => {
    const url = appendQuery(String(options.url ?? ""), options.query);
    if (!/^https?:\/\//i.test(url)) throw new Error("HTTP 节点只支持 http/https 地址");
    const timeoutMs = Math.max(1, Math.min(120_000, Math.trunc(options.timeoutMs ?? 30_000)));
    const { body, headers } = prepareFetchBody(options);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        method: String(options.method ?? "GET").toUpperCase(),
        headers,
        ...(body === undefined ? {} : { body }),
        redirect: options.followRedirects === false ? "manual" : "follow",
        signal: controller.signal,
      });
      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });
      const responseType = options.responseType ?? "json";
      if (responseType === "base64") {
        const buffer = await response.arrayBuffer();
        return {
          statusCode: response.status,
          headers: responseHeaders,
          body: Buffer.from(buffer).toString("base64"),
          size: buffer.byteLength,
        };
      }
      const text = await response.text();
      let parsed: unknown = text;
      if (responseType === "json") {
        try {
          parsed = text ? JSON.parse(text) : null;
        } catch {
          parsed = text;
        }
      }
      return {
        statusCode: response.status,
        headers: responseHeaders,
        body: parsed,
        rawBody: text,
        size: Buffer.byteLength(text, "utf8"),
      };
    } catch (error) {
      if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
        throw new Error(`HTTP 请求超时（超过 ${timeoutMs} 毫秒）`);
      }
      throw new Error(`HTTP 请求失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      clearTimeout(timer);
    }
  };
}

/** 等待（Wait 节点 / 重试共用）；取消时抛错而不是永远挂着。 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("执行已取消"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, Math.max(0, Math.trunc(ms)));
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error("执行已取消"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** 包一层 Proxy：引擎拿到的是普通对象，写/删时自动落盘（静态数据跨运行保留）。 */
function persistingRecord(
  record: Record<string, unknown>,
  persist: (next: Record<string, unknown>) => void,
): Record<string, unknown> {
  return new Proxy(record, {
    set(target, key, value) {
      target[String(key)] = value;
      persist(target);
      return true;
    },
    deleteProperty(target, key) {
      delete target[String(key)];
      persist(target);
      return true;
    },
  });
}

/** 子流程输出：取「执行序号最大且产出过 items」的节点输出；没有则空。 */
function subWorkflowOutput(execution: WorkflowExecution): Item[] {
  let best: { index: number; items: Item[] } | null = null;
  for (const runs of Object.values(execution.runData)) {
    for (const run of runs) {
      const items = run.data?.main?.[0];
      if (!items || items.length === 0) continue;
      const index = run.executionIndex ?? 0;
      if (!best || index > best.index) best = { index, items };
    }
  }
  return best?.items ?? execution.triggerData ?? [];
}

export function createRuntime(store: Store, config: WorkflowConfig): Runtime {
  const live = new Map<string, WorkflowExecution>();
  const runningWorkflows = new Set<string>();
  let controller: AbortController | null = null;

  const httpRequest = createHttpRequest();

  const getCredential: EngineDeps["getCredential"] = (type, id) => store.getCredentialData(type, id);

  function staticDataProvider(): NonNullable<EngineDeps["staticData"]> {
    return {
      getWorkflowStaticData: (workflowId: string) =>
        persistingRecord(store.getStaticData(workflowId), (next) =>
          store.saveStaticData(workflowId, null, { ...next }),
        ),
      getNodeStaticData: (workflowId: string, nodeId: string) =>
        persistingRecord(store.getStaticData(workflowId, nodeId), (next) =>
          store.saveStaticData(workflowId, nodeId, { ...next }),
        ),
    };
  }

  async function execute(
    workflow: Workflow,
    options: RunOptions,
    depth: number,
    parentExecutionId?: string,
    parentSignal?: AbortSignal,
  ): Promise<WorkflowExecution> {
    const executionId = randomUUID();
    let liveId: string = executionId;
    const runController = new AbortController();
    const forwardAbort = (): void => runController.abort();
    parentSignal?.addEventListener("abort", forwardAbort, { once: true });
    const deps: EngineDeps = {
      httpRequest,
      sleep,
      runUserCode,
      getCredential,
      staticData: staticDataProvider(),
      now: () => Date.now(),
      executeSubWorkflow: async (params: SubWorkflowParams): Promise<SubWorkflowResult> => {
        if (depth >= MAX_SUBWORKFLOW_DEPTH) throw new Error(`子流程嵌套超过 ${MAX_SUBWORKFLOW_DEPTH} 层`);
        const child = store.getWorkflow(params.workflowId);
        if (!child) throw new Error(`子流程不存在：${params.workflowId}`);
        // callerPolicy 只约束「被别的流程调用」；错误工作流由本工作流自己配置，不受限。
        if (params.mode !== "error" && child.settings.callerPolicy === "none") {
          throw new Error(`子流程「${child.name}」不允许被其它工作流调用`);
        }
        const execution = await execute(
          child,
          {
            mode: params.mode,
            inputData: params.inputData,
          },
          depth + 1,
          params.parentExecutionId,
          runController.signal,
        );
        store.saveExecution(execution);
        if (params.mode === "error") {
          store.addNotification({
            title: `错误工作流「${child.name}」已执行`,
            body: `执行 ${execution.status}`,
            workflowId: workflow.id,
          });
        }
        return { execution, output: subWorkflowOutput(execution) };
      },
    };

    try {
      const execution = await executeWorkflow({
        workflow,
        mode: options.mode ?? "manual",
        ...(options.startNodeId ? { startNodeId: options.startNodeId } : {}),
        ...(options.destinationNodeId ? { destinationNodeId: options.destinationNodeId } : {}),
        ...(options.inputData ? { inputData: { main: [options.inputData] } } : {}),
        executionId,
        ...(parentExecutionId ? { parentExecutionId } : {}),
        abortSignal: runController.signal,
        vars: store.getSettings().vars,
        deps,
        onEvent: (event) => {
          if (event.type === "executionStart") {
            liveId = event.execution.id;
            live.set(liveId, event.execution);
          } else if (event.type === "executionFinish") {
            live.set(liveId, event.execution);
          }
          try {
            options.onEvent?.(event);
          } catch {
            /* 事件回调失败不影响执行 */
          }
        },
      });
      return execution;
    } finally {
      parentSignal?.removeEventListener("abort", forwardAbort);
    }
  }

  return {
    async runWorkflow(workflow, options = {}) {
      if (runningWorkflows.has(workflow.id)) {
        throw new Error(`工作流「${workflow.name}」正在运行，等它结束再试`);
      }
      runningWorkflows.add(workflow.id);
      const runController = new AbortController();
      controller = runController;
      const timeoutMs =
        typeof options.timeoutMs === "number" && Number.isFinite(options.timeoutMs)
          ? Math.max(100, Math.min(120_000, Math.trunc(options.timeoutMs)))
          : 0;
      let timedOut = false;
      const timeoutTimer =
        timeoutMs > 0
          ? setTimeout(() => {
              timedOut = true;
              runController.abort();
            }, timeoutMs)
          : null;
      let finishedId = "";
      try {
        // 关键：把本次执行的 signal 作为父信号传下去。此前 stop()/超时 abort 的是
        // 一个没人监听的 controller，`/api/workflows/:id/stop` 实际停不掉执行。
        const execution = await execute(workflow, options, 0, undefined, runController.signal);
        finishedId = execution.id;
        if (timedOut) {
          execution.status = "canceled";
          execution.error = {
            message: `执行超时（${Math.round(timeoutMs / 1000)} 秒）`,
            description: "本次执行被超时中止；已完成节点的记录仍保留。",
          };
        }
        store.saveExecution(execution);
        return execution;
      } finally {
        if (timeoutTimer) clearTimeout(timeoutTimer);
        runningWorkflows.delete(workflow.id);
        controller = null;
        // 给 UI 一点时间读到最后一次进度，再把内存态清掉（持久化的记录还在 store 里）。
        if (finishedId) {
          const timer = setTimeout(() => live.delete(finishedId), 30_000);
          timer.unref?.();
        }
      }
    },

    getLiveExecution: (id) => live.get(id),

    isRunning: (workflowId) => runningWorkflows.has(workflowId),

    stop: () => {
      if (!controller) return false;
      controller.abort();
      return true;
    },
  };
}

/** 供测试/文档引用：执行上限常量。 */
export const RUNTIME_LIMITS = { maxExecutionMs: WORKFLOW_LIMITS.maxExecutionMs };
