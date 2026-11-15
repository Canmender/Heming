import type { ReactNode } from "react";
import { PAGE_TABLIST, pageTabClass } from "../../lib/ui/tabStyles.js";
import { FOCUS_RING } from "../../lib/a11y/focus.js";

/**
 * 会话页「编排条」（T32）：两行顶栏。
 *
 * 第一行是「这一轮在什么状态下编排」：会话标题 + 四个 chip（团队 / 模式 / 工具调用 /
 * 后台任务）；第二行是主区切换（对话 / 轨迹 / 上下文）。
 *
 * 为什么 chip 只用真实数据：参考实现里的「N 个子智能体」我们没有对应实体，
 * 编一个数字出来只会让审计和用户都对不上账。工具调用取本轮进度里的真实计数、
 * 后台任务取任务库里本会话仍在跑的条数，为 0 就老实显示 0。
 *
 * 为什么把页签视觉收去 `lib/ui/tabStyles.js`：一级页签全站统一为下划线式
 * （设置页/插件页/记忆页/团队页都是 PAGE_TABLIST + pageTabClass），会话页再抄一套
 * 药丸样式会让同一个「页面内一级切换」出现两种视觉语言。
 */
export type ChatView = "chat" | "trail" | "context";

/** 页签顺序即使用频率：对话是默认，轨迹看过程，上下文看预算。 */
const VIEW_TABS: ReadonlyArray<{ id: ChatView; label: string }> = [
  { id: "chat", label: "对话" },
  { id: "trail", label: "轨迹" },
  { id: "context", label: "上下文" },
];

/** chip 共用外观：`.ui-chip` 是纯展示胶囊；可聚焦的 chip 再补一个统一焦点环。 */
const CHIP_CLASS = `ui-chip ${FOCUS_RING}`;

export interface OrchestrationBarProps {
  /** 会话标题（调用方用 conversationTitle 算好，组件不认识 store）。 */
  title: string;
  /** 本轮工具调用数（真实：progress.counts.total）。 */
  toolsCount: number;
  /** 本会话仍在跑的后台任务数（真实：任务库按 conversationId 过滤）。 */
  tasksCount: number;
  view: ChatView;
  onViewChange: (view: ChatView) => void;
  /** 打开「智能体团队」页（导航由调用方接 store，组件不碰全局状态）。 */
  onOpenTeam: () => void;
  /** 右侧动作槽：会话进度、会话内搜索等既有按钮原样搬进来。 */
  right?: ReactNode;
  /**
   * 标题左侧槽位（T32）：返回按钮不属于「编排事实」，但它必须和标题同一行，
   * 所以做成可选槽位——单独再包一行会把「返回 → 标题」的阅读顺序拆散。
   */
  leading?: ReactNode;
}

export function OrchestrationBar({
  title,
  toolsCount,
  tasksCount,
  view,
  onViewChange,
  onOpenTeam,
  right,
  leading,
}: OrchestrationBarProps) {
  return (
    <div
      data-testid="chat-orchestration"
      className="shrink-0 border-b border-line-soft px-chat-gutter"
    >
      {/* 第一行：标题 + 编排事实。flex-wrap：窄屏（320px）下 chips 换行而不是把标题挤没。 */}
      <div className="flex min-h-11 flex-wrap items-center gap-2 py-1.5">
        {leading}
        <h2 className="ui-section-title min-w-0 truncate">{title}</h2>
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <button
            type="button"
            data-chip="team"
            title="打开智能体团队"
            onClick={onOpenTeam}
            className={`${CHIP_CLASS} transition-colors hover:border-line-strong hover:text-ink`}
          >
            智能体团队
          </button>
          <span
            data-chip="mode"
            title="当前编排模式：标准"
            tabIndex={0}
            className={CHIP_CLASS}
          >
            标准模式
          </span>
          <span data-chip="tools" tabIndex={0} className={CHIP_CLASS}>
            {toolsCount} 个工具调用
          </span>
          <span data-chip="tasks" tabIndex={0} className={CHIP_CLASS}>
            {tasksCount} 个后台任务
          </span>
        </div>
        {right ? <div className="ml-auto flex items-center gap-2">{right}</div> : null}
      </div>
      {/* 第二行：主区页签。下划线压住分隔线（pageTabClass 自带 -mb-px）。 */}
      <div role="tablist" aria-label="会话视图" className={PAGE_TABLIST}>
        {VIEW_TABS.map((tab) => {
          const active = tab.id === view;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              id={`chat-view-tab-${tab.id}`}
              data-view={tab.id}
              aria-selected={active}
              aria-controls={`chat-view-panel-${tab.id}`}
              onClick={() => onViewChange(tab.id)}
              className={pageTabClass(active)}
            >
              {tab.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
