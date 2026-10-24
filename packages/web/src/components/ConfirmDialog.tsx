import { useRef, type ReactNode } from "react";
import { useModalA11y } from "./useModalA11y.js";
import { XIcon } from "./icons.js";

/**
 * 确认弹窗骨架：遮罩、Esc、焦点陷阱、打开落点。
 *
 * 为什么单独抽一层：焦点管理是本仓最易写错的部分——
 * 打开时焦点落在哪、Tab 会不会跑出弹窗、Esc 会不会误触发。
 * 写一份就够，写两份迟早两份行为不一样。
 *
 * 骨架只管「怎么显示」，不管「显示什么」：
 * 内容由调用方通过 children 塞进来（工具确认、装包确认各用各的内容区）。
 */
export interface ConfirmDialogProps {
  /** 弹窗标题（给读屏软件用）。 */
  title: string;
  /** 内容区。 */
  children: ReactNode;
  /** 底部按钮区。 */
  footer?: ReactNode;
  /** 关闭（= 拒绝）的回调：点遮罩、点 Esc 都走它。 */
  onCancel: () => void;
  /**
   * 打开时聚焦的元素选择器（默认聚焦第一个按钮）。
   *
   * 安全默认是**拒绝**按钮：用户手快按下回车时，误放行的代价
   * 远大于误拒绝——误拒绝用户会立刻发现，误放行则可能已经落盘。
   */
  initialFocusRef?: React.RefObject<HTMLElement>;
}

export function ConfirmDialog({
  title,
  children,
  footer,
  onCancel,
  initialFocusRef,
}: ConfirmDialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  useModalA11y(panelRef, onCancel, { initialFocusRef });

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/20"
      // 点遮罩 = 拒绝：与 Esc 同一个口径（用户想中止这次操作）。
      onClick={onCancel}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        // 点弹窗内部不冒泡到遮罩（否则点内容就等于拒绝）。
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[80vh] w-[min(560px,92vw)] flex-col overflow-hidden rounded-xl border border-[#ececec] bg-white shadow-card"
      >
        <div className="flex items-center justify-between gap-3 border-b border-line-soft px-4 py-2.5">
          <span className="truncate text-[13px] font-bold">{title}</span>
          <button
            type="button"
            aria-label="关闭并拒绝"
            onClick={onCancel}
            className="shrink-0 rounded p-1 text-muted hover:bg-[#f0f0f0] hover:text-ink"
          >
            <XIcon width={16} height={16} aria-hidden="true" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">{children}</div>
        {footer ? (
          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line-soft px-4 py-2.5">
            {footer}
          </div>
        ) : null}
      </div>
    </div>
  );
}
