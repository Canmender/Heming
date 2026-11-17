/**
 * 收尾自检（d.232）：模型宣布「做完了」，但任务清单里还有没打勾的项。
 *
 * 为什么需要这一层：
 * 长任务跑到后半段，模型最常见的塌方不是「不会做」，而是**提前宣布完成**——
 * 它把最后一句写成「都改好了，你可以试试了」，而清单里还挂着两三行 `[ ]`。
 * 用户信了这句话去验收，才发现一半没做；再让它继续，又得重新解释一遍。
 *
 * 和 d.157 的「撞轮次上限自动续跑」不是同一件事：
 * - d.157 管「轮次用完了但活没干完」——边界在 `MAX_TOOL_ROUNDS`；
 * - 本轮管「它自己说完了、但清单没打完」——边界在**收口**。
 * 两者互相独立：轮次没到顶也可能提前收工。
 *
 * 判定口径刻意保守（宁可少催一次，也不制造循环）：
 * 1. 只在**正常收口**（`ok`）时看：用户点停止、或这一轮出错，都不催——那是另一种情境；
 * 2. 只看**清单**：清单是模型自己写的，「它自己承认没干完」才算数；没有清单就不替它脑补；
 * 3. 一次用户输入只催一次（{@link FINISH_GATE_MAX_NUDGES}），催完仍不动手就如实停，
 *    把判断权交回用户——无限催会变成用户按不了停止的自动循环；
 * 4. 有待处理的插话时先让插话（用户的话优先于系统的自检）。
 */
import { getTodos } from "../todo/store.js";

/** 一次用户输入最多催几次收尾（催多了就成了自动循环）。 */
export const FINISH_GATE_MAX_NUDGES = 1;

/** 提示里最多逐条列几项（再多会稀释重点，剩下的用「还有 N 项」表达）。 */
export const FINISH_GATE_MAX_LISTED = 5;

/** 收尾自检关心的「没做完的项」。 */
export interface FinishGateTodo {
  content: string;
  status: "pending" | "in_progress";
}

/**
 * 本会话任务清单里还没打勾的项（按清单顺序）。
 *
 * 读不到清单（没有会话 id、存储坏了）一律返回空数组：自检是「锦上添花」，
 * 判据不明时必须选择**不催**——错误地催会把一轮正常对话莫名拉长。
 */
export function unfinishedTodos(conversationId: string | null | undefined): FinishGateTodo[] {
  const id = conversationId?.trim();
  if (!id) return [];
  return getTodos(id)
    .filter((item): item is { content: string; status: "pending" | "in_progress" } => item.status !== "completed")
    .map((item) => ({ content: item.content, status: item.status }));
}

/** 收尾自检的判定结果。`reason` 只进日志与测试，不改界面文案。 */
export interface FinishGateVerdict {
  nudge: boolean;
  reason: "not-ok" | "no-open" | "already-nudged" | "queued" | "nudge";
}

export interface FinishGateInput {
  /** 这一轮的收口状态。 */
  status: "ok" | "aborted" | "error";
  /** 清单里没打勾的项数。 */
  open: number;
  /** 这次用户输入已经催过几次。 */
  nudges: number;
  /** 是否还有没处理的插话（用户的即时意图优先）。 */
  steerQueued?: boolean;
}

export function finishGateVerdict(input: FinishGateInput): FinishGateVerdict {
  if (input.status !== "ok") return { nudge: false, reason: "not-ok" };
  if (input.open <= 0) return { nudge: false, reason: "no-open" };
  if (input.steerQueued === true) return { nudge: false, reason: "queued" };
  if (input.nudges >= FINISH_GATE_MAX_NUDGES) return { nudge: false, reason: "already-nudged" };
  return { nudge: true, reason: "nudge" };
}

/**
 * 催它核对清单的那句话。
 *
 * 写成「用户口吻的指令」而不是系统提示：它会作为一条普通用户消息落库并上行，
 * 后续轮次里模型从历史也能读到同一条约束（不需要额外的隐藏状态）。
 */
export function finishGatePrompt(todos: readonly FinishGateTodo[]): string {
  const listed = todos.slice(0, FINISH_GATE_MAX_LISTED);
  const rest = todos.length - listed.length;
  const lines = listed.map(
    (item) => `- ${item.status === "in_progress" ? "[>] 进行中" : "[ ] 未开始"}：${item.content}`,
  );
  if (rest > 0) lines.push(`- 还有 ${rest} 项没列出来`);
  return [
    `【收尾自检】你刚说这一轮做完了，但任务清单里还有 ${todos.length} 项没打勾：`,
    ...lines,
    "",
    "请逐项核对，别把未完成项留在清单里就结束——那会让用户以为都做好了：",
    "1. 真做完了的：用 todo_write 把对应项标成 completed（清单要与事实一致）；",
    "2. 还没做的：接着做，做完再更新清单；",
    "3. 做不了或不该做的：说清原因，并把那一项标成 completed 或直接说明它不做了（不要留一个永远完不成的项）。",
  ].join("\n");
}
