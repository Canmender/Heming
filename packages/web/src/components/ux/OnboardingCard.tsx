import { FOCUS_RING, FOCUS_RING_TIGHT } from "../../lib/a11y/focus.js";
import type { OnboardingStep, OnboardingTarget } from "../../lib/onboarding.js";

/**
 * 首跑「开始使用」引导卡（UX-A · U1）。
 *
 * 只负责画：三步骤的 done 状态由 `deriveOnboardingSteps` 从真实 store 派生
 *（连接数 / 会话数 / 任务数），这里不自己判断，避免「界面说完成了、实际没有」。
 */
export interface OnboardingCardProps {
  steps: OnboardingStep[];
  /** 跳转到某一步要去的地方（设置 / 智能体 / 任务区）。 */
  onGo: (target: OnboardingTarget) => void;
  /** 用户关掉这张卡（只存本机）。 */
  onDismiss: () => void;
}

export function OnboardingCard({ steps, onGo, onDismiss }: OnboardingCardProps) {
  const doneCount = steps.filter((step) => step.done).length;
  return (
    <section
      aria-label="开始使用"
      className="rounded-xl border border-line-soft bg-[var(--surface)] p-4 shadow-card"
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-[14px] font-extrabold">开始使用</h2>
          <p className="mt-0.5 text-[12px] leading-5 text-muted">
            三步跑通第一次任务（{doneCount}/{steps.length} 已完成）。
          </p>
        </div>
        <button
          type="button"
          // 不能直接把 onDismiss 交给 onClick：React 会把事件对象当第一个参数传进去
          //（dismiss(now) 会把 Event 存成 dismissedAt，读回又回落 null → 关不掉）
          onClick={() => onDismiss()}
          className={`ui-link ${FOCUS_RING_TIGHT}`}
        >
          不再显示
        </button>
      </div>

      <ol className="mt-3 grid grid-cols-1 gap-2 min-[900px]:grid-cols-3">
        {steps.map((step, index) => (
          <li
            key={step.id}
            aria-label={`${step.title}${step.done ? "（已完成）" : "（未完成）"}`}
            className={`flex flex-col gap-1.5 rounded-lg border px-3 py-2.5 ${
              step.done ? "border-[var(--success-line)] bg-[var(--success-soft)]" : "border-line-soft bg-[var(--subtle-2)]"
            }`}
          >
            <div className="flex items-center gap-2">
              <span
                aria-hidden="true"
                className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[11px] font-bold ${
                  step.done
                    ? "border-[var(--success)] bg-[var(--success)] text-white"
                    : "border-[var(--line-strong)] bg-[var(--surface)] text-[var(--body)]"
                }`}
              >
                {index + 1}
              </span>
              <span className="min-w-0 truncate text-[12px] font-bold">{step.title}</span>
              {step.done && (
                <span className="ml-auto shrink-0 text-[10px] font-medium text-[var(--success)]">
                  已完成
                </span>
              )}
            </div>
            <p className="text-[11px] leading-4 text-muted">{step.description}</p>
            <button
              type="button"
              disabled={step.done}
              onClick={() => onGo(step.target)}
              className={`ui-btn ui-btn-sm ui-btn-ghost mt-auto self-start disabled:cursor-default ${FOCUS_RING_TIGHT}`}
            >
              {step.done ? "已完成" : step.actionLabel}
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
}

/** 引导卡内按钮的主焦点环（导出给需要统一视觉的调用方）。 */
export const ONBOARDING_FOCUS_RING = FOCUS_RING;
