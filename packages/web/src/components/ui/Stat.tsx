import type { ReactNode } from "react";
import { FOCUS_RING } from "../../lib/a11y/focus.js";

/**
 * 统计卡基元（d.138 · 阶段 2）。
 *
 * 起因：首页和模型页各写了一份 `StatCard`，尺寸还不一样——
 *   首页  label 11px / 数字 20px extrabold / 说明 10px / 内边距 p-3
 *   模型  label 12px / 数字 26px bold（`ui-numeric`）/ 说明 `ui-caption` / p-4
 * 同一套「数字卡」在两个页面上大小不同，正是验收表里「最大字号只能有一个」要清理的形态。
 *
 * 收敛口径：数字是这一屏最强的元素（26px、`ui-numeric` 等宽数字，防跳动），
 * label 与说明都退到 `ui-caption`——两者靠**位置**（上下）区分，不靠字号差。
 *
 * 传了 `onOpen` 就渲染成按钮：统计卡从「看板」变成「可下钻的入口」，
 * 鼠标悬停有底、键盘有焦点环，可访问名默认是「标题：数值」。
 */
export interface StatProps {
  /** 指标名，如「待处理」「可用模型」。 */
  label: string;
  /** 数值（字符串或数字；数字会走 `ui-numeric` 等宽）。 */
  value: string | number;
  /** 一句说明（口径、来源或补充）。 */
  hint?: ReactNode;
  /** 可下钻时传：整张卡变成按钮。 */
  onOpen?: () => void;
  /** 可下钻时的可访问名，默认「标题：数值」。 */
  actionLabel?: string;
  /** 额外容器类（布局用）。 */
  className?: string;
}

export function Stat({ label, value, hint, onOpen, actionLabel, className = "" }: StatProps) {
  const body = (
    <>
      <div className="ui-caption text-muted">{label}</div>
      <div className="ui-numeric mt-1.5 text-[26px] font-bold leading-none">{value}</div>
      {hint ? <div className="mt-1.5 ui-caption">{hint}</div> : null}
    </>
  );

  if (!onOpen) return <div className={`ui-card p-4${className ? ` ${className}` : ""}`}>{body}</div>;

  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={actionLabel ?? `${label}：${value}`}
      className={`ui-card p-4 text-left transition-colors hover:bg-[var(--subtle)] ${FOCUS_RING}${
        className ? ` ${className}` : ""
      }`}
    >
      {body}
    </button>
  );
}
