import type { TeamActivity, TeamMember } from "@heming/shared";
import { Avatar } from "../Avatar.js";
import { Button } from "../ui/Button.js";
import { EmptyState } from "../ui/EmptyState.js";
import { SkeletonLine } from "../ui/Skeleton.js";
import { TeamIcon } from "../icons.js";
import { useUiStore } from "../../store/ui.js";

/**
 * 首页「团队动向」卡（d.141 从 HomePage 抽出的既有实现，行为未改）。
 *
 * 为什么抽：首页重排后它落在第二屏（状态与动向），数据仍由 HomePage 拉取
 * （同一份 `activities` 还要喂「今日动向」统计卡），这里只负责渲染与三种状态：
 * 加载骨架 / 加载失败（可重试）/ 空态（给下一步动作）。
 */

function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return sameDay
    ? hm
    : `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${hm}`;
}

const KIND_LABEL: Record<TeamActivity["kind"], string> = {
  task: "任务",
  agent: "AI",
  staff: "幕僚",
  agenda: "日程",
  join: "加入",
};

export interface TeamActivityCardProps {
  /** 只含真实成员的任务与日程（智能体侧旧数据不在首页露出）。 */
  activities: TeamActivity[];
  members: TeamMember[];
  /** 首次拉取是否已落地：false 时显示骨架，而不是「空态」。 */
  teamReady: boolean;
  teamError: string;
  lastTeamLoadAt: number | null;
  onRefresh: () => void;
  onOpenTeam: () => void;
}

export function TeamActivityCard({
  activities,
  members,
  teamReady,
  teamError,
  lastTeamLoadAt,
  onRefresh,
  onOpenTeam,
}: TeamActivityCardProps) {
  const recentActivities = activities.slice(0, 3);

  return (
    <section aria-label="团队动向" className="ui-card p-3">
      <div className="mb-1.5 flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-ui-sm font-bold text-muted">
          <TeamIcon width={14} height={14} />
          团队动向
        </div>
        <div className="flex items-center gap-2">
          {lastTeamLoadAt ? (
            <span className="ui-micro">{fmtTime(new Date(lastTeamLoadAt).toISOString())} 更新</span>
          ) : null}
          <button
            type="button"
            className="ui-link"
            onClick={onRefresh}
          >
            刷新
          </button>
          <button
            type="button"
            className="ui-link"
            onClick={onOpenTeam}
          >
            进入团队
          </button>
        </div>
      </div>
      {activities.length === 0 ? (
        !teamReady ? (
          <div role="status" aria-label="正在加载" className="flex flex-col gap-2 py-1.5">
            {[0, 1, 2].map((i) => (
              <SkeletonLine key={i} className="h-7 rounded-lg" />
            ))}
          </div>
        ) : teamError ? (
          <div className="flex items-center justify-between gap-2 py-1.5 text-ui-sm">
            <div role="alert" className="ui-alert ui-alert-danger min-w-0 flex-1 items-center">
              <span className="min-w-0 truncate">加载失败：{teamError}</span>
            </div>
            <button
              type="button"
              onClick={onRefresh}
              className="ui-link border border-line"
            >
              重试
            </button>
          </div>
        ) : (
          // 空态必须给下一步：用户看到「还没有团队动向」时唯一的动作是去团队页开启共享。
          <EmptyState
            compact
            align="start"
            title="还没有团队动向"
            desc="成员在「团队」页开启共享后，这里显示任务和日程摘要；对话正文不上传。"
            action={
              <Button type="button" size="sm" variant="ghost" onClick={onOpenTeam}>
                去团队页
              </Button>
            }
          />
        )
      ) : (
        recentActivities.map((a) => {
          const actor = members.find((m) => m.user.id === a.actorId);
          return (
            <button
              key={a.id}
              type="button"
              // 点的是「谁的哪条动向」就落到那个人 + 高亮那一条（审计 P2-6 的完整一半）
              onClick={() => useUiStore.getState().focusTeamActivity(a.id, a.actorId)}
              className="flex w-full items-start gap-2.5 rounded-lg px-1.5 py-2 text-left transition-colors duration-fast hover:bg-[var(--subtle-2)]"
            >
              <Avatar
                user={{
                  displayName: actor?.user.displayName ?? "成员",
                  avatar: actor?.user.avatar,
                }}
                size={28}
              />
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline gap-1.5">
                  <span className="shrink-0 rounded-sm border border-line px-1 text-ui-xs text-muted">
                    {KIND_LABEL[a.kind]}
                  </span>
                  <span className="truncate text-ui-md font-medium">{a.title}</span>
                </span>
                <span className="block truncate text-ui-xs text-muted">
                  {actor?.user.displayName ?? "成员"}
                  {a.detail ? ` · ${a.detail}` : ""}
                </span>
              </span>
              <span className="shrink-0 text-ui-xs text-muted">{fmtTime(a.occurredAt)}</span>
            </button>
          );
        })
      )}
    </section>
  );
}