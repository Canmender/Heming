import type { TaskRecord } from "./store.js";

/**
 * 重跑（rerun）的纯逻辑：把「用什么目标、@哪个智能体、落到哪个会话」算清楚，
 * 并把**必须说的话**固定成常量——文案不该散落在组件里，否则迟早少说一句。
 *
 * 语义（§12.2 拍板）：重跑**保留原任务**，新建一个任务、新 `streamId`，
 * 原任务的状态/步骤/结果/日志一律不动。这样「留痕」与「这次跑成什么样」互不干扰。
 *
 * 为什么不是「断点续跑」：日志有损（§4.1），续跑要伪造 assistant/tool 消息，
 * 只能靠猜；重跑诚实地重新执行一遍，代价是**写操作可能重复**——所以必须显式确认。
 */

/** 重跑确认文案的第一句：必须出现的「会重新执行一遍」。 */
export const RERUN_NOTICE_REPLAY = "会重新执行一遍";

/** 重跑确认文案的第二句：必须出现的「之前的写操作可能重复」。 */
export const RERUN_NOTICE_SIDE_EFFECT = "之前的写操作可能重复（例如再次写同一批文件）";

/**
 * 重跑确认文案（纯函数，便于用例钉死「两句话都在」）。
 *
 * 三句分工：会发生什么（重跑 = 重新执行）→ 有什么代价（副作用重复）→ 原任务怎么样（不动）。
 * 措辞刻意不说「接着上次」「从第 N 步继续」：那会暗示无损续跑，而实际是重新执行。
 */
export function rerunNoticeLines(): string[] {
  return [
    `重跑${RERUN_NOTICE_REPLAY}：会用同一个目标重新调用模型，${RERUN_NOTICE_SIDE_EFFECT}。`,
    "原任务的记录、日志与状态保持不变；重跑会新建一个任务，两者互不影响。",
  ];
}

/** 重跑是否可点：运行中的任务不能重跑（否则两个回合抢同一个会话）。 */
export function canRerun(task: TaskRecord): boolean {
  return task.status !== "running";
}

/** 新建任务 + 投递执行所需的参数（不含 id/时间戳：那些由 store 生成）。 */
export interface RerunPlan {
  conversationId: string;
  agentId: string;
  agentName: string;
  /** 原目标原样继承：重跑不重新解读用户意图。 */
  prompt: string;
  mentions: { agentId: string; name: string }[];
}

/** 由原任务算出「重跑要新建什么任务、往哪个会话投递」。 */
export function buildRerunPlan(task: TaskRecord): RerunPlan {
  return {
    conversationId: task.conversationId,
    agentId: task.agentId,
    agentName: task.agentName,
    prompt: task.prompt,
    mentions: [{ agentId: task.agentId, name: task.agentName }],
  };
}
