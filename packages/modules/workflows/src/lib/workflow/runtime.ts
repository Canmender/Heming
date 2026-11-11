/**
 * 运行时装配：把「引擎不关心的外部能力」注入进去。
 *
 * 引擎（`engine/index.ts`）只依赖 `EngineDeps` 这些抽象：发 HTTP、等一会儿、
 * 跑用户代码、读凭据、跑子流程、取静态数据。这样做的原因是**同一套执行语义
 * 要能跑在三个宿主里**（浏览器、桌面端、测试），区别只在依赖实现：
 * - 浏览器：HTTP 走 `fetch`，跨域读响应用不上（CORS）——明确告诉用户去用桌面版；
 * - 桌面端：HTTP 走 preload 暴露的 `window.__heming_http`（主进程发请求，无 CORS）；
 * - 测试：整套依赖都可以覆盖（`createWorkflowRuntime(overrides)`）。
 *
 * 红线：不新增任何网络/文件入口。HTTP 是唯一出网点（节点自己发起的），
 * 代码沙箱由 `expressions/sandbox.ts` 负责隔离，本文件只负责把它们接起来。
 */

import {
  executeWorkflow,
  type EngineDeps,
  type EngineEvent,
} from "./engine/index";
import { runUserCode } from "./expressions/sandbox";
import { getCredentialData } from "./credentials";
import { createDefaultStorage, isPlainObject, readJson, utf8Length, writeJson } from "@heming/sdk";
import type { StorageLike } from "@heming/sdk";
import { useWorkflowStore } from "./store";
import { useWorkflowExecutionsStore } from "./executions";
import {
  WORKFLOW_LIMITS,
  type ExecutionMode,
  type HttpRequestOptions,
  type HttpResponse,
  type Item,
  type NodeInputData,
  type NodeLogger,
  type NodeRunData,
  type SubWorkflowParams,
  type SubWorkflowResult,
  type Workflow,
  type WorkflowExecution,
} from "./types";

/** 全局变量键（契约 §8：64KB）。 */
export const WORKFLOW_VARS_KEY = "heming.workflows.vars.v1";
/** 工作流静态数据键（契约 §8：128KB；跨运行保留）。 */
export const WORKFLOW_STATIC_KEY = "heming.workflows.static.v1";
/** 子流程最大嵌套层数：防「A 调 B 调 A」把主线程拖死。 */
export const MAX_SUBWORKFLOW_DEPTH = 8;

let runtimeStorage: StorageLike | null = null;

function getRuntimeStorage(): StorageLike {
  return (runtimeStorage ??= createDefaultStorage());
}

/** 测试注入点：传 null 恢复默认（jsdom 的 localStorage）。 */
export function setWorkflowRuntimeStorage(next: StorageLike | null): void {
  runtimeStorage = next;
  staticCache = null;
}

// ---------------------------------------------------------------------------
// 全局变量
// ---------------------------------------------------------------------------

/** 读全局变量（`$vars`）。坏数据回退空对象——变量读不出来不该阻止工作流运行。 */
export function readWorkflowVars(storage: StorageLike = getRuntimeStorage()): Record<string, unknown> {
  const raw = readJson(storage, WORKFLOW_VARS_KEY, {} as Record<string, unknown>, (value) =>
    isPlainObject(value) ? value : {},
  );
  return { ...raw };
}

/** 写全局变量（设置区/后续「变量」面板用；保持键级上限）。 */
export function writeWorkflowVars(
  vars: Record<string, unknown>,
  storage: StorageLike = getRuntimeStorage(),
): boolean {
  return writeJson(storage, WORKFLOW_VARS_KEY, vars, 64 * 1024);
}

// ---------------------------------------------------------------------------
// 静态数据（跨运行保留：游标、去重键、增量同步水位）
// ---------------------------------------------------------------------------

interface StaticWorkflowEntry {
  global: Record<string, unknown>;
  nodes: Record<string, Record<string, unknown>>;
}

interface StaticFile {
  workflows: Record<string, StaticWorkflowEntry>;
}

let staticCache: StaticFile | null = null;

function readStaticFile(): StaticFile {
  if (staticCache) return staticCache;
  const raw = readJson(
    getRuntimeStorage(),
    WORKFLOW_STATIC_KEY,
    { workflows: {} } as StaticFile,
    (value) => {
      if (!isPlainObject(value) || !isPlainObject(value.workflows)) return { workflows: {} };
      const workflows: Record<string, StaticWorkflowEntry> = {};
      for (const [workflowId, entry] of Object.entries(value.workflows)) {
        if (!isPlainObject(entry)) continue;
        workflows[workflowId] = {
          global: isPlainObject(entry.global) ? entry.global : {},
          nodes: isPlainObject(entry.nodes)
            ? (entry.nodes as Record<string, Record<string, unknown>>)
            : {},
        };
      }
      return { workflows };
    },
  );
  staticCache = raw;
  return raw;
}

function writeStaticFile(): void {
  if (!staticCache) return;
  // 写失败静默：静态数据丢一次只会让下次从头算，不该中断本次执行。
  writeJson(getRuntimeStorage(), WORKFLOW_STATIC_KEY, staticCache, 128 * 1024);
}

function staticEntry(workflowId: string): StaticWorkflowEntry {
  const file = readStaticFile();
  // readJson 的 fallback 与损坏数据都可能给出没有 workflows 的对象，这里再兜一层。
  file.workflows ??= {};
  file.workflows[workflowId] ??= { global: {}, nodes: {} };
  return file.workflows[workflowId];
}

/**
 * 静态数据用 Proxy 包一层：节点直接 `data.cursor = x` 也能落盘。
 *
 * 不这么做的话，调用方必须记得「改完再调一次保存」，而节点作者不会记得。
 * 同步写盘（数据很小、频率低）比 debounce 更可预期——延迟写会让「跑完立即
 * 读上一次的水位」在测试里变得难等。
 */
function mutableRecord(target: Record<string, unknown>): Record<string, unknown> {
  return new Proxy(target, {
    set(obj, key, value) {
      obj[String(key)] = value;
      writeStaticFile();
      return true;
    },
    deleteProperty(obj, key) {
      delete obj[String(key)];
      writeStaticFile();
      return true;
    },
  });
}

/** 引擎依赖：静态数据提供器（每次返回可写的 Proxy，写入即落盘）。 */
export function createStaticDataProvider(): NonNullable<EngineDeps["staticData"]> {
  return {
    getWorkflowStaticData: (workflowId: string) =>
      mutableRecord(staticEntry(workflowId).global),
    getNodeStaticData: (workflowId: string, nodeId: string) => {
      const entry = staticEntry(workflowId);
      entry.nodes[nodeId] ??= {};
      return mutableRecord(entry.nodes[nodeId]);
    },
  };
}

/** 测试隔离：清掉静态数据的内存缓存（不动 localStorage）。 */
export function resetWorkflowStaticCache(): void {
  staticCache = null;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

/** preload 暴露的桌面 HTTP 桥（形状见 packages/desktop/preload.js）。 */
interface DesktopHttpBridge {
  available?: boolean;
  request?: (options: Record<string, unknown>) => Promise<{
    ok: boolean;
    statusCode?: number;
    headers?: Record<string, string>;
    body?: unknown;
    encoding?: "utf8" | "base64";
    error?: string;
  }>;
}

function desktopHttpBridge(): DesktopHttpBridge | undefined {
  if (typeof window === "undefined") return undefined;
  const bridge = (window as unknown as { __heming_http?: DesktopHttpBridge }).__heming_http;
  if (!bridge || typeof bridge.request !== "function") return undefined;
  if (bridge.available === false) return undefined;
  return bridge;
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  const lowered = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === lowered);
}

/** 把查询参数拼到 URL 上（用 URLSearchParams 保证中文/特殊字符编码正确）。 */
export function appendQuery(url: string, query?: Record<string, string>): string {
  if (!query) return url;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (key) params.append(key, value);
  }
  const queryString = params.toString();
  if (!queryString) return url;
  const hashIndex = url.indexOf("#");
  const base = hashIndex >= 0 ? url.slice(0, hashIndex) : url;
  const hash = hashIndex >= 0 ? url.slice(hashIndex) : "";
  const separator = base.includes("?") ? "&" : "?";
  return `${base}${separator}${queryString}${hash}`;
}

/** 把 options.body 变成 fetch 能吃的 body，并按 bodyType 补 Content-Type。 */
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
    if (!hasHeader(headers, "content-type")) {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
    }
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

/** ArrayBuffer → base64（分块拼接，避免大响应把调用栈压爆）。 */
function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

/**
 * 创建 HTTP 依赖：桌面桥优先，浏览器 fetch 兜底。
 *
 * 为什么桌面桥优先：浏览器里读跨域响应会被 CORS 拦（请求其实发出去了，
 * 但拿不到状态码/响应体），而工作流 HTTP 节点经常要调第三方 API。桌面端由
 * 主进程发请求，没有这个限制；失败时的错误文案要明确指路。
 */
export function createHttpRequest(): (options: HttpRequestOptions) => Promise<HttpResponse> {
  return async (options) => {
    const url = appendQuery(String(options.url ?? ""), options.query);
    if (!/^https?:\/\//i.test(url)) {
      throw new Error("HTTP 节点只支持 http/https 地址");
    }
    const timeoutMs = Math.max(1, Math.trunc(options.timeoutMs ?? 30_000));
    const bridge = desktopHttpBridge();
    if (bridge?.request) {
      let result: Awaited<ReturnType<NonNullable<DesktopHttpBridge["request"]>>>;
      try {
        result = await bridge.request({
          method: options.method,
          url,
          headers: options.headers ?? {},
          body: options.body,
          bodyType: options.bodyType ?? (options.body === undefined ? "none" : "json"),
          timeoutMs,
          followRedirects: options.followRedirects !== false,
          responseType: options.responseType ?? "json",
        });
      } catch (error) {
        throw new Error(
          `HTTP 请求失败：${error instanceof Error ? error.message : String(error)}（桌面桥不可用，可重试或检查主进程日志）`,
        );
      }
      if (!result?.ok) {
        throw new Error(`HTTP 请求失败：${result?.error ?? "桌面桥未返回错误详情"}`);
      }
      return {
        statusCode: result.statusCode ?? 0,
        headers: result.headers ?? {},
        body: result.body,
        ...(typeof result.body === "string" ? { rawBody: result.body } : {}),
      };
    }

    const { body, headers } = prepareFetchBody(options);
    const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = setTimeout(() => controller?.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        method: String(options.method ?? "GET").toUpperCase(),
        headers,
        ...(body === undefined ? {} : { body }),
        redirect: options.followRedirects === false ? "manual" : "follow",
        ...(controller ? { signal: controller.signal } : {}),
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
          body: toBase64(buffer),
          size: buffer.byteLength,
        };
      }
      const text = await response.text();
      let parsed: unknown = text;
      if (responseType === "json") {
        try {
          parsed = text ? JSON.parse(text) : null;
        } catch {
          // 声明 json 但返回了非 JSON：回退文本（很多 API 出错时返回 HTML）
          parsed = text;
        }
      }
      return {
        statusCode: response.status,
        headers: responseHeaders,
        body: parsed,
        rawBody: text,
        size: utf8Length(text),
      };
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`HTTP 请求超时（超过 ${timeoutMs} 毫秒）`);
      }
      throw new Error(
        `HTTP 请求失败：${error instanceof Error ? error.message : String(error)}。浏览器端受 CORS 限制，桌面版可直连。`,
      );
    } finally {
      clearTimeout(timer);
    }
  };
}

// ---------------------------------------------------------------------------
// 其它依赖
// ---------------------------------------------------------------------------

/** 节点等待（Wait 节点与重试共用）；abort 时抛可读错误而不是永远挂着。 */
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

/** 节点日志：只写本机控制台（不落盘、不上云）。 */
export function createNodeLogger(): NodeLogger {
  const write = (level: "info" | "warn" | "error", message: string, meta?: Record<string, unknown>) => {
    const fn = level === "error" ? console.error : level === "warn" ? console.warn : console.info;
    if (meta) fn(`[工作流] ${message}`, meta);
    else fn(`[工作流] ${message}`);
  };
  return {
    info: (message, meta) => write("info", message, meta),
    warn: (message, meta) => write("warn", message, meta),
    error: (message, meta) => write("error", message, meta),
  };
}

/** 取子流程执行结束后的输出 items（取最晚跑完的节点、最后一个有数据的输出口）。 */
export function collectOutputItems(execution: WorkflowExecution): Item[] {
  let latest: NodeRunData | undefined;
  let latestAt = -Infinity;
  for (const runs of Object.values(execution.runData ?? {})) {
    for (const run of runs ?? []) {
      const endedAt = run.startTime + run.executionTime;
      if (endedAt >= latestAt) {
        latestAt = endedAt;
        latest = run;
      }
    }
  }
  const main = latest?.data?.main;
  if (!main) return [];
  for (let index = main.length - 1; index >= 0; index -= 1) {
    const list = main[index];
    if (list && list.length > 0) return list;
  }
  return [];
}

// ---------------------------------------------------------------------------
// 运行时
// ---------------------------------------------------------------------------

export interface WorkflowRunOptions {
  /** 执行模式（默认 manual）。 */
  mode?: ExecutionMode;
  /** 部分执行：从哪个节点开始（配合 inputData）。 */
  startNodeId?: string;
  /** 部分执行：跑到哪个节点后停。 */
  destinationNodeId?: string;
  triggerData?: Item[];
  inputData?: NodeInputData;
  abortSignal?: AbortSignal;
  onEvent?: (event: EngineEvent) => void;
  parentExecutionId?: string;
  executionId?: string;
  vars?: Record<string, unknown>;
  /** 是否写执行记录（默认 true；调用方自己写时传 false）。 */
  record?: boolean;
}

export interface WorkflowRuntime {
  deps: EngineDeps;
  /** 跑一条工作流并（默认）记执行记录。引擎永不抛：失败在 execution.status 里。 */
  run: (workflow: Workflow, options?: WorkflowRunOptions) => Promise<WorkflowExecution>;
}

/**
 * 子流程执行器：读仓库 → 递归调用引擎 → 记子执行 → 回输出。
 *
 * 深度上限必须有：A 调 B、B 又调 A 是合法的画法，但无限递归会直接卡死页面。
 * 超过上限时抛中文错误，节点按自己的 onError 策略处理（默认整条失败）。
 */
function makeSubWorkflowRunner(
  deps: EngineDeps,
  depth: number,
): (params: SubWorkflowParams) => Promise<SubWorkflowResult> {
  return async (params) => {
    if (depth >= MAX_SUBWORKFLOW_DEPTH) {
      throw new Error(
        `子流程嵌套超过 ${MAX_SUBWORKFLOW_DEPTH} 层，已停止（请检查是否存在工作流互相调用）`,
      );
    }
    const workflow = useWorkflowStore
      .getState()
      .workflows.find((candidate) => candidate.id === params.workflowId);
    if (!workflow) {
      throw new Error(`找不到要执行的子工作流（id：${params.workflowId}）`);
    }
    // callerPolicy 只约束「用户主动调用另一条工作流」；错误工作流是被动触发的
    // （引擎在执行失败时以 mode:"error" 调进来），不能因为对方 policy 是 none 就吞掉错误处理。
    if (params.mode === "subworkflow" && workflow.settings.callerPolicy === "none") {
      throw new Error(`工作流「${workflow.name}」不允许被其它工作流调用`);
    }
    const input = Array.isArray(params.inputData) ? params.inputData : [];
    const execution = await executeWorkflow({
      workflow,
      // 保持调用方语义：executeWorkflow 节点传 "subworkflow"，错误工作流传 "error"。
      mode: params.mode,
      parentExecutionId: params.parentExecutionId,
      triggerData: input,
      inputData: { main: [input] },
      deps: { ...deps, executeSubWorkflow: makeSubWorkflowRunner(deps, depth + 1) },
      vars: readWorkflowVars(),
      // 父执行被取消时，子执行跟着停：否则点了「停止」子流程还在后台跑。
      ...(params.abortSignal ? { abortSignal: params.abortSignal } : {}),
    });
    // 子执行也要留档：否则从历史里只看到父执行，子流程里的失败无从查起。
    useWorkflowExecutionsStore.getState().add(execution, workflow.settings);
    return { execution, output: collectOutputItems(execution) };
  };
}

/**
 * 组装一份完整运行时。
 *
 * `overrides` 用于测试或未来替换某一种能力（例如把 HTTP 换成企业代理实现），
 * 语义是「覆盖同名依赖」，不是追加。
 */
export function createWorkflowRuntime(overrides: Partial<EngineDeps> = {}): WorkflowRuntime {
  const deps: EngineDeps = {
    httpRequest: createHttpRequest(),
    sleep,
    runUserCode,
    getCredential: (type, id) => getCredentialData(type, id),
    logger: createNodeLogger(),
    now: () => Date.now(),
    staticData: createStaticDataProvider(),
  };
  deps.executeSubWorkflow = makeSubWorkflowRunner(deps, 0);
  Object.assign(deps, overrides);
  // overrides 里如果换了 executeSubWorkflow，递归仍用新实现（浅覆盖即可）。

  const run = async (
    workflow: Workflow,
    options: WorkflowRunOptions = {},
  ): Promise<WorkflowExecution> => {
    const execution = await executeWorkflow({
      workflow,
      mode: options.mode ?? "manual",
      ...(options.startNodeId ? { startNodeId: options.startNodeId } : {}),
      ...(options.destinationNodeId ? { destinationNodeId: options.destinationNodeId } : {}),
      ...(options.inputData ? { inputData: options.inputData } : {}),
      ...(options.triggerData ? { triggerData: options.triggerData } : {}),
      ...(options.executionId ? { executionId: options.executionId } : {}),
      ...(options.parentExecutionId ? { parentExecutionId: options.parentExecutionId } : {}),
      ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
      ...(options.onEvent ? { onEvent: options.onEvent } : {}),
      deps,
      vars: options.vars ?? readWorkflowVars(),
    });
    if (options.record !== false) {
      const stored = useWorkflowExecutionsStore.getState().add(execution, workflow.settings);
      if (stored) return stored;
    }
    return execution;
  };

  return { deps, run };
}

/** 执行上限的再导出（UI 在运行前提示「最多 500 次节点运行 / 10 分钟」用）。 */
export const RUNTIME_LIMITS = {
  maxNodeRuns: WORKFLOW_LIMITS.maxNodeRuns,
  maxExecutionMs: WORKFLOW_LIMITS.maxExecutionMs,
  maxSubWorkflowDepth: MAX_SUBWORKFLOW_DEPTH,
} as const;
