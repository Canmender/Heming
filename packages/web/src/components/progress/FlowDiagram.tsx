import type { ProgressPhase, ProgressStep, ProgressStepStatus } from "../../lib/progress/model.js";
import { AlertIcon, CheckIcon, XIcon } from "../icons.js";
import { STEP_TONES, connectorClass, stepDuration } from "./status.js";

/**
 * 动态流程图（d.147.4.88）：把「这一轮走到哪了」画成一条竖排时间轴。
 *
 * 为什么用流程图而不是复用步骤列表：步骤列表回答「有哪些步」，流程图回答
 * 「顺序与卡点」——用户在侧栏最想一眼看到的是「现在停在哪、接下来还剩几步」。
 * 两者数据同源（`progress.steps`），只是表达密度不同，所以一上一下都留着。
 *
 * 为什么纯 div/CSS 而不引图形库：280px 宽的侧栏里节点最多十来个，
 * 一条竖线加几个圆点就够，引 mermaid/xyflow 只会带来几百 KB 与一个新依赖。
 * 连接线用 `border-l` 画（只有 border 能 dashed），圆点用 flex 列居中，
 * 不需要绝对定位，也就没有「容器变高后线断开」的问题。
 *
 * 可达性：整张图当一张图播报（`role="img"` + 一句话读完整条链路），
 * 内部节点 `aria-hidden`，避免读屏逐个节点再把标签念一遍。
 */
export function FlowDiagram({ steps, phase }: { steps: ProgressStep[]; phase: ProgressPhase }) {
  // 没有步骤就没有图可画；空态由面板统一处理，这里不造一个「空流程」。
  if (steps.length === 0) return null;

  // 读屏听到的是整条链路的顺序（「思考 → 调用 read_file → 生成回答」），
  // 节点内的状态词靠 aria-label 已经概括不了，所以额外补进尾部说明。
  const trail = steps.map((s) => s.label).join(" → ");

  return (
    <div
      role="img"
      aria-label={`本轮流程：${trail}`}
      data-testid="progress-flow"
      data-phase={phase}
      className="rounded-lg border border-line-soft bg-surface px-2.5 py-2"
    >
      <div aria-hidden="true">
        <ol className="flex list-none flex-col p-0">
          {steps.map((step, index) => {
            const last = index === steps.length - 1;
            const tone = STEP_TONES[step.status];
            const duration = stepDuration(step);
            return (
              <li
                key={step.id}
                data-testid={`progress-flow-node-${step.id}`}
                data-status={step.status}
                className="flex items-stretch gap-2"
              >
                {/* 左轨：节点 + 连接线。线长由右侧文本块的行数决定，短步骤也不会断开。 */}
                <div className="flex w-4 shrink-0 flex-col items-center">
                  <span className="mt-0.5 flex h-4 w-4 items-center justify-center">
                    <StepStatusDot status={step.status} />
                  </span>
                  {last ? null : <span className={`w-0 flex-1 ${connectorClass(step.status)}`} />}
                </div>
                {/* 右侧：标签 + 状态词（有耗时时跟在后面）。min-w-0 必须留，否则长工具名会把栏撑出横向滚动。 */}
                <div className={`min-w-0 flex-1 ${last ? "" : "pb-3"}`}>
                  <p className="break-words text-ui-sm leading-5 text-ink">{step.label}</p>
                  <p className="mt-0.5 break-words text-ui-xs leading-4 text-muted">
                    <span className={tone.text}>{tone.label}</span>
                    {duration ? <span> · {duration}</span> : null}
                  </p>
                </div>
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}

/**
 * 状态点：16px 的圆形徽标，终态里面放一个描边图形，进行中/等待只用底色/虚线边。
 *
 * 为什么图形只给 ok/error/denied：这三个是「结果」，图形能让人不看文字也认出来；
 * running 与 waiting 靠颜色 + 呼吸/虚线已经足够区分，再塞图形会显得吵。
 *
 * 为什么导出：任务步骤列表要同一颗点；两个组件各自画一份会让「同一个状态两种外观」
 * 慢慢长出来。放在这里而不是 `status.ts`，是因为 `status.ts` 是纯数据文件、不带 JSX。
 */
export function StepStatusDot({ status }: { status: ProgressStepStatus }) {
  const tone = STEP_TONES[status];
  return (
    <span
      className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${tone.dot}`}
      aria-hidden="true"
    >
      {status === "ok" ? <CheckIcon width={12} height={12} /> : null}
      {status === "error" ? <AlertIcon width={12} height={12} /> : null}
      {status === "denied" ? <XIcon width={12} height={12} /> : null}
    </span>
  );
}