/**
 * 定时触发的工作流「下一次该在什么时候跑」的计算。
 *
 * 为什么放在引擎而不是 scheduler.ts：`getNextRun` 是**节点类型**的能力
 * （间隔/每天/每周/Cron 各不同，见 types.ts 的 `INodeType.getNextRun`），
 * 由注册表提供；引擎只负责「挑哪个触发器、什么时候放弃」。调度循环
 * （15s 轮询、错过不补跑、写 lastRunAt）是 wf-shell 的 `scheduler.ts`。
 *
 * 口径（CONTRACT §5，与 model.findTriggerNode 一致）：
 * - 只看已注册为 `trigger === "schedule"` 且未禁用的节点；
 * - 多个 schedule 触发器时取**最左**（画布位置 x*10000+y）那个，和 findTriggerNode 同口径；
 * - 没有 schedule 触发器、或节点没有实现 getNextRun、或算出非法时间 → null。
 */

import { getNodeType } from "../registry";
import type { Workflow, WorkflowNode } from "../types";

/** 画布位置排序键：x 优先、y 次之（与 model.getInputConnections 同一算法）。 */
function positionKey(node: Pick<WorkflowNode, "position">): number {
  return node.position.x * 10_000 + node.position.y;
}

/** 工作流里所有启用中的定时触发器，按画布从左到右排序（第一个就是「最左」）。 */
export function listScheduleTriggers(workflow: Pick<Workflow, "nodes">): WorkflowNode[] {
  return workflow.nodes
    .filter((node) => {
      if (node.disabled) return false;
      const nodeType = getNodeType(node.type);
      return nodeType?.description.trigger === "schedule";
    })
    .sort((a, b) => positionKey(a) - positionKey(b) || a.id.localeCompare(b.id));
}

/**
 * 从 `from` 起算下一次定时触发时刻；无法计算返回 null。
 *
 * 调用方（scheduler）拿到 null 表示「这条工作流没有可排期的触发点」，
 * 应停止为它排期——而不是每 15 秒重算一次。
 */
export function nextScheduleRun(
  workflow: Pick<Workflow, "nodes">,
  from: Date,
): Date | null {
  const trigger = listScheduleTriggers(workflow)[0];
  if (!trigger) return null;
  const nodeType = getNodeType(trigger.type);
  if (!nodeType?.getNextRun) return null;
  let next: Date | null;
  try {
    next = nodeType.getNextRun(trigger.parameters ?? {}, from);
  } catch {
    // 触发器参数不合法（例如 Cron 写错）时不要让调度循环崩掉：当作「不可排期」。
    return null;
  }
  if (!(next instanceof Date) || !Number.isFinite(next.getTime())) return null;
  return next;
}
