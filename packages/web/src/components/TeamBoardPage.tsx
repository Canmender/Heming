import { useMemo, useState } from "react";
import type { TeamActivity, TeamActivityKind, TeamMember } from "@heming/shared";
import { Avatar } from "./Avatar.js";
import { CalendarIcon, TaskIcon } from "./icons.js";
import { EmptyState } from "./ui/EmptyState.js";
import { AsyncBoundary } from "./ui/AsyncBoundary.js";
import { SkeletonCard } from "./ui/Skeleton.js";
import { activitySummaryLabel, activitySummaryLine, activityTitle } from "../lib/team/labels.js";

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
  // 第二行摘要：任务类的标题本身就是状态摘要，重复时不再画第二行。
  const summary = activitySummaryLine(activity);
  return (
    <button
      type="button"
      onClick={onSelect}
      className="w-full rounded-xl border border-line-soft bg-surface px-3 py-2.5 text-left transition-colors hover:border-line-strong focus-visible:ring-2"
    >
      <span className="flex items-start gap-2">
        <span className="min-w-0 flex-1">
          <span className="block truncate text-ui-sm font-medium text-ink">{activityTitle(activity)}</span>
          <span className="mt-0.5 block truncate text-ui-xs text-muted">{actor}</span>
        </span>
        <span className="shrink-0 text-ui-xs text-muted">{fmtTime(activity.occurredAt)}</span>
      </span>
      {summary && (
        <span className="mt-1 block truncate text-ui-xs leading-5 text-body">{summary}</span>
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
      // 搜索只匹配**上屏的**标题与派生摘要（不回显 detail 自由文本）；任务类的标题
      // 由 activityTitle 派生，直接搜 a.title 会去匹配一个用户根本看不到的旧字段。
      return (
        activityTitle(a).toLowerCase().includes(q) ||
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
      <div className="shrink-0 border-b border-line-soft bg-subtle px-6 py-2.5">
        {/* 成员 chips 单行横向滚动：1100 窄窗下不再折成两行占掉内容高度。 */}
        <div className="flex flex-nowrap items-center gap-2 overflow-x-auto pb-0.5">
          {/* P2 可达性：胶囊本体只有 27px 高，`min-h-8` 撑到 32 命中区（轨道行溢出滚动，
              伪元素扩区会被 `overflow-x-auto` 裁掉，所以必须撑本体）。 */}
          <button
            type="button"
            aria-pressed={selectedId === null}
            onClick={() => onSelectMember(null)}
            className={`ui-hit inline-flex min-h-8 shrink-0 items-center rounded-full border px-2.5 py-1 text-ui-xs ${
              selectedId === null
                ? "border-ink bg-ink text-white"
                : "border-line text-muted hover:bg-surface"
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
              className={`ui-hit flex min-h-8 shrink-0 items-center gap-1.5 rounded-full border py-0.5 pl-0.5 pr-2 text-ui-xs ${
                m.user.id === selectedId
                  ? "border-ink bg-ink text-white"
                  : "border-line text-body hover:bg-surface"
              }`}
            >
              <span className="relative">
                <Avatar user={m.user} size={22} />
                <span
                  aria-hidden="true"
                  className={`absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full border border-surface ${
                    m.online ? "bg-success" : "bg-line-strong"
                  }`}
                />
              </span>
              {m.user.displayName}
            </button>
          ))}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2 ui-caption">
          {/* 时间范围：原来是手拼的两颗 22px 高文字按钮，选中态只有一层浅底；
              改用全站唯一分段控件（.ui-segment 已 min-h-8），语义也从「按钮」变成
              互斥筛选，与记忆页「复盘频率」等同类切换一致。 */}
          <div className="ui-segment-group" role="group" aria-label="时间范围">
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
                className="ui-segment"
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
            className="ui-hit inline-flex min-h-8 items-center rounded-lg border border-line bg-surface px-2.5 py-1 ui-caption hover:bg-subtle-2"
          >
            刷新
          </button>
        </div>
        <p className="mt-2 ui-micro">
          {members.length} 名成员 · {onlineCount} 人在线 · 今日 {todayCount} 条动向 ·
          只含成员主动共享的任务 / 日程摘要
        </p>
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-6 py-5">
        <AsyncBoundary
          status={!ready ? "loading" : error ? "error" : "ready"}
          loadingLabel="正在加载"
          loadingClassName="grid gap-4 md:grid-cols-2"
          loadingFallback={
            <>
              {[0, 1].map((i) => (
                <SkeletonCard key={i} lines={3} className="h-40" />
              ))}
            </>
          }
          errorTitle={<>看板加载失败：{error}</>}
          onRetry={onRetry}
          errorClassName="py-10"
        >
          <div className="grid gap-4 md:grid-cols-2">
            <section aria-label="任务" className={`flex flex-col rounded-xl bg-subtle-2 p-3 ${tasks.length === 0 ? "" : "min-h-[160px]"}`}>
              <h2 className="mb-2 flex items-center gap-1.5 ui-section-title">
                <TaskIcon width={14} height={14} />
                任务
                <span className="ui-micro font-normal">{tasks.length}</span>
              </h2>
              {tasks.length === 0 ? (
                <EmptyState
                  compact
                  className="px-0 py-6"
                  icon={<TaskIcon width={20} height={20} />}
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

            <section aria-label="日程" className={`flex flex-col rounded-xl bg-subtle-2 p-3 ${agenda.length === 0 ? "" : "min-h-[160px]"}`}>
              <h2 className="mb-2 flex items-center gap-1.5 ui-section-title">
                <span className="h-2 w-2 rounded-full bg-line-strong" aria-hidden="true" />
                日程
                <span className="ui-micro font-normal">{agenda.length}</span>
              </h2>
              {agenda.length === 0 ? (
                <EmptyState
                  compact
                  className="px-0 py-6"
                  icon={<CalendarIcon width={20} height={20} />}
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
        </AsyncBoundary>
      </div>
    </div>
  );
}
