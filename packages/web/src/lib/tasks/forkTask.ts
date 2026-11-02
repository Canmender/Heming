import type { ChatMessage } from "../llmClient.js";
import {
  buildForkPrefix,
  checkFork,
  forkNoticeLines,
  previewFork,
  type ForkCheckContext,
  type ForkPreview,
  type ForkRejectCode,
} from "../rollout/fork.js";
import type { RolloutItem } from "../rollout/types.js";
import type { TaskForkedFrom, TaskRecord } from "./store.js";

/**
 * 分叉落地的纯逻辑：把「这一条能不能分叉」「要新建什么任务」「前缀长什么样」
 * 「必须对用户说什么」一次算清，组件只负责调用与渲染。
 *
 * 为什么不把这几步散在组件里：前置条件、重建结果、确认文案必须**同源**——
 * 任何一处各算各的，就会出现「说能分叉、点了失败」或「说复用了、其实没复用」。
 *
 * 语义（§12.1 拍板）：分叉 = **新建任务**，继承原任务的目标与智能体，
 * `forkedFrom` 指向原 `streamId + seq`；原任务日志/汇总/状态一律不动。
 */

/** 任务层多出来的两种拒绝：没绑定回合、前缀重建不出来。 */
export type ForkTaskRejectCode = ForkRejectCode | "task_without_stream" | "prefix_invalid";

export interface ForkTaskRejection {
  code: ForkTaskRejectCode;
  message: string;
}

/** 分叉要新建的任务参数 + 要投递的前缀（不含 id/时间戳：由 store 生成）。 */
export interface ForkTaskPlan {
  conversationId: string;
  agentId: string;
  agentName: string;
  /** 继承原任务的目标（§12.1）。 */
  prompt: string;
  /** 分叉来源：新回合的 `turn_start` 与任务卡都靠它。 */
  forkedFrom: TaskForkedFrom;
  /** 重建出来的前缀（接在真实会话历史之后）。 */
  forkPrefix: ChatMessage[];
  mentions: { agentId: string; name: string }[];
  /** 确认框必须显示的行（副作用 + 重建 + 截断）。 */
  notices: string[];
}

export interface ForkTaskPlanResult {
  ok: boolean;
  rejections: ForkTaskRejection[];
  /** 代价预览（P3）：即使被拒绝也给出，界面可以顺便说明「本来会复用哪些」。 */
  preview: ForkPreview | null;
  plan: ForkTaskPlan | null;
}

/**
 * 由原任务 + 该回合日志算出「分叉要建什么任务、带什么前缀」。
 *
 * `ctx.running` 缺省按任务状态推断：任务仍在跑时不给分叉（前缀还不稳定）。
 */
export function buildForkTaskPlan(
  task: TaskRecord,
  items: RolloutItem[],
  ctx: ForkCheckContext,
): ForkTaskPlanResult {
  const preview = previewFork(items, ctx.targetSeq);
  if (!task.streamId) {
    return {
      ok: false,
      rejections: [
        {
          code: "task_without_stream",
          message: "该任务没有绑定回合日志，无法确定从哪里分叉。",
        },
      ],
      preview,
      plan: null,
    };
  }

  const check = checkFork(items, {
    ...ctx,
    version: ctx.version,
    running: ctx.running ?? task.status === "running",
  });
  if (!check.ok) {
    return { ok: false, rejections: check.rejections, preview, plan: null };
  }

  const prefix = buildForkPrefix(items, ctx.targetSeq);
  if (prefix.skipped.length > 0 || prefix.messages.length === 0) {
    const detail = prefix.skipped
      .map((skip) => `${skip.name || skip.id}（${skip.reason === "dangling" ? "没有结果" : "参数被截断"}）`)
      .join("、");
    return {
      ok: false,
      rejections: [
        {
          code: "prefix_invalid",
          message: detail
            ? `前缀里有调用无法重建为合法请求：${detail}。`
            : "前缀里没有可复用的工具结果，分叉等价于重跑。",
        },
      ],
      preview,
      plan: null,
    };
  }

  const forkedFrom: TaskForkedFrom = {
    streamId: task.streamId,
    seq: ctx.targetSeq,
    // 只在真有截断时记：0 与「没这个字段」在任务卡上是同一件事，不必落盘噪音。
    ...(prefix.truncatedResults > 0 ? { truncatedResults: prefix.truncatedResults } : {}),
  };

  return {
    ok: true,
    rejections: [],
    preview,
    plan: {
      conversationId: task.conversationId,
      agentId: task.agentId,
      agentName: task.agentName,
      prompt: task.prompt,
      forkedFrom,
      forkPrefix: prefix.messages,
      mentions: [{ agentId: task.agentId, name: task.agentName }],
      notices: forkNoticeLines(prefix.truncatedResults),
    },
  };
}

/* ------------------------------------------------------ 运行期：前缀解析与降级 */

/** 分叉运行降级的原因（任务卡说「是分叉」，但这次实际按重跑执行）。 */
export type ForkRunDegradeReason = "log_unreadable" | "legacy_version" | "prefix_invalid";

export interface ForkRunContext {
  /** 传给 `TriggerDeps.forkedFrom`：即使降级也保留来源，日志能看出「本来是从哪来的」。 */
  forkedFrom?: { streamId: string; seq: number };
  /** 传给 `TriggerDeps.forkPrefix`：**只有重建成功才给**，降级时绝不给空数组冒充。 */
  forkPrefix?: ChatMessage[];
  /** 非空 = 本次按普通重跑执行，原因是这个。 */
  degraded?: ForkRunDegradeReason;
  /** 给用户看的降级说明（不是静默：必须显示出来）。 */
  notice?: string;
}

/** 读取端日志视图（ChatPage 用 `rolloutLog.readStream()` 拿到的形状）。 */
export interface ForkRunLogView {
  version: number;
  items: RolloutItem[];
}

/**
 * 把「任务记录里的 forkedFrom + 来源日志」解析成这次运行要怎么跑。
 *
 * 三种情况**显式降级为普通重跑**（不伪造前缀，也不静默）：
 * 1. 来源日志读不到（被清理/存储异常）；
 * 2. 来源是 v1 或未来版本日志（前者没有真序号，后者结构不可猜）；
 * 3. 前缀重建失败（参数被截断/没有可用配对）。
 *
 * 降级时仍返回 `forkedFrom`：任务卡与回合日志要如实表达「这是一次分叉的尝试」，
 * 只是这次没能复用前缀。是否显示提示由调用方负责（`notice` 非空即显示）。
 */
export function resolveForkRun(
  task: TaskRecord | undefined,
  view: ForkRunLogView | null,
): ForkRunContext {
  const forked = task?.forkedFrom;
  if (!forked) return {};
  const forkedFrom = { streamId: forked.streamId, seq: forked.seq };
  if (!view) {
    return {
      forkedFrom,
      degraded: "log_unreadable",
      notice: "分叉来源的回合日志读不到（可能已被清理），本次按普通重跑执行。",
    };
  }
  if (view.version !== 2) {
    return {
      forkedFrom,
      degraded: "legacy_version",
      notice:
        view.version > 2
          ? "分叉来源由更新版本的日志记录，本版本无法重建前缀，本次按普通重跑执行。"
          : "分叉来源是旧版本日志（没有序号），本次按普通重跑执行。",
    };
  }
  const prefix = buildForkPrefix(view.items, forked.seq);
  if (prefix.skipped.length > 0 || prefix.messages.length === 0) {
    return {
      forkedFrom,
      degraded: "prefix_invalid",
      notice: "分叉前缀重建失败（参数被截断或缺少配对结果），本次按普通重跑执行。",
    };
  }
  return { forkedFrom, forkPrefix: prefix.messages };
}
