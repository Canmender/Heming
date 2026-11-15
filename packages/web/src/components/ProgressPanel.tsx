import { EmptyState } from "./ui/EmptyState.js";
import { IconButton } from "./ui/IconButton.js";
import { TaskIcon, XIcon } from "./icons.js";

/**
 * 右侧「会话进度」栏（d.147.4.87）。
 *
 * 为什么现在是个空壳：用户口径是「右侧默认隐藏，可以根据会话进度展示内容」——
 * 先把位置、开合方式和留白定下来（顶栏一颗按钮、右侧一条 280px 栏），
 * 内容（工具调用 / 任务步骤 / 待确认）等有真实数据再接，避免先编一套假进度。
 *
 * 为什么内容区用 `EmptyState` 而不是自写一段灰字：空态的结构、字号档位与
 * 图标槽全站统一，标题走 `h2` 才能让「sr-only h1 → h2」的标题层级不断档
 * （设计审计要求每页至少两级标题，侧栏在 main 之外不计入）。
 */
export function ProgressPanel({ onClose }: { onClose: () => void }) {
  return (
    <aside
      aria-label="会话进度"
      className="relative flex w-[280px] shrink-0 flex-col border-l border-line-soft bg-subtle"
    >
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line-soft pl-3 pr-2">
        <h2 className="ui-section-title min-w-0 flex-1 truncate">会话进度</h2>
        <IconButton
          label="关闭会话进度"
          icon={<XIcon width={16} height={16} />}
          onClick={onClose}
        />
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto p-4">
        <EmptyState
          className="max-w-[240px]"
          icon={<TaskIcon width={24} height={24} />}
          titleAs="h2"
          title="这一轮还没有进度"
          desc="工具调用、任务步骤和待确认事项会显示在这里。"
        />
      </div>
    </aside>
  );
}
