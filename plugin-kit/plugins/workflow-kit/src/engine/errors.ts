/**
 * 执行引擎的结构化错误与「错误项」切分。
 *
 * 为什么单独一层而不是在 execute.ts 里就地 throw：
 * - 执行记录、UI 报错、错误工作流三处都要读同一个错误形状（`NodeErrorInfo`），
 *   在入口处统一收敛成可序列化对象，避免把 axios/浏览器特有的 Error 实例写进 localStorage；
 * - `continueErrorOutput` 的语义是「失败也走数据流」——错误要变成 items 并切到最后一个输出口，
 *   这段切分是纯函数，单独放这里才能不启动引擎就单测。
 *
 * 语义参考 n8n 的公开文档（`onError` 三态、错误项 `{ json: { error } }`、错误输出），
 * 实现是本仓自己的（见 CONTRACT.md §5.5）。
 */

import type { Item, NodeErrorInfo, NodeOutputData, WorkflowNode } from "../types.js";

/**
 * 执行被取消的哨兵错误。
 *
 * 为什么需要它：节点可能自己抛 `AbortError`（例如 helpers.sleep 被 abort），
 * 但「取消」和「失败」在记录里的终态不同（canceled vs error），不能混在一起。
 */
export class ExecutionAbortedError extends Error {
  constructor(message = "执行已取消") {
    super(message);
    this.name = "ExecutionAbortedError";
  }
}

/** 判断一个异常是不是「取消」而不是「失败」。 */
export function isAbortError(error: unknown): boolean {
  if (error instanceof ExecutionAbortedError) return true;
  if (error instanceof Error) {
    return error.name === "AbortError" || error.name === "ExecutionAbortedError";
  }
  return false;
}

/** 从任意异常里读一个字符串字段（不信任第三方错误对象一定带这些键）。 */
function readField(value: unknown, keys: readonly string[]): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const field = record[key];
    if (typeof field === "string" && field.trim()) return field;
    if (typeof field === "number" && Number.isFinite(field)) return String(field);
  }
  return undefined;
}

/** 错误消息兜底：Error → message；字符串/对象 → 尽量可读；绝不抛。 */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  if (typeof error === "string") return error;
  if (typeof error === "object" && error !== null) {
    const message = readField(error, ["message", "error"]);
    if (message) return message;
    try {
      const text = JSON.stringify(error);
      return text && text !== "{}" ? text : "执行失败（错误对象为空）";
    } catch {
      return "执行失败（错误对象无法序列化）";
    }
  }
  return String(error ?? "执行失败");
}

/**
 * 把任意异常收敛成结构化错误。
 *
 * `node` 只用来补 id/名字/类型：错误里带节点名，用户才能在长工作流里定位，
 * 不必先记住失败节点的 id。
 */
export function toNodeErrorInfo(
  error: unknown,
  node?: Pick<WorkflowNode, "id" | "name" | "type">,
  extra?: Pick<NodeErrorInfo, "description" | "itemIndex">,
): NodeErrorInfo {
  const info: NodeErrorInfo = { message: errorMessage(error) };
  if (node) {
    info.nodeId = node.id;
    info.nodeName = node.name;
    info.nodeType = node.type;
  }
  const httpCode = readField(error, ["httpCode", "statusCode", "status"]);
  if (httpCode !== undefined) info.httpCode = httpCode;
  if (error instanceof Error && error.stack) info.stack = error.stack;
  if (extra?.description) info.description = extra.description;
  if (extra?.itemIndex !== undefined) info.itemIndex = extra.itemIndex;
  return info;
}

/** 生成给错误工作流/UI 的责任说明（常见错误给一句人话，而不是只抛英文）。 */
export function errorDescriptionOf(errorInfo: NodeErrorInfo): string | undefined {
  if (errorInfo.httpCode) {
    if (errorInfo.httpCode === "401" || errorInfo.httpCode === "403") {
      return "请求被拒绝：检查凭据是否过期或权限是否足够。";
    }
    if (errorInfo.httpCode === "429") {
      return "请求过于频繁：稍后重试，或降低触发频率。";
    }
    if (errorInfo.httpCode.startsWith("5")) {
      return "对方服务出错：通常稍后重试即可。";
    }
  }
  return errorInfo.description;
}

/** 错误项里保留上游 json 的哪一个（避免把二进制/巨大对象复制进错误项）。 */
function errorItemOf(source: Item, errorInfo: NodeErrorInfo, itemIndex: number): Item {
  return {
    json: { ...source.json, error: errorInfo.message },
    // 错误项也要能回答「是哪条输入失败的」：pairedItem 指回本次节点的输入序号
    pairedItem: { item: itemIndex },
  };
}

/**
 * 构造错误输出口要放的 items。
 *
 * 契约形状（CONTRACT §5.5）：`{json: {error: <message>, ...上游 json>}}`。
 * `error` 字段放在展开之后，保证上游 json 里恰好有 `error` 键时不会被覆盖掉——
 * 错误输出口的第一要务是「一眼看出这条是错误」。
 * 节点没有输入时也要产出 1 条，否则错误输出口为空、下游永远不会被调度。
 */
export function buildErrorItems(inputItems: Item[], errorInfo: NodeErrorInfo): Item[] {
  if (inputItems.length === 0) {
    return [{ json: { error: errorInfo.message }, pairedItem: { item: 0 } }];
  }
  return inputItems.map((item, index) => errorItemOf(item, errorInfo, index));
}

/**
 * `continueErrorOutput`：成功项留在原输出口，错误项切到**最后一个**输出口。
 *
 * 我们的模型里节点要么正常返回、要么整体抛错，所以抛错时「成功项」为空；
 * 仍然按输出口总数铺出二维数组，保证下游按 outputIndex 取数据时形状稳定。
 * `outputCount` 至少为 1：单输出节点没有独立错误口，错误项就落在唯一输出口上。
 */
export function routeErrorItemsToLastOutput(
  outputCount: number,
  inputItems: Item[],
  errorInfo: NodeErrorInfo,
): NodeOutputData {
  const count = Math.max(1, Math.trunc(outputCount) || 1);
  const main: Item[][] = Array.from({ length: count }, () => []);
  main[count - 1] = buildErrorItems(inputItems, errorInfo);
  return { main };
}

/**
 * `continueRegularOutput`：把该节点的输入原样透传给下游；没有输入时输出空。
 *
 * 浅拷贝外层数组：节点实现可能修改数组本身（push/splice），不能让它改到引擎
 * 缓存的「上一轮输出」，否则回环场景会串数据。
 */
export function passThroughInput(inputItems: Item[]): NodeOutputData {
  return { main: [[...inputItems]] };
}
