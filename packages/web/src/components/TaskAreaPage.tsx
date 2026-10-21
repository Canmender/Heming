import { useEffect, useMemo, useRef, useState } from "react";
import { useChatStore } from "../store/chat.js";
import { useLlmStore } from "../store/llm.js";
import { useUiStore } from "../store/ui.js";
import {
  buildTaskJson,
  buildTaskReport,
  formatDuration,
  formatTaskTime,
  taskSources,
  taskStats,
  taskStatusLabel,
  taskStepStatusLabel,
  useTaskStore,
  type TaskRecord,
  type TaskStatus,
  type TaskStepStatus,
} from "../lib/tasks/store.js";
import {
  MAX_TEMPLATES,
  suggestTemplateName,
  useTemplateStore,
  type TaskTemplate,
} from "../lib/tasks/templates.js";
import { ChatPage } from "./ChatPage.js";
import { MarkdownMessage } from "./MarkdownMessage.js";
import { ConfirmDialog } from "./ConfirmDialog.js";
import { useModalA11y } from "./useModalA11y.js";
import { capabilityNotice } from "../lib/capabilityNotice.js";
import { PlusIcon, TaskIcon, TrashIcon } from "./icons.js";

/**
 * 任务区：把「一次智能体执行」当成一等公民。
 *
 * 布局借鉴 Codex/Claude Code 的任务视图，但**不照搬它们的执行模型**：
 * - 左列任务清单（状态/搜索/筛选）；
 * - 中间复用 ChatPage（消息、工具确认、E2E 全部沿用聊天链路，不另起一套发送逻辑）；
 * - 右列确定性汇总（目标、结果、步骤、来源、可复制的 Markdown 报告）。
 *
 * 数据只存本机：任务记录含工具参数摘要，不进消息库、不上云。
 */

type Filter = "all" | TaskStatus;

const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "全部" },
  { key: "running", label: "进行中" },
  { key: "done", label: "已完成" },
  { key: "failed", label: "失败" },
  { key: "cancelled", label: "已中断" },
];

/** 状态胶囊配色（无 emoji：用色块 + 文案区分）。 */
function statusClass(status: TaskStatus): string {
  switch (status) {
    case "running":
      return "border-[#d0d5dd] bg-[#f9fafb] text-[#475467]";
    case "done":
      return "border-[#bbf7d0] bg-[#f0fdf4] text-[#15803d]";
    case "failed":
      return "border-[#fecdca] bg-[#fef3f2] text-[#b42318]";
    case "cancelled":
      return "border-[#fed7aa] bg-[#fffbeb] text-[#b45309]";
  }
}

function stepClass(status: TaskStepStatus): string {
  switch (status) {
    case "running":
      return "text-muted";
    case "ok":
      return "text-[#15803d]";
    case "error":
      return "text-[#b42318]";
    case "denied":
      return "text-[#b45309]";
  }
}

/** 步骤时间线的圆点配色（与文字状态同源，避免两套判定漂移）。 */
function stepDotClass(status: TaskStepStatus): string {
  switch (status) {
    case "running":
      return "bg-[#98a2b3]";
    case "ok":
      return "bg-[#16a34a]";
    case "error":
      return "bg-[#dc2626]";
    case "denied":
      return "bg-[#d97706]";
  }
}

/** 运行中任务每秒刷新一次「已用时」；非运行态不挂定时器。 */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

/** 三段式进度：创建 → 执行 → 收口。没有排队/暂停等当前模型不存在的状态。 */
function TaskProgress({ status }: { status: TaskStatus }) {
  const running = status === "running";
  const terminalTone =
    status === "done"
      ? "bg-[#16a34a]"
      : status === "failed"
        ? "bg-[#dc2626]"
        : "bg-[#d97706]";
  const nodes = [
    { label: "创建", tone: "bg-[#16a34a]" },
    { label: "执行", tone: running ? "bg-[#98a2b3]" : "bg-[#16a34a]" },
    { label: taskStatusLabel(status), tone: running ? "bg-[#e5e7eb]" : terminalTone },
  ];
  return (
    <div className="flex items-center" aria-label="任务进度">
      {nodes.map((node, i) => (
        <div key={node.label} className={`flex items-center ${i === nodes.length - 1 ? "" : "flex-1"}`}>
          <div className="flex items-center gap-1.5">
            <span
              className={`h-1.5 w-1.5 rounded-full ${node.tone} ${
                running && i === 1 ? "animate-pulse" : ""
              }`}
            />
            <span className={`text-[10px] ${i === nodes.length - 1 && !running ? stepClass(status === "done" ? "ok" : status === "failed" ? "error" : "denied") : "text-muted"}`}>
              {node.label}
            </span>
          </div>
          {i < nodes.length - 1 && (
            <span
              className={`mx-1.5 h-px flex-1 ${running && i === 1 ? "bg-[#e5e7eb]" : "bg-[#d0d5dd]"}`}
            />
          )}
        </div>
      ))}
    </div>
  );
}

/** 复制到剪贴板：安全上下文缺失时退到 textarea + execCommand（与 MarkdownMessage 同口径）。 */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const area = document.createElement("textarea");
      area.value = text;
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(area);
      return ok;
    } catch {
      return false;
    }
  }
}

/** 新建任务弹窗：选智能体 + 写目标，提交后建会话并自动开始执行。 */
function NewTaskModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const agentsRoster = useChatStore((s) => s.agentsRoster);
  const openAgent = useChatStore((s) => s.openAgent);
  const bindings = useLlmStore((s) => s.bindings);
  const profiles = useLlmStore((s) => s.profiles);
  const createTask = useTaskStore((s) => s.create);
  const focusConversation = useUiStore((s) => s.focusConversation);
  const setTaskDraft = useUiStore((s) => s.setTaskDraft);
  const templates = useTemplateStore((s) => s.templates);
  const saveTemplate = useTemplateStore((s) => s.save);
  const removeTemplate = useTemplateStore((s) => s.remove);

  const [agentId, setAgentId] = useState("");
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [templateId, setTemplateId] = useState("");
  const [templateName, setTemplateName] = useState("");
  const [templateNotice, setTemplateNotice] = useState("");
  const [templateError, setTemplateError] = useState("");
  const [removeTemplateTarget, setRemoveTemplateTarget] = useState<TaskTemplate | null>(null);
  const pendingRef = useRef(false);
  const panelRef = useRef<HTMLFormElement>(null);
  useModalA11y(panelRef, onClose, { active: open });

  const boundProfile = (id: string) => {
    const pid = bindings[id];
    return pid ? profiles.find((p) => p.id === pid) : undefined;
  };

  // 打开时自动选中第一个已绑定的智能体：用户多数情况只有一个常用连接
  useEffect(() => {
    if (!open) return;
    setError("");
    setPending(false);
    setTemplateId("");
    setTemplateName("");
    setTemplateNotice("");
    setTemplateError("");
    setRemoveTemplateTarget(null);
    pendingRef.current = false;
    setAgentId((prev) => {
      if (prev && boundProfile(prev)) return prev;
      return agentsRoster.find((a) => boundProfile(a.id))?.id ?? "";
    });
    // bindings/profiles 在弹窗打开期间变化时不必重选（避免用户选一半被抢）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;

  const agent = agentsRoster.find((a) => a.id === agentId);
  const profile = agent ? boundProfile(agent.id) : undefined;
  // 任务的价值多半在工具执行上：模型不支持函数调用时，这一轮只能纯靠模型自述，
  // 与其让用户跑完才发现，不如建任务前就说明。
  const toolsNotice =
    agent && profile ? capabilityNotice("tools", [{ name: agent.name, profile }]) : null;
  const canSubmit = !!agent && !!profile && !!text.trim() && !pending;

  const templatesFull = templates.length >= MAX_TEMPLATES;

  const applyTemplate = (id: string) => {
    setTemplateId(id);
    setTemplateNotice("");
    setTemplateError("");
    const picked = templates.find((t) => t.id === id);
    // 模板是「起跑线」不是「枷锁」：填入后仍可随手改，不影响模板本身
    if (picked) setText(picked.prompt);
  };

  const onSaveTemplate = () => {
    const result = saveTemplate({
      name: templateName.trim() || suggestTemplateName(text),
      prompt: text,
    });
    if (!result.ok) {
      setTemplateError(result.error);
      setTemplateNotice("");
      return;
    }
    setTemplateError("");
    setTemplateNotice(`已存为模板「${result.template.name}」`);
    setTemplateName("");
    setTemplateId(result.template.id);
  };

  const confirmRemoveTemplate = () => {
    if (!removeTemplateTarget) return;
    removeTemplate(removeTemplateTarget.id);
    if (templateId === removeTemplateTarget.id) setTemplateId("");
    setRemoveTemplateTarget(null);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit || !agent || pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    setError("");
    try {
      // 先建/复用一对一 agent 会话：任务记录必须带真实 conversationId，
      // 否则任务区的嵌入式 ChatPage 找不到会话。
      const conversationId = await openAgent(agent.id);
      const taskId = createTask({
        conversationId,
        agentId: agent.id,
        agentName: agent.name,
        prompt: text,
      });
      focusConversation(conversationId);
      setTaskDraft({
        taskId,
        conversationId,
        text,
        mentions: [{ agentId: agent.id, name: agent.name }],
      });
      setText("");
      onClose();
    } catch (err) {
      setError(`创建任务失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  };

  const boundCount = agentsRoster.filter((a) => boundProfile(a.id)).length;

  return (
    <div
      className="fixed inset-0 z-30 flex items-center justify-center bg-black/20 p-6"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <form
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="新建任务"
        onSubmit={submit}
        className="w-full max-w-[520px] rounded-xl border border-line bg-white p-5 shadow-card"
      >
        <div className="mb-1 text-[15px] font-bold">新建任务</div>
        <p className="mb-4 text-[12px] leading-5 text-muted">
          选一个已绑定 LLM 连接的智能体，写下要做的事。创建后会在任务区直接开始执行，
          工具调用仍会按你的确认策略逐次询问。
        </p>

        <label className="mb-1 block text-[12px] font-medium text-[#344054]">智能体</label>
        <select
          aria-label="选择智能体"
          value={agentId}
          onChange={(e) => setAgentId(e.target.value)}
          className="mb-4 w-full rounded-lg border border-line bg-white px-2.5 py-2 text-[13px] outline-none focus:border-ink"
        >
          <option value="">请选择…</option>
          {agentsRoster.map((a) => {
            const bound = !!boundProfile(a.id);
            return (
              <option key={a.id} value={a.id} disabled={!bound}>
                {a.name}
                {bound ? "" : "（未绑定 LLM）"}
              </option>
            );
          })}
        </select>

        {agentsRoster.length > 0 && boundCount === 0 && (
          <p className="mb-3 rounded-lg border border-[#fed7aa] bg-[#fffbeb] px-3 py-2 text-[12px] text-[#b45309]">
            还没有智能体绑定 LLM 连接。请先去设置区完成绑定，再回来建任务。
          </p>
        )}

        {toolsNotice && (
          <p role="status" className="mb-3 rounded-lg border border-[#fed7aa] bg-[#fffbeb] px-3 py-2 text-[12px] text-[#b45309]">
            {toolsNotice}
          </p>
        )}

        <div className="mb-1 flex items-baseline justify-between">
          <span className="text-[12px] font-medium text-[#344054]">任务模板</span>
          <span className="text-[11px] text-muted">
            {templates.length}/{MAX_TEMPLATES}
          </span>
        </div>
        <div className="mb-4 flex gap-2">
          <select
            aria-label="任务模板"
            value={templateId}
            onChange={(e) => applyTemplate(e.target.value)}
            className="min-w-0 flex-1 rounded-lg border border-line bg-white px-2.5 py-2 text-[13px] outline-none focus:border-ink"
          >
            <option value="">不使用模板</option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
          {templateId && (
            <button
              type="button"
              onClick={() => setRemoveTemplateTarget(templates.find((t) => t.id === templateId) ?? null)}
              className="shrink-0 rounded-lg border border-line px-2.5 py-2 text-[12px] hover:bg-[#fafafa]"
            >
              删除模板
            </button>
          )}
        </div>

        <label className="mb-1 block text-[12px] font-medium text-[#344054]">任务目标</label>
        <textarea
          aria-label="任务目标"
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={5}
          placeholder="例如：梳理 packages/web/src/lib 下的模块依赖，列出耦合最重的三处并给出拆分建议"
          className="w-full resize-y rounded-lg border border-line px-2.5 py-2 text-[13px] leading-5 outline-none focus:border-ink"
        />

        <div className="mt-2 flex gap-2">
          <input
            aria-label="模板名称"
            value={templateName}
            onChange={(e) => setTemplateName(e.target.value)}
            placeholder={text.trim() ? suggestTemplateName(text) : "给这个模板起个名字"}
            className="min-w-0 flex-1 rounded-lg border border-line px-2.5 py-1.5 text-[12px] outline-none focus:border-ink"
          />
          <button
            type="button"
            onClick={onSaveTemplate}
            disabled={!text.trim() || templatesFull}
            className="shrink-0 rounded-lg border border-line px-3 py-1.5 text-[12px] hover:bg-[#fafafa] disabled:cursor-not-allowed disabled:opacity-40"
          >
            存为模板
          </button>
        </div>
        {templatesFull && (
          <p className="mt-1 text-[12px] text-muted">
            模板已达 {MAX_TEMPLATES} 条上限，删除旧模板后才能继续保存。
          </p>
        )}
        {templateError && <p className="mt-1 text-[12px] text-[#b42318]">{templateError}</p>}
        {templateNotice && (
          <p role="status" className="mt-1 text-[12px] text-[#15803d]">
            {templateNotice}
          </p>
        )}

        {error && <p className="mt-2 text-[12px] text-[#b42318]">{error}</p>}

        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-line px-3 py-1.5 text-[12px] hover:bg-[#fafafa]"
          >
            取消
          </button>
          <button
            type="submit"
            disabled={!canSubmit}
            className="rounded-lg bg-ink px-3 py-1.5 text-[12px] font-medium text-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            {pending ? "创建中…" : "创建并执行"}
          </button>
        </div>

        {removeTemplateTarget && (
          <ConfirmDialog
            title="删除任务模板"
            onCancel={() => setRemoveTemplateTarget(null)}
            footer={
              <>
                <button
                  type="button"
                  onClick={() => setRemoveTemplateTarget(null)}
                  className="rounded-lg border border-line px-3 py-1.5 text-[12px] hover:bg-[#fafafa]"
                >
                  取消
                </button>
                <button
                  type="button"
                  onClick={confirmRemoveTemplate}
                  className="rounded-lg bg-[#b42318] px-3 py-1.5 text-[12px] font-medium text-white hover:bg-[#912018]"
                >
                  删除
                </button>
              </>
            }
          >
            <p className="text-[12px] leading-6">
              删除模板「{removeTemplateTarget.name}」？模板文本只存在本机，删掉无法恢复；
              已经用它发起过的任务不受影响。
            </p>
          </ConfirmDialog>
        )}
      </form>
    </div>
  );
}

export function TaskAreaPage() {
  const tasks = useTaskStore((s) => s.tasks);
  const removeTask = useTaskStore((s) => s.remove);
  const clearFinished = useTaskStore((s) => s.clearFinished);
  const reopenTask = useTaskStore((s) => s.reopen);
  const loadWorkspace = useChatStore((s) => s.loadWorkspace);
  const loadAgentsRoster = useChatStore((s) => s.loadAgentsRoster);
  const conversations = useChatStore((s) => s.conversations);
  const activeConversationId = useUiStore((s) => s.activeConversationId);
  const focusConversation = useUiStore((s) => s.focusConversation);
  const setTaskDraft = useUiStore((s) => s.setTaskDraft);
  const taskFocusId = useUiStore((s) => s.taskFocusId);
  const consumeTaskFocus = useUiStore((s) => s.consumeTaskFocus);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [modalOpen, setModalOpen] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<TaskRecord | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [copied, setCopied] = useState<"md" | "json" | null>(null);
  const copiedTimer = useRef<number | null>(null);

  // 任务区是独立页：名册（建任务候选）与会话列表（ChatPage 标题）在这里自行补齐，
  // 不依赖用户先去过工作区。
  useEffect(() => {
    void loadWorkspace().catch(() => {
      /* 离线/服务端异常：已有本地任务仍可查看 */
    });
    void loadAgentsRoster().catch(() => {
      /* 名册失败只影响新建任务 */
    });
  }, [loadWorkspace, loadAgentsRoster]);

  // 超时未收尾的任务（应用关过/刷新过）自动置失败，避免永远显示「进行中」。
  useEffect(() => {
    useTaskStore.getState().markStale();
    const timer = window.setInterval(() => useTaskStore.getState().markStale(), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(
    () => () => {
      if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
    },
    [],
  );

  const stats = useMemo(() => taskStats(tasks), [tasks]);
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return tasks.filter((task) => {
      if (filter !== "all" && task.status !== filter) return false;
      if (!q) return true;
      return (
        task.title.toLowerCase().includes(q) ||
        task.prompt.toLowerCase().includes(q) ||
        task.agentName.toLowerCase().includes(q)
      );
    });
  }, [tasks, filter, query]);

  const selected = tasks.find((t) => t.id === selectedId) ?? null;
  const selectedConv = selected
    ? conversations.find((c) => c.id === selected.conversationId)
    : undefined;

  const selectTask = (task: TaskRecord) => {
    setSelectedId(task.id);
    focusConversation(task.conversationId);
  };

  // 通知中心跳转：进任务区后选中那条任务并立刻消费投递槽，
  // 否则切走再回来还会被同一通知拽回去。
  useEffect(() => {
    if (!taskFocusId) return;
    const task = tasks.find((t) => t.id === taskFocusId);
    if (task) selectTask(task);
    consumeTaskFocus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskFocusId]);

  const retry = (task: TaskRecord) => {
    reopenTask(task.id);
    focusConversation(task.conversationId);
    // 复用投递槽：自动发送同一条目标，流与消息仍走 ChatPage 的完整链路
    setTaskDraft({
      taskId: task.id,
      conversationId: task.conversationId,
      text: task.prompt,
      mentions: [{ agentId: task.agentId, name: task.agentName }],
    });
  };

  const copyTask = async (task: TaskRecord, format: "md" | "json") => {
    const ok = await copyText(format === "md" ? buildTaskReport(task) : buildTaskJson(task));
    if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
    setCopied(ok ? format : null);
    if (!ok) return;
    copiedTimer.current = window.setTimeout(() => {
      copiedTimer.current = null;
      setCopied(null);
    }, 1500);
  };

  const sources = selected ? taskSources(selected) : [];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex flex-wrap items-center gap-3 border-b border-line-soft px-5 py-3">
        <div className="flex items-center gap-2">
          <TaskIcon width={18} height={18} />
          <span className="text-[15px] font-bold">任务区</span>
          <span className="text-[11px] text-muted">
            {stats.total} 个任务 · {stats.running} 进行中 · {stats.done} 已完成
          </span>
        </div>
        <input
          aria-label="搜索任务"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索任务…"
          className="ml-2 w-[200px] rounded-lg border border-line px-2.5 py-1.5 text-[12px] outline-none focus:border-ink"
        />
        <div className="flex items-center gap-1" role="group" aria-label="按状态筛选">
          {FILTERS.map((f) => {
            const count =
              f.key === "all" ? stats.total : stats[f.key as keyof typeof stats];
            return (
              <button
                key={f.key}
                type="button"
                aria-pressed={filter === f.key}
                onClick={() => setFilter(f.key)}
                className={`rounded-full border px-2.5 py-1 text-[11px] transition-colors ${
                  filter === f.key
                    ? "border-ink bg-ink text-white"
                    : "border-line text-muted hover:bg-[#fafafa]"
                }`}
              >
                {f.label} {count}
              </button>
            );
          })}
        </div>
        <div className="ml-auto flex items-center gap-2">
          {stats.done + stats.failed + stats.cancelled > 0 && (
            <button
              type="button"
              onClick={() => setConfirmClear(true)}
              className="rounded-lg border border-line px-2.5 py-1.5 text-[12px] text-muted hover:bg-[#fafafa]"
            >
              清空已结束
            </button>
          )}
          <button
            type="button"
            aria-label="新建任务"
            onClick={() => setModalOpen(true)}
            className="flex items-center gap-1 rounded-lg bg-ink px-3 py-1.5 text-[12px] font-medium text-white"
          >
            <PlusIcon width={14} height={14} />
            新建任务
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* 左列：任务清单 */}
        <aside className="flex w-[280px] shrink-0 flex-col border-r border-line-soft">
          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {visible.length === 0 ? (
              <div className="px-3 py-10 text-center text-[12px] leading-6 text-muted">
                {stats.total === 0
                  ? "还没有任务。点右上角「新建任务」，给一个智能体派活。"
                  : "没有符合条件的任务。"}
              </div>
            ) : (
              visible.map((task) => (
                <button
                  key={task.id}
                  type="button"
                  aria-label={`任务 ${task.title}`}
                  aria-current={task.id === selectedId}
                  onClick={() => selectTask(task)}
                  className={`mb-1 w-full rounded-lg border px-3 py-2.5 text-left transition-colors ${
                    task.id === selectedId
                      ? "border-line bg-[#f7f7f7]"
                      : "border-transparent hover:bg-[#fafafa]"
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <span className="flex min-w-0 flex-1 items-center gap-1.5">
                      <span
                        className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                          task.status === "running"
                            ? "animate-pulse bg-[#98a2b3]"
                            : task.status === "done"
                              ? "bg-[#16a34a]"
                              : task.status === "failed"
                                ? "bg-[#dc2626]"
                                : "bg-[#d97706]"
                        }`}
                      />
                      <span className="truncate text-[13px] font-medium">{task.title}</span>
                    </span>
                    <span
                      className={`shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] ${statusClass(task.status)}`}
                    >
                      {taskStatusLabel(task.status)}
                    </span>
                  </div>
                  <div className="mt-1 truncate text-[11px] text-muted">
                    {task.agentName} · {formatTaskTime(task.createdAt)}
                  </div>
                  <div className="mt-0.5 text-[11px] text-muted">
                    {task.steps.length} 个工具调用
                    {task.endedAt !== undefined
                      ? ` · 用时 ${formatDuration(task.endedAt - task.createdAt)}`
                      : ""}
                  </div>
                  {task.status === "running" && (
                    <div className="mt-2 h-0.5 overflow-hidden rounded-full bg-[#ececec]">
                      <div className="h-full w-1/2 animate-pulse rounded-full bg-[#98a2b3]" />
                    </div>
                  )}
                </button>
              ))
            )}
          </div>
          <div className="border-t border-line-soft px-3 py-2 text-[10px] leading-4 text-muted">
            任务记录与汇总只保存在本机，不上传服务端。
          </div>
        </aside>

        {/* 中列：嵌入式 ChatPage（选中任务的会话） */}
        <section className="flex min-w-0 flex-1 flex-col">
          {selected && activeConversationId === selected.conversationId ? (
            <ChatPage embedded />
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center">
              <span className="flex h-16 w-16 items-center justify-center rounded-2xl border border-line-soft bg-[#fafafa] text-[#98a2b3]">
                <TaskIcon width={30} height={30} />
              </span>
              <div className="text-[14px] font-bold">
                {selected ? "正在打开会话…" : "选择一个任务，或新建任务"}
              </div>
              <p className="max-w-[420px] text-[12px] leading-6 text-muted">
                任务区把「目标 → 智能体执行 → 工具轨迹 → 结果汇总」串在一起。
                对话仍走和鸣的端到端加密链路，工具调用仍受人工确认闸门保护。
              </p>
              {selected && selectedConv && (
                <button
                  type="button"
                  onClick={() => selectTask(selected)}
                  className="rounded-lg border border-line px-3 py-1.5 text-[12px] hover:bg-[#fafafa]"
                >
                  打开任务会话
                </button>
              )}
            </div>
          )}
        </section>

        {/* 右列：确定性汇总 */}
        <aside className="w-[320px] shrink-0 overflow-y-auto border-l border-line-soft px-4 py-4">
          {!selected ? (
            <div className="text-[12px] leading-6 text-muted">
              选中一个任务后，这里会显示目标、结果、工具步骤与来源，并可复制成
              Markdown 报告或 JSON。
            </div>
          ) : (
            <TaskSummary
              task={selected}
              sources={sources}
              copied={copied}
              onCopy={(format) => void copyTask(selected, format)}
              onRetry={() => retry(selected)}
              onRemove={() => setRemoveTarget(selected)}
            />
          )}
        </aside>
      </div>

      <NewTaskModal open={modalOpen} onClose={() => setModalOpen(false)} />

      {confirmClear && (
        <ConfirmDialog
          title="清空已结束任务"
          onCancel={() => setConfirmClear(false)}
          footer={
            <>
              <button
                type="button"
                className="rounded-lg border border-line px-3 py-1.5 text-[12px] text-muted hover:bg-[#f7f7f7]"
                onClick={() => setConfirmClear(false)}
              >
                取消
              </button>
              <button
                type="button"
                className="rounded-lg bg-[#b42318] px-3 py-1.5 text-[12px] font-bold text-white"
                onClick={() => {
                  const n = clearFinished();
                  setConfirmClear(false);
                  if (n > 0 && selected && selected.status !== "running") setSelectedId(null);
                }}
              >
                清空
              </button>
            </>
          }
        >
          <p className="text-[12px] leading-6">
            清空所有已结束（完成/失败/已取消）的任务记录？运行中的任务会保留，聊天消息与导出过的报告不受影响；记录删除后不可恢复。
          </p>
        </ConfirmDialog>
      )}

      {removeTarget && (
        <ConfirmDialog
          title="删除任务"
          onCancel={() => setRemoveTarget(null)}
          footer={
            <>
              <button
                type="button"
                className="rounded-lg border border-line px-3 py-1.5 text-[12px] text-muted hover:bg-[#f7f7f7]"
                onClick={() => setRemoveTarget(null)}
              >
                取消
              </button>
              <button
                type="button"
                className="rounded-lg bg-[#b42318] px-3 py-1.5 text-[12px] font-bold text-white"
                onClick={() => {
                  removeTask(removeTarget.id);
                  if (selectedId === removeTarget.id) setSelectedId(null);
                  setRemoveTarget(null);
                }}
              >
                删除
              </button>
            </>
          }
        >
          <p className="text-[12px] leading-6">
            删除任务「{removeTarget.title}」？只删本机记录，聊天消息不受影响。
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
}

/** 右列汇总：结构化展示 + 复制报告（Markdown/JSON 均由确定性纯函数生成）。 */
function TaskSummary({
  task,
  sources,
  copied,
  onCopy,
  onRetry,
  onRemove,
}: {
  task: TaskRecord;
  sources: { id: string; title: string; detail?: string }[];
  copied: "md" | "json" | null;
  onCopy: (format: "md" | "json") => void;
  onRetry: () => void;
  onRemove: () => void;
}) {
  const running = task.status === "running";
  const now = useNow(running);
  const elapsedTo = task.endedAt ?? now;
  return (
    <div className="flex flex-col gap-3">
      <div>
        <div className="flex items-center gap-2">
          <span
            className={`rounded-full border px-1.5 py-0.5 text-[10px] ${statusClass(task.status)}`}
          >
            {taskStatusLabel(task.status)}
          </span>
          {running && <span className="text-[11px] text-muted">执行中…</span>}
          <span className="ml-auto text-[11px] tabular-nums text-muted">
            {formatDuration(elapsedTo - task.createdAt)}
          </span>
        </div>
        <h2 className="mt-1.5 text-[14px] font-bold leading-6">{task.title}</h2>
        <div className="mt-2">
          <TaskProgress status={task.status} />
        </div>
      </div>

      <dl className="grid grid-cols-[64px_1fr] gap-x-2 gap-y-1 text-[11px] leading-5">
        <dt className="text-muted">智能体</dt>
        <dd className="truncate">{task.agentName}</dd>
        <dt className="text-muted">创建</dt>
        <dd>{formatTaskTime(task.createdAt)}</dd>
        {task.endedAt !== undefined && (
          <>
            <dt className="text-muted">用时</dt>
            <dd>{formatDuration(task.endedAt - task.createdAt)}</dd>
          </>
        )}
        <dt className="text-muted">工具</dt>
        <dd>
          {task.steps.length} 次调用
          {sources.length ? ` · ${sources.length} 个来源` : ""}
        </dd>
      </dl>

      <section>
        <h3 className="mb-1 text-[11px] font-bold uppercase tracking-wider text-muted">目标</h3>
        <p className="whitespace-pre-wrap rounded-lg border border-line-soft bg-[#fafafa] px-2.5 py-2 text-[12px] leading-5">
          {task.prompt}
        </p>
      </section>

      {task.error && (
        <section>
          <h3 className="mb-1 text-[11px] font-bold uppercase tracking-wider text-muted">失败原因</h3>
          <p className="rounded-lg border border-[#fecdca] bg-[#fef3f2] px-2.5 py-2 text-[12px] leading-5 text-[#b42318]">
            {task.error}
          </p>
        </section>
      )}

      <section>
        <h3 className="mb-1 text-[11px] font-bold uppercase tracking-wider text-muted">结果</h3>
        {task.result ? (
          <div className="rounded-lg border border-line-soft px-2.5 py-2 text-[12px] leading-5">
            <MarkdownMessage text={task.result} />
          </div>
        ) : (
          <p className="text-[12px] text-muted">
            {running ? "执行中，暂无结果。" : "没有产出文本。"}
          </p>
        )}
      </section>

      <section>
        <h3 className="mb-1.5 text-[11px] font-bold uppercase tracking-wider text-muted">执行步骤</h3>
        {task.steps.length === 0 ? (
          <p className="text-[12px] text-muted">没有工具调用。</p>
        ) : (
          <ol className="flex flex-col">
            {task.steps.map((step, i) => (
              <li key={`${step.id}-${i}`} className="flex gap-2">
                <span className="relative flex w-3 shrink-0 justify-center">
                  {i < task.steps.length - 1 && (
                    <span className="absolute bottom-0 top-3 w-px bg-[#e6e6e6]" />
                  )}
                  <span
                    className={`relative z-10 mt-2.5 h-1.5 w-1.5 shrink-0 rounded-full ${stepDotClass(
                      step.status,
                    )} ${step.status === "running" ? "animate-pulse" : ""}`}
                  />
                </span>
                <div className="mb-2 min-w-0 flex-1 rounded-lg border border-line-soft px-2.5 py-2">
                  <div className="flex items-center justify-between gap-2 text-[12px]">
                    <span className="min-w-0 flex-1 truncate font-medium">{step.name}</span>
                    <span className={`shrink-0 text-[10px] ${stepClass(step.status)}`}>
                      {taskStepStatusLabel(step.status)}
                      {step.endedAt !== undefined
                        ? ` · ${formatDuration(step.endedAt - step.startedAt)}`
                        : ""}
                    </span>
                  </div>
                  {step.args && (
                    <div className="mt-1 break-all font-mono text-[10px] leading-4 text-muted">
                      {step.args.length > 180 ? `${step.args.slice(0, 180)}…` : step.args}
                    </div>
                  )}
                  {step.denyCause && (
                    <div className="mt-1 text-[10px] text-[#b45309]">
                      拒绝原因：
                      {step.denyCause === "rule"
                        ? "命中记住的拒绝规则"
                        : step.denyCause === "gate"
                          ? "确认流程异常"
                          : "用户当场拒绝"}
                    </div>
                  )}
                  {step.result && (
                    <div className="mt-1 line-clamp-4 whitespace-pre-wrap break-words text-[11px] leading-4 text-muted">
                      {step.result.length > 400 ? `${step.result.slice(0, 400)}…` : step.result}
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>

      {sources.length > 0 && (
        <section>
          <h3 className="mb-1 text-[11px] font-bold uppercase tracking-wider text-muted">来源</h3>
          <ul className="flex flex-col gap-1">
            {sources.map((s) => (
              <li key={s.id} className="truncate text-[11px] leading-5">
                <span className="font-medium">{s.title || s.id}</span>
                <span className="text-muted">（{s.id}）</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="flex flex-wrap items-center gap-2 border-t border-line-soft pt-3">
        <button
          type="button"
          onClick={() => onCopy("md")}
          className="rounded-lg border border-line px-2.5 py-1.5 text-[12px] hover:bg-[#fafafa]"
        >
          {copied === "md" ? "已复制" : "复制 Markdown 报告"}
        </button>
        <button
          type="button"
          aria-label="复制任务 JSON"
          title="结构化记录，便于脚本或其他工具读取"
          onClick={() => onCopy("json")}
          className="rounded-lg border border-line px-2.5 py-1.5 text-[12px] hover:bg-[#fafafa]"
        >
          {copied === "json" ? "已复制" : "复制 JSON"}
        </button>
        {!running && (
          <button
            type="button"
            onClick={onRetry}
            className="rounded-lg border border-line px-2.5 py-1.5 text-[12px] hover:bg-[#fafafa]"
          >
            重新执行
          </button>
        )}
        <button
          type="button"
          aria-label="删除任务"
          onClick={onRemove}
          className="ml-auto flex items-center gap-1 rounded-lg border border-line px-2.5 py-1.5 text-[12px] text-muted hover:border-[#fecdca] hover:text-[#b42318]"
        >
          <TrashIcon width={13} height={13} />
          删除
        </button>
      </div>
    </div>
  );
}
