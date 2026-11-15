import { useMemo, useRef, useState } from "react";
import type {
  SharedFileMeta,
  TeamItemStatus,
  TeamPlanItem,
  TeamTask,
  WorkspaceTeamMember,
  TeamWorkspaceSnapshot,
} from "@heming/shared";
import {
  createTeamTask,
  deleteTeamTask,
  fetchFiles,
  fetchWorkspaceTeam,
  updateTeamTask,
  uploadFile,
} from "../../lib/api.js";
import { NEXT_STATUS } from "./TeamPlanPanel.js";
import { ConfirmDialog } from "../ConfirmDialog.js";
import { fmtLocalDateTime, isOverdue } from "../../lib/format/datetime.js";
import { Button } from "../../components/ui/Button.js";

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
type TaskFilter = "open" | "all" | "done";

/**
 * 团队任务（d.92）：创建 / 指派 / 改状态 / 上传交付物。
 *
 * 交付物直接复用共享文件库：上传后把 fileId 记在任务上（服务端只存 id，
 * 文件本体仍走既有配额与预览链路），不需要为团队再造一套存储。
 * 所有写操作都有 `team_task_*` 工具对应，智能体可以代劳（会先让用户确认）。
 */
export function TeamTaskPanel({
  teamId,
  plans,
  members,
  tasks,
  busy,
  onChanged,
  onError,
}: {
  teamId: string;
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
  const [uploading, setUploading] = useState(false);
  const [attachment, setAttachment] = useState<SharedFileMeta | null>(null);
  const [filter, setFilter] = useState<TaskFilter>("open");
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

  const shown = useMemo(() => {
    if (filter === "all") return tasks;
    if (filter === "done") return tasks.filter((t) => t.status === "done");
    return tasks.filter((t) => t.status !== "done");
  }, [tasks, filter]);

  const refresh = async () => onChanged(await fetchWorkspaceTeam(teamId));

  const resetDraft = () => {
    setTitle("");
    setDetail("");
    setAssigneeId("");
    setPlanId("");
    setDueAt("");
    setAttachment(null);
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
        ...(attachment ? { attachmentFileId: attachment.id } : {}),
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

  return (
    <section aria-label="团队任务" className="ui-card p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="ui-block-title">任务</h2>
        <span className="ui-micro">{tasks.length}</span>
        <div className="ml-auto flex items-center gap-1" role="group" aria-label="任务筛选">
          {(
            [
              ["open", "未完成"],
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
                  <option key={m.user.id} value={m.user.id}>
                    {m.user.displayName}
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
          <Button type="submit" size="sm" variant="primary" className="self-start" disabled={busy || uploading || saving}>
            {saving ? "发布中…" : "发布任务"}
          </Button>
        </form>
      )}

      {shown.length === 0 ? (
        <p className="mt-2 ui-caption">
          {tasks.length === 0
            ? "还没有任务。把目标拆成能派出去的一件事，指定负责人即可。"
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
                  disabled={isPending(task.id)}
                  title="点击切换状态"
                  className={`rounded-full border px-1.5 py-0.5 text-ui-xs ${STATUS_STYLE[task.status]} ${
                    isPending(task.id) ? "opacity-60" : ""
                  }`}
                >
                  {STATUS_LABEL[task.status]}
                </button>
                <span className="min-w-0 flex-1 truncate text-ui-md font-medium">{task.title}</span>
                <label className="flex shrink-0 items-center gap-1 text-ui-xs text-muted">
                  负责
                  <select
                    aria-label={`任务负责人 ${task.title}`}
                    value={task.assigneeId ?? ""}
                    disabled={isPending(task.id)}
                    onChange={(e) => void assign(task, e.target.value)}
                    className="ui-input w-auto py-0.5 text-ui-xs"
                  >
                    <option value="">待认领</option>
                    {members.map((m) => (
                      <option key={m.user.id} value={m.user.id}>
                        {m.user.displayName}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  aria-label={`删除任务 ${task.title}`}
                  className="shrink-0 text-ui-xs text-muted hover:text-danger disabled:opacity-60"
                  disabled={isPending(task.id)}
                  onClick={() => setPendingDelete(task)}
                >
                  删除
                </button>
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 ui-caption">
                {task.planId && planName.get(task.planId) ? (
                  <span>方案：{planName.get(task.planId)}</span>
                ) : null}
                {task.assigneeId && memberName.get(task.assigneeId) ? (
                  <span>负责人：{memberName.get(task.assigneeId)}</span>
                ) : (
                  <span>待认领</span>
                )}
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
                        disabled={isPending(task.id) || uploading}
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
