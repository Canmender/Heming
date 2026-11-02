/**
 * 回合事件日志（rollout）的类型。
 *
 * 为什么要有它：任务区现在只存「目标/结果/步骤」的汇总（`localStorage`），
 * 崩溃、刷新、换设备之后，长任务的**过程**就没了——事后想复盘「它当时为什么这么干」，
 * 只剩一段摘要。这里把一回合里的关键事实逐条记下来，作为可重放的唯一事实来源。
 *
 * 与 Codex 的 rollout 对齐的只有**形状**（每行一个 item、按时间追加），
 * 不搬它的恢复/分叉实现：那是编辑器级需求，我们先把「记得住」做到。
 *
 * ★ v2（d.56）：每条 item 多一个 `seq`。没有序号时，同一毫秒内的两条记录顺序不确定，
 * 「把调用和结果配起来」「从第 k 条之后分叉」都只能靠数组下标猜——而日志会截断旧条目，
 * 下标会跟着变。`seq` 是**分叉的前提**，也是配对校验的定位依据。
 */

/** 日志格式版本：形状变了就 +1，读取端据此决定要不要迁移。 */
export const ROLLOUT_VERSION = 2;

/** 所有 item 的公共字段：一回合内按 `seq` 严格递增。 */
export interface RolloutItemBase {
  /**
   * 单调递增序号（v2 起）。
   *
   * 由记录器统一分配（追加时取上一条 +1），调用方不必传：
   * 同毫秒内的顺序、配对定位、「从此处分叉」的落点都靠它。
   * v1 日志没有这个字段，读取时用数组下标补齐（只读够用，分叉要求真序号）。
   */
  seq: number;
  /** ISO 时间戳（由记录器统一打，调用方不必自己造）。 */
  at: string;
}

/** 一回合的开始：谁在哪个会话里、被什么话触发。 */
export interface RolloutTurnStart extends RolloutItemBase {
  type: "turn_start";
  conversationId: string;
  streamId: string;
  agentId: string;
  /** 触发文本（会按上限截断，日志不是消息存储）。 */
  userText: string;
  /**
   * 分叉来源（v2）：本回合是从哪个回合的第 `seq` 条 item 之后接着执行的。
   *
   * 只记「从哪来」，不记「为什么」——分叉新任务的汇总独立统计，
   * 原任务的日志/汇总/状态一律不动（§12.1 拍板）。
   */
  forkedFrom?: { streamId: string; seq: number };
}

/** 模型发起一次工具调用（**决策已经做出**，尚未执行）。 */
export interface RolloutToolCall extends RolloutItemBase {
  type: "tool_call";
  streamId: string;
  /** 模型给的 tool_call id，与结果一一对应。 */
  id: string;
  name: string;
  /** 原始参数 JSON（截断后）。 */
  args: string;
}

/** 工具执行结束：成功/失败/被拒都在这里，`denied` 区分「没执行」。 */
export interface RolloutToolResult extends RolloutItemBase {
  type: "tool_result";
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
export interface RolloutAssistantFinal extends RolloutItemBase {
  type: "assistant_final";
  streamId: string;
  text: string;
}

/** 回合终态：每次 run 恰好一条。 */
export interface RolloutTurnEnd extends RolloutItemBase {
  type: "turn_end";
  streamId: string;
  status: "ok" | "aborted" | "error";
  error?: string;
}

/** 分配式 Omit：直接对联合类型做 `Omit` 会把各分支的字段抹平，只剩公共键。 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/**
 * 追加时只给内容：`at` 与 `seq` 都由记录器统一分配。
 *
 * 为什么 seq 也不让调用方给：调用点分布在编排层的五处，各自编号必然打架；
 * 编号是**记录器的职责**（它是唯一知道上一条是多少的角色）。
 */
export type RolloutInput = DistributiveOmit<RolloutItem, "at" | "seq">;

export type RolloutItem =
  | RolloutTurnStart
  | RolloutToolCall
  | RolloutToolResult
  | RolloutAssistantFinal
  | RolloutTurnEnd;

/** 五种 item 的类型名（解析存储数据时用来判真假，与联合类型同源维护）。 */
export const ROLLOUT_ITEM_TYPES = [
  "turn_start",
  "tool_call",
  "tool_result",
  "assistant_final",
  "turn_end",
] as const;

export type RolloutItemType = (typeof ROLLOUT_ITEM_TYPES)[number];

/**
 * 一个回合的读取视图（`RolloutLog.readStream`）。
 *
 * 为什么把版本一起带出来：v1 日志能回放但**不能分叉**（没有真序号），
 * 未来版本的日志连结构都不该猜（§8）。界面据此决定按钮启用与文案，而不是自己去读存储。
 */
export interface RolloutStreamView {
  streamId: string;
  /** 存储里记的版本（可能是未来版本，原样带出）。 */
  version: number;
  /** 归一化后的 item；版本不认识时为空数组（只报数，不猜结构）。 */
  items: RolloutItem[];
  /** 存储里的条目数：版本不认识时也能如实报数。 */
  count: number;
  /** 最后一条记录的时间（ISO）；空日志为 null。 */
  lastAt: string | null;
}

/** `list()` 的摘要：界面列出「有哪些回合日志」时不必读全文。 */
export interface RolloutSummary {
  streamId: string;
  /** 日志格式版本（v1 = 不可分叉）。 */
  version: number;
  items: number;
  /** 最后一条记录的时间（ISO）；空日志为 null。 */
  lastAt: string | null;
  /** 终态（有 turn_end 才有值）。 */
  status?: "ok" | "aborted" | "error";
}
