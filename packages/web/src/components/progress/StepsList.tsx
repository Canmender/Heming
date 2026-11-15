import type { ProgressStep } from "../../lib/progress/model.js";
import { StepStatusDot } from "./FlowDiagram.js";
import { STEP_TONES, stepDuration } from "./status.js";

/**
 * 任务步骤列表（d.147.4.88）：一行一步，交代「哪一步、什么状态、花了多久」。
 *
 * 与流程图的分工：流程图看顺序与卡点，列表看细节（种类 + 耗时 + 详情），
 * 所以这里每行能多带一条被截断的详情，密度比流程图高。
 *
 * 为什么用 `<ol>`：步骤天然有序，序号对读屏用户是「第几步」的唯一线索
 * （视觉上序号被状态点取代，但语义不能丢）。
 */
export function StepsList({ steps }: { steps: ProgressStep[] }) {
  if (steps.length === 0) return null;

  return (
    <ol className="list-none divide-y divide-line-soft overflow-hidden rounded-lg border border-line-soft bg-surface p-0">
      {steps.map((step) => {
        const tone = STEP_TONES[step.status];
        const duration = stepDuration(step);
        // 耗时优先；没有耗时但状态不是「完成」时补一个状态词（失败/拒绝/等待需要文字，
        // 只看点颜色会漏读），已完成的步骤有点内的对勾，再写「完成」是噪音。
        const meta = duration ?? (step.status === "ok" ? null : tone.label);
        return (
          <li key={step.id} className="flex items-start gap-2 px-2.5 py-2">
            <span className="mt-0.5">
              <StepStatusDot status={step.status} />
            </span>
            <div className="min-w-0 flex-1">
              <p className="break-words text-ui-sm leading-5 text-ink">{step.label}</p>
              {/* 详情单行截断：侧栏 280px，多行详情会把列表撑成散文，完整内容留给 title 悬停。 */}
              {step.detail ? (
                <p className="truncate text-ui-xs leading-4 text-muted" title={step.detail}>
                  {step.detail}
                </p>
              ) : null}
            </div>
            {meta ? (
              <span className={`shrink-0 text-ui-xs leading-4 ${tone.text}`}>{meta}</span>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}