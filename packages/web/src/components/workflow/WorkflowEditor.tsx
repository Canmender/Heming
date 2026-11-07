/**
 * 工作流编辑器：工具栏 + 画布 + 右侧节点详情，是「搭流程」的主界面。
 *
 * 编辑器持有一份**本地草稿**（`draft`），只有点保存才写回仓库：
 * 拖节点、改参数、连线都是高频操作，每一下都落盘会让撤销栈与存储读写变得难以收拾。
 * 因此这里有一套最小的撤销/重做（画布级历史），保存时才生成新版本号。
 *
 * 运行状态从引擎的 `onEvent` 回填到节点描边：nodeStart → running，
 * nodeFinish → success/error。事件里不带数据（控制体积），详情面板要数据就
 * 读 executionFinish 里的完整执行记录。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  addConnection,
  canRunWorkflow,
  createNode,
  removeNode,
  renameNode,
  validateWorkflow,
} from "../../lib/workflow/model.js";
import { useWorkflowStore } from "../../lib/workflow/store.js";
import { useWorkflowExecutionsStore } from "../../lib/workflow/executions.js";
import { createWorkflowRuntime, type WorkflowRuntime } from "../../lib/workflow/runtime.js";
import type { EngineEvent } from "../../lib/workflow/engine/index.js";
import type { Workflow, WorkflowExecution } from "../../lib/workflow/types.js";
import { ConfirmDialog } from "../ConfirmDialog.js";
import { WorkflowCanvas } from "./canvas/Canvas.js";
import { NodePalette } from "./NodePalette.js";
import { NodeDetailPanel } from "./NodeDetailPanel.js";
import { ExecutionsPanel, collectRunInputItems } from "./ExecutionsPanel.js";
import { ExportDialog, ImportDialog } from "./TransferDialogs.js";

/** 与 Canvas 契约一致的运行态（本地声明，避免依赖 canvas 的额外类型导出）。 */
type NodeRunVisual = "idle" | "running" | "success" | "error";

export interface WorkflowEditorProps {
  workflow: Workflow;
  /** 返回列表（页面切换）。 */
  onBack: () => void;
  /** 文件级操作（导入）由页面处理时用；不传则编辑器自己选中导入结果。 */
  onImported?: (workflow: Workflow) => void;
}

interface EditorState {
  draft: Workflow;
  past: Workflow[];
  future: Workflow[];
}

/** 深拷贝一条工作流作为编辑草稿（节点参数是嵌套对象，不能共享引用）。 */
function cloneForEdit(workflow: Workflow): Workflow {
  return {
    ...workflow,
    tags: [...workflow.tags],
    nodes: workflow.nodes.map((node) => ({
      ...node,
      position: { ...node.position },
      parameters: JSON.parse(JSON.stringify(node.parameters ?? {})) as Record<string, unknown>,
      ...(node.credentials ? { credentials: { ...node.credentials } } : {}),
      ...(node.pinData
        ? { pinData: JSON.parse(JSON.stringify(node.pinData)) as NonNullable<typeof node.pinData> }
        : {}),
    })),
    connections: JSON.parse(JSON.stringify(workflow.connections)) as Workflow["connections"],
    settings: { ...workflow.settings },
  };
}

type RunStateMap = Record<string, { state: NodeRunVisual; itemCount?: number }>;

const EMPTY_RUN_STATE: RunStateMap = {};

const MAX_HISTORY = 50;

export function WorkflowEditor({ workflow, onBack, onImported }: WorkflowEditorProps) {
  const saveWorkflow = useWorkflowStore((state) => state.save);
  const setActive = useWorkflowStore((state) => state.setActive);
  const select = useWorkflowStore((state) => state.select);

  const [editor, setEditor] = useState<EditorState>(() => ({
    draft: cloneForEdit(workflow),
    past: [],
    future: [],
  }));
  /** 当前草稿对应的「已保存版本」；外部保存/导入后据此重置草稿。 */
  const [baseline, setBaseline] = useState<Workflow>(() => cloneForEdit(workflow));
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [openNodeId, setOpenNodeId] = useState<string | null>(null);
  const [palette, setPalette] = useState<{ open: boolean; position: { x: number; y: number } }>({
    open: false,
    position: { x: 240, y: 200 },
  });
  const [nodeRunState, setNodeRunState] = useState<RunStateMap>(EMPTY_RUN_STATE);
  const [running, setRunning] = useState(false);
  const [runningNodeId, setRunningNodeId] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [executionsOpen, setExecutionsOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [leaveOpen, setLeaveOpen] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const runtimeRef = useRef<WorkflowRuntime | null>(null);

  const draft = editor.draft;
  const executions = useWorkflowExecutionsStore((state) => state.executions);
  const latestExecution = useMemo(
    () => executions.find((execution) => execution.workflowId === workflow.id) ?? null,
    [executions, workflow.id],
  );
  const [lastExecution, setLastExecution] = useState<WorkflowExecution | null>(latestExecution);

  // 仓库里的这条工作流被外部更新（保存/导入/别的页面改启停）时同步草稿。
  useEffect(() => {
    if (workflow.versionId === baseline.versionId && workflow.updatedAt === baseline.updatedAt) return;
    const next = cloneForEdit(workflow);
    setEditor({ draft: next, past: [], future: [] });
    setBaseline(cloneForEdit(workflow));
  }, [workflow, baseline.versionId, baseline.updatedAt]);

  // 切换工作流时把运行态/选中态清掉，避免把上一条的描边带到新画布上。
  useEffect(() => {
    setNodeRunState(EMPTY_RUN_STATE);
    setSelectedIds([]);
    setOpenNodeId(null);
    setLastExecution(
      useWorkflowExecutionsStore
        .getState()
        .executions.find((execution) => execution.workflowId === workflow.id) ?? null,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workflow.id]);

  const dirty = useMemo(
    () => JSON.stringify(draft) !== JSON.stringify(baseline),
    [draft, baseline],
  );

  const node = openNodeId ? draft.nodes.find((item) => item.id === openNodeId) : undefined;
  const nodeRuns = node ? (lastExecution?.runData?.[node.id] ?? []) : [];

  /** 提交一次草稿修改（同时把上一版压进撤销栈）。 */
  const apply = useCallback((mutator: (current: Workflow) => Workflow) => {
    setEditor((current) => ({
      draft: mutator(cloneForEdit(current.draft)),
      past: [...current.past.slice(-(MAX_HISTORY - 1)), cloneForEdit(current.draft)],
      future: [],
    }));
  }, []);

  function pushNotice(message: string): void {
    setNotice(message);
    setError("");
  }

  function saveDraft(): boolean {
    const result = saveWorkflow(draft.id, draft);
    if (!result.ok) {
      setError(result.error);
      return false;
    }
    setEditor({ draft: cloneForEdit(result.workflow), past: [], future: [] });
    setBaseline(cloneForEdit(result.workflow));
    pushNotice(
      `已保存（${new Date(result.workflow.updatedAt).toLocaleTimeString("zh-CN", { hour12: false })}）。`,
    );
    return true;
  }

  function undo(): void {
    setEditor((current) => {
      const previous = current.past[current.past.length - 1];
      if (!previous) return current;
      return {
        draft: cloneForEdit(previous),
        past: current.past.slice(0, -1),
        future: [cloneForEdit(current.draft), ...current.future].slice(0, MAX_HISTORY),
      };
    });
  }

  function redo(): void {
    setEditor((current) => {
      const next = current.future[0];
      if (!next) return current;
      return {
        draft: cloneForEdit(next),
        past: [...current.past.slice(-(MAX_HISTORY - 1)), cloneForEdit(current.draft)],
        future: current.future.slice(1),
      };
    });
  }

  function updateNode(nodeId: string, patch: Partial<Workflow["nodes"][number]>): void {
    apply((current) => {
      const target = current.nodes.find((item) => item.id === nodeId);
      if (!target) return current;
      for (const [key, value] of Object.entries(patch)) {
        if (key === "name" && typeof value === "string") {
          renameNode(current, nodeId, value);
          continue;
        }
        const record = target as unknown as Record<string, unknown>;
        if (value === undefined) delete record[key];
        else record[key] = value;
      }
      return current;
    });
  }

  function handleEngineEvent(event: EngineEvent): void {
    if (event.type === "nodeStart") {
      setNodeRunState((current) => ({ ...current, [event.nodeId]: { state: "running" } }));
    } else if (event.type === "nodeFinish") {
      setNodeRunState((current) => ({
        ...current,
        [event.nodeId]: {
          state: event.status === "error" ? "error" : event.status === "waiting" ? "running" : "success",
          itemCount: event.itemsTotal,
        },
      }));
    } else if (event.type === "executionFinish") {
      setLastExecution(event.execution);
      setRunning(false);
      setRunningNodeId(null);
      const status = event.execution.status;
      const message =
        status === "success"
          ? `运行完成，用时 ${Math.round(event.execution.durationMs ?? 0)} 毫秒。`
          : status === "canceled"
            ? "已停止。"
            : `运行失败：${event.execution.error?.message ?? "未知错误"}`;
      if (status === "error") setError(message);
      else pushNotice(message);
    }
  }

  async function runAll(): Promise<void> {
    if (running) return;
    const issues = validateWorkflow(draft).filter((issue) => issue.level === "error");
    if (issues.length > 0) {
      setError(issues.map((issue) => issue.message).join("；"));
      return;
    }
    if (!canRunWorkflow(draft)) {
      setError("工作流还有错误，先修正后再运行。");
      return;
    }
    runtimeRef.current ??= createWorkflowRuntime();
    const controller = new AbortController();
    abortRef.current = controller;
    setRunning(true);
    setError("");
    setNodeRunState(EMPTY_RUN_STATE);
    pushNotice("正在运行…");
    try {
      const execution = await runtimeRef.current.run(draft, {
        mode: "manual",
        abortSignal: controller.signal,
        onEvent: handleEngineEvent,
      });
      // 引擎把所有终态都放进 execution；事件缺失时也兜底更新一次界面。
      if (execution.status !== "running") {
        setLastExecution(execution);
        setRunning(false);
      }
    } catch (err) {
      setError(`运行失败：${err instanceof Error ? err.message : String(err)}`);
      setRunning(false);
    } finally {
      abortRef.current = null;
    }
  }

  async function runSingleNode(nodeId: string): Promise<void> {
    if (running) return;
    const target = draft.nodes.find((item) => item.id === nodeId);
    if (!target) return;
    runtimeRef.current ??= createWorkflowRuntime();
    const controller = new AbortController();
    abortRef.current = controller;
    setRunning(true);
    setRunningNodeId(nodeId);
    setNodeRunState({ [nodeId]: { state: "running" } });
    setError("");
    try {
      const inputItems = collectRunInputItems(lastExecution, nodeId);
      const execution = await runtimeRef.current.run(draft, {
        mode: "partial",
        startNodeId: nodeId,
        inputData: { main: [inputItems] },
        abortSignal: controller.signal,
        onEvent: handleEngineEvent,
      });
      setLastExecution(execution);
      pushNotice(
        execution.status === "success"
          ? `「${target.name}」执行完成。`
          : `「${target.name}」执行失败：${execution.error?.message ?? "未知错误"}`,
      );
    } catch (err) {
      setError(`执行节点失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setRunning(false);
      setRunningNodeId(null);
      abortRef.current = null;
    }
  }

  function stop(): void {
    abortRef.current?.abort();
    pushNotice("正在停止…");
  }

  // 键盘快捷键：Ctrl/Cmd+S 保存、Ctrl/Cmd+Enter 运行、Esc 关面板、Ctrl/Cmd+Z 撤销。
  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      const mod = event.metaKey || event.ctrlKey;
      if (mod && event.key.toLowerCase() === "s") {
        event.preventDefault();
        saveDraft();
        return;
      }
      if (mod && event.key === "Enter") {
        event.preventDefault();
        void runAll();
        return;
      }
      if (mod && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
        return;
      }
      if (mod && event.key.toLowerCase() === "y") {
        event.preventDefault();
        redo();
        return;
      }
      if (event.key === "Escape") {
        setPalette((current) => (current.open ? { ...current, open: false } : current));
        setOpenNodeId(null);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
    // 依赖草稿/基线/运行态：闭包需要最新的它们，重建监听的成本可以忽略。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, baseline, running, lastExecution]);

  function goBack(): void {
    if (dirty) {
      setLeaveOpen(true);
      return;
    }
    onBack();
  }

  function toggleActive(next: boolean): void {
    const result = setActive(draft.id, next);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setEditor((current) => ({ ...current, draft: { ...current.draft, active: next } }));
    pushNotice(next ? "已启用；定时触发会在后台执行。" : "已停用。");
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line-soft px-4 py-2">
        <button type="button" onClick={goBack} className="ui-btn ui-btn-sm ui-btn-ghost">
          返回
        </button>
        <input
          aria-label="工作流名称"
          value={draft.name}
          onChange={(event) => setEditor((current) => ({ ...current, draft: { ...current.draft, name: event.target.value } }))}
          className="ui-input w-[220px] text-[13px]"
        />
        {dirty ? <span className="ui-chip border-[#fed7aa] text-[#b45309]">未保存</span> : null}
        <span className="mx-1 h-5 w-px bg-[color:var(--line)]" aria-hidden="true" />
        <button type="button" onClick={saveDraft} className="ui-btn ui-btn-sm ui-btn-primary">
          保存
        </button>
        <button
          type="button"
          onClick={() => void runAll()}
          disabled={running}
          className="ui-btn ui-btn-sm ui-btn-ghost"
        >
          {running ? "运行中…" : "运行"}
        </button>
        <button type="button" onClick={stop} disabled={!running} className="ui-btn ui-btn-sm ui-btn-ghost">
          停止
        </button>
        <button
          type="button"
          onClick={undo}
          disabled={editor.past.length === 0}
          className="ui-btn ui-btn-sm ui-btn-ghost"
        >
          撤销
        </button>
        <button
          type="button"
          onClick={redo}
          disabled={editor.future.length === 0}
          className="ui-btn ui-btn-sm ui-btn-ghost"
        >
          重做
        </button>
        <button type="button" onClick={() => setExportOpen(true)} className="ui-btn ui-btn-sm ui-btn-ghost">
          导出
        </button>
        <button type="button" onClick={() => setImportOpen(true)} className="ui-btn ui-btn-sm ui-btn-ghost">
          导入
        </button>
        <button
          type="button"
          onClick={() => setExecutionsOpen(true)}
          className="ui-btn ui-btn-sm ui-btn-ghost"
        >
          执行记录
        </button>
        <span className="ml-auto flex items-center gap-2">
          <span className="ui-caption">启用</span>
          <input
            type="checkbox"
            aria-label="启用工作流"
            checked={draft.active}
            onChange={(event) => toggleActive(event.target.checked)}
          />
          <span className="ui-caption">滚轮缩放，空格拖动平移</span>
        </span>
      </div>

      {error ? (
        <p role="alert" className="ui-alert ui-alert-danger mx-4 mt-2 justify-between">
          <span className="min-w-0 break-words">{error}</span>
          <button type="button" onClick={() => setError("")} className="shrink-0 hover:underline">
            关闭
          </button>
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="ui-alert ui-alert-muted mx-4 mt-2 justify-between">
          <span className="min-w-0 break-words">{notice}</span>
          <button type="button" onClick={() => setNotice("")} className="shrink-0 hover:underline">
            关闭
          </button>
        </p>
      ) : null}

      <div className="flex min-h-0 flex-1">
        <div className="relative min-w-0 flex-1">
          <WorkflowCanvas
            workflow={draft}
            selectedIds={selectedIds}
            nodeRunState={nodeRunState}
            onSelectionChange={setSelectedIds}
            onMoveNodes={(moves: Array<{ id: string; position: { x: number; y: number } }>) =>
              apply((current) => {
                for (const move of moves) {
                  const target = current.nodes.find((item) => item.id === move.id);
                  if (target) target.position = { ...move.position };
                }
                return current;
              })
            }
            onConnect={(input: {
              sourceId: string;
              sourceOutput: number;
              targetId: string;
              targetInput: number;
            }) =>
              apply((current) => {
                addConnection(current, input.sourceId, input.sourceOutput, input.targetId, input.targetInput);
                return current;
              })
            }
            onRequestDelete={(ids: string[]) =>
              apply((current) => {
                for (const id of ids) removeNode(current, id);
                return current;
              })
            }
            onOpenNode={(nodeId: string) => setOpenNodeId(nodeId)}
            onRequestAddNode={(position: { x: number; y: number }) => setPalette({ open: true, position })}
            onCanvasDoubleClick={(position: { x: number; y: number }) =>
              setPalette({ open: true, position })
            }
          />
        </div>

        {node ? (
          <NodeDetailPanel
            workflow={draft}
            node={node}
            runData={nodeRuns}
            execution={lastExecution}
            running={running && runningNodeId === node.id}
            onChange={(patch) => updateNode(node.id, patch)}
            onClose={() => setOpenNodeId(null)}
            onRunNode={() => void runSingleNode(node.id)}
          />
        ) : null}
      </div>

      <NodePalette
        open={palette.open}
        onClose={() => setPalette((current) => ({ ...current, open: false }))}
        onPick={(type: string) => {
          const spec = createNode(type, { workflow: draft, position: palette.position });
          apply((current) => {
            current.nodes = [...current.nodes, spec];
            return current;
          });
          setPalette((current) => ({ ...current, open: false }));
          setOpenNodeId(spec.id);
        }}
      />

      {executionsOpen ? (
        <div className="fixed inset-0 z-40 flex justify-end bg-black/20" onClick={() => setExecutionsOpen(false)}>
          <div
            className="flex h-full w-[min(860px,94vw)] flex-col bg-white p-3 shadow-card"
            role="dialog"
            aria-modal="true"
            aria-label="执行记录"
            onClick={(event) => event.stopPropagation()}
          >
            <ExecutionsPanel
              onClose={() => setExecutionsOpen(false)}
              onRerun={(execution) => {
                setExecutionsOpen(false);
                const target = useWorkflowStore
                  .getState()
                  .workflows.find((item) => item.id === execution.workflowId);
                if (!target) {
                  setError("这条记录对应的工作流已被删除。");
                  return;
                }
                select(target.id);
                setEditor({ draft: cloneForEdit(target), past: [], future: [] });
                setBaseline(cloneForEdit(target));
                pushNotice(`已切到「${target.name}」，点运行即可重跑。`);
              }}
            />
          </div>
        </div>
      ) : null}

      <ExportDialog workflow={exportOpen ? draft : null} onClose={() => setExportOpen(false)} />
      <ImportDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onImported={(imported) => {
          setImportOpen(false);
          if (dirty) {
            setError("当前有未保存的修改；已导入到列表，请先保存或返回后再打开。");
            return;
          }
          if (onImported) onImported(imported);
          else select(imported.id);
        }}
      />

      {leaveOpen ? (
        <ConfirmDialog
          title="离开编辑器"
          onCancel={() => setLeaveOpen(false)}
          footer={
            <>
              <button type="button" onClick={() => setLeaveOpen(false)} className="ui-btn ui-btn-md ui-btn-ghost">
                继续编辑
              </button>
              <button
                type="button"
                onClick={() => {
                  setLeaveOpen(false);
                  onBack();
                }}
                className="ui-btn ui-btn-md ui-btn-danger"
              >
                放弃修改并返回
              </button>
            </>
          }
        >
          <p>有未保存的修改，返回后这些修改会丢失。要先保存吗？</p>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              onClick={() => {
                if (saveDraft()) {
                  setLeaveOpen(false);
                  onBack();
                }
              }}
              className="ui-btn ui-btn-md ui-btn-primary"
            >
              保存并返回
            </button>
          </div>
        </ConfirmDialog>
      ) : null}
    </div>
  );
}
