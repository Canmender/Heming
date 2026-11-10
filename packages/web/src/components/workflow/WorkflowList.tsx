/**
 * 工作流列表：卡片式清单 + 搜索 + 新建/导入/导出/复制/删除/启停。
 *
 * 为什么用卡片而不是表格：工作流之间不是同构数据（有的有定时、有的有最近失败），
 * 卡片能按需展示「节点数 / 触发器 / 下次运行 / 最近执行状态」这些非必填字段，
 * 窄窗下也不会横向滚动。
 *
 * 列表里的「启用」开关直接改 `active`：调度器 15 秒轮询一次，开关之后最多 15 秒
 * 生效；启用时会把 lastRunAt 推到当前时刻（停用很久再启用不会立刻补跑）。
 */

import { useMemo, useState } from "react";
import { workflowSummary } from "../../lib/workflow/model.js";
import { nextWorkflowRun } from "../../lib/workflow/scheduler.js";
import { useWorkflowStore } from "../../lib/workflow/store.js";
import { useWorkflowExecutionsStore } from "../../lib/workflow/executions.js";
import type { Workflow, WorkflowExecution } from "../../lib/workflow/types.js";
import { Switch } from "../plugins/shared.js";
import { ConfirmDialog } from "../ConfirmDialog.js";
import { EmptyState } from "../ui/EmptyState.js";
import { DownloadIcon, PlusIcon, SearchIcon, TrashIcon } from "../icons.js";
import { ExportDialog, ImportDialog, NewWorkflowDialog } from "./TransferDialogs.js";

export interface WorkflowListProps {
  /** 页面在选中工作流后进入编辑器；列表内部调用 store.select 即可，这里只作通知。 */
  onOpen?: (workflow: Workflow) => void;
}

const STATUS_LABEL: Record<WorkflowExecution["status"], string> = {
  new: "新建",
  running: "运行中",
  success: "上次成功",
  error: "上次失败",
  canceled: "上次取消",
  waiting: "等待中",
};

const STATUS_CLASS: Record<WorkflowExecution["status"], string> = {
  new: "border-line bg-panel text-muted",
  running: "border-[var(--info-line)] bg-[var(--info-soft)] text-[var(--info)]",
  success: "border-[var(--success-line)] bg-[var(--success-soft)] text-[var(--success)]",
  error: "border-[var(--danger-line)] bg-[var(--danger-soft)] text-[var(--danger)]",
  canceled: "border-line bg-panel text-muted",
  waiting: "border-[var(--warn-line)] bg-[var(--warn-soft)] text-[var(--warn)]",
};

function formatTime(at: number | undefined): string {
  if (!at) return "—";
  return new Date(at).toLocaleString("zh-CN", { hour12: false });
}

export function WorkflowList({ onOpen }: WorkflowListProps) {
  const workflows = useWorkflowStore((state) => state.workflows);
  const select = useWorkflowStore((state) => state.select);
  const setActive = useWorkflowStore((state) => state.setActive);
  const duplicate = useWorkflowStore((state) => state.duplicate);
  const remove = useWorkflowStore((state) => state.remove);
  const executions = useWorkflowExecutionsStore((state) => state.executions);

  const [query, setQuery] = useState("");
  const [newOpen, setNewOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [exportTarget, setExportTarget] = useState<Workflow | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Workflow | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return workflows;
    return workflows.filter((workflow) =>
      [workflow.name, workflow.description ?? "", ...workflow.tags]
        .join("\n")
        .toLowerCase()
        .includes(keyword),
    );
  }, [workflows, query]);

  /** 每条工作流最近一次执行（最新在前，取第一条）。 */
  const lastExecutionOf = useMemo(() => {
    const map = new Map<string, WorkflowExecution>();
    for (const execution of executions) {
      if (!map.has(execution.workflowId)) map.set(execution.workflowId, execution);
    }
    return map;
  }, [executions]);

  function openWorkflow(workflow: Workflow): void {
    select(workflow.id);
    onOpen?.(workflow);
  }

  function toggleActive(workflow: Workflow, active: boolean): void {
    const result = setActive(workflow.id, active);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setError("");
    setNotice(active ? "已启用；到点后由调度器自动运行。" : "已停用；不会再被定时触发。");
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <label className="relative min-w-[220px] flex-1">
          <span className="sr-only">搜索工作流</span>
          <SearchIcon
            width={14}
            height={14}
            aria-hidden="true"
            className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-muted"
          />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索名称、说明或标签"
            className="ui-input w-full pl-7 text-[12px]"
          />
        </label>
        <button type="button" onClick={() => setNewOpen(true)} className="ui-btn ui-btn-md ui-btn-primary">
          <PlusIcon width={14} height={14} />
          新建工作流
        </button>
        <button type="button" onClick={() => setImportOpen(true)} className="ui-btn ui-btn-md ui-btn-ghost">
          导入
        </button>
      </div>

      {error ? (
        <p role="alert" className="ui-alert ui-alert-danger">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="ui-alert ui-alert-muted">
          {notice}
        </p>
      ) : null}

      {workflows.length === 0 ? (
        <EmptyState
          title="还没有工作流"
          desc="从空白画布开始，或选一个起手模板：手动触发、定时触发、HTTP 请求、代码与分支都能直接拖。"
          actions={
            <button type="button" onClick={() => setNewOpen(true)} className="ui-btn ui-btn-md ui-btn-primary">
              新建工作流
            </button>
          }
        />
      ) : filtered.length === 0 ? (
        <EmptyState compact title="没有匹配的工作流" desc="换个关键词试试，或清空搜索。" />
      ) : (
        <ul className="flex flex-col gap-2" aria-label="工作流列表">
          {filtered.map((workflow) => {
            const summary = workflowSummary(workflow);
            const next = workflow.active ? nextWorkflowRun(workflow) : null;
            const last = lastExecutionOf.get(workflow.id);
            return (
              <li key={workflow.id} className="ui-card px-4 py-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <button
                      type="button"
                      onClick={() => openWorkflow(workflow)}
                      className="block max-w-full truncate text-left text-[14px] font-medium hover:underline"
                    >
                      {workflow.name}
                    </button>
                    {workflow.description ? (
                      <p className="ui-caption mt-0.5 line-clamp-2">{workflow.description}</p>
                    ) : null}
                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
                      <span className="ui-caption">
                        {summary.nodes} 个节点 · {summary.links} 条连接
                        {summary.triggers > 0 ? ` · ${summary.triggers} 个触发器` : ""}
                      </span>
                      <span className="ui-caption">更新于 {formatTime(workflow.updatedAt)}</span>
                      {next ? (
                        <span className="ui-caption">下次运行：{formatTime(next.getTime())}</span>
                      ) : workflow.active ? (
                        <span className="ui-caption">已启用但没法定时（缺定时触发器）</span>
                      ) : null}
                      {last ? (
                        <span
                          className={`rounded-sm border px-1.5 py-0.5 text-[10px] ${STATUS_CLASS[last.status]}`}
                        >
                          {STATUS_LABEL[last.status]} · {formatTime(last.startedAt)}
                        </span>
                      ) : null}
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center gap-1">
                    <span className="ui-caption mr-1">启用</span>
                    <Switch
                      label={`启用工作流 ${workflow.name}`}
                      checked={workflow.active}
                      onChange={(active) => toggleActive(workflow, active)}
                    />
                    <button
                      type="button"
                      onClick={() => openWorkflow(workflow)}
                      className="ui-btn ui-btn-sm ui-btn-ghost"
                    >
                      编辑
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        const result = duplicate(workflow.id);
                        if (!result.ok) setError(result.error);
                        else {
                          setError("");
                          setNotice(`已复制为「${result.workflow.name}」`);
                        }
                      }}
                      className="ui-btn ui-btn-sm ui-btn-ghost"
                    >
                      复制
                    </button>
                    <button
                      type="button"
                      onClick={() => setExportTarget(workflow)}
                      className="ui-btn ui-btn-sm ui-btn-ghost"
                      aria-label={`导出工作流 ${workflow.name}`}
                    >
                      <DownloadIcon width={13} height={13} />
                    </button>
                    <button
                      type="button"
                      onClick={() => setDeleteTarget(workflow)}
                      className="ui-btn ui-btn-sm ui-btn-ghost text-[var(--danger)]"
                      aria-label={`删除工作流 ${workflow.name}`}
                    >
                      <TrashIcon width={13} height={13} />
                    </button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <NewWorkflowDialog
        open={newOpen}
        onClose={() => setNewOpen(false)}
        onPick={(template) => {
          setNewOpen(false);
          const result = useWorkflowStore.getState().create({ from: template, name: template.name });
          if (!result.ok) setError(result.error);
          else {
            setError("");
            setNotice(`已创建「${result.workflow.name}」。`);
            onOpen?.(result.workflow);
          }
        }}
      />
      <ImportDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onImported={(workflow) => {
          setImportOpen(false);
          setNotice(`已导入「${workflow.name}」。`);
          openWorkflow(workflow);
        }}
      />
      <ExportDialog workflow={exportTarget} onClose={() => setExportTarget(null)} />

      {deleteTarget ? (
        <ConfirmDialog
          title="删除工作流"
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
                  remove(deleteTarget.id);
                  setDeleteTarget(null);
                  setNotice(`已删除「${deleteTarget.name}」及其执行记录。`);
                }}
                className="ui-btn ui-btn-md ui-btn-danger"
              >
                删除
              </button>
            </>
          }
        >
          <p>
            确定删除工作流「{deleteTarget.name}」吗？它的执行记录也会一并删除，且无法恢复。
            建议先导出备份。
          </p>
        </ConfirmDialog>
      ) : null}
    </div>
  );
}
