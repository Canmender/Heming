import { useEffect, useRef, useState } from "react";
import { isInfohubAvailable } from "../lib/infohub/client.js";
import { useInfohubStore } from "../lib/infohub/store.js";
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
import { runAutomationTask } from "../lib/automation/runner.js";
import { useAutomationStore } from "../lib/automation/store.js";
import { useUiStore } from "../store/ui.js";
import { useModalA11y } from "./useModalA11y.js";
import { ConfirmDialog } from "./ConfirmDialog.js";
import { AutomationIcon, PlusIcon, TrashIcon } from "./icons.js";

/**
 * 自动化页（d.47）：把信息中枢的本机同步/日程重扫变成可定时的任务。
 *
 * 数据只在本机。执行前提是「桌面端 + 信息中枢已连接」——未连接时任务会被
 * 记为跳过并顺延，绝不自动拉起 Python 边车（与 d.45/d.46 的红线一致）。
 */

/** 无 emoji 的状态胶囊。 */
function statusClass(status: AutomationTask["lastStatus"]): string {
  if (status === "ok") return "border-[#bbf7d0] bg-[#f0fdf4] text-[#15803d]";
  if (status === "error") return "border-[#fecdca] bg-[#fef3f2] text-[#b42318]";
  if (status === "skipped") return "border-[#fed7aa] bg-[#fffbeb] text-[#b45309]";
  return "border-line bg-panel text-muted";
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
  const beginRun = useAutomationStore((s) => s.beginRun);
  const finishRun = useAutomationStore((s) => s.finishRun);

  const openInfohub = useUiStore((s) => s.openInfohub);
  const intent = useUiStore((s) => s.automationIntent);
  const consumeIntent = useUiStore((s) => s.consumeAutomationIntent);

  const desktop = isInfohubAvailable();
  const booted = useInfohubStore((s) => s.booted);
  const infohubRunning = useInfohubStore((s) => s.running);

  const [editor, setEditor] = useState<{ id: string | null; draft: AutomationDraft } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AutomationTask | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

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
    if (!beginRun(task.id)) {
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
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line-soft px-5 py-3">
        <div className="min-w-0">
          <h1 className="text-[15px] font-semibold tracking-tight">自动化</h1>
          <p className="mt-0.5 text-[11px] text-muted">
            本机定时任务 · 只在和鸣运行期间触发 · 错过的时刻不补跑
          </p>
        </div>
        <button
          type="button"
          onClick={openCreate}
          className="flex items-center gap-1.5 rounded-md bg-ink px-3 py-1.5 text-[12px] font-medium text-white transition-opacity hover:opacity-90"
        >
          <PlusIcon width={14} height={14} />
          新建自动化
        </button>
      </header>

      {!desktop && (
        <div className="border-b border-line-soft bg-[#fffdf5] px-5 py-2 text-[11px] leading-5 text-[#8a6d3b]">
          自动化只在桌面端执行。浏览器里可以创建和查看任务，但到点不会运行。
        </div>
      )}
      {desktop && booted && !infohubRunning && (
        <div className="flex flex-wrap items-center gap-2 border-b border-line-soft bg-[#fffdf5] px-5 py-2 text-[11px] leading-5 text-[#8a6d3b]">
          <span>信息中枢未连接：到点的任务会被记为跳过并顺延，不会自动拉起本机进程。</span>
          <button
            type="button"
            onClick={() => openInfohub()}
            className="rounded border border-[#e5d5a8] px-2 py-0.5 text-[10px] hover:bg-[#fff8e1]"
          >
            去连接
          </button>
        </div>
      )}

      {(error || notice) && (
        <div
          role={error ? "alert" : "status"}
          className={`flex items-start justify-between gap-3 border-b px-5 py-2 text-[11px] leading-5 ${
            error
              ? "border-[#f3c6c2] bg-[#fdf3f2] text-[#912018]"
              : "border-line-soft bg-panel text-[#555]"
          }`}
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

      <div className="flex gap-2 border-b border-line-soft px-5 py-2.5">
        <Stat label="任务" value={String(tasks.length)} />
        <Stat label="启用" value={String(enabledCount)} />
        <Stat label="下次执行" value={nextTask ? formatAutomationTime(nextTask.nextRunAt) : "—"} />
        <Stat
          label="信息中枢"
          value={!desktop ? "仅桌面端" : infohubRunning ? "已连接" : booted ? "未连接" : "探测中"}
        />
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-5 py-4">
        {tasks.length === 0 ? (
          <div className="mx-auto mt-8 max-w-[520px] rounded-xl border border-line bg-white p-6 text-center shadow-card">
            <AutomationIcon width={26} height={26} />
            <h2 className="mt-2 text-[14px] font-semibold">还没有自动化任务</h2>
            <p className="mt-1 text-[12px] leading-6 text-muted">
              可以把信息中枢的「同步归档」或「重扫日程」设成每天定时或按间隔执行。
              任务只存本机，不会上传。
            </p>
            <button
              type="button"
              onClick={openCreate}
              className="mt-4 rounded-md bg-ink px-4 py-1.5 text-[12px] font-medium text-white hover:opacity-90"
            >
              新建自动化
            </button>
          </div>
        ) : (
          <ul className="mx-auto flex max-w-[900px] flex-col gap-2">
            {tasks.map((task) => {
              const running = runningId === task.id;
              return (
                <li
                  key={task.id}
                  className={`rounded-xl border bg-white px-4 py-3 shadow-card ${
                    task.enabled ? "border-line" : "border-line-soft opacity-75"
                  }`}
                >
                  <div className="flex flex-wrap items-start gap-3">
                    <div className="mt-0.5 flex w-[70px] shrink-0 flex-col items-start gap-1">
                      <span
                        className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[9px] font-semibold ${
                          task.enabled
                            ? "border-[#bbf7d0] bg-[#f0fdf4] text-[#15803d]"
                            : "border-line bg-panel text-muted"
                        }`}
                      >
                        {task.enabled ? "启用" : "停用"}
                      </span>
                      {running && <span className="text-[9px] text-muted">运行中…</span>}
                    </div>

                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate text-[13px] font-semibold">{task.name}</span>
                        <span className="rounded border border-line px-1.5 py-0.5 text-[9px] text-[#555]">
                          {actionLabel(task.kind)}
                        </span>
                      </div>
                      <div className="mt-1 text-[11px] text-[#555]">
                        {task.kind === "infohub.sync" ? describeAction(task) : "重扫本机归档的日程表"}
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px] text-muted">
                        <span>{describeSchedule(task.schedule)}</span>
                        <span>
                          下次 {task.enabled ? formatAutomationTime(task.nextRunAt) : "—（已停用）"}
                        </span>
                        <span>上次 {task.lastRunAt ? formatAutomationTime(task.lastRunAt) : "从未"}</span>
                        {task.lastStatus && (
                          <span
                            className={`inline-flex items-center rounded-full border px-1.5 py-0.5 text-[9px] font-medium ${statusClass(task.lastStatus)}`}
                          >
                            {runStatusLabel(task.lastStatus)}
                          </span>
                        )}
                      </div>
                      {task.lastDetail && task.lastStatus && (
                        <div className="mt-1 break-words text-[10px] leading-4 text-[#666]">
                          {task.lastDetail}
                        </div>
                      )}
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
                        className="rounded-md border border-line px-2.5 py-1 text-[11px] hover:bg-[#fafafa]"
                      >
                        {task.enabled ? "停用" : "启用"}
                      </button>
                      <button
                        type="button"
                        aria-label={`编辑 ${task.name}`}
                        onClick={() => openEdit(task)}
                        className="rounded-md border border-line px-2.5 py-1 text-[11px] hover:bg-[#fafafa]"
                      >
                        编辑
                      </button>
                      <button
                        type="button"
                        aria-label={`删除 ${task.name}`}
                        onClick={() => setDeleteTarget(task)}
                        className="flex items-center gap-1 rounded-md border border-line px-2.5 py-1 text-[11px] text-[#b42318] hover:bg-[#fdf3f2]"
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
        )}
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
                className="rounded-lg border border-line px-3 py-1.5 text-[12px] hover:bg-[#fafafa]"
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
                className="rounded-lg bg-[#b42318] px-3 py-1.5 text-[12px] font-medium text-white hover:bg-[#912018]"
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
    </div>
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
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={taskId ? "编辑自动化" : "新建自动化"}
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[88vh] w-[min(600px,94vw)] flex-col overflow-hidden rounded-xl border border-[#ececec] bg-white shadow-card"
      >
        <div className="flex items-center justify-between gap-3 border-b border-line-soft px-4 py-2.5">
          <span className="truncate text-[13px] font-bold">{taskId ? "编辑自动化" : "新建自动化"}</span>
          <button
            type="button"
            onClick={onClose}
            className="rounded px-2 py-0.5 text-[11px] text-muted hover:bg-[#f2f2f2] hover:text-ink"
          >
            关闭
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-auto px-4 py-3">
          <label className="block text-[11px] font-medium text-[#555]" htmlFor="automation-name">
            名称
          </label>
          <input
            id="automation-name"
            ref={nameRef}
            value={draft.name}
            onChange={(e) => setDraft((current) => ({ ...current, name: e.target.value }))}
            className="mt-1 w-full rounded-md border border-line px-2.5 py-1.5 text-[12px] outline-none focus:border-[#bbb]"
          />

          <label className="mt-3 block text-[11px] font-medium text-[#555]" htmlFor="automation-kind">
            动作
          </label>
          <select
            id="automation-kind"
            value={draft.kind}
            onChange={(e) =>
              setDraft((current) => ({
                ...current,
                kind: e.target.value === "infohub.agenda" ? "infohub.agenda" : "infohub.sync",
              }))
            }
            className="mt-1 w-full rounded-md border border-line bg-white px-2.5 py-1.5 text-[12px] outline-none focus:border-[#bbb]"
          >
            <option value="infohub.sync">{actionLabel("infohub.sync")}</option>
            <option value="infohub.agenda">{actionLabel("infohub.agenda")}</option>
          </select>

          {draft.kind === "infohub.sync" && (
            <div className="mt-2 rounded-lg border border-line-soft bg-panel p-3">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[11px]">
                <span className="font-medium text-[#555]">同步选项</span>
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

          <div className="mt-4 text-[11px] font-medium text-[#555]">触发方式</div>
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
                schedule.type === "daily" ? "border-ink bg-ink text-white" : "border-line hover:bg-[#fafafa]"
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
                schedule.type === "interval" ? "border-ink bg-ink text-white" : "border-line hover:bg-[#fafafa]"
              }`}
            >
              按间隔
            </button>
          </div>

          {schedule.type === "daily" ? (
            <div className="mt-2">
              <div className="flex flex-wrap items-center gap-2">
                <label className="text-[11px] text-[#555]" htmlFor="automation-time">
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
                  className="rounded-md border border-line px-2 py-1 text-[12px] outline-none focus:border-[#bbb]"
                />
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <span className="mr-1 text-[11px] text-[#555]">星期</span>
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
                          : "border-line text-[#666] hover:bg-[#fafafa]"
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
              <label className="text-[11px] text-[#555]" htmlFor="automation-interval">
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
                className="w-24 rounded-md border border-line px-2 py-1 text-[12px] outline-none focus:border-[#bbb]"
              />
              <span className="text-[10px] text-muted">
                {MIN_INTERVAL_MINUTES}–{MAX_INTERVAL_MINUTES} 分钟
              </span>
            </div>
          )}

          <p className="mt-2 text-[10px] leading-4 text-muted">
            下次执行：{formatAutomationTime(preview)}（保存后按此刻重新排期）
          </p>

          <div className="mt-4 rounded-lg border border-line-soft bg-[#fffdf5] p-3 text-[10px] leading-5 text-[#8a6d3b]">
            执行前提：桌面端且信息中枢已连接。未连接时任务记为跳过并顺延，不会自动拉起本机进程；
            和鸣关闭期间错过的时刻不会补跑。
          </div>

          {error && <p className="mt-2 text-[11px] text-[#b42318]">{error}</p>}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-line-soft px-4 py-2.5">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-line px-3 py-1.5 text-[12px] hover:bg-[#fafafa]"
          >
            取消
          </button>
          <button
            type="button"
            onClick={save}
            className="rounded-lg bg-ink px-3 py-1.5 text-[12px] font-medium text-white hover:opacity-90"
          >
            保存
          </button>
        </div>
      </div>
    </div>
  );
}
