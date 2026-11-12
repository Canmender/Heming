import type { ReactNode } from "react";
import { Button } from "./Button.js";

/**
 * 统一失败态（d.138 · 状态三件套的第三件）。
 *
 * 现状：全站 `加载失败` 的呈现有十几种——一行红字、居中一段灰字、带不带重试、重试按钮
 * 尺寸各不相同；而 `EmptyState` / `Skeleton` 已经收口成组件，失败态却还是各写一遍。
 *
 * 这个组件只做三件事：
 *   · 用 `role="alert"` 让读屏立刻播报（失败是需要打断的，不是「有空再说」的空态）；
 *   · 把「发生了什么 / 能怎么办」分成 `title` 与 `desc` 两层，别把错误串直接铺成正文；
 *   · 给一个统一的「重试」——传了 `onRetry` 才渲染，不传就是纯说明（如不可重试的 403）。
 *
 * 视觉走 `index.css` 的 `.ui-empty*`（与空态同骨架，失败态只是多了告警语义与重试），
 * 不引入第二套空/失败样式。
 *
 * 接线注意：现有 28 处断言把文案写成了「加载失败：{原因}」的整串（`getByText(/加载失败：网络中断/)`）。
 * 接线时要么把原因并进 `title`，要么同批改断言——不能只换组件不跑测试。
 */
export interface ErrorStateProps {
  /** 一句话说清「什么失败了」，如「历史消息加载失败」。 */
  title: ReactNode;
  /** 原因或补充说明（可选）；不要把整段堆栈丢进来。 */
  desc?: ReactNode;
  /** 重试回调；不传则不渲染重试按钮（不可重试的错误）。 */
  onRetry?: () => void;
  /** 重试按钮文案，默认「重试」。 */
  retryLabel?: string;
  /** 紧凑变体：用于卡片内部。 */
  compact?: boolean;
  /** 额外容器类（高度约束等）。 */
  className?: string;
}

export function ErrorState({
  title,
  desc,
  onRetry,
  retryLabel = "重试",
  compact = false,
  className = "",
}: ErrorStateProps) {
  return (
    <div
      role="alert"
      className={`ui-empty${compact ? " gap-1 py-5" : ""}${className ? ` ${className}` : ""}`}
    >
      {/* 图标槽沿用空态的格子，但换成告警语义的符号；aria-hidden 是因为 role=alert 已经播报整块。 */}
      <div className="ui-icon-tile" aria-hidden="true">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--danger)" strokeWidth="1.6">
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7.5v5.5" strokeLinecap="round" />
          <circle cx="12" cy="16.5" r="0.9" fill="var(--danger)" stroke="none" />
        </svg>
      </div>
      <p className="ui-empty-title">{title}</p>
      {desc ? <p className="ui-empty-desc">{desc}</p> : null}
      {onRetry ? (
        <div className="ui-empty-actions">
          <Button variant="ghost" size="sm" onClick={onRetry}>
            {retryLabel}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
