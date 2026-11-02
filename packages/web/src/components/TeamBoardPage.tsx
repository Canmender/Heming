import { useCallback, useEffect, useMemo, useState } from "react";
import type { TeamActivity, TeamActivityKind, TeamMember } from "@heming/shared";
import { fetchTeam, fetchTeamActivities } from "../lib/api.js";
import { useUiStore } from "../store/ui.js";
import { Avatar } from "./Avatar.js";
import { AssistantIcon, TaskIcon, TeamIcon } from "./icons.js";

/**
 * 团队看板：工作区的替代页。
 *
 * 只收真实成员的任务与日程摘要，按「任务 / 日程」两列铺开；聊天记录、
 * 群聊与好友关系都不在这里——团队本身只有一份名册，隐私边界与团队页一致。
 */

const REFRESH_MS = 30_000;
const FEED_LIMIT = 100;

const HUMAN_KINDS: readonly TeamActivityKind[] = ["task", "agenda"];

type Range = "today" | "all";

function sameLocalDay(iso: string, now = new Date()): boolean {
  const d = new Date(iso);
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  );
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return sameLocalDay(iso, now)
    ? hm
    : `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${hm}`;
}

function lastSeenLabel(iso: string | null): string {
  if (!iso) return "从未登录";
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "从未登录";
  const diff = Math.max(0, Date.now() - at);
  if (diff < 60_000) return "刚刚在线";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return `${Math.floor(diff / 86_400_000)} 天前`;
}

function BoardCard({ activity, actor }: { activity: TeamActivity; actor: string }) {
  return (
    <article className="rounded-xl border border-line-soft bg-white px-3 py-2.5 transition-colors hover:border-[#ddd]">
      <div className="flex items-start gap-2">
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[12px] font-medium text-ink">{activity.title}</span>
          <span className="mt-0.5 block truncate text-[10px] text-muted">{actor}</span>
        </span>
        <span className="shrink-0 text-[10px] text-muted">{fmtTime(activity.occurredAt)}</span>
      </div>
      {activity.detail && (
        <p className="mt-1 line-clamp-3 break-words text-[11px] leading-5 text-[#666]">
          {activity.detail}
        </p>
      )}
    </article>
  );
}

export function TeamBoardPage() {
  const setPage = useUiStore((s) => s.setPage);
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [onlineCount, setOnlineCount] = useState(0);
  const [activities, setActivities] = useState<TeamActivity[]>([]);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [selectedActor, setSelectedActor] = useState<string | null>(null);
  const [range, setRange] = useState<Range>("today");
  const [query, setQuery] = useState("");

  const load = useCallback(async () => {
    try {
      const [team, feed] = await Promise.all([
        fetchTeam(),
        fetchTeamActivities({ limit: FEED_LIMIT }),
      ]);
      setMembers(team.members);
      setOnlineCount(team.onlineCount);
      setActivities(feed.activities.filter((a) => HUMAN_KINDS.includes(a.kind)));
      setError("");
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : "网络异常");
    } finally {
      setReady(true);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), REFRESH_MS);
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [load]);

  const roster = useMemo(
    () =>
      [...members].sort((a, b) => {
        if (a.online !== b.online) return a.online ? -1 : 1;
        return a.user.displayName.localeCompare(b.user.displayName, "zh");
      }),
    [members],
  );

  const nameOf = useCallback(
    (actorId: string) =>
      members.find((m) => m.user.id === actorId)?.user.displayName ?? "成员",
    [members],
  );

  const scoped = useMemo(() => {
    const q = query.trim().toLowerCase();
    return activities.filter((a) => {
      if (selectedActor && a.actorId !== selectedActor) return false;
      if (range === "today" && !sameLocalDay(a.occurredAt)) return false;
      if (!q) return true;
      return a.title.toLowerCase().includes(q) || (a.detail ?? "").toLowerCase().includes(q);
    });
  }, [activities, query, range, selectedActor]);

  const tasks = scoped.filter((a) => a.kind === "task");
  const agenda = scoped.filter((a) => a.kind === "agenda");
  const todayCount = activities.filter((a) => sameLocalDay(a.occurredAt)).length;

  const selectedMember = selectedActor
    ? members.find((m) => m.user.id === selectedActor) ?? null
    : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex flex-wrap items-center gap-3 border-b border-line-soft px-5 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <TeamIcon width={18} height={18} />
            <h1 className="text-[15px] font-extrabold">团队看板</h1>
            <span className="rounded border border-line px-1 text-[9px] text-muted">全站一个团队</span>
          </div>
          <p className="mt-0.5 text-[11px] text-muted">
            {members.length} 名真实成员 · {onlineCount} 人在线 · 今日 {todayCount} 条动向
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={() => void load()}
            className="rounded-lg border border-line px-2.5 py-1.5 text-[11px] text-muted hover:bg-[#fafafa]"
          >
            刷新
          </button>
          <button
            type="button"
            onClick={() => setPage("team")}
            className="rounded-lg border border-line px-2.5 py-1.5 text-[11px] text-muted hover:bg-[#fafafa]"
          >
            成员动向
          </button>
          <button
            type="button"
            onClick={() => setPage("tasks")}
            className="flex items-center gap-1 rounded-lg bg-ink px-3 py-1.5 text-[11px] font-medium text-white"
          >
            <AssistantIcon width={13} height={13} />
            去通用智能体
          </button>
        </div>
      </header>

      <div className="border-b border-line-soft bg-[#fbfbfb] px-5 py-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setSelectedActor(null)}
            className={`rounded-full border px-2.5 py-1 text-[11px] ${
              selectedActor === null
                ? "border-ink bg-ink text-white"
                : "border-line text-muted hover:bg-white"
            }`}
          >
            全部成员
          </button>
          {roster.map((m) => (
            <button
              key={m.user.id}
              type="button"
              onClick={() => setSelectedActor(m.user.id === selectedActor ? null : m.user.id)}
              className={`flex items-center gap-1.5 rounded-full border py-0.5 pl-0.5 pr-2 text-[11px] ${
                m.user.id === selectedActor
                  ? "border-ink bg-ink text-white"
                  : "border-line text-[#555] hover:bg-white"
              }`}
            >
              <span className="relative">
                <Avatar user={m.user} size={22} />
                <span
                  aria-hidden="true"
                  className={`absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full border border-white ${
                    m.online ? "bg-[#12b76a]" : "bg-[#c4c4c4]"
                  }`}
                />
              </span>
              {m.user.displayName}
            </button>
          ))}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px]">
          <div className="flex items-center gap-1" role="group" aria-label="时间范围">
            {(
              [
                ["today", "今日"],
                ["all", "全部"],
              ] as [Range, string][]
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                aria-pressed={range === value}
                onClick={() => setRange(value)}
                className={`rounded-md px-2 py-0.5 ${
                  range === value ? "bg-[#ececec] text-ink" : "text-muted hover:bg-[#f2f2f2]"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <input
            aria-label="搜索看板"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索任务或日程…"
            className="w-[200px] rounded-md border border-line px-2 py-1 text-[11px] outline-none focus:border-[#bbb]"
          />
          <span className="text-muted">
            {selectedMember ? `${selectedMember.user.displayName} · ` : ""}
            任务 {tasks.length} · 日程 {agenda.length}
          </span>
          <span className="ml-auto text-[10px] text-muted">
            只含成员主动共享的任务 / 日程摘要，不含对话与智能体轨迹
          </span>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-5 py-4">
        {!ready ? (
          <div className="grid gap-3 md:grid-cols-2">
            {[0, 1].map((i) => (
              <div key={i} className="h-40 animate-pulse rounded-xl bg-[#f2f2f2]" />
            ))}
          </div>
        ) : error ? (
          <div className="py-10 text-center text-[12px]">
            <p className="text-[#b42318]">看板加载失败：{error}</p>
            <button
              type="button"
              onClick={() => void load()}
              className="mt-2 rounded border border-line px-2 py-0.5 text-[11px]"
            >
              重试
            </button>
          </div>
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            <section aria-label="任务" className="flex min-h-[160px] flex-col rounded-xl bg-[#f7f7f7] p-3">
              <div className="mb-2 flex items-center gap-1.5 text-[12px] font-bold">
                <TaskIcon width={14} height={14} />
                任务
                <span className="text-[10px] font-normal text-muted">{tasks.length}</span>
              </div>
              {tasks.length === 0 ? (
                <p className="px-1 py-6 text-center text-[11px] text-muted">
                  {selectedMember ? "该成员没有符合条件的任务。" : "还没有任务摘要。"}
                </p>
              ) : (
                <div className="flex flex-col gap-2">
                  {tasks.map((a) => (
                    <BoardCard key={a.id} activity={a} actor={nameOf(a.actorId)} />
                  ))}
                </div>
              )}
            </section>

            <section aria-label="日程" className="flex min-h-[160px] flex-col rounded-xl bg-[#f7f7f7] p-3">
              <div className="mb-2 flex items-center gap-1.5 text-[12px] font-bold">
                <span className="h-2 w-2 rounded-full bg-[#98a2b3]" aria-hidden="true" />
                日程
                <span className="text-[10px] font-normal text-muted">{agenda.length}</span>
              </div>
              {agenda.length === 0 ? (
                <p className="px-1 py-6 text-center text-[11px] text-muted">
                  {selectedMember ? "该成员没有符合条件的日程。" : "还没有日程摘要。"}
                </p>
              ) : (
                <div className="flex flex-col gap-2">
                  {agenda.map((a) => (
                    <BoardCard key={a.id} activity={a} actor={nameOf(a.actorId)} />
                  ))}
                </div>
              )}
            </section>
          </div>
        )}
      </div>

      <footer className="border-t border-line-soft px-5 py-2 text-[10px] text-muted">
        看板数据来自团队成员主动共享的摘要；{selectedMember ? `${selectedMember.user.displayName} 最近${selectedMember.online ? "在线" : ` ${lastSeenLabel(selectedMember.lastSeenAt)} 在线`}` : "点击成员可只看他的任务与日程"}。
      </footer>
    </div>
  );
}
