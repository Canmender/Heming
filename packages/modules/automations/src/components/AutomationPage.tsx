import { useEffect, useRef, useState } from "react";
import { isInfohubAvailable } from "@heming/sdk";
import { useInfohubStore } from "@heming/sdk";
import {
  ALL_WEEKDAYS,
  MAX_INTERVAL_MINUTES,
  MIN_INTERVAL_MINUTES,
  WEEKDAY_LABEL,
  actionLabel,
  describeAction,
  describeSchedule,
  draftForKind,
  formatAutomationTime,
  nextRunAt,
  runStatusLabel,
  validateDraft,
  type AutomationDraft,
  type AutomationTask,
} from "../lib/automation/model.js";
import { isAutomationKind, kindMeta, listKindMeta } from "../lib/automation/kinds.js";
import { AUTOMATION_PRESETS, presetDraft } from "../lib/automation/presets.js";
import {
  MAX_AUTOMATION_RUNS,
  useAutomationRunsStore,
  type AutomationRun,
} from "../lib/automation/runs.js";
import { runAutomationTask } from "../lib/automation/runner.js";
import { useAutomationStore } from "../lib/automation/store.js";
import { useUiStore } from "@heming/sdk";
import { useModalA11y } from "@heming/sdk";
import { ConfirmDialog } from "@heming/sdk";
import { AutomationIcon, PlusIcon, TrashIcon } from "@heming/sdk";
import { PageShell } from "@heming/sdk";
import { EmptyState } from "@heming/sdk";

/**
 * 自动化页（d.47）：把信息中枢的本机同步/日程重扫变成可定时的任务。
 *
 * 数据只在本机。执行前提是「桌面端 + 信息中枢已连接」——未连接时任务会被
 * 记为跳过并顺延，绝不自动拉起 Python 边车（与 d.45/d.46 的红线一致）。
 */

/** 无 emoji 的状态胶囊。 */
function statusClass(status: AutomationTask["lastStatus"]): string {
  if (status === "ok") return "border-[var(--success-line)] bg-[var(--success-soft)] text-[var(--success)]";
  if (status === "error") return "border-[var(--danger-line)] bg-[var(--danger-soft)] text-[var(--danger)]";
  if (status === "skipped") return "border-[var(--warn-line)] bg-[var(--warn-soft)] text-[var(--warn)]";
  return "border-line bg-panel text-muted";
}

/** 执行耗时：秒级为主，超过一分钟给「N 分 M 秒」。 */
function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0 秒";
  if (ms < 1_000) return "不到 1 秒";
  const seconds = Math.round(ms / 1_000);
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest > 0 ? `${minutes} 分 ${rest} 秒` : `${minutes} 分`;
}

/** 运行记录的触发来源（文案留在页内，避免同一句话散到多个模块）。 */
function triggerLabel(trigger: AutomationRun["trigger"]): string {
  return trigger === "manual" ? "手动" : "定时";
}

function cloneDraft(draft: AutomationDraft): AutomationDraft {
  return {
    name: draft.name,
    kind: draft.kind,
    schedule:
      draft.schedule.type === "daily"
        ? { type: "daily", time: draft.schedule.time, weekdays: [...draft.schedule.weekdays] }
        : { type: "interval", minutes: draft.schedule.minutes },
    sync: { ...draft.sync, sources: [...draft.sync.sources] },
  };
}

function draftFromTask(task: AutomationTask): AutomationDraft {
  return cloneDraft({
    name: task.name,
    kind: task.kind,
    schedule: task.schedule,
    sync: task.sync,
  });
}

export function AutomationPage() {
  const tasks = useAutomationStore((s) => s.tasks);
  const runningId = useAutomationStore((s) => s.runningId);
  const setEnabled = useAutomationStore((s) => s.setEnabled);
  const removeTask = useAutomationStore((s) => s.remove);
  const createTask = useAutomationStore((s) => s.create);
  const beginRun = useAutomationStore((s) => s.beginRun);
  const finishRun = useAutomationStore((s) => s.finishRun);
  const runs = useAutomationRunsStore((s) => s.runs);
  const clearRuns = useAutomationRunsStore((s) => s.clearAll);

  const openInfohub = useUiStore((s) => s.openInfohub);
  const intent = useUiStore((s) => s.automationIntent);
  const consumeIntent = useUiStore((s) => s.consumeAutomationIntent);
  const automationFocusId = useUiStore((s) => s.automationFocusId);
  const consumeAutomationFocus = useUiStore((s) => s.consumeAutomationFocus);

  const desktop = isInfohubAvailable();
  const booted = useInfohubStore((s) => s.booted);
  const infohubRunning = useInfohubStore((s) => s.running);

  const [editor, setEditor] = useState<{ id: string | null; draft: AutomationDraft } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AutomationTask | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  /** 展开运行记录的任务 id；默认收起，只有用户点开或通知跳转时才展开。 */
  const [expandedRuns, setExpandedRuns] = useState<Record<string, boolean>>({});
  const [clearRunsOpen, setClearRunsOpen] = useState(false);
  /** 从通知跳进来时短暂高亮目标任务，2 秒后自灭（不做常驻选中态）。 */
  const [highlightId, setHighlightId] = useState<string | null>(null);

  // 直接进本页（如刷新后）时也探测一次；只读 info，不拉起进程。
  useEffect(() => {
    void useInfohubStore.getState().boot();
  }, []);

  useEffect(() => {
    if (!intent) return;
    consumeIntent();
    setError("");
    setEditor({ id: null, draft: draftForKind(intent.kind, intent.sync) });
  }, [intent, consumeIntent]);

  // 从通知中心跳进来：展开目标任务的运行记录、滚到视野里、短暂高亮。
  // 无论命中与否都消费焦点——留着的话，切走再回来会被同一条旧通知再拽一次。
  useEffect(() => {
    if (!automationFocusId) return;
    const taskId = automationFocusId;
    consumeAutomationFocus();
    setExpandedRuns((current) => ({ ...current, [taskId]: true }));
    setHighlightId(taskId);
    document.getElementById(`automation-task-${taskId}`)?.scrollIntoView?.({ block: "center" });
    const timer = window.setTimeout(() => setHighlightId(null), 2_000);
    return () => window.clearTimeout(timer);
  }, [automationFocusId, consumeAutomationFocus]);

  const enabledCount = tasks.filter((task) => task.enabled).length;
  const nextTask = tasks
    .filter((task) => task.enabled)
    .sort((a, b) => a.nextRunAt - b.nextRunAt)[0];

  function openCreate() {
    setError("");
    setEditor({ id: null, draft: draftForKind("infohub.sync") });
  }

  function openEdit(task: AutomationTask) {
    setError("");
    setEditor({ id: task.id, draft: draftFromTask(task) });
  }

  async function runNow(task: AutomationTask) {
    setError("");
    setNotice("");
    // 「立即运行」是人点的：触发来源记为 manual，运行记录里与定时任务区分得开。
    if (!beginRun(task.id, Date.now(), "manual")) {
      setError("已有任务正在运行，请等它结束");
      return;
    }
    setNotice(`正在执行「${task.name}」…`);
    try {
      const outcome = await runAutomationTask(task);
      finishRun(task.id, outcome);
      setNotice(`「${task.name}」${runStatusLabel(outcome.status)}：${outcome.detail}`);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      finishRun(task.id, { status: "error", detail });
      setNotice(`「${task.name}」失败：${detail}`);
    }
  }

  return (
    <PageShell
      title="自动化"
      subtitle="定时同步归档、重扫日程；和鸣关着时错过的点不补跑。"
      width="readable"
      // d.72：空态垂直居中，同幕僚页；滚动交给内层容器
      scroll={false}
      actions={
        <button
          type="button"
          onClick={openCreate}
          className="ui-btn ui-btn-md ui-btn-primary"
        >
          <PlusIcon width={14} height={14} />
          新建自动化
        </button>
      }
    >
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5 max-[1199px]:px-4">
      <div className="mx-auto flex min-h-full w-full max-w-[960px] flex-col">
      {!desktop && (
        <div className="mb-4 rounded-lg border border-line-soft bg-[var(--warn-soft)] px-3 py-2 ui-caption text-[var(--warn)]">
          自动化只在桌面端执行。浏览器里可以创建和查看任务，但到点不会运行。
        </div>
      )}
      {desktop && booted && !infohubRunning && (
        <div className="mb-4 flex flex-wrap items-center gap-2 rounded-lg border border-line-soft bg-[var(--warn-soft)] px-3 py-2 ui-caption text-[var(--warn)]">
          <span>信息中枢未连接：到点的任务会如实记为失败并顺延，不会自动拉起本机进程。</span>
          <button
            type="button"
            onClick={() => openInfohub()}
            className="rounded-sm border border-[var(--warn-line)] px-2 py-0.5 text-[10px] hover:bg-[var(--warn-soft)]"
          >
            去连接
          </button>
        </div>
      )}

      {(error || notice) && (
        <div
          role={error ? "alert" : "status"}
          className={`ui-alert mb-4 justify-between ${error ? "ui-alert-danger" : "ui-alert-muted"}`}
        >
          <span className="min-w-0 break-words">{error || notice}</span>
          <button
            type="button"
            onClick={() => (error ? setError("") : setNotice(""))}
            className="shrink-0 hover:underline"
          >
            关闭
          </button>
        </div>
      )}

      <div className="mb-4 flex flex-wrap gap-2">
        <Stat label="任务" value={String(tasks.length)} />
        <Stat label="启用" value={String(enabledCount)} />
        <Stat label="下次执行" value={nextTask ? formatAutomationTime(nextTask.nextRunAt) : "—"} />
        <Stat label="运行记录" value={String(runs.length)} />
        <Stat
          label="信息中枢"
          value={!desktop ? "仅桌面端" : infohubRunning ? "已连接" : booted ? "未连接" : "探测中"}
        />
        {runs.length > 0 && (
          <button
            type="button"
            onClick={() => setClearRunsOpen(true)}
            className="shrink-0 self-stretch rounded-lg border border-line px-3 text-[11px] text-[var(--body)] hover:bg-[var(--subtle-2)]"
          >
            清空记录
          </button>
        )}
      </div>

      {/* d.76：常用组合一键创建——把「动作 / 来源 / 时间 / 全量」的选择降级为高级入口。 */}
      <section aria-label="自动化预设" className="mb-4">
        <div className="mb-2 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="ui-section-title">常用预设</span>
          <span className="ui-caption">点一下直接建好，之后仍可在列表里改</span>
        </div>
        <div className="grid gap-2 md:grid-cols-2">
          {AUTOMATION_PRESETS.map((preset) => (
            <div
              key={preset.id}
              className="flex flex-col gap-1 rounded-xl border border-line bg-panel p-3"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[13px] font-semibold">{preset.label}</span>
                <span className="ui-chip">{preset.scheduleText}</span>
              </div>
              <p className="ui-caption">{preset.description}</p>
              <button
                type="button"
                aria-label={`一键创建：${preset.label}`}
                className="ui-btn ui-btn-sm ui-btn-ghost mt-2 self-start"
                onClick={() => {
                  setError("");
                  setNotice("");
                  const outcome = createTask(presetDraft(preset));
                  if (!outcome.ok) {
                    setError(outcome.error);
                    return;
                  }
                  setNotice(`已按预设创建「${preset.label}」`);
                }}
              >
                一键创建
              </button>
            </div>
          ))}
        </div>
      </section>

      <div className="flex flex-1 flex-col">
        {tasks.length === 0 ? (
          <div className="flex flex-1 items-center justify-center py-8">
          <div className="w-full max-w-[520px] ui-card">
            <EmptyState
              icon={<AutomationIcon width={22} height={22} />}
              title="还没有自动化任务"
              desc="把信息中枢的「同步归档」「重扫日程」设为每天定时或按间隔执行。任务只存本机。"
              actions={
                <button
                  type="button"
                  onClick={openCreate}
                  className="ui-btn ui-btn-md ui-btn-primary"
                >
                  新建自动化
                </button>
              }
            />
          </div>
          </div>
        ) : (
          <>
            <ul className="flex flex-col gap-4">
              {tasks.map((task) => {
                const running = runningId === task.id;
                const taskRuns = runs.filter((run) => run.taskId === task.id);
                const runsOpen = expandedRuns[task.id] === true;
                return (
                  <li
                    key={task.id}
                    id={`automation-task-${task.id}`}
                    className={`rounded-xl border bg-[var(--surface)] px-4 py-3 shadow-card ${
                      task.enabled ? "border-line" : "border-line-soft opacity-75"
                    } ${highlightId === task.id ? "ring-2 ring-[#bbb]" : ""}`}
                  >
                  <div className="flex flex-wrap items-start gap-3">
                    <div className="mt-0.5 flex w-[70px] shrink-0 flex-col items-start gap-1">
                      <span
                        className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 ui-micro font-semibold ${
                          task.enabled
                            ? "border-[var(--success-line)] bg-[var(--success-soft)] text-[var(--success)]"
                            : "border-line bg-panel text-muted"
                        }`}
                      >
                        {task.enabled ? "启用" : "停用"}
                      </span>
                      {running && <span className="ui-micro text-muted">运行中…</span>}
                    </div>

                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate text-[13px] font-semibold">{task.name}</span>
                        <span className="rounded-sm border border-line px-1.5 py-0.5 ui-micro text-[var(--body)]">
                          {actionLabel(task.kind)}
                        </span>
                      </div>
                      <div className="mt-1 text-[11px] text-[var(--body)]">{describeAction(task)}</div>
                      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px] text-muted">
                        <span>{describeSchedule(task.schedule)}</span>
                        <span>
                          下次 {task.enabled ? formatAutomationTime(task.nextRunAt) : "—（已停用）"}
                        </span>
                        <span>上次 {task.lastRunAt ? formatAutomationTime(task.lastRunAt) : "从未"}</span>
                        {task.lastStatus && (
                          <span
                            className={`inline-flex items-center rounded-full border px-1.5 py-0.5 ui-micro font-medium ${statusClass(task.lastStatus)}`}
                          >
                            {runStatusLabel(task.lastStatus)}
                          </span>
                        )}
                      </div>
                      {task.lastDetail && task.lastStatus && (
                        <div className="mt-1 break-words text-[10px] leading-4 text-muted">
                          {task.lastDetail}
                        </div>
                      )}
                      <div className="mt-2 border-t border-line-soft pt-1.5">
                        <button
                          type="button"
                          aria-label={`运行记录 ${task.name}`}
                          aria-expanded={runsOpen}
                          onClick={() =>
                            setExpandedRuns((current) => ({
                              ...current,
                              [task.id]: !current[task.id],
                            }))
                          }
                          className="text-[10px] text-[var(--body)] hover:text-ink"
                        >
                          {runsOpen ? "收起运行记录" : `运行记录（${taskRuns.length}）`}
                        </button>
                        {runsOpen &&
                          (taskRuns.length === 0 ? (
                            <p className="mt-1 text-[10px] text-muted">还没有运行记录。</p>
                          ) : (
                            <ul className="mt-1.5 flex flex-col gap-1">
                              {taskRuns.slice(0, 8).map((run) => (
                                <li
                                  key={run.id}
                                  className="flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded border border-line-soft bg-panel px-2 py-1 text-[10px] text-[var(--body)]"
                                >
                                  <span
                                    className={`inline-flex items-center rounded-full border px-1.5 py-0.5 text-[9px] font-medium ${statusClass(run.status)}`}
                                  >
                                    {runStatusLabel(run.status)}
                                  </span>
                                  <span className="tabular-nums">
                                    {formatAutomationTime(run.finishedAt)}
                                  </span>
                                  <span>{triggerLabel(run.trigger)}</span>
                                  <span className="tabular-nums">
                                    耗时 {formatDuration(run.durationMs)}
                                  </span>
                                  {run.detail && (
                                    <span className="min-w-0 basis-full break-words leading-4 text-muted">
                                      {run.detail}
                                    </span>
                                  )}
                                </li>
                              ))}
                              {taskRuns.length > 8 && (
                                <li className="text-[10px] text-muted">
                                  只显示最近 8 条，共 {taskRuns.length} 条
                                </li>
                              )}
                            </ul>
                          ))}
                      </div>
                    </div>

                    <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                      <button
                        type="button"
                        aria-label={`立即运行 ${task.name}`}
                        disabled={Boolean(runningId)}
                        onClick={() => void runNow(task)}
                        className="rounded-md bg-ink px-2.5 py-1 text-[11px] font-medium text-white hover:opacity-90 disabled:opacity-50"
                      >
                        {running ? "运行中…" : "立即运行"}
                      </button>
                      <button
                        type="button"
                        aria-label={`${task.enabled ? "停用" : "启用"} ${task.name}`}
                        onClick={() => setEnabled(task.id, !task.enabled)}
                        className="rounded-md border border-line px-2.5 py-1 text-[11px] hover:bg-[var(--subtle-2)]"
                      >
                        {task.enabled ? "停用" : "启用"}
                      </button>
                      <button
                        type="button"
                        aria-label={`编辑 ${task.name}`}
                        onClick={() => openEdit(task)}
                        className="rounded-md border border-line px-2.5 py-1 text-[11px] hover:bg-[var(--subtle-2)]"
                      >
                        编辑
                      </button>
                      <button
                        type="button"
                        aria-label={`删除 ${task.name}`}
                        onClick={() => setDeleteTarget(task)}
                        className="flex items-center gap-1 rounded-md border border-line px-2.5 py-1 text-[11px] text-[var(--danger)] hover:bg-[var(--danger-soft)]"
                      >
                        <TrashIcon width={12} height={12} />
                        删除
                      </button>
                    </div>
                  </div>
                </li>
              );
              })}
            </ul>
            <p className="mx-auto mt-3 max-w-[900px] text-[10px] leading-4 text-muted">
              运行记录只存本机，最多保留 {MAX_AUTOMATION_RUNS} 条；本机存储写不下时只在本次会话里可见。
              错过的时刻不补跑，失败也不会自动重试。
            </p>
          </>
        )}
      </div>
      </div>
      </div>

      {editor && (
        <AutomationEditor
          taskId={editor.id}
          initial={editor.draft}
          onClose={() => setEditor(null)}
          onSaved={() => {
            setEditor(null);
            setError("");
            setNotice("自动化任务已保存");
          }}
        />
      )}

      {deleteTarget && (
        <ConfirmDialog
          title="删除自动化"
          onCancel={() => setDeleteTarget(null)}
          footer={
            <>
              <button
                type="button"
                onClick={() => setDeleteTarget(null)}
                className="ui-btn ui-btn-md ui-btn-ghost"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => {
                  removeTask(deleteTarget.id);
                  setDeleteTarget(null);
                  setNotice("自动化任务已删除");
                }}
                className="ui-btn ui-btn-md ui-btn-danger"
              >
                删除
              </button>
            </>
          }
        >
          <p className="text-[12px] leading-6">
            确定删除「{deleteTarget.name}」？删除后不会再按计划执行，已有的运行结果也会一并移除。
          </p>
        </ConfirmDialog>
      )}

      {clearRunsOpen && (
        <ConfirmDialog
          title="清空运行记录"
          onCancel={() => setClearRunsOpen(false)}
          footer={
            <>
              <button
                type="button"
                onClick={() => setClearRunsOpen(false)}
                className="ui-btn ui-btn-md ui-btn-ghost"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => {
                  clearRuns();
                  setClearRunsOpen(false);
                  setNotice("运行记录已清空");
                }}
                className="ui-btn ui-btn-md ui-btn-danger"
              >
                清空
              </button>
            </>
          }
        >
          <p className="text-[12px] leading-6">
            确定清空全部运行记录？共 {runs.length} 条，清空后无法恢复；任务本身与排期不受影响。
          </p>
        </ConfirmDialog>
      )}
    </PageShell>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 flex-1 rounded-lg border border-line-soft bg-panel px-3 py-2">
      <div className="text-[10px] font-medium uppercase tracking-wider text-muted">{label}</div>
      <div className="mt-0.5 truncate text-[13px] font-semibold tabular-nums text-ink">{value}</div>
    </div>
  );
}

function AutomationEditor({
  taskId,
  initial,
  onClose,
  onSaved,
}: {
  taskId: string | null;
  initial: AutomationDraft;
  onClose: () => void;
  onSaved: () => void;
}) {
  const create = useAutomationStore((s) => s.create);
  const update = useAutomationStore((s) => s.update);
  const [draft, setDraft] = useState(() => cloneDraft(initial));
  const [error, setError] = useState("");
  const panelRef = useRef<HTMLDivElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  useModalA11y(panelRef, onClose, { initialFocusRef: nameRef });

  const schedule = draft.schedule;
  const preview = nextRunAt(schedule, Date.now());
  /** d.77（R10）：弹窗内回车 = 保存，和桌面端习惯一致；Esc 仍由 useModalA11y 关闭。 */
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    save();
  };

  function patchSync(patch: Partial<AutomationDraft["sync"]>) {
    setDraft((current) => ({ ...current, sync: { ...current.sync, ...patch } }));
  }

  function toggleSource(source: "qq" | "wechat") {
    setDraft((current) => {
      const has = current.sync.sources.includes(source);
      return {
        ...current,
        sync: {
          ...current.sync,
          sources: has
            ? current.sync.sources.filter((s) => s !== source)
            : [...current.sync.sources, source],
        },
      };
    });
  }

  function toggleWeekday(day: number) {
    setDraft((current) => {
      if (current.schedule.type !== "daily") return current;
      const has = current.schedule.weekdays.includes(day);
      return {
        ...current,
        schedule: {
          ...current.schedule,
          weekdays: has
            ? current.schedule.weekdays.filter((d) => d !== day)
            : [...current.schedule.weekdays, day],
        },
      };
    });
  }

  function save() {
    const invalid = validateDraft(draft);
    if (invalid) {
      setError(invalid);
      return;
    }
    const outcome = taskId ? update(taskId, draft) : create(draft);
    if (!outcome.ok) {
      setError(outcome.error);
      return;
    }
    onSaved();
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/20"
      onClick={onClose}
    >
      <form
        ref={panelRef as unknown as React.RefObject<HTMLFormElement>}
        role="dialog"
        aria-modal="true"
        aria-label={taskId ? "编辑自动化" : "新建自动化"}
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
        className="flex max-h-[88vh] w-[min(600px,94vw)] flex-col overflow-hidden rounded-xl border border-line-soft bg-[var(--surface)] shadow-card"
      >
        <div className="flex items-center justify-between gap-3 border-b border-line-soft px-4 py-2.5">
          <span className="truncate text-[13px] font-bold">{taskId ? "编辑自动化" : "新建自动化"}</span>
          <button
            type="button"
            onClick={onClose}
            className="rounded-sm px-2 py-0.5 text-[11px] text-muted hover:bg-[var(--subtle-3)] hover:text-ink"
          >
            关闭
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-auto px-4 py-3">
          <label className="block text-[11px] font-medium text-[var(--body)]" htmlFor="automation-name">
            名称
          </label>
          <input
            id="automation-name"
            ref={nameRef}
            value={draft.name}
            onChange={(e) => setDraft((current) => ({ ...current, name: e.target.value }))}
            className="mt-1 w-full rounded-md border border-line-strong px-2.5 py-1.5 text-[12px] outline-hidden focus:border-ink"
          />

          <label className="mt-3 block text-[11px] font-medium text-[var(--body)]" htmlFor="automation-kind">
            动作
          </label>
          <select
            id="automation-kind"
            value={draft.kind}
            onChange={(e) => {
              const next = e.target.value;
              // 下拉项来自注册表；值不可信时落回默认动作（与旧行为「未知按同步」等价）。
              setDraft((current) => ({
                ...current,
                kind: isAutomationKind(next) ? next : "infohub.sync",
              }));
            }}
            className="mt-1 w-full rounded-md border border-line-strong bg-[var(--surface)] px-2.5 py-1.5 text-[12px] outline-hidden focus:border-ink"
          >
            {listKindMeta().map((meta) => (
              <option key={meta.kind} value={meta.kind}>
                {meta.label}
              </option>
            ))}
          </select>
          <p className="mt-1 text-[10px] leading-4 text-muted">{kindMeta(draft.kind).summary}</p>

          {kindMeta(draft.kind).hasSyncParams && (
            <div className="mt-2 rounded-lg border border-line-soft bg-panel p-3">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[11px]">
                <span className="font-medium text-[var(--body)]">同步选项</span>
                <label className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={draft.sync.sources.includes("qq")}
                    onChange={() => toggleSource("qq")}
                  />
                  QQ
                </label>
                <label className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={draft.sync.sources.includes("wechat")}
                    onChange={() => toggleSource("wechat")}
                  />
                  微信
                </label>
                <label className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={draft.sync.full}
                    onChange={(e) => patchSync({ full: e.target.checked })}
                  />
                  全量重扫
                </label>
                <label className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={draft.sync.archive}
                    onChange={(e) => patchSync({ archive: e.target.checked })}
                  />
                  导出知识库
                </label>
              </div>
              <p className="mt-1.5 text-[10px] leading-4 text-muted">
                同步会写入本机归档；<strong>导出知识库</strong>会写入 InfoHub 配置的 Obsidian 目录。
              </p>
            </div>
          )}

          <div className="mt-4 text-[11px] font-medium text-[var(--body)]">触发方式</div>
          <div role="radiogroup" aria-label="触发方式" className="mt-1 flex gap-2">
            <button
              type="button"
              role="radio"
              aria-checked={schedule.type === "daily"}
              onClick={() =>
                setDraft((current) => ({
                  ...current,
                  schedule: {
                    type: "daily",
                    time: current.schedule.type === "daily" ? current.schedule.time : "09:00",
                    weekdays:
                      current.schedule.type === "daily"
                        ? current.schedule.weekdays
                        : [...ALL_WEEKDAYS],
                  },
                }))
              }
              className={`rounded-md border px-3 py-1 text-[11px] ${
                schedule.type === "daily" ? "border-ink bg-ink text-white" : "border-line hover:bg-[var(--subtle-2)]"
              }`}
            >
              每天定时
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={schedule.type === "interval"}
              onClick={() =>
                setDraft((current) => ({
                  ...current,
                  schedule: {
                    type: "interval",
                    minutes: current.schedule.type === "interval" ? current.schedule.minutes : 60,
                  },
                }))
              }
              className={`rounded-md border px-3 py-1 text-[11px] ${
                schedule.type === "interval" ? "border-ink bg-ink text-white" : "border-line hover:bg-[var(--subtle-2)]"
              }`}
            >
              按间隔
            </button>
          </div>

          {schedule.type === "daily" ? (
            <div className="mt-2">
              <div className="flex flex-wrap items-center gap-2">
                <label className="text-[11px] text-[var(--body)]" htmlFor="automation-time">
                  执行时间
                </label>
                <input
                  id="automation-time"
                  type="time"
                  value={schedule.time}
                  onChange={(e) =>
                    setDraft((current) =>
                      current.schedule.type === "daily"
                        ? { ...current, schedule: { ...current.schedule, time: e.target.value } }
                        : current,
                    )
                  }
                  className="rounded-md border border-line-strong px-2 py-1 text-[12px] outline-hidden focus:border-ink"
                />
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <span className="mr-1 text-[11px] text-[var(--body)]">星期</span>
                {ALL_WEEKDAYS.map((day) => {
                  const active = schedule.weekdays.includes(day);
                  return (
                    <button
                      key={day}
                      type="button"
                      aria-label={`周${WEEKDAY_LABEL[day]}`}
                      aria-pressed={active}
                      onClick={() => toggleWeekday(day)}
                      className={`h-[26px] w-[26px] rounded-full border text-[11px] transition-colors ${
                        active
                          ? "border-ink bg-ink text-white"
                          : "border-line text-muted hover:bg-[var(--subtle-2)]"
                      }`}
                    >
                      {WEEKDAY_LABEL[day]}
                    </button>
                  );
                })}
              </div>
            </div>
          ) : (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <label className="text-[11px] text-[var(--body)]" htmlFor="automation-interval">
                间隔分钟
              </label>
              <input
                id="automation-interval"
                type="number"
                min={MIN_INTERVAL_MINUTES}
                max={MAX_INTERVAL_MINUTES}
                step={1}
                value={Number.isFinite(schedule.minutes) ? schedule.minutes : ""}
                onChange={(e) =>
                  setDraft((current) =>
                    current.schedule.type === "interval"
                      ? { ...current, schedule: { ...current.schedule, minutes: Number(e.target.value) } }
                      : current,
                  )
                }
                className="w-24 rounded-md border border-line-strong px-2 py-1 text-[12px] outline-hidden focus:border-ink"
              />
              <span className="text-[10px] text-muted">
                {MIN_INTERVAL_MINUTES}–{MAX_INTERVAL_MINUTES} 分钟
              </span>
            </div>
          )}

          <p className="mt-2 text-[10px] leading-4 text-muted">
            下次执行：{formatAutomationTime(preview)}（保存后按此刻重新排期）
          </p>

          <div className="mt-4 rounded-lg border border-line-soft bg-[var(--warn-soft)] p-3 text-[10px] leading-5 text-[var(--warn)]">
            执行前提：桌面端且信息中枢已连接。未连接时任务会如实记为失败并顺延，不会自动拉起本机进程；
            和鸣关闭期间错过的时刻不会补跑。
          </div>

          {error && <p role="alert" className="mt-2 text-[11px] text-[var(--danger)]">{error}</p>}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-line-soft px-4 py-2.5">
          <button
            type="button"
            onClick={onClose}
            className="ui-btn ui-btn-md ui-btn-ghost"
          >
            取消
          </button>
          <button type="submit" className="ui-btn ui-btn-md ui-btn-primary">
            保存
          </button>
        </div>
      </form>
    </div>
  );
}
