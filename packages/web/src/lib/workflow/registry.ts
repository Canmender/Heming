/**
 * 节点类型注册表：节点实现在 `nodes/`，这里只做「按 type 取实现」的查找。
 *
 * 为什么用全局注册表而不是 import 一个巨大的对象：
 * - 节点库是**可增量扩充**的（新增一种节点只加一个文件 + 一行注册）；
 * - 执行引擎与 UI 都只依赖 `getNodeType`，不 import 任何具体节点，
 *   避免「引擎 → 节点 → 引擎」的循环依赖；
 * - 测试可以注册假节点，不必加载整库。
 *
 * 注册顺序即调色板顺序（`listNodeTypes` 保持注册顺序），因此节点库在
 * `nodes/index.ts` 里按「触发器 → 数据 → 分支 → 集成 → 输出」的顺序注册。
 */

import type { INodeType } from "./types.js";

const registry = new Map<string, INodeType>();

/** 注册一个节点类型；重复注册同一 type 直接报错（重复说明有两条事实来源）。 */
export function registerNodeType(nodeType: INodeType): void {
  const { type } = nodeType.description;
  if (!type || typeof type !== "string") {
    throw new Error("节点类型缺少 type");
  }
  if (registry.has(type)) {
    throw new Error(`节点类型重复注册：${type}`);
  }
  registry.set(type, nodeType);
}

/** 按 type 取节点实现；没注册返回 undefined（导入旧工作流时由 UI 标注「未知节点」）。 */
export function getNodeType(type: string): INodeType | undefined {
  return registry.get(type);
}

/** 按 type 取节点实现；没注册直接抛错（执行路径上不该继续跑一个不存在的节点）。 */
export function requireNodeType(type: string): INodeType {
  const nodeType = registry.get(type);
  if (!nodeType) throw new Error(`未知的节点类型：${type}`);
  return nodeType;
}

/** 全部已注册节点（注册顺序 = 调色板顺序）。 */
export function listNodeTypes(): INodeType[] {
  return [...registry.values()];
}

/** 清空注册表（只给测试用；生产代码永远不调用）。 */
export function clearNodeRegistry(): void {
  registry.clear();
}
