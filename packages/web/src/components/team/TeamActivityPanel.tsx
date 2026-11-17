import { useCallback, useEffect, useState } from "react";
import type { TeamEvent, TeamWorkspaceSnapshot } from "@heming/shared";
import { fetchTeamEvents } from "../../lib/api.js";
import { fmtLocalDateTime } from "../../lib/format/datetime.js";
import { Button } from "../ui/Button.js";

/** 一次拉多少条：和工具默认一致，够看清「刚刚发生了什么」。 */
const ACTIVITY_LIMIT = 20;

const KIND_LABEL: Record<TeamEvent["kind"], string> = {
  task_added: "派活",
  task_updated: "改动",
  task_removed: "删任务",
  task_comment: "留言",
  plan_added: "新方案",
  plan_updated: "改方案",
  plan_removed: "删方案",
  member_added: "加人",
  member_removed: "移人",
  owner_transferred: "换队长",
};

/** 时间线上的三类事：任务线、方案线、人员线（d.274 之后才有后两类）。 */
type EventScope = "all" | "task" | "plan" | "member";

const SCOPE_LABEL: Record<EventScope, string> = {
  all: "全部",
  task: "任务",
  plan: "方案",
  member: "成员",
};

const SCOPE_KINDS: Record<Exclude<EventScope, "all">, ReadonlySet<TeamEvent["kind"]>> = {
  task: new Set(["task_added", "task_updated", "task_removed", "task_comment"]),
  plan: new Set(["plan_added", "plan_updated", "plan_removed"]),
  member: new Set(["member_added", "member_removed", "owner_transferred"]),
};

/**
 * 团队动态（d.273）：谁在哪一步动了哪件活。
 *
 * 默认折叠、展开才拉：大多数时候用户关心的是任务本身，
 * 只有「怎么突然变成这样」需要翻时间线时才用到它。
 */
export function TeamActivityPanel({
  teamId,
  members,
}: {
  teamId: string;
  members: TeamWorkspaceSnapshot["members"];
}) {
  const [open, setOpen] = useState(false);
  const [events, setEvents] = useState<TeamEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [loadedFor, setLoadedFor] = useState("");
  // 时间线可能跨任务/方案/成员，先给个粗筛（不做搜索：这里只需要「哪类事」）。
  const [scope, setScope] = useState<EventScope>("all");

  const load = useCallback(
    async (id: string) => {
      setLoading(true);
      setError("");
      try {
        const data = await fetchTeamEvents(id, undefined, ACTIVITY_LIMIT);
        setEvents(data.events);
        setLoadedFor(id);
      } catch {
        setError("动态没拉下来：可能是网络或登录态问题，稍后重试。");
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  // 切团队时把旧团队的动态清掉，避免张冠李戴。
  useEffect(() => {
    if (!open) return;
    if (loadedFor !== "" && loadedFor !== teamId) {
      setEvents([]);
      setLoadedFor("");
    }
  }, [open, loadedFor, teamId]);

  const nameOf = (id: string) => members.find((m) => m.user.id === id)?.user.displayName ?? id;
  const visible = scope === "all" ? events : events.filter((event) => SCOPE_KINDS[scope].has(event.kind));

  return (
    <section className="ui-card p-4" aria-label="团队动态">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-ui-sm font-semibold text-muted">团队动态</span>
        <span className="ui-caption">谁派的、谁改的、谁催的、谁验收的，都在这条时间线上</span>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="ml-auto"
          aria-expanded={open}
          onClick={() => {
            const next = !open;
            setOpen(next);
            if (next && loadedFor !== teamId) void load(teamId);
          }}
        >
          {open ? "收起动态" : "看动态"}
        </Button>
      </div>

      {open ? (
        <div className="mt-2" data-testid="team-events">
          {loading ? <p className="ui-caption">正在拉动态…</p> : null}
          {error ? (
            <div className="flex items-center gap-2">
              <p className="ui-caption text-danger">{error}</p>
              <Button type="button" size="sm" variant="ghost" onClick={() => void load(teamId)}>
                重试
              </Button>
            </div>
          ) : null}
          {!loading && !error && events.length === 0 ? (
            <p className="ui-caption">
              还没有动态。派活、改状态、催办、验收、留言、改方案、加人/移人都会记一条。
            </p>
          ) : null}
          {events.length > 0 ? (
            <div className="mb-2 flex flex-wrap items-center gap-1" role="group" aria-label="动态筛选">
              {(["all", "task", "plan", "member"] as EventScope[]).map((key) => (
                <Button
                  key={key}
                  type="button"
                  size="sm"
                  variant={scope === key ? "primary" : "ghost"}
                  aria-pressed={scope === key}
                  onClick={() => setScope(key)}
                >
                  {SCOPE_LABEL[key]}
                </Button>
              ))}
            </div>
          ) : null}
          {!loading && !error && events.length > 0 && visible.length === 0 ? (
            <p className="ui-caption">这一类还没有动态；切回「全部」看看别的。</p>
          ) : null}
          {visible.length > 0 ? (
            <ul className="flex flex-col gap-1">
              {visible.map((event) => (
                <li key={event.id} className="flex flex-wrap items-baseline gap-2 text-ui-sm">
                  <span className="shrink-0 tabular-nums text-muted">
                    {fmtLocalDateTime(event.createdAt).slice(5, 16)}
                  </span>
                  <span className="shrink-0 text-muted">{nameOf(event.actorId)}</span>
                  <span className="rounded-sm bg-subtle-2 px-1 text-ui-xs text-muted">
                    {KIND_LABEL[event.kind]}
                  </span>
                  <span className="min-w-0 flex-1">{event.summary}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
