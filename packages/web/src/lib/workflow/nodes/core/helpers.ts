/**
 * 核心节点共用的小工具：items 形状收敛、参数读取、条件比较、错误形状。
 *
 * 为什么集中在一处：`if` / `switch` / `filter` 必须共用**同一套**条件语义，
 * `set` / `splitOut` / `itemLists` 也必须共用**同一套** items 形状规则。
 * 如果每个节点各自复制一份比较逻辑，用户很快会看到「同样的条件在 If 里成立、
 * 在 Filter 里不成立」这种无法解释的差异；参数读取也同理（字符串数字的容错
 * 一旦分叉，UI 里存的 "10" 在某几个节点里生效、在另几个里失效）。
 *
 * 这里只放纯函数与类型，不放任何节点注册，避免 import 关系打结。
 */

import { WORKFLOW_LIMITS, type Item, type NodeExecutionContext } from "../../types.js";

/**
 * 节点主动失败时抛的错误。
 *
 * 为什么不是普通 `Error`：执行记录要写 `NodeErrorInfo`（message / description /
 * httpCode / itemIndex），这些信息必须能随异常一起穿过引擎。引擎只看到 `Error`
 * 也能工作（message 一定有），但会丢掉 httpCode 之类的细节；这里把字段做成
 * 可枚举自有属性，引擎用鸭子类型读取即可。
 */
export class WorkflowNodeError extends Error {
  readonly description?: string;
  readonly httpCode?: string;
  readonly itemIndex?: number;

  constructor(
    message: string,
    options: { description?: string; httpCode?: string; itemIndex?: number; cause?: unknown } = {},
  ) {
    super(message);
    this.name = "WorkflowNodeError";
    this.description = options.description;
    this.httpCode = options.httpCode;
    this.itemIndex = options.itemIndex;
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

/** 把任意抛出物转成人类可读的一行（错误信息统一走这里，避免 "undefined"）。 */
export function errorText(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/** 判断是不是普通对象（排除 null 与数组）。 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// items 形状
// ---------------------------------------------------------------------------

/**
 * 把「节点返回的任意值」收敛成 items。
 *
 * 代码节点与 HTTP 节点都要面对用户/服务端给的各种形状：数组、单个对象、
 * 已经是 `{json}` 的 item、甚至字符串数组。规则写在一处：
 * - 对象且**只**含 json/binary/pairedItem ⇒ 视为已经是 item，不再套一层；
 * - 普通对象 ⇒ `{json: 对象}`；
 * - 数组 ⇒ 逐个收敛并展开一层（代码节点返回数组是常态）；
 * - 其他标量 ⇒ `{json: {value: 标量}}`，保证下游永远能按字段取到值。
 */
export function normalizeToItems(value: unknown): Item[] {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) {
    const items: Item[] = [];
    for (const entry of value) items.push(...normalizeToItems(entry));
    return items;
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value);
    const itemLike =
      isPlainObject(value.json) &&
      keys.every((key) => key === "json" || key === "binary" || key === "pairedItem");
    if (itemLike) {
      // 已经是 Item 形状：原样保留（binary/pairedItem 不丢），不做二次包裹。
      return [value as unknown as Item];
    }
    return [{ json: value }];
  }
  return [{ json: { value } }];
}

/** 取某个输入口的 items（缺省第一口，找不到时返回空数组而不是 undefined）。 */
export function inputItems(context: NodeExecutionContext, inputIndex = 0): Item[] {
  return context.getInputData(inputIndex);
}

/** 取第二个输入口（Merge 等双输入节点用）。 */
export function secondaryInputItems(context: NodeExecutionContext): Item[] {
  return context.getInputData(1);
}

// ---------------------------------------------------------------------------
// 参数读取（参数已由引擎解析表达式，这里只做类型容错）
// ---------------------------------------------------------------------------

/** 读字符串参数；数字/布尔按字符串用，其它类型回退默认值。 */
export function readString(
  context: NodeExecutionContext,
  name: string,
  fallback = "",
): string {
  const value = context.getNodeParameter<unknown>(name, fallback);
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return String(value);
  return fallback;
}

/** 读数字参数；数字字符串也接受（表单里数字可能被存成字符串）。 */
export function readNumber(
  context: NodeExecutionContext,
  name: string,
  fallback: number,
): number {
  const value = context.getNodeParameter<unknown>(name, fallback);
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

/** 读布尔参数；"true"/"false"/1/0 都接受。 */
export function readBoolean(
  context: NodeExecutionContext,
  name: string,
  fallback: boolean,
): boolean {
  const value = context.getNodeParameter<unknown>(name, fallback);
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true" || normalized === "1") return true;
    if (normalized === "false" || normalized === "0" || normalized === "") return false;
  }
  return fallback;
}

/** 读枚举参数；不在白名单时回退默认值（导入的旧工作流可能带已废弃的取值）。 */
export function readOption<T extends string>(
  context: NodeExecutionContext,
  name: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const value = context.getNodeParameter<unknown>(name, fallback);
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

/** 把参数值解析成 JSON（字符串按 JSON.parse；空字符串视为 `undefined`）。 */
export function parseJsonParameter(value: unknown, what: string): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch (error) {
    throw new WorkflowNodeError(`参数「${what}」不是合法的 JSON`, {
      description: errorText(error),
    });
  }
}

/** 把参数值解析成对象（数组/标量都算错；用于 headers / query / 条件组）。 */
export function readJsonObject(
  context: NodeExecutionContext,
  name: string,
  what: string,
): Record<string, unknown> {
  const parsed = parseJsonParameter(context.getNodeParameter<unknown>(name, {}), what);
  if (parsed === undefined) return {};
  if (!isPlainObject(parsed)) {
    throw new WorkflowNodeError(`参数「${what}」必须是一个 JSON 对象`);
  }
  return parsed;
}

/** 把参数值解析成数组（不是数组时报参数错误，而不是静默当成空）。 */
export function readJsonArray(
  context: NodeExecutionContext,
  name: string,
  what: string,
): unknown[] {
  const parsed = parseJsonParameter(context.getNodeParameter<unknown>(name, []), what);
  if (parsed === undefined) return [];
  if (!Array.isArray(parsed)) {
    throw new WorkflowNodeError(`参数「${what}」必须是一个 JSON 数组`);
  }
  return parsed;
}

/** 夹紧整数（批次大小、超时这类参数越界时给出稳定行为，而不是把坏值传给下游）。 */
export function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

/** 批次大小上限沿用「单节点单次运行最多保留多少条 items」，避免一次塞爆执行记录。 */
export function clampBatchSize(value: number): number {
  return clampInteger(value, 1, WORKFLOW_LIMITS.maxItemsPerNodeRun);
}

// ---------------------------------------------------------------------------
// 取值 / 比较（Set、Sort、RemoveDuplicates、Aggregate 共用）
// ---------------------------------------------------------------------------

/**
 * 按点路径取值：支持 `a.b[0].c`（n8n 的字段选择器同口径）。
 * 取不到返回 undefined（不抛错：数组里个别 item 缺字段是常态）。
 */
export function getValueByPath(source: unknown, path: string): unknown {
  if (!path) return undefined;
  const keys = path.replace(/\[(\d+)\]/g, ".$1").split(".").filter((key) => key !== "");
  let current: unknown = source;
  for (const key of keys) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      const index = Number(key);
      if (!Number.isInteger(index)) return undefined;
      current = current[index];
      continue;
    }
    if (isPlainObject(current)) {
      current = current[key];
      continue;
    }
    return undefined;
  }
  return current;
}

/** 按点路径取某个 item 的字段。 */
export function getItemField(item: Item, path: string): unknown {
  return getValueByPath(item.json, path);
}

/**
 * 稳定序列化：对象键排序后再拼 JSON。
 * 去重要靠它——`{a:1,b:2}` 与 `{b:2,a:1}` 必须算同一条数据。
 */
export function stableStringify(value: unknown): string {
  if (value === undefined) return "undefined";
  if (typeof value === "number" && !Number.isFinite(value)) return String(value);
  if (value === null || typeof value !== "object") {
    const json = JSON.stringify(value);
    return json === undefined ? String(value) : json;
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

// ---------------------------------------------------------------------------
// 条件语义（if / switch / filter 共用）
// ---------------------------------------------------------------------------

/** 条件运算符的白名单（顺序即 UI 下拉顺序）。 */
export const CONDITION_OPERATORS = [
  { name: "等于", value: "equals" },
  { name: "不等于", value: "notEquals" },
  { name: "包含", value: "contains" },
  { name: "不包含", value: "notContains" },
  { name: "开头是", value: "startsWith" },
  { name: "结尾是", value: "endsWith" },
  { name: "匹配正则", value: "regex" },
  { name: "大于", value: "greater" },
  { name: "大于等于", value: "greaterEqual" },
  { name: "小于", value: "less" },
  { name: "小于等于", value: "lessEqual" },
  { name: "为空", value: "isEmpty" },
  { name: "不为空", value: "isNotEmpty" },
  { name: "为真", value: "isTrue" },
  { name: "为假", value: "isFalse" },
  { name: "存在", value: "exists" },
  { name: "不存在", value: "notExists" },
] as const;

export type ConditionOperator = (typeof CONDITION_OPERATORS)[number]["value"];

const OPERATOR_SET = new Set<string>(CONDITION_OPERATORS.map((entry) => entry.value));

/** 单条条件：left/right 由引擎按表达式解析成真实值后传进来。 */
export interface ConditionRule {
  left?: unknown;
  operator?: string;
  right?: unknown;
}

/** 条件组：`combinator` 决定条件之间是「且」还是「或」。 */
export interface ConditionGroup {
  combinator: "and" | "or";
  /** 字符串比较是否区分大小写（缺省不区分，与 n8n 的默认口径一致）。 */
  caseSensitive: boolean;
  conditions: ConditionRule[];
}

/** 把参数里的条件组归一成内部形状；空值视为「无条件」（恒真）。 */
export function parseConditionGroup(value: unknown, what = "条件"): ConditionGroup {
  const parsed = parseJsonParameter(value, what);
  if (parsed === undefined || parsed === null) {
    return { combinator: "and", caseSensitive: false, conditions: [] };
  }
  if (!isPlainObject(parsed)) {
    throw new WorkflowNodeError(`参数「${what}」必须是一个 JSON 对象`);
  }
  const rawConditions = Array.isArray(parsed.conditions) ? parsed.conditions : [];
  const conditions: ConditionRule[] = [];
  for (const entry of rawConditions) {
    if (!isPlainObject(entry)) continue;
    conditions.push({
      left: entry.left,
      operator: typeof entry.operator === "string" && entry.operator ? entry.operator : "equals",
      right: entry.right,
    });
  }
  return {
    combinator: parsed.combinator === "or" ? "or" : "and",
    caseSensitive: parsed.caseSensitive === true,
    conditions,
  };
}

/** 条件组是否成立；空条件组恒真（If 的「没写条件」= 全走 true）。 */
export function matchesConditionGroup(group: ConditionGroup, item?: Item): boolean {
  if (group.conditions.length === 0) return true;
  if (group.combinator === "or") {
    return group.conditions.some((rule) => matchesConditionRule(rule, item, group.caseSensitive));
  }
  return group.conditions.every((rule) => matchesConditionRule(rule, item, group.caseSensitive));
}

/** 单条条件求值；未知运算符直接报错（静默返回 false 会让用户以为条件不成立）。 */
export function matchesConditionRule(
  rule: ConditionRule,
  item: Item | undefined,
  caseSensitive = false,
): boolean {
  const operator = typeof rule.operator === "string" ? rule.operator : "equals";
  if (!OPERATOR_SET.has(operator)) {
    throw new WorkflowNodeError(`不支持的条件运算符：${operator}`, {
      description: "请检查条件里的 operator 字段，或改为 equals/contains 等内置运算符。",
    });
  }
  // item 参数预留给未来「按 item 相对取值」的运算符；当前 left/right 已是解析后的值。
  void item;
  const left = rule.left;
  const right = rule.right;

  switch (operator as ConditionOperator) {
    case "equals":
      return valuesEqual(left, right, caseSensitive);
    case "notEquals":
      return !valuesEqual(left, right, caseSensitive);
    case "contains":
      return valueContains(left, right, caseSensitive);
    case "notContains":
      return !valueContains(left, right, caseSensitive);
    case "startsWith":
      return toText(left, caseSensitive).startsWith(toText(right, caseSensitive));
    case "endsWith":
      return toText(left, caseSensitive).endsWith(toText(right, caseSensitive));
    case "regex":
      return matchesRegex(left, right, caseSensitive);
    case "greater":
      return orderCompare(left, right) === 1;
    case "greaterEqual": {
      const result = orderCompare(left, right);
      return result === 1 || result === 0;
    }
    case "less":
      return orderCompare(left, right) === -1;
    case "lessEqual": {
      const result = orderCompare(left, right);
      return result === -1 || result === 0;
    }
    case "isEmpty":
      return isEmptyValue(left);
    case "isNotEmpty":
      return !isEmptyValue(left);
    case "isTrue":
      return toBooleanLike(left) === true;
    case "isFalse":
      return toBooleanLike(left) === false;
    case "exists":
      return left !== undefined && left !== null;
    case "notExists":
      return left === undefined || left === null;
    default:
      return false;
  }
}

function toText(value: unknown, caseSensitive: boolean): string {
  let text: string;
  if (value === null || value === undefined) text = "";
  else if (typeof value === "string") text = value;
  else if (typeof value === "number" || typeof value === "boolean") text = String(value);
  else {
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
  }
  return caseSensitive ? text : text.toLowerCase();
}

/** 数字识别：数字本身与「看起来是数字的字符串」都算；否则返回 null。 */
function toNumberLike(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** 布尔识别：只认明确的真假表达；认不出返回 null（用于 equals 与 isTrue）。 */
function toBooleanLike(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true" || normalized === "1" || normalized === "是") return true;
    if (normalized === "false" || normalized === "0" || normalized === "否" || normalized === "") {
      return false;
    }
  }
  return null;
}

function valuesEqual(left: unknown, right: unknown, caseSensitive: boolean): boolean {
  if (left === undefined || left === null) {
    return right === undefined || right === null || (typeof right === "string" && right === "");
  }
  if (right === undefined || right === null) {
    return typeof left === "string" && left === "";
  }
  const leftBoolean = toBooleanLike(left);
  const rightBoolean = toBooleanLike(right);
  // 只有两边都能识别成布尔、且至少有一边本来就是布尔时才按布尔比较，
  // 避免 "1" vs 1 被布尔化之后掩盖数字相等的语义。
  if (
    (typeof left === "boolean" || typeof right === "boolean") &&
    leftBoolean !== null &&
    rightBoolean !== null
  ) {
    return leftBoolean === rightBoolean;
  }
  const leftNumber = toNumberLike(left);
  const rightNumber = toNumberLike(right);
  if (leftNumber !== null && rightNumber !== null) return leftNumber === rightNumber;
  return toText(left, caseSensitive) === toText(right, caseSensitive);
}

function valueContains(left: unknown, right: unknown, caseSensitive: boolean): boolean {
  if (Array.isArray(left)) {
    return left.some((entry) => valuesEqual(entry, right, caseSensitive));
  }
  return toText(left, caseSensitive).includes(toText(right, caseSensitive));
}

function matchesRegex(left: unknown, right: unknown, caseSensitive: boolean): boolean {
  const pattern = typeof right === "string" ? right : toText(right, true);
  let regex: RegExp;
  try {
    regex = new RegExp(pattern, caseSensitive ? "" : "i");
  } catch (error) {
    throw new WorkflowNodeError(`正则表达式无效：${pattern}`, {
      description: errorText(error),
    });
  }
  return regex.test(toText(left, true));
}

/** 大小比较：两边都是数字 → 数值比较；否则按字符串比较；缺值时不可比。 */
function orderCompare(left: unknown, right: unknown): -1 | 0 | 1 | null {
  if (left === undefined || left === null || right === undefined || right === null) return null;
  const leftNumber = toNumberLike(left);
  const rightNumber = toNumberLike(right);
  if (leftNumber !== null && rightNumber !== null) {
    return leftNumber < rightNumber ? -1 : leftNumber > rightNumber ? 1 : 0;
  }
  const leftText = toText(left, true);
  const rightText = toText(right, true);
  return leftText < rightText ? -1 : leftText > rightText ? 1 : 0;
}

/** 空值判定：null / undefined / 空字符串 / 空数组 / 空对象。 */
function isEmptyValue(value: unknown): boolean {
  if (value === undefined || value === null || value === "") return true;
  if (Array.isArray(value)) return value.length === 0;
  if (isPlainObject(value)) return Object.keys(value).length === 0;
  return false;
}
