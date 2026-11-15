import type { ReactNode } from "react";
import { useConversationProgress } from "../lib/progress/useConversationProgress.js";
import { ToolTraceList, toolSummaryLabel } from "./AgentStreamBubble.js";
import { TaskIcon, XIcon } from "./icons.js";
import { FlowDiagram } from "./progress/FlowDiagram.js";
import { StepsList } from "./progress/StepsList.js";
import { PHASE_TONES } from "./progress/status.js";
import { EmptyState } from "./ui/EmptyState.js";
import { IconButton } from "./ui/IconButton.js";

/**
 * 右侧「会话进度」面板（d.147.4.88）：把这一轮的三件事摊开——走到哪一步（阶段与进度条）、
 * 顺序长什么样（动态流程图）、具体做了什么（任务步骤 + 工具调用）。
 *
 * 为什么四块按这个顺序：顶部是「一句话结论 + 百分比」（扫一眼就够），中间流程图回答
 * 「卡在哪、还剩几步」，下面两块才是逐条细节。反过来（先列工具）就变成日志面板，
 * 用户在会话里其实先想知道「还要等多久」。
 *
 * 为什么数据由 props 传入会话 id、而不是订阅 activeConversationId：面板只挂在 ChatPage
 * 内，由右上角按钮开合，切页/换会话时随组件卸载；自己读全局 store 会在卸载边界上
 * 多一份「面板看到的会话」与「页面正在看的会话」不一致的可能。
 */
export function ProgressPanel({
  conversationId,
  onClose,
}: {
  conversationId: string | null;
  onClose: () => void;
}) {
  const progress = useConversationProgress(conversationId);
  const phaseTone = PHASE_TONES[progress.phase];
  const { done, total } = progress.progress;
  const toolCount = progress.tools.length;
  const toolSummary = toolSummaryLabel(progress.tools);

  return (
    <aside
      aria-label="会话进度"
      className="relative flex w-[280px] shrink-0 flex-col border-l border-line-soft bg-subtle"
    >
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line-soft px-3">
        <h2 className="ui-section-title min-w-0 flex-1 truncate">会话进度</h2>
        <IconButton label="关闭会话进度" icon={<XIcon />} onClick={onClose} />
      </div>
      {/* 滚动只发生在面板内部：页面级滚动属于会话流，侧栏撑高整页会让用户滚丢消息。 */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {progress.hasData ? (
          <div className="flex flex-col gap-4 p-3">
            <Section title="本轮进度">
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className={`inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-ui-xs ${phaseTone.badge}`}
                >
                  {phaseTone.label}
                </span>
                {/* headline 用 medium 字重：它是这一段唯一的一句话结论，比计数小字重要一档。 */}
                <p
                  className="min-w-0 flex-1 break-words text-ui-sm font-medium text-ink"
                  data-testid="progress-headline"
                >
                  {progress.headline}
                </p>
              </div>
              {/* total 为 0 时画进度条会是一条永远 0% 的空槽，像坏了；不如不画。 */}
              {total > 0 ? (
                <div
                  role="progressbar"
                  aria-label="本轮步骤进度"
                  aria-valuemin={0}
                  aria-valuemax={total}
                  aria-valuenow={done}
                  className="mt-2 h-1.5 overflow-hidden rounded-full bg-subtle-3"
                >
                  <div
                    className="h-full rounded-full bg-success transition-all duration-base motion-reduce:transition-none"
                    style={{ width: `${Math.round((done / total) * 100)}%` }}
                  />
                </div>
              ) : null}
              {/* 计数只列非零项：一行「工具 0 次」纯占位置；没有工具就整行不渲染。 */}
              {toolCount > 0 ? (
                <p className="mt-1.5 text-ui-xs leading-4 text-muted" data-testid="progress-counts">
                  工具 {toolCount} 次{toolSummary ? ` · ${toolSummary}` : ""}
                </p>
              ) : null}
              {/* 待确认要能被读屏即时播报（role=status），且给出去哪儿继续的下一步说明。 */}
              {progress.pendingConfirms > 0 ? (
                <div
                  role="status"
                  className="mt-2 rounded-lg border border-warn-line bg-warn-soft px-2.5 py-2"
                >
                  <p className="text-ui-sm font-medium text-warn">
                    等待你确认 {progress.pendingConfirms} 项工具调用
                  </p>
                  <p className="mt-0.5 text-ui-xs leading-4 text-warn">
                    在对话里允许或拒绝后，这里会继续
                  </p>
                </div>
              ) : null}
            </Section>

            <Section title="动态流程图">
              <FlowDiagram steps={progress.steps} phase={progress.phase} />
            </Section>

            <Section title="任务步骤">
              <StepsList steps={progress.steps} />
            </Section>

            {/* 没有工具调用时整段不出现：空标题比没有更让人以为「还没加载出来」。 */}
            {toolCount > 0 ? (
              <Section title="工具调用">
                <ToolTraceList tools={progress.tools} />
              </Section>
            ) : null}
          </div>
        ) : (
          <div className="flex min-h-full items-center justify-center p-4">
            <EmptyState
              titleAs="h2"
              title="这一轮还没有进度"
              desc="发送一条消息后，任务步骤、工具调用和流程图会出现在这里。"
              icon={<TaskIcon />}
              className="max-w-[240px]"
            />
          </div>
        )}
      </div>
    </aside>
  );
}

/**
 * 段落壳：固定 h3 层级与间距，避免四个 section 各写一遍还写歪。
 *
 * 注意 h3 的类名用 `ui-micro`（12px/500 muted）——小标题在 280px 侧栏里要弱于内容，
 * 否则四行标题会和正文抢注意力；但语义层级必须真实存在（h2 栏头 → h3 段落），
 * 设计审计会按 DOM 层级检查，用 span 冒充层级过不了。
 */
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col">
      <h3 className="ui-micro mb-2">{title}</h3>
      {children}
    </section>
  );
}
