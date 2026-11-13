import { useState } from "react";
import { FOCUS_RING, FOCUS_RING_TIGHT } from "../../lib/a11y/focus.js";
import type { OnboardingStep, OnboardingStepId, OnboardingTarget } from "../../lib/onboarding.js";
import { Button } from "../../components/ui/Button.js";

/**
 * 首跑「开始使用」引导卡（UX-A · U1）。
 *
 * 只负责画：三步骤的 done 状态由 `deriveOnboardingSteps` 从真实 store 派生
 *（连接数 / 会话数 / 任务数），这里不自己判断，避免「界面说完成了、实际没有」。
 *
 * d.138：三步原本只有「去配置模型」一个去处——用户点完跳走，回来还是不知道
 * 具体点哪里。现在每步可以**就地展开**三句话的具体做法，先把动作讲清楚再跳。
 * 展开状态只存 `sessionStorage`（本标签页内有效）：不做真正的「完成进度落盘」，
 * 因为完成度只有一个真相来源（真实 store），另存一份迟早对不上。
 */
export interface OnboardingCardProps {
  steps: OnboardingStep[];
  /** 跳转到某一步要去的地方（设置 / 智能体 / 任务区）。 */
  onGo: (target: OnboardingTarget) => void;
  /** 用户关掉这张卡（只存本机）。 */
  onDismiss: () => void;
}

/** 展开状态的本页存储键（只记「展开了哪几步」，不记完成度）。 */
export const ONBOARDING_OPEN_KEY = "heming.onboarding.open.v1";

/** 每一步「具体怎么做」：短句、可照做，不写抽象建议。 */
export const ONBOARDING_HOW_TO: Record<OnboardingStepId, string[]> = {
  model: [
    "打开「模型 → 来源」，点一个服务商（或填自定义地址）。",
    "只粘贴一个 Key；地址和默认模型会自动带出来。",
    "保存后会测试连通并读出可用模型，然后去「智能体」页挑模型。",
  ],
  chat: [
    "打开「对话」页，在左上角挑一个已绑定的智能体。",
    "输入一句话按回车；有回复就说明这一步通了。",
    "想换模型，去「模型 → 智能体」里改。",
  ],
  task: [
    "打开「任务」页，用一句话写清要它做什么。",
    "确认范围后让它跑；跑完会给你结果和改动清单。",
    "需要它改文件时，先在设置里添加可写根。",
  ],
};

function readOpenIds(): OnboardingStepId[] {
  try {
    const raw = sessionStorage.getItem(ONBOARDING_OPEN_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is OnboardingStepId => typeof id === "string");
  } catch {
    return [];
  }
}

function writeOpenIds(ids: OnboardingStepId[]): void {
  try {
    sessionStorage.setItem(ONBOARDING_OPEN_KEY, JSON.stringify(ids));
  } catch {
    /* 隐私模式/配额满：展开状态丢了不影响功能 */
  }
}

export function OnboardingCard({ steps, onGo, onDismiss }: OnboardingCardProps) {
  const doneCount = steps.filter((step) => step.done).length;
  // 下一个该做的步骤：三张卡不再同等对待——已完成的是回执，下一步是唯一的主对象。
  const nextIndex = steps.findIndex((step) => !step.done);
  const [openIds, setOpenIds] = useState<OnboardingStepId[]>(readOpenIds);

  const toggleOpen = (id: OnboardingStepId) => {
    setOpenIds((prev) => {
      const next = prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id];
      writeOpenIds(next);
      return next;
    });
  };

  return (
    <section
      aria-label="开始使用"
      className="ui-card p-4"
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-ui-base font-semibold">开始使用</h2>
          <p className="mt-0.5 text-ui-sm leading-5 text-muted">
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
        {steps.map((step, index) => {
          const open = openIds.includes(step.id);
          const howToId = `onboarding-how-${step.id}`;
          return (
            <li
              key={step.id}
              aria-label={`${step.title}${step.done ? "（已完成）" : "（未完成）"}`}
              className={`flex flex-col gap-1.5 rounded-lg border px-3 py-2.5 ${
                step.done
                  ? "border-[var(--success-line)] bg-[var(--success-soft)]"
                  : index === nextIndex
                    ? "border-[var(--line-strong)] bg-[var(--surface)]"
                    : "border-line-soft bg-[var(--subtle-2)]"
              }`}
            >
              <div className="flex items-center gap-2">
                <span
                  aria-hidden="true"
                  className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-ui-xs font-bold ${
                    step.done
                      ? "border-[var(--success)] bg-[var(--success)] text-[var(--success-on)]"
                      : "border-[var(--line-strong)] bg-[var(--surface)] text-[var(--body)]"
                  }`}
                >
                  {index + 1}
                </span>
                <span className="min-w-0 truncate text-ui-sm font-bold">{step.title}</span>
                {step.done && (
                  <span className="ml-auto shrink-0 text-ui-xs font-medium text-[var(--success)]">
                    已完成
                  </span>
                )}
              </div>
              {/* 已完成的步骤不该再读「在「智能体」页挑一个智能体，发第一句话」——
                  那是待办句式，勾了还这么写，等于让用户怀疑自己漏做了。 */}
              <p className="text-ui-xs leading-4 text-muted">
                {step.done ? "这一步已经完成，不用再动。" : step.description}
              </p>

              {/* 未完成才有「怎么做」：展开后给三句可照做的步骤，跳转前就知道点哪里。 */}
              {!step.done && (
                <button
                  type="button"
                  onClick={() => toggleOpen(step.id)}
                  aria-expanded={open}
                  aria-controls={howToId}
                  className={`self-start rounded-sm ui-micro text-muted underline decoration-[var(--line-strong)] underline-offset-2 hover:text-[var(--body)] ${FOCUS_RING_TIGHT}`}
                >
                  {open ? "收起做法" : "怎么做"}
                </button>
              )}
              {!step.done && open && (
                <ol
                  id={howToId}
                  className="flex list-decimal flex-col gap-0.5 pl-4 ui-micro leading-4 text-[var(--body)]"
                >
                  {ONBOARDING_HOW_TO[step.id].map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ol>
              )}

              {/* 已完成的步骤不再给按钮：右上「已完成」+ 下方一句回执已经足够，
                  再放一个灰色的「已完成」按钮是三处重复同一件事。 */}
              {!step.done && (
                <Button
                  type="button"
                  onClick={() => onGo(step.target)}
                  size="sm"
                  variant="ghost"
                  className={`mt-auto self-start ${FOCUS_RING_TIGHT}`}
                >
                  {step.actionLabel}
                </Button>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/** 引导卡内按钮的主焦点环（导出给需要统一视觉的调用方）。 */
export const ONBOARDING_FOCUS_RING = FOCUS_RING;