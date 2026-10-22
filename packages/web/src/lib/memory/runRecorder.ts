import { matchUsage } from "./attribution.js";
import type { MemoryObservability } from "./format.js";
import { RecallLog } from "./recallLog.js";
import type { RecallRun, RecallRunItem } from "./recallLog.js";
import { UsageLedger } from "./usage.js";
import type { EntryUsage, UsageView } from "./usage.js";

/**
 * 召回档案登记器（可观测性，d.27）：把「拼装提示词时算出的注入旁路」接到「轮次收尾」上。
 *
 * 为什么要一个中间登记器：`buildSystemPrompt` 与 `onTurnComplete` 这两个钩子
 * **都拿不到 streamId**（前者在流启动前、后者只带 agentId/userText），
 * 而旁路只在前者存在、日志只在后者写。这里用 `agentId + 用户原话` 作键把两端接上：
 * 同一轮里二者必然相同，重试则会覆盖旧档（重试本来就该按新的注入算）。
 *
 * 全程静默：任何一步异常都只是「这一档没记上」，绝不影响发送与流式渲染。
 */

/** 待收尾的注入旁路。 */
interface PendingRecall {
  agentId: string;
  conversationId: string;
  trace: MemoryObservability;
  /** 登记时刻，用于清理长期未收尾的孤儿档（流被中断且完全无文本时不会回调收尾）。 */
  at: number;
}

/** 同时在飞的流不多，24 档足够；超出的孤儿按最旧先丢。 */
const MAX_PENDING = 24;
/** 孤儿档过期时间：10 分钟还没收尾的，视为那轮流没跑成，直接丢。 */
const PENDING_TTL_MS = 10 * 60 * 1000;

export class RecallRecorder {
  private pending = new Map<string, PendingRecall>();

  constructor(
    private log: RecallLog = new RecallLog(),
    private now: () => number = () => Date.now(),
    /** 个性化权重账本（d.28）：settle 判完引用就顺手累加，不再另开一次判定。 */
    private usage: UsageLedger = new UsageLedger(),
  ) {}

  /** 提示词拼装完成后登记本次注入旁路；零注入（无记忆）不留档，收尾端据此不记日志。 */
  capture(
    agentId: string,
    conversationId: string,
    userText: string,
    trace: MemoryObservability | undefined,
  ): void {
    if (!trace || !trace.injected.length) return;
    const key = this.keyOf(agentId, userText);
    this.pending.set(key, { agentId, conversationId, trace, at: this.now() });
    // 先丢过期孤儿，再按容量截断：正常运行时这一步几乎不触发，只有流反复中断才会。
    for (const [k, value] of this.pending) {
      if (k !== key && this.now() - value.at > PENDING_TTL_MS) this.pending.delete(k);
    }
    while (this.pending.size > MAX_PENDING) {
      const oldest = this.pending.keys().next().value as string | undefined;
      if (oldest === undefined || oldest === key) break;
      this.pending.delete(oldest);
    }
  }

  /**
   * 收尾一（成功）轮：取出旁路 → 判定疑似引用 → 落召回日志。
   * 返回 null 表示本轮没有记忆注入（或旁路已被消费），不记日志。
   */
  settle(input: {
    agentId: string;
    conversationId: string;
    userText: string;
    assistantText: string;
  }): RecallRun | null {
    const key = this.keyOf(input.agentId, input.userText);
    const pending = this.pending.get(key);
    if (!pending) return null;
    // 消费即删：重试/重发会重新登记，同一份旁路不该记两档。
    this.pending.delete(key);
    const { trace } = pending;
    const used = matchUsage(input.assistantText, trace.injected).map((match) => match.id);
    const injected: RecallRunItem[] = trace.injected.map((item) => ({
      id: item.id,
      layer: item.layer,
      ...(trace.scores[item.id] !== undefined ? { score: trace.scores[item.id] } : {}),
      content: item.content,
      truncated: item.truncated,
    }));
    try {
      const run = this.log.record({
        agentId: input.agentId,
        conversationId: input.conversationId,
        query: input.userText,
        recalled: trace.counts,
        injected,
        dropped: trace.dropped,
        used,
      });
      // 日志没落盘就不累加权重：账本与日志必须同进同退，
      // 否则记忆页会出现「有权重却查不到任何一次引用的原始档案」，没法解释。
      if (run) this.usage.apply(run);
      return run;
    } catch {
      return null;
    }
  }

  /** 读日志（记忆页用）；异常回退空表。 */
  list(): RecallRun[] {
    try {
      return this.log.list();
    } catch {
      return [];
    }
  }

  /** 个性化权重视图（d.28）：召回侧拿它调顺序，记忆页拿它显示「×1.18」与冷门清单。 */
  get usageView(): UsageView {
    return this.usage;
  }

  /** 全表快照（记忆页一次读全，别逐条读）：条目 id → 注入/引用计数。 */
  usageSnapshot(): Record<string, EntryUsage> {
    try {
      return this.usage.snapshot();
    } catch {
      return {};
    }
  }

  /** 记忆条目被删除时清掉它的计数（不留孤儿 id）。 */
  forgetUsage(ids: Iterable<string>): void {
    try {
      this.usage.forget(ids);
    } catch {
      /* 静默：计数清不掉不影响删除本身 */
    }
  }

  /**
   * 清除诊断数据：召回日志 + 权重账本一起清（两者同属「本机诊断数据，不是用户记忆」），
   * 三层记忆本身不受影响。
   */
  clearLog(): void {
    this.log.clear();
    this.usage.clear();
  }

  /** 测试/调试：当前待收尾档数。 */
  get pendingCount(): number {
    return this.pending.size;
  }

  private keyOf(agentId: string, userText: string): string {
    return `${agentId}::${userText}`;
  }
}

/** 模块级单例：与 memoryStore 同生命周期，聊天页与记忆页读同一份日志。 */
export const recallRecorder = new RecallRecorder();
