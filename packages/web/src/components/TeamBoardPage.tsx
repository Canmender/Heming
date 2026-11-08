import { useMemo, useState } from "react";
import type { TeamActivity, TeamActivityKind, TeamMember } from "@heming/shared";
import { Avatar } from "./Avatar.js";
import { TaskIcon } from "./icons.js";
import { EmptyState } from "./ui/EmptyState.js";
import { SkeletonCard } from "./ui/Skeleton.js";
import { activitySummaryLabel } from "../lib/team/labels.js";

/**
 * 团队看板（d.67 起并入团队页的「看板」Tab，d.109 起改为受控视图）。
 *
 * 它只收真实成员的任务与日程摘要，按「任务 / 日程」两列铺开；聊天记录、群聊与
 * 好友关系都不在这里——团队本身只有一份名册，隐私边界与团队页一致。
 *
 * **数据由宿主 `TeamPage` 提供**（同一份 `fetchTeamActivities` 结果 + 同一套成员筛选），
 * 不再自己取数/轮询：d.109 之前看板与动向各拉一份（limit=100 / 30s vs 50 / 60s），
 * 同一时刻两个视图可能看到不同条数，且切换 Tab 就是一次冷启动。现在看板是
 * 「动向的另一种读法」——同一份摘要按类型铺成两列，成员筛选也共用宿主状态。
 */

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

function BoardCard({
  activity,
  actor,
  onSelect,
}: {
  activity: TeamActivity;
  actor: string;
  onSelect: () => void;
}) {
  const summary = activitySummaryLabel(activity);
  return (
    <button
      type="button"
      onClick={onSelect}
      className="w-full rounded-xl border border-line-soft bg-white px-3 py-2.5 text-left transition-colors hover:border-[var(--line-strong)] focus-visible:ring-2"
    >
      <span className="flex items-start gap-2">
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[12px] font-medium text-ink">{activity.title}</span>
          <span className="mt-0.5 block truncate text-[10px] text-muted">{actor}</span>
        </span>
        <span className="shrink-0 text-[10px] text-muted">{fmtTime(activity.occurredAt)}</span>
      </span>
      {summary && (
        <span className="mt-1 block truncate text-[11px] leading-5 text-[#666]">{summary}</span>
      )}
    </button>
  );
}

export interface TeamBoardViewProps {
  /** 额外容器类：宿主页要控制高度/内边距时用，视图本身不自带 PageShell。 */
  className?: string;
  /** 宿主已加载的名册（不再自己拉 /api/team）。 */
  members: TeamMember[];
  onlineCount: number;
  /** 宿主已加载的动向（已按人成员两类过滤）；本视图只做展示与筛选。 */
  activities: TeamActivity[];
  /** 宿主持有的「选中成员」：看板 chips 与左栏名册读写同一个状态。 */
  selectedId: string | null;
  onSelectMember: (userId: string | null) => void;
  ready: boolean;
  error: string;
  onRetry: () => void;
}

export function TeamBoardView({
  className = "",
  members,
  onlineCount,
  activities,
  selectedId,
  onSelectMember,
  ready,
  error,
  onRetry,
}: TeamBoardViewProps) {
  const [range, setRange] = useState<Range>("today");
  const [query, setQuery] = useState("");

  const human = useMemo(
    () => activities.filter((a) => HUMAN_KINDS.includes(a.kind)),
    [activities],
  );

  const roster = useMemo(
    () =>
      [...members].sort((a, b) => {
        if (a.online !== b.online) return a.online ? -1 : 1;
        return a.user.displayName.localeCompare(b.user.displayName, "zh");
      }),
    [members],
  );

  const nameOf = (actorId: string) =>
    members.find((m) => m.user.id === actorId)?.user.displayName ?? "成员";

  const scoped = useMemo(() => {
    const q = query.trim().toLowerCase();
    return human.filter((a) => {
      if (selectedId && a.actorId !== selectedId) return false;
      if (range === "today" && !sameLocalDay(a.occurredAt)) return false;
      if (!q) return true;
      // 搜索只匹配标题与派生摘要（不回显 detail 自由文本）。
      return (
        a.title.toLowerCase().includes(q) ||
        activitySummaryLabel(a).toLowerCase().includes(q)
      );
    });
  }, [human, query, range, selectedId]);

  const tasks = scoped.filter((a) => a.kind === "task");
  const agenda = scoped.filter((a) => a.kind === "agenda");
  const todayCount = human.filter((a) => sameLocalDay(a.occurredAt)).length;

  const selectedMember = selectedId
    ? members.find((m) => m.user.id === selectedId) ?? null
    : null;

  return (
    <div className={`flex min-h-0 flex-1 flex-col ${className}`}>
      <div className="shrink-0 border-b border-line-soft bg-[#fbfbfb] px-6 py-2.5">
        {/* 成员 chips 单行横向滚动：1100 窄窗下不再折成两行占掉内容高度。 */}
        <div className="flex flex-nowrap items-center gap-2 overflow-x-auto pb-0.5">
          <button
            type="button"
            aria-pressed={selectedId === null}
            onClick={() => onSelectMember(null)}
            className={`shrink-0 rounded-full border px-2.5 py-1 text-[11px] ${
              selectedId === null
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
              aria-pressed={m.user.id === selectedId}
              onClick={() => onSelectMember(m.user.id === selectedId ? null : m.user.id)}
              className={`flex shrink-0 items-center gap-1.5 rounded-full border py-0.5 pl-0.5 pr-2 text-[11px] ${
                m.user.id === selectedId
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
        <div className="mt-2 flex flex-wrap items-center gap-2 ui-caption">
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
            className="w-[200px] rounded-md border border-line-strong px-2 py-1 ui-caption outline-hidden focus:border-ink"
          />
          <span>
            {selectedMember ? `${selectedMember.user.displayName} · ` : ""}
            任务 {tasks.length} · 日程 {agenda.length}
          </span>
          <button
            type="button"
            onClick={onRetry}
            className="rounded-lg border border-line bg-white px-2.5 py-1 ui-caption hover:bg-[#f5f5f5]"
          >
            刷新
          </button>
        </div>
        <p className="mt-1.5 ui-micro">
          {members.length} 名成员 · {onlineCount} 人在线 · 今日 {todayCount} 条动向 ·
          只含成员主动共享的任务 / 日程摘要
        </p>
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-6 py-5">
        {!ready ? (
          <div className="grid gap-4 md:grid-cols-2" role="status" aria-label="正在加载">
            {[0, 1].map((i) => (
              <SkeletonCard key={i} lines={3} className="h-40" />
            ))}
          </div>
        ) : error ? (
          <div className="py-10 text-center text-[12px]">
            <p role="alert" className="text-[#b42318]">看板加载失败：{error}</p>
            <button
              type="button"
              onClick={onRetry}
              className="mt-2 rounded-sm border border-line px-2 py-0.5 text-[11px]"
            >
              重试
            </button>
          </div>
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            <section aria-label="任务" className={`flex flex-col rounded-xl bg-[#f7f7f7] p-3 ${tasks.length === 0 ? "" : "min-h-[160px]"}`}>
              <div className="mb-2 flex items-center gap-1.5 ui-section-title">
                <TaskIcon width={14} height={14} />
                任务
                <span className="ui-micro font-normal">{tasks.length}</span>
              </div>
              {tasks.length === 0 ? (
                <EmptyState
                  compact
                  className="px-0 py-6"
                  title={selectedMember ? "该成员没有符合条件的任务。" : "还没有任务摘要。"}
                />
              ) : (
                <div className="flex flex-col gap-2">
                  {tasks.map((a) => (
                    <BoardCard
                      key={a.id}
                      activity={a}
                      actor={nameOf(a.actorId)}
                      onSelect={() => onSelectMember(a.actorId)}
                    />
                  ))}
                </div>
              )}
            </section>

            <section aria-label="日程" className={`flex flex-col rounded-xl bg-[#f7f7f7] p-3 ${agenda.length === 0 ? "" : "min-h-[160px]"}`}>
              <div className="mb-2 flex items-center gap-1.5 ui-section-title">
                <span className="h-2 w-2 rounded-full bg-[#98a2b3]" aria-hidden="true" />
                日程
                <span className="ui-micro font-normal">{agenda.length}</span>
              </div>
              {agenda.length === 0 ? (
                <EmptyState
                  compact
                  className="px-0 py-6"
                  title={selectedMember ? "该成员没有符合条件的日程。" : "还没有日程摘要。"}
                />
              ) : (
                <div className="flex flex-col gap-2">
                  {agenda.map((a) => (
                    <BoardCard
                      key={a.id}
                      activity={a}
                      actor={nameOf(a.actorId)}
                      onSelect={() => onSelectMember(a.actorId)}
                    />
                  ))}
                </div>
              )}
            </section>
          </div>
        )}
      </div>
    </div>
  );
}
