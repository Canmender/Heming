import type { CollaborationTurn } from "../../lib/collaboration/types.js";
import { Avatar } from "../Avatar.js";
import { MarkdownMessage } from "../MarkdownMessage.js";

function durationOf(turn: CollaborationTurn): string {
  if (!turn.startedAt || !turn.endedAt) return "";
  const ms = Math.max(0, turn.endedAt - turn.startedAt);
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1)} 秒`;
}

/**
 * 一个协作回合：谁、什么角色、第几轮、流式正文、耗时/错误。
 * 与聊天气泡刻意不同——这是「有结构的工作台」，左侧有回合序号与角色标签。
 */
export function CollabTurnCard({
  turn,
  order,
}: {
  turn: CollaborationTurn;
  /** 回合序号（从 1 开始，按时间顺序）。 */
  order: number;
}) {
  const duration = durationOf(turn);
  return (
    <article
      className="ui-card p-3"
      aria-label={`第 ${order} 个回合：${turn.agentName}，${turn.role}`}
    >
      <header className="flex flex-wrap items-center gap-2">
        <span className="ui-micro ui-numeric w-5 shrink-0 text-right">{order}</span>
        <Avatar user={{ displayName: turn.agentName }} size={22} />
        <span className="ui-body-sm min-w-0 truncate font-medium">{turn.agentName}</span>
        <span className="ui-chip">{turn.role}</span>
        {turn.round > 0 ? <span className="ui-micro">第 {turn.round} 轮</span> : null}
        {turn.streaming ? (
          <span className="ui-micro animate-pulse text-[var(--heming-accent)]">生成中…</span>
        ) : null}
        {turn.aborted ? <span className="ui-chip">已中止</span> : null}
        <span className="ui-micro ml-auto ui-numeric">{duration}</span>
      </header>

      <div className="ui-body mt-2 pl-7">
        {turn.error ? (
          <p className="ui-alert ui-alert-danger" role="alert">
            {turn.error}
          </p>
        ) : null}
        {turn.text ? (
          <MarkdownMessage text={turn.text} streaming={Boolean(turn.streaming)} />
        ) : !turn.error ? (
          <p className="ui-caption">{turn.streaming ? "正在生成…" : "（本回合没有产出）"}</p>
        ) : null}
      </div>
    </article>
  );
}
