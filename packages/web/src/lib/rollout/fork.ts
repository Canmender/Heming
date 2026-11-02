import type { ChatMessage, ToolCall } from "../llmClient.js";
import { MAX_TEXT_CHARS } from "./log.js";
import { indexOfSeq, pairToolCalls, type RolloutToolPair } from "./pair.js";
import {
  ROLLOUT_VERSION,
  type RolloutItem,
  type RolloutToolCall,
  type RolloutToolResult,
} from "./types.js";

/**
 * 分叉（fork）的**纯逻辑**：前置条件、代价预览、可复用前缀的重建。
 *
 * 三件事共用同一份配对判定（`pairToolCalls`），保证「面板能显示的」「按钮能不能点」
 * 「实际重建成什么」永远一致——§6 要求配对校验与分叉判定同源。
 *
 * 为什么分叉只能**重建前缀**、不能真正续跑：日志是有损的（文本截断到 2000 字符、
 * 单回合 200 条上限、没有系统提示词快照），§4.1 已经否定「断点续跑」。
 * 分叉做的是：把前缀重建成**合法请求形状**的 extra（assistant.tool_calls + tool 结果），
 * 接在真实会话历史之后，再由模型重新采样后续步骤。前缀里的工具调用**不会重放**，
 * 所以确认文案必须把「前缀是重建的、结果可能被截断」写明——这是诚实，不是免责声明。
 */

/** 分叉被拒绝的原因码（界面据此给具体文案；码稳定，文案可变）。 */
export type ForkRejectCode =
  | "unknown_version"
  | "legacy_version"
  | "running"
  | "no_turn_start"
  | "target_not_tool_result"
  | "assistant_final_after"
  | "turn_error"
  | "missing_turn_end"
  | "dangling_call"
  | "denied_call";

export interface ForkRejection {
  code: ForkRejectCode;
  message: string;
}

export interface ForkCheckContext {
  /** 目标 item 的 `seq`（必须落在某条 `tool_result` 上：从「这一步做完」之后分叉）。 */
  targetSeq: number;
  /** 日志版本；v1（< 2）没有真序号，不能作为分叉点。 */
  version?: number;
  /** 任务仍在运行 → 不允许分叉（正在跑的回合没有稳定前缀）。 */
  running?: boolean;
  /** 用户已明确知道这是崩溃回合（缺 `turn_end` 或 `status=error`）。 */
  allowCrashed?: boolean;
}

export interface ForkCheckResult {
  ok: boolean;
  targetIndex: number;
  target: RolloutToolResult | null;
  /** 全部拒绝原因（不是只报第一条）：界面可以一次说清为什么不给分叉。 */
  rejections: ForkRejection[];
}

/** 悬空调用 / 被拒结果这类「前缀不可信」的事实，统一从配对结果里取。 */
function collectPrefixFacts(prefix: RolloutItem[]): {
  danglingCalls: RolloutToolCall[];
  deniedResults: RolloutToolResult[];
} {
  const { danglingCalls } = pairToolCalls(prefix);
  const deniedResults: RolloutToolResult[] = [];
  for (const item of prefix) {
    if (item.type === "tool_result" && item.denied) deniedResults.push(item);
  }
  return { danglingCalls, deniedResults };
}

/**
 * 分叉前置条件（§5.2，缺一不可）：
 * 1. 目标之后没有 `assistant_final`（已经给了答案的回合，重跑更直接）；
 * 2. 回合已收尾且不是出错收尾，或用户已确认「这是崩溃回合」；
 * 3. 前缀里每个 `tool_call` 都有配对结果（悬空即拒绝）；
 * 4. 前缀里没有被拒（`denied`）的调用（「没执行」拿去续跑会让模型以为执行过）。
 *
 * v1 日志与未来版本一律拒绝：前者没有真序号，后者结构不可猜。
 */
export function checkFork(items: RolloutItem[], ctx: ForkCheckContext): ForkCheckResult {
  const rejections: ForkRejection[] = [];
  const targetIndex = indexOfSeq(items, ctx.targetSeq);
  const target = targetIndex >= 0 && items[targetIndex]?.type === "tool_result"
    ? (items[targetIndex] as RolloutToolResult)
    : null;

  const version = ctx.version ?? ROLLOUT_VERSION;
  if (version > ROLLOUT_VERSION) {
    rejections.push({
      code: "unknown_version",
      message: "该回合由更新版本的日志记录，本版本无法回放与分叉。",
    });
  } else if (version < 2) {
    rejections.push({
      code: "legacy_version",
      message: "该回合由旧版本记录，没有序号，无法确定分叉点；可用「重跑」重新执行一遍。",
    });
  }
  if (ctx.running) {
    rejections.push({ code: "running", message: "任务仍在运行，请等它收尾后再分叉。" });
  }
  if (!target) {
    rejections.push({
      code: "target_not_tool_result",
      message: "只能从一条工具结果之后分叉；这一步没有可复用的结果。",
    });
  }
  if (!items.some((it) => it.type === "turn_start")) {
    rejections.push({ code: "no_turn_start", message: "日志缺少回合开始记录，无法确定上下文。" });
  }
  if (targetIndex >= 0) {
    const after = items.slice(targetIndex + 1);
    if (after.some((it) => it.type === "assistant_final")) {
      rejections.push({
        code: "assistant_final_after",
        message: "这一步之后已经有最终答案，不需要分叉；换方向请用「重跑」。",
      });
    }
    const end = items.find((it) => it.type === "turn_end") as
      | { status: "ok" | "aborted" | "error" }
      | undefined;
    if (!end) {
      if (!ctx.allowCrashed) {
        rejections.push({
          code: "missing_turn_end",
          message: "该回合没有正常收尾（可能是崩溃或强制退出）；确认知道这是崩溃回合后才能分叉。",
        });
      }
    } else if (end.status === "error" && !ctx.allowCrashed) {
      rejections.push({
        code: "turn_error",
        message: "该回合是出错结束；确认知道这是崩溃回合后才能分叉。",
      });
    }
    const prefix = items.slice(0, targetIndex + 1);
    const { danglingCalls, deniedResults } = collectPrefixFacts(prefix);
    if (danglingCalls.length > 0) {
      rejections.push({
        code: "dangling_call",
        message: `前缀里有 ${danglingCalls.length} 个工具调用没有结果（执行中断），不能作为分叉依据。`,
      });
    }
    if (deniedResults.length > 0) {
      rejections.push({
        code: "denied_call",
        message: `前缀里有 ${deniedResults.length} 个调用被拒绝（没有执行），拿去续跑会让模型以为执行过。`,
      });
    }
  }

  return { ok: rejections.length === 0, targetIndex, target, rejections };
}

/** 分叉代价预览（P3）：点下去之前先看清「复用哪几条、丢弃哪些」。 */
export interface ForkPreview {
  targetIndex: number;
  target: RolloutToolResult | null;
  /** 将复用：目标及其之前的配对（按发生顺序）。 */
  reuse: RolloutToolPair[];
  /** 将丢弃：目标之后的所有 item。 */
  discard: RolloutItem[];
  /** 前缀里没有结果的调用（空 = 满足前置条件 3）。 */
  danglingInPrefix: RolloutToolCall[];
  /** 前缀里被拒绝的调用（空 = 满足前置条件 4）。 */
  deniedInPrefix: RolloutToolResult[];
  /** 将复用的结果里，有多少条已被截断（诚实提示依据）。 */
  truncatedResults: number;
}

/** 日志文本是否被记录器截断（截断时会追加省略号并刚好超出上限一位）。 */
export function looksTruncated(text: string, maxTextChars = MAX_TEXT_CHARS): boolean {
  return text.length === maxTextChars + 1 && text.endsWith("…");
}

/** 预览分叉的代价：复用/丢弃/被截断，判据与 `checkFork` 同源（同一份配对结果）。 */
export function previewFork(items: RolloutItem[], targetSeq: number): ForkPreview {
  const targetIndex = indexOfSeq(items, targetSeq);
  if (targetIndex < 0) {
    return {
      targetIndex: -1,
      target: null,
      reuse: [],
      discard: [],
      danglingInPrefix: [],
      deniedInPrefix: [],
      truncatedResults: 0,
    };
  }
  const prefix = items.slice(0, targetIndex + 1);
  const { pairs, danglingCalls } = pairToolCalls(prefix);
  const deniedInPrefix: RolloutToolResult[] = [];
  for (const item of prefix) {
    if (item.type === "tool_result" && item.denied) deniedInPrefix.push(item);
  }
  return {
    targetIndex,
    target: items[targetIndex]!.type === "tool_result" ? (items[targetIndex] as RolloutToolResult) : null,
    reuse: pairs,
    discard: items.slice(targetIndex + 1),
    danglingInPrefix: danglingCalls,
    deniedInPrefix,
    truncatedResults: pairs.filter((pair) => looksTruncated(pair.result.text)).length,
  };
}

/** 重建前缀时被跳过的调用：合法请求形状不允许孤儿 tool 消息或未配对的 tool_calls。 */
export interface ForkPrefixSkip {
  id: string;
  name: string;
  reason: "dangling" | "args_invalid";
}

export interface ForkPrefix {
  /** 可直接拼到真实会话历史之后的 extra（assistant.tool_calls + tool 结果成对出现）。 */
  messages: ChatMessage[];
  /** 被跳过的调用（正常情况下应为空；前置条件已挡掉悬空调用）。 */
  skipped: ForkPrefixSkip[];
  /** 被复用的配对条数。 */
  reusedPairs: number;
  /** 复用的结果里被截断的条数（>0 时确认文案要升级）。 */
  truncatedResults: number;
}

/** args 必须是合法 JSON 对象：截断过的参数直接跳过，不能拼出供应商必然 400 的请求。 */
function argsUsable(args: string): boolean {
  try {
    const parsed: unknown = JSON.parse(args);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

/**
 * 把前缀重建成**合法请求形状**的历史片段（P2 分叉执行用）。
 *
 * 形状硬约束（配错就是供应商 400，不能靠「大概能过」）：
 * - 一段连续 `tool_call` → 一条 `assistant` 消息（`tool_calls` 数组）；
 * - 紧随其后的是**等长同序**的 `tool` 消息（`tool_call_id` 一一对应）；
 * - 没有配对的调用 / 参数被截断的调用整条跳过（`skipped` 里如实报告）；
 * - 被拒绝（`denied`）的结果不会出现在这里——前置条件已拒绝含 denied 的前缀。
 */
export function buildForkPrefix(items: RolloutItem[], targetSeq: number): ForkPrefix {
  const targetIndex = indexOfSeq(items, targetSeq);
  if (targetIndex < 0) return { messages: [], skipped: [], reusedPairs: 0, truncatedResults: 0 };
  const prefix = items.slice(0, targetIndex + 1);
  const { pairs } = pairToolCalls(prefix);
  const pairByCallIndex = new Map<number, RolloutToolPair>();
  for (const pair of pairs) pairByCallIndex.set(pair.callIndex, pair);

  const messages: ChatMessage[] = [];
  const skipped: ForkPrefixSkip[] = [];
  const emittedResultIndexes = new Set<number>();
  let reusedPairs = 0;
  let truncatedResults = 0;

  for (let i = 0; i < prefix.length; i += 1) {
    const item = prefix[i]!;
    if (item.type !== "tool_call") continue;
    // 收集一段连续的调用：它们同属一次 assistant 决策，必须放进同一条 assistant 消息。
    const run: { call: RolloutToolCall; index: number; pair: RolloutToolPair }[] = [];
    let j = i;
    while (j < prefix.length && prefix[j]!.type === "tool_call") {
      const call = prefix[j] as RolloutToolCall;
      const pair = pairByCallIndex.get(j);
      if (!pair) {
        skipped.push({ id: call.id, name: call.name, reason: "dangling" });
      } else if (!argsUsable(call.args)) {
        skipped.push({ id: call.id, name: call.name, reason: "args_invalid" });
      } else {
        run.push({ call, index: j, pair });
      }
      j += 1;
    }
    i = j - 1;
    if (run.length === 0) continue;

    const toolCalls: ToolCall[] = run.map(({ call }) => ({
      id: call.id,
      type: "function" as const,
      function: { name: call.name, arguments: call.args },
    }));
    messages.push({ role: "assistant", content: "", tool_calls: toolCalls });
    for (const { call, pair } of run) {
      messages.push({
        role: "tool",
        content: pair.result.text,
        tool_call_id: call.id,
        name: call.name,
        // 与正常回灌同口径：失败的结果标 is_error（Anthropic 分支读它，OpenAI 分支忽略）。
        ...(pair.result.ok ? {} : { toolError: true }),
      });
      emittedResultIndexes.add(pair.resultIndex);
      reusedPairs += 1;
      if (looksTruncated(pair.result.text)) truncatedResults += 1;
    }
  }

  return { messages, skipped, reusedPairs, truncatedResults };
}

/* ------------------------------------------------------------ 诚实提示（文案） */

/** 前缀重建的基本口径：确认框与任务卡都必须出现这句。 */
export const FORK_PREFIX_NOTICE = "前缀由本机日志重建；超过 2000 字符的工具结果已被截断。";

/** 前缀里有被截断的结果时追加这句：不能让用户以为复用是无损的。 */
export const FORK_TRUNCATED_NOTICE = "结果不完整，后续可能需要重新读取。";

/** 分叉副作用的两句话（§5.3）：写操作已经发生，且新步骤可能再写一遍。 */
export const FORK_SIDE_EFFECT_NOTICE =
  "前缀里的工具调用不会重放：之前的写操作已经真实发生，不会回滚；后续步骤可能再次写入同一批文件。";

/**
 * 分叉确认文案（纯函数，便于测试「该说的话有没有说」）。
 *
 * 措辞刻意避免「从第 N 步继续」——那会暗示无损续跑，而实际是**重建前缀后重新采样**。
 */
export function forkNoticeLines(truncatedResults: number): string[] {
  const lines = [FORK_SIDE_EFFECT_NOTICE, FORK_PREFIX_NOTICE];
  if (truncatedResults > 0) {
    lines.push(`有 ${truncatedResults} 条工具${FORK_TRUNCATED_NOTICE}`);
  }
  return lines;
}
