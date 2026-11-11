/**
 * 执行记录面板：看历史、看每次执行里每个节点的输入输出、重跑、清理。
 *
 * 为什么详情要「逐节点 + 输入/输出」：工作流出问题时用户最想知道的是
 * 「哪一步没拿到数据」。只显示最终错误不够——错误往往在最后一个节点，
 * 根因在中间某一步的输入是空数组。输入数据从上游节点的输出推出来
 * （引擎的 runData 只存输出），这也是调试时最直接的还原方式。
 */

import { useState } from "react";
import { useWorkflowExecutionsStore } from "../../lib/workflow/executions";
import {
  WORKFLOW_LIMITS,
  type Item,
  type NodeRunData,
  type WorkflowExecution,
  type WorkflowNode,
} from "../../lib/workflow/types";
import { useWorkflowStore } from "../../lib/workflow/store";
import { ConfirmDialog } from "@heming/sdk";
import { EmptyState } from "@heming/sdk";
import { DataPreview } from "./DataPreview";
import { TrashIcon } from "@heming/sdk";

export interface ExecutionsPanelProps {
  /** 重跑某次执行对应的工作流（页面/编辑器提供）。 */
  onRerun?: (execution: WorkflowExecution) => void;
  /** 关闭（放在抽屉里时用；整页 Tab 里不传）。 */
  onClose?: () => void;
  className?: string;
}

const STATUS_LABEL: Record<WorkflowExecution["status"], string> = {
  new: "新建",
  running: "运行中",
  success: "成功",
  error: "失败",
  canceled: "已取消",
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

const MODE_LABEL: Record<WorkflowExecution["mode"], string> = {
  manual: "手动",
  trigger: "定时",
  retry: "重试",
  subworkflow: "子流程",
  error: "错误处理",
  partial: "部分执行",
};

function formatTime(at: number): string {
  if (!Number.isFinite(at) || at <= 0) return "—";
  return new Date(at).toLocaleString("zh-CN", { hour12: false });
}

function formatDuration(ms: number | undefined): string {
  if (!ms || ms <= 0) return "不到 1 秒";
  if (ms < 1000) return `${Math.round(ms)} 毫秒`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)} 秒`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return rest > 0 ? `${minutes} 分 ${rest} 秒` : `${minutes} 分`;
}

/** 某节点这次运行的输入：由上游节点的输出拼出来（runData 只存输出）。 */
export function collectRunInputItems(
  execution: WorkflowExecution | null | undefined,
  nodeId: string,
): Item[] {
  const runs = execution?.runData?.[nodeId];
  if (!runs || runs.length === 0) return [];
  const latest = runs[runs.length - 1];
  const items: Item[] = [];
  for (const source of latest?.source ?? []) {
    if (!source.previousNode) continue;
    const upstreamRuns = execution?.runData?.[source.previousNode];
    const upstream = upstreamRuns?.[upstreamRuns.length - 1];
    for (const list of upstream?.data?.main ?? []) {
      items.push(...(list ?? []));
    }
  }
  return items;
}

function nodeLabelOf(nodes: WorkflowNode[], nodeId: string): { name: string; type: string } {
  const node = nodes.find((item) => item.id === nodeId);
  return { name: node?.name ?? nodeId, type: node?.type ?? "未知类型" };
}

function RunEntry({ execution, nodeId, run, index }: { execution: WorkflowExecution; nodeId: string; run: NodeRunData; index: number }) {
  const input = index === run.executionIndex ? collectRunInputItems(execution, nodeId) : [];
  return (
    <details className="rounded-lg border border-line-soft">
      <summary className="flex cursor-pointer flex-wrap items-center gap-2 px-2 py-1.5 text-[12px]">
        <span
          className={`rounded-sm border px-1.5 py-0.5 text-[10px] ${
            run.status === "error"
              ? "border-[var(--danger-line)] bg-[var(--danger-soft)] text-[var(--danger)]"
              : "border-[var(--success-line)] bg-[var(--success-soft)] text-[var(--success)]"
          }`}
        >
          {run.status === "error" ? "失败" : run.status === "waiting" ? "等待" : "成功"}
        </span>
        <span className="text-muted">第 {run.executionIndex + 1} 次运行</span>
        <span className="text-muted">{formatDuration(run.executionTime)}</span>
        <span className="text-muted">{run.itemsTotal} 条数据</span>
      </summary>
      <div className="flex flex-col gap-2 border-t border-line-soft p-2">
        {run.error ? (
          <p className="ui-alert ui-alert-danger flex-col items-start">
            <span className="font-medium">{run.error.message}</span>
            {run.error.description ? <span>{run.error.description}</span> : null}
          </p>
        ) : null}
        <DataPreview
          title={`输入（${input.length} 条）`}
          data={input}
          compact
          emptyText="没有上游输入（可能是触发节点）。"
        />
        <DataPreview
          title={`输出（${run.itemsTotal} 条）`}
          data={run.data?.main ?? []}
          compact
          emptyText="这次运行没有输出，或工作流设置成不保存执行数据。"
        />
        {run.itemsTotal > WORKFLOW_LIMITS.maxItemsPerNodeRun ? (
          <p className="ui-caption">
            输出超过 {WORKFLOW_LIMITS.maxItemsPerNodeRun} 条，执行记录只保留了前{" "}
            {WORKFLOW_LIMITS.maxItemsPerNodeRun} 条。
          </p>
        ) : null}
      </div>
    </details>
  );
}

export function ExecutionsPanel({ onRerun, onClose, className = "" }: ExecutionsPanelProps) {
  const executions = useWorkflowExecutionsStore((state) => state.executions);
  const remove = useWorkflowExecutionsStore((state) => state.remove);
  const clear = useWorkflowExecutionsStore((state) => state.clear);
  const workflows = useWorkflowStore((state) => state.workflows);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [clearOpen, setClearOpen] = useState(false);

  const selected = executions.find((execution) => execution.id === selectedId) ?? executions[0];
  const nodes: WorkflowNode[] = selected
    ? (workflows.find((item) => item.id === selected.workflowId)?.nodes ?? [])
    : [];

  return (
    <div className={`flex min-h-0 flex-1 gap-4 ${className}`}>
      <div className="flex w-[300px] shrink-0 flex-col">
        <div className="mb-2 flex items-center justify-between gap-2">
          <span className="ui-section-title">执行记录</span>
          <div className="flex gap-1">
            {onClose ? (
              <button type="button" onClick={onClose} className="ui-btn ui-btn-sm ui-btn-ghost">
                关闭
              </button>
            ) : null}
            {executions.length > 0 ? (
              <button
                type="button"
                onClick={() => setClearOpen(true)}
                className="ui-btn ui-btn-sm ui-btn-ghost text-[var(--danger)]"
              >
                清空
              </button>
            ) : null}
          </div>
        </div>
        {executions.length === 0 ? (
          <EmptyState
            compact
            title="还没有执行记录"
            desc="手动运行、定时触发或子流程都会在这里留一条记录（只存本机）。"
          />
        ) : (
          <ul className="min-h-0 flex-1 overflow-y-auto pr-1" aria-label="执行记录列表">
            {executions.map((execution) => (
              <li key={execution.id} className="mb-1">
                <button
                  type="button"
                  onClick={() => setSelectedId(execution.id)}
                  aria-current={selected?.id === execution.id}
                  className={`w-full rounded-lg border px-2 py-1.5 text-left ${
                    selected?.id === execution.id
                      ? "border-[color:var(--line)] bg-[color:var(--panel)]"
                      : "border-transparent hover:bg-[var(--subtle-2)]"
                  }`}
                >
                  <span className="flex items-center justify-between gap-2">
                    <span className="truncate text-[12px] font-medium">{execution.workflowName}</span>
                    <span
                      className={`shrink-0 rounded-sm border px-1.5 py-0.5 text-[10px] ${STATUS_CLASS[execution.status]}`}
                    >
                      {STATUS_LABEL[execution.status]}
                    </span>
                  </span>
                  <span className="ui-caption mt-0.5 block">
                    {MODE_LABEL[execution.mode]} · {formatTime(execution.startedAt)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
        {!selected ? (
          <p className="ui-caption">选择左边的记录查看详情。</p>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="ui-section-title truncate">{selected.workflowName}</p>
                <p className="ui-caption">
                  {STATUS_LABEL[selected.status]} · {MODE_LABEL[selected.mode]} ·{" "}
                  {formatDuration(selected.durationMs)} · {formatTime(selected.startedAt)}
                  {selected.parentExecutionId ? ` · 父执行 ${selected.parentExecutionId}` : ""}
                </p>
              </div>
              <div className="flex shrink-0 gap-1">
                {onRerun ? (
                  <button
                    type="button"
                    onClick={() => onRerun(selected)}
                    className="ui-btn ui-btn-sm ui-btn-primary"
                  >
                    重跑
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={() => setDeleteTarget(selected.id)}
                  className="ui-btn ui-btn-sm ui-btn-ghost text-[var(--danger)]"
                  aria-label="删除这条执行记录"
                >
                  <TrashIcon width={13} height={13} />
                </button>
              </div>
            </div>

            {selected.error ? (
              <div role="alert" className="ui-alert ui-alert-danger flex-col items-start">
                <p className="font-medium">{selected.error.message}</p>
                {selected.error.description ? <p>{selected.error.description}</p> : null}
                {selected.error.nodeName ? <p>出错节点：{selected.error.nodeName}</p> : null}
              </div>
            ) : null}

            <DataPreview
              title={`触发数据（${selected.triggerData?.length ?? 0} 条）`}
              data={selected.triggerData ?? []}
              compact
              emptyText="这次执行没有触发数据（定时触发通常没有）。"
            />

            <div className="flex flex-col gap-2">
              <p className="ui-section-title">逐节点</p>
              {Object.keys(selected.runData).length === 0 ? (
                <p className="ui-caption">没有节点运行记录（可能一开始就失败了）。</p>
              ) : null}
              {Object.entries(selected.runData).map(([nodeId, runs]) => {
                const label = nodeLabelOf(nodes, nodeId);
                return (
                  <section key={nodeId} aria-label={`节点 ${label.name}`}>
                    <p className="mb-1 text-[12px] font-medium">
                      {label.name} <span className="ui-caption">（{label.type}）</span>
                    </p>
                    <div className="flex flex-col gap-1">
                      {runs.map((run, index) => (
                        <RunEntry
                          key={`${nodeId}-${run.executionIndex}-${index}`}
                          execution={selected}
                          nodeId={nodeId}
                          run={run}
                          index={index}
                        />
                      ))}
                    </div>
                  </section>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {deleteTarget ? (
        <ConfirmDialog
          title="删除执行记录"
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
                  remove(deleteTarget);
                  setDeleteTarget(null);
                }}
                className="ui-btn ui-btn-md ui-btn-danger"
              >
                删除
              </button>
            </>
          }
        >
          <p>删除后无法恢复，工作流本身不受影响。</p>
        </ConfirmDialog>
      ) : null}

      {clearOpen ? (
        <ConfirmDialog
          title="清空执行记录"
          onCancel={() => setClearOpen(false)}
          footer={
            <>
              <button
                type="button"
                onClick={() => setClearOpen(false)}
                className="ui-btn ui-btn-md ui-btn-ghost"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => {
                  clear();
                  setSelectedId(null);
                  setClearOpen(false);
                }}
                className="ui-btn ui-btn-md ui-btn-danger"
              >
                清空
              </button>
            </>
          }
        >
          <p>将删除全部 {executions.length} 条执行记录（只在本机，工作流不受影响）。</p>
        </ConfirmDialog>
      ) : null}
    </div>
  );
}
