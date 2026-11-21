import { useCallback, useEffect, useMemo, useState } from "react";
import type { TeamItemStatus, TeamMember, TeamPlanItem, TeamTask, TeamTaskPriority } from "@heming/shared";
import { fetchWorkspaceTeam, updateTeamTask } from "../../lib/api.js";
import { isTeamLeader } from "../../lib/team/roles.js";
import { AsyncBoundary } from "../ui/AsyncBoundary.js";
import { EmptyState } from "../ui/EmptyState.js";
import { SkeletonCard } from "../ui/Skeleton.js";
import { Avatar } from "../Avatar.js";
import { Dialog } from "../ui/Dialog.js";
import { Button } from "../ui/Button.js";

/**
 * 真·任务看板（团队协作完善 1.2）：
 *
 * 旧的 `TeamBoardView` 读 `team_activities` 摘要、铺成「任务 / 日程」两列，
 * 不能拖卡也不能改状态——用户点进「看板」必然期待落空。这里改成读真正的
 * `team_tasks`（与工作台同一数据源 `GET /api/teams/:id`），按状态分列，
 * 支持拖拽流转，并复用收紧后的状态机（见 `updateTeamTask` 的 done_locked）。
 *
 * - 拖到「待验收」= 交活（status:done），不直接完成。
 * - 「已完成」（验收通过）列不可拖入：验收只能由组长在任务面板做。
 * - 已完成的任务不能拖回待认领/有卡点（绕过验收）：给出解释，不发请求。
 * - 本人可改自己名下/待认领的任务；组长可改全部（与服务端 forbidden 同口径）。
 */

type ColumnKey = "todo" | "doing" | "blocked" | "review" | "done";

const COLUMNS: { key: ColumnKey; label: string; hint: string }[] = [
  { key: "todo", label: "待开始", hint: "还没人动手" },
  { key: "doing", label: "进行中", hint: "正在做" },
  { key: "blocked", label: "有卡点", hint: "被前置或问题卡住" },
  { key: "review", label: "待验收", hint: "交上来了，等组长验收" },
  { key: "done", label: "已完成", hint: "组长验收通过" },
];

const PRIORITY_LABEL: Record<TeamTaskPriority, string> = {
  low: "低",
  normal: "",
  high: "高",
};

const STATUS_LABEL: Record<TeamItemStatus, string> = {
  todo: "待开始",
  doing: "进行中",
  done: "已完成",
  blocked: "有卡点",
};

const REVIEW_LABEL: Record<string, string> = {
  pending: "待验收",
  approved: "已验收",
  changes: "打回重做",
};

function fmtTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function columnOf(task: TeamTask): ColumnKey {
  if (task.status === "done") {
    return (task.reviewState ?? "pending") === "approved" ? "done" : "review";
  }
  return task.status as ColumnKey;
}

function isOverdue(task: TeamTask): boolean {
  if (!task.dueAt || task.status === "done") return false;
  return new Date(task.dueAt).getTime() < Date.now();
}

export interface TeamTaskBoardProps {
  teamId: string;
  members: TeamMember[];
  currentUserId: string | null;
  ownerId: string | null;
  /** 只读详情里的「到工作台处理」落点：由宿主切到工作台 Tab；不传则不显示该按钮。 */
  onOpenWorkbench?: () => void;
}

export function TeamTaskBoard({ teamId, members, currentUserId, ownerId, onOpenWorkbench }: TeamTaskBoardProps) {
  const [tasks, setTasks] = useState<TeamTask[]>([]);
  const [plans, setPlans] = useState<TeamPlanItem[]>([]);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [movingId, setMovingId] = useState<string | null>(null);
  const [memberFilter, setMemberFilter] = useState("");
  const [priorityFilter, setPriorityFilter] = useState<"all" | TeamTaskPriority>("all");
  const [planFilter, setPlanFilter] = useState("");
  const [overdueOnly, setOverdueOnly] = useState(false);
  const [query, setQuery] = useState("");
  /** 点卡片打开的只读详情（数据与列表同源，不发新请求、不改服务端）。 */
  const [detailId, setDetailId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!teamId) {
      setTasks([]);
      setPlans([]);
      setReady(true);
      return;
    }
    setError("");
    try {
      const snap = await fetchWorkspaceTeam(teamId);
      setTasks(snap.tasks);
      setPlans(snap.plans ?? []);
      setReady(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载任务失败");
      setReady(true);
    }
  }, [teamId]);

  useEffect(() => {
    // 切换工作组：筛选条件与打开的详情必须随团队重置（方案 1.2 验收），
    // 否则会把 A 队的负责人/方案筛选甚至详情，套到 B 队的新数据上。
    setMemberFilter("");
    setPriorityFilter("all");
    setPlanFilter("");
    setOverdueOnly(false);
    setQuery("");
    setDetailId(null);
    setNotice("");
    setReady(false);
    void load();
  }, [load]);

  /** 当前打开的详情任务（随列表刷新自动跟随最新数据；任务被删则自然消失）。 */
  const detailTask = tasks.find((t) => t.id === detailId) ?? null;

  const leader = isTeamLeader({ ownerId }, currentUserId);
  const nameOf = useCallback(
    (userId: string | null) =>
      userId ? (members.find((m) => m.user.id === userId)?.user.displayName ?? "成员") : "待认领",
    [members],
  );
  const canEdit = useCallback(
    (task: TeamTask) => leader || task.assigneeId === null || task.assigneeId === currentUserId,
    [leader, currentUserId],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return tasks.filter((t) => {
      if (memberFilter && t.assigneeId !== memberFilter) return false;
      if (priorityFilter !== "all" && (t.priority ?? "normal") !== priorityFilter) return false;
      // 方案筛选："__none__" = 只看独立任务；否则按 planId 精确匹配。
      if (planFilter === "__none__" ? t.planId !== null : planFilter && t.planId !== planFilter)
        return false;
      if (overdueOnly && !isOverdue(t)) return false;
      if (q && !t.title.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [tasks, memberFilter, priorityFilter, planFilter, overdueOnly, query]);

  const byColumn = useMemo(() => {
    const map: Record<ColumnKey, TeamTask[]> = {
      todo: [],
      doing: [],
      blocked: [],
      review: [],
      done: [],
    };
    for (const t of filtered) map[columnOf(t)].push(t);
    return map;
  }, [filtered]);

  /** 拖拽落下：把任务流转到目标列。所有状态改写都走 updateTeamTask，与工作台同一接口。 */
  const dropOn = async (taskId: string, target: ColumnKey) => {
    setNotice("");
    const task = tasks.find((t) => t.id === taskId);
    if (!task) return;
    if (!canEdit(task)) {
      setNotice("只能拖动自己名下或待认领的任务；别人的任务请让组长调整");
      return;
    }
    const from = columnOf(task);
    if (from === target) return;

    // 验收通过列不可拖入：只有组长能在任务面板验收通过。
    if (target === "done") {
      setNotice("「已完成」要靠组长验收通过，不能拖进来；交活请拖到「待验收」");
      return;
    }
    // 已完成任务不能拖回待认领/有卡点（绕过验收，服务端 done_locked 也会挡）。
    if (from === "done" || from === "review") {
      setNotice("已交的任务要重开，请让组长打回重做（会记下原因）；本人继续做可在工作台改回进行中");
      return;
    }
    const nextStatus: TeamItemStatus = target === "review" ? "done" : target;
    if (movingId) return;
    setMovingId(taskId);
    try {
      const updated = await updateTeamTask(teamId, taskId, { status: nextStatus });
      setTasks((prev) => prev.map((t) => (t.id === updated.id ? updated : t)));
      setNotice(target === "review" ? `「${updated.title}」已交上去，等组长验收` : "");
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "改状态失败");
    } finally {
      setMovingId(null);
    }
  };

  const onDragStart = (event: React.DragEvent, task: TeamTask) => {
    if (!canEdit(task)) {
      event.preventDefault();
      setNotice("只能拖动自己名下或待认领的任务");
      return;
    }
    event.dataTransfer.setData("text/plain", task.id);
    event.dataTransfer.effectAllowed = "move";
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b border-line-soft bg-subtle px-6 py-2.5">
        <div className="flex flex-wrap items-center gap-2 ui-caption">
          <input
            aria-label="搜索任务看板"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索任务…"
            className="w-[200px] rounded-md border border-line-strong px-2 py-1 ui-caption outline-hidden focus:border-ink"
          />
          <select
            aria-label="按负责人筛选看板"
            value={memberFilter}
            onChange={(e) => setMemberFilter(e.target.value)}
            className="rounded-md border border-line-strong bg-surface px-2 py-1 ui-caption"
          >
            <option value="">全部负责人</option>
            {members.map((m) => (
              <option key={m.user.id} value={m.user.id}>
                {m.user.displayName}
              </option>
            ))}
          </select>
          <div className="ui-segment-group" role="group" aria-label="优先级筛选">
            {(["all", "high", "normal", "low"] as const).map((p) => (
              <button
                key={p}
                type="button"
                aria-pressed={priorityFilter === p}
                onClick={() => setPriorityFilter(p)}
                className="ui-segment"
              >
                {p === "all" ? "全部优先级" : PRIORITY_LABEL[p]}
              </button>
            ))}
          </div>
          <select
            aria-label="按方案筛选看板"
            value={planFilter}
            onChange={(e) => setPlanFilter(e.target.value)}
            className="rounded-md border border-line-strong bg-surface px-2 py-1 ui-caption"
          >
            <option value="">全部方案</option>
            {plans.map((p) => (
              <option key={p.id} value={p.id}>
                {p.title}
              </option>
            ))}
            <option value="__none__">独立任务</option>
          </select>
          <button
            type="button"
            aria-pressed={overdueOnly}
            onClick={() => setOverdueOnly((v) => !v)}
            className={`ui-hit inline-flex min-h-8 items-center rounded-lg border px-2.5 py-1 ui-caption ${
              overdueOnly ? "border-danger bg-danger-soft text-danger" : "border-line bg-surface hover:bg-subtle-2"
            }`}
          >
            只看逾期
          </button>
          <button
            type="button"
            onClick={() => void load()}
            className="ui-hit inline-flex min-h-8 items-center rounded-lg border border-line bg-surface px-2.5 py-1 ui-caption hover:bg-subtle-2"
          >
            刷新
          </button>
        </div>
        <p className="mt-2 ui-micro">
          读真正的任务（与工作台同一份），拖动卡片改状态 · 交活拖到「待验收」，验收由组长做
        </p>
        {notice ? (
          <p role="status" className="mt-1 ui-caption text-warn">
            {notice}
          </p>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-6 py-5">
        <AsyncBoundary
          status={!ready ? "loading" : error ? "error" : "ready"}
          loadingLabel="正在加载任务"
          loadingClassName="grid gap-3 md:grid-cols-3 lg:grid-cols-5"
          loadingFallback={
            <>
              {[0, 1, 2].map((i) => (
                <SkeletonCard key={i} lines={3} className="h-40" />
              ))}
            </>
          }
          errorTitle={<>任务看板加载失败：{error}</>}
          onRetry={() => void load()}
          errorClassName="py-10"
        >
          {filtered.length === 0 ? (
            <EmptyState
              className="py-10"
              title={tasks.length === 0 ? "还没有任务。去工作台把目标拆成能派出去的一件事。" : "没有任务命中筛选。"}
            />
          ) : (
            <div className="grid gap-3 md:grid-cols-3 lg:grid-cols-5">
              {COLUMNS.map((col) => {
                const cards = byColumn[col.key];
                return (
                  <section
                    key={col.key}
                    aria-label={col.label}
                    className="flex min-h-[160px] flex-col rounded-lg border border-line-soft bg-subtle p-2"
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => {
                      e.preventDefault();
                      const id = e.dataTransfer.getData("text/plain");
                      if (id) void dropOn(id, col.key);
                    }}
                  >
                    <h2 className="mb-2 flex items-center justify-between px-1 ui-section-title">
                      <span>{col.label}</span>
                      <span className="ui-micro font-normal">{cards.length}</span>
                    </h2>
                    <p className="mb-2 px-1 ui-micro text-muted">{col.hint}</p>
                    <div className="flex flex-1 flex-col gap-1.5">
                      {cards.map((task) => {
                        const editable = canEdit(task);
                        const assignee = members.find((m) => m.user.id === task.assigneeId);
                        return (
                          <article
                            key={task.id}
                            data-testid={`board-card-${task.id}`}
                            draggable={editable}
                            onDragStart={(e) => onDragStart(e, task)}
                            title={editable ? "拖动改状态" : "别人的任务：只有本人或组长能改"}
                            className={`rounded-md border border-line-soft bg-surface p-2 ${
                              editable ? "cursor-grab" : "opacity-70"
                            } ${movingId === task.id ? "opacity-50" : ""}`}
                          >
                            <div className="flex items-start gap-1.5">
                              <button
                                type="button"
                                aria-label={`查看任务详情 ${task.title}`}
                                className="min-w-0 flex-1 truncate text-left text-ui-sm font-medium text-ink hover:underline"
                                onClick={() => setDetailId(task.id)}
                              >
                                {task.title}
                              </button>
                              {PRIORITY_LABEL[task.priority ?? "normal"] ? (
                                <span className="shrink-0 rounded-full bg-danger-soft px-1.5 text-ui-xs text-danger">
                                  高
                                </span>
                              ) : null}
                            </div>
                            <div className="mt-1.5 flex items-center gap-1.5 ui-micro text-muted">
                              {assignee ? (
                                <>
                                  <Avatar user={assignee.user} size={22} />
                                  <span className="truncate">{assignee.user.displayName}</span>
                                </>
                              ) : (
                                <span>待认领</span>
                              )}
                              {(task.blockedBy?.length ?? 0) > 0 ? (
                                <span title={`${task.blockedBy!.length} 个前置未完成`}>
                                  · 卡 {task.blockedBy!.length}
                                </span>
                              ) : null}
                            </div>
                            {task.planId ? (
                              <div
                                className="mt-1 truncate ui-micro text-muted"
                                title={`所属方案：${plans.find((p) => p.id === task.planId)?.title ?? "方案"}`}
                              >
                                方案 · {plans.find((p) => p.id === task.planId)?.title ?? "已关联"}
                              </div>
                            ) : null}
                            {task.dueAt ? (
                              <div
                                className={`mt-1 ui-micro ${isOverdue(task) ? "text-danger" : "text-muted"}`}
                              >
                                {isOverdue(task) ? "逾期 " : "截止 "}
                                {task.dueAt.slice(0, 10)}
                              </div>
                            ) : null}
                          </article>
                        );
                      })}
                      {cards.length === 0 ? (
                        <p className="px-1 py-3 ui-micro text-muted">空</p>
                      ) : null}
                    </div>
                  </section>
                );
              })}
            </div>
          )}
        </AsyncBoundary>
      </div>

      {detailTask ? (
        <Dialog
          ariaLabel="任务详情"
          title={detailTask.title}
          description={`${STATUS_LABEL[detailTask.status]}${detailTask.status === "done" ? ` · ${REVIEW_LABEL[detailTask.reviewState ?? "pending"]}` : ""} · ${PRIORITY_LABEL[detailTask.priority ?? "normal"] || "普通优先级"}`}
          size="md"
          onClose={() => setDetailId(null)}
        >
          <dl className="flex flex-col gap-2 text-ui-md">
            <div className="flex gap-2">
              <dt className="w-20 shrink-0 text-muted">负责人</dt>
              <dd className="min-w-0 flex-1">{nameOf(detailTask.assigneeId)}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-20 shrink-0 text-muted">所属方案</dt>
              <dd className="min-w-0 flex-1">
                {detailTask.planId ? (plans.find((p) => p.id === detailTask.planId)?.title ?? "—") : "独立任务"}
              </dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-20 shrink-0 text-muted">截止</dt>
              <dd className={`min-w-0 flex-1 ${isOverdue(detailTask) ? "text-danger" : ""}`}>
                {detailTask.dueAt ? `${fmtTime(detailTask.dueAt)}${isOverdue(detailTask) ? " · 已逾期" : ""}` : "没定"}
              </dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-20 shrink-0 text-muted">需求</dt>
              <dd className="min-w-0 flex-1 whitespace-pre-wrap">{detailTask.detail || "（无）"}</dd>
            </div>
            {detailTask.progress ? (
              <div className="flex gap-2">
                <dt className="w-20 shrink-0 text-muted">最新进展</dt>
                <dd className="min-w-0 flex-1 whitespace-pre-wrap">{detailTask.progress}</dd>
              </div>
            ) : null}
            {detailTask.result ? (
              <div className="flex gap-2">
                <dt className="w-20 shrink-0 text-muted">交付结论</dt>
                <dd className="min-w-0 flex-1 whitespace-pre-wrap">{detailTask.result}</dd>
              </div>
            ) : null}
            {detailTask.reviewNote ? (
              <div className="flex gap-2">
                <dt className="w-20 shrink-0 text-muted">验收备注</dt>
                <dd className="min-w-0 flex-1 whitespace-pre-wrap">{detailTask.reviewNote}</dd>
              </div>
            ) : null}
            {(detailTask.blockedBy?.length ?? 0) > 0 ? (
              <div className="flex gap-2">
                <dt className="w-20 shrink-0 text-muted">前置任务</dt>
                <dd className="min-w-0 flex-1">
                  {detailTask.blockedBy!.map((id) => tasks.find((t) => t.id === id)?.title ?? id).join("、")}
                </dd>
              </div>
            ) : null}
          </dl>
          <p className="mt-3 ui-micro text-muted">
            只读详情，数据与看板同源。验收、讨论等编辑请到工作台。
          </p>
          {onOpenWorkbench ? (
            <div className="mt-3 flex justify-end">
              <Button
                size="sm"
                variant="primary"
                onClick={() => {
                  setDetailId(null);
                  onOpenWorkbench();
                }}
              >
                到工作台处理 →
              </Button>
            </div>
          ) : null}
        </Dialog>
      ) : null}
    </div>
  );
}
