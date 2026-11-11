/**
 * 代码节点的 JS 沙箱。
 *
 * 为什么要 Web Worker：
 * - 用户在「代码」节点里写的是任意 JS，跑在页面主线程会卡 UI，而且没有超时可言；
 * - Worker 里本来就**没有 DOM、没有 localStorage**，网络入口（fetch/XHR/WebSocket）
 *   再被形参遮蔽 + 静态拒绝，等于把可用面收到「纯计算 + items 进 / items 出」；
 * - 超时时直接 `terminate()`，比在用户代码里插检查点可靠得多。
 *
 * 为什么 worker 源码用字符串模板生成、而不是单独一个 worker 入口文件：
 * - 避免构建期多一个 rollup 入口与产物路径（应用有两个 HTML 入口，不想再加第三份）；
 * - 这段源码不能 `import` 任何模块，所以依赖（遮蔽名单、作用域名字）全部以 JSON 注入，
 *   保证主线程与 Worker 里的形参顺序只由一处常量决定。
 *
 * 为什么还要同步 fallback：
 * - jsdom / 单元测试环境没有 `Worker`，但代码节点的行为必须有测试可跑；
 * - fallback 仍在同一 realm 里，靠同样的静态扫描 + 形参遮蔽收敛能力，
 *   并**不承诺**能打断死循环（同步代码无法被计时器抢占）——真实运行走 Worker。
 *
 * 返回值语义（供 nodes/core/code 节点消费）：
 * - `runOnceForAllItems`：返回用户代码的原始返回值；
 * - `runOnceForEachItem` + `itemIndex`：只跑这一项，返回该项的用户返回值（单个值）；
 * - `runOnceForEachItem` 没有 `itemIndex`：按 item 顺序返回数组，每项是该 item 的用户返回值；
 * - 空代码视为「原样透传」：all 模式返回 items；per-item 模式返回各项的 `json`
 *   （给了 `itemIndex` 就只返回该项的 json）。
 * `normalizeUserCodeResult` 负责把任意返回值收敛成 `Item[]`（含 `{json: …}` 包装判断）。
 */

import type { Item, RunUserCodeOptions, UserCodeRunner } from "../types";
import { findUnsafeSource, FORBIDDEN_GLOBALS, isPlainObject } from "./helpers";

/** 代码沙箱错误：与 ExpressionError 分开，UI 能区分「表达式错」与「代码节点错」。 */
export class UserCodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserCodeError";
  }
}

/** 默认超时（与 CONTRACT 口径一致：代码节点 10 秒不返回就终止）。 */
export const DEFAULT_USER_CODE_TIMEOUT_MS = 10_000;
const MIN_USER_CODE_TIMEOUT_MS = 50;
const MAX_USER_CODE_TIMEOUT_MS = 120_000;

/** 代码作用域的形参名（顺序必须与 Worker 源码里的 scopeArgs 一致）。 */
const CODE_SCOPE_KEYS = [
  "items",
  "$input",
  "$json",
  "$item",
  "$itemIndex",
  "$runIndex",
  "console",
] as const;

/** 与表达式共用的遮蔽名单（`eval` 不能当形参名，已在 helpers 里滤掉）。 */
const SHADOWED_GLOBALS: readonly string[] = FORBIDDEN_GLOBALS.filter((name) => name !== "eval");

/** Worker 侧通信协议：主线程 → Worker 的入参。 */
interface WorkerRequest {
  code: string;
  mode: RunUserCodeOptions["mode"];
  items: Item[];
  itemIndex?: number;
}

/** Worker 侧通信协议：Worker → 主线程的回包。 */
interface WorkerResponse {
  ok?: boolean;
  value?: unknown;
  error?: { message?: string };
}

/**
 * 沙箱 Worker 的最小接口。
 *
 * 抽成接口是为了测试：jsdom 没有 Worker，用 `node:vm` 跑同一份 Worker 源码来验证
 * 通信协议、超时 terminate 与错误回传（否则 Worker 分支在 CI 里永远是盲区）。
 */
export interface SandboxWorker {
  postMessage(message: unknown): void;
  terminate(): void;
  onMessage(handler: (data: unknown) => void): void;
  onError(handler: (error: Error) => void): void;
}

export type SandboxWorkerFactory = (source: string) => SandboxWorker;

export interface UserCodeSandboxOptions {
  /**
   * 自定义 Worker 工厂（测试注入用）；显式传 `null` 可强制走 fallback。
   * 不传时按环境自动判断：有 Worker/Blob/URL 就用 Worker。
   */
  workerFactory?: SandboxWorkerFactory | null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeTimeout(value?: number): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_USER_CODE_TIMEOUT_MS;
  return Math.min(MAX_USER_CODE_TIMEOUT_MS, Math.max(MIN_USER_CODE_TIMEOUT_MS, Math.trunc(value)));
}

function clampIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  if (!Number.isFinite(index)) return 0;
  const truncated = Math.trunc(index);
  if (truncated < 0) return 0;
  return Math.min(truncated, length - 1);
}

function emptyCodeResult(
  mode: RunUserCodeOptions["mode"],
  items: Item[],
  itemIndex?: number,
): unknown {
  if (mode !== "runOnceForEachItem") return items;
  if (itemIndex !== undefined) return items[clampIndex(itemIndex, items.length)]?.json ?? {};
  return items.map((item) => item.json);
}

// ---------------------------------------------------------------------------
// Worker 源码（字符串模板：这里不能 import，依赖全部注入）
// ---------------------------------------------------------------------------

const WORKER_SOURCE_TEMPLATE = `"use strict";
// 由 expressions/sandbox.ts 生成：不要手改这份字符串里的逻辑，改生成端。
const SHADOWED_GLOBALS = __SHADOWED_GLOBALS__;
const SCOPE_KEYS = __CODE_SCOPE_KEYS__;
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

function describeError(error) {
  const message =
    error && typeof error === "object" && typeof error.message === "string"
      ? error.message
      : String(error);
  if (error && typeof error === "object" && error.name === "SyntaxError") {
    return "代码语法有误：" + message;
  }
  return "代码执行出错：" + message;
}

function createInput(items, item) {
  return {
    all: function () { return items; },
    first: function () { return items.length > 0 ? items[0] : null; },
    last: function () { return items.length > 0 ? items[items.length - 1] : null; },
    item: item || null,
  };
}

function clampIndex(index, length) {
  if (length <= 0) return 0;
  if (typeof index !== "number" || !isFinite(index)) return 0;
  const truncated = Math.trunc(index);
  if (truncated < 0) return 0;
  return truncated >= length ? length - 1 : truncated;
}

async function execute(payload) {
  const code = typeof payload.code === "string" ? payload.code : "";
  const mode =
    payload.mode === "runOnceForEachItem" ? "runOnceForEachItem" : "runOnceForAllItems";
  const items = Array.isArray(payload.items) ? payload.items : [];
  const requestedIndex = typeof payload.itemIndex === "number" ? payload.itemIndex : null;

  // 用户代码被包成 async 函数体：支持 return / const / 循环，也支持 await。
  const fn = new AsyncFunction(
    ...SHADOWED_GLOBALS,
    ...SCOPE_KEYS,
    '"use strict";' + String.fromCharCode(10) + code
  );
  const shadowArgs = SHADOWED_GLOBALS.map(function () { return undefined; });

  function invoke(index) {
    const item = items[index] || null;
    const json = item && item.json && typeof item.json === "object" ? item.json : {};
    const input = createInput(items, item);
    return fn.apply(null, shadowArgs.concat([items, input, json, item, index, 0, console]));
  }

  if (mode === "runOnceForEachItem") {
    // 给了 itemIndex（单条预览 / 代码节点逐条调用）就返回该项的单个结果；
    // 没给才按 item 顺序跑完并返回数组——两种用法都常见，不能混成一个形状。
    if (requestedIndex !== null) return invoke(clampIndex(requestedIndex, items.length));
    const results = [];
    for (let index = 0; index < items.length; index += 1) results.push(await invoke(index));
    return results;
  }

  const index = requestedIndex === null ? 0 : clampIndex(requestedIndex, items.length);
  return invoke(index);
}

self.onmessage = async function (event) {
  const payload = event && event.data ? event.data : {};
  try {
    const value = await execute(payload);
    self.postMessage({ ok: true, value: value });
  } catch (error) {
    self.postMessage({ ok: false, error: { message: describeError(error) } });
  }
};
`;

/**
 * 生成 Worker 源码。
 *
 * 导出给测试与诊断用（测试会用 `node:vm` 跑它来验证协议；生产路径由 runUserCode 内部调用）。
 */
export function buildCodeSandboxWorkerSource(): string {
  return WORKER_SOURCE_TEMPLATE.replace(
    "__SHADOWED_GLOBALS__",
    JSON.stringify(SHADOWED_GLOBALS),
  ).replace("__CODE_SCOPE_KEYS__", JSON.stringify(CODE_SCOPE_KEYS));
}

/**
 * 默认 Worker 工厂：Blob URL + `new Worker`。
 *
 * 每次调用现算环境，不在模块加载时判断——测试可以 stub 全局 Worker 后再走 Worker 分支，
 * 而且 SSR / jsdom 里 import 本模块**不会**实例化任何 Worker。
 */
function createDefaultWorkerFactory(): SandboxWorkerFactory | null {
  if (typeof Worker !== "function" || typeof Blob !== "function") return null;
  if (typeof URL === "undefined" || typeof URL.createObjectURL !== "function") return null;
  if (typeof URL.revokeObjectURL !== "function") return null;
  return (source: string): SandboxWorker => {
    const blobUrl = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
    let worker: Worker;
    try {
      worker = new Worker(blobUrl);
    } catch (error) {
      URL.revokeObjectURL(blobUrl);
      throw error;
    }
    const messageHandlers: Array<(data: unknown) => void> = [];
    const errorHandlers: Array<(error: Error) => void> = [];
    worker.onmessage = (event: MessageEvent): void => {
      for (const handler of messageHandlers) handler((event as MessageEvent).data);
    };
    worker.onerror = (event: ErrorEvent): void => {
      for (const handler of errorHandlers) {
        handler(new Error(event.message || "代码沙箱内部错误"));
      }
    };
    return {
      postMessage(message: unknown): void {
        worker.postMessage(message);
      },
      terminate(): void {
        worker.terminate();
        URL.revokeObjectURL(blobUrl);
      },
      onMessage(handler: (data: unknown) => void): void {
        messageHandlers.push(handler);
      },
      onError(handler: (error: Error) => void): void {
        errorHandlers.push(handler);
      },
    };
  };
}

/** 当前环境能否真的起 Web Worker（jsdom / SSR 为 false，走同步 fallback）。 */
export function isWorkerSandboxAvailable(): boolean {
  return createDefaultWorkerFactory() !== null;
}

// ---------------------------------------------------------------------------
// 执行路径
// ---------------------------------------------------------------------------

type CompiledCodeFunction = (...args: unknown[]) => Promise<unknown>;

type AsyncFunctionConstructor = new (...args: string[]) => CompiledCodeFunction;

const AsyncFunctionRef = Object.getPrototypeOf(async (): Promise<void> => undefined)
  .constructor as AsyncFunctionConstructor;

/** 把用户代码编译成 async 函数（fallback 用；Worker 里有一份同逻辑）。 */
function compileUserCodeFunction(code: string): CompiledCodeFunction {
  try {
    return new AsyncFunctionRef(
      ...SHADOWED_GLOBALS,
      ...CODE_SCOPE_KEYS,
      `"use strict";\n${code}\n`,
    );
  } catch (error) {
    throw new UserCodeError(`代码语法有误：${errorMessage(error)}`);
  }
}

/**
 * 执行入口：自动选择 Worker / fallback。
 *
 * 所有模式共用同一套前置检查（空代码、静态安全扫描、取消信号），
 * 保证「走哪条执行路径」不影响用户看到的行为。
 */
function executeRun(deps: UserCodeSandboxOptions, options: RunUserCodeOptions): Promise<unknown> {
  const items = Array.isArray(options.items) ? options.items : [];
  const code = typeof options.code === "string" ? options.code : "";
  const timeoutMs = normalizeTimeout(options.timeoutMs);
  if (options.signal?.aborted) return Promise.reject(new UserCodeError("代码执行已取消"));
  if (code.trim() === "") return Promise.resolve(emptyCodeResult(options.mode, items, options.itemIndex));
  const unsafe = findUnsafeSource(code);
  if (unsafe) return Promise.reject(new UserCodeError(unsafe));

  const factory =
    deps.workerFactory === null ? null : (deps.workerFactory ?? createDefaultWorkerFactory());
  const request: RunUserCodeOptions = { ...options, code, items };
  if (factory) return executeInWorker(factory, request, timeoutMs);
  return executeInFallback(request, timeoutMs);
}

function executeInWorker(
  factory: SandboxWorkerFactory,
  options: RunUserCodeOptions & { items: Item[] },
  timeoutMs: number,
): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    let worker: SandboxWorker;
    try {
      worker = factory(buildCodeSandboxWorkerSource());
    } catch (error) {
      reject(new UserCodeError(`代码沙箱启动失败：${errorMessage(error)}`));
      return;
    }

    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      worker.terminate();
    };
    const succeed = (value: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onAbort = (): void => fail(new UserCodeError("代码执行已取消"));

    worker.onMessage((data) => {
      const response = (data ?? null) as WorkerResponse | null;
      if (!response || typeof response !== "object") {
        fail(new UserCodeError("代码沙箱返回了无法识别的结果"));
        return;
      }
      if (response.ok === true) {
        succeed(response.value);
        return;
      }
      const message =
        typeof response.error?.message === "string" ? response.error.message : "代码执行出错";
      fail(new UserCodeError(message));
    });
    worker.onError((error) => fail(new UserCodeError(`代码沙箱运行出错：${error.message}`)));

    if (options.signal) {
      if (options.signal.aborted) {
        fail(new UserCodeError("代码执行已取消"));
        return;
      }
      options.signal.addEventListener("abort", onAbort, { once: true });
    }
    timer = setTimeout(
      () => fail(new UserCodeError(`代码执行超时（超过 ${timeoutMs} 毫秒，已终止）`)),
      timeoutMs,
    );
    try {
      const request: WorkerRequest = {
        code: options.code,
        mode: options.mode,
        items: options.items,
        itemIndex: options.itemIndex,
      };
      worker.postMessage(request);
    } catch (error) {
      fail(new UserCodeError(`代码沙箱通信失败：${errorMessage(error)}`));
    }
  });
}

function buildScopeArgs(items: Item[], index: number): unknown[] {
  const item = items[index];
  const json = item && isPlainObject(item.json) ? item.json : {};
  const input = {
    all: (): Item[] => items,
    first: (): Item | null => items[0] ?? null,
    last: (): Item | null => items[items.length - 1] ?? null,
    item: item ?? null,
  };
  return [items, input, json, item ?? null, index, 0, console];
}

/**
 * 同步 fallback：没有 Worker 时用同 realm 的受限执行。
 *
 * 注意：同步死循环无法被打断（JS 单线程没有抢占）；这里的超时只能兜住「异步未返回」
 * （例如用户返回一个永不 resolve 的 Promise）。真实运行环境有 Worker 时不存在这个限制。
 */
function executeInFallback(
  options: RunUserCodeOptions & { items: Item[] },
  timeoutMs: number,
): Promise<unknown> {
  let fn: CompiledCodeFunction;
  try {
    fn = compileUserCodeFunction(options.code);
  } catch (error) {
    return Promise.reject(
      error instanceof UserCodeError ? error : new UserCodeError(`代码语法有误：${errorMessage(error)}`),
    );
  }
  const items = options.items;
  const shadowArgs: undefined[] = SHADOWED_GLOBALS.map(() => undefined);
  const invoke = async (index: number): Promise<unknown> => {
    try {
      return await fn(...shadowArgs, ...buildScopeArgs(items, index));
    } catch (error) {
      // Worker 路径在 Worker 里做同样的包装；fallback 也要一致，否则错误文案会两套。
      if (error instanceof UserCodeError) throw error;
      throw new UserCodeError(`代码执行出错：${errorMessage(error)}`);
    }
  };

  const execute = async (): Promise<unknown> => {
    if (options.mode === "runOnceForEachItem") {
      // 与 Worker 路径同语义：给了 itemIndex 返回单值，未给返回数组。
      if (options.itemIndex !== undefined) {
        return invoke(clampIndex(options.itemIndex, items.length));
      }
      const results: unknown[] = [];
      for (let index = 0; index < items.length; index += 1) results.push(await invoke(index));
      return results;
    }
    return invoke(clampIndex(options.itemIndex ?? 0, items.length));
  };
  return withTimeout(execute(), timeoutMs, options.signal);
}

function withTimeout<T>(
  task: Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = (): void => finish(() => reject(new UserCodeError("代码执行已取消")));
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      action();
    };
    // 先挂 then 再判取消：否则「调用前已 abort」时用户代码的 Promise 无人接管，
    // 万一它随后 reject 会变成 unhandledRejection。
    task.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) =>
        finish(() => reject(error instanceof Error ? error : new UserCodeError(String(error)))),
    );
    timer = setTimeout(
      () => finish(() => reject(new UserCodeError(`代码执行超时（超过 ${timeoutMs} 毫秒，已终止）`))),
      timeoutMs,
    );
    if (signal) {
      if (signal.aborted) {
        finish(() => reject(new UserCodeError("代码执行已取消")));
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

// ---------------------------------------------------------------------------
// 公开 API
// ---------------------------------------------------------------------------

/** 代码节点运行器（满足 types.ts 的 `UserCodeRunner` 形状，可直接注入引擎）。 */
export function runUserCode(options: RunUserCodeOptions): Promise<unknown> {
  return createUserCodeRunner()(options);
}

/**
 * 造一个自定义运行器（主要给测试注入 mock Worker / 强制 fallback）。
 * 生产代码直接用 `runUserCode` 即可。
 */
export function createUserCodeRunner(deps: UserCodeSandboxOptions = {}): UserCodeRunner {
  return (options: RunUserCodeOptions): Promise<unknown> => executeRun(deps, options);
}

/**
 * 把用户代码的返回值收敛成 `Item[]`（代码节点用）。
 *
 * 规则（尽量宽容，避免用户为了“格式”多写一堆包装）：
 * - 数组逐项处理；非数组视为单值；
 * - 已是 `{json: {...}}` 形状的保留（binary / pairedItem 一并带上）；
 * - 普通对象包成 `{json: 对象}`；
 * - 其它原始值包成 `{json: {value: 原始值}}`（json 必须是对象，这是类型约束）。
 */
export function normalizeUserCodeResult(result: unknown): Item[] {
  if (result === undefined || result === null) return [];
  const list = Array.isArray(result) ? result : [result];
  return list.map(normalizeSingleResult);
}

function normalizeSingleResult(value: unknown): Item {
  if (isPlainObject(value)) {
    const json = value["json"];
    if (isPlainObject(json)) {
      const item: Item = { json };
      const binary = value["binary"];
      if (isPlainObject(binary)) item.binary = binary as Item["binary"];
      const pairedItem = value["pairedItem"];
      if (pairedItem !== undefined) item.pairedItem = pairedItem as Item["pairedItem"];
      return item;
    }
    return { json: value };
  }
  return { json: { value } };
}
