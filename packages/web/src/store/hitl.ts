import { create } from "zustand";
import type { HitlCall, HitlVerdict } from "../lib/hitl/types.js";

/**
 * 待确认请求的**判别式**。
 *
 * 为什么用判别式而不是「payload 就是 HitlCall[]」：
 * 确认通道是个通用原语——工具调用确认、装第三方包确认都走它。
 * 判别式让「这次要确认的是什么」变成类型的一部分，
 * 将来加新类型时不会退化成「一个什么都能塞的 unknown」，
 * 两种内容也不会互相认错。
 *
 * - `tool-call`：模型要调工具，问用户同不同意；
 * - `registry-install`：要从 Registry 装第三方包（并行任务接入，载荷由那边定义）。
 */
export type ConfirmRequest =
  | { kind: "tool-call"; payload: HitlCall[]; auto?: HitlCall[] }
  | { kind: "registry-install"; payload: unknown };

/** 一次确认请求的归属上下文（谁要确认、在哪一轮）。 */
export interface ConfirmContext {
  agentId: string;
  conversationId: string;
  streamId: string;
  agentName: string;
}

/** 当前待确认请求（UI 侧持有的完整信息）。 */
export interface PendingConfirm {
  requestId: string;
  kind: ConfirmRequest["kind"];
  /** 载荷原样带出（由 UI 按 kind 自己解释）。 */
  payload: unknown;
  /** 工具调用场景下的调用清单（`registry-install` 时为空）。 */
  calls: HitlCall[];
  /** 已自动放行的调用（只读项，折叠展示，不可勾选）。 */
  auto: HitlCall[];
  agentId: string;
  conversationId: string;
  streamId: string;
  agentName: string;
}

/** 用户对一次确认给出的裁决。 */
export interface ConfirmDecision {
  requestId: string;
  /** 逐项裁决（工具调用场景）。 */
  verdicts: HitlVerdict[];
  /** 整体拒绝时的理由。 */
  reason?: string;
}

interface HitlState {
  /**
   * 当前待确认请求（**单槽**）。
   *
   * 单槽而不是多槽：桌面端多个弹窗会互相盖住，用户看不全。
   * 并发的第二个请求**排队**等第一个决定完（顺序按到达）。
   */
  pending: PendingConfirm | null;
  /**
   * 登记一批待确认项，返回用户的裁决。
   *
   * 队列化而非合并：两个智能体同时要工具时，合并会让用户面对一批
   * 不属于同一个动作的调用（分不清哪个是谁的）；排队则一次只问一件事。
   * 两批各自 resolve 自己的裁决，互不串味。
   */
  enqueue: (request: ConfirmRequest, ctx: ConfirmContext) => Promise<HitlVerdict[]>;
  /**
   * 底层原语：登记并等待，resolve 值由调用方定义。
   *
   * 单独暴露是为了让「确认什么」这件事可以扩展到工具调用之外
   * （如装第三方包），而不必改这个文件。
   */
  enqueueRaw: <T>(request: ConfirmRequest, ctx: ConfirmContext) => Promise<T>;
  /** 给出裁决，resolve 对应的等待者。 */
  decide: (decision: ConfirmDecision) => void;
  /** 全部取消（如用户按了停止）：所有等待者按拒绝收口。 */
  cancelAll: (reason: string) => void;
}

/**
 * 等待者的 resolver 放在模块级 Map（不放在 zustand state 里）。
 *
 * 理由：resolver 是**函数**，放进 state 会参与订阅比较，
 * 每次 enqueue 都触发一遍无意义的重渲染；模块级 Map 也天然避开了
 * 「state 被序列化/持久化」这类问题。
 */
const waiters = new Map<string, (value: unknown) => void>();

/** 排队中的请求（按到达顺序）。 */
interface QueueItem {
  kind: ConfirmRequest["kind"];
  payload: unknown;
  calls: HitlCall[];
  auto: HitlCall[];
  ctx: ConfirmContext;
  resolve: (value: unknown) => void;
}
const queue: QueueItem[] = [];

/** 生成请求 id：时间戳 + 随机后缀（够用即可，只是防「过期批次误 resolve」）。 */
function newRequestId(): string {
  return `hitl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 从请求里取出工具调用清单（`registry-install` 载荷由那边自己解释）。 */
function callsOf(request: ConfirmRequest): HitlCall[] {
  return request.kind === "tool-call" ? (request.payload as HitlCall[]) : [];
}

/** 从请求里取出「已自动放行」的只读项（仅工具调用场景有）。 */
function autoOf(request: ConfirmRequest): HitlCall[] {
  return request.kind === "tool-call" ? (request.auto ?? []) : [];
}

export const useHitlStore = create<HitlState>((set, get) => ({
  pending: null,

  enqueueRaw: <T,>(request: ConfirmRequest, ctx: ConfirmContext): Promise<T> =>
    new Promise<T>((resolve) => {
      const item: QueueItem = {
        kind: request.kind,
        payload: request.payload,
        calls: callsOf(request),
        auto: autoOf(request),
        ctx,
        resolve: resolve as (value: unknown) => void,
      };
      // 已有 pending → 排队，等当前的决定完再弹（桌面端多弹窗会盖住彼此）。
      if (get().pending) {
        queue.push(item);
        return;
      }
      const requestId = newRequestId();
      waiters.set(requestId, item.resolve);
      set({ pending: toPending(requestId, item) });
    }),

  enqueue: (request, ctx) =>
    get().enqueueRaw<HitlVerdict[]>(request, ctx) as Promise<HitlVerdict[]>,

  decide: (decision) => {
    const current = get().pending;
    // requestId 不匹配 → 忽略：这是过期批次，不能 resolve 别人的等待者。
    if (!current || current.requestId !== decision.requestId) return;
    const resolve = waiters.get(decision.requestId);
    if (!resolve) return;
    waiters.delete(decision.requestId);
    set({ pending: null });
    resolve(decision.verdicts);

    // 队列头成为新的 pending。
    const next = queue.shift();
    if (next) {
      const requestId = newRequestId();
      waiters.set(requestId, next.resolve);
      set({ pending: toPending(requestId, next) });
    }
  },

  cancelAll: (reason) => {
    // 所有等待者一律按拒绝收口：用户按了停止就是要「别执行」。
    // 逐项裁决交由调用方解释——这里给「空裁决」即「什么都没被允许」。
    for (const [requestId, resolve] of waiters) {
      waiters.delete(requestId);
      resolve([]);
    }
    // 排队中的请求也要收口：它们同样在等裁决，
    // 不 resolve 就是闸门永远挂起 → 整轮对话挂死。
    for (const item of queue) item.resolve([]);
    queue.length = 0;
    set({ pending: null });
    void reason;
  },
}));

/** 队列项 → UI 侧持有的 pending。 */
function toPending(requestId: string, item: QueueItem): PendingConfirm {
  return {
    requestId,
    kind: item.kind,
    payload: item.payload,
    calls: item.calls,
    auto: item.auto,
    agentId: item.ctx.agentId,
    conversationId: item.ctx.conversationId,
    streamId: item.ctx.streamId,
    agentName: item.ctx.agentName,
  };
}

/** 只订阅 pending 的选择器（避免组件因整个 state 变化而重渲染）。 */
export const usePendingHitl = (): PendingConfirm | null => useHitlStore((s) => s.pending);
