import type { ReactNode, RefObject } from "react";
import { Dialog } from "./ui/Dialog.js";

/**
 * 确认弹窗：`Dialog` 的语义化包装，只负责「标题 = 可访问名 + 默认拒绝」。
 *
 * 为什么保留这一层：确认框是最常见的一类对话框，默认焦点落在**拒绝**按钮上
 * （误放行的代价远大于误拒绝）。把这条策略钉在这里，调用方就不用每次重申。
 * 壳的部分（遮罩/焦点陷阱/Esc/关闭按钮）全部在 `ui/Dialog`。
 */
export interface ConfirmDialogProps {
  /** 弹窗标题（同时作为读屏名称）。 */
  title: string;
  /** 内容区。 */
  children: ReactNode;
  /** 底部按钮区。 */
  footer?: ReactNode;
  /** 关闭（= 拒绝）的回调：点遮罩、点 Esc、点右上角都走它。 */
  onCancel: () => void;
  /**
   * 打开时聚焦的元素；默认聚焦第一个按钮（即「拒绝」）。
   *
   * 类型里带 `| null`：React 19 的 `useRef<T>(null)` 返回 `RefObject<T | null>`。
   */
  initialFocusRef?: RefObject<HTMLElement | null>;
}

export function ConfirmDialog({
  title,
  children,
  footer,
  onCancel,
  initialFocusRef,
}: ConfirmDialogProps) {
  return (
    <Dialog
      ariaLabel={title}
      title={title}
      footer={footer}
      onClose={onCancel}
      initialFocusRef={initialFocusRef}
      closeLabel="关闭并拒绝"
    >
      {children}
    </Dialog>
  );
}