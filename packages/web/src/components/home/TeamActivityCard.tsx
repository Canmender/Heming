import type { TeamActivity, TeamMember } from "@heming/shared";
import { Avatar } from "../Avatar.js";
import { Button } from "../ui/Button.js";
import { EmptyState } from "../ui/EmptyState.js";
import { SkeletonLine } from "../ui/Skeleton.js";
import { TeamIcon } from "../icons.js";
import { useUiStore } from "../../store/ui.js";
import { activitySummaryLine, activityTitle } from "../../lib/team/labels.js";

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
  /** 当前在线人数（团队名册口径，用于卡片标题右侧的规模提示）。 */
  onlineCount: number;
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
  onlineCount,
  teamReady,
  teamError,
  lastTeamLoadAt,
  onRefresh,
  onOpenTeam,
}: TeamActivityCardProps) {
  const recentActivities = activities.slice(0, 3);

  return (
    <section aria-label="团队动向" className="ui-card p-3">
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-2 text-ui-sm font-semibold text-muted">
          <TeamIcon width={16} height={16} />
          团队动向
          {/* T2-09：首页此前只拉 onlineCount、不显示（spec §8 要求露出规模）。 */}
          {teamReady && !teamError && members.length > 0 ? (
            <span className="font-normal ui-micro">
              {members.length} 名成员 · {onlineCount} 人在线
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          {lastTeamLoadAt ? (
            <span className="ui-micro">{fmtTime(new Date(lastTeamLoadAt).toISOString())} 更新</span>
          ) : null}
          <button
            type="button"
            className="ui-link ui-hit"
            onClick={onRefresh}
          >
            刷新
          </button>
          <button
            type="button"
            className="ui-link ui-hit"
            onClick={onOpenTeam}
          >
            进入团队
          </button>
        </div>
      </div>
      {activities.length === 0 ? (
        !teamReady ? (
          <div role="status" aria-label="正在加载" className="flex flex-col gap-2 py-2">
            {[0, 1, 2].map((i) => (
              <SkeletonLine key={i} className="h-7 rounded-lg" />
            ))}
          </div>
        ) : teamError ? (
          <div className="flex items-center justify-between gap-2 py-2 text-ui-sm">
            <div role="alert" className="ui-alert ui-alert-danger min-w-0 flex-1 items-center">
              <span className="min-w-0 truncate">加载失败：{teamError}</span>
            </div>
            <button
              type="button"
              onClick={onRefresh}
              className="ui-link border border-line ui-hit"
            >
              重试
            </button>
          </div>
        ) : (
          // 空态 = 标题 + 一个行动（d.142）：前面「成员在团队页开启共享后，这里显示…摘要」
          // 是把空态标题换个说法再说一遍，删掉；只保留用户猜不到的边界——对话正文不上传。
          <EmptyState
            compact
            align="start"
            title="还没有团队动向"
            desc="只共享任务与日程，对话正文不上传。"
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
              className="flex w-full items-start gap-3 rounded-lg px-2 py-2 text-left transition-colors duration-fast hover:bg-subtle-2"
            >
              <Avatar
                user={{
                  displayName: actor?.user.displayName ?? "成员",
                  avatar: actor?.user.avatar,
                }}
                size={28}
              />
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline gap-2">
                  <span className="shrink-0 rounded-sm border border-line px-1 text-ui-xs text-muted">
                    {KIND_LABEL[a.kind]}
                  </span>
                  <span className="truncate text-ui-md font-medium">{activityTitle(a)}</span>
                </span>
                <span className="block truncate ui-caption">
                  {actor?.user.displayName ?? "成员"}
                  {activitySummaryLine(a) ? ` · ${activitySummaryLine(a)}` : ""}
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