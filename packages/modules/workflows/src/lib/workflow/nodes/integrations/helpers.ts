/**
 * 集成节点共用的小工具。
 *
 * 为什么不直接 import `nodes/core/helpers.ts`：那份文件的归属是 wf-nodes-core，
 * 两边并行开发时互相 import 会让「谁改坏谁」变得说不清。这里只保留集成节点真正
 * 需要的三件事：取输入 items、把结果收敛成 items、错误文本——都很小，重复一份
 * 的成本低于跨模块耦合的成本。
 */

import type { Item, NodeExecutionContext } from "../../types";

/** 取第 0 个输入口的全部 items（集成节点都只有一个输入口）。 */
export function inputItems(context: NodeExecutionContext): Item[] {
  const first = context.inputData?.main?.[0];
  return Array.isArray(first) ? first : [];
}

/** 判断普通对象（排除 null 与数组）。 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 把任意值收敛成 items：数组逐个展开，普通对象套 json，标量放进 value 字段。 */
export function normalizeToItems(value: unknown): Item[] {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value.flatMap((entry) => normalizeToItems(entry));
  if (isPlainObject(value)) {
    if ("json" in value && isPlainObject((value as { json?: unknown }).json)) {
      return [value as unknown as Item];
    }
    return [{ json: value }];
  }
  return [{ json: { value } }];
}

/** 错误一行文本（不把对象序列化成 [object Object]）。 */
export function errorText(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/** 读一个「可能有、也可能没有」的字符串参数。 */
export function readString(context: NodeExecutionContext, name: string, fallback = ""): string {
  const value = context.getNodeParameter<unknown>(name, fallback);
  return typeof value === "string" ? value : fallback;
}

/** 读数字参数（字符串数字也认；非法回落 default）。 */
export function readNumber(context: NodeExecutionContext, name: string, fallback: number): number {
  const value = context.getNodeParameter<unknown>(name, fallback);
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** 读布尔参数（"false" 字符串不认成 true）。 */
export function readBoolean(context: NodeExecutionContext, name: string, fallback = false): boolean {
  const value = context.getNodeParameter<unknown>(name, fallback);
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value === "true" || value === "1";
  return fallback;
}

/** 给每条输入 item 补一个字段；没有输入时造一条。 */
export function withField(items: Item[], field: string, value: unknown): Item[] {
  if (items.length === 0) return [{ json: { [field]: value } }];
  return items.map((item) => ({ ...item, json: { ...item.json, [field]: value } }));
}
