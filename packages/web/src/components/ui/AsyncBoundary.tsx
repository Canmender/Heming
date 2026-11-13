import type { ReactNode } from "react";
import { EmptyState } from "./EmptyState.js";
import { ErrorState } from "./ErrorState.js";
import { SkeletonCard } from "./Skeleton.js";

/**
 * 异步区域三态边界（③-1 交互态收口）。
 *
 * 背景：本仓各页的「加载中 / 加载失败 / 空」是手写的三份 JSX，同一页里还会互相漂移：
 * 有的 loading 有 `role="status" aria-busy`，有的只有一行「加载中…」；失败态有的用
 * `role="alert"` 包整块，有的只把红字塞进 `ui-alert`；空态的「下一步按钮」时有时无。
 * 组件化的 EmptyState / ErrorState / Skeleton 早就有了，缺的是把「按状态选一个」这段
 * 判断也收口——否则每个页面仍要自己写 `!ready ? … : error ? … : empty ? …`。
 *
 * 这个组件只做分发，不发明视觉：
 *   · loading → `role="status" aria-busy` 容器 + 默认骨架（读屏只播报一次）；
 *   · error   → ErrorState（`role="alert"`，可带错误码与重试）；
 *   · empty   → EmptyState（图标/标题/说明/单操作或多操作插槽）；
 *   · ready   → 原样渲染 children。
 *
 * 为什么保留各状态的独立 props 而不是让调用方传三个 ReactNode：调用方传节点就又会
 * 各自拼字号/间距；这里让页面只描述「说什么、能做什么」。
 */
export type AsyncStatus = "ready" | "loading" | "error" | "empty";

export interface AsyncBoundaryProps {
  status: AsyncStatus;
  /** ready 时的内容。 */
  children?: ReactNode;

  /** 加载态读屏名，默认「正在加载」；写具体一点（如「正在加载团队成员」）更有用。 */
  loadingLabel?: string;
  /** 自定义加载占位（默认一张 3 行骨架卡）。骨架自带 aria-hidden。 */
  loadingFallback?: ReactNode;
  /** 加载态容器类（如 space-y-2 / p-2）。 */
  loadingClassName?: string;

  /** 失败标题，如「名册加载失败：网络异常」。 */
  errorTitle?: ReactNode;
  /** 失败原因/补充。 */
  errorDesc?: ReactNode;
  /** 可展示给用户的错误码（服务端 code / HTTP 状态），读屏会念出来。 */
  errorCode?: string;
  /** 重试回调；不传则不渲染重试按钮。 */
  onRetry?: () => void;
  /** 重试按钮文案，默认「重试」。 */
  retryLabel?: string;
  /** 失败态容器类。 */
  errorClassName?: string;
  /** 失败态紧凑变体（卡片/侧栏内）。 */
  errorCompact?: boolean;

  /** 空态标题。 */
  emptyTitle?: ReactNode;
  /** 空态说明。 */
  emptyDesc?: ReactNode;
  /** 空态图标。 */
  emptyIcon?: ReactNode;
  /** 空态主操作（单个节点）；与 emptyActions 二选一，优先 emptyActions。 */
  emptyAction?: ReactNode;
  /** 空态操作区（多个节点）。 */
  emptyActions?: ReactNode;
  /** 空态紧凑变体。 */
  emptyCompact?: boolean;
  /** 空态自带卡片描边。 */
  emptyFramed?: boolean;
  /** 空态容器类。 */
  emptyClassName?: string;
}

export function AsyncBoundary({
  status,
  children,
  loadingLabel = "正在加载",
  loadingFallback,
  loadingClassName = "",
  errorTitle = "加载失败",
  errorDesc,
  errorCode,
  onRetry,
  retryLabel,
  errorClassName,
  errorCompact = false,
  emptyTitle = "暂无内容",
  emptyDesc,
  emptyIcon,
  emptyAction,
  emptyActions,
  emptyCompact = false,
  emptyFramed = false,
  emptyClassName,
}: AsyncBoundaryProps) {
  if (status === "loading") {
    return (
      <div
        role="status"
        aria-busy="true"
        aria-label={loadingLabel}
        className={loadingClassName || undefined}
      >
        {loadingFallback ?? <SkeletonCard lines={3} />}
      </div>
    );
  }

  if (status === "error") {
    return (
      <ErrorState
        title={errorTitle}
        desc={errorDesc}
        code={errorCode}
        onRetry={onRetry}
        retryLabel={retryLabel}
        compact={errorCompact}
        className={errorClassName}
      />
    );
  }

  if (status === "empty") {
    return (
      <EmptyState
        icon={emptyIcon}
        title={emptyTitle}
        desc={emptyDesc}
        actions={emptyActions ?? emptyAction}
        compact={emptyCompact}
        framed={emptyFramed}
        className={emptyClassName}
      />
    );
  }

  return <>{children}</>;
}