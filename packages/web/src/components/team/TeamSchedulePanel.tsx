import { useMemo, useState } from "react";
import type { TeamTask, TeamWorkspaceSnapshot } from "@heming/shared";
import { describeSchedule, dueText, scheduleBuckets, type ScheduleBucketKey } from "../../lib/team/schedule.js";
import { Button } from "../ui/Button.js";

/** 每一档最多列几件：够了就收口，免得一屏全是标题。 */
const SCHEDULE_ROW_MAX = 6;

const STATUS_LABEL: Record<TeamTask["status"], string> = {
  todo: "未开始",
  doing: "进行中",
  done: "已完成",
  blocked: "有卡点",
};

const BUCKET_TONE: Record<ScheduleBucketKey, string> = {
  overdue: "text-danger",
  today: "text-warn",
  tomorrow: "text-body",
  week: "text-body",
  later: "text-muted",
  none: "text-muted",
};

/**
 * 近期要交的活（d.277）：按截止日把「今天谁该交什么」摊开。
 *
 * 任务板是按状态和负责人分的，回答「谁在做什么」；
 * 组长每天要问的是「今天谁该交什么、哪件已经拖了」——两条不同的轴。
 * 默认收起（展开才渲染标题，避免和任务板撞脸）；这里只读任务、不改任何东西；没有带截止的任务就整块不出现（不占版面）。
 */
export function TeamSchedulePanel({
  tasks,
  members,
  now = Date.now(),
}: {
  tasks: readonly TeamTask[];
  members: TeamWorkspaceSnapshot["members"];
  now?: number;
}) {
  const buckets = useMemo(() => scheduleBuckets(tasks, now), [tasks, now]);
  const nameOf = useMemo(() => {
    const map = new Map<string, string>();
    for (const member of members) map.set(member.user.id, member.user.displayName || member.user.username);
    return map;
  }, [members]);

  const [open, setOpen] = useState(false);

  if (buckets.length === 0) return null;

  return (
    <section
      data-testid="team-schedule"
      aria-label="近期要交的活"
      className="rounded-lg border border-line-soft bg-surface p-3"
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <h2 className="ui-title text-ui-sm">近期要交的活</h2>
        <p className="ui-caption" data-testid="schedule-summary">
          {describeSchedule(buckets)}
        </p>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="ml-auto"
          aria-expanded={open}
          aria-label={open ? "收起近期要交的活" : "展开近期要交的活"}
          onClick={() => setOpen(!open)}
        >
          {open ? "收起" : "展开"}
        </Button>
      </div>
      {open ? (
      <div className="mt-2 space-y-2">
        {buckets.map((bucket) => {
          const listed = bucket.tasks.slice(0, SCHEDULE_ROW_MAX);
          const rest = bucket.tasks.length - listed.length;
          return (
            <div key={bucket.key} data-testid={`schedule-bucket-${bucket.key}`}>
              <p className="flex flex-wrap items-baseline gap-x-2">
                <span className={`ui-caption font-medium ${BUCKET_TONE[bucket.key]}`}>
                  {bucket.label}（{bucket.tasks.length}）
                </span>
                <span className="ui-caption text-muted">{bucket.hint}</span>
              </p>
              <ul className="mt-1 space-y-0.5">
                {listed.map((task) => (
                  <li
                    key={task.id}
                    data-testid={`schedule-task-${task.id}`}
                    className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-ui-sm"
                  >
                    <span className="min-w-0 truncate">{task.title}</span>
                    {task.priority === "high" ? <span className="ui-caption text-danger">高</span> : null}
                    <span className="ui-caption text-muted">
                      {task.assigneeId ? nameOf.get(task.assigneeId) ?? task.assigneeId : "待认领"}
                    </span>
                    <span className="ui-caption text-muted">{STATUS_LABEL[task.status]}</span>
                    <span className="ml-auto ui-caption tabular-nums text-muted">{dueText(task, now)}</span>
                  </li>
                ))}
              </ul>
              {rest > 0 ? (
                <p className="mt-0.5 ui-caption text-muted">还有 {rest} 件，去任务板看全部。</p>
              ) : null}
            </div>
          );
        })}
      </div>
      ) : null}
    </section>
  );
}
