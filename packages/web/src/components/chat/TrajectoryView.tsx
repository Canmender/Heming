import type { ConversationProgress } from "../../lib/progress/model.js";
import { StepStatusDot } from "../progress/FlowDiagram.js";
import { STEP_TONES, stepDuration } from "../progress/status.js";
import { EmptyState } from "../ui/EmptyState.js";
import { WorkflowIcon } from "../icons.js";

/**
 * 「轨迹」页签（T32）：把本轮进度的步骤按时间顺序铺成一条竖线。
 *
 * 与右侧 `ProgressPanel` 的分工：面板是窄栏，只够看摘要与流程节点；
 * 这里是整页宽度，所以每一步可以同时带「状态词 + 耗时 + 详情」，不必折叠。
 * 数据仍来自同一个 `useConversationProgress`，两处不各自推导。
 *
 * 空态用 `titleAs="h2"`：整页空态本身就是这一页的二级标题，
 * 文档大纲需要「h1 页标题 → h2 空态标题」这一级（EmptyState 的约定）。
 */
export function TrajectoryView({ progress }: { progress: ConversationProgress }) {
  const { steps, hasData } = progress;

  return (
    <section aria-label="本轮轨迹" data-view-panel="trail">
      <h3 className="ui-section-title mb-3">本轮轨迹</h3>
      {hasData ? (
        steps.length === 0 ? (
          // 有数据但没有步骤：这一轮只发生了思考/回答，没有可列的时间点。
          // 不编造步骤，直接说明「没有可列出的步骤」。
          <p className="text-ui-sm text-muted">这一轮没有可列出的步骤。</p>
        ) : (
          <ol className="m-0 list-none space-y-3 p-0">
            {steps.map((step) => {
              const tone = STEP_TONES[step.status];
              const duration = stepDuration(step);
              return (
                <li key={step.id} className="flex items-start gap-3">
                  <span className="mt-0.5 shrink-0">
                    <StepStatusDot status={step.status} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                      <p className="break-words text-ui-sm leading-5 text-ink">{step.label}</p>
                      {/* 状态词是颜色的文字兜底（色弱/灰度截图也能读）。 */}
                      <span className={`shrink-0 text-ui-xs leading-4 ${tone.text}`}>
                        {tone.label}
                      </span>
                      {duration ? (
                        <span className="shrink-0 text-ui-xs leading-4 tabular-nums text-muted">
                          {duration}
                        </span>
                      ) : null}
                    </div>
                    {/* 工具步骤的 detail（结果/思考开头）整段展开：这里是整页宽度，不需要截断。 */}
                    {step.detail ? (
                      <p className="mt-1 break-words text-ui-xs leading-5 text-muted">
                        {step.detail}
                      </p>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ol>
        )
      ) : (
        <EmptyState
          icon={<WorkflowIcon width={24} height={24} />}
          titleAs="h2"
          title="这一轮还没有轨迹"
          desc="发送一条消息后，工具调用与步骤会按时间记在这里。"
          framed
        />
      )}
    </section>
  );
}
