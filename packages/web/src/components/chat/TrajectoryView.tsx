import type { ConversationProgress, ProgressStepKind } from "../../lib/progress/model.js";
import type { ToolTrace } from "../../store/chat.js";
import { StepStatusDot } from "../progress/FlowDiagram.js";
import { STEP_TONES, formatDuration, stepDuration } from "../progress/status.js";
import { EmptyState } from "../ui/EmptyState.js";
import { WorkflowIcon } from "../icons.js";

/**
 * 「轨迹」页签（T32 / d.346）：把本轮进度的步骤按时间顺序铺成一条竖线。
 *
 * 与右侧 `ProgressPanel` 的分工：面板是窄栏，只够看摘要与流程节点；
 * 这里是整页宽度，所以每一步可以同时带「序号 + 类别 + 状态词 + 耗时 + 详情」。
 * 数据仍来自同一个 `useConversationProgress`，两处不各自推导。
 *
 * 版式参考 DSH 的轨迹 ledger（行高固定、序号定宽、正文单行省略），但**不抄时间线**：
 * 思考/回答步没有首尾时间戳，画出来只能插值成假的时间分布（见 docs/HANDOFF.md 的
 * 「不做伪造」口径），所以只呈现**已有事实**。
 *
 * 空态用 `titleAs="h2"`：整页空态本身就是这一页的二级标题，
 * 文档大纲需要「h1 页标题 → h2 空态标题」这一级（EmptyState 的约定）。
 */

/** 类别标签：和鸣只有四种步骤，别用颜色单独表义（色弱用户读不到）。 */
const KIND_LABELS: Record<ProgressStepKind, string> = {
  think: "思考",
  tool: "工具",
  confirm: "确认",
  answer: "回答",
};

/** 类别标签的底色：工具用 warn 系（与工具轨迹同色），其余用中性系。 */
function kindClass(kind: ProgressStepKind): string {
  if (kind === "tool") return "border-warn-line bg-warn-soft text-warn";
  if (kind === "confirm") return "border-line-strong bg-subtle-2 text-ink";
  return "border-line-soft bg-subtle-1 text-muted";
}

/** 参数压成单行：模型给的 JSON 常常带换行，整段铺出来会把一行撑成一屏。 */
function oneLine(text: string, max = 60): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max - 1)}…`;
}

/** 本轮可计算的时间跨度：只认有首尾时间戳的步骤，拿不到就返回 null（不补 0）。 */
function turnSpan(steps: ConversationProgress["steps"]): string | null {
  const starts = steps.map((s) => s.startedAt).filter((v): v is number => typeof v === "number");
  const ends = steps.map((s) => s.endedAt).filter((v): v is number => typeof v === "number");
  if (starts.length === 0 || ends.length === 0) return null;
  const span = Math.max(...ends) - Math.min(...starts);
  return span > 0 ? formatDuration(span) : null;
}

function ToolTable({ tools }: { tools: ToolTrace[] }) {
  return (
    <div className="mt-5">
      <h4 className="ui-section-title mb-2">工具调用</h4>
      <table className="w-full table-fixed border-collapse text-ui-sm">
        <caption className="sr-only">本轮调用的工具、耗时与结果</caption>
        <thead>
          <tr className="text-left text-ui-xs text-muted">
            <th scope="col" className="w-[38%] border-b border-line-soft py-1 font-medium">工具</th>
            <th scope="col" className="w-[22%] border-b border-line-soft py-1 font-medium">耗时</th>
            <th scope="col" className="w-[40%] border-b border-line-soft py-1 font-medium">结果</th>
          </tr>
        </thead>
        <tbody>
          {tools.map((tool) => {
            const tone = STEP_TONES[tool.status];
            const ms =
              tool.endedAt !== undefined && tool.endedAt >= tool.startedAt
                ? formatDuration(tool.endedAt - tool.startedAt)
                : null;
            return (
              <tr key={tool.id} className="align-baseline">
                <th scope="row" className="truncate border-b border-line-soft py-1 pr-2 text-left font-normal text-ink">
                  {tool.name}
                </th>
                <td className="whitespace-nowrap border-b border-line-soft py-1 pr-2 tabular-nums text-muted">
                  {ms ?? "—"}
                </td>
                <td className="border-b border-line-soft py-1">
                  <span className={`text-ui-xs ${tone.text}`}>{tone.label}</span>
                  {tool.status === "denied" && tool.denyCause ? (
                    <span className="ml-1 text-ui-xs text-muted">（{tool.denyCause}）</span>
                  ) : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function TrajectoryView({ progress }: { progress: ConversationProgress }) {
  const { steps, tools, hasData } = progress;
  const span = turnSpan(steps);
  const toolsById = new Map(tools.map((tool) => [tool.id, tool]));

  return (
    <section aria-label="本轮轨迹" data-view-panel="trail">
      <h3 className="ui-section-title mb-3">本轮轨迹</h3>
      {hasData ? (
        steps.length === 0 ? (
          // 有数据但没有步骤：这一轮只发生了思考/回答，没有可列的时间点。
          // 不编造步骤，直接说明「没有可列出的步骤」。
          <p className="text-ui-sm text-muted">这一轮没有可列出的步骤。</p>
        ) : (
          <>
            {/* 事实条：只报已有的计数与可计算的时间跨度；没有就不写。 */}
            <p
              className="mb-3 flex flex-wrap items-baseline gap-x-2 gap-y-1 text-ui-xs tabular-nums text-muted"
              data-testid="trajectory-summary"
            >
              <span>{steps.length} 个步骤</span>
              <span aria-hidden="true">·</span>
              <span>{progress.counts.total} 次工具调用</span>
              {span ? (
                <>
                  <span aria-hidden="true">·</span>
                  <span>跨度 {span}</span>
                </>
              ) : null}
            </p>
            <ol className="m-0 list-none space-y-3 p-0">
              {steps.map((step, index) => {
                const tone = STEP_TONES[step.status];
                const duration = stepDuration(step);
                const tool = toolsById.get(step.id);
                const args = tool?.args ? oneLine(tool.args) : "";
                return (
                  <li key={step.id} className="flex items-start gap-3" data-step-index={index + 1}>
                    <span className="mt-0.5 shrink-0">
                      <StepStatusDot status={step.status} />
                    </span>
                    <span className="mt-0.5 w-6 shrink-0 text-right text-ui-xs tabular-nums text-muted">
                      #{index + 1}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                        <span
                          className={`shrink-0 rounded border px-1 text-ui-xs leading-4 ${kindClass(step.kind)}`}
                        >
                          {KIND_LABELS[step.kind]}
                        </span>
                        <p className="break-words text-ui-sm leading-5 text-ink">{step.label}</p>
                        {/* 状态词是颜色的文字兜底（色弱/灰度截图也能读）。 */}
                        <span className={`shrink-0 text-ui-xs leading-4 ${tone.text}`}>{tone.label}</span>
                        {duration ? (
                          <span className="shrink-0 text-ui-xs leading-4 tabular-nums text-muted">
                            {duration}
                          </span>
                        ) : null}
                      </div>
                      {/* 工具步骤的 detail（结果/思考开头）整段展开：这里是整页宽度，不需要截断。 */}
                      {step.detail ? (
                        <p className="mt-1 break-words text-ui-xs leading-5 text-muted">{step.detail}</p>
                      ) : null}
                      {args ? (
                        <p className="mt-0.5 break-words text-ui-xs leading-5 text-muted" title={tool?.args}>
                          参数：{args}
                        </p>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ol>
            {tools.length > 0 ? <ToolTable tools={tools} /> : null}
          </>
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
