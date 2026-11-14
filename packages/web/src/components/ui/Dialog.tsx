import { useRef, type ReactNode, type RefObject } from "react";
import { useModalA11y } from "../useModalA11y.js";
import { XIcon } from "../icons.js";

/**
 * 内容弹窗骨架：遮罩、面板、头部（可选图标/说明）、底部按钮区、关闭按钮。
 *
 * 为什么要有这一层：审计里 11 个弹窗各自拼壳——4 种宽度、2 种圆角、
 * 有的带 `border` 有的不带、投影有的 `shadow-xl` 有的 `ui-overlay-shadow`。
 * 同一种「浮在页面上的对话框」长出 11 个版本，改一处视觉要改 11 个文件。
 *
 * 只统一「壳」，不管「内容」：焦点陷阱、Esc、点遮罩、`inert` 背景全部交给
 * `useModalA11y`（和 `ConfirmDialog` 同一套），内容由调用方塞 children。
 *
 * 用法约束：
 * - `ariaLabel` 是读屏名称，现有测试一律 `getByRole("dialog", { name })` 查询，
 *   迁移时逐字保留原值，不要跟着可见标题改。
 * - 尺寸只有四档（sm 480 / md 560 / lg 660 / xl 860），不再允许调用方传任意宽度；
 *   确实需要窄/宽时先看是不是该用抽屉或整页。
 */
export type DialogSize = "sm" | "md" | "lg" | "xl";

const SIZE_CLASS: Record<DialogSize, string> = {
  sm: "w-[min(480px,92vw)]",
  md: "w-[min(560px,92vw)]",
  lg: "w-[min(660px,94vw)]",
  xl: "w-[min(860px,94vw)]",
};

export interface DialogProps {
  /** 读屏名称（`role="dialog"` 的可访问名）。 */
  ariaLabel: string;
  /** 头部可见标题；不传则没有头部（如命令面板这类自带搜索框的浮层）。 */
  title?: ReactNode;
  /** 头部左侧图标槽（16–18px 的 SVG）。 */
  icon?: ReactNode;
  /** 头部标题下的说明文案。 */
  description?: ReactNode;
  /** 底部按钮区；传了才渲染分隔线与底栏。 */
  footer?: ReactNode;
  /** 宽度档，默认 `md`（560px）。 */
  size?: DialogSize;
  /** 最大高度（视口百分比），默认 80。 */
  maxHeightVh?: number;
  /** 关闭回调：点遮罩、点关闭按钮、按 Esc 都走它。 */
  onClose: () => void;
  /** 打开时聚焦的元素；不传时 `useModalA11y` 聚焦第一个可聚焦元素。 */
  initialFocusRef?: RefObject<HTMLElement | null>;
  /** 是否响应 Esc，默认 true；命令面板自己处理 Esc 时传 false。 */
  closeOnEscape?: boolean;
  /** 关闭按钮的无障碍名称，默认「关闭」。 */
  closeLabel?: string;
  /** 面板追加类（一般不要用；需要贴内容的变体请走 bodyClassName）。 */
  className?: string;
  /** 内容区追加类；默认 `p-4`。 */
  bodyClassName?: string;
  /**
   * 底栏容器追加/替换类。默认只有分隔线与右对齐按钮；
   * 少数弹窗的底栏带浅色底（如安装面板），整串替换以免出现双边框/双内边距。
   */
  footerClassName?: string;
  children: ReactNode;
}

export function Dialog({
  ariaLabel,
  title,
  icon,
  description,
  footer,
  size = "md",
  maxHeightVh = 80,
  onClose,
  initialFocusRef,
  closeOnEscape = true,
  closeLabel = "关闭",
  className = "",
  bodyClassName = "p-4",
  footerClassName = "flex flex-wrap items-center justify-end gap-2 border-t border-line-soft px-4 py-2.5",
  children,
}: DialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  useModalA11y(panelRef, onClose, { initialFocusRef, closeOnEscape });

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-scrim p-4"
      // 点遮罩 = 关闭：与 Esc 同一口径。
      onClick={onClose}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        // 点面板内部不冒泡到遮罩（否则点内容就等于关闭）。
        onClick={(event) => event.stopPropagation()}
        style={{ maxHeight: `${maxHeightVh}vh` }}
        className={`flex flex-col overflow-hidden rounded-xl border border-line bg-surface ui-overlay-shadow ${SIZE_CLASS[size]} ${className}`.trim()}
      >
        {title ? (
          <div className="flex items-start gap-2.5 border-b border-line-soft px-4 py-3">
            {icon ? (
              <span className="ui-icon-tile h-8 w-8 shrink-0" aria-hidden="true">
                {icon}
              </span>
            ) : null}
            <div className="min-w-0 flex-1">
              <span className="ui-section-title">{title}</span>
              {description ? <p className="mt-0.5 ui-caption">{description}</p> : null}
            </div>
            <button
              type="button"
              aria-label={closeLabel}
              onClick={onClose}
              className="ui-hit shrink-0 rounded-sm p-2 text-muted hover:bg-subtle-3 hover:text-ink"
            >
              <XIcon width={16} height={16} aria-hidden="true" />
            </button>
          </div>
        ) : null}
        <div className={`min-h-0 flex-1 overflow-y-auto ${bodyClassName}`.trim()}>{children}</div>
        {footer ? (
          <div className={footerClassName}>{footer}</div>
        ) : null}
      </div>
    </div>
  );
}