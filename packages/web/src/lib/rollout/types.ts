/**
 * 回合事件日志（rollout）的类型。
 *
 * 为什么要有它：任务区现在只存「目标/结果/步骤」的汇总（`localStorage`），
 * 崩溃、刷新、换设备之后，长任务的**过程**就没了——事后想复盘「它当时为什么这么干」，
 * 只剩一段摘要。这里把一回合里的关键事实逐条记下来，作为可重放的唯一事实来源。
 *
 * 与 Codex 的 rollout 对齐的只有**形状**（每行一个 item、按时间追加），
 * 不搬它的恢复/分叉实现：那是编辑器级需求，我们先把「记得住」做到。
 */

/** 日志格式版本：形状变了就 +1，读取端据此决定要不要迁移。 */
export const ROLLOUT_VERSION = 1;

/** 一回合的开始：谁在哪个会话里、被什么话触发。 */
export interface RolloutTurnStart {
  type: "turn_start";
  /** ISO 时间戳（由记录器统一打，调用方不必自己造）。 */
  at: string;
  conversationId: string;
  streamId: string;
  agentId: string;
  /** 触发文本（会按上限截断，日志不是消息存储）。 */
  userText: string;
}

/** 模型发起一次工具调用（**决策已经做出**，尚未执行）。 */
export interface RolloutToolCall {
  type: "tool_call";
  at: string;
  streamId: string;
  /** 模型给的 tool_call id，与结果一一对应。 */
  id: string;
  name: string;
  /** 原始参数 JSON（截断后）。 */
  args: string;
}

/** 工具执行结束：成功/失败/被拒都在这里，`denied` 区分「没执行」。 */
export interface RolloutToolResult {
  type: "tool_result";
  at: string;
  streamId: string;
  id: string;
  name: string;
  ok: boolean;
  /** 被 HITL 拒绝（没有真正执行），与「执行失败」不是一回事。 */
  denied?: boolean;
  /** 回灌给模型的文本（截断后）。 */
  text: string;
}

/** 最终答案（成功收口时的全文）。 */
export interface RolloutAssistantFinal {
  type: "assistant_final";
  at: string;
  streamId: string;
  text: string;
}

/** 回合终态：每次 run 恰好一条。 */
export interface RolloutTurnEnd {
  type: "turn_end";
  at: string;
  streamId: string;
  status: "ok" | "aborted" | "error";
  error?: string;
}

/** 分配式 Omit：直接对联合类型做 `Omit` 会把各分支的字段抹平，只剩公共键。 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** 追加时只给内容，`at` 由记录器统一打。 */
export type RolloutInput = DistributiveOmit<RolloutItem, "at">;

export type RolloutItem =
  | RolloutTurnStart
  | RolloutToolCall
  | RolloutToolResult
  | RolloutAssistantFinal
  | RolloutTurnEnd;

/** `list()` 的摘要：界面列出「有哪些回合日志」时不必读全文。 */
export interface RolloutSummary {
  streamId: string;
  items: number;
  /** 最后一条记录的时间（ISO）；空日志为 null。 */
  lastAt: string | null;
  /** 终态（有 turn_end 才有值）。 */
  status?: "ok" | "aborted" | "error";
}
