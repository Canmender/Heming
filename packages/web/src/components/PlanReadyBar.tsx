import { Button } from "./ui/Button.js";

/**
 * 「这一轮是计划模式，只给了方案」的可见落点（d.173）。
 *
 * 为什么需要它：开了计划模式之后，写工具被摘掉，模型只能读、只能给计划。
 * 用户看完计划如果还想让它动手，就得自己先找到「计划」按钮关掉、再打字说「按这个来」——
 * 两件事都容易忘，而「忘了关」的表现恰好是「它怎么不动手」，会被当成模型不会干活。
 *
 * 所以把这一步做成一次点击：按钮同时做两件事（关掉计划模式 + 发一条「照上面的计划执行」）。
 * 注意这里不替用户判断计划好坏：要不要执行由人按，界面只负责把「方案已就绪、还没动文件」说出来。
 */
export interface PlanReadyBarProps {
  /** 点「接受计划，开始执行」：关掉计划模式，并以一条用户消息让模型照着刚才的计划动手。 */
  onExecute: () => void;
  /** 点「继续讨论」：只收起这条提示；计划模式保持开启，用户接着说。 */
  onDismiss?: () => void;
}

export function PlanReadyBar({ onExecute, onDismiss }: PlanReadyBarProps) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="mx-4 mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-line bg-subtle-2 px-2.5 py-1.5 text-ui-sm text-ink"
    >
      <span aria-hidden="true" className="text-heming-accent">
        ◉
      </span>
      <span>计划模式：这一轮只给了方案，文件还没有改动。</span>
      <span className="inline-flex items-center gap-1.5">
        <Button variant="ghost" size="sm" onClick={onExecute}>
          接受计划，开始执行
        </Button>
        {onDismiss ? (
          <Button variant="ghost" size="sm" onClick={onDismiss}>
            继续讨论
          </Button>
        ) : null}
      </span>
    </div>
  );
}
