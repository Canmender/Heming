import { useMemo, useRef, useState } from "react";
import type {
  SharedFileMeta,
  TeamEvent,
  TeamItemStatus,
  TeamPlanItem,
  TeamTask,
  TeamTaskComment,
  TeamTaskPriority,
  WorkspaceTeamMember,
  TeamWorkspaceSnapshot,
} from "@heming/shared";
import {
  createTeamTask,
  createTeamTaskComment,
  deleteTeamTask,
  fetchFiles,
  fetchTeamEvents,
  fetchTeamTaskComments,
  fetchWorkspaceTeam,
  updateTeamTask,
  uploadFile,
} from "../../lib/api.js";
import { NEXT_STATUS } from "./TeamPlanPanel.js";
import { ConfirmDialog } from "../ConfirmDialog.js";
import { fmtLocalDateTime, isOverdue } from "../../lib/format/datetime.js";
import { matchesTaskQuery } from "../../lib/team/findTasks.js";
import { Button } from "../../components/ui/Button.js";
import {
  assigneeAgentHint,
  isTeamLeader,
  LEADER_ASSIGN_HINT,
  memberLabel,
} from "../../lib/team/roles.js";
import { describeTaskResult } from "../../lib/team/taskResult.js";
import {
  assigneeFilterLabel,
  groupTasksByAssignee,
  UNASSIGNED_GROUP,
} from "../../lib/team/assigneeGroups.js";
import { describeTaskAge, taskAge } from "../../lib/team/taskAge.js";

/** 优先级（d.268）：三档就够用，多了没人填、也没人看。 */
const PRIORITY_LABEL: Record<TeamTaskPriority, string> = { low: "低", normal: "普通", high: "高" };
const PRIORITIES: TeamTaskPriority[] = ["low", "normal", "high"];

/** 验收状态（d.272）：只有已完成的任务才有意义；老任务缺省 pending。 */
const REVIEW_LABEL: Record<string, string> = {
  pending: "待验收",
  approved: "已验收",
  changes: "打回重做",
};

const STATUS_LABEL: Record<TeamItemStatus, string> = {
  todo: "待开始",
  doing: "进行中",
  done: "已完成",
  blocked: "有卡点",
};

const STATUS_STYLE: Record<TeamItemStatus, string> = {
  todo: "border-line text-muted",
  doing: "border-info-line bg-info-soft text-info",
  done: "border-success-line bg-success-soft text-success",
  blocked: "border-warn-line bg-warn-soft text-warn",
};

/** 任务筛选：默认看未完成的（完成的多起来会淹掉真正要做的）。 */
type TaskFilter = "open" | "all" | "done" | "review";

/**
 * 团队任务（d.92）：创建 / 指派 / 改状态 / 上传交付物。
 *
 * 交付物直接复用共享文件库：上传后把 fileId 记在任务上（服务端只存 id，
 * 文件本体仍走既有配额与预览链路），不需要为团队再造一套存储。
 * 所有写操作都有 `team_task_*` 工具对应，智能体可以代劳（会先让用户确认）。
 */
export function TeamTaskPanel({
  teamId,
  viewerId,
  ownerId,
  plans,
  members,
  tasks,
  busy,
  onChanged,
  onError,
}: {
  teamId: string;
  /** 当前用户 id（d.249）：用来判断“我是不是组长”。不传时不做限制（旧用法/单测）。 */
  viewerId?: string;
  /** 团队创建者 id（d.249）：创建者即组长。 */
  ownerId?: string;
  plans: TeamPlanItem[];
  members: WorkspaceTeamMember[];
  tasks: TeamTask[];
  busy: boolean;
  onChanged: (snapshot: TeamWorkspaceSnapshot) => void;
  /** 面板内的失败同时上报给页级错误条（WIP 里 TeamWorkspace 已经在传，这里补上类型与调用）。 */
  onError?: (message: string) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");
  const [detail, setDetail] = useState("");
  const [assigneeId, setAssigneeId] = useState("");
  const [planId, setPlanId] = useState("");
  const [dueAt, setDueAt] = useState("");
  /** 这条任务要等哪条先做完（d.255）：单选，存前置任务 id。 */
  const [blockedBy, setBlockedBy] = useState("");
  /** 优先级（d.268）：默认普通；只有真要插队的活才手动标高。 */
  const [priority, setPriority] = useState<TeamTaskPriority>("normal");
  const [uploading, setUploading] = useState(false);
  const [attachment, setAttachment] = useState<SharedFileMeta | null>(null);
  const [filter, setFilter] = useState<TaskFilter>("open");
  /** 按人看（d.250）：点一下成员 chip 就只看他的任务；null = 不筛。 */
  const [assigneeFilter, setAssigneeFilter] = useState<string | null>(null);
  /** 关键词（d.266）：任务多了以后，界面上也要能像智能体一样「找活」。 */
  const [query, setQuery] = useState("");
  // 退回（d.261）：做不了的人把它装回待认领池，并留一句为什么。
  const [returningId, setReturningId] = useState<string | null>(null);
  const [returnNoteDraft, setReturnNoteDraft] = useState("");
  /** 讨论（d.271）：展开哪条任务的讨论、各自的留言、输入里的草稿。 */
  const [commentTaskId, setCommentTaskId] = useState<string | null>(null);
  const [comments, setComments] = useState<Record<string, TeamTaskComment[]>>({});
  const [commentDraft, setCommentDraft] = useState("");
  const [commentBusy, setCommentBusy] = useState(false);
  const [commentError, setCommentError] = useState("");
  /** 单件任务的历史（d.276）：团队动态是全队流水，这里只看这一条活。 */
  const [historyTaskId, setHistoryTaskId] = useState<string | null>(null);
  const [history, setHistory] = useState<Record<string, TeamEvent[]>>({});
  const [historyError, setHistoryError] = useState("");
  /** 验收（d.272）：正在给哪条已完成的任务写验收意见，以及草稿。 */
  const [reviewingId, setReviewingId] = useState<string | null>(null);
  const [reviewNoteDraft, setReviewNoteDraft] = useState("");
  /**
   * 组长口径（d.249）：只有组长能把任务派给别人。
   * 未传 viewerId/ownerId 时不做限制——旧调用方与单测因此不受影响；
   * 真机上一律由 TeamWorkspace 传全（它与服务端 not_leader 是同一件事）。
   */
  const leader =
    viewerId === undefined || ownerId === undefined
      ? true
      : isTeamLeader({ ownerId }, viewerId);
  const canAssignTo = (userId: string) => leader || userId === viewerId;
  /**
   * 任务级权限（d.254）：成员只能动「自己名下」和「还没人认领」的任务。
   * 与服务端 updateTeamTask / deleteTeamTask 的 forbidden 是同一件事——界面先挡住，
   * 免得点下去才看到 403；组长不受限（要能替人收尾）。
   */
  const canTouch = (task: TeamTask) =>
    leader || task.assigneeId === null || task.assigneeId === viewerId;
  const touchHint = (task: TeamTask) =>
    canTouch(task) ? undefined : "这是别人名下的任务：只有本人或组长能改";
  /** 待删除任务：先出应用内确认框，确认后才真的发请求（取消不发）。 */
  const [pendingDelete, setPendingDelete] = useState<TeamTask | null>(null);
  /** 打开确认框时焦点落在「取消」：误按回车不会执行破坏性操作。 */
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  /**
   * 面板自己的错误：就地显示在任务卡片里，而不是只写到页顶（W-06）。
   * 关闭按钮或下一次成功提交时清掉，避免一次失败长期挂在那里。
   */
  const [panelError, setPanelError] = useState("");
  /** 创建任务的提交中标记：双击「发布任务」只允许发一次请求（W-04）。 */
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  /**
   * 正在改状态/指派/交付物/删除的任务 id。
   *
   * 用 ref 做同步判定：两次点击可能发生在同一帧内（state 还没重渲染），
   * 只靠 state 会让第二次点击仍按旧闭包再发一遍请求。state 只负责把按钮禁用掉。
   */
  const [pendingIds, setPendingIds] = useState<string[]>([]);
  const pendingRef = useRef(new Set<string>());
  /**
   * 点击时从这里取「最新一次 props」里的任务，而不是渲染时捕获的旧对象：
   * 45s 轮询/写操作刷新都可能已经把状态推到了下一档，用旧 prop 会把状态推错。
   */
  const tasksRef = useRef(tasks);
  tasksRef.current = tasks;

  const isPending = (id: string) => pendingIds.includes(id);

  const beginPending = (id: string) => {
    if (pendingRef.current.has(id)) return false;
    pendingRef.current.add(id);
    setPendingIds([...pendingRef.current]);
    return true;
  };

  const endPending = (id: string) => {
    pendingRef.current.delete(id);
    setPendingIds([...pendingRef.current]);
  };

  const planName = useMemo(
    () => new Map(plans.map((p) => [p.id, p.title])),
    [plans],
  );
  const memberName = useMemo(
    () => new Map(members.map((m) => [m.user.id, m.user.displayName])),
    [members],
  );

  /** 展开/收起一条任务的历史（第一次展开才去拉，只取这一条活的流水）。 */
  const toggleHistory = async (item: TeamTask) => {
    if (historyTaskId === item.id) {
      setHistoryTaskId(null);
      return;
    }
    setHistoryTaskId(item.id);
    setHistoryError("");
    if (history[item.id] !== undefined) return;
    try {
      const data = await fetchTeamEvents(teamId, undefined, 20, item.id);
      setHistory((prev) => ({ ...prev, [item.id]: data.events }));
    } catch (error) {
      setHistoryError(error instanceof Error ? error.message : "历史没加载出来，稍后再试。");
    }
  };

  /** 展开/收起一条任务的讨论（第一次展开才去拉）。 */
  const toggleComments = async (item: TeamTask) => {
    if (commentTaskId === item.id) {
      setCommentTaskId(null);
      return;
    }
    setCommentTaskId(item.id);
    setCommentDraft("");
    setCommentError("");
    if (comments[item.id] !== undefined) return;
    try {
      const res = await fetchTeamTaskComments(teamId, item.id);
      setComments((prev) => ({ ...prev, [item.id]: res.comments }));
    } catch (error) {
      setCommentError(error instanceof Error ? error.message : "讨论没加载出来，稍后再试。");
    }
  };

  /** 发一句留言（追加，不覆盖别人的话）。 */
  const sendComment = async (item: TeamTask) => {
    const text = commentDraft.trim();
    if (text === "" || commentBusy) return;
    setCommentBusy(true);
    setCommentError("");
    try {
      const created = await createTeamTaskComment(teamId, item.id, text);
      setComments((prev) => ({ ...prev, [item.id]: [...(prev[item.id] ?? []), created] }));
      setCommentDraft("");
    } catch (error) {
      setCommentError(error instanceof Error ? error.message : "留言没发出去，稍后再试。");
    } finally {
      setCommentBusy(false);
    }
  };

  const shown = useMemo(() => {
    const base =
      filter === "all"
        ? tasks
        : filter === "done"
          ? tasks.filter((t) => t.status === "done")
          : filter === "review"
            ? // 待验收（d.275）：交上来、还没人看过的那些——组长进来直接看这一档。
              tasks.filter((t) => t.status === "done" && t.reviewState === "pending")
            : tasks.filter((t) => t.status !== "done");
    const byAssignee =
      assigneeFilter === null
        ? base
        : assigneeFilter === UNASSIGNED_GROUP
          ? base.filter((t) => !t.assigneeId)
          : base.filter((t) => t.assigneeId === assigneeFilter);
    const keyword = query.trim();
    return keyword === "" ? byAssignee : byAssignee.filter((t) => matchesTaskQuery(t, keyword));
  }, [tasks, filter, assigneeFilter, query]);

  const refresh = async () => onChanged(await fetchWorkspaceTeam(teamId));

  const resetDraft = () => {
    setTitle("");
    setDetail("");
    setAssigneeId("");
    setPlanId("");
    setDueAt("");
    setAttachment(null);
    setBlockedBy("");
    setPriority("normal");
  };

  /** 面板内的失败：既就地显示在任务卡片里，也上报给页级错误条。 */
  const report = (message: string) => {
    setPanelError(message);
    onError?.(message);
  };

  const onPickFile = async (file: File | null) => {
    if (!file) return;
    setUploading(true);
    setPanelError("");
    try {
      const meta = await uploadFile(file);
      setAttachment(meta);
    } catch (err) {
      report(err instanceof Error && err.message ? err.message : "上传失败");
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const add = async () => {
    const clean = title.trim();
    if (!clean) {
      report("请填写任务标题");
      return;
    }
    // 服务端没有创建任务的幂等键：重复提交会真的多出一条任务（W-04）。
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setPanelError("");
    try {
      await createTeamTask(teamId, {
        title: clean,
        detail: detail.trim() || undefined,
        assigneeId: assigneeId || null,
        planId: planId || null,
        dueAt: dueAt ? new Date(dueAt).toISOString() : null,
        ...(blockedBy ? { blockedBy: [blockedBy] } : {}),
        ...(attachment ? { attachmentFileId: attachment.id } : {}),
        priority,
      });
      resetDraft();
      setAdding(false);
      await refresh();
    } catch (err) {
      report(err instanceof Error && err.message ? err.message : "创建任务失败");
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const cycle = async (task: TeamTask) => {
    if (!beginPending(task.id)) return;
    setPanelError("");
    try {
      // 用最新 props 里的状态算下一档；连点第二下在 pending 期间被忽略，只前进一档。
      const latest = tasksRef.current.find((t) => t.id === task.id) ?? task;
      await updateTeamTask(teamId, task.id, { status: NEXT_STATUS[latest.status] });
      await refresh();
    } catch (err) {
      report(err instanceof Error && err.message ? err.message : "更新任务失败");
    } finally {
      endPending(task.id);
    }
  };

  const setTaskPriority = async (task: TeamTask, next: TeamTaskPriority) => {
    if (!beginPending(task.id)) return;
    setPanelError("");
    try {
      await updateTeamTask(teamId, task.id, { priority: next });
      await refresh();
    } catch (err) {
      report(err instanceof Error && err.message ? err.message : "改优先级失败");
    } finally {
      endPending(task.id);
    }
  };

  const assign = async (task: TeamTask, nextAssignee: string) => {
    if (!beginPending(task.id)) return;
    setPanelError("");
    try {
      await updateTeamTask(teamId, task.id, { assigneeId: nextAssignee || null });
      await refresh();
    } catch (err) {
      report(err instanceof Error && err.message ? err.message : "指派失败");
    } finally {
      endPending(task.id);
    }
  };

  /** 退回：负责人清空 = 回到待认领；原因写进 return_note，组长在任务板上一眼看到。 */
  const returnTask = async (task: TeamTask) => {
    if (!beginPending(task.id)) return;
    setPanelError("");
    try {
      const note = returnNoteDraft.trim();
      await updateTeamTask(teamId, task.id, {
        assigneeId: null,
        ...(note ? { returnNote: note } : {}),
      });
      setReturningId(null);
      setReturnNoteDraft("");
      await refresh();
    } catch (err) {
      report(err instanceof Error && err.message ? err.message : "退回任务失败");
    } finally {
      endPending(task.id);
    }
  };

  /** 验收（d.272）：通过只打标；打回必须带原因，任务会回到进行中。 */
  const review = async (task: TeamTask, verdict: "approve" | "changes") => {
    const note = reviewNoteDraft.trim();
    if (verdict === "changes" && note === "") {
      report("打回重做要写一句原因，让做的人知道要改什么");
      return;
    }
    if (!beginPending(task.id)) return;
    setPanelError("");
    try {
      await updateTeamTask(teamId, task.id, {
        review: verdict,
        ...(note ? { reviewNote: note } : {}),
      });
      setReviewingId(null);
      setReviewNoteDraft("");
      await refresh();
    } catch (err) {
      report(err instanceof Error && err.message ? err.message : "验收失败");
    } finally {
      endPending(task.id);
    }
  };

  const attach = async (task: TeamTask, file: File | null) => {
    if (!file) return;
    if (!beginPending(task.id)) return;
    setUploading(true);
    setPanelError("");
    try {
      const meta = await uploadFile(file);
      await updateTeamTask(teamId, task.id, { attachmentFileId: meta.id });
      await refresh();
    } catch (err) {
      report(err instanceof Error && err.message ? err.message : "上传交付物失败");
    } finally {
      setUploading(false);
      endPending(task.id);
    }
  };

  const remove = async (task: TeamTask) => {
    if (!beginPending(task.id)) return;
    setPanelError("");
    try {
      await deleteTeamTask(teamId, task.id);
      await refresh();
    } catch (err) {
      report(err instanceof Error ? err.message : "删除任务失败");
    } finally {
      endPending(task.id);
    }
  };

  const confirmRemove = async () => {
    const task = pendingDelete;
    if (!task) return;
    setPendingDelete(null);
    await remove(task);
  };

  /** 多久没动（d.251）：按自然日算，未完成且超过 3 天就标出来；一次算好，渲染时只查表。 */
  const ageNotes = useMemo(() => {
    const now = Date.now();
    const map = new Map<string, { text: string; stale: boolean }>();
    for (const task of tasks) {
      const text = describeTaskAge(task, now);
      if (text !== null) map.set(task.id, { text, stale: taskAge(task, now).stale });
    }
    return map;
  }, [tasks]);

  /** 完成结论：只在任务真的完成过时才有内容（d.252），一次算好避免逐行重复计算。 */
  const resultNotes = useMemo(() => {
    const map = new Map<string, { text: string; full: string }>();
    for (const task of tasks) {
      const note = describeTaskResult(task, {
        who: task.assigneeId ? (memberName.get(task.assigneeId) ?? null) : null,
        completedText: task.completedAt ? fmtLocalDateTime(task.completedAt) : null,
      });
      if (note !== null) map.set(task.id, note);
    }
    return map;
  }, [tasks, memberName]);

  /** 前置任务（d.255）：把 id 换成标题，并标出前置是否已经做完；一次算好。 */
  const blockerNotes = useMemo(() => {
    const byId = new Map(tasks.map((task) => [task.id, task]));
    const map = new Map<string, { text: string; open: boolean }>();
    for (const task of tasks) {
      const ids = task.blockedBy ?? [];
      if (ids.length === 0) continue;
      const deps = ids.map((id) => byId.get(id)).filter((dep): dep is TeamTask => dep !== undefined);
      if (deps.length === 0) continue;
      const openDeps = deps.filter((dep) => dep.status !== "done");
      const names = deps.map((dep) => `「${dep.title}」`).join("、");
      map.set(task.id, {
        text: openDeps.length > 0 ? `等${names}做完` : `前置${names}已完成`,
        open: openDeps.length > 0,
      });
    }
    return map;
  }, [tasks]);

  /** 可以当前置的任务：没做完的其它任务。 */
  const blockerOptions = useMemo(() => tasks.filter((task) => task.status !== "done"), [tasks]);

  /** 退回痕迹（d.261）：谁退的、为什么、什么时候；再次认领会清空。 */
  const returnNotes = useMemo(() => {
    const map = new Map<string, { text: string; full: string }>();
    for (const task of tasks) {
      if (!task.returnedAt) continue;
      const who = (task.returnedBy ? memberName.get(task.returnedBy) : null) ?? "有人";
      const note = (task.returnNote ?? "").trim();
      const full = `${who} 退回过：${note || "（没写原因）"}（${fmtLocalDateTime(task.returnedAt)}）`;
      map.set(task.id, { text: full, full });
    }
    return map;
  }, [tasks, memberName]);

  /** 最新进展（d.262）：做到哪、卡在哪；与结果、退回痕迹分开显示。 */
  const progressNotes = useMemo(() => {
    const map = new Map<string, string>();
    for (const task of tasks) {
      const note = (task.progress ?? "").trim();
      if (!task.progressAt || note === "") continue;
      const who = (task.progressBy ? memberName.get(task.progressBy) : null) ?? "有人";
      map.set(task.id, `进展（${who}，${fmtLocalDateTime(task.progressAt)}）：${note}`);
    }
    return map;
  }, [tasks, memberName]);

  /** 分组用全量任务算：切「已完成」时也要看得出谁手上还有活。 */
  /** 催办痕迹（d.265）：谁催的、什么时候、催了几次。 */
  const nudgeNotes = useMemo(() => {
    const map = new Map<string, string>();
    for (const task of tasks) {
      const count = task.nudgeCount ?? 0;
      if (!task.nudgedAt || count <= 0) continue;
      const who = (task.nudgedBy ? memberName.get(task.nudgedBy) : null) ?? "有人";
      map.set(task.id, `催过 ${count} 次（最近一次：${who}，${fmtLocalDateTime(task.nudgedAt)}）`);
    }
    return map;
  }, [tasks, memberName]);

  const groups = useMemo(
    () => groupTasksByAssignee(tasks, members, ownerId ?? null, Date.now()),
    [tasks, members, ownerId],
  );

  return (
    <section aria-label="团队任务" className="ui-card p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="ui-block-title">任务</h2>
        <span className="ui-micro">{tasks.length}</span>
        <div className="ml-auto flex items-center gap-1" role="group" aria-label="任务筛选">
          {(
            [
              ["open", "未完成"],
    ["review", "待验收"],
              ["all", "全部"],
              ["done", "已完成"],
            ] as [TaskFilter, string][]
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              aria-pressed={filter === key}
              onClick={() => setFilter(key)}
              className={`rounded-md px-2 py-0.5 text-ui-xs ${
                filter === key ? "bg-subtle-4 text-ink" : "text-muted hover:bg-subtle-2"
              }`}
            >
              {label}
            </button>
          ))}
          <button
            type="button"
            className="ui-link ml-2"
            onClick={() => setAdding((v) => !v)}
          >
            {adding ? "取消" : "派任务"}
          </button>
        </div>
      </div>

      {groups.length > 0 && (
        <div
          data-testid="task-assignee-chips"
          className="mt-2 flex flex-wrap items-center gap-1"
          role="group"
          aria-label="按成员看任务"
        >
          <span className="text-ui-xs text-muted">按人看：</span>
          {groups.map((group) => {
            const active = assigneeFilter === group.key;
            return (
              <button
                key={group.key}
                type="button"
                aria-pressed={active}
                data-testid={`task-assignee-${group.role}`}
                onClick={() => setAssigneeFilter(active ? null : group.key)}
                className={`rounded-full border px-2 py-0.5 text-ui-xs ${
                  active
                    ? "border-accent-line bg-accent-soft text-accent"
                    : group.overdueCount > 0
                      ? "border-danger-line bg-danger-soft text-danger"
                      : "border-line text-muted hover:bg-subtle-2"
                }`}
              >
                {assigneeFilterLabel(group)}
              </button>
            );
          })}
          {assigneeFilter !== null && (
            <button
              type="button"
              className="ui-link ml-1"
              onClick={() => setAssigneeFilter(null)}
            >
              显示全部
            </button>
          )}
        </div>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <input
          type="search"
          data-testid="task-search"
          aria-label="按关键词找任务"
          placeholder="按关键词找任务（标题 / 需求 / 结论 / 进展）"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="ui-input min-w-0 flex-1"
        />
        {query.trim() !== "" && (
          <button type="button" className="ui-link" onClick={() => setQuery("")}>
            清空
          </button>
        )}
      </div>

      {query.trim() !== "" && (
        <p data-testid="task-search-count" className="mt-1 ui-caption">
          {shown.length === 0
            ? `没有任务命中「${query.trim()}」；换个关键词，或把上面的筛选放宽。`
            : `命中 ${shown.length} 条（当前筛选下共 ${tasks.length} 条）。`}
        </p>
      )}

      {panelError && (
        <p
          role="alert"
          className="mt-2 flex items-start gap-2 rounded-lg border border-danger-line bg-danger-soft px-2.5 py-2 text-ui-sm text-danger"
        >
          <span className="min-w-0 flex-1 break-words">{panelError}</span>
          <button
            type="button"
            className="shrink-0 text-ui-xs underline"
            onClick={() => setPanelError("")}
          >
            关闭
          </button>
        </p>
      )}

      {adding && (
        <form
          className="mt-2 flex flex-col gap-1.5 rounded-lg border border-line-soft p-2.5"
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
        >
          <input
            aria-label="任务标题"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="任务标题（如：产出本周周报初稿）"
            className="ui-input w-full"
          />
          <textarea
            aria-label="任务说明"
            value={detail}
            onChange={(e) => setDetail(e.target.value)}
            placeholder="要做什么、交付标准（可选）"
            rows={2}
            className="ui-input w-full resize-y"
          />
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-1 text-ui-xs text-muted">
              指给
              <select
                aria-label="任务负责人"
                value={assigneeId}
                onChange={(e) => setAssigneeId(e.target.value)}
                className="ui-input w-auto"
              >
                <option value="">待认领</option>
                {members.map((m) => (
                  <option
                    key={m.user.id}
                    value={m.user.id}
                    disabled={!canAssignTo(m.user.id)}
                  >
                    {memberLabel(
                      { id: m.user.id, displayName: m.user.displayName },
                      ownerId ? { ownerId } : null,
                    )}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-1 text-ui-xs text-muted">
              归属方案
              <select
                aria-label="归属方案"
                value={planId}
                onChange={(e) => setPlanId(e.target.value)}
                className="ui-input w-auto"
              >
                <option value="">不挂方案</option>
                {plans.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.title}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-1 text-ui-xs text-muted">
              前置
              <select
                aria-label="前置任务"
                value={blockedBy}
                onChange={(e) => setBlockedBy(e.target.value)}
                className="ui-input w-auto max-w-[180px]"
              >
                <option value="">无前置</option>
                {blockerOptions.map((task) => (
                  <option key={task.id} value={task.id}>
                    {task.title}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-1 text-ui-xs text-muted">
              优先级
              <select
                aria-label="任务优先级"
                data-testid="task-priority"
                value={priority}
                onChange={(e) => setPriority(e.target.value as TeamTaskPriority)}
                className="ui-input w-auto"
              >
                {PRIORITIES.map((item) => (
                  <option key={item} value={item}>
                    {PRIORITY_LABEL[item]}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-1 text-ui-xs text-muted">
              截止
              <input
                aria-label="任务截止时间"
                type="datetime-local"
                value={dueAt}
                onChange={(e) => setDueAt(e.target.value)}
                className="ui-input w-auto"
              />
            </label>
            <label className="flex items-center gap-1 text-ui-xs text-muted">
              <input
                ref={fileRef}
                type="file"
                aria-label="上传任务交付物"
                className="hidden"
                onChange={(e) => void onPickFile(e.target.files?.[0] ?? null)}
              />
              <Button
                type="button"
                size="sm" variant="ghost"
                disabled={uploading}
                onClick={() => fileRef.current?.click()}
              >
                {uploading ? "上传中…" : attachment ? "换一个交付物" : "上传交付物"}
              </Button>
            </label>
            {attachment && (
              <span className="ui-caption truncate">已选：{attachment.name}</span>
            )}
          </div>
          {leader ? null : (
            <p data-testid="team-assign-hint" className="text-ui-xs text-muted">
              {LEADER_ASSIGN_HINT}
            </p>
          )}
          <Button type="submit" size="sm" variant="primary" className="self-start" disabled={busy || uploading || saving}>
            {saving ? "发布中…" : "发布任务"}
          </Button>
        </form>
      )}

      {shown.length === 0 ? (
        <p className="mt-2 ui-caption">
          {tasks.length === 0
            ? "还没有任务。把目标拆成能派出去的一件事，指定负责人即可。"
            : query.trim() !== ""
              ? "没有任务命中这个关键词。"
              : "这个筛选下没有任务。"}
        </p>
      ) : (
        <ul className="mt-2 flex flex-col gap-1.5">
          {shown.map((task) => (
            <li key={task.id} className="rounded-lg border border-line-soft px-2.5 py-2">
              <div className="flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => void cycle(task)}
                  disabled={isPending(task.id) || !canTouch(task)}
                  title={
                    touchHint(task) ??
                    (blockerNotes.get(task.id)?.open
                      ? `前置还没完成：${blockerNotes.get(task.id)!.text}`
                      : "点击切换状态")
                  }
                  className={`rounded-full border px-1.5 py-0.5 text-ui-xs ${STATUS_STYLE[task.status]} ${
                    isPending(task.id) ? "opacity-60" : ""
                  }`}
                >
                  {STATUS_LABEL[task.status]}
                </button>
                {task.priority === "high" ? (
                  <span
                    data-testid="task-priority-high"
                    className="shrink-0 rounded-full bg-danger-soft px-1.5 py-0.5 text-ui-xs text-danger"
                    title="高优先级：先做这件"
                  >
                    高
                  </span>
                ) : null}
                {task.status === "done" ? (
                  <span
                    data-testid="task-review-state"
                    className={`shrink-0 rounded-full px-1.5 py-0.5 text-ui-xs ${
                      (task.reviewState ?? "pending") === "approved"
                        ? "bg-success-soft text-success"
                        : (task.reviewState ?? "pending") === "changes"
                          ? "bg-warn-soft text-warn"
                          : "bg-subtle-2 text-muted"
                    }`}
                    title={task.reviewNote || undefined}
                  >
                    {REVIEW_LABEL[task.reviewState ?? "pending"] ?? "待验收"}
                  </span>
                ) : null}
                <span className="min-w-0 flex-1 truncate text-ui-md font-medium">{task.title}</span>
                <select
                  aria-label={`任务优先级 ${task.title}`}
                  data-testid={`task-priority-${task.id}`}
                  value={task.priority ?? "normal"}
                  disabled={isPending(task.id) || !canTouch(task)}
                  title={touchHint(task) ?? "调整轻重缓急"}
                  onChange={(e) => void setTaskPriority(task, e.target.value as TeamTaskPriority)}
                  className="ui-input w-auto shrink-0 py-0.5 text-ui-xs"
                >
                  {PRIORITIES.map((item) => (
                    <option key={item} value={item}>
                      {PRIORITY_LABEL[item]}
                    </option>
                  ))}
                </select>
                <label className="flex shrink-0 items-center gap-1 text-ui-xs text-muted">
                  负责
                  <select
                    aria-label={`任务负责人 ${task.title}`}
                    value={task.assigneeId ?? ""}
                    disabled={isPending(task.id) || !canTouch(task)}
                    title={touchHint(task)}
                    onChange={(e) => void assign(task, e.target.value)}
                    className="ui-input w-auto py-0.5 text-ui-xs"
                  >
                    <option value="">待认领</option>
                    {members.map((m) => (
                      <option
                        key={m.user.id}
                        value={m.user.id}
                        disabled={!canAssignTo(m.user.id)}
                      >
                        {memberLabel(
                          { id: m.user.id, displayName: m.user.displayName },
                          ownerId ? { ownerId } : null,
                        )}
                      </option>
                    ))}
                  </select>
                </label>
                {task.assigneeId !== null && task.status !== "done" && canTouch(task) ? (
                  <button
                    type="button"
                    aria-label={`退回任务 ${task.title}`}
                    className="shrink-0 text-ui-xs text-muted hover:text-warn disabled:opacity-60"
                    disabled={isPending(task.id)}
                    title="做不了就把这条退回待认领，并说明原因"
                    onClick={() => {
                      setReturningId((prev) => (prev === task.id ? null : task.id));
                      setReturnNoteDraft("");
                    }}
                  >
                    退回
                  </button>
                ) : null}
                <button
                  type="button"
                  aria-label={`任务讨论 ${task.title}`}
                  aria-expanded={commentTaskId === task.id}
                  className="shrink-0 text-ui-xs text-muted hover:text-ink"
                  title="在这里问口径、补约束；留言只追加，谁也不能改别人写的话"
                  onClick={() => void toggleComments(task)}
                >
                  讨论
                </button>
                <button
                  type="button"
                  aria-label={`任务历史 ${task.title}`}
                  aria-expanded={historyTaskId === task.id}
                  className="shrink-0 text-ui-xs text-muted hover:text-ink"
                  title="看这件活自己的流水：谁改过状态、谁催的、谁打回的、谁验收的"
                  onClick={() => void toggleHistory(task)}
                >
                  历史
                </button>
                <button
                  type="button"
                  aria-label={`删除任务 ${task.title}`}
                  className="shrink-0 text-ui-xs text-muted hover:text-danger disabled:opacity-60"
                  disabled={isPending(task.id) || !canTouch(task)}
                  title={touchHint(task)}
                  onClick={() => setPendingDelete(task)}
                >
                  删除
                </button>
              </div>
              {returningId === task.id ? (
                <div data-testid="task-return-form" className="mt-1 flex flex-wrap items-start gap-1.5">
                  <textarea
                    aria-label={`退回原因 ${task.title}`}
                    value={returnNoteDraft}
                    onChange={(e) => setReturnNoteDraft(e.target.value)}
                    rows={2}
                    maxLength={500}
                    placeholder="为什么做不了（权限不够 / 信息不足 / 不归你）——组长会看到这句"
                    className="ui-input min-w-0 flex-1 py-1 text-ui-xs"
                  />
                  <Button type="button" size="sm" variant="primary" disabled={isPending(task.id)} onClick={() => void returnTask(task)}>
                    确认退回
                  </Button>
                  <Button type="button" size="sm" variant="ghost" onClick={() => setReturningId(null)}>
                    取消
                  </Button>
                </div>
              ) : null}
              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 ui-caption">
                {task.planId && planName.get(task.planId) ? (
                  <span>方案：{planName.get(task.planId)}</span>
                ) : null}
                {task.assigneeId && memberName.get(task.assigneeId) ? (
                  <>
                    <span>负责人：{memberName.get(task.assigneeId)}</span>
                    <span data-testid="assignee-agent-hint" className="text-muted">
                      {assigneeAgentHint(memberName.get(task.assigneeId) ?? "")}
                    </span>
                  </>
                ) : (
                  <span>待认领</span>
                )}
                {blockerNotes.get(task.id) ? (
                  <span
                    data-testid="task-blocked-by"
                    data-open={blockerNotes.get(task.id)!.open ? "true" : "false"}
                    className={
                      blockerNotes.get(task.id)!.open
                        ? "rounded-full bg-warn-soft px-1.5 text-warn"
                        : "text-muted"
                    }
                  >
                    {blockerNotes.get(task.id)!.text}
                  </span>
                ) : null}
                {ageNotes.get(task.id) ? (
                  <span
                    data-testid="task-age"
                    className={
                      ageNotes.get(task.id)!.stale ? "rounded-full bg-warn-soft px-1.5 text-warn" : undefined
                    }
                  >
                    {ageNotes.get(task.id)!.text}
                  </span>
                ) : null}
                {nudgeNotes.get(task.id) ? (
                  <span
                    data-testid="task-nudged"
                    className="w-full rounded-full bg-warn-soft px-1.5 text-warn"
                  >
                    {nudgeNotes.get(task.id)}
                  </span>
                ) : null}
                {returnNotes.get(task.id) ? (
                  <span
                    data-testid="task-returned"
                    className="w-full rounded-full bg-warn-soft px-1.5 text-warn"
                    title={returnNotes.get(task.id)!.full}
                  >
                    {returnNotes.get(task.id)!.text}
                  </span>
                ) : null}
                {progressNotes.get(task.id) ? (
                  <span
                    data-testid="task-progress"
                    className="w-full text-muted"
                    title={progressNotes.get(task.id)}
                  >
                    {progressNotes.get(task.id)}
                  </span>
                ) : null}
                {resultNotes.get(task.id) ? (
                  <span
                    data-testid="task-result"
                    className="w-full text-body"
                    title={resultNotes.get(task.id)!.full}
                  >
                    {resultNotes.get(task.id)!.text}
                  </span>
                ) : null}
                {task.dueAt && (
                  <span>
                    截止 {fmtLocalDateTime(task.dueAt)}
                    {task.status !== "done" && isOverdue(task.dueAt) ? (
                      <span className="ml-1 rounded-full border border-danger-line bg-danger-soft px-1.5 py-0.5 text-ui-xs text-danger">
                        已逾期
                      </span>
                    ) : null}
                  </span>
                )}
                <span className="inline-flex items-center gap-1">
                  交付物：
                  {task.attachmentFileId ? (
                    <span className="truncate">已上传</span>
                  ) : (
                    <label className="cursor-pointer text-muted underline-offset-2 hover:underline">
                      上传
                      <input
                        type="file"
                        aria-label={`上传交付物 ${task.title}`}
                        className="hidden"
                        disabled={isPending(task.id) || uploading || !canTouch(task)}
                        onChange={(e) => void attach(task, e.target.files?.[0] ?? null)}
                      />
                    </label>
                  )}
                </span>
              </div>
              {task.detail && (
                <p className="mt-1 whitespace-pre-wrap text-ui-xs leading-5 text-muted">
                  {task.detail}
                </p>
              )}
              {historyTaskId === task.id ? (
                <div data-testid="task-history" className="mt-1 rounded-sm border border-line-soft bg-subtle px-2 py-1">
                  {historyError !== "" ? (
                    <p data-testid="task-history-error" className="text-ui-xs text-danger">
                      {historyError}
                    </p>
                  ) : null}
                  {(history[task.id] ?? []).length === 0 ? (
                    <p className="ui-caption">
                      这件活还没有历史：派活、改状态、催办、验收、留言都会记一条。
                    </p>
                  ) : null}
                  <ul className="flex flex-col gap-1">
                    {(history[task.id] ?? []).map((event) => (
                      <li key={event.id} className="flex flex-wrap items-baseline gap-2 text-ui-xs">
                        <span className="shrink-0 tabular-nums text-muted">
                          {fmtLocalDateTime(event.createdAt).slice(5, 16)}
                        </span>
                        <span className="shrink-0 text-muted">
                          {memberName.get(event.actorId) ?? event.actorId}
                        </span>
                        <span className="min-w-0 flex-1">{event.summary}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {commentTaskId === task.id ? (
                <div
                  data-testid="task-comments"
                  className="mt-1 rounded-md border border-line-soft bg-subtle-2 px-2 py-1.5"
                >
                  {commentError !== "" ? (
                    <p data-testid="task-comments-error" className="text-ui-xs text-danger">
                      {commentError}
                    </p>
                  ) : null}
                  {(comments[task.id] ?? []).length === 0 ? (
                    <p className="text-ui-xs text-muted">
                      还没有留言。有疑问就留一句，对方的智能体下一轮能看到。
                    </p>
                  ) : (
                    <ul className="flex flex-col gap-1">
                      {(comments[task.id] ?? []).map((comment) => (
                        <li key={comment.id} className="text-ui-xs leading-5">
                          <span className="text-muted">
                            {memberName.get(comment.authorId) ?? comment.authorId} ·{" "}
                            {fmtLocalDateTime(comment.createdAt).slice(5, 16)}
                          </span>
                          <span className="ml-1 whitespace-pre-wrap text-body">{comment.text}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                  <div className="mt-1 flex flex-wrap items-start gap-1.5">
                    <input
                      aria-label={`留言 ${task.title}`}
                      data-testid="task-comment-input"
                      value={commentDraft}
                      onChange={(e) => setCommentDraft(e.target.value)}
                      maxLength={2000}
                      placeholder="问口径 / 补一条约束（最多 2000 字）"
                      className="ui-input min-w-0 flex-1 py-1 text-ui-xs"
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                          e.preventDefault();
                          void sendComment(task);
                        }
                      }}
                    />
                    <Button
                      type="button"
                      size="sm"
                      variant="primary"
                      data-testid="task-comment-send"
                      disabled={commentBusy || commentDraft.trim() === ""}
                      onClick={() => void sendComment(task)}
                    >
                      发送
                    </Button>
                  </div>
                </div>
              ) : null}
              {leader && task.status === "done" && (task.reviewState ?? "pending") !== "approved" ? (
                <div data-testid="task-review-box" className="mt-1 flex flex-wrap items-center gap-1.5">
                  <input
                    aria-label={`验收意见 ${task.title}`}
                    data-testid="task-review-note"
                    value={reviewingId === task.id ? reviewNoteDraft : ""}
                    onChange={(e) => {
                      setReviewingId(task.id);
                      setReviewNoteDraft(e.target.value);
                    }}
                    maxLength={500}
                    placeholder="打回时写清要改什么（通过可不填）"
                    className="ui-input min-w-0 flex-1 py-1 text-ui-xs"
                  />
                  <button
                    type="button"
                    aria-label={`验收通过 ${task.title}`}
                    data-testid={`task-review-approve-${task.id}`}
                    className="shrink-0 text-ui-xs text-success hover:underline disabled:opacity-60"
                    disabled={isPending(task.id)}
                    title="看过，可以"
                    onClick={() => void review(task, "approve")}
                  >
                    验收通过
                  </button>
                  <button
                    type="button"
                    aria-label={`要求修改 ${task.title}`}
                    data-testid={`task-review-changes-${task.id}`}
                    className="shrink-0 text-ui-xs text-warn hover:underline disabled:opacity-60"
                    disabled={isPending(task.id)}
                    title="打回重做：任务会回到进行中，要写一句原因"
                    onClick={() => void review(task, "changes")}
                  >
                    要求修改
                  </button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {pendingDelete ? (
        <ConfirmDialog
          title="删除任务？"
          onCancel={() => setPendingDelete(null)}
          initialFocusRef={cancelRef}
          footer={
            <>
              <Button
                type="button"
                ref={cancelRef}
                size="md" variant="ghost"
                onClick={() => setPendingDelete(null)}
              >
                取消
              </Button>
              <Button
                type="button"
                size="md" variant="danger"
                onClick={() => void confirmRemove()}
              >
                删除
              </Button>
            </>
          }
        >
          <p className="ui-body-sm">
            删除任务「{pendingDelete.title}」？删除后不可恢复，负责人与截止时间等信息会一起消失。
            交付物文件仍保留在共享文件库。
          </p>
        </ConfirmDialog>
      ) : null}
    </section>
  );
}
