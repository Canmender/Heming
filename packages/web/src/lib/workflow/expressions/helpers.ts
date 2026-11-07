/**
 * 表达式求值与代码沙箱**共用**的内置函数与「危险入口」清单。
 *
 * 为什么集中在这里：
 * - 表达式和代码节点必须遮蔽同一批全局对象（fetch / window / process …），
 *   规则只写一份，避免两边各维护一份清单后慢慢漂移；
 * - helper（`$if` / `$length` / `$sum` …）被注入求值作用域，实现与作用域装配分开后，
 *   index.ts 只负责「怎么绑」，这里只管「绑什么」，单测也能直接覆盖纯函数。
 *
 * 安全边界的口径（与 CONTRACT.md §2.3 一致，别过度设计）：
 * - 表达式/代码由**本机用户本人**写在工作流里，信任级别等于本人写的本地脚本；
 *   目标只是防误用（顺手写 fetch）与挡明显的逃逸写法（constructor.constructor、__proto__），
 *   不是对抗恶意代码。
 * - 这一层是「静态扫描 + 参数遮蔽」：能给出可读的中文错误；真正的隔离在代码节点的
 *   Web Worker（见 sandbox.ts）——Worker 里本来就没有 DOM/存储，网络入口再被遮蔽。
 */

import type { Item } from "../types.js";

// ---------------------------------------------------------------------------
// 危险入口清单
// ---------------------------------------------------------------------------

/**
 * 表达式与代码节点里一律不可用的全局名字。
 *
 * 清单刻意包含「本可以用但会带来副作用」的入口（定时器、弹窗、postMessage），
 * 因为工作流节点应当是**纯函数式**的一步：自己定时/开窗会让超时与取消语义失控。
 */
export const FORBIDDEN_GLOBALS = [
  // 页面 / 窗口状态
  "window",
  "document",
  "self",
  "top",
  "parent",
  "frames",
  "location",
  "navigator",
  "alert",
  "confirm",
  "prompt",
  "open",
  "postMessage",
  // 浏览器存储
  "localStorage",
  "sessionStorage",
  "indexedDB",
  "caches",
  // 网络
  "fetch",
  "XMLHttpRequest",
  "WebSocket",
  "EventSource",
  "importScripts",
  // Worker / 宿主
  "Worker",
  "SharedWorker",
  "ServiceWorker",
  "require",
  "module",
  "exports",
  "process",
  "global",
  "globalThis",
  // 动态执行字符串代码（能直接绕开作用域遮蔽）
  "eval",
  "Function",
  // 定时器与调度
  "setTimeout",
  "setInterval",
  "setImmediate",
  "clearTimeout",
  "clearInterval",
  "queueMicrotask",
  "requestAnimationFrame",
  "requestIdleCallback",
] as const;

const FORBIDDEN_SET: ReadonlySet<string> = new Set(FORBIDDEN_GLOBALS);

/**
 * 能作为 `new Function` / `AsyncFunction` 形参名的遮蔽名单。
 *
 * 严格模式函数的形参不能叫 `eval` / `arguments`（V8 会抛 SyntaxError），
 * 所以这两个名字不放进形参表，只靠静态扫描拦（`eval(` 本身就是明显写法）。
 */
export const SHADOWED_GLOBALS: readonly string[] = FORBIDDEN_GLOBALS.filter(
  (name) => name !== "eval",
);

const NETWORK_GLOBALS: ReadonlySet<string> = new Set([
  "fetch",
  "XMLHttpRequest",
  "WebSocket",
  "EventSource",
  "importScripts",
]);

const STORAGE_GLOBALS: ReadonlySet<string> = new Set([
  "localStorage",
  "sessionStorage",
  "indexedDB",
  "caches",
]);

const PAGE_GLOBALS: ReadonlySet<string> = new Set([
  "window",
  "document",
  "self",
  "top",
  "parent",
  "frames",
  "location",
  "navigator",
  "alert",
  "confirm",
  "prompt",
  "open",
  "postMessage",
]);

const HOST_GLOBALS: ReadonlySet<string> = new Set([
  "require",
  "module",
  "exports",
  "process",
  "global",
  "globalThis",
  "Worker",
  "SharedWorker",
  "ServiceWorker",
]);

const TIMER_GLOBALS: ReadonlySet<string> = new Set([
  "setTimeout",
  "setInterval",
  "setImmediate",
  "clearTimeout",
  "clearInterval",
  "queueMicrotask",
  "requestAnimationFrame",
  "requestIdleCallback",
]);

/** 给某个被禁全局对象一句「为什么不行 + 替代方案」。 */
export function describeForbiddenGlobal(name: string): string {
  if (NETWORK_GLOBALS.has(name)) {
    return `不允许访问「${name}」：表达式和代码节点都没有网络入口，需要发请求请用 HTTP 请求节点`;
  }
  if (STORAGE_GLOBALS.has(name)) {
    return `不允许访问「${name}」：表达式和代码节点不能读写浏览器存储，跨运行数据请用工作流变量`;
  }
  if (TIMER_GLOBALS.has(name)) {
    return `不允许使用「${name}」：表达式和代码节点不支持自行调度定时器（超时与取消会失控）`;
  }
  if (PAGE_GLOBALS.has(name)) {
    return `不允许访问「${name}」：表达式和代码节点没有页面/窗口环境`;
  }
  if (HOST_GLOBALS.has(name)) {
    return `不允许访问「${name}」：表达式和代码节点没有 Node 宿主能力`;
  }
  if (name === "eval" || name === "Function") {
    return `不允许使用「${name}」动态执行字符串代码：这会绕开作用域遮蔽`;
  }
  return `不允许访问「${name}」：该全局对象在表达式与代码节点里不可用`;
}

/**
 * 扫描一段「用户写的 JS 源码」里有没有明显越界写法。
 *
 * 返回中文错误；没问题返回 null。规则：
 * 1. 裸标识符命中 `FORBIDDEN_GLOBALS`（`$json.window` 这类**属性名**不算）；
 * 2. 出现 `constructor` / `__proto__` —— 原型链逃逸的入口，字符串形式也一样拦；
 * 3. 动态 `import(` —— 会绕过作用域直接加载模块。
 *
 * 为减少误报，扫描前把字符串/注释/模板字符串的**纯文本部分**遮成空格，
 * 但模板字符串 `${…}` 里的代码会被保留（那仍是会执行的代码）。
 */
export function findUnsafeSource(source: string): string | null {
  const masked = maskStringsAndComments(source);
  const bare = /(?<![.\w$])([A-Za-z_$][\w$]*)\b(?!\s*:)/g;
  let match: RegExpExecArray | null;
  while ((match = bare.exec(masked)) !== null) {
    const name = match[1];
    if (name && FORBIDDEN_SET.has(name)) return describeForbiddenGlobal(name);
  }
  // 原型链逃逸：`constructor` / `__proto__` 的**变量用法与属性访问**都拦。
  // 分三段而不是直接扫原文，是为了不误伤 `'constructor'` 这种纯字符串；
  // 方括号取属性必须扫原文——遮掉字符串后 `$json["constructor"]` 会漏掉。
  const dangerousName = /(?<![.\w$])(constructor|__proto__)\b/.exec(masked)?.[1]
    ?? /\.\s*(constructor|__proto__)\b/.exec(masked)?.[1]
    ?? /\[\s*["'`](constructor|__proto__)["'`]\s*\]/.exec(source)?.[1];
  if (dangerousName === "constructor") {
    return "不允许访问「constructor」：它可以顺着原型链拿到 Function，从而绕开沙箱限制";
  }
  if (dangerousName === "__proto__") {
    return "不允许访问「__proto__」：它可以读写原型链，从而绕开沙箱限制";
  }
  if (/\bimport\s*\(/.test(masked)) {
    return "不允许使用动态 import()：表达式与代码节点没有模块加载能力";
  }
  return null;
}

/**
 * 把字符串字面量、注释、模板字符串的文本部分替换成空格（保留换行与代码部分）。
 *
 * 为什么需要它：`$json.type === "window"` 里的 `window` 只是文本，不该被当成访问全局；
 * 而模板字符串 `` `${fetch("x")}` `` 里的 fetch 是真代码，必须保留下来被扫出来。
 */
export function maskStringsAndComments(source: string): string {
  const output: string[] = new Array(source.length);
  for (let i = 0; i < source.length; i += 1) {
    output[i] = source[i] === "\n" ? "\n" : " ";
  }

  const maskRange = (start: number, end: number): void => {
    for (let i = start; i < end && i < source.length; i += 1) {
      if (source[i] !== "\n") output[i] = " ";
    }
  };

  const skipString = (start: number): number => {
    const quote = source[start];
    let i = start + 1;
    while (i < source.length) {
      const char = source[i];
      if (char === "\\") {
        i += 2;
        continue;
      }
      if (char === quote) return i + 1;
      i += 1;
    }
    return i;
  };

  const skipTemplate = (start: number): number => {
    let i = start + 1;
    while (i < source.length) {
      const char = source[i];
      if (char === "\\") {
        i += 2;
        continue;
      }
      if (char === "`") return i + 1;
      if (char === "$" && source[i + 1] === "{") {
        maskRange(start, i + 2);
        output[i] = "$";
        output[i + 1] = "{";
        i = scanCode(i + 2, true);
        if (i < source.length && source[i] === "}") {
          output[i] = "}";
          i += 1;
        }
        continue;
      }
      i += 1;
    }
    maskRange(start, i);
    return i;
  };

  const scanCode = (start: number, stopAtClosingBrace: boolean): number => {
    let i = start;
    let depth = 0;
    while (i < source.length) {
      const char = source[i];
      if (stopAtClosingBrace && depth === 0 && char === "}") return i;
      if (char === '"' || char === "'") {
        const end = skipString(i);
        maskRange(i, end);
        i = end;
        continue;
      }
      if (char === "`") {
        const end = skipTemplate(i);
        i = end;
        continue;
      }
      if (char === "/" && source[i + 1] === "/") {
        const startComment = i;
        while (i < source.length && source[i] !== "\n") i += 1;
        maskRange(startComment, i);
        continue;
      }
      if (char === "/" && source[i + 1] === "*") {
        const startComment = i;
        i += 2;
        while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) i += 1;
        i = Math.min(source.length, i + 2);
        maskRange(startComment, i);
        continue;
      }
      if (char === "{") depth += 1;
      else if (char === "}") depth -= 1;
      if (char !== undefined) output[i] = char;
      i += 1;
    }
    return i;
  };

  scanCode(0, false);
  return output.join("");
}

// ---------------------------------------------------------------------------
// 通用小工具
// ---------------------------------------------------------------------------

/** 只认「plain object」：Date / WorkflowDate / Map 这类实例不能被当成参数对象递归拆开。 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** 表达式拼进文本时的字符串化：null/undefined 变空串，对象走 JSON。 */
export function stringifyValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (typeof value === "function") return "";
  try {
    const json = JSON.stringify(value);
    return json ?? String(value);
  } catch {
    return String(value);
  }
}

// ---------------------------------------------------------------------------
// 内置函数（注入表达式作用域；名字就是表达式里看到的 `$if` / `$length` …）
// ---------------------------------------------------------------------------

/** `$if(条件, 真值, 假值)`：避免表达式里写长串 `? :`。 */
export function $if<T>(condition: unknown, whenTrue: T, whenFalse: T): T {
  return condition ? whenTrue : whenFalse;
}

/** `$isEmpty(值)`：null / 空串 / 空数组 / 空对象。 */
export function $isEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  if (isPlainObject(value)) return Object.keys(value).length === 0;
  return false;
}

/** `$length(值)`：字符串/数组长度，对象键数；别的返回 0。 */
export function $length(value: unknown): number {
  if (typeof value === "string" || Array.isArray(value)) return value.length;
  if (isPlainObject(value)) return Object.keys(value).length;
  return 0;
}

/** `$toJson(值)`：序列化成 JSON 文本（失败给 "null"，避免表达式整体抛错）。 */
export function $toJson(value: unknown): string {
  try {
    const json = JSON.stringify(value ?? null);
    return json ?? "null";
  } catch {
    return "null";
  }
}

/** `$fromJson(文本)`：解析 JSON；解析失败给 null（让用户自己用 $if 兜底）。 */
export function $fromJson(text: unknown): unknown {
  if (typeof text !== "string") return text;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** `$number(值)`：转数字，非有限数给 0（表达式里 NaN 会污染后续计算）。 */
export function $number(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const parsed = typeof value === "string" && value.trim() === "" ? Number.NaN : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** `$string(值)`：与文本拼接时的字符串化规则一致。 */
export function $string(value: unknown): string {
  return stringifyValue(value);
}

/** `$boolean(值)`：中文/英文真值字面量都认，避免 `Boolean("false") === true` 的坑。 */
export function $boolean(value: unknown): boolean {
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "false" || normalized === "0" || normalized === "no") return false;
    if (normalized === "off" || normalized === "否" || normalized === "") return false;
    return true;
  }
  return Boolean(value);
}

let uuidCounter = 0;

/**
 * `$uuid()`：本机 UUID v4。
 *
 * 环境没有 `crypto.randomUUID` 时用 `getRandomValues`；再没有就退到「时间 + 自增」——
 * 形状仍是 UUID，但**不可用于密钥**（表达式里的 id 只用于去重/标记）。
 */
export function $uuid(): string {
  const cryptoObject = typeof crypto !== "undefined" ? crypto : undefined;
  if (cryptoObject?.randomUUID) return cryptoObject.randomUUID();
  if (cryptoObject?.getRandomValues) {
    const bytes = cryptoObject.getRandomValues(new Uint8Array(16));
    bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
    bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
    const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  uuidCounter += 1;
  const time = Date.now().toString(16).padStart(12, "0");
  return `00000000-0000-4000-8000-${time.slice(-12)}${uuidCounter.toString(16).padStart(4, "0")}`;
}

/** `$random()`：0–1 随机数（不被当作密钥使用）。 */
export function $random(): number {
  return Math.random();
}

/**
 * 在 `{json: {...}}` 包装的 item 或普通对象上按点路径取值。
 *
 * `$sum($items, "金额")` 这种写法里，传进来的是 item（值在 `.json` 下），
 * 但用户也可能直接传 `$items.map(i => i.json)`，所以这里先尝试直接取值，取不到再拆 `.json`。
 */
export function readPath(value: unknown, path: string): unknown {
  const segments = path.split(".").filter((segment) => segment !== "");
  if (segments.length === 0) return value;
  let current: unknown = value;
  if (
    isPlainObject(current) &&
    segments[0] !== undefined &&
    !(segments[0] in current) &&
    isPlainObject(current["json"])
  ) {
    current = current["json"];
  }
  for (const segment of segments) {
    if (!isPlainObject(current) && !Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function toNumericList(values: unknown, field?: unknown): number[] {
  if (!Array.isArray(values)) return [];
  const path = typeof field === "string" && field.trim() !== "" ? field : null;
  const numbers: number[] = [];
  for (const entry of values) {
    const raw = path ? readPath(entry, path) : entry;
    const parsed = typeof raw === "number" ? raw : Number(raw);
    if (Number.isFinite(parsed)) numbers.push(parsed);
  }
  return numbers;
}

/** `$sum(列表, 字段?)`：求和；字段支持点路径，可省略（列表就是数字）。 */
export function $sum(values: unknown, field?: unknown): number {
  return toNumericList(values, field).reduce((total, value) => total + value, 0);
}

/** `$max(列表, 字段?)`：最大值；空列表给 null（给 -Infinity 更难排查）。 */
export function $max(values: unknown, field?: unknown): number | null {
  const numbers = toNumericList(values, field);
  return numbers.length === 0 ? null : Math.max(...numbers);
}

/** `$min(列表, 字段?)`：最小值；空列表给 null。 */
export function $min(values: unknown, field?: unknown): number | null {
  const numbers = toNumericList(values, field);
  return numbers.length === 0 ? null : Math.min(...numbers);
}

/** `$keys(对象)`：对象键数组；非对象给空数组（便于直接 `.join()`）。 */
export function $keys(value: unknown): string[] {
  return isPlainObject(value) ? Object.keys(value) : [];
}

/** `$merge(对象1, 对象2, …)`：浅合并，后面的覆盖前面的；非对象参数忽略。 */
export function $merge(...sources: unknown[]): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const source of sources) {
    if (!isPlainObject(source)) continue;
    Object.assign(merged, source);
  }
  return merged;
}

/** `$split(文本, 分隔符=",")`：拆分字符串。 */
export function $split(text: unknown, separator?: unknown): string[] {
  const source = stringifyValue(text);
  if (separator instanceof RegExp) return source.split(separator);
  if (typeof separator === "string") {
    if (separator === "") return [...source];
    return source.split(separator);
  }
  return source.split(",");
}

/** `$trim(文本)`：去首尾空白。 */
export function $trim(text: unknown): string {
  return stringifyValue(text).trim();
}

/** `$lower(文本)` / `$upper(文本)`：大小写转换。 */
export function $lower(text: unknown): string {
  return stringifyValue(text).toLowerCase();
}

export function $upper(text: unknown): string {
  return stringifyValue(text).toUpperCase();
}

/** `$match(文本, 模式)`：是否匹配；模式可以是正则或正则字符串，非法正则给 false。 */
export function $match(text: unknown, pattern: unknown): boolean {
  const source = stringifyValue(text);
  try {
    if (pattern instanceof RegExp) return new RegExp(pattern.source, pattern.flags).test(source);
    if (typeof pattern === "string") return new RegExp(pattern).test(source);
  } catch {
    return false;
  }
  return false;
}

/** `$replace(文本, 查找, 替换)`：查找可以是字符串或正则。 */
export function $replace(text: unknown, search: unknown, replacement: unknown): string {
  const source = stringifyValue(text);
  const replacementText = stringifyValue(replacement);
  try {
    if (search instanceof RegExp) {
      return source.replace(new RegExp(search.source, search.flags), replacementText);
    }
    return source.replace(stringifyValue(search), replacementText);
  } catch {
    return source;
  }
}

/** `$item(index)` 依赖当前 items，由 index.ts 在装配作用域时用闭包生成。 */
export type ScopeItemGetter = (index: number) => Item | null;
