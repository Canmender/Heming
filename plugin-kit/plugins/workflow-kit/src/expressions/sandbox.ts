/**
 * 代码节点的 JS 沙箱（Node 服务版，`node:vm`）。
 *
 * 为什么从浏览器 Blob Worker 改成 `node:vm`：
 * - 服务端跑在 Node 里，没有 Worker/DOM；`vm.runInNewContext` 会给出一套**独立的
 *   全局环境**——沙箱里根本没有 `process` / `require` / `fetch` / `fs` / `Buffer` / 定时器，
 *   不需要靠「字符串黑名单」去挡（黑名单还容易误伤 `typeof process` 这种无害探测）；
 * - `vm` 的 `timeout` 能在**同步代码**里抢占执行：`while (true) {}` 也会在超时后抛出
 *   `ERR_SCRIPT_EXECUTION_TIMEOUT`，这是 Worker 的 `terminate()` 在 Node 里的等价物；
 * - 返回值用 `structuredClone` 传回宿主 realm——与旧版 Worker 的 `postMessage`
 *   结构化克隆语义一致，避免 vm-realm 对象混进引擎的数据结构；
 * - 日志由沙箱内自建的 console 收集，执行结束后由宿主统一打印：不给用户任何宿主对象引用
 *   （哪怕一个宿主函数，都能顺着 `.constructor` 摸回宿主 realm 的 `process`）。
 *
 * 隔离边界（写清楚，别让后来者误会）：
 * - 只支持**同步**用户代码（与 docs/CONTRACT.md §6.1「代码节点按同步代码定位」一致）：
 *   不支持 `await`、也不接受返回 Promise（会得到中文错误）。原因是 vm 的 timeout
 *   打不断 Promise 的异步续体，放行等于给服务端留一个卡死事件循环的口子；
 * - 传给 `vm` 的 context 必须是 **null 原型对象**：普通 `{}` 会把宿主 `Object.prototype`
 *   暴露到沙箱 `globalThis` 链上。null 原型下 vm 全局仍带一条 **vm-realm** 的
 *   Object.prototype 链（`globalThis.constructor` 是函数），但 `constructor.constructor(…)`
 *   造出的 Function 仍在 vm realm 里执行，`process`/`require` 依旧不存在——
 *   自检用例（`vm-realm 构造器拿不到宿主能力`）钉住这一点；
 * - 输入数据以 JSON 字面量嵌进源码，而不是以对象属性塞进 context：连「宿主数组/函数」
 *   都不进沙箱；
 * - 表达式引擎（index.ts）仍保留危险全局静态扫描：它跑在宿主 realm（`new Function`），
 *   和这里「真隔离」不是一回事，别把两边的规则混起来。
 *
 * 返回值语义（与旧版一致，供 core/code 节点消费）：
 * - `runOnceForAllItems`：返回用户代码的原始返回值；
 * - `runOnceForEachItem` + `itemIndex`：只跑这一项，返回该项的用户返回值（单个值）；
 * - `runOnceForEachItem` 没有 `itemIndex`：按 item 顺序返回数组；
 * - 空代码视为「原样透传」：all 模式返回 items；per-item 模式返回各项的 `json`
 *   （给了 `itemIndex` 就只返回该项的 json）。`normalizeUserCodeResult` 负责收敛成 `Item[]`。
 */

import vm from "node:vm";
import type { Item, RunUserCodeOptions, UserCodeRunner } from "../types.js";
import { isPlainObject } from "./helpers.js";

/** 代码沙箱错误：与 ExpressionError 分开，UI 能区分「表达式错」与「代码节点错」。 */
export class UserCodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserCodeError";
  }
}

/** 默认超时：代码节点 10 秒不返回就终止（CONTRACT §6.1）。 */
export const DEFAULT_USER_CODE_TIMEOUT_MS = 10_000;
const MIN_USER_CODE_TIMEOUT_MS = 50;
const MAX_USER_CODE_TIMEOUT_MS = 120_000;

/** 日志上限：用户代码里的 console 输出不该把服务端日志或内存撑爆。 */
const MAX_LOG_LINES = 200;
const MAX_LOG_LINE_LENGTH = 2_000;

/** 沙箱源码文件名：语法/运行时错误的报错信息里会带上它，方便定位。 */
const SANDBOX_FILENAME = "workflow-code.js";

/**
 * 造运行器时的可选参数（主要给测试与默认值覆盖用）。
 * 生产代码直接用 `runUserCode`；`RunUserCodeOptions.timeoutMs` 优先于这里的默认超时。
 */
export interface UserCodeSandboxOptions {
  /** 默认超时（毫秒）；缺省 10s，会被夹紧到 50ms–120s。 */
  timeoutMs?: number;
}

function errorMessage(error: unknown): string {
  if (
    error &&
    typeof error === "object" &&
    typeof (error as { message?: unknown }).message === "string"
  ) {
    return (error as { message: string }).message;
  }
  return String(error);
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

/** 输入数据要跨进沙箱，先 JSON 序列化；环引用/大整数等直接给可读错误。 */
function serializeItems(items: Item[]): string {
  try {
    return JSON.stringify(items);
  } catch (error) {
    throw new UserCodeError(`输入数据无法序列化后传入代码沙箱：${errorMessage(error)}`);
  }
}

/**
 * 生成沙箱脚本。
 *
 * 结构（重要）：
 * 1. 整个脚本是一个 IIFE，返回 envelope `{ ok, value|error, logs }`；
 * 2. 用户代码再包一层普通函数（非 async），这样 `return` 语义与旧版一致，
 *    且 `await` 会得到语法错误（同步定位，见文件头）；
 * 3. items 用 `JSON.parse(<JS 字符串字面量>)` 在沙箱内重建——不经过 context 属性。
 *
 * 脚本里只能出现沙箱自己的东西：任何宿主对象（数组/函数）都会成为逃逸入口。
 */
function buildSandboxScript(itemsJson: string, itemIndex: number, code: string): string {
  // JSON.stringify 再包一层，把用户数据变成合法的 JS 字符串字面量；
  // 这样数据里出现引号/反斜杠/换行都不会破坏源码结构。
  const itemsLiteral = JSON.stringify(itemsJson);
  return `"use strict";
(function () {
  "use strict";
  const __items = JSON.parse(${itemsLiteral});
  const __itemIndex = ${itemIndex};
  const __item = __items[__itemIndex] || null;
  const __json = __item && __item.json && typeof __item.json === "object" ? __item.json : {};
  const __logs = [];
  const __format = function (value) {
    if (typeof value === "string") return value;
    try {
      const text = JSON.stringify(value);
      return text === undefined ? String(value) : text;
    } catch (ignored) {
      return String(value);
    }
  };
  const __recordLog = function (level, args) {
    if (__logs.length >= ${MAX_LOG_LINES}) return;
    let text = "";
    for (let index = 0; index < args.length; index += 1) {
      if (index > 0) text += " ";
      text += __format(args[index]);
    }
    if (text.length > ${MAX_LOG_LINE_LENGTH}) text = text.slice(0, ${MAX_LOG_LINE_LENGTH}) + "…";
    __logs.push("[" + level + "] " + text);
  };
  const console = {
    log: function () { __recordLog("log", arguments); },
    info: function () { __recordLog("info", arguments); },
    warn: function () { __recordLog("warn", arguments); },
    error: function () { __recordLog("error", arguments); },
    debug: function () { __recordLog("debug", arguments); },
  };
  const items = __items;
  const $input = {
    all: function () { return __items; },
    first: function () { return __items.length > 0 ? __items[0] : null; },
    last: function () { return __items.length > 0 ? __items[__items.length - 1] : null; },
    item: __item,
  };
  const $json = __json;
  const $item = __item;
  const $itemIndex = __itemIndex;
  const $runIndex = 0;
  try {
    const __value = (function () {
${code}
    })();
    return { ok: true, value: __value, logs: __logs };
  } catch (error) {
    let __name = "Error";
    let __message = "未知错误";
    try {
      if (error && typeof error === "object") {
        if (typeof error.name === "string") __name = error.name;
        if (typeof error.message === "string") __message = error.message;
      } else if (typeof error === "string") {
        __message = error;
      }
    } catch (ignored) {
      // 取错误信息本身失败时保留默认文案，不能让沙箱内的错误再抛一次
    }
    return { ok: false, error: { name: __name, message: __message }, logs: __logs };
  }
})()`;
}

interface SandboxEnvelope {
  ok?: unknown;
  value?: unknown;
  error?: { name?: unknown; message?: unknown };
  logs?: unknown;
}

/** 仅从沙箱返回值里取日志（防御性读取；日志本身是字符串数组）。 */
function readLogs(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const logs: string[] = [];
  for (const entry of value) {
    if (typeof entry === "string") logs.push(entry);
    if (logs.length >= MAX_LOG_LINES) break;
  }
  return logs;
}

function flushLogs(logs: readonly string[]): void {
  for (const line of logs) {
    // 走宿主 console：这是服务端日志，不是沙箱内的 console
    console.log(line);
  }
}

function isThenable(value: unknown): boolean {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return false;
  try {
    return typeof (value as { then?: unknown }).then === "function";
  } catch {
    return false;
  }
}

/**
 * 把沙箱里的返回值复制回宿主 realm。
 *
 * 用 structuredClone 而不是直接返回对象：vm-realm 对象的原型是**另一个 realm** 的
 * `Object.prototype`，直接交给引擎会被各类 `isPlainObject` 判断错，
 * 也会让沙箱对象一直活在内存里。克隆失败（函数、Promise、Symbol 等）给中文错误。
 */
function toHostValue(value: unknown): unknown {
  if (value === undefined) return undefined;
  if (isThenable(value)) {
    throw new UserCodeError(
      "代码节点按同步执行：不支持 await 或返回 Promise，请改成同步代码后重试",
    );
  }
  try {
    return structuredClone(value);
  } catch (error) {
    const message = errorMessage(error);
    if ((error as { name?: unknown }).name === "DataCloneError") {
      throw new UserCodeError(
        `代码返回值无法从沙箱传回宿主（含函数、Symbol 等不可克隆的值）：${message}`,
      );
    }
    throw new UserCodeError(`代码返回值无法从沙箱传回宿主：${message}`);
  }
}

/** vm 同步执行超时的错误码（Node 官方常量）。 */
const VM_TIMEOUT_CODE = "ERR_SCRIPT_EXECUTION_TIMEOUT";

/**
 * 把 vm 抛出来的异常翻成中文 UserCodeError。
 *
 * 注意区分 realm：vm 里的用户错误**不是**宿主 `Error` 的实例（`instanceof` 为 false），
 * 所以用户错误走 envelope 返回；这里处理的是「脚本编译错误」与「vm 自身中断」两种宿主异常。
 */
function translateSandboxError(error: unknown, timeoutMs: number): UserCodeError {
  if (error instanceof UserCodeError) return error;
  const record = (error ?? {}) as { code?: unknown; name?: unknown };
  if (record.code === VM_TIMEOUT_CODE) {
    return new UserCodeError(`代码执行超时（超过 ${timeoutMs} 毫秒，已终止）`);
  }
  // 注意：vm 编译期抛出的 SyntaxError 属于**沙箱 realm**，`instanceof SyntaxError` 为 false，
  // 只能按 name 判断；用户运行时主动 throw 的错误会走 envelope，不会到这里。
  if (record.name === "SyntaxError") {
    return new UserCodeError(`代码语法有误：${errorMessage(error)}`);
  }
  return new UserCodeError(`代码执行出错：${errorMessage(error)}`);
}

/** 用户代码抛出的错误（沙箱内 envelope 带回）→ 中文 UserCodeError。 */
function translateUserError(error: SandboxEnvelope["error"]): UserCodeError {
  const name = typeof error?.name === "string" ? error.name : "Error";
  const message = typeof error?.message === "string" ? error.message : "未知错误";
  return new UserCodeError(`代码执行出错：${name === "Error" ? message : `${name}：${message}`}`);
}

/**
 * 在沙箱里跑一次用户代码。
 *
 * 每次调用都新建 context（不同 item 之间不共享可变状态）；
 * `timeout` 覆盖从编译源码到用户代码返回的**全部同步执行**。
 */
function executeInSandbox(
  code: string,
  itemsJson: string,
  itemIndex: number,
  timeoutMs: number,
): unknown {
  const script = buildSandboxScript(itemsJson, itemIndex, code);
  // null 原型：普通对象会把宿主 Object.prototype 挂到沙箱 globalThis 的原型链上（逃逸口）
  const context = Object.create(null) as Record<string, unknown>;
  let envelope: SandboxEnvelope;
  try {
    envelope = vm.runInNewContext(script, context, {
      timeout: timeoutMs,
      filename: SANDBOX_FILENAME,
      displayErrors: true,
    }) as SandboxEnvelope;
  } catch (error) {
    throw translateSandboxError(error, timeoutMs);
  }

  const logs = readLogs(envelope?.logs);
  if (envelope?.ok !== true) {
    try {
      throw translateUserError(envelope?.error);
    } finally {
      flushLogs(logs);
    }
  }
  const value = toHostValue(envelope?.value);
  flushLogs(logs);
  return value;
}

function runOnce(
  options: RunUserCodeOptions,
  itemsJson: string,
  itemIndex: number,
  timeoutMs: number,
): unknown {
  if (options.signal?.aborted) throw new UserCodeError("代码执行已取消");
  const value = executeInSandbox(options.code, itemsJson, itemIndex, timeoutMs);
  if (options.signal?.aborted) throw new UserCodeError("代码执行已取消");
  return value;
}

/**
 * 同步执行入口（异步 API 只是把它包成 Promise；vm 的 timeout 才是真正的超时机制）。
 */
function runSync(defaults: UserCodeSandboxOptions, options: RunUserCodeOptions): unknown {
  const items = Array.isArray(options.items) ? options.items : [];
  const code = typeof options.code === "string" ? options.code : "";
  const timeoutMs = normalizeTimeout(options.timeoutMs ?? defaults.timeoutMs);
  if (options.signal?.aborted) throw new UserCodeError("代码执行已取消");
  if (code.trim() === "") return emptyCodeResult(options.mode, items, options.itemIndex);

  const itemsJson = serializeItems(items);
  if (options.mode !== "runOnceForEachItem") {
    return runOnce(options, itemsJson, clampIndex(options.itemIndex ?? 0, items.length), timeoutMs);
  }
  // per-item：给了 itemIndex 返回单值，未给则按顺序跑完返回数组（与旧版一致）
  if (options.itemIndex !== undefined) {
    return runOnce(options, itemsJson, clampIndex(options.itemIndex, items.length), timeoutMs);
  }
  const results: unknown[] = [];
  for (let index = 0; index < items.length; index += 1) {
    results.push(runOnce(options, itemsJson, index, timeoutMs));
  }
  return results;
}

// ---------------------------------------------------------------------------
// 公开 API
// ---------------------------------------------------------------------------

/** 代码节点运行器（满足 types.ts 的 `UserCodeRunner` 形状，可直接注入引擎）。 */
export function runUserCode(options: RunUserCodeOptions): Promise<unknown> {
  return createUserCodeRunner()(options);
}

/**
 * 造一个自定义运行器（默认超时可覆盖；测试也可用）。
 * 生产代码直接用 `runUserCode` 即可。
 */
export function createUserCodeRunner(
  defaults: UserCodeSandboxOptions = {},
): UserCodeRunner {
  return (options: RunUserCodeOptions): Promise<unknown> => {
    try {
      return Promise.resolve(runSync(defaults, options));
    } catch (error) {
      return Promise.reject(
        error instanceof UserCodeError ? error : new UserCodeError(errorMessage(error)),
      );
    }
  };
}

/**
 * 兼容旧 API：浏览器版这里判断能否起 Worker；Node 版没有 Worker，恒为 false。
 * 保留导出是为了不让旧调用方/测试 import 失败。
 */
export function isWorkerSandboxAvailable(): boolean {
  return false;
}

/**
 * 把用户代码的返回值收敛成 `Item[]`（代码节点用；跨 realm 的对象已在沙箱出口克隆过）。
 *
 * 规则（尽量宽容）：
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
