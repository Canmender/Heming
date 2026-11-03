import { useEffect, useMemo, useRef, useState } from "react";
import { useChatStore } from "../store/chat.js";
import { useLlmStore } from "../store/llm.js";
import { useUiStore } from "../store/ui.js";
import {
  buildTaskJson,
  buildTaskReport,
  formatDuration,
  formatTaskTime,
  taskForkNotice,
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
import { buildForkTaskPlan, type ForkTaskPlan } from "../lib/tasks/forkTask.js";
import { rerunNoticeLines } from "../lib/tasks/rerun.js";
import { rolloutLog, type ForkPreview } from "../lib/rollout/index.js";
import { ChatPage } from "./ChatPage.js";
import { MarkdownMessage } from "./MarkdownMessage.js";
import { RolloutTimeline } from "./RolloutTimeline.js";
import { ConfirmDialog } from "./ConfirmDialog.js";
import { UnboundModelNotice } from "./ux/UnboundModelNotice.js";
import { resolveBoundProfile } from "../lib/llmRoute.js";
import { capabilityNotice } from "../lib/capabilityNotice.js";
import { AssistantIcon, PlusIcon, TaskIcon, TrashIcon } from "./icons.js";

/**
 * 通用智能体：页内直接选智能体、写目标并运行。
 *
 * 底层仍复用任务记录（TaskRecord）：它把「目标 → 智能体执行 → 工具轨迹 → 结果汇总」
 * 串在一起；页面只是把入口从「新建任务弹窗」改成常驻启动面板，使用时不必先建任务。
 *
 * 布局：
 * - 左列运行记录（状态/搜索/筛选）；
 * - 中间未选运行时是启动面板，选中后复用 ChatPage（消息、工具确认、E2E 全部沿用）；
 * - 右列确定性汇总（目标、结果、步骤、来源、可复制的 Markdown 报告）。
 *
 * 数据只存本机：运行记录含工具参数摘要，不进消息库、不上云。
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
    <div className="flex items-center" aria-label="运行进度">
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
function AgentComposer({ onStarted }: { onStarted: (taskId: string) => void }) {
  const agentsRoster = useChatStore((s) => s.agentsRoster);
  const openAgent = useChatStore((s) => s.openAgent);
  const bindings = useLlmStore((s) => s.bindings);
  const profiles = useLlmStore((s) => s.profiles);
  const createTask = useTaskStore((s) => s.create);
  const focusConversation = useUiStore((s) => s.focusConversation);
  const setTaskDraft = useUiStore((s) => s.setTaskDraft);
  const setPage = useUiStore((s) => s.setPage);
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
  const textRef = useRef<HTMLTextAreaElement>(null);

  const boundProfile = (id: string) => {
    const pid = bindings[id];
    return pid ? profiles.find((p) => p.id === pid) : undefined;
  };

  // 名册与绑定是异步到的：已选且仍可用就不打断，否则落到第一个可用智能体
  useEffect(() => {
    setAgentId((prev) => {
      if (prev && boundProfile(prev)) return prev;
      return agentsRoster.find((a) => boundProfile(a.id))?.id ?? "";
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentsRoster, bindings, profiles]);

  useEffect(() => {
    textRef.current?.focus();
  }, []);

  const agent = agentsRoster.find((a) => a.id === agentId);
  const profile = agent ? boundProfile(agent.id) : undefined;
  // 通用智能体的价值在工具执行上：模型不支持函数调用时，先说明再让用户跑
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
      // 先建/复用一对一 agent 会话：运行记录必须带真实 conversationId，
      // 否则嵌入式 ChatPage 找不到会话。
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
      onStarted(taskId);
    } catch (err) {
      setError(`启动运行失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  };

  const boundCount = agentsRoster.filter((a) => boundProfile(a.id)).length;

  return (
    <div className="flex h-full min-h-0 items-start justify-center overflow-y-auto px-6 py-6">
      <form
        aria-label="运行智能体"
        onSubmit={submit}
        className="w-full max-w-[620px] rounded-xl border border-line bg-white p-5 shadow-card"
      >
        <div className="flex items-center gap-2">
          <AssistantIcon width={18} height={18} />
          <h2 className="ui-section-title">直接调用智能体</h2>
        </div>
        <p className="mt-1 text-[12px] leading-5 text-muted">
          选一个已绑定 LLM 连接的智能体，写下要做的事，点「开始运行」即执行。
          工具调用仍会按你的确认策略逐次询问，结果与工具轨迹留在本机。
        </p>

        <label className="mt-4 mb-1 block text-[12px] font-medium text-[#344054]">智能体</label>
        <select
          aria-label="选择智能体"
          value={agentId}
          onChange={(e) => setAgentId(e.target.value)}
          className="w-full rounded-lg border border-line-strong bg-white px-2.5 py-2 text-[13px] outline-hidden focus:border-ink"
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
          <div className="mt-3">
            <UnboundModelNotice onGoSettings={() => setPage("settings")} />
          </div>
        )}

        {toolsNotice && (
          <p role="status" className="mt-3 rounded-lg border border-[#fed7aa] bg-[#fffbeb] px-3 py-2 text-[12px] text-[#b45309]">
            {toolsNotice}
          </p>
        )}

        <div className="mt-4 mb-1 flex items-baseline justify-between">
          <span className="text-[12px] font-medium text-[#344054]">目标模板</span>
          <span className="text-[11px] text-muted">
            {templates.length}/{MAX_TEMPLATES}
          </span>
        </div>
        <div className="flex gap-2">
          <select
            aria-label="目标模板"
            value={templateId}
            onChange={(e) => applyTemplate(e.target.value)}
            className="min-w-0 flex-1 rounded-lg border border-line-strong bg-white px-2.5 py-2 text-[13px] outline-hidden focus:border-ink"
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

        <label className="mt-4 mb-1 block text-[12px] font-medium text-[#344054]">目标</label>
        <textarea
          ref={textRef}
          aria-label="运行目标"
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={6}
          placeholder="例如：梳理 packages/web/src/lib 下的模块依赖，列出耦合最重的三处并给出拆分建议"
          className="w-full resize-y rounded-lg border border-line-strong px-2.5 py-2 text-[13px] leading-5 outline-hidden focus:border-ink"
        />

        <div className="mt-2 flex gap-2">
          <input
            aria-label="模板名称"
            value={templateName}
            onChange={(e) => setTemplateName(e.target.value)}
            placeholder={text.trim() ? suggestTemplateName(text) : "给这个模板起个名字"}
            className="min-w-0 flex-1 rounded-lg border border-line-strong px-2.5 py-1.5 text-[12px] outline-hidden focus:border-ink"
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

        <div className="mt-4 flex items-center justify-between">
          <span className="text-[10px] text-muted">运行记录与结果只保存在本机，不上传服务端。</span>
          <button
            type="submit"
            disabled={!canSubmit}
            className="rounded-lg bg-ink px-4 py-1.5 text-[12px] font-medium text-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            {pending ? "启动中…" : "开始运行"}
          </button>
        </div>

        {removeTemplateTarget && (
          <ConfirmDialog
            title="删除目标模板"
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
              已经用它发起过的运行不受影响。
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
  const rerunTask = useTaskStore((s) => s.rerun);
  const forkFromTask = useTaskStore((s) => s.forkFrom);
  const loadWorkspace = useChatStore((s) => s.loadWorkspace);
  const loadAgentsRoster = useChatStore((s) => s.loadAgentsRoster);
  const conversations = useChatStore((s) => s.conversations);
  const activeConversationId = useUiStore((s) => s.activeConversationId);
  const focusConversation = useUiStore((s) => s.focusConversation);
  const setTaskDraft = useUiStore((s) => s.setTaskDraft);
  const taskFocusId = useUiStore((s) => s.taskFocusId);
  const consumeTaskFocus = useUiStore((s) => s.consumeTaskFocus);
  // 订阅绑定表：智能体被解绑/换绑后，运行卡上的「未绑定模型」提示要立即出现/消失
  const llmBindings = useLlmStore((s) => s.bindings);
  const llmProfiles = useLlmStore((s) => s.profiles);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [removeTarget, setRemoveTarget] = useState<TaskRecord | null>(null);
  const [rerunTarget, setRerunTarget] = useState<TaskRecord | null>(null);
  /** 分叉确认（P3 预览）：算好了代价才出这个框，用户点之前就看清复用/丢弃。 */
  const [forkDraft, setForkDraft] = useState<{
    task: TaskRecord;
    plan: ForkTaskPlan;
    preview: ForkPreview;
  } | null>(null);
  /** 分叉被拒：把原因列出来（前置条件同源于面板按钮的置灰判据）。 */
  const [forkRejection, setForkRejection] = useState<{
    task: TaskRecord;
    messages: string[];
  } | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [copied, setCopied] = useState<"md" | "json" | null>(null);
  const copiedTimer = useRef<number | null>(null);

  // 通用智能体是独立页：名册（启动面板候选）与会话列表（ChatPage 标题）在这里自行补齐，
  // 不依赖用户先去过别的页。
  useEffect(() => {
    void loadWorkspace().catch(() => {
      /* 离线/服务端异常：已有本地运行记录仍可查看 */
    });
    void loadAgentsRoster().catch(() => {
      /* 名册失败只影响启动面板 */
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
  /** UX-A：选中任务的智能体是否未绑定模型（与对话页/启动面板同源判定）。 */
  const selectedAgentUnbound = useMemo(
    () => (selected ? !resolveBoundProfile(selected.agentId) : false),
    // 绑定表/连接表变化必须重算：解绑后提示要立刻出现，绑上后立刻消失
    [selected, llmBindings, llmProfiles],
  );

  const selectTask = (task: TaskRecord) => {
    setSelectedId(task.id);
    focusConversation(task.conversationId);
  };

  // 运行创建后立刻选中它：嵌入式 ChatPage 挂载起来，投递槽里的目标才会自动执行
  const onStarted = (taskId: string) => {
    setSelectedId(taskId);
  };

  // 通知中心跳转：进通用智能体后选中那条运行记录并立刻消费投递槽，
  // 否则切走再回来还会被同一通知拽回去。
  useEffect(() => {
    if (!taskFocusId) return;
    const task = tasks.find((t) => t.id === taskFocusId);
    if (task) selectTask(task);
    consumeTaskFocus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskFocusId]);

  /**
   * 重跑：**新建任务**（原任务保持原状态，留痕），复用投递槽自动发送同一条目标。
   *
   * 与旧「重新执行」（`reopen` 同一任务）的区别就在这里：旧做法会把上一轮的步骤与
   * 结果覆盖掉，用户分不清「这次跑成什么样」和「上次跑到哪」。
   */
  const runRerun = (task: TaskRecord) => {
    const newId = rerunTask(task.id);
    setRerunTarget(null);
    if (!newId) return;
    setSelectedId(newId);
    focusConversation(task.conversationId);
    setTaskDraft({
      taskId: newId,
      conversationId: task.conversationId,
      text: task.prompt,
      mentions: [{ agentId: task.agentId, name: task.agentName }],
    });
  };

  /**
   * 请求从某条工具结果之后分叉：先算前置条件与代价（P3），再弹确认框。
   *
   * 判定与面板按钮置灰**同源**（都走 `buildForkTaskPlan` → `checkFork`），
   * 不会出现「面板说能分叉、点了报错」。
   */
  const requestFork = (task: TaskRecord, targetSeq: number) => {
    if (!task.streamId) {
      setForkRejection({ task, messages: ["该任务没有绑定回合日志，无法确定从哪里分叉。"] });
      return;
    }
    let view: ReturnType<typeof rolloutLog.readStream>;
    try {
      view = rolloutLog.readStream(task.streamId);
    } catch {
      setForkRejection({ task, messages: ["读取本机回合日志失败，无法分叉。"] });
      return;
    }
    const result = buildForkTaskPlan(task, view.items, {
      targetSeq,
      version: view.version,
      running: task.status === "running",
    });
    if (!result.ok || !result.plan || !result.preview) {
      setForkRejection({ task, messages: result.rejections.map((r) => r.message) });
      return;
    }
    setForkDraft({ task, plan: result.plan, preview: result.preview });
  };

  /** 确认分叉：新建任务 + 投递原目标；前缀由 ChatPage 按任务的 forkedFrom 重建。 */
  const confirmFork = () => {
    if (!forkDraft) return;
    const { task, plan } = forkDraft;
    const newId = forkFromTask(task.id, plan.forkedFrom);
    setForkDraft(null);
    if (!newId) return;
    setSelectedId(newId);
    focusConversation(task.conversationId);
    setTaskDraft({
      taskId: newId,
      conversationId: task.conversationId,
      text: task.prompt,
      mentions: plan.mentions,
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
      <header className="flex flex-wrap items-center gap-3 border-b border-line-soft px-6 pb-4 pt-5">
        <div className="flex items-center gap-2">
          <AssistantIcon width={18} height={18} />
          <span className="ui-page-title">通用智能体</span>
          <span className="ui-page-sub">
            {stats.total} 次运行 · {stats.running} 进行中 · {stats.done} 已完成
          </span>
        </div>
        <input
          aria-label="搜索运行记录"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索运行记录…"
          className="ml-2 w-[200px] rounded-lg border border-line-strong px-2.5 py-1.5 text-[12px] outline-hidden focus:border-ink"
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
          {selected && (
            <button
              type="button"
              aria-label="新建运行"
              onClick={() => setSelectedId(null)}
              className="flex items-center gap-1 rounded-lg bg-ink px-3 py-1.5 text-[12px] font-medium text-white"
            >
              <PlusIcon width={14} height={14} />
              新建运行
            </button>
          )}
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* 左列：运行记录 */}
        <aside className="flex w-[280px] shrink-0 flex-col border-r border-line-soft">
          <div className="flex items-center gap-2 border-b border-line-soft px-6 py-2">
            <span className="ui-section-title">运行记录</span>
            <span className="ui-micro">{visible.length}</span>
            {selected && (
              <button
                type="button"
                onClick={() => setSelectedId(null)}
                className="ui-micro ml-auto hover:text-ink"
              >
                新运行
              </button>
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {visible.length === 0 ? (
              <div className="px-4 py-10 text-center text-[12px] leading-6 text-muted">
                {stats.total === 0
                  ? "还没有运行记录。在右侧选智能体、写下目标，就能直接开始。"
                  : "没有符合条件的运行记录。"}
              </div>
            ) : (
              visible.map((task) => (
                <button
                  key={task.id}
                  type="button"
                  aria-label={`运行 ${task.title}`}
                  aria-current={task.id === selectedId}
                  onClick={() => selectTask(task)}
                  className={`mb-1 w-full rounded-lg border px-4 py-2.5 text-left transition-colors ${
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
                    {task.forkedFrom ? " · 分叉" : ""}
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
          <div className="ui-caption border-t border-line-soft px-6 py-2 leading-4">
            运行记录与汇总只保存在本机，不上传服务端。
          </div>
        </aside>

        {/* 中列：未选运行时是启动面板；选中后复用嵌入式 ChatPage */}
        <section className="flex min-w-0 flex-1 flex-col">
          {selected && activeConversationId === selected.conversationId ? (
            <ChatPage embedded />
          ) : selected ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
              <span className="flex h-16 w-16 items-center justify-center rounded-2xl border border-line-soft bg-[#fafafa] text-[#98a2b3]">
                <AssistantIcon width={30} height={30} />
              </span>
              <div className="ui-section-title">正在打开运行…</div>
              {selectedConv && (
                <button
                  type="button"
                  onClick={() => selectTask(selected)}
                  className="rounded-lg border border-line px-3 py-1.5 text-[12px] hover:bg-[#fafafa]"
                >
                  打开运行会话
                </button>
              )}
            </div>
          ) : (
            <AgentComposer onStarted={onStarted} />
          )}
        </section>

        {/* 右列：确定性汇总 */}
        <aside className="w-[320px] shrink-0 overflow-y-auto border-l border-line-soft px-6 py-5">
          {!selected ? (
            <div className="text-[12px] leading-6 text-muted">
              选中一次运行后，这里会显示目标、结果、工具步骤与来源，并可复制成
              Markdown 报告或 JSON。
            </div>
          ) : (
            <TaskSummary
              task={selected}
              sources={sources}
              copied={copied}
              agentUnbound={selectedAgentUnbound}
              onGoSettings={() => useUiStore.getState().setPage("settings")}
              onCopy={(format) => void copyTask(selected, format)}
              onRerun={() => setRerunTarget(selected)}
              onFork={(seq) => requestFork(selected, seq)}
              onRemove={() => setRemoveTarget(selected)}
            />
          )}
        </aside>
      </div>

      {confirmClear && (
        <ConfirmDialog
          title="清空已结束运行"
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
            清空所有已结束（完成/失败/已取消）的运行记录？运行中的记录会保留，聊天消息与导出过的报告不受影响；记录删除后不可恢复。
          </p>
        </ConfirmDialog>
      )}

      {removeTarget && (
        <ConfirmDialog
          title="删除运行记录"
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
            删除运行「{removeTarget.title}」？只删本机记录，聊天消息不受影响。
          </p>
        </ConfirmDialog>
      )}

      {rerunTarget && (
        <ConfirmDialog
          title="重跑这次运行"
          onCancel={() => setRerunTarget(null)}
          footer={
            <>
              <button
                type="button"
                className="rounded-lg border border-line px-3 py-1.5 text-[12px] text-muted hover:bg-[#f7f7f7]"
                onClick={() => setRerunTarget(null)}
              >
                取消
              </button>
              <button
                type="button"
                className="rounded-lg bg-ink px-3 py-1.5 text-[12px] font-bold text-white"
                onClick={() => runRerun(rerunTarget)}
              >
                确认重跑
              </button>
            </>
          }
        >
          <div className="flex flex-col gap-2 text-[12px] leading-6">
            {rerunNoticeLines().map((line) => (
              <p key={line}>{line}</p>
            ))}
            <p className="text-muted">目标：{rerunTarget.title}</p>
          </div>
        </ConfirmDialog>
      )}

      {forkDraft && (
        <ConfirmDialog
          title="从这一步之后分叉"
          onCancel={() => setForkDraft(null)}
          footer={
            <>
              <button
                type="button"
                className="rounded-lg border border-line px-3 py-1.5 text-[12px] text-muted hover:bg-[#f7f7f7]"
                onClick={() => setForkDraft(null)}
              >
                取消
              </button>
              <button
                type="button"
                className="rounded-lg bg-ink px-3 py-1.5 text-[12px] font-bold text-white"
                onClick={confirmFork}
              >
                确认分叉
              </button>
            </>
          }
        >
          <div className="flex flex-col gap-2 text-[12px] leading-6">
            {forkDraft.plan.notices.map((line) => (
              <p key={line} className="text-[#b45309]">
                {line}
              </p>
            ))}
            <div>
              <p className="font-medium">
                将复用 {forkDraft.preview.reuse.length} 条工具结果：
              </p>
              <ul className="mt-1 flex flex-col gap-0.5 text-[11px] leading-5 text-muted">
                {forkDraft.preview.reuse.map((pair) => (
                  <li key={`${pair.callSeq}-${pair.resultSeq}`} className="truncate">
                    {pair.name || pair.id}
                    {pair.denied ? "（已拒绝）" : pair.ok ? "" : "（失败）"}
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <p className="font-medium">
                将丢弃 {forkDraft.preview.discard.length} 条记录（这一步之后的步骤与结果）。
              </p>
            </div>
            <p className="text-muted">任务：{forkDraft.task.title}</p>
          </div>
        </ConfirmDialog>
      )}

      {forkRejection && (
        <ConfirmDialog
          title="无法从这一步分叉"
          onCancel={() => setForkRejection(null)}
          footer={
            <button
              type="button"
              className="rounded-lg border border-line px-3 py-1.5 text-[12px] hover:bg-[#f7f7f7]"
              onClick={() => setForkRejection(null)}
            >
              知道了
            </button>
          }
        >
          <div className="flex flex-col gap-2 text-[12px] leading-6">
            {forkRejection.messages.map((line) => (
              <p key={line}>{line}</p>
            ))}
          </div>
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
  agentUnbound,
  onGoSettings,
  onCopy,
  onRerun,
  onFork,
  onRemove,
}: {
  task: TaskRecord;
  sources: { id: string; title: string; detail?: string }[];
  copied: "md" | "json" | null;
  /** 该任务的智能体是否未绑定模型（UX-A：与对话页/启动面板同源提示）。 */
  agentUnbound: boolean;
  onGoSettings: () => void;
  onCopy: (format: "md" | "json") => void;
  onRerun: () => void;
  onFork: (targetSeq: number) => void;
  onRemove: () => void;
}) {
  const running = task.status === "running";
  const now = useNow(running);
  const elapsedTo = task.endedAt ?? now;
  /** 分叉任务的任务卡提示：与分叉确认框同一份口径（前缀重建、可能截断）。 */
  const forkNotice = taskForkNotice(task);
  return (
    <div className="flex flex-col gap-3">
      {/* UX-A：未绑定模型时在运行卡顶部给同一份提示与「去设置」，重跑/新建都不会白跑 */}
      {agentUnbound && (
        <UnboundModelNotice agentName={task.agentName} onGoSettings={onGoSettings} />
      )}
      <div>
        <div className="flex items-center gap-2">
          <span
            className={`rounded-full border px-1.5 py-0.5 text-[10px] ${statusClass(task.status)}`}
          >
            {taskStatusLabel(task.status)}
          </span>
          {task.forkedFrom && (
            <span className="rounded-full border border-[#c7d2fe] bg-[#f5f8ff] px-1.5 py-0.5 text-[10px] text-[#3538cd]">
              分叉
            </span>
          )}
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

      {forkNotice && (
        <p
          role="status"
          className="rounded-lg border border-[#fedf89] bg-[#fffaeb] px-2.5 py-2 text-[11px] leading-5 text-[#b45309]"
        >
          {forkNotice}
        </p>
      )}

      <dl className="grid grid-cols-[64px_1fr] gap-x-2 gap-y-1 text-[11px] leading-5">
        <dt className="text-muted">智能体</dt>
        <dd className="truncate">{task.agentName}</dd>
        <dt className="text-muted">创建</dt>
        <dd>{formatTaskTime(task.createdAt)}</dd>
        {task.forkedFrom && (
          <>
            <dt className="text-muted">分叉来源</dt>
            <dd className="truncate">
              回合 {task.forkedFrom.streamId} · 第 {task.forkedFrom.seq} 条之后
            </dd>
          </>
        )}
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

      {/* 过程日志：只读，只有绑定了流（从通用智能体发起）的记录才有；
          分叉入口挂在这里——每条 tool_result 的「从此处分叉」由 checkFork 决定能不能点 */}
      {task.streamId && (
        <RolloutTimeline
          streamId={task.streamId}
          active={running}
          running={running}
          onFork={onFork}
        />
      )}

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
          aria-label="复制运行 JSON"
          title="结构化记录，便于脚本或其他工具读取"
          onClick={() => onCopy("json")}
          className="rounded-lg border border-line px-2.5 py-1.5 text-[12px] hover:bg-[#fafafa]"
        >
          {copied === "json" ? "已复制" : "复制 JSON"}
        </button>
        {!running && (
          <button
            type="button"
            onClick={onRerun}
            title="新建一次运行，原记录保留"
            className="rounded-lg border border-line px-2.5 py-1.5 text-[12px] hover:bg-[#fafafa]"
          >
            重跑
          </button>
        )}
        <button
          type="button"
          aria-label="删除运行记录"
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
