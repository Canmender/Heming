import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Agent } from "@heming/shared";
import type {
  CollaborationMode,
  CollaborationParticipant,
  CollaborationRun,
  CollaborationTurn,
} from "../../lib/collaboration/types.js";
import { estimateTurnCount, runCollaboration } from "../../lib/collaboration/engine.js";
import { createCollaborationAsk } from "../../lib/collaboration/run.js";
import { loadLastRun, saveLastRun } from "../../lib/collaboration/history.js";
import { resolveBoundProfile } from "../../lib/llmRoute.js";
import { useLlmStore } from "../../store/llm.js";
import { useUiStore } from "../../store/ui.js";
import { Avatar } from "../Avatar.js";
import { PlusIcon } from "../icons.js";
import { CollabTurnCard } from "./CollabTurnCard.js";

/**
 * 协作工作台（Multi-Agent Collaboration）。
 *
 * 布局刻意与聊天窗口不同：左边是「设置 + 有结构的回合时间线」，右边是参与者顺序与
 * 运行状态。协作只在本机运行：每个智能体用自己的绑定与提示词，没有绑定就标灰禁选；
 * 不新增服务端接口，历史只在本机 localStorage 保留最近一次。
 */

export interface CollabViewProps {
  agents: Agent[];
  /** 打开「新建智能体」弹窗（宿主页提供，避免本组件重复实现建人流程）。 */
  onCreateAgent?: () => void;
}

const MODES: { key: CollaborationMode; label: string; description: string }[] = [
  {
    key: "sequential",
    label: "流水线",
    description: "按顺序接力：方案 → 补充实现 → 评审定稿，每人只交增量。",
  },
  {
    key: "supervisor",
    label: "协调者-工作者",
    description: "第一位拆解分工，工作者按轮执行，最后协调者汇总。",
  },
  {
    key: "debate",
    label: "评审团",
    description: "各自独立出方案，读到他人观点后修正，最后综合成结论。",
  },
];

const MODE_LABEL: Record<CollaborationMode, string> = {
  sequential: "流水线",
  supervisor: "协调者-工作者",
  debate: "评审团",
};

const MODE_HINT: Record<CollaborationMode, string> = {
  sequential: "第一位出方案，中间补充实现，最后一位评审定稿。",
  supervisor: "第一位是协调者：先拆解，工作者执行，最后由协调者汇总。",
  debate: "独立方案互相不可见；修正轮才看到上一轮观点。",
};

interface Template {
  key: string;
  title: string;
  task: string;
  mode: CollaborationMode;
  rounds: number;
  /** 需要几位参与者（按可用顺序自动选）。 */
  size: number;
}

const TEMPLATES: Template[] = [
  {
    key: "research",
    title: "调研 → 方案 → 评审",
    task: "调研现状与关键约束，产出一份可执行方案，最后由评审者挑错并定稿。",
    mode: "sequential",
    rounds: 1,
    size: 3,
  },
  {
    key: "fullstack",
    title: "前端 → 后端 → 联调评审",
    task: "把一个功能拆成前端与后端两部分分别实现，最后完成联调检查与评审。",
    mode: "supervisor",
    rounds: 1,
    size: 3,
  },
  {
    key: "factcheck",
    title: "事实核查 → 反方 → 综合",
    task: "先核查事实与证据，再由反方提出最强反驳，最后综合出稳妥结论。",
    mode: "debate",
    rounds: 1,
    size: 3,
  },
];

interface Progress {
  index: number;
  total: number;
  round: number;
  agentName: string;
  role: string;
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // 剪贴板权限缺失 / 非安全上下文的退路（与 MarkdownMessage 的代码块一致）
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    try {
      document.execCommand("copy");
      return true;
    } catch {
      return false;
    } finally {
      document.body.removeChild(area);
    }
  }
}

function summaryOf(run: CollaborationRun): string {
  const head = [
    `# 协作纪要 · ${MODE_LABEL[run.mode]}`,
    `任务：${run.task}`,
    `参与者：${run.participants.map((p) => p.name).join(" → ")}`,
    `轮数：${run.rounds}`,
  ].join("\n");
  const body = run.turns
    .map((turn, index) => {
      const meta = `## ${index + 1}. ${turn.agentName} · ${turn.role}${
        turn.round > 0 ? `（第 ${turn.round} 轮）` : ""
      }`;
      const content = turn.error ? `> 失败：${turn.error}\n\n${turn.text}` : turn.text;
      return `${meta}\n\n${content.trim() || "（无产出）"}`;
    })
    .join("\n\n");
  return `${head}\n\n${body}`;
}

export function CollabView({ agents, onCreateAgent }: CollabViewProps) {
  const profiles = useLlmStore((s) => s.profiles);
  const bindings = useLlmStore((s) => s.bindings);
  const routes = useLlmStore((s) => s.routes);

  /** 已绑定模型的智能体（绑定值必须能解析出 profile，删掉的连接不算）。 */
  const boundIds = useMemo(() => {
    const ids = new Set<string>();
    for (const agent of agents) if (resolveBoundProfile(agent.id)) ids.add(agent.id);
    return ids;
    // bindings/routes/profiles 变化都可能让「是否绑定」翻转
  }, [agents, bindings, routes, profiles]);

  const agentMap = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);

  const [task, setTask] = useState("");
  const [mode, setMode] = useState<CollaborationMode>("sequential");
  const [rounds, setRounds] = useState(1);
  const [selected, setSelected] = useState<string[]>(() =>
    agents
      .filter((a) => resolveBoundProfile(a.id))
      .slice(0, 2)
      .map((a) => a.id),
  );
  const touchedRef = useRef(false);

  // 名册异步加载完成后再补默认参与者（用户手动改过就不再插手）。
  useEffect(() => {
    if (touchedRef.current || selected.length > 0) return;
    const first = agents
      .filter((a) => boundIds.has(a.id))
      .slice(0, 2)
      .map((a) => a.id);
    if (first.length > 0) setSelected(first);
  }, [agents, boundIds, selected.length]);

  const [run, setRun] = useState<CollaborationRun | null>(() => loadLastRun());
  const [restored, setRestored] = useState(run !== null);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "ok" | "failed">("idle");
  const abortRef = useRef<AbortController | null>(null);
  const orderRef = useRef(0);
  const totalRef = useRef(0);

  useEffect(
    () => () => {
      // 切走 Tab / 离开页面就中止在跑的协作，不在后台空烧 token。
      abortRef.current?.abort();
    },
    [],
  );

  const selectedAgents = useMemo(
    () =>
      selected
        .map((id) => agentMap.get(id))
        .filter((a): a is Agent => a !== undefined && boundIds.has(a.id)),
    [selected, agentMap, boundIds],
  );
  const canStart = task.trim().length > 0 && selectedAgents.length >= 2 && !running;

  const toggle = (agentId: string) => {
    touchedRef.current = true;
    setSelected((prev) =>
      prev.includes(agentId) ? prev.filter((id) => id !== agentId) : [...prev, agentId],
    );
  };

  const move = (index: number, delta: number) => {
    touchedRef.current = true;
    setSelected((prev) => {
      const next = [...prev];
      const target = index + delta;
      if (target < 0 || target >= next.length) return prev;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  };

  const handleToken = useCallback((turnId: string, text: string) => {
    setRun((prev) =>
      prev
        ? { ...prev, turns: prev.turns.map((t) => (t.id === turnId ? { ...t, text } : t)) }
        : prev,
    );
  }, []);

  const appendTurn = useCallback((turn: CollaborationTurn) => {
    orderRef.current += 1;
    setRun((prev) => (prev ? { ...prev, turns: [...prev.turns, turn] } : prev));
    setProgress({
      index: orderRef.current,
      total: totalRef.current,
      round: turn.round,
      agentName: turn.agentName,
      role: turn.role,
    });
  }, []);

  const finishTurn = useCallback((turn: CollaborationTurn) => {
    setRun((prev) => {
      if (!prev) return prev;
      const existing = prev.turns.find((t) => t.id === turn.id);
      return {
        ...prev,
        turns: prev.turns.map((t) =>
          t.id === turn.id ? { ...turn, text: turn.text || existing?.text || "" } : t,
        ),
      };
    });
  }, []);

  const start = async () => {
    if (!canStart) return;
    const taskText = task.trim();
    const participants: CollaborationParticipant[] = selectedAgents.map((agent) => {
      const own = useLlmStore.getState().prompts[agent.id];
      return {
        agentId: agent.id,
        name: agent.name,
        ...(own && own.trim() ? { systemPrompt: own } : {}),
      };
    });
    if (participants.length < 2) return;

    const controller = new AbortController();
    abortRef.current = controller;
    const startedAt = Date.now();
    const skeleton: CollaborationRun = {
      id: `run-${startedAt}`,
      mode,
      task: taskText,
      participants,
      rounds,
      turns: [],
      status: "running",
      startedAt,
    };
    orderRef.current = 0;
    setRun(skeleton);
    setRestored(false);
    setCopyState("idle");
    setProgress(null);
    setRunning(true);

    try {
      totalRef.current = estimateTurnCount({ mode, rounds, participants, task: taskText });
      const promptsSnapshot = { ...useLlmStore.getState().prompts };
      const ask = createCollaborationAsk({ prompts: promptsSnapshot, onToken: handleToken });
      const result = await runCollaboration(
        { mode, rounds, participants, task: taskText },
        { ask },
        {
          signal: controller.signal,
          onTurnStart: appendTurn,
          onTurnEnd: finishTurn,
        },
      );
      setRun(result);
      setProgress(null);
      saveLastRun(result);
    } catch (error) {
      const message = error instanceof Error && error.message ? error.message : "协作启动失败";
      setRun((prev) =>
        prev ? { ...prev, status: "error", error: message, endedAt: Date.now() } : prev,
      );
      setProgress(null);
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  };

  const abort = () => {
    abortRef.current?.abort();
  };

  const copyRun = async () => {
    if (!run || run.turns.length === 0) return;
    const ok = await copyText(summaryOf(run));
    setCopyState(ok ? "ok" : "failed");
  };

  const applyTemplate = (template: Template) => {
    touchedRef.current = true;
    setTask(template.task);
    setMode(template.mode);
    setRounds(template.rounds);
    const picks = agents
      .filter((a) => boundIds.has(a.id))
      .slice(0, template.size)
      .map((a) => a.id);
    if (picks.length >= 2) setSelected(picks);
  };

  const usableCount = boundIds.size;
  const insufficient = usableCount < 2;

  const statusText = (() => {
    if (running && progress) {
      const round =
        progress.round > 0 ? `第 ${progress.round} 轮 · ` : "";
      return `正在协作 · ${round}第 ${progress.index} / ${progress.total} 位 · ${progress.agentName}（${progress.role}）`;
    }
    if (running) return "正在准备协作…";
    if (!run) return "填写任务、选择模式与参与者后开始；协作只在本机运行。";
    if (run.status === "done") {
      return `已完成 · 共 ${run.turns.length} 个回合${
        run.turns.some((t) => t.error) ? "（部分失败）" : ""
      }`;
    }
    if (run.status === "aborted") return `已中止 · 保留 ${run.turns.length} 个已产生回合`;
    if (run.status === "error") return `已失败：${run.error ?? "未知错误"}`;
    return "正在准备协作…";
  })();

  const participantsForAside = selected
    .map((id) => agentMap.get(id))
    .filter((a): a is Agent => a !== undefined);
  const boundAgents = agents.filter((a) => boundIds.has(a.id));

  return (
    <div className="flex min-h-0 flex-1">
      <div className="min-w-0 flex-1 overflow-y-auto px-6 py-5 max-[1199px]:px-4">
        <div className="mx-auto flex w-full max-w-[880px] flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <span
              role="status"
              aria-live="polite"
              className="ui-caption min-w-0 flex-1 leading-5"
            >
              {statusText}
            </span>
            {run?.status === "done" && run.turns.length > 0 ? (
              <button
                type="button"
                className="ui-btn ui-btn-sm ui-btn-ghost"
                onClick={() => void copyRun()}
              >
                {copyState === "ok" ? "已复制纪要" : "复制纪要"}
              </button>
            ) : null}
          </div>

          {insufficient ? (
            <section className="ui-card p-4" aria-label="协作准备">
              <div className="flex items-start gap-3">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-line-soft bg-[var(--subtle-2)]">
                  <PlusIcon width={16} height={16} />
                </span>
                <div className="min-w-0">
                  <h2 className="ui-section-title">至少需要 2 个已绑定模型的智能体</h2>
                  <p className="ui-caption mt-1 leading-5">
                    当前可用 {usableCount} 个。协作会让每个智能体用自己的模型与提示词发言，
                    未绑定模型的智能体不能参与（本机运行，不会借用别人的 Key）。
                  </p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button
                      type="button"
                      className="ui-btn ui-btn-sm ui-btn-primary"
                      onClick={() => onCreateAgent?.()}
                    >
                      新建智能体
                    </button>
                    <button
                      type="button"
                      className="ui-btn ui-btn-sm ui-btn-ghost"
                      onClick={() => useUiStore.getState().setPage("model")}
                    >
                      去绑定模型
                    </button>
                  </div>
                </div>
              </div>
            </section>
          ) : (
            <section className="ui-card p-4" aria-label="协作设置">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h2 className="ui-section-title">协作任务</h2>
                <span className="ui-caption">本机运行 · 不写云端</span>
              </div>

              <label htmlFor="collab-task" className="ui-caption mt-3 block">
                任务描述（必填）
              </label>
              <textarea
                id="collab-task"
                value={task}
                onChange={(e) => setTask(e.target.value)}
                disabled={running}
                rows={4}
                placeholder="例如：调研本季度退款率上升的原因，产出改进方案并完成评审。"
                className="mt-1 min-h-[88px] w-full resize-y rounded-md border border-line-strong bg-[var(--surface)] px-2.5 py-2 text-[13px] leading-5 text-ink outline-hidden transition-colors placeholder:text-[var(--placeholder)] focus:border-ink disabled:cursor-not-allowed disabled:bg-[var(--subtle)]"
              />

              <div className="mt-3 grid gap-3 md:grid-cols-[1fr_112px]">
                <div>
                  <span className="ui-caption block" id="collab-mode-label">
                    协作模式
                  </span>
                  <div
                    role="radiogroup"
                    aria-labelledby="collab-mode-label"
                    className="mt-1 grid gap-2 sm:grid-cols-3"
                  >
                    {MODES.map((m) => {
                      const active = mode === m.key;
                      return (
                        <button
                          key={m.key}
                          type="button"
                          role="radio"
                          aria-checked={active}
                          disabled={running}
                          onClick={() => setMode(m.key)}
                          className={`rounded-lg border px-2.5 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
                            active
                              ? "border-ink bg-[var(--subtle-2)]"
                              : "border-line-soft hover:bg-[var(--subtle)]"
                          }`}
                        >
                          <span className="ui-body-sm block font-medium">{m.label}</span>
                          <span className="ui-caption mt-0.5 block leading-4">
                            {m.description}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>

                <label htmlFor="collab-rounds" className="ui-caption block">
                  轮数
                  <select
                    id="collab-rounds"
                    aria-label="协作轮数"
                    value={rounds}
                    disabled={running}
                    onChange={(e) => setRounds(Number(e.target.value))}
                    className="ui-input mt-1"
                  >
                    <option value={1}>1 轮</option>
                    <option value={2}>2 轮</option>
                    <option value={3}>3 轮</option>
                  </select>
                </label>
              </div>

              <fieldset className="mt-3 min-w-0" disabled={running}>
                <legend className="ui-caption">
                  参与者（按顺序；{mode === "supervisor" ? "第一位是协调者" : "顺序决定发言先后"}）
                </legend>
                <div className="mt-1 grid gap-1.5 sm:grid-cols-2">
                  {agents.map((agent) => {
                    const bound = boundIds.has(agent.id);
                    const index = selected.indexOf(agent.id);
                    const active = index >= 0;
                    return (
                      <div
                        key={agent.id}
                        className={`flex items-center gap-2 rounded-lg border px-2 py-1.5 ${
                          active ? "border-ink bg-[var(--subtle-2)]" : "border-line-soft"
                        } ${bound ? "" : "opacity-55"}`}
                      >
                        <input
                          type="checkbox"
                          id={`collab-agent-${agent.id}`}
                          checked={active}
                          disabled={!bound || running}
                          onChange={() => toggle(agent.id)}
                          className="h-3.5 w-3.5 shrink-0 accent-[var(--heming-accent)]"
                        />
                        <Avatar
                          user={{ displayName: agent.name, avatar: agent.avatar ?? undefined }}
                          size={22}
                        />
                        <label
                          htmlFor={`collab-agent-${agent.id}`}
                          className={`min-w-0 flex-1 ${bound ? "cursor-pointer" : "cursor-not-allowed"}`}
                        >
                          <span className="ui-body-sm block truncate">{agent.name}</span>
                          <span className="ui-caption block truncate">
                            {bound
                              ? active
                                ? `第 ${index + 1} 位`
                                : "已绑定模型"
                              : "未绑定模型，先绑定才能参与"}
                          </span>
                        </label>
                        {active ? (
                          <span className="flex shrink-0 items-center gap-0.5">
                            <button
                              type="button"
                              aria-label={`上移 ${agent.name}`}
                              disabled={running || index === 0}
                              onClick={() => move(index, -1)}
                              className="ui-micro flex h-6 w-6 items-center justify-center rounded-sm border border-line-soft text-muted hover:text-ink disabled:opacity-40"
                            >
                              ↑
                            </button>
                            <button
                              type="button"
                              aria-label={`下移 ${agent.name}`}
                              disabled={running || index === selected.length - 1}
                              onClick={() => move(index, 1)}
                              className="ui-micro flex h-6 w-6 items-center justify-center rounded-sm border border-line-soft text-muted hover:text-ink disabled:opacity-40"
                            >
                              ↓
                            </button>
                          </span>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </fieldset>

              <div className="mt-4 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  className="ui-btn ui-btn-md ui-btn-primary"
                  disabled={!canStart}
                  onClick={() => void start()}
                >
                  {running ? "协作进行中…" : "开始协作"}
                </button>
                <button
                  type="button"
                  className="ui-btn ui-btn-md ui-btn-danger"
                  disabled={!running}
                  onClick={abort}
                >
                  中止
                </button>
                <button
                  type="button"
                  className="ui-btn ui-btn-md ui-btn-ghost"
                  disabled={!run || run.turns.length === 0 || copyState === "ok"}
                  onClick={() => void copyRun()}
                >
                  {copyState === "ok" ? "已复制纪要" : "复制纪要"}
                </button>
                <span className="ui-caption ml-auto">
                  {selectedAgents.length} 位已选 · 至少 2 位
                </span>
              </div>
              {copyState === "failed" ? (
                <p className="ui-caption mt-1 text-[var(--danger)]" role="alert">
                  剪贴板不可用，请手动选择文本复制。
                </p>
              ) : null}
            </section>
          )}

          <section aria-label="协作过程" className="flex flex-col gap-2.5">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="ui-section-title">协作过程</h2>
              {restored && run ? <span className="ui-chip">上次协作</span> : null}
              {run && run.turns.length > 0 ? (
                <span className="ui-caption">{run.turns.length} 个回合</span>
              ) : null}
              {run ? (
                <span className="ui-micro ml-auto">
                  {MODE_LABEL[run.mode]} · {run.rounds} 轮
                </span>
              ) : null}
            </div>

            {run && run.turns.length > 0 ? (
              <ol className="flex flex-col gap-2.5" aria-label="协作回合">
                {run.turns.map((turn, index) => (
                  <li key={turn.id}>
                    <CollabTurnCard turn={turn} order={index + 1} />
                  </li>
                ))}
              </ol>
            ) : (
              <div className="ui-empty rounded-xl border border-dashed border-line-soft">
                <p className="ui-empty-title">从模板开始，或自己填写任务</p>
                <p className="ui-empty-desc">
                  模板只填充任务、模式与轮数；参与者和顺序仍可调整。
                </p>
                <div className="ui-empty-actions flex-wrap justify-center">
                  {TEMPLATES.map((template) => (
                    <button
                      key={template.key}
                      type="button"
                      disabled={running}
                      onClick={() => applyTemplate(template)}
                      className="ui-btn ui-btn-sm ui-btn-ghost"
                    >
                      {template.title}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </section>
        </div>
      </div>

      <aside className="hidden w-[244px] shrink-0 flex-col gap-3 overflow-y-auto border-l border-line-soft p-3 lg:flex">
        <section className="ui-card p-3" aria-label="参与者顺序">
          <h2 className="ui-section-title">参与者顺序</h2>
          {participantsForAside.length > 0 ? (
            <ol className="mt-2 flex flex-col gap-1.5">
              {participantsForAside.map((agent, index) => (
                <li key={agent.id} className="flex items-center gap-2">
                  <span className="ui-micro ui-numeric w-4 text-right">{index + 1}</span>
                  <Avatar
                    user={{ displayName: agent.name, avatar: agent.avatar ?? undefined }}
                    size={22}
                  />
                  <span className="ui-body-sm min-w-0 truncate">{agent.name}</span>
                  {mode === "supervisor" && index === 0 ? (
                    <span className="ui-chip ml-auto">协调者</span>
                  ) : null}
                </li>
              ))}
            </ol>
          ) : (
            <p className="ui-caption mt-1">尚未选择参与者</p>
          )}
          <p className="ui-caption mt-2 leading-5">{MODE_HINT[mode]}</p>
        </section>

        <section className="ui-card p-3" aria-label="协作说明">
          <h2 className="ui-section-title">协作纪律</h2>
          <ul className="mt-1.5 flex list-disc flex-col gap-1 pl-4 ui-caption leading-5">
            <li>每人只用自己绑定的模型与提示词，看不到他人的私有设定。</li>
            <li>只共享本轮产出正文；中止后已产生的回合会保留。</li>
            <li>最近一次纪要在本机保留一份，不上传。</li>
          </ul>
          <p className="ui-caption mt-2 leading-5">
            可用智能体 {usableCount} 个 / 名册 {agents.length} 个
            {boundAgents.length !== agents.length ? "（未绑定的已标灰）" : ""}
          </p>
        </section>
      </aside>
    </div>
  );
}
