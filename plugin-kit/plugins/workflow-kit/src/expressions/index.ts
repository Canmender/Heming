/**
 * 表达式求值（公开入口）。
 *
 * 契约（**不要改签名**，引擎与 UI 都依赖它）：
 * - `hasExpression(value)`：任意参数值里是否含 `{{ … }}`；
 * - `evaluateExpression(body, ctx)`：求值单个表达式体（不含花括号）；
 * - `resolveValue(value, ctx)`：把任意参数值里的表达式全部替换掉；
 * - `resolveParameters(parameters, ctx)`：深拷贝一份已解析的参数；
 * - `buildExpressionContext(input)`：按「当前 item + 已执行节点输出」造求值上下文。
 *
 * 语义参考 n8n 的公开文档（`{{ }}` 模板 + 受限作用域：`$json` / `$items` / `$node` /
 * `$now` / `$today` / `$vars` …），实现是本仓自己的。两条核心规则：
 * 1. 整段就是一个 `{{ }}` ⇒ **保留原始类型**（数字/数组/对象不被字符串化）；
 * 2. 表达式夹在文本里 ⇒ 按字符串拼接（`Bearer {{ $json.token }}`）。
 *
 * 安全边界（写清楚，别让后来者误会）：
 * - 表达式由**本机用户在工作流里自己写**，与本机脚本同级信任——不是外部输入；
 * - 目标是防误用与挡明显逃逸：`window` / `document` / `fetch` / `localStorage` 等名字
 *   被静态拒绝（见 helpers.ts 的 `findUnsafeSource`），并作为 undefined 形参再遮蔽一层；
 *   `constructor.constructor` / `__proto__` / 动态 `import()` 这类绕过写法直接拒绝；
 * - 需要网络/存储的能力一律走节点（HTTP 节点、大模型节点等），表达式里没有这些入口；
 * - 代码节点的真正隔离在 `sandbox.ts`（Node 版 `node:vm`）——本文件跑在宿主 realm，
 *   两者安全模型不同：这里靠扫描 + 遮蔽，代码节点靠独立 context。
 *
 * 编译缓存：同一段表达式在循环里会求值上千次，所以按源码字符串缓存编译结果；
 * 缓存只存函数，不存上下文（上下文每次调用传入），因此不会串数据。
 */

import { createWorkflowDate, type WorkflowDateImpl } from "./date.js";
import {
  $boolean,
  $fromJson,
  $if,
  $isEmpty,
  $keys,
  $length,
  $lower,
  $match,
  $max,
  $merge,
  $min,
  $number,
  $random,
  $replace,
  $split,
  $string,
  $sum,
  $toJson,
  $trim,
  $upper,
  $uuid,
  findUnsafeSource,
  isPlainObject,
  SHADOWED_GLOBALS,
  stringifyValue,
} from "./helpers.js";
import type { DateUnit, ExpressionContext, Item, WorkflowDate } from "../types.js";

export {
  runUserCode,
  createUserCodeRunner,
  isWorkerSandboxAvailable,
  normalizeUserCodeResult,
  UserCodeError,
  DEFAULT_USER_CODE_TIMEOUT_MS,
} from "./sandbox.js";
export type { UserCodeSandboxOptions } from "./sandbox.js";

/** 表达式错误：带表达式片段，避免用户只看到 "Unexpected token" 猜不到是哪一段。 */
export class ExpressionError extends Error {
  readonly expression: string;

  constructor(message: string, expression: string) {
    const snippet = expression.trim();
    super(snippet ? `${message}（表达式：{{ ${clipSnippet(snippet)} }}）` : message);
    this.name = "ExpressionError";
    this.expression = expression;
  }
}

const SNIPPET_MAX = 120;

function clipSnippet(text: string): string {
  return text.length > SNIPPET_MAX ? `${text.slice(0, SNIPPET_MAX)}…` : text;
}

// ---------------------------------------------------------------------------
// 模板扫描：把 `"Bearer {{ $json.token }}"` 切成文本/表达式片段
// ---------------------------------------------------------------------------

interface TemplateToken {
  kind: "text" | "expression";
  value: string;
}

/**
 * 切分模板字符串。
 *
 * 比正则 `/\{\{([\s\S]+?)\}\}/` 多做的两件事（都是实际会踩的坑）：
 * - 表达式里出现对象字面量（`{{ { a: 1 } }}`）时，按花括号层级找真正的结尾，
 *   `}}` 只在层级为 0 时才是闭合；
 * - 字符串里的 `}}`（`{{ "}}" }}`）不算闭合。
 *
 * 没闭合的 `{{` 与空表达式（`{{ }}`）都当普通文本保留——用户少打一个括号时，
 * 原样显示比把整段参数变成空串更容易发现问题。
 */
function scanTemplate(text: string): TemplateToken[] {
  const tokens: TemplateToken[] = [];
  let index = 0;
  let textStart = 0;
  while (index < text.length) {
    if (text[index] === "{" && text[index + 1] === "{") {
      if (index > textStart) tokens.push({ kind: "text", value: text.slice(textStart, index) });
      const end = findExpressionEnd(text, index + 2);
      if (end === -1) {
        tokens.push({ kind: "text", value: text.slice(index) });
        return tokens;
      }
      const body = text.slice(index + 2, end);
      if (body.trim() === "") {
        tokens.push({ kind: "text", value: text.slice(index, end + 2) });
      } else {
        tokens.push({ kind: "expression", value: body });
      }
      index = end + 2;
      textStart = index;
      continue;
    }
    index += 1;
  }
  if (textStart < text.length) tokens.push({ kind: "text", value: text.slice(textStart) });
  return tokens;
}

/** 找表达式的闭合 `}}`：返回第一个 `}` 的下标；找不到返回 -1。 */
function findExpressionEnd(text: string, start: number): number {
  let depth = 0;
  let quote: string | null = null;
  let index = start;
  while (index < text.length) {
    const char = text[index];
    if (quote) {
      if (char === "\\") {
        index += 2;
        continue;
      }
      if (char === quote) quote = null;
      index += 1;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      index += 1;
      continue;
    }
    if (char === "{") {
      depth += 1;
      index += 1;
      continue;
    }
    if (char === "}") {
      if (depth > 0) {
        depth -= 1;
        index += 1;
        continue;
      }
      if (text[index + 1] === "}") return index;
      index += 1;
      continue;
    }
    index += 1;
  }
  return -1;
}

/** 参数值里是否含表达式（嵌套对象/数组会递归检查）。 */
export function hasExpression(value: unknown): boolean {
  if (typeof value === "string") {
    return scanTemplate(value).some((token) => token.kind === "expression");
  }
  if (Array.isArray(value)) return value.some((entry) => hasExpression(entry));
  if (isPlainObject(value)) return Object.values(value).some((entry) => hasExpression(entry));
  return false;
}

/**
 * 编辑器里的「单表情」判断：整段就是一个 `{{ … }}`（前后空白忽略）。
 * 这种参数求值结果保留原始类型，例如返回数组/对象/数字而不是被 `String()` 掉。
 */
export function isSingleExpression(value: string): boolean {
  const meaningful = scanTemplate(value).filter(
    (token) => token.kind === "expression" || token.value.trim() !== "",
  );
  return meaningful.length === 1 && meaningful[0]?.kind === "expression";
}

// ---------------------------------------------------------------------------
// 作用域装配与编译缓存
// ---------------------------------------------------------------------------

/** 表达式里可用的作用域名字（顺序即 `new Function` 的形参顺序）。 */
const SCOPE_KEYS = [
  "$json",
  "$items",
  "$itemIndex",
  "$runIndex",
  "$node",
  "$now",
  "$today",
  "$timestamp",
  "$workflow",
  "$execution",
  "$vars",
  "$parameter",
  "$if",
  "$isEmpty",
  "$length",
  "$toJson",
  "$fromJson",
  "$number",
  "$string",
  "$boolean",
  "$uuid",
  "$random",
  "$item",
  "$sum",
  "$max",
  "$min",
  "$keys",
  "$merge",
  "$split",
  "$trim",
  "$lower",
  "$upper",
  "$match",
  "$replace",
] as const;

type ScopeKey = (typeof SCOPE_KEYS)[number];

function createScope(ctx: ExpressionContext): Record<ScopeKey, unknown> {
  return {
    $json: ctx.$json,
    $items: ctx.$items,
    $itemIndex: ctx.$itemIndex,
    $runIndex: ctx.$runIndex,
    $node: ctx.$node,
    $now: ctx.$now,
    $today: ctx.$today,
    $timestamp: ctx.$timestamp,
    $workflow: ctx.$workflow,
    $execution: ctx.$execution,
    $vars: ctx.$vars,
    $parameter: ctx.$parameter,
    $if,
    $isEmpty,
    $length,
    $toJson,
    $fromJson,
    $number,
    $string,
    $boolean,
    $uuid,
    $random,
    $item: (index: number): Item | null => {
      const target = Number(index);
      if (!Number.isFinite(target)) return null;
      return ctx.$items[Math.trunc(target)] ?? null;
    },
    $sum,
    $max,
    $min,
    $keys,
    $merge,
    $split,
    $trim,
    $lower,
    $upper,
    $match,
    $replace,
  };
}

type CompiledExpression = (...args: unknown[]) => unknown;

interface CompiledEntry {
  /** 静态扫描结果：非 null 表示这段表达式被拒绝（缓存住，循环里不重复扫）。 */
  readonly unsafe: string | null;
  readonly fn: CompiledExpression | null;
}

const compiledExpressions = new Map<string, CompiledEntry>();

/** 缓存上限：表达式数量有限，超过就丢最旧的，避免用户反复编辑把内存撑大。 */
const MAX_COMPILED_EXPRESSIONS = 500;

/** 遮蔽形参的实参（全是 undefined），模块级复用避免每次求值都 map 一遍。 */
const SHADOWED_ARGS: readonly undefined[] = SHADOWED_GLOBALS.map(() => undefined);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 取（或编译）一段表达式的缓存条目。
 *
 * 安全扫描也放进缓存：循环里同一个表达式会求值上千次，静态扫描没必要每次都跑。
 * 语法错误不缓存——用户还在编辑，下次可能就改对了。
 */
function getCompiledEntry(source: string): CompiledEntry {
  const cached = compiledExpressions.get(source);
  if (cached) return cached;
  const unsafe = findUnsafeSource(source);
  let entry: CompiledEntry;
  if (unsafe !== null) {
    entry = { unsafe, fn: null };
  } else {
    let fn: CompiledExpression;
    try {
      // eslint-disable-next-line no-new-func -- 用户自己写的表达式，见文件头的信任边界
      fn = new Function(
        ...SHADOWED_GLOBALS,
        ...SCOPE_KEYS,
        `"use strict";\nreturn (${source});`,
      ) as unknown as CompiledExpression;
    } catch (error) {
      throw new ExpressionError(`表达式语法有误：${errorMessage(error)}`, source);
    }
    entry = { unsafe: null, fn };
  }
  if (compiledExpressions.size >= MAX_COMPILED_EXPRESSIONS) {
    const oldest = compiledExpressions.keys().next();
    if (!oldest.done) compiledExpressions.delete(oldest.value);
  }
  compiledExpressions.set(source, entry);
  return entry;
}

/** 求值单个表达式体（不含花括号）。 */
export function evaluateExpression(body: string, ctx: ExpressionContext): unknown {
  const source = body.trim();
  if (!source) return "";
  const entry = getCompiledEntry(source);
  if (entry.unsafe !== null) throw new ExpressionError(entry.unsafe, source);
  const fn = entry.fn;
  if (!fn) throw new ExpressionError("表达式编译失败", source);
  const scope = createScope(ctx);
  try {
    return fn(...SHADOWED_ARGS, ...SCOPE_KEYS.map((key) => scope[key]));
  } catch (error) {
    throw toExpressionError(error, source);
  }
}

/** 把运行时异常翻成可读的中文 ExpressionError（带表达式片段）。 */
function toExpressionError(error: unknown, source: string): ExpressionError {
  if (error instanceof ExpressionError) return error;
  if (error instanceof ReferenceError) {
    const match = /^([A-Za-z_$][\w$]*)\s+is not defined$/.exec(error.message);
    const name = match?.[1];
    return new ExpressionError(
      name
        ? `表达式里用到了不存在的变量「${name}」`
        : `表达式里用到了不存在的变量：${error.message}`,
      source,
    );
  }
  if (error instanceof TypeError) {
    const nullAccess = /Cannot read properties of (undefined|null) \(reading '([^']+)'\)/.exec(
      error.message,
    );
    if (nullAccess) {
      return new ExpressionError(
        `表达式里访问了空值的属性「${nullAccess[2]}」（上游数据里没有这个字段，或节点还没运行）`,
        source,
      );
    }
    if (/Cannot read properties of (undefined|null)/.test(error.message)) {
      return new ExpressionError(
        "表达式里访问了空值（上游数据里没有这个字段，或节点还没运行）",
        source,
      );
    }
  }
  return new ExpressionError(`表达式执行出错：${errorMessage(error)}`, source);
}

// ---------------------------------------------------------------------------
// 参数解析
// ---------------------------------------------------------------------------

function resolveString(text: string, ctx: ExpressionContext): unknown {
  const tokens = scanTemplate(text);
  if (!tokens.some((token) => token.kind === "expression")) return text;
  const meaningful = tokens.filter(
    (token) => token.kind === "expression" || token.value.trim() !== "",
  );
  // 整段就是一个表达式：保留原始类型（这是「表达式能返回数组」的关键）。
  if (meaningful.length === 1 && meaningful[0]?.kind === "expression") {
    return evaluateExpression(meaningful[0].value, ctx);
  }
  let output = "";
  for (const token of tokens) {
    output +=
      token.kind === "expression"
        ? stringifyValue(evaluateExpression(token.value, ctx))
        : token.value;
  }
  return output;
}

/**
 * 解析一个参数值里的全部表达式。
 *
 * 只递归 plain object 与数组：Date / WorkflowDate 这类实例原样保留
 * （否则会被 Object.entries 拆成空对象）。返回新对象，不改原始参数。
 */
export function resolveValue(value: unknown, ctx: ExpressionContext): unknown {
  if (typeof value === "string") {
    return value.includes("{{") ? resolveString(value, ctx) : value;
  }
  if (Array.isArray(value)) return value.map((entry) => resolveValue(entry, ctx));
  if (isPlainObject(value)) {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      result[key] = resolveValue(entry, ctx);
    }
    return result;
  }
  return value;
}

/** 深拷贝 + 解析全部参数（每次节点执行前调用；不会改工作流里的原始参数）。 */
export function resolveParameters(
  parameters: Record<string, unknown>,
  ctx: ExpressionContext,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parameters)) {
    result[key] = resolveValue(value, ctx);
  }
  return result;
}

// ---------------------------------------------------------------------------
// 上下文构造（引擎用；放在这里保证「怎么造 ctx」只有一份实现）
// ---------------------------------------------------------------------------

export interface BuildExpressionContextInput {
  json: Record<string, unknown>;
  items: Item[];
  itemIndex: number;
  runIndex: number;
  nodeOutputs: Record<string, Item[]>;
  workflow: ExpressionContext["$workflow"];
  execution: ExpressionContext["$execution"];
  vars: Record<string, unknown>;
  parameter: Record<string, unknown>;
  /** 测试注入「现在」；缺省用真实时间。 */
  now?: Date;
}

/**
 * `$node` 的访问器：节点名写错/该节点还没跑时，给一句人话错误。
 *
 * 用 Proxy 而不是普通对象，是因为 `$node["HTTP 请求"].json` 的典型报错
 * "Cannot read properties of undefined (reading 'json')" 完全看不出是哪个节点。
 * 白名单放行 `toJSON` / `then` 等协议属性，否则 `$toJson($node)` / `await` 会误触发。
 */
const NODE_ACCESSOR_PROTOCOL_KEYS: ReadonlySet<string> = new Set([
  "toJSON",
  "then",
  "toString",
  "valueOf",
  "inspect",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
]);

function createNodeAccessor(
  nodeOutputs: Record<string, Item[]>,
): ExpressionContext["$node"] {
  const target: ExpressionContext["$node"] = {};
  for (const [name, items] of Object.entries(nodeOutputs)) {
    target[name] = {
      json: items[0]?.json ?? {},
      all: () => items,
    };
  }
  return new Proxy(target, {
    get(object, property, receiver) {
      if (typeof property === "string" && !NODE_ACCESSOR_PROTOCOL_KEYS.has(property)) {
        if (!(property in object)) {
          throw new Error(
            `变量 $node 里没有节点「${property}」的运行结果（节点名拼写错了，或该节点还没执行）`,
          );
        }
      }
      return Reflect.get(object, property, receiver) as unknown;
    },
  });
}

function startOfToday(date: Date): Date {
  const copy = new Date(date.getTime());
  copy.setHours(0, 0, 0, 0);
  return copy;
}

/**
 * 用「当前 item + 已执行节点的输出」造一个求值上下文。
 * `$node["名字"].json` 取该节点最近一次运行的第一条；`.all()` 取全部。
 */
export function buildExpressionContext(input: BuildExpressionContextInput): ExpressionContext {
  const nowDate = input.now ?? new Date();
  return {
    $json: input.json,
    $items: input.items,
    $itemIndex: input.itemIndex,
    $runIndex: input.runIndex,
    $node: createNodeAccessor(input.nodeOutputs),
    $now: createWorkflowDate(nowDate),
    $today: createWorkflowDate(startOfToday(nowDate)),
    $timestamp: nowDate.getTime(),
    $workflow: input.workflow,
    $execution: input.execution,
    $vars: input.vars,
    $parameter: input.parameter,
  };
}

/** 供测试用：清空表达式编译缓存。 */
export function clearExpressionCache(): void {
  compiledExpressions.clear();
}

/** 供测试/诊断用：当前缓存了多少条编译结果。 */
export function getExpressionCacheSize(): number {
  return compiledExpressions.size;
}

export type { WorkflowDate, DateUnit, WorkflowDateImpl };
